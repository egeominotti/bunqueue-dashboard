import { Worker, type Job, type ConnectionOptions } from 'bunqueue/client';
import {
  type PipelineData,
  type MarketResult,
  type RiskResult,
  type ExecutionResult,
  type PortfolioResult,
  accountExecutionConcurrency,
  queues,
  accountActive,
  accountPeak,
  executionAttempts,
  latencies,
  infrastructureErrors,
  positions,
  portfolioState,
  round,
  firstChild,
  tracked,
  marketSnapshot,
  evaluateRisk,
  calculateExecution,
} from './model';
export function createStressWorkers(connection: ConnectionOptions) {
  const marketWorker = new Worker<PipelineData, MarketResult>(
    queues.market,
    (job) =>
      tracked('market', async () => {
        if (job.data.order.index % 100 === 0) {
          await job.updateProgress(50, 'market snapshot');
          await job.log('Stress test market sample');
        }
        await Bun.sleep(1 + (job.data.order.index % 3));
        return marketSnapshot(job.data.order);
      }),
    { connection, concurrency: 64, batchSize: 64, group: { concurrency: 8 } }
  );

  const riskWorker = new Worker<PipelineData, RiskResult>(
    queues.risk,
    (job) =>
      tracked('risk', async () => {
        const market = firstChild<MarketResult>(await job.getChildrenValues());
        await Bun.sleep(1 + (job.data.order.index % 2));
        return evaluateRisk(job.data.order, market);
      }),
    { connection, concurrency: 48, batchSize: 48, group: { concurrency: 4 } }
  );

  const executionWorker = new Worker<PipelineData, ExecutionResult>(
    queues.execution,
    (job) =>
      tracked('execution', async () => {
        const order = job.data.order;
        const currentAccountActive = (accountActive.get(order.accountId) ?? 0) + 1;
        accountActive.set(order.accountId, currentAccountActive);
        accountPeak.set(
          order.accountId,
          Math.max(accountPeak.get(order.accountId) ?? 0, currentAccountActive)
        );
        const attempt = (executionAttempts.get(order.orderId) ?? 0) + 1;
        executionAttempts.set(order.orderId, attempt);
        try {
          const risk = firstChild<RiskResult>(await job.getChildrenValues());
          if (order.transientFailure && attempt === 1) throw new Error('paper-venue-timeout');
          await Bun.sleep(2 + (order.index % 4));
          return calculateExecution(order, risk);
        } finally {
          accountActive.set(order.accountId, (accountActive.get(order.accountId) ?? 1) - 1);
        }
      }),
    {
      connection,
      concurrency: 32,
      batchSize: 32,
      group: { concurrency: accountExecutionConcurrency },
    }
  );

  const portfolioWorker = new Worker<PipelineData, PortfolioResult>(
    queues.portfolio,
    (job) =>
      tracked('portfolio', async () => {
        const execution = firstChild<ExecutionResult>(await job.getChildrenValues());
        if (execution.status === 'rejected') {
          return { status: 'unchanged', orderId: job.data.order.orderId, cashDelta: 0 };
        }
        const order = job.data.order;
        const gross = execution.averagePrice! * execution.quantity!;
        const cashDelta = order.side === 'BUY' ? -(gross + execution.fee!) : gross - execution.fee!;
        portfolioState.cash += cashDelta;
        const signedQuantity = order.side === 'BUY' ? execution.quantity! : -execution.quantity!;
        positions.set(order.symbol, (positions.get(order.symbol) ?? 0) + signedQuantity);
        await Bun.sleep(1);
        return { status: 'booked', orderId: order.orderId, cashDelta: round(cashDelta) };
      }),
    { connection, concurrency: 16, batchSize: 32, group: { concurrency: 2 } }
  );

  const deadletterWorker = new Worker<{ index: number }, never>(
    queues.deadletter,
    (job) =>
      tracked('deadletter', async () => {
        await Bun.sleep(2);
        throw new Error(`invalid-compliance-payload-${job.data.index}`);
      }),
    { connection, concurrency: 8, batchSize: 16 }
  );

  const workers = [marketWorker, riskWorker, executionWorker, portfolioWorker, deadletterWorker];
  for (const worker of workers) {
    worker.on('error', (error: Error) => infrastructureErrors.push(error.message));
  }
  portfolioWorker.on('completed', (job: Job<PipelineData>) => {
    latencies.push(Date.now() - job.data.order.submittedAt);
  });

  return workers;
}
