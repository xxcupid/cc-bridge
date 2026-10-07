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
    // replace the internal channel with the mock
    (gateway as unknown as { channel: typeof channel }).channel = channel;

    const result = await gateway.sendFile('oc_chat', '/tmp/report.xlsx', 'report.xlsx');
    expect(result).toEqual({ messageId: 'm-file-1' });
    expect(channel.send).toHaveBeenCalledWith(
      'oc_chat',
      { file: { source: '/tmp/report.xlsx', fileName: 'report.xlsx' } },
      {},
    );
  });
});
