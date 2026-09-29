import type { MulticaTaskClient, MulticaTaskMessage } from './task-message-client.js';

export interface MulticaHttpTaskClientOptions {
  baseUrl: string;
  token: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
}

interface IssueTask {
  id?: string;
  status?: string;
  status_category?: string;
}

/**
 * User-authenticated HTTP client for the existing Multica task APIs.
 *
 * The message endpoint is incremental (`since` is a sequence number). The
 * task status endpoint is issue-scoped, so the client learns issue_id from
 * the first TaskMessage batch and then queries the issue's task-runs list.
 */
export class MulticaHttpTaskClient implements MulticaTaskClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly workspaceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly issueByTask = new Map<string, string>();

  constructor(options: MulticaHttpTaskClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.workspaceId = options.workspaceId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listMessages(taskId: string, since: number): Promise<MulticaTaskMessage[]> {
    const query = since > 0 ? `?since=${encodeURIComponent(String(since))}` : '';
    const response = await this.request(`/api/tasks/${encodeURIComponent(taskId)}/messages${query}`);
    const messages = await decodeJson<MulticaTaskMessage[]>(response);
    for (const message of messages) {
      if (message.issue_id) this.issueByTask.set(taskId, message.issue_id);
    }
    return messages;
  }

  async getTaskStatus(taskId: string): Promise<string> {
    const issueId = this.issueByTask.get(taskId);
    if (!issueId) return 'running';
    const response = await this.request(`/api/issues/${encodeURIComponent(issueId)}/task-runs`);
    const tasks = await decodeJson<IssueTask[]>(response);
    const task = tasks.find((candidate) => candidate.id === taskId);
    return task?.status_category ?? task?.status ?? 'running';
  }

  private request(path: string): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Workspace-ID': this.workspaceId,
        Accept: 'application/json',
      },
    }).then((response) => {
      if (!response.ok) throw new Error(`Multica API ${response.status}: ${response.statusText}`);
      return response;
    });
  }
}

async function decodeJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    throw new Error(`Multica API returned invalid JSON: ${(error as Error).message}`);
  }
}
