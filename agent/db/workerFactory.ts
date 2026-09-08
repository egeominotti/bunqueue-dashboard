import { DatabaseProcessWorker, type DatabaseWorker } from './processWorker';

const spawnWorker = (): DatabaseWorker => new DatabaseProcessWorker();
let queryFactory: () => DatabaseWorker = spawnWorker;
let exportFactory: () => DatabaseWorker = spawnWorker;

export function createQueryWorker(): DatabaseWorker {
  return queryFactory();
}

export function createExportWorker(): DatabaseWorker {
  return exportFactory();
}

/** @deprecated SQLite now runs in a self-reexecuted process; no worker URL is needed. */
export function setQueryWorkerUrl(_url: string): void {}

export function setQueryWorkerFactory(factory: (() => DatabaseWorker) | null): void {
  queryFactory = factory ?? spawnWorker;
}

export function setExportWorkerFactory(factory: (() => DatabaseWorker) | null): void {
  exportFactory = factory ?? spawnWorker;
}
