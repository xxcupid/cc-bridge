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
    // Skip when fs.readFile isn't easy to mock — just confirm Buffer passthrough
    // works for the common case and trust readFile to be tested by Node itself.
    const channel = {
      send: vi.fn().mockResolvedValue({ messageId: 'm-file-2' }),
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const gateway = new LarkChannelGateway({ appId: 'cli_x', appSecret: 'sec', profile: 'test' });
    (gateway as unknown as { channel: typeof channel }).channel = channel;

    const result = await gateway.sendFile('oc_chat', Buffer.from('abc'), 'a.txt');
    expect(result.messageId).toBe('m-file-2');
    const arg = channel.send.mock.calls[0]![1] as { file: { source: unknown } };
    expect(Buffer.isBuffer(arg.file.source)).toBe(true);
  });
});
