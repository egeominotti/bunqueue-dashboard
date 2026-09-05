import type { Job } from 'bunqueue/client';
export type Side = 'BUY' | 'SELL';

export interface TradeOrder {
  accountId: string;
  orderId: string;
  symbol: string;
  side: Side;
  quantity: number;
  referencePrice: number;
  maxNotional: number;
}

export interface PipelineData {
  runId: string;
  order: TradeOrder;
}

export interface MarketResult {
  symbol: string;
  bid: number;
  ask: number;
  observedAt: string;
}

export interface RiskResult {
  approved: boolean;
  reason: string;
  estimatedNotional: number;
  executionPrice: number;
}

export interface ExecutionResult {
  status: 'filled' | 'rejected';
  orderId: string;
  reason?: string;
  filledQuantity?: number;
  averagePrice?: number;
  fee?: number;
  venue?: string;
}

export interface PortfolioResult {
  status: 'booked' | 'unchanged';
  orderId: string;
  reason?: string;
  cash: number;
  position?: { symbol: string; quantity: number; averagePrice: number };
}

export const connection = { host: '127.0.0.1', port: Number(Bun.env.PAPER_TCP_PORT ?? 6789) };
export const httpPort = Number(Bun.env.PAPER_HTTP_PORT ?? 6790);
export const runId = `paper-${Date.now().toString(36)}`;
export const queues = {
  market: `trading-market-${runId}`,
  risk: `trading-risk-${runId}`,
  execution: `trading-execution-${runId}`,
  portfolio: `trading-portfolio-${runId}`,
};

export const timeline: Array<{
  event: 'completed' | 'failed';
  stage: string;
  orderId: string;
  detail?: string;
  at: string;
}> = [];
export const infrastructureErrors: string[] = [];
export const executionAttempts = new Map<string, number>();
export const portfolio = {
  cash: 100_000,
  positions: new Map<string, { quantity: number; averagePrice: number }>(),
};

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

export function round(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

export function childResult<T>(values: Record<string, unknown>): T {
  const value = Object.values(values)[0];
  if (value === undefined) throw new Error('Risultato della fase precedente mancante');
  return value as T;
}

export async function markProgress(
  job: Job<PipelineData>,
  progress: number,
  message: string
): Promise<void> {
  await job.updateProgress(progress, message);
  await job.log(message);
}
