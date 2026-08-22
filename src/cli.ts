import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { AgentRegistry } from './application/agent-registry.js';
import { BridgeApplication } from './application/bridge-application.js';
import { ClaudeAdapter } from './agents/claude/adapter.js';
import { CodexAppServerAdapter } from './agents/codex/app-server-adapter.js';
import { LarkChannelGateway } from './channel/lark-channel.js';
import { loadRuntimeConfig } from './config/runtime-config.js';
import {
  createProfile,
  inferServiceProfile,
  listProfiles,
  profileEnvironment,
  profileRoot,
  removeProfile,
  resolveProfilePaths,
  resolveSelectedProfile,
  useProfile,
  type ProfilePaths,
} from './config/profile.js';
import { SessionStore } from './session/session-store.js';
import { resolveWorkspace } from './workspace/workspace-policy.js';
import { WorkspaceStore } from './workspace/workspace-store.js';
import { ApprovalStore } from './approval/approval-store.js';
import { LaunchdService, type ServiceResult } from './service/launchd.js';
import { agentDoctorChecks, formatDoctorCheck, type DoctorCheck } from './diagnostics/doctor.js';
import { acquireInstanceLocks } from './runtime/instance-lock.js';

interface ProfileOption { profile?: string }

const program = new Command().name('oscar-lark-bridge').description('Feishu/Lark bridge for local coding agents').version('0.1.0');

withProfile(program.command('run').description('Run one bridge profile in the foreground')).action(async (options: ProfileOption) => {
  const paths = await selectedProfilePaths(options.profile);
  const config = loadRuntimeConfig(profileEnvironment(paths));
  const workspace = await resolveWorkspace(config.defaultWorkspace);
  if (!workspace.ok) throw new Error(workspace.message);
  const channel = new LarkChannelGateway({
    appId: config.appId, appSecret: config.appSecret,
    ...(config.domain ? { domain: config.domain } : {}),
    dmAllowlist: config.dmAllowlist, groupAllowlist: config.groupAllowlist,
    requireMention: config.requireMention,
  });
  const agents = new AgentRegistry();
  agents.register(new ClaudeAdapter({ binary: config.claudeBinary }));
  agents.register(new CodexAppServerAdapter({ binary: config.codexBinary }));
  const app = new BridgeApplication({
    channel, agents, defaultAgent: config.defaultAgent, defaultWorkspace: workspace.path,
    permission: config.permission,
    sessions: new SessionStore(join(config.dataDir, 'sessions.json')),
    workspaces: new WorkspaceStore(join(config.dataDir, 'workspaces.json')),
    approvals: new ApprovalStore(join(config.dataDir, 'approvals.json')),
    runTimeoutMs: config.runTimeoutMs,
  });
  const locks = await acquireInstanceLocks(paths.rootDir, paths.profile, config.appId);
  try { await app.start(); }
  catch (error) { await locks.release(); throw error; }
  console.log(`oscar-lark-bridge connected (profile: ${paths.profile})`);
  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    try { await app.stop(); }
    finally { await locks.release(); }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
});

withProfile(program.command('doctor').description('Validate one profile, workspace, and local agent binaries')).action(async (options: ProfileOption) => {
  const paths = await selectedProfilePaths(options.profile);
  let config;
  try { config = loadRuntimeConfig(profileEnvironment(paths)); }
  catch (error) { console.error(`FAIL config: ${(error as Error).message}`); process.exitCode = 1; return; }
  const [claudeAvailable, codexAvailable] = await Promise.all([
    commandAvailable(config.claudeBinary),
    commandAvailable(config.codexBinary),
  ]);
  const checks: DoctorCheck[] = [
    { name: 'workspace', ok: (await resolveWorkspace(config.defaultWorkspace)).ok, required: true },
    ...agentDoctorChecks(config.defaultAgent, { claude: claudeAvailable, codex: codexAvailable }),
    { name: 'app credentials', ok: Boolean(config.appId && config.appSecret), required: true },
  ];
  console.log(`profile: ${paths.profile}`);
  for (const check of checks) console.log(formatDoctorCheck(check));
  if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
});

withProfile(program.command('status').description('Show one profile configuration without revealing secrets')).action(async (options: ProfileOption) => {
  const paths = await selectedProfilePaths(options.profile);
  try {
    const config = loadRuntimeConfig(profileEnvironment(paths));
    console.log(JSON.stringify({ profile: paths.profile, configured: true, appIdSuffix: config.appId.slice(-6), workspace: config.defaultWorkspace, agent: config.defaultAgent, mode: config.permission.mode, maxAccess: config.permission.maxAccess, runTimeoutMs: config.runTimeoutMs, dataDir: config.dataDir }, null, 2));
  } catch (error) { console.log(JSON.stringify({ profile: paths.profile, configured: false, error: (error as Error).message }, null, 2)); process.exitCode = 1; }
});

