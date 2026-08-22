import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProfile,
  inferServiceProfile,
  listProfiles,
  normalizeProfileName,
  profileEnvironment,
  removeProfile,
  resolveProfilePaths,
  resolveSelectedProfile,
  useProfile,
} from '../src/config/profile.js';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

describe('bridge profiles', () => {
  it('keeps the legacy default layout and isolates named profile state', () => {
    const root = '/tmp/oscar';
    expect(resolveProfilePaths('default', root)).toMatchObject({
      profileDir: root,
      envFile: '/tmp/oscar/service-env.json',
      dataDir: root,
    });
    expect(resolveProfilePaths('work-claude', root)).toMatchObject({
      profileDir: '/tmp/oscar/profiles/work-claude',
      envFile: '/tmp/oscar/profiles/work-claude/service-env.json',
      dataDir: '/tmp/oscar/profiles/work-claude',
    });
  });

  it('pins legacy and named services from their environment file paths', () => {
    expect(inferServiceProfile({ OSCAR_LARK_ENV_FILE: '/tmp/oscar/service-env.json' })).toMatchObject({
      profile: 'default', rootDir: '/tmp/oscar',
    });
    expect(inferServiceProfile({ OSCAR_LARK_ENV_FILE: '/tmp/oscar/profiles/codex/service-env.json' })).toMatchObject({
      profile: 'codex', rootDir: '/tmp/oscar',
    });
  });

  it('rejects path traversal and unsafe service labels', () => {
    for (const value of ['', '../escape', 'has space', '中文', '.hidden']) {
      expect(() => normalizeProfileName(value)).toThrow('profile name');
    }
    expect(normalizeProfileName('work_codex-1.2')).toBe('work_codex-1.2');
  });

  it('creates, selects, lists, and removes isolated named profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oscar-profiles-'));
    const work = resolveProfilePaths('work-claude', root);
    await createProfile(work, {
      OSCAR_LARK_APP_ID: 'cli_work',
      OSCAR_LARK_APP_SECRET: 'secret',
      OSCAR_LARK_WORKSPACE: '/repo',
    });
    expect(JSON.parse(await readFile(work.envFile, 'utf8'))).toMatchObject({ OSCAR_LARK_APP_ID: 'cli_work' });
    expect(await listProfiles(root)).toEqual(['work-claude']);
    await useProfile(work);
    expect(await resolveSelectedProfile(undefined, root)).toBe('work-claude');
    expect(profileEnvironment(work, {})).toMatchObject({
      OSCAR_LARK_HOME: root,
      OSCAR_LARK_DATA_DIR: work.dataDir,
      OSCAR_LARK_ENV_FILE: work.envFile,
      OSCAR_LARK_PROFILE: 'work-claude',
    });
    expect(loadRuntimeConfig(profileEnvironment(work, {
      OSCAR_LARK_APP_ID: 'cli_wrong_ambient_app',
      OSCAR_LARK_APP_SECRET: 'wrong-ambient-secret',
      OSCAR_LARK_WORKSPACE: '/wrong/ambient/workspace',
    }))).toMatchObject({ appId: 'cli_work', appSecret: 'secret', defaultWorkspace: '/repo' });
    await removeProfile(work);
    expect(await listProfiles(root)).toEqual([]);
    expect(await resolveSelectedProfile(undefined, root)).toBe('default');
  });

  it('requires complete credentials when creating a profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oscar-profiles-invalid-'));
    await expect(createProfile(resolveProfilePaths('broken', root), { OSCAR_LARK_APP_ID: 'cli_x' }))
      .rejects.toThrow('OSCAR_LARK_APP_SECRET');
  });
});
