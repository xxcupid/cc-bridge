import { describe, expect, it } from 'vitest';
import { agentDoctorChecks, formatDoctorCheck } from '../src/diagnostics/doctor.js';

describe('Claude-only doctor checks', () => {
  it('requires only the selected Claude adapter', () => {
    const checks = agentDoctorChecks('claude', { claude: true, codex: false });
    expect(checks).toEqual([
      { name: 'claude', ok: true, required: true },
      { name: 'codex', ok: false, required: false },
    ]);
    expect(checks.map(formatDoctorCheck)).toEqual(['PASS claude', 'SKIP codex (not installed, optional)']);
  });

  it('fails when the selected adapter is unavailable', () => {
    expect(agentDoctorChecks('claude', { claude: false, codex: true })[0]).toEqual({ name: 'claude', ok: false, required: true });
  });

  it('reports an installed non-default adapter without making it required', () => {
    const optional = agentDoctorChecks('claude', { claude: true, codex: true })[1]!;
    expect(optional).toEqual({ name: 'codex', ok: true, required: false });
    expect(formatDoctorCheck(optional)).toBe('PASS codex (optional)');
  });
});
