import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LarkChannelGateway } from '../../src/channel/lark-channel.js';

describe('LarkChannelGateway.sendFile', () => {
  it('forwards file uploads through the underlying lark channel', async () => {
    const channel = {
      send: vi.fn().mockResolvedValue({ messageId: 'm-file-1' }),
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const gateway = new LarkChannelGateway({ appId: 'cli_x', appSecret: 'sec', profile: 'test' });
    (gateway as unknown as { channel: typeof channel }).channel = channel;

    const result = await gateway.sendFile('oc_chat', Buffer.from('hello'), 'report.xlsx');
    expect(result).toEqual({ messageId: 'm-file-1' });
    expect(channel.send).toHaveBeenCalledWith(
      'oc_chat',
      { file: { source: Buffer.from('hello'), fileName: 'report.xlsx' } },
      {},
    );
  });

  it('resolves a string source to a Buffer before handing to the SDK', async () => {
    const channel = {
      send: vi.fn().mockResolvedValue({ messageId: 'm-file-2' }),
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const gateway = new LarkChannelGateway({ appId: 'cli_x', appSecret: 'sec', profile: 'test' });
    (gateway as unknown as { channel: typeof channel }).channel = channel;

    const dir = await mkdtemp(join(tmpdir(), 'gateway-file-'));
    try {
      const file = join(dir, 'a.txt'); await writeFile(file, 'abc');
      const result = await gateway.sendFile('oc_chat', file, 'a.txt', { allowedFileDirs: [dir], replyTo: 'source', replyInThread: true });
      expect(result.messageId).toBe('m-file-2');
      expect(channel.send).toHaveBeenCalledWith('oc_chat', { file: { source: Buffer.from('abc'), fileName: 'a.txt' } }, { replyTo: 'source', replyInThread: true });
      await expect(gateway.sendFile('oc_chat', file, 'a.txt')).rejects.toThrow('outside allowed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
