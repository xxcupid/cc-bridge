import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { serviceEnvironment } from '../config/runtime-config.js';
import { DEFAULT_PROFILE, normalizeProfileName } from '../config/profile.js';

export const LAUNCHD_LABEL = 'com.oscar.lark-bridge';

export interface LaunchdPaths { plist: string; envFile: string; stdout: string; stderr: string; }
export interface PlistInput { nodePath: string; cliPath: string; envPath: string; rootDir: string; profile: string; paths: LaunchdPaths; }
export interface ServiceResult { ok: boolean; stdout: string; stderr: string; }

export function launchdLabel(profile = DEFAULT_PROFILE): string {
  profile = normalizeProfileName(profile);
  return profile === DEFAULT_PROFILE ? LAUNCHD_LABEL : `${LAUNCHD_LABEL}.${profile}`;
}

export function launchdPaths(dataDir: string, home = homedir(), profile = DEFAULT_PROFILE): LaunchdPaths {
  const logDir = join(dataDir, 'logs');
  return {
    plist: join(home, 'Library', 'LaunchAgents', `${launchdLabel(profile)}.plist`),
    envFile: join(dataDir, 'service-env.json'), stdout: join(logDir, 'service.stdout.log'), stderr: join(logDir, 'service.stderr.log'),
  };
}

export function buildLaunchdPlist(input: PlistInput): string {
  const xml = escapeXml;
  const label = launchdLabel(input.profile);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(resolve(input.nodePath))}</string><string>${xml(resolve(input.cliPath))}</string><string>run</string><string>--profile</string><string>${xml(input.profile)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(input.paths.stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(input.paths.stderr)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(input.envPath)}</string>
    <key>OSCAR_LARK_HOME</key><string>${xml(input.rootDir)}</string>
    <key>OSCAR_LARK_ENV_FILE</key><string>${xml(input.paths.envFile)}</string>
  </dict>
</dict></plist>
`;
}

export class LaunchdService {
  readonly paths: LaunchdPaths;
  readonly profile: string;
  readonly label: string;
  constructor(private readonly input: { profile?: string; rootDir?: string; dataDir: string; nodePath: string; cliPath: string; envPath: string; home?: string; uid?: number }) {
    this.profile = normalizeProfileName(input.profile ?? DEFAULT_PROFILE);
    this.label = launchdLabel(this.profile);
    this.paths = launchdPaths(input.dataDir, input.home, this.profile);
  }
  async install(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('service management currently supports macOS launchd only');
    const captured = serviceEnvironment(env);
    if (!captured.OSCAR_LARK_APP_ID || !captured.OSCAR_LARK_APP_SECRET || !captured.OSCAR_LARK_WORKSPACE) {
      throw new Error('service install requires OSCAR_LARK_APP_ID, OSCAR_LARK_APP_SECRET and OSCAR_LARK_WORKSPACE');
    }
    await mkdir(dirname(this.paths.plist), { recursive: true });
    await mkdir(dirname(this.paths.stdout), { recursive: true });
    await writePrivate(this.paths.envFile, `${JSON.stringify(captured, null, 2)}\n`);
    await writePrivate(this.paths.plist, buildLaunchdPlist({ nodePath: this.input.nodePath, cliPath: this.input.cliPath, envPath: this.input.envPath, rootDir: this.input.rootDir ?? this.input.dataDir, profile: this.profile, paths: this.paths }));
  }
  installed(): boolean { return existsSync(this.paths.plist) && existsSync(this.paths.envFile); }
  loaded(): boolean { return runLaunchctl(['print', this.target()]).ok; }
  start(): ServiceResult {
    runLaunchctl(['enable', this.target()]);
    if (this.loaded()) return runLaunchctl(['kickstart', '-k', this.target()]);
    return runLaunchctl(['bootstrap', this.domain(), this.paths.plist]);
  }
  stop(): ServiceResult {
    const result = runLaunchctl(['bootout', this.target()]);
    runLaunchctl(['disable', this.target()]);
    return result;
  }
  restart(): ServiceResult { return this.loaded() ? runLaunchctl(['kickstart', '-k', this.target()]) : this.start(); }
  status(): { installed: boolean; loaded: boolean; plist: string; envFile: string; stdout: string; stderr: string; detail?: string } {
    const detail = runLaunchctl(['print', this.target()]);
    return { installed: this.installed(), loaded: detail.ok, ...this.paths, ...(detail.ok ? { detail: summarize(detail.stdout) } : {}) };
  }
  async uninstall(): Promise<void> {
    if (this.loaded()) this.stop();
    await rm(this.paths.plist, { force: true });
    await rm(this.paths.envFile, { force: true });
  }
  private domain(): string { return `gui/${this.input.uid ?? userInfo().uid}`; }
  private target(): string { return `${this.domain()}/${this.label}`; }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}
function runLaunchctl(args: string[]): ServiceResult {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function summarize(value: string): string {
  return value.split('\n').filter((line) => /state =|pid =|last exit code =/i.test(line)).map((line) => line.trim()).join('; ');
}
function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
