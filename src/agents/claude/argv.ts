import type { AccessLevel, AgentRunRequest } from '../../domain/agent.js';

export type ClaudePermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

export function claudePermissionMode(request: AgentRunRequest): ClaudePermissionMode {
  if (request.permission.mode === 'default') return 'default';
  const mapping: Record<AccessLevel, ClaudePermissionMode> = {
    'read-only': 'plan',
    workspace: 'acceptEdits',
    full: 'bypassPermissions',
  };
  return mapping[request.permission.maxAccess];
}

export function buildClaudeArgs(request: AgentRunRequest): string[] {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--permission-prompt-tool',
    'stdio',
    '--replay-user-messages',
    '--verbose',
  ];
  const permissionMode = claudePermissionMode(request);
  if (permissionMode !== 'default') args.push('--permission-mode', permissionMode);
  if (request.resumeId) args.push('--resume', request.resumeId);
  if (request.model) args.push('--model', request.model);
  return args;
}
