import { Worker, type Job } from 'bunqueue/client';
import {
  type PipelineData,
  type MarketResult,
  type RiskResult,
  type ExecutionResult,
  type PortfolioResult,
  connection,
  queues,
  timeline,
  infrastructureErrors,
  executionAttempts,
  portfolio,
  round,
  childResult,
  markProgress,
} from './model';
export function createTradingWorkers() {
  const marketWorker = new Worker<PipelineData, MarketResult>(
    queues.market,
    async (job) => {
      await markProgress(job, 30, 'Normalizzazione tick di mercato');
      await Bun.sleep(40);
      const spread = job.data.order.referencePrice * 0.0002;
      await markProgress(job, 100, 'Snapshot di mercato validato');
      return {
        symbol: job.data.order.symbol,
        bid: round(job.data.order.referencePrice - spread),
        ask: round(job.data.order.referencePrice + spread),
        observedAt: new Date().toISOString(),
      };
    },
    { connection, concurrency: 2 }
  );

  const riskWorker = new Worker<PipelineData, RiskResult>(
    queues.risk,
    async (job) => {
      await markProgress(job, 25, 'Calcolo esposizione e limite nozionale');
      const market = childResult<MarketResult>(await job.getChildrenValues());
      const executionPrice = job.data.order.side === 'BUY' ? market.ask : market.bid;
      const estimatedNotional = executionPrice * job.data.order.quantity;
      const approved = estimatedNotional <= job.data.order.maxNotional;
      await markProgress(job, 100, approved ? 'Rischio approvato' : 'Rischio rifiutato');
      return {
        approved,
        reason: approved
          ? 'within-notional-limit'
          : `notional ${round(estimatedNotional)} exceeds limit ${job.data.order.maxNotional}`,
        estimatedNotional: round(estimatedNotional),
        executionPrice,
      };
    },
    { connection, concurrency: 2 }
  );

  const executionWorker = new Worker<PipelineData, ExecutionResult>(
    queues.execution,
    async (job) => {
      const risk = childResult<RiskResult>(await job.getChildrenValues());
      const attempts = (executionAttempts.get(job.data.order.orderId) ?? 0) + 1;
      executionAttempts.set(job.data.order.orderId, attempts);
      await markProgress(job, 20, `Invio ordine al paper venue, tentativo ${attempts}`);

      if (!risk.approved) {
        await markProgress(job, 100, 'Ordine bloccato dal risk engine');
        return { status: 'rejected', orderId: job.data.order.orderId, reason: risk.reason };
      }

      if (job.data.order.orderId === 'PAPER-AAPL-001' && attempts === 1) {
        throw new Error('timeout temporaneo del paper venue');
      }

      await Bun.sleep(60);
      const slippageMultiplier = job.data.order.side === 'BUY' ? 1.0004 : 0.9996;
      const averagePrice = round(risk.executionPrice * slippageMultiplier);
      const fee = round(Math.max(1, averagePrice * job.data.order.quantity * 0.0005));
      await markProgress(job, 100, 'Fill confermato');
      return {
        status: 'filled',
        orderId: job.data.order.orderId,
        filledQuantity: job.data.order.quantity,
        averagePrice,
        fee,
        venue: 'PAPER-XNAS',
      };
    },
    { connection, concurrency: 1 }
  );

  const portfolioWorker = new Worker<PipelineData, PortfolioResult>(
    queues.portfolio,
    async (job) => {
      const execution = childResult<ExecutionResult>(await job.getChildrenValues());
      await markProgress(job, 30, 'Riconciliazione esecuzione');

      if (execution.status === 'rejected') {
        await markProgress(job, 100, 'Portafoglio invariato');
        return {
          status: 'unchanged',
          orderId: job.data.order.orderId,
          reason: execution.reason,
          cash: round(portfolio.cash),
        };
      }

      const signedQuantity =
        job.data.order.side === 'BUY' ? execution.filledQuantity! : -execution.filledQuantity!;
      const current = portfolio.positions.get(job.data.order.symbol) ?? {
        quantity: 0,
        averagePrice: 0,
      };
      const nextQuantity = current.quantity + signedQuantity;
      const tradeValue = execution.averagePrice! * execution.filledQuantity!;
      portfolio.cash +=
        job.data.order.side === 'BUY'
          ? -(tradeValue + execution.fee!)
          : tradeValue - execution.fee!;
      const nextPosition = {
        quantity: nextQuantity,
        averagePrice: execution.averagePrice!,
      };
      portfolio.positions.set(job.data.order.symbol, nextPosition);
      await markProgress(job, 100, 'Portafoglio aggiornato');
      return {
        status: 'booked',
        orderId: job.data.order.orderId,
        cash: round(portfolio.cash),
        position: { symbol: job.data.order.symbol, ...nextPosition },
      };
    },
    { connection, concurrency: 1 }
  );

  const workers = [marketWorker, riskWorker, executionWorker, portfolioWorker];
  function observeWorker<Result>(stage: string, worker: Worker<PipelineData, Result>): void {
    worker.on('completed', (job: Job<PipelineData>) =>
      timeline.push({
        event: 'completed',
        stage,
        orderId: job.data.order.orderId,
        at: new Date().toISOString(),
      })
    );
    worker.on('failed', (job: Job<PipelineData>, error: Error) =>
      timeline.push({
        event: 'failed',
        stage,
        orderId: job.data.order.orderId,
        detail: error.message,
        at: new Date().toISOString(),
      })
    );
    worker.on('error', (error: Error) => infrastructureErrors.push(`${stage}: ${error.message}`));
  }

  observeWorker('market', marketWorker);
  observeWorker('risk', riskWorker);
  observeWorker('execution', executionWorker);
  observeWorker('portfolio', portfolioWorker);

  return workers;
}
