import { rm } from 'node:fs/promises';
import { FlowProducer, Queue } from 'bunqueue/client';
import { tempRoot, tcpPort, httpPort, startBroker, stopBroker } from './trading-stress/broker';
import {
  type PipelineData,
  orderCount,
  pipelineStages,
  poisonCount,
  initialCash,
  globalExecutionConcurrency,
  accountExecutionConcurrency,
  executionRateLimit,
  symbols,
  queues,
  stageRuntime,
  accountPeak,
  latencies,
  infrastructureErrors,
  positions,
  portfolioState,
  assert,
  round,
  percentile,
  evaluateRisk,
  calculateExecution,
  generateOrders,
  buildFlow,
  waitFor,
} from './trading-stress/model';
import { createStressWorkers } from './trading-stress/workers';
const testStartedAt = performance.now();

try {
  await startBroker();
  const connection = { host: '127.0.0.1', port: tcpPort, poolSize: 4 };
  const flow = new FlowProducer({ connection });
  const marketQueue = new Queue<PipelineData>(queues.market, { connection });
  const riskQueue = new Queue<PipelineData>(queues.risk, { connection });
  const executionQueue = new Queue<PipelineData>(queues.execution, { connection });
  const portfolioQueue = new Queue<PipelineData>(queues.portfolio, { connection });
  const deadletterQueue = new Queue<{ index: number }>(queues.deadletter, { connection });
  const dedupeQueue = new Queue<{ symbol: string }>(queues.dedupe, { connection });
  const queuesToClose = [
    marketQueue,
    riskQueue,
    executionQueue,
    portfolioQueue,
    deadletterQueue,
    dedupeQueue,
  ];

  await Promise.all(queuesToClose.map((queue) => queue.waitUntilReady()));
  await flow.waitUntilReady();
  await riskQueue.pauseAsync();
  await executionQueue.setGlobalConcurrencyAsync(globalExecutionConcurrency);
  await executionQueue.setGlobalRateLimitAsync(executionRateLimit, 1_000);

  const workers = createStressWorkers(connection);
  await Promise.all(workers.map((worker) => worker.waitUntilReady()));

  const dedupeKey = 'AAPL:market-tick:1s';
  const firstTick = await dedupeQueue.add(
    'market-tick',
    { symbol: 'AAPL' },
    { delay: 60_000, deduplication: { id: dedupeKey, ttl: 60_000 } }
  );
  const duplicateTick = await dedupeQueue.add(
    'market-tick',
    { symbol: 'AAPL' },
    { delay: 60_000, deduplication: { id: dedupeKey, ttl: 60_000 } }
  );
  const dedupeOwner = await dedupeQueue.getDeduplicationJobId(dedupeKey);
  assert(
    firstTick.id === duplicateTick.id && dedupeOwner === firstTick.id,
    'deduplicazione non atomica'
  );
  assert(
    (await dedupeQueue.removeDeduplicationKey(dedupeKey)) === 1,
    'rimozione chiave dedupe non confermata'
  );
  await dedupeQueue.removeAsync(firstTick.id);

  await deadletterQueue.addBulk(
    Array.from({ length: poisonCount }, (_, index) => ({
      name: 'compliance-invalid',
      data: { index },
      opts: { attempts: 2, backoff: 10 },
    }))
  );

  const orders = generateOrders();
  const roots: Array<{ id: string; queueName: string }> = [];
  const batchSize = 25;
  for (let offset = 0; offset < orders.length; offset += batchSize) {
    const nodes = await flow.addBulk(orders.slice(offset, offset + batchSize).map(buildFlow));
    roots.push(...nodes.map((node) => ({ id: node.job.id, queueName: node.job.queueName })));
  }

  await Bun.sleep(150);
  const pauseGate = {
    paused: await riskQueue.isPausedAsync(),
    rootsCompletedBeforeResume: await portfolioQueue.getCompletedCount(),
  };
  assert(pauseGate.paused, 'la coda rischio deve risultare in pausa');
  assert(
    pauseGate.rootsCompletedBeforeResume === 0,
    'nessun flusso deve superare il risk gate in pausa'
  );

  const processingStartedAt = performance.now();
  await riskQueue.resumeAsync();

  await Promise.all([
    waitFor(
      async () => (await portfolioQueue.getCompletedCount()) === orderCount,
      90_000,
      'completamento pipeline trading'
    ),
    waitFor(
      async () => (await deadletterQueue.getFailedCount()) === poisonCount,
      30_000,
      'popolamento DLQ'
    ),
  ]);
  const processingElapsedMs = Math.round(performance.now() - processingStartedAt);

  const expectedApproved = orders.filter((order) => evaluateRisk(order).approved);
  const expectedRejected = orderCount - expectedApproved.length;
  const expectedRetries = orders.filter((order) => order.transientFailure).length;
  let expectedCash = initialCash;
  const expectedPositions = new Map<string, number>();
  for (const order of expectedApproved) {
    const execution = calculateExecution(order);
    const gross = execution.averagePrice! * execution.quantity!;
    expectedCash += order.side === 'BUY' ? -(gross + execution.fee!) : gross - execution.fee!;
    const signedQuantity = order.side === 'BUY' ? execution.quantity! : -execution.quantity!;
    expectedPositions.set(
      order.symbol,
      (expectedPositions.get(order.symbol) ?? 0) + signedQuantity
    );
  }

  const countsBeforeRestart = {
    market: await marketQueue.getJobCountsAsync(),
    risk: await riskQueue.getJobCountsAsync(),
    execution: await executionQueue.getJobCountsAsync(),
    portfolio: await portfolioQueue.getJobCountsAsync(),
    deadletter: await deadletterQueue.getJobCountsAsync(),
  };
  const dlqBeforeRestart = await deadletterQueue.getDlqStatsAsync();
  const configuredLimits = {
    globalConcurrency: await executionQueue.getGlobalConcurrency(),
    rateLimit: await executionQueue.getGlobalRateLimit(),
  };

  assert(countsBeforeRestart.market.completed === orderCount, 'conteggio market incompleto');
  assert(countsBeforeRestart.risk.completed === orderCount, 'conteggio risk incompleto');
  assert(countsBeforeRestart.execution.completed === orderCount, 'conteggio execution incompleto');
  assert(countsBeforeRestart.portfolio.completed === orderCount, 'conteggio portfolio incompleto');
  assert(dlqBeforeRestart.total === poisonCount, 'conteggio DLQ inatteso');
  assert(
    stageRuntime.execution.failedAttempts === expectedRetries,
    'numero retry transitori inatteso'
  );
  assert(
    Math.abs(portfolioState.cash - expectedCash) < 0.001,
    'riconciliazione della liquidità fallita'
  );
  for (const [symbol, quantity] of expectedPositions) {
    assert(positions.get(symbol) === quantity, `posizione ${symbol} non riconciliata`);
  }
  assert(
    stageRuntime.execution.peak <= globalExecutionConcurrency,
    'limite globale di concorrenza superato'
  );
  assert(
    Math.max(...accountPeak.values()) <= accountExecutionConcurrency,
    'limite di concorrenza per account superato'
  );
  assert(latencies.length === orderCount, 'campioni di latenza incompleti');
  assert(infrastructureErrors.length === 0, 'errori infrastrutturali rilevati');

  const sampledFlow = await flow.getFlow({
    ...roots[Math.floor(roots.length / 2)],
    depth: 4,
    maxChildren: 10,
  });
  assert(sampledFlow, 'grafo campione non leggibile');
  const sampledStates: string[] = [];
  async function inspectNode(node: NonNullable<typeof sampledFlow>): Promise<void> {
    sampledStates.push(await node.job.getState());
    for (const child of node.children ?? []) await inspectNode(child);
  }
  await inspectNode(sampledFlow);
  assert(sampledStates.length === pipelineStages, 'profondità del grafo non integra');
  assert(
    sampledStates.every((state) => state === 'completed'),
    'grafo campione non completamente concluso'
  );

  const healthBeforeRestart = (await fetch(`http://127.0.0.1:${httpPort}/health`).then((response) =>
    response.json()
  )) as { version: string; memory: { rss: number }; queues: Record<string, number> };

  await Promise.all(workers.map((worker) => worker.close(true)));
  await flow.close();
  for (const queue of queuesToClose) queue.close();
  await stopBroker();
  await startBroker();

  const verifyConnection = { host: '127.0.0.1', port: tcpPort };
  const persistedPortfolio = new Queue(queues.portfolio, { connection: verifyConnection });
  const persistedExecution = new Queue(queues.execution, { connection: verifyConnection });
  const persistedDeadletter = new Queue(queues.deadletter, { connection: verifyConnection });
  await Promise.all([
    persistedPortfolio.waitUntilReady(),
    persistedExecution.waitUntilReady(),
    persistedDeadletter.waitUntilReady(),
  ]);
  const persistence = {
    portfolioCompleted: await persistedPortfolio.getCompletedCount(),
    executionCompleted: await persistedExecution.getCompletedCount(),
    dlq: (await persistedDeadletter.getDlqStatsAsync()).total,
    globalConcurrency: await persistedExecution.getGlobalConcurrency(),
    rateLimit: await persistedExecution.getGlobalRateLimit(),
  };
  assert(persistence.portfolioCompleted === orderCount, 'root non persistiti dopo il riavvio');
  assert(
    persistence.executionCompleted === orderCount,
    'esecuzioni non persistite dopo il riavvio'
  );
  assert(persistence.dlq === poisonCount, 'DLQ non persistita dopo il riavvio');
  assert(
    persistence.globalConcurrency === globalExecutionConcurrency,
    'concorrenza globale non persistita'
  );
  assert(persistence.rateLimit?.max === executionRateLimit, 'rate limit non persistito');
  persistedPortfolio.close();
  persistedExecution.close();
  persistedDeadletter.close();

  const completedPipelineJobs = orderCount * pipelineStages;
  const totalProcessorAttempts = completedPipelineJobs + expectedRetries + poisonCount * 2;
  const result = {
    passed: true,
    bunqueue: healthBeforeRestart.version,
    isolatedDatabase: true,
    workload: {
      orders: orderCount,
      accounts: 20,
      symbols: symbols.length,
      pipelineDepth: pipelineStages,
      completedPipelineJobs,
      processorAttempts: totalProcessorAttempts,
      approvedOrders: expectedApproved.length,
      rejectedOrders: expectedRejected,
      transientRetries: expectedRetries,
      dlqJobs: poisonCount,
    },
    controls: {
      pauseGate,
      deduplication: 'atomic-pass',
      configuredLimits,
      observedExecutionPeak: stageRuntime.execution.peak,
      observedMaxPerAccount: Math.max(...accountPeak.values()),
    },
    performance: {
      processingElapsedMs,
      endToEndElapsedMs: Math.round(performance.now() - testStartedAt),
      pipelineJobsPerSecond: round(completedPipelineJobs / (processingElapsedMs / 1_000), 2),
      orderLatencyMs: {
        min: Math.min(...latencies),
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: Math.max(...latencies),
      },
      brokerRssMb: healthBeforeRestart.memory.rss,
    },
    integrity: {
      cashExpected: round(expectedCash),
      cashActual: round(portfolioState.cash),
      positions: Object.fromEntries([...positions.entries()].sort()),
      sampledFlowStates: sampledStates,
      persistenceAfterRestart: persistence,
      infrastructureErrors,
    },
  };

  console.log(JSON.stringify(result, null, 2));
} finally {
  await stopBroker().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
