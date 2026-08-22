import type { AgentId } from '../domain/agent.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
}

export function agentDoctorChecks(selected: AgentId, availability: Record<AgentId, boolean>): DoctorCheck[] {
  const other: AgentId = selected === 'claude' ? 'codex' : 'claude';
  return [
    { name: selected, ok: availability[selected], required: true },
    { name: other, ok: availability[other], required: false },
  ];
}

export function formatDoctorCheck(check: DoctorCheck): string {
  if (check.required) return `${check.ok ? 'PASS' : 'FAIL'} ${check.name}`;
  return check.ok ? `PASS ${check.name} (optional)` : `SKIP ${check.name} (not installed, optional)`;
}
