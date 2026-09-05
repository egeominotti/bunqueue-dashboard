import { FlowProducer, Queue } from 'bunqueue/client';
import {
  type TradeOrder,
  type PipelineData,
  type PortfolioResult,
  connection,
  httpPort,
  runId,
  queues,
  timeline,
  infrastructureErrors,
  executionAttempts,
  portfolio,
  assert,
  round,
} from './trading/model';
import { createTradingWorkers } from './trading/workers';
const health = (await fetch(`http://127.0.0.1:${httpPort}/health`).then((response) =>
  response.json()
)) as {
  ok: boolean;
  version: string;
};
assert(health.ok && health.version === '2.9.4', 'Bunqueue 2.9.4 deve essere healthy');

const flow = new FlowProducer({ connection });
const portfolioQueue = new Queue<PipelineData>(queues.portfolio, { connection });

const workers = createTradingWorkers();

async function waitForResult(jobId: string): Promise<PortfolioResult> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await portfolioQueue.getJobState(jobId);
    if (state === 'completed') {
      const job = await portfolioQueue.getJob(jobId);
      return job?.returnvalue as PortfolioResult;
    }
    if (state === 'failed') throw new Error(`Pipeline ${jobId} fallita`);
    await Bun.sleep(50);
  }
  throw new Error(`Timeout pipeline ${jobId}`);
}

async function submit(
  order: TradeOrder
): Promise<{ rootId: string; result: PortfolioResult; elapsedMs: number }> {
  const startedAt = performance.now();
  const data: PipelineData = { runId, order };
  const root = await flow.add({
    name: 'update-portfolio',
    queueName: queues.portfolio,
    data,
    opts: { attempts: 2, group: { id: order.accountId } },
    children: [
      {
        name: 'execute-order',
        queueName: queues.execution,
        data,
        opts: { attempts: 3, backoff: 150, priority: 100, group: { id: order.accountId } },
        children: [
          {
            name: 'risk-check',
            queueName: queues.risk,
            data,
            opts: { attempts: 2, group: { id: order.accountId } },
            children: [
              {
                name: 'market-snapshot',
                queueName: queues.market,
                data,
                opts: { attempts: 2, group: { id: order.accountId } },
              },
            ],
          },
        ],
      },
    ],
  });

  const result = await waitForResult(root.job.id);
  return { rootId: root.job.id, result, elapsedMs: Math.round(performance.now() - startedAt) };
}

try {
  await Promise.all(workers.map((worker) => worker.waitUntilReady()));
  await flow.waitUntilReady();
  await portfolioQueue.waitUntilReady();

  const approved = await submit({
    accountId: 'DEMO-ACCOUNT-01',
    orderId: 'PAPER-AAPL-001',
    symbol: 'AAPL',
    side: 'BUY',
    quantity: 12,
    referencePrice: 228.4,
    maxNotional: 5_000,
  });

  const rejected = await submit({
    accountId: 'DEMO-ACCOUNT-01',
    orderId: 'PAPER-TSLA-002',
    symbol: 'TSLA',
    side: 'BUY',
    quantity: 100,
    referencePrice: 341.2,
    maxNotional: 5_000,
  });

  assert(approved.result.status === 'booked', 'ordine AAPL deve essere contabilizzato');
  assert(
    executionAttempts.get('PAPER-AAPL-001') === 2,
    'ordine AAPL deve riuscire al secondo tentativo'
  );
  assert(
    rejected.result.status === 'unchanged',
    'ordine TSLA deve essere rifiutato senza modificare il portafoglio'
  );
  assert(
    rejected.result.cash === approved.result.cash,
    'un ordine rifiutato non deve modificare la liquidità'
  );
  assert(
    infrastructureErrors.length === 0,
    'non devono esserci errori infrastrutturali nei worker'
  );

  const pipelineOrder = (orderId: string) =>
    timeline
      .filter((entry) => entry.orderId === orderId && entry.event === 'completed')
      .map((entry) => entry.stage);
  assert(
    pipelineOrder('PAPER-AAPL-001').join('>') === 'market>risk>execution>portfolio',
    'le dipendenze della pipeline devono essere rispettate'
  );

  console.log(
    JSON.stringify(
      {
        passed: true,
        mode: 'paper-trading-only',
        bunqueue: health.version,
        runId,
        queues,
        approvedOrder: {
          orderId: 'PAPER-AAPL-001',
          executionAttempts: executionAttempts.get('PAPER-AAPL-001'),
          elapsedMs: approved.elapsedMs,
          result: approved.result,
        },
        rejectedOrder: {
          orderId: 'PAPER-TSLA-002',
          executionAttempts: executionAttempts.get('PAPER-TSLA-002'),
          elapsedMs: rejected.elapsedMs,
          result: rejected.result,
        },
        finalPortfolio: {
          cash: round(portfolio.cash),
          positions: Object.fromEntries(portfolio.positions),
        },
        timeline,
        infrastructureErrors,
      },
      null,
      2
    )
  );
} finally {
  await Promise.all(workers.map((worker) => worker.close(true).catch(() => undefined)));
  await flow.close().catch(() => undefined);
  portfolioQueue.close();
}
