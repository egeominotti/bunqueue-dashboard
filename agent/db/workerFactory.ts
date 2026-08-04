let workerUrl = new URL('../dbQueryWorker.ts', import.meta.url).href;

const spawnWorker = (): Worker => new Worker(workerUrl, { type: 'module' });
let queryFactory: () => Worker = spawnWorker;
let exportFactory: () => Worker = spawnWorker;

export function createQueryWorker(): Worker {
  return queryFactory();
}

export function createExportWorker(): Worker {
  return exportFactory();
}

export function setQueryWorkerUrl(url: string): void {
  workerUrl = url;
}

export function setQueryWorkerFactory(factory: (() => Worker) | null): void {
  queryFactory = factory ?? spawnWorker;
}

export function setExportWorkerFactory(factory: (() => Worker) | null): void {
  exportFactory = factory ?? spawnWorker;
}
