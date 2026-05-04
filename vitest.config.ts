import { defineConfig } from 'vitest/config';

// ESM project (package.json "type": "module"). Tests live next to source under
// extensions/**/__tests__/. The runner only picks up *.test.ts files there so
// we don't accidentally treat unrelated files (e.g. viewer.mjs) as tests.
export default defineConfig({
  test: {
    include: ['extensions/**/*.test.ts'],
  },
});
