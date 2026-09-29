import { describe, expect, it } from 'vitest';
import { MulticaHttpTaskClient } from '../../../src/integrations/multica/http-task-client.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Error' });
}

describe('MulticaHttpTaskClient', () => {
  it('reads incremental messages with bearer auth and resolves issue task status', async () => {
    const requests: Array<{ url: string; auth: string | null; workspace: string | null }> = [];
    const client = new MulticaHttpTaskClient({
      baseUrl: 'http://localhost:8081/',
      token: 'mul_test',
      workspaceId: 'workspace-1',
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        requests.push({ url, auth: headers.get('Authorization'), workspace: headers.get('X-Workspace-ID') });
        if (url.includes('/messages?since=4')) {
          return response([{ task_id: 'task-1', issue_id: 'issue-1', seq: 5, type: 'text', content: 'tail' }]);
        }
        if (url.includes('/task-runs')) return response([{ id: 'task-1', status: 'completed' }]);
        return response([]);
      },
    });

    const messages = await client.listMessages('task-1', 4);
    expect(messages[0]?.content).toBe('tail');
    expect(await client.getTaskStatus('task-1')).toBe('completed');
    expect(requests).toEqual([
      { url: 'http://localhost:8081/api/tasks/task-1/messages?since=4', auth: 'Bearer mul_test', workspace: 'workspace-1' },
      { url: 'http://localhost:8081/api/issues/issue-1/task-runs', auth: 'Bearer mul_test', workspace: 'workspace-1' },
    ]);
  });

  it('surfaces non-2xx responses', async () => {
    const client = new MulticaHttpTaskClient({
      baseUrl: 'http://localhost:8081',
      token: 'mul_test',
      workspaceId: 'workspace-1',
      fetchImpl: async () => response({ message: 'nope' }, 401),
    });
    await expect(client.listMessages('task-1', 0)).rejects.toThrow('Multica API 401');
  });
});
