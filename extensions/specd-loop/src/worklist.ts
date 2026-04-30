import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

import yaml from 'js-yaml';

import type { WorkList, Spec, WorkItem } from './types.js';
import { isRecord, asString } from './yaml-helpers.js';

export const WORK_LIST_FILE = 'specd_work_list.yaml';

export async function loadWorkList(cwd: string): Promise<WorkList> {
  const filePath = resolve(cwd, WORK_LIST_FILE);
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { specs: [] };
    }
    throw new Error(`Failed to read ${WORK_LIST_FILE}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new Error(`Failed to parse ${WORK_LIST_FILE} as YAML: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return normalizeWorkList(parsed);
}

export async function saveWorkList(cwd: string, workList: WorkList): Promise<void> {
  const filePath = resolve(cwd, WORK_LIST_FILE);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const content = yaml.dump({ specs: workList.specs }, { indent: 2, lineWidth: -1 });
  await writeFile(filePath, content, 'utf-8');
}

function normalizeWorkList(data: unknown): WorkList {
  if (!isRecord(data)) {
    return { specs: [] };
  }

  const specs: Spec[] = [];

  if (Array.isArray(data.specs)) {
    for (const spec of data.specs) {
      if (!isRecord(spec) || !('name' in spec)) continue;
      const name = asString(spec.name);
      if (!name) continue; // a non-string or empty name is treated as no spec
      const items: WorkItem[] = [];

      if (Array.isArray(spec.items)) {
        for (const item of spec.items) {
          if (!isRecord(item)) continue;
          const description = asString(item.description);
          // Strict equality on the literal `true`. A hand-edited YAML file
          // with `completed: "false"` (string) or `completed: 1` would
          // truthy-coerce into the completed branch under truthy checks; we
          // want anything that isn't the YAML boolean `true` to remain
          // pending so the loop will pick it up.
          if (item.completed === true) {
            items.push({ spec: name, description, completed: true });
          } else {
            items.push({
              spec: name,
              description,
              completed: false,
              blocked: typeof item.blocked === 'string' ? item.blocked : undefined,
            });
          }
        }
      }

      specs.push({ name, items });
    }
  }

  return { specs };
}

type PendingItem = Extract<WorkItem, { completed: false }>;
type BlockedItem = PendingItem & { blocked: string };

export function getUnblockedItems(workList: WorkList): PendingItem[] {
  return workList.specs
    .flatMap((s) => s.items)
    .filter((item): item is PendingItem => !item.completed && !item.blocked);
}

export function getBlockedItems(workList: WorkList): BlockedItem[] {
  return workList.specs
    .flatMap((s) => s.items)
    .filter(
      (item): item is BlockedItem =>
        !item.completed && typeof item.blocked === 'string' && item.blocked.length > 0,
    );
}

export function pickNextItem(workList: WorkList): PendingItem | null {
  return getUnblockedItems(workList)[0] ?? null;
}

/**
 * Flip `completed: true` for the item identified by spec + description.
 * Returns true if a matching item was found and marked, false otherwise.
 */
export function markItemCompleted(
  workList: WorkList,
  specName: string,
  description: string,
): boolean {
  const spec = workList.specs.find((s) => s.name === specName);
  if (!spec) return false;
  const idx = spec.items.findIndex((i) => i.description === description && !i.completed);
  if (idx === -1) return false;
  const existing = spec.items[idx];
  spec.items[idx] = { spec: existing.spec, description: existing.description, completed: true };
  return true;
}

export function getCompletedCount(workList: WorkList): number {
  return workList.specs.flatMap((s) => s.items).filter((item) => item.completed).length;
}

/**
 * Drop specs from the work list when every item under them is `completed: true`.
 * Returns the names of the specs that were dropped.
 */
export function pruneCompletedSpecs(workList: WorkList): string[] {
  const dropped: string[] = [];
  workList.specs = workList.specs.filter((spec) => {
    const allDone = spec.items.length > 0 && spec.items.every((i) => i.completed);
    if (allDone) dropped.push(spec.name);
    return !allDone;
  });
  return dropped;
}
