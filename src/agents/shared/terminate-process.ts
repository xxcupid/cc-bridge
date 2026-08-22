import type { ChildProcess } from 'node:child_process';

export async function terminateProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    if (child.exitCode !== null || child.signalCode !== null) { finish(); return; }
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      finish();
    }, graceMs);
  });
}
