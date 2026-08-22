import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

describe('loadRuntimeConfig', () => {
  it('requires credentials and workspace without exposing secret transformations', () => {
    expect(() => loadRuntimeConfig({})).toThrow('OSCAR_LARK_APP_ID');
    const config = loadRuntimeConfig({ OSCAR_LARK_APP_ID: 'cli_x', OSCAR_LARK_APP_SECRET: 'secret', OSCAR_LARK_WORKSPACE: '/repo', OSCAR_LARK_MODE: 'yolo', OSCAR_LARK_MAX_ACCESS: 'full' });
    expect(config).toMatchObject({ appId: 'cli_x', appSecret: 'secret', permission: { mode: 'yolo', maxAccess: 'full' }, runTimeoutMs: 1_800_000 });
  });
  it('loads private service JSON while explicit environment values win', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-config-'));
    const path = join(dir, 'service.json');
    await writeFile(path, JSON.stringify({ OSCAR_LARK_APP_ID: 'file-id', OSCAR_LARK_APP_SECRET: 'file-secret', OSCAR_LARK_WORKSPACE: '/tmp', UNTRUSTED: 'ignored' }));
    const config = loadRuntimeConfig({ OSCAR_LARK_ENV_FILE: path, OSCAR_LARK_APP_ID: 'override-id' });
    expect(config.appId).toBe('override-id');
    expect(config.appSecret).toBe('file-secret');
  });
  it('rejects invalid enum settings', () => {
    expect(() => loadRuntimeConfig({ OSCAR_LARK_APP_ID: 'x', OSCAR_LARK_APP_SECRET: 'x', OSCAR_LARK_WORKSPACE: '/repo', OSCAR_LARK_MODE: 'unsafe' })).toThrow('OSCAR_LARK_MODE');
  });
  it('loads a configurable run timeout and rejects invalid values', () => {
    const base = { OSCAR_LARK_APP_ID: 'x', OSCAR_LARK_APP_SECRET: 'x', OSCAR_LARK_WORKSPACE: '/repo' };
    expect(loadRuntimeConfig({ ...base, OSCAR_LARK_RUN_TIMEOUT_MS: '0' }).runTimeoutMs).toBe(0);
    expect(() => loadRuntimeConfig({ ...base, OSCAR_LARK_RUN_TIMEOUT_MS: '-1' })).toThrow('OSCAR_LARK_RUN_TIMEOUT_MS');
  });
});
