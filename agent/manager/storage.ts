import type { DbStats } from './types';

/** Stat a SQLite database plus its WAL/SHM sidecars. */
export async function databaseStats(path: string): Promise<DbStats> {
  const one = async (file: string): Promise<{ size: number; mtimeMs: number | null }> => {
    try {
      const handle = Bun.file(file);
      if (!(await handle.exists())) return { size: 0, mtimeMs: null };
      return { size: handle.size, mtimeMs: handle.lastModified };
    } catch {
      return { size: 0, mtimeMs: null };
    }
  };
  const [main, wal, shm] = await Promise.all([
    one(path),
    one(`${path}-wal`),
    one(`${path}-shm`),
  ]);
  return {
    path,
    exists: main.mtimeMs !== null,
    size: main.size,
    walSize: wal.size,
    shmSize: shm.size,
    totalSize: main.size + wal.size + shm.size,
    mtimeMs: main.mtimeMs,
  };
}
