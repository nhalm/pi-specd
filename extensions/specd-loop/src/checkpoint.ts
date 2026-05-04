import { existsSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { asString, isRecord } from './yaml-helpers.js';

const CHECKPOINT_FILE = '.specd-loop-checkpoint.json';

export interface Checkpoint {
  /** ISO timestamp the checkpoint was written. */
  startedAt: string;
  /** The item the cycle was about to mark complete + persist. */
  pendingItem: { spec: string; description: string };
  /** Best-effort context for the user. */
  cycle: number;
}

/**
 * Write a checkpoint marking that a cycle is about to complete an item.
 * The driver removes this file after `saveWorkList` succeeds; if a crash
 * happens between mark+save, the file is left behind and the next run
 * detects it.
 *
 * Note: if multiple `/specd:loop` invocations target the same repo at once
 * (they shouldn't, but they could), the checkpoint file becomes a race —
 * this module does not defend against that, by design.
 */
export async function writeCheckpoint(cwd: string, ckpt: Checkpoint): Promise<void> {
  const path = resolve(cwd, CHECKPOINT_FILE);
  // Use a temp-then-rename pattern for consistency with saveWorkList; the
  // checkpoint is best-effort but a partially written JSON file would defeat
  // the purpose of the recovery anchor.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(ckpt, null, 2), 'utf-8');
  try {
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Best-effort delete; does not throw if the file doesn't exist. */
export async function clearCheckpoint(cwd: string): Promise<void> {
  const path = resolve(cwd, CHECKPOINT_FILE);
  try {
    await unlink(path);
  } catch {
    // already gone
  }
}

/** Read the current checkpoint, or null if none / unreadable / malformed. */
export async function readCheckpoint(cwd: string): Promise<Checkpoint | null> {
  const path = resolve(cwd, CHECKPOINT_FILE);
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return null;
    const startedAt = asString(parsed.startedAt);
    const cycle = typeof parsed.cycle === 'number' ? parsed.cycle : 0;
    if (!isRecord(parsed.pendingItem)) return null;
    const spec = asString(parsed.pendingItem.spec);
    const description = asString(parsed.pendingItem.description);
    if (!startedAt || !spec || !description) return null;
    return { startedAt, pendingItem: { spec, description }, cycle };
  } catch {
    return null;
  }
}

export const CHECKPOINT_FILENAME = CHECKPOINT_FILE;
