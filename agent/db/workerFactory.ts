import { DatabaseProcessWorker, type DatabaseWorker } from './processWorker';

let workerUrl: string | undefined;
const spawnWorker = (): DatabaseWorker => new DatabaseProcessWorker(workerUrl);
let queryFactory: () => DatabaseWorker = spawnWorker;
let exportFactory: () => DatabaseWorker = spawnWorker;

export function createQueryWorker(): DatabaseWorker {
  return queryFactory();
}

export function createExportWorker(): DatabaseWorker {
  return exportFactory();
}

/** Optional legacy query/export worker override, still hosted in a killable process. */
export function setQueryWorkerUrl(url: string | null): void {
  workerUrl = url ?? undefined;
}

export function setQueryWorkerFactory(factory: (() => DatabaseWorker) | null): void {
  queryFactory = factory ?? spawnWorker;
}

export function setExportWorkerFactory(factory: (() => DatabaseWorker) | null): void {
  exportFactory = factory ?? spawnWorker;
}
