import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

import type { WorkList, Spec, WorkItem } from "./types.js";

export const WORK_LIST_FILE = "specd_work_list.yaml";

export async function loadWorkList(cwd: string): Promise<WorkList> {
  const filePath = resolve(cwd, WORK_LIST_FILE);
  try {
    const content = await readFile(filePath, "utf-8");
    return parseYaml(content);
  } catch {
    return { specs: [] };
  }
}

export async function saveWorkList(
  cwd: string,
  workList: WorkList,
): Promise<void> {
  const filePath = resolve(cwd, WORK_LIST_FILE);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const content = stringifyYaml(workList);
  await writeFile(filePath, content, "utf-8");
}

export function getUnblockedItems(workList: WorkList): WorkItem[] {
  return workList.specs
    .filter((s) => s.status === "ready")
    .flatMap((s) => s.items)
    .filter((item) => !item.completed && !item.blocked);
}

export function getNextItem(workList: WorkList): WorkItem | null {
  const unblocked = getUnblockedItems(workList);
  return unblocked.length > 0 ? unblocked[0] : null;
}

export function completeItem(
  workList: WorkList,
  specName: string,
  description: string,
): void {
  const spec = workList.specs.find((s) => s.name === specName);
  if (!spec) return;

  const item = spec.items.find((i) => i.description === description);
  if (item) {
    item.completed = true;
    // Unblock items that were waiting for this one
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

  const spec: Spec = {
    name,
    status: "draft",
    items: [],
  };
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

export function removeItem(
  workList: WorkList,
  specName: string,
  description: string,
): void {
  const spec = workList.specs.find((s) => s.name === specName);
  if (!spec) return;

  spec.items = spec.items.filter((i) => i.description !== description);
}

export function setSpecStatus(
  workList: WorkList,
  specName: string,
  status: Spec["status"],
): void {
  const spec = workList.specs.find((s) => s.name === specName);
  if (spec) {
    spec.status = status;
  }
}

// Simple YAML serializer (no external deps)
function parseYaml(content: string): WorkList {
  const result: WorkList = { specs: [] };
  if (!content.trim()) return result;

  let currentSpec: Spec | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Spec header
    const specMatch = /^#\s*(.+)$/.exec(trimmed);
    if (specMatch) {
      currentSpec = {
        name: specMatch[1],
        status: "draft",
        items: [],
      };
      result.specs.push(currentSpec);
      continue;
    }

    // Status line
    const statusMatch = /^status:\s*(\w+)$/i.exec(trimmed);
    if (statusMatch && currentSpec) {
      currentSpec.status = statusMatch[1].toLowerCase() as Spec["status"];
      continue;
    }

    // Item line
    const itemMatch = /^-\s*(.+)$/.exec(trimmed);
    if (itemMatch && currentSpec) {
      const text = itemMatch[1];
      const blockedMatch = /\(blocked:\s*(.+)\)$/.exec(text);
      const item: WorkItem = {
        spec: currentSpec.name,
        description: blockedMatch
          ? text.replace(/\s*\(blocked:.+\)$/, "").trim()
          : text,
        completed: text.startsWith("[x]"),
        blocked: blockedMatch?.[1],
      };
      currentSpec.items.push(item);
    }
  }

  return result;
}

function stringifyYaml(workList: WorkList): string {
  const lines: string[] = [];

  for (const spec of workList.specs) {
    lines.push(`# ${spec.name}`);
    lines.push(`status: ${spec.status}`);
    lines.push("");

    for (const item of spec.items) {
      let text = item.completed ? "[x] " : "- ";
      text += item.description;
      if (item.blocked) {
        text += ` (blocked: ${item.blocked})`;
      }
      lines.push(text);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}
