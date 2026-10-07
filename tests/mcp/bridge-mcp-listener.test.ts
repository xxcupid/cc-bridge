import { describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import { startBridgeMcpListener } from '../../src/mcp/bridge-mcp-listener.js';
import type { ChannelPort } from '../../src/channel/port.js';

function request(socketPath: string, payload: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    const chunks: Buffer[] = [];
    let timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('socket request timeout'));
    }, 3000);
    sock.once('error', (err) => { clearTimeout(timer); reject(err); });
    sock.once('connect', () => {
      sock.write(JSON.stringify(payload) + '\n', (err) => {
        if (err) { clearTimeout(timer); reject(err); }
      });
    });
    sock.on('data', (chunk) => {
      chunks.push(chunk);
      // wait briefly for any trailing data
      setTimeout(() => {
        clearTimeout(timer);
        sock.destroy();
        resolve(Buffer.concat(chunks).toString('utf8'));
      }, 50);
    });
  });
}

describe('startBridgeMcpListener', () => {
  it('accepts send_file requests and returns messageId', async () => {
    const sent: Array<{ chatId: string; source: string; fileName: string }> = [];
    const channel: ChannelPort = {
      onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
      async sendMarkdown() {},
      async sendFile(chatId, source, fileName) {
        sent.push({ chatId, source: String(source), fileName });
        return { messageId: 'msg-77' };
      },
    } as unknown as ChannelPort;

    const handle = await startBridgeMcpListener({ channel, chatId: 'oc_chat_x', runId: 'run-1' });

    const response = await request(handle.socketPath, { method: 'send_file', args: { path: '/tmp/a.xlsx', file_name: 'a.xlsx' } });
    await handle.close();
    await unlink(handle.socketPath).catch(() => undefined);

    expect(sent).toEqual([{ chatId: 'oc_chat_x', source: '/tmp/a.xlsx', fileName: 'a.xlsx' }]);
    const parsed = JSON.parse(response);
    expect(parsed.content[0].text).toContain('msg-77');
    expect(parsed.isError).toBeFalsy();
  });

  it('returns isError when channel.sendFile is not implemented', async () => {
    const channel: ChannelPort = {
      onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
      async sendMarkdown() {},
    } as unknown as ChannelPort;

    const handle = await startBridgeMcpListener({ channel, chatId: 'oc_y', runId: 'run-2' });

    const response = await request(handle.socketPath, { method: 'send_file', args: { path: '/tmp/b.xlsx' } });
    await handle.close();
    await unlink(handle.socketPath).catch(() => undefined);

    const parsed = JSON.parse(response);
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0].text).toMatch(/send_file failed/);
  });

  it('returns isError when path is missing', async () => {
    const channel: ChannelPort = {
      onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
      async sendMarkdown() {},
      async sendFile() { return { messageId: 'm' }; },
    } as unknown as ChannelPort;

    const handle = await startBridgeMcpListener({ channel, chatId: 'oc_z', runId: 'run-3' });

    const response = await request(handle.socketPath, { method: 'send_file', args: {} });
    await handle.close();
    await unlink(handle.socketPath).catch(() => undefined);

    const parsed = JSON.parse(response);
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0].text).toMatch(/path is required/);
  });

  it('returns isError for unknown methods', async () => {
    const channel: ChannelPort = {
      onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
      async sendMarkdown() {},
    } as unknown as ChannelPort;

    const handle = await startBridgeMcpListener({ channel, chatId: 'oc_w', runId: 'run-4' });

    const response = await request(handle.socketPath, { method: 'nope', args: {} });
    await handle.close();
    await unlink(handle.socketPath).catch(() => undefined);

    const parsed = JSON.parse(response);
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0].text).toContain('unknown method: nope');
  });
});
