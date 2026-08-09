import { AtomicJsonFile } from '../infrastructure/atomic-json-file.js';

interface WorkspaceData { version: 1; byScope: Record<string, string>; named: Record<string, string>; }

export class WorkspaceStore {
  private data: WorkspaceData = { version: 1, byScope: {}, named: {} };
  private saveChain = Promise.resolve();
  private readonly file: AtomicJsonFile<WorkspaceData>;

  constructor(path: string) { this.file = new AtomicJsonFile(path); }
  async load(): Promise<void> { this.data = await this.file.read(this.data); }
  forScope(scope: string): string | undefined { return this.data.byScope[scope]; }
  setScope(scope: string, cwd: string): void { this.data.byScope[scope] = cwd; this.persist(); }
  listNamed(): Record<string, string> { return { ...this.data.named }; }
  getNamed(name: string): string | undefined { return this.data.named[name]; }
  saveNamed(name: string, cwd: string): void { this.data.named[name] = cwd; this.persist(); }
  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name]; this.persist(); return true;
  }
  async flush(): Promise<void> { await this.saveChain; }
  private persist(): void { this.saveChain = this.saveChain.then(() => this.file.write(this.data)); }
}
