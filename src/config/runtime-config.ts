import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { AccessLevel, AgentId, PermissionMode } from '../domain/agent.js';

export interface RuntimeConfig {
  appId: string;
  appSecret: string;
  domain?: string;
  defaultWorkspace: string;
  defaultAgent: AgentId;
  permission: { mode: PermissionMode; maxAccess: AccessLevel };
  dmAllowlist: string[];
  groupAllowlist: string[];
  requireMention: boolean;
  dataDir: string;
  claudeBinary: string;
  codexBinary: string;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  env = mergeServiceEnvironment(env);
  const appId = required(env, 'OSCAR_LARK_APP_ID');
  const appSecret = required(env, 'OSCAR_LARK_APP_SECRET');
  const defaultWorkspace = required(env, 'OSCAR_LARK_WORKSPACE');
  const defaultAgent = oneOf(env.OSCAR_LARK_DEFAULT_AGENT ?? 'claude', ['claude', 'codex'] as const, 'OSCAR_LARK_DEFAULT_AGENT');
  const mode = oneOf(env.OSCAR_LARK_MODE ?? 'default', ['default', 'yolo'] as const, 'OSCAR_LARK_MODE');
  const maxAccess = oneOf(env.OSCAR_LARK_MAX_ACCESS ?? 'workspace', ['read-only', 'workspace', 'full'] as const, 'OSCAR_LARK_MAX_ACCESS');
  return {
    appId, appSecret, defaultWorkspace: resolve(defaultWorkspace), defaultAgent,
    permission: { mode, maxAccess },
    ...(env.OSCAR_LARK_DOMAIN ? { domain: env.OSCAR_LARK_DOMAIN } : {}),
    dmAllowlist: csv(env.OSCAR_LARK_DM_ALLOWLIST),
    groupAllowlist: csv(env.OSCAR_LARK_GROUP_ALLOWLIST),
    requireMention: env.OSCAR_LARK_REQUIRE_MENTION !== 'false',
    dataDir: resolve(env.OSCAR_LARK_DATA_DIR ?? join(homedir(), '.oscar-lark-bridge')),
    claudeBinary: env.OSCAR_LARK_CLAUDE_BINARY ?? 'claude',
    codexBinary: env.OSCAR_LARK_CODEX_BINARY ?? 'codex',
  };
}

const SERVICE_ENV_KEYS = [
  'OSCAR_LARK_APP_ID', 'OSCAR_LARK_APP_SECRET', 'OSCAR_LARK_WORKSPACE', 'OSCAR_LARK_DEFAULT_AGENT',
  'OSCAR_LARK_MODE', 'OSCAR_LARK_MAX_ACCESS', 'OSCAR_LARK_DOMAIN', 'OSCAR_LARK_DM_ALLOWLIST',
  'OSCAR_LARK_GROUP_ALLOWLIST', 'OSCAR_LARK_REQUIRE_MENTION', 'OSCAR_LARK_DATA_DIR',
  'OSCAR_LARK_CLAUDE_BINARY', 'OSCAR_LARK_CODEX_BINARY',
] as const;

export function serviceEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SERVICE_ENV_KEYS) if (env[key] !== undefined) result[key] = env[key]!;
  return result;
}

function mergeServiceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = env.OSCAR_LARK_ENV_FILE;
  if (!path) return env;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(resolve(path), 'utf8')); }
  catch (error) { throw new Error(`cannot read OSCAR_LARK_ENV_FILE: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OSCAR_LARK_ENV_FILE must contain a JSON object');
  const allowed = new Set<string>(SERVICE_ENV_KEYS);
  const fromFile: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (allowed.has(key) && typeof value === 'string') fromFile[key] = value;
  }
  return { ...fromFile, ...env };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim(); if (!value) throw new Error(`missing required environment variable: ${key}`); return value;
}
function csv(value: string | undefined): string[] { return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []; }
function oneOf<const T extends readonly string[]>(value: string, allowed: T, key: string): T[number] {
  if (!allowed.includes(value)) throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
  return value as T[number];
}
