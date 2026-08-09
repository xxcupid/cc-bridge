import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { AgentRegistry } from './application/agent-registry.js';
import { BridgeApplication } from './application/bridge-application.js';
import { ClaudeAdapter } from './agents/claude/adapter.js';
import { CodexAppServerAdapter } from './agents/codex/app-server-adapter.js';
import { LarkChannelGateway } from './channel/lark-channel.js';
import { loadRuntimeConfig } from './config/runtime-config.js';
import { SessionStore } from './session/session-store.js';
import { resolveWorkspace } from './workspace/workspace-policy.js';
import { WorkspaceStore } from './workspace/workspace-store.js';
import { ApprovalStore } from './approval/approval-store.js';
import { LaunchdService, type ServiceResult } from './service/launchd.js';
import { agentDoctorChecks, formatDoctorCheck, type DoctorCheck } from './diagnostics/doctor.js';

const program = new Command().name('oscar-lark-bridge').description('Feishu/Lark bridge for local coding agents').version('0.1.0');

program.command('run').description('Run the bridge in the foreground').action(async () => {
  const config = loadRuntimeConfig();
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
  });
  await app.start();
  console.log('oscar-lark-bridge connected');
  const shutdown = async (signal: string) => { console.log(`received ${signal}, shutting down`); await app.stop(); process.exit(0); };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
});

program.command('doctor').description('Validate configuration, workspace, and local agent binaries').action(async () => {
  let config;
  try { config = loadRuntimeConfig(); }
  catch (error) { console.error(`FAIL config: ${(error as Error).message}`); process.exitCode = 1; return; }
  const selectedBinary = config.defaultAgent === 'claude' ? config.claudeBinary : config.codexBinary;
  const checks: DoctorCheck[] = [
    { name: 'workspace', ok: (await resolveWorkspace(config.defaultWorkspace)).ok, required: true },
    ...agentDoctorChecks(config.defaultAgent, await commandAvailable(selectedBinary)),
    { name: 'app credentials', ok: Boolean(config.appId && config.appSecret), required: true },
  ];
  for (const check of checks) console.log(formatDoctorCheck(check));
  if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
});

program.command('status').description('Show local configuration status without revealing secrets').action(() => {
  try {
    const config = loadRuntimeConfig();
    console.log(JSON.stringify({ configured: true, appIdSuffix: config.appId.slice(-6), workspace: config.defaultWorkspace, agent: config.defaultAgent, mode: config.permission.mode, maxAccess: config.permission.maxAccess, dataDir: config.dataDir }, null, 2));
  } catch (error) { console.log(JSON.stringify({ configured: false, error: (error as Error).message }, null, 2)); process.exitCode = 1; }
});

const service = program.command('service').description('Manage the macOS launchd user service');
service.command('install').description('Write private service configuration and install the LaunchAgent').action(async () => {
  loadRuntimeConfig();
  const manager = serviceManager();
  await manager.install();
  const result = manager.start();
  reportServiceResult(result, 'service installed and started');
});
service.command('start').description('Start the installed LaunchAgent').action(() => reportServiceResult(serviceManager().start(), 'service started'));
service.command('stop').description('Stop and disable the LaunchAgent').action(() => reportServiceResult(serviceManager().stop(), 'service stopped'));
service.command('restart').description('Restart the LaunchAgent').action(() => reportServiceResult(serviceManager().restart(), 'service restarted'));
service.command('status').description('Show launchd state and log paths without secrets').action(() => {
  console.log(JSON.stringify(serviceManager().status(), null, 2));
});
service.command('uninstall').description('Stop the service and remove its plist and private environment file').action(async () => {
  await serviceManager().uninstall();
  console.log('service uninstalled');
});

async function commandAvailable(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: 'ignore' });
    child.once('error', () => resolve(false)); child.once('exit', (code) => resolve(code === 0));
  });
}

function serviceManager(): LaunchdService {
  if (process.platform !== 'darwin') throw new Error('service management currently supports macOS launchd only');
  const cliPath = process.argv[1];
  if (!cliPath) throw new Error('cannot determine CLI entry path');
  const dataDir = resolve(process.env.OSCAR_LARK_DATA_DIR ?? join(homedir(), '.oscar-lark-bridge'));
  return new LaunchdService({ dataDir, nodePath: process.execPath, cliPath, envPath: process.env.PATH ?? '' });
}

function reportServiceResult(result: ServiceResult, success: string): void {
  if (!result.ok) throw new Error(result.stderr.trim() || result.stdout.trim() || 'launchctl command failed');
  console.log(success);
}

await program.parseAsync();
