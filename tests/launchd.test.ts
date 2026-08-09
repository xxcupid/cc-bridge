import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLaunchdPlist, LaunchdService, launchdPaths } from '../src/service/launchd.js';

describe('launchd service', () => {
  it('keeps secrets out of the plist and restarts only after unsuccessful exit', () => {
    const paths = launchdPaths('/tmp/oscar data', '/Users/test');
    const plist = buildLaunchdPlist({ nodePath: '/opt/node', cliPath: '/opt/bridge & cli.js', envPath: '/opt/bin:/usr/bin', paths });
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).toContain('/opt/bridge &amp; cli.js');
    expect(plist).toContain('OSCAR_LARK_ENV_FILE');
    expect(plist).not.toContain('app-secret');
  });

  it.runIf(process.platform === 'darwin')('writes plist and credential file with mode 0600', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oscar-launchd-'));
    const manager = new LaunchdService({ dataDir: join(root, 'data'), home: join(root, 'home'), nodePath: '/opt/node', cliPath: '/opt/cli.js', envPath: '/usr/bin', uid: 501 });
    await manager.install({ OSCAR_LARK_APP_ID: 'cli_test', OSCAR_LARK_APP_SECRET: 'app-secret', OSCAR_LARK_WORKSPACE: '/tmp/project' });
    const plist = await readFile(manager.paths.plist, 'utf8');
    expect(plist).not.toContain('app-secret');
    expect(JSON.parse(await readFile(manager.paths.envFile, 'utf8'))).toMatchObject({ OSCAR_LARK_APP_SECRET: 'app-secret' });
    expect((await stat(manager.paths.plist)).mode & 0o777).toBe(0o600);
    expect((await stat(manager.paths.envFile)).mode & 0o777).toBe(0o600);
  });
});
