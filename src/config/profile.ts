import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SERVICE_ENV_KEYS, serviceEnvironment } from './runtime-config.js';

export const DEFAULT_PROFILE = 'default';

export interface ProfilePaths {
  rootDir: string;
  profile: string;
  profileDir: string;
  dataDir: string;
  envFile: string;
  activeProfileFile: string;
}

export function normalizeProfileName(value: string): string {
  const profile = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error('profile name must start with an ASCII letter or digit and contain only letters, digits, dot, underscore, or hyphen (max 64 characters)');
  }
  return profile;
}

export function profileRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OSCAR_LARK_HOME ?? env.OSCAR_LARK_DATA_DIR ?? join(homedir(), '.oscar-lark-bridge'));
}

export function resolveProfilePaths(
  profile: string,
  rootDir = profileRoot(),
): ProfilePaths {
  profile = normalizeProfileName(profile);
  rootDir = resolve(rootDir);
  // Keep the historical default layout intact so existing installations do
  // not need a destructive migration. Named profiles use isolated subtrees.
  const profileDir = profile === DEFAULT_PROFILE ? rootDir : join(rootDir, 'profiles', profile);
  return {
    rootDir,
    profile,
    profileDir,
    dataDir: profileDir,
    envFile: join(profileDir, 'service-env.json'),
    activeProfileFile: join(rootDir, 'active-profile'),
  };
}

export function inferServiceProfile(env: NodeJS.ProcessEnv = process.env): ProfilePaths | undefined {
  if (env.OSCAR_LARK_PROFILE) {
    return resolveProfilePaths(env.OSCAR_LARK_PROFILE, profileRoot(env));
  }
  if (!env.OSCAR_LARK_ENV_FILE) return undefined;
  const envFile = resolve(env.OSCAR_LARK_ENV_FILE);
  const profileDir = dirname(envFile);
  const profilesDir = dirname(profileDir);
  if (basename(profilesDir) === 'profiles') {
    return resolveProfilePaths(basename(profileDir), dirname(profilesDir));
  }
  return resolveProfilePaths(DEFAULT_PROFILE, profileDir);
}

export async function resolveSelectedProfile(
  explicit: string | undefined,
  rootDir = profileRoot(),
): Promise<string> {
  if (explicit) return normalizeProfileName(explicit);
  try {
    return normalizeProfileName((await readFile(join(rootDir, 'active-profile'), 'utf8')).trim());
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function profileEnvironment(
  paths: ProfilePaths,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const selected = { ...env };
  if (existsSync(paths.envFile)) {
    // Once a Profile exists, its file is authoritative. Ambient variables
    // often belong to a different App and must not silently cross profiles.
    for (const key of SERVICE_ENV_KEYS) delete selected[key];
  }
  return {
    ...selected,
    OSCAR_LARK_HOME: paths.rootDir,
    OSCAR_LARK_PROFILE: paths.profile,
    OSCAR_LARK_ENV_FILE: existsSync(paths.envFile) ? paths.envFile : undefined,
    // Profile state must remain isolated even when the persisted environment
    // was captured from an older installation with a root data directory.
    OSCAR_LARK_DATA_DIR: paths.dataDir,
  };
}

export async function createProfile(
  paths: ProfilePaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (existsSync(paths.envFile)) throw new Error(`profile already exists: ${paths.profile}`);
  const captured = serviceEnvironment({ ...env, OSCAR_LARK_ENV_FILE: undefined });
  if (!captured.OSCAR_LARK_APP_ID || !captured.OSCAR_LARK_APP_SECRET || !captured.OSCAR_LARK_WORKSPACE) {
    throw new Error('profile create requires OSCAR_LARK_APP_ID, OSCAR_LARK_APP_SECRET and OSCAR_LARK_WORKSPACE');
  }
  await mkdir(dirname(paths.envFile), { recursive: true });
  await writePrivate(paths.envFile, `${JSON.stringify(captured, null, 2)}\n`);
}

export async function listProfiles(rootDir = profileRoot()): Promise<string[]> {
  const result = new Set<string>();
  if (existsSync(join(rootDir, 'service-env.json'))) result.add(DEFAULT_PROFILE);
  try {
    const entries = await readdir(join(rootDir, 'profiles'), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && existsSync(join(rootDir, 'profiles', entry.name, 'service-env.json'))) {
        result.add(normalizeProfileName(entry.name));
      }
    }
  } catch {
    // A fresh installation has no profiles directory yet.
  }
  return [...result].sort((a, b) => a.localeCompare(b));
}

export async function useProfile(paths: ProfilePaths): Promise<void> {
  if (!existsSync(paths.envFile)) throw new Error(`profile not found: ${paths.profile}`);
  await mkdir(dirname(paths.activeProfileFile), { recursive: true });
  await writePrivate(paths.activeProfileFile, `${paths.profile}\n`);
}

export async function removeProfile(paths: ProfilePaths): Promise<void> {
  if (paths.profile === DEFAULT_PROFILE) {
    throw new Error('the legacy default profile cannot be removed; uninstall its service and remove its data manually if required');
  }
  await rm(paths.profileDir, { recursive: true, force: true });
  try {
    const active = (await readFile(paths.activeProfileFile, 'utf8')).trim();
    if (active === paths.profile) await rm(paths.activeProfileFile, { force: true });
  } catch {
    // No active profile marker.
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
}