const profiles = program.command('profile').description('Manage isolated bridge profiles');
profiles.command('create <name>').description('Create a profile from the current OSCAR_LARK_* environment').action(async (name: string) => {
  const paths = resolveProfilePaths(name, profileRoot());
  await createProfile(paths);
  console.log(`profile created: ${paths.profile}`);
});
profiles.command('list').description('List configured profiles').action(async () => {
  const rootDir = profileRoot();
  const active = await resolveSelectedProfile(undefined, rootDir);
  const names = await listProfiles(rootDir);
  console.log(JSON.stringify({ active, profiles: names.map((name) => ({ name, active: name === active })) }, null, 2));
});
profiles.command('show [name]').description('Show a profile without revealing its App Secret').action(async (name?: string) => {
  const paths = await selectedProfilePaths(name);
  const config = loadRuntimeConfig(profileEnvironment(paths));
  console.log(JSON.stringify({ profile: paths.profile, appIdSuffix: config.appId.slice(-6), workspace: config.defaultWorkspace, agent: config.defaultAgent, mode: config.permission.mode, maxAccess: config.permission.maxAccess, dataDir: config.dataDir }, null, 2));
});
profiles.command('use <name>').description('Select the default profile for commands without --profile').action(async (name: string) => {
  const paths = resolveProfilePaths(name, profileRoot());
  await useProfile(paths);
  console.log(`active profile: ${paths.profile}`);
});
profiles.command('remove <name>').description('Permanently remove an inactive named profile').option('--yes', 'confirm permanent deletion').action(async (name: string, options: { yes?: boolean }) => {
  if (!options.yes) throw new Error('profile remove permanently deletes local state; re-run with --yes');
  const paths = resolveProfilePaths(name, profileRoot());
  const manager = serviceManager(paths);
  if (manager.installed() || manager.loaded()) throw new Error(`profile ${paths.profile} still has a service; run service uninstall --profile ${paths.profile} first`);
  await removeProfile(paths);
  console.log(`profile removed: ${paths.profile}`);
});

const service = program.command('service').description('Manage per-profile macOS launchd services');
withProfile(service.command('install').description('Write private profile configuration and install its LaunchAgent')).action(async (options: ProfileOption) => {
  const paths = await selectedProfilePaths(options.profile);
  const env = profileEnvironment(paths);
  loadRuntimeConfig(env);
  const manager = serviceManager(paths);
  await manager.install(env);
  reportServiceResult(manager.start(), `service installed and started (profile: ${paths.profile})`);
});
withProfile(service.command('start').description('Start one installed profile LaunchAgent')).action(async (options: ProfileOption) => {
  const paths = await selectedProfilePaths(options.profile);
  reportServiceResult(serviceManager(paths).start(), `service started (profile: ${paths.profile})`);
});
withProfile(service.command('stop').description('Stop and disable one profile LaunchAgent')).action(async (options: ProfileOption) => {
  const paths = await selectedProfilePaths(options.profile);
  reportServiceResult(serviceManager(paths).stop(), `service stopped (profile: ${paths.profile})`);
});
withProfile(service.command('restart').description('Restart one profile LaunchAgent')).action(async (options: ProfileOption) => {
  const paths = await selectedProfilePaths(options.profile);
  reportServiceResult(serviceManager(paths).restart(), `service restarted (profile: ${paths.profile})`);
});
withProfile(service.command('status').description('Show one profile launchd state and log paths')).action(async (options: ProfileOption) => {
  const paths = await selectedProfilePaths(options.profile);
  console.log(JSON.stringify({ profile: paths.profile, ...serviceManager(paths).status() }, null, 2));
});
withProfile(service.command('uninstall').description('Stop one profile service and remove its plist and private environment file')).action(async (options: ProfileOption) => {
  const paths = await selectedProfilePaths(options.profile);
  await serviceManager(paths).uninstall();
  console.log(`service uninstalled (profile: ${paths.profile})`);
});

async function commandAvailable(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: 'ignore' });
    child.once('error', () => resolve(false)); child.once('exit', (code) => resolve(code === 0));
  });
}

function withProfile(command: Command): Command {
  return command.option('--profile <name>', 'profile name (defaults to the active profile, then default)');
}

async function selectedProfilePaths(explicit: string | undefined): Promise<ProfilePaths> {
  if (!explicit) {
    const serviceProfile = inferServiceProfile();
    if (serviceProfile) return serviceProfile;
  }
  const rootDir = profileRoot();
  return resolveProfilePaths(await resolveSelectedProfile(explicit, rootDir), rootDir);
}

function serviceManager(paths: ProfilePaths): LaunchdService {
  if (process.platform !== 'darwin') throw new Error('service management currently supports macOS launchd only');
  const cliPath = process.argv[1];
  if (!cliPath) throw new Error('cannot determine CLI entry path');
  return new LaunchdService({ profile: paths.profile, rootDir: paths.rootDir, dataDir: paths.dataDir, nodePath: process.execPath, cliPath, envPath: process.env.PATH ?? '' });
}

function reportServiceResult(result: ServiceResult, success: string): void {
  if (!result.ok) throw new Error(result.stderr.trim() || result.stdout.trim() || 'launchctl command failed');
  console.log(success);
}

await program.parseAsync();
