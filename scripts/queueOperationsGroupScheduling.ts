import { Queue, Worker, type Job } from 'bunqueue/client';
import { assert } from './flowRuntimeSupport';

type Connection = {
  host: string;
  port: number;
  poolSize: number;
};

export async function validateGroupScheduling(
  queueName: string,
  connection: Connection,
  workers: Worker[]
): Promise<void> {
  const priorityQueueName = `${queueName}-priority`;
  const priorityQueue = new Queue(priorityQueueName, {
    autoBatch: { enabled: false },
    connection,
  });
  const groupId = `priority-${Date.now()}`;
  const order: string[] = [];
  let completed!: () => void;
  const finished = new Promise<void>((resolveFinished) => {
    completed = resolveFinished;
  });
  try {
    await priorityQueue.waitUntilReady();
    await priorityQueue.add('priority-seven', {}, { group: { id: groupId, priority: 7 } });
    await priorityQueue.add('priority-two', {}, { group: { id: groupId, priority: 2 } });
    const worker = new Worker(
      priorityQueueName,
      async (job: Job) => {
        order.push(job.name);
        if (order.length === 2) completed();
      },
      { concurrency: 1, group: { concurrency: 1 }, connection }
    );
    worker.on('error', () => undefined);
    workers.push(worker);
    await worker.waitUntilReady();
    await Promise.race([
      finished,
      Bun.sleep(10_000).then(() => {
        throw new Error('group priority worker timed out');
      }),
    ]);
    assert(order.join(',') === 'priority-two,priority-seven', 'group priority claim order failed');
  } finally {
    priorityQueue.close();
  }
}
