import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The real @remnote/plugin-sdk bundle references `self` at module scope and
// cannot load under node. Tests that import src/adapter/adapter.ts (which
// value-imports the SDK's enums) get a tiny stub instead — see
// tests/sdk-stub.ts. Type-only imports are erased at transform time, so
// typechecking still runs against the real SDK.
export default defineConfig({
  resolve: {
    alias: {
      '@remnote/plugin-sdk': path.resolve(__dirname, 'tests/sdk-stub.ts'),
    },
  },
});
