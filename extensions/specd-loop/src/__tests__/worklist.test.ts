import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadWorkList, saveWorkList } from '../worklist.js';
import type { WorkList } from '../types.js';

describe('saveWorkList', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'specd-worklist-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('round-trips through loadWorkList', async () => {
    const workList: WorkList = {
      specs: [
        {
          name: 'auth',
          items: [
            { spec: 'auth', description: 'add login endpoint', completed: false },
            { spec: 'auth', description: 'add logout endpoint', completed: true },
          ],
        },
        {
          name: 'billing',
          items: [
            { spec: 'billing', description: 'render invoice', completed: false, blocked: 'spec-q' },
          ],
        },
      ],
    };

    await saveWorkList(scratch, workList);
    const loaded = await loadWorkList(scratch);
    expect(loaded).toEqual(workList);
  });

  it('leaves no .tmp files behind after a successful save', async () => {
    const workList: WorkList = {
      specs: [{ name: 'auth', items: [{ spec: 'auth', description: 'one', completed: false }] }],
    };

    await saveWorkList(scratch, workList);
    const entries = await readdir(scratch);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});
