import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHECKPOINT_FILENAME,
  clearCheckpoint,
  readCheckpoint,
  writeCheckpoint,
} from '../checkpoint.js';

describe('checkpoint', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'specd-checkpoint-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('round-trips through write and read', async () => {
    const ckpt = {
      startedAt: '2024-01-01T00:00:00.000Z',
      pendingItem: { spec: 'auth', description: 'add login' },
      cycle: 3,
    };
    await writeCheckpoint(scratch, ckpt);
    const loaded = await readCheckpoint(scratch);
    expect(loaded).toEqual(ckpt);
  });

  it('returns null when no checkpoint file exists', async () => {
    const loaded = await readCheckpoint(scratch);
    expect(loaded).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    await writeFile(join(scratch, CHECKPOINT_FILENAME), 'not json {{{', 'utf-8');
    const loaded = await readCheckpoint(scratch);
    expect(loaded).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    // Missing pendingItem entirely.
    await writeFile(
      join(scratch, CHECKPOINT_FILENAME),
      JSON.stringify({ startedAt: '2024-01-01T00:00:00.000Z', cycle: 1 }),
      'utf-8',
    );
    expect(await readCheckpoint(scratch)).toBeNull();

    // pendingItem present but missing description.
    await writeFile(
      join(scratch, CHECKPOINT_FILENAME),
      JSON.stringify({
        startedAt: '2024-01-01T00:00:00.000Z',
        cycle: 1,
        pendingItem: { spec: 'auth' },
      }),
      'utf-8',
    );
    expect(await readCheckpoint(scratch)).toBeNull();

    // Missing startedAt.
    await writeFile(
      join(scratch, CHECKPOINT_FILENAME),
      JSON.stringify({
        cycle: 1,
        pendingItem: { spec: 'auth', description: 'x' },
      }),
      'utf-8',
    );
    expect(await readCheckpoint(scratch)).toBeNull();
  });

  it('clearCheckpoint is idempotent on a missing file', async () => {
    await expect(clearCheckpoint(scratch)).resolves.toBeUndefined();
    await expect(clearCheckpoint(scratch)).resolves.toBeUndefined();
  });

  it('clearCheckpoint removes an existing checkpoint', async () => {
    await writeCheckpoint(scratch, {
      startedAt: '2024-01-01T00:00:00.000Z',
      pendingItem: { spec: 'auth', description: 'x' },
      cycle: 1,
    });
    expect(await readCheckpoint(scratch)).not.toBeNull();
    await clearCheckpoint(scratch);
    expect(await readCheckpoint(scratch)).toBeNull();
  });
});
