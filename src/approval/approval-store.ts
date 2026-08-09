import { createHash, randomBytes } from 'node:crypto';
import { AtomicJsonFile } from '../infrastructure/atomic-json-file.js';

export type ApprovalKind = 'approval' | 'question';

export interface ApprovalEntry {
  token: string;
  kind: ApprovalKind;
  runId: string;
  sessionId: string;
  scope: string;
  operatorId: string;
  requestId: string;
  action: string;
  parameterFingerprint: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

interface ApprovalData { version: 1; entries: ApprovalEntry[]; }

export class ApprovalStore {
  private data: ApprovalData = { version: 1, entries: [] };
  private saveChain = Promise.resolve();
  private readonly file: AtomicJsonFile<ApprovalData>;

  constructor(path: string, private readonly ttlMs = 15 * 60_000) { this.file = new AtomicJsonFile(path); }

  async load(): Promise<void> {
    this.data = await this.file.read(this.data);
    if (this.data.version !== 1 || !Array.isArray(this.data.entries)) throw new Error('unsupported approvals file');
    this.prune();
  }

  issue(input: Omit<ApprovalEntry, 'token' | 'createdAt' | 'expiresAt' | 'consumedAt' | 'parameterFingerprint'> & { parameters?: unknown }): ApprovalEntry {
    const now = Date.now();
    const entry: ApprovalEntry = {
      token: randomBytes(24).toString('base64url'), kind: input.kind, runId: input.runId,
      sessionId: input.sessionId, scope: input.scope, operatorId: input.operatorId,
      requestId: input.requestId, action: input.action,
      parameterFingerprint: fingerprint(input.parameters),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    this.data.entries.push(entry); this.persist(); return { ...entry };
  }

  consume(token: string, expected: { runId: string; scope: string; operatorId: string }, now = Date.now()): ApprovalEntry | undefined {
    const entry = this.data.entries.find((item) => item.token === token);
    if (!entry || entry.consumedAt || Date.parse(entry.expiresAt) <= now) return undefined;
    if (entry.runId !== expected.runId || entry.scope !== expected.scope || entry.operatorId !== expected.operatorId) return undefined;
    entry.consumedAt = new Date(now).toISOString(); this.persist(); return { ...entry };
  }

  peek(token: string, now = Date.now()): ApprovalEntry | undefined {
    const entry = this.data.entries.find((item) => item.token === token);
    if (!entry || entry.consumedAt || Date.parse(entry.expiresAt) <= now) return undefined;
    return { ...entry };
  }

  async flush(): Promise<void> { await this.saveChain; }

  private prune(now = Date.now()): void {
    const cutoff = now - 24 * 60 * 60_000;
    this.data.entries = this.data.entries.filter((entry) => Date.parse(entry.expiresAt) > cutoff);
  }
  private persist(): void { this.saveChain = this.saveChain.then(() => this.file.write(this.data)); }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
