import { randomUUID } from 'node:crypto';
import type { AgentId, PermissionMode } from '../domain/agent.js';
import { AtomicJsonFile } from '../infrastructure/atomic-json-file.js';

export interface StoredSession {
  id: string;
  name: string;
  scope: string;
  agentId: AgentId;
  cwd: string;
  mode: PermissionMode;
  nativeSessionId?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

interface SessionData {
  version: 1;
  sessions: StoredSession[];
  activeByScope: Record<string, string>;
}

export class SessionStore {
  private data: SessionData = { version: 1, sessions: [], activeByScope: {} };
  private saveChain = Promise.resolve();
  private readonly file: AtomicJsonFile<SessionData>;

  constructor(path: string) { this.file = new AtomicJsonFile(path); }

  async load(): Promise<void> {
    const loaded = await this.file.read(this.data);
    if (loaded.version !== 1 || !Array.isArray(loaded.sessions)) throw new Error('unsupported sessions file');
    this.data = loaded;
  }

  create(scope: string, input: { name?: string; agentId: AgentId; cwd: string; mode: PermissionMode }): StoredSession {
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: randomUUID(), name: input.name?.trim() || `session-${this.list(scope).length + 1}`,
      scope, agentId: input.agentId, cwd: input.cwd, mode: input.mode, createdAt: now, updatedAt: now,
    };
    this.data.sessions.push(session);
    this.data.activeByScope[scope] = session.id;
    this.persist();
    return { ...session };
  }

  active(scope: string): StoredSession | undefined {
    const id = this.data.activeByScope[scope];
    return id ? this.get(id) : undefined;
  }

  list(scope: string, includeEnded = false): StoredSession[] {
    return this.data.sessions
      .filter((session) => session.scope === scope && (includeEnded || !session.endedAt))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => ({ ...session }));
  }

  switch(scope: string, target: string): StoredSession | undefined {
    const normalized = target.trim().toLowerCase();
    const candidates = this.list(scope);
    const session = candidates.find((item) => item.id === target)
      ?? candidates.find((item) => item.id.startsWith(target))
      ?? candidates.find((item) => item.name.toLowerCase() === normalized);
    if (!session) return undefined;
    this.data.activeByScope[scope] = session.id;
    this.touch(session.id);
    return this.get(session.id);
  }

  updateNativeSession(id: string, nativeSessionId: string): void {
    const session = this.mutable(id);
    if (!session) return;
    session.nativeSessionId = nativeSessionId;
    this.touch(id);
  }

  updateWorkspace(id: string, cwd: string): void {
    const session = this.mutable(id);
    if (!session) return;
    session.cwd = cwd;
    session.nativeSessionId = undefined;
    this.touch(id);
  }

  updateAgent(id: string, agentId: AgentId): void {
    const session = this.mutable(id);
    if (!session) return;
    session.agentId = agentId;
    session.nativeSessionId = undefined;
    this.touch(id);
  }

  updateMode(id: string, mode: PermissionMode): void {
    const session = this.mutable(id);
    if (!session) return;
    session.mode = mode;
    this.touch(id);
  }

  end(scope: string, id?: string): StoredSession | undefined {
    const target = id ? this.mutable(id) : this.mutable(this.data.activeByScope[scope] ?? '');
    if (!target || target.scope !== scope || target.endedAt) return undefined;
    target.endedAt = new Date().toISOString();
    target.updatedAt = target.endedAt;
    if (this.data.activeByScope[scope] === target.id) delete this.data.activeByScope[scope];
    this.persist();
    return { ...target };
  }

  async flush(): Promise<void> { await this.saveChain; }

  private get(id: string): StoredSession | undefined {
    const session = this.mutable(id);
    return session && !session.endedAt ? { ...session } : undefined;
  }

  private mutable(id: string): StoredSession | undefined { return this.data.sessions.find((item) => item.id === id); }

  private touch(id: string): void {
    const session = this.mutable(id);
    if (session) session.updatedAt = new Date().toISOString();
    this.persist();
  }

  private persist(): void {
    this.saveChain = this.saveChain.then(() => this.file.write(this.data));
  }
}
