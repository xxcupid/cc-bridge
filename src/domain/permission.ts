import type { AccessLevel, PermissionMode } from './agent.js';

const ACCESS_RANK: Record<AccessLevel, number> = {
  'read-only': 0,
  workspace: 1,
  full: 2,
};

export interface PermissionDecision {
  outcome: 'allow' | 'ask' | 'deny';
  reason: string;
}

export function decidePermission(
  mode: PermissionMode,
  maxAccess: AccessLevel,
  requestedAccess: AccessLevel,
): PermissionDecision {
  if (ACCESS_RANK[requestedAccess] > ACCESS_RANK[maxAccess]) {
    return { outcome: 'deny', reason: `requested ${requestedAccess} exceeds maxAccess ${maxAccess}` };
  }
  if (mode === 'yolo') {
    return { outcome: 'allow', reason: 'yolo mode within maxAccess' };
  }
  if (requestedAccess === 'read-only') {
    return { outcome: 'allow', reason: 'read-only action is safe by default' };
  }
  return { outcome: 'ask', reason: 'default mode requires user approval' };
}
