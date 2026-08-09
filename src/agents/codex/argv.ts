import type { AccessLevel, AgentRunRequest } from '../../domain/agent.js';

const SANDBOX: Record<AccessLevel, string> = {
  'read-only': 'read-only', workspace: 'workspace-write', full: 'danger-full-access',
};

export function buildCodexArgs(request: AgentRunRequest): string[] {
  const global = [
    '--sandbox', SANDBOX[request.permission.maxAccess],
    '-c', 'approval_policy="never"',
    '-c', 'shell_environment_policy.inherit="all"',
    '--skip-git-repo-check', '-C', request.cwd,
    ...(request.model ? ['--model', request.model] : []),
  ];
  if (request.resumeId) return ['exec', ...global, 'resume', '--json', request.resumeId, '-'];
  return ['exec', '--json', ...global, '-'];
}
