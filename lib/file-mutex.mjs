import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A directory mutex shared by the control-plane modules.
//
// Holding the lock means owning the directory created by mkdir. Each holder
// records a random token, and release only removes a lock that still carries
// that token. A lock whose owner process is gone, or that is older than
// staleMs, may be reclaimed — but only inside a second, short-lived reclaim
// mutex that re-checks the token, so two waiters can never both delete a lock
// and both enter the critical section.

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readOwner(lock) {
  try {
    return JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function lockAgeMs(lock) {
  const info = await stat(lock).catch(() => null);
  return info ? Date.now() - info.mtimeMs : null;
}

async function isStale(lock, staleMs) {
  const age = await lockAgeMs(lock);
  if (age === null) return { stale: false, gone: true };
  const owner = await readOwner(lock);
  // The owner file is written right after mkdir; give it a moment to appear.
  if (!owner) return { stale: age > Math.min(staleMs, 5000), owner: null };
  return { stale: age > staleMs || !processAlive(owner.pid), owner };
}

async function reclaim(lock, observedOwner, staleMs) {
  const guard = `${lock}.reclaim`;
  try {
    await mkdir(guard);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const age = await lockAgeMs(guard);
    if (age !== null && age > 10_000) await rmdir(guard).catch(() => {});
    return;
  }
  try {
    const current = await isStale(lock, staleMs);
    if (current.gone || !current.stale) return;
    if ((current.owner?.token ?? null) !== (observedOwner?.token ?? null)) return;
    await rm(lock, { recursive: true, force: true });
  } finally {
    await rmdir(guard).catch(() => {});
  }
}

export async function acquireFileMutex(lock, { timeoutMs = 5000, staleMs = 30_000, label = 'mutex' } = {}) {
  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() }));
      return { lock, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const state = await isStale(lock, staleMs);
    if (state.stale) {
      await reclaim(lock, state.owner, staleMs);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function releaseFileMutex(handle) {
  if (!handle) return;
  const owner = await readOwner(handle.lock);
  if (owner?.token !== handle.token) return;
  await rm(handle.lock, { recursive: true, force: true });
}

export async function withFileMutex(lock, options, operation) {
  const handle = await acquireFileMutex(lock, options);
  try {
    return await operation();
  } finally {
    await releaseFileMutex(handle);
  }
}
