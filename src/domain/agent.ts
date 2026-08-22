export type AgentId = 'claude' | 'codex';
export type AccessLevel = 'read-only' | 'workspace' | 'full';
export type PermissionMode = 'default' | 'yolo';
export interface RunMetrics {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Tokens currently occupying the model context window. */
  totalTokens?: number;
  /** Maximum model context window size. */
  contextTokens?: number;
}

export interface AgentRunRequest {
  runId: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  resumeId?: string;
  model?: string;
  permission: { mode: PermissionMode; maxAccess: AccessLevel };
}

export type AgentEvent =
  | { type: 'session.started'; nativeSessionId: string }
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.started'; toolCallId: string; name: string; input?: unknown }
  | { type: 'tool.completed'; toolCallId: string; output?: unknown; isError: boolean }
  | { type: 'metrics.updated'; metrics: RunMetrics }
  | { type: 'approval.requested'; requestId: string; action: string; access: AccessLevel; details?: unknown; token?: string }
  | { type: 'question.requested'; questionId: string; prompt: string; options?: string[]; token?: string }
  | { type: 'run.completed'; nativeSessionId?: string; metrics?: RunMetrics }
  | { type: 'run.cancelled'; reason?: string }
  | { type: 'run.failed'; message: string; code?: string };

export interface AgentRunHandle {
  events: AsyncIterable<AgentEvent>;
  cancel(reason?: string): Promise<void>;
  approve(requestId: string, approved: boolean): Promise<void>;
  answer(questionId: string, answer: string): Promise<void>;
}

export interface AgentAdapter {
  readonly id: AgentId;
  start(request: AgentRunRequest): Promise<AgentRunHandle>;
}
