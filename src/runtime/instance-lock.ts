import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

interface LockRecord {
  token: string;
  pid: number;
  profile: string;
  appIdSuffix: string;
  startedAt: string;
}

export interface InstanceLocks {
  release(): Promise<void>;
}

export async function acquireInstanceLocks(
  rootDir: string,
  profile: string,
  appId: string,
  pid = process.pid,
): Promise<InstanceLocks> {
  const lockDir = join(rootDir, 'registry', 'locks');
  await mkdir(lockDir, { recursive: true });
  const profileLock = await acquireLock(join(lockDir, `profile-${safeKey(profile)}.lock`), { pid, profile, appId });
  try {
    const appLock = await acquireLock(join(lockDir, `app-${safeKey(appId)}.lock`), { pid, profile, appId });
    return {
      release: async () => {
        await appLock.release();
        await profileLock.release();
      },
    };
  } catch (error) {
    await profileLock.release();
    throw error;
  }
}

async function acquireLock(
  path: string,
  owner: { pid: number; profile: string; appId: string },
): Promise<{ release(): Promise<void> }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const record: LockRecord = {
      token,
      pid: owner.pid,
      profile: owner.profile,
      appIdSuffix: owner.appId.slice(-6),
      startedAt: new Date().toISOString(),
    };
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.close();
      return { release: async () => releaseOwnedLock(path, token) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readLock(path);
      if (existing && processAlive(existing.pid)) {
        throw new Error(`bridge instance already running: profile=${existing.profile} app=...${existing.appIdSuffix} pid=${existing.pid}`);
      }
      await rm(path, { force: true });
    }
  }
  throw new Error(`cannot acquire bridge instance lock: ${path}`);
}

async function releaseOwnedLock(path: string, token: string): Promise<void> {
  const record = await readLock(path);
  if (record?.token === token) await rm(path, { force: true });
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LockRecord>;
    if (typeof value.token !== 'string' || typeof value.pid !== 'number' || typeof value.profile !== 'string') return undefined;
    return value as LockRecord;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function safeKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
