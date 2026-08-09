import type { ChildProcess } from 'node:child_process';

export async function terminateProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
