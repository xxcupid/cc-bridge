import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli.ts',
    'src/mcp/oscar-bridge-mcp.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    // tsup prepends `#!/usr/bin/env node` to every entry. The MCP child is
    // invoked via `node dist/mcp/oscar-bridge-mcp.js`, not directly, so it
    // does not need a shebang — strip the duplicate one tsup emitted.
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = 'dist/mcp/oscar-bridge-mcp.js';
    const text = await readFile(path, 'utf8');
    const stripped = text.replace(/^#!\/usr\/bin\/env node\n/g, '');
    await writeFile(path, stripped, 'utf8');
  },
});
