/**
 * A work item is either pending (with optional blocker) or completed.
 * Modeled as a discriminated union on `completed` so that `blocked` only
 * exists where it's meaningful.
 */
export type WorkItem =
  | { spec: string; description: string; completed: false; blocked?: string }
  | { spec: string; description: string; completed: true };

export interface Spec {
  name: string;
  items: WorkItem[];
}

export interface WorkList {
  specs: Spec[];
}
