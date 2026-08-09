import type { AgentId } from '../domain/agent.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
}

export function agentDoctorChecks(selected: AgentId, selectedAvailable: boolean): DoctorCheck[] {
  const other: AgentId = selected === 'claude' ? 'codex' : 'claude';
  return [
    { name: selected, ok: selectedAvailable, required: true },
    { name: other, ok: true, required: false },
  ];
}

export function formatDoctorCheck(check: DoctorCheck): string {
  const status = check.required ? (check.ok ? 'PASS' : 'FAIL') : 'SKIP';
  return `${status} ${check.name}${check.required ? '' : ' (not selected)'}`;
}
