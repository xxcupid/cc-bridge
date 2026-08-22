import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLaunchdPlist, launchdLabel, LaunchdService, launchdPaths } from '../src/service/launchd.js';

describe('launchd service', () => {
  it('keeps secrets out of the plist and restarts only after unsuccessful exit', () => {
    const paths = launchdPaths('/tmp/oscar data', '/Users/test');
    const plist = buildLaunchdPlist({ nodePath: '/opt/node', cliPath: '/opt/bridge & cli.js', envPath: '/opt/bin:/usr/bin', rootDir: '/tmp/oscar data', profile: 'default', paths });
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).toContain('/opt/bridge &amp; cli.js');
    expect(plist).toContain('OSCAR_LARK_ENV_FILE');
    expect(plist).toContain('OSCAR_LARK_HOME');
    expect(plist).toContain('<string>--profile</string><string>default</string>');
    expect(plist).not.toContain('app-secret');
  });

  it('isolates named profiles by launchd label, plist, environment, and logs', () => {
    const paths = launchdPaths('/tmp/oscar/profiles/work-claude', '/Users/test', 'work-claude');
    const plist = buildLaunchdPlist({ nodePath: '/opt/node', cliPath: '/opt/cli.js', envPath: '/usr/bin', rootDir: '/tmp/oscar', profile: 'work-claude', paths });
    expect(launchdLabel('work-claude')).toBe('com.oscar.lark-bridge.work-claude');
    expect(paths.plist).toBe('/Users/test/Library/LaunchAgents/com.oscar.lark-bridge.work-claude.plist');
    expect(paths.envFile).toBe('/tmp/oscar/profiles/work-claude/service-env.json');
    expect(paths.stdout).toBe('/tmp/oscar/profiles/work-claude/logs/service.stdout.log');
    expect(plist).toContain('<string>work-claude</string>');
    expect(plist).toContain('<string>/tmp/oscar</string>');
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
