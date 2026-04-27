import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import yaml from 'js-yaml';

import type { WorkList, Spec, WorkItem } from './types.js';

export const WORK_LIST_FILE = 'specd_work_list.yaml';

export async function loadWorkList(cwd: string): Promise<WorkList> {
  const filePath = resolve(cwd, WORK_LIST_FILE);
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = yaml.load(content) as WorkList;
    if (!parsed || typeof parsed !== 'object') {
      return { specs: [] };
    }
    return normalizeWorkList(parsed);
  } catch {
    return { specs: [] };
  }
}

export async function saveWorkList(cwd: string, workList: WorkList): Promise<void> {
  const filePath = resolve(cwd, WORK_LIST_FILE);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const content = yaml.dump({ specs: workList.specs }, { indent: 2, lineWidth: -1 });
  await writeFile(filePath, content, 'utf-8');
}

// Ensure the loaded work list has proper structure
function normalizeWorkList(data: unknown): WorkList {
  if (!data || typeof data !== 'object') {
    return { specs: [] };
  }

  const obj = data as Record<string, unknown>;
  const specs: Spec[] = [];

  if (Array.isArray(obj.specs)) {
    for (const spec of obj.specs) {
      if (spec && typeof spec === 'object' && 'name' in spec) {
        const s = spec as Record<string, unknown>;
        const items: WorkItem[] = [];

        if (Array.isArray(s.items)) {
          for (const item of s.items) {
            if (item && typeof item === 'object') {
              const i = item as Record<string, unknown>;
              items.push({
                spec: String(s.name),
                description: String(i.description || ''),
                completed: Boolean(i.completed),
                blocked: i.blocked ? String(i.blocked) : undefined,
              });
            }
          }
        }

        specs.push({ name: String(s.name), items });
      }
    }
  }

  return { specs };
}

export function getUnblockedItems(workList: WorkList): WorkItem[] {
  return workList.specs
    .flatMap((s) => s.items)
    .filter((item) => !item.completed && !item.blocked);
}

export function getNextItem(workList: WorkList): WorkItem | null {
  const unblocked = getUnblockedItems(workList);
  return unblocked.length > 0 ? unblocked[0] : null;
}

export function completeItem(workList: WorkList, specName: string, description: string): void {
  const spec = workList.specs.find((s) => s.name === specName);
  if (!spec) return;

  const item = spec.items.find((i) => i.description === description);
  if (item) {
    item.completed = true;
    unblockItems(spec, item.description);
  }
}

function unblockItems(spec: Spec, completedDescription: string): void {
  for (const item of spec.items) {
    if (item.blocked?.includes(completedDescription)) {
      item.blocked = undefined;
    }
  }
}

export function addSpec(workList: WorkList, name: string): Spec {
  const existing = workList.specs.find((s) => s.name === name);
  if (existing) return existing;

  const spec: Spec = { name, items: [] };
  workList.specs.push(spec);
  return spec;
}

export function addItem(
  workList: WorkList,
  specName: string,
  description: string,
  blocked?: string,
): WorkItem {
  const spec = addSpec(workList, specName);
  const item: WorkItem = {
    spec: specName,
    description,
    blocked,
    completed: false,
  };
  spec.items.push(item);
  return item;
}

export function removeItem(workList: WorkList, specName: string, description: string): void {
  const spec = workList.specs.find((s) => s.name === specName);
  if (!spec) return;

  spec.items = spec.items.filter((i) => i.description !== description);
}

export function getSpecsInWorkList(workList: WorkList): string[] {
  return workList.specs.map((s) => s.name);
}
