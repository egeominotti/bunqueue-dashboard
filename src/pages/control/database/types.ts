export type Sort = { col: string; dir: 'asc' | 'desc' } | null;
export type Tab = 'data' | 'schema';
export type ColMeta = Record<string, { type: string; primaryKey: boolean }>;
