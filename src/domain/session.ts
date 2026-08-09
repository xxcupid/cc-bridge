import type { AgentId, PermissionMode } from './agent.js';

export interface SessionScope {
  tenantId: string;
  ownerId: string;
  chatId: string;
  threadId?: string;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_answer'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface Session {
  id: string;
  name: string;
  scope: SessionScope;
  agentId: AgentId;
  cwd: string;
  mode: PermissionMode;
  nativeSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}
