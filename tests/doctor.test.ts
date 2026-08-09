import { describe, expect, it } from 'vitest';
import { agentDoctorChecks, formatDoctorCheck } from '../src/diagnostics/doctor.js';

describe('Claude-only doctor checks', () => {
  it('requires only the selected Claude adapter', () => {
    const checks = agentDoctorChecks('claude', true);
    expect(checks).toEqual([
      { name: 'claude', ok: true, required: true },
      { name: 'codex', ok: true, required: false },
    ]);
    expect(checks.map(formatDoctorCheck)).toEqual(['PASS claude', 'SKIP codex (not selected)']);
  });

  it('fails when the selected adapter is unavailable', () => {
    expect(agentDoctorChecks('claude', false)[0]).toEqual({ name: 'claude', ok: false, required: true });
  });
});
