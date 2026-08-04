import fixtures from './fixtures.json';

export type Json = Record<string, unknown>;
export const F = fixtures as unknown as Record<string, Json>;
