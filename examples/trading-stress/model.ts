import type { FlowJob } from 'bunqueue/client';
export type Side = 'BUY' | 'SELL';
export type Stage = 'market' | 'risk' | 'execution' | 'portfolio' | 'deadletter';

export interface Order {
  index: number;
  orderId: string;
  accountId: string;
  symbol: string;
  side: Side;
  quantity: number;
  referencePrice: number;
  maxNotional: number;
  transientFailure: boolean;
  submittedAt: number;
}

export interface PipelineData {
  order: Order;
}

export interface MarketResult {
  bid: number;
  ask: number;
}

export interface RiskResult {
  approved: boolean;
  reason: string;
  executionPrice: number;
  notional: number;
}

export interface ExecutionResult {
  status: 'filled' | 'rejected';
  reason?: string;
  quantity?: number;
  averagePrice?: number;
  fee?: number;
}

export interface PortfolioResult {
  status: 'booked' | 'unchanged';
  orderId: string;
  cashDelta: number;
}

export interface StageRuntime {
  active: number;
  peak: number;
  completed: number;
  failedAttempts: number;
}

export const orderCount = Number(Bun.env.STRESS_ORDERS ?? 400);
if (!Number.isInteger(orderCount) || orderCount < 50 || orderCount > 2_000) {
  throw new Error('STRESS_ORDERS deve essere un intero tra 50 e 2000');
}

export const pipelineStages = 4;
export const poisonCount = Math.max(8, Math.floor(orderCount / 50));
export const initialCash = 1_000_000;
export const globalExecutionConcurrency = 16;
export const accountExecutionConcurrency = 2;
export const executionRateLimit = 300;
export const symbols = [
  ['AAPL', 228.4],
  ['MSFT', 517.2],
  ['NVDA', 182.6],
  ['TSLA', 341.2],
  ['AMZN', 235.8],
  ['META', 812.5],
  ['GOOGL', 206.1],
  ['AMD', 164.9],
] as const;

export const queues = {
  market: 'stress-trading-market',
  risk: 'stress-trading-risk',
  execution: 'stress-trading-execution',
  portfolio: 'stress-trading-portfolio',
  deadletter: 'stress-trading-deadletter',
  dedupe: 'stress-trading-dedupe',
};

export const stageRuntime: Record<Stage, StageRuntime> = {
  market: { active: 0, peak: 0, completed: 0, failedAttempts: 0 },
  risk: { active: 0, peak: 0, completed: 0, failedAttempts: 0 },
  execution: { active: 0, peak: 0, completed: 0, failedAttempts: 0 },
  portfolio: { active: 0, peak: 0, completed: 0, failedAttempts: 0 },
  deadletter: { active: 0, peak: 0, completed: 0, failedAttempts: 0 },
};
export const accountActive = new Map<string, number>();
export const accountPeak = new Map<string, number>();
export const executionAttempts = new Map<string, number>();
export const latencies: number[] = [];
export const infrastructureErrors: string[] = [];
export const positions = new Map<string, number>();
export const portfolioState = { cash: initialCash };

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

export function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

export function firstChild<T>(values: Record<string, unknown>): T {
  const value = Object.values(values)[0];
  if (value === undefined) throw new Error('Risultato dipendenza mancante');
  return value as T;
}

export async function tracked<T>(stage: Stage, action: () => Promise<T>): Promise<T> {
  const runtime = stageRuntime[stage];
  runtime.active++;
  runtime.peak = Math.max(runtime.peak, runtime.active);
  try {
    const result = await action();
    runtime.completed++;
    return result;
  } catch (error) {
    runtime.failedAttempts++;
    throw error;
  } finally {
    runtime.active--;
  }
}

export function marketSnapshot(order: Order): MarketResult {
  const halfSpread = order.referencePrice * 0.0002;
  return {
    bid: round(order.referencePrice - halfSpread),
    ask: round(order.referencePrice + halfSpread),
  };
}

export function evaluateRisk(order: Order, market = marketSnapshot(order)): RiskResult {
  const executionPrice = order.side === 'BUY' ? market.ask : market.bid;
  const notional = round(executionPrice * order.quantity);
  const approved = notional <= order.maxNotional;
  return {
    approved,
    reason: approved ? 'approved' : 'max-notional-exceeded',
    executionPrice,
    notional,
  };
}

export function calculateExecution(order: Order, risk = evaluateRisk(order)): ExecutionResult {
  if (!risk.approved) return { status: 'rejected', reason: risk.reason };
  const multiplier = order.side === 'BUY' ? 1.0003 : 0.9997;
  const averagePrice = round(risk.executionPrice * multiplier);
  const fee = round(Math.max(0.25, averagePrice * order.quantity * 0.0002));
  return { status: 'filled', quantity: order.quantity, averagePrice, fee };
}

export function generateOrders(): Order[] {
  return Array.from({ length: orderCount }, (_, index) => {
    const [symbol, basePrice] = symbols[index % symbols.length];
    const quantity = 1 + ((index * 17) % 90);
    const referencePrice = round(basePrice * (1 + ((index % 9) - 4) * 0.0007));
    const maxNotional = index % 5 === 0 ? 2_500 : 75_000;
    const partial: Order = {
      index,
      orderId: `STRESS-${String(index + 1).padStart(5, '0')}`,
      accountId: `ACCOUNT-${String((index % 20) + 1).padStart(2, '0')}`,
      symbol,
      side: index % 4 === 0 ? 'SELL' : 'BUY',
      quantity,
      referencePrice,
      maxNotional,
      transientFailure: false,
      submittedAt: Date.now(),
    };
    partial.transientFailure = index % 17 === 0 && evaluateRisk(partial).approved;
    return partial;
  });
}

export function buildFlow(order: Order): FlowJob<PipelineData> {
  const data = { order };
  const group = { id: order.accountId, priority: order.index % 8, maxSize: orderCount };
  return {
    name: 'book-portfolio',
    queueName: queues.portfolio,
    data,
    opts: { attempts: 2, durable: true, group },
    children: [
      {
        name: 'execute-order',
        queueName: queues.execution,
        data,
        opts: {
          attempts: 3,
          backoff: 25,
          priority: order.index % 11 === 0 ? 100 : 10,
          durable: true,
          group,
        },
        children: [
          {
            name: 'risk-check',
            queueName: queues.risk,
            data,
            opts: { attempts: 2, durable: true, group },
            children: [
              {
                name: 'market-snapshot',
                queueName: queues.market,
                data,
                opts: {
                  attempts: 2,
                  delay: order.index % 13 === 0 ? 40 + (order.index % 5) * 20 : 0,
                  durable: true,
                  group,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timeout: ${label}`);
}
