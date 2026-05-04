/**
 * A work item is either pending (with optional blocker) or completed.
 * Modeled as a discriminated union on `completed` so that `blocked` only
 * exists where it's meaningful. The shared identity fields live on a base
 * interface; both branches inherit them as `readonly` because once a work
 * item is loaded from YAML we never mutate `spec`/`description` in place —
 * `markItemCompleted` constructs a new object with the same identity.
 */
interface WorkItemBase {
  readonly spec: string;
  readonly description: string;
}

export type WorkItem =
  | (WorkItemBase & { completed: false; blocked?: string })
  | (WorkItemBase & { completed: true });

export interface Spec {
  name: string;
  items: WorkItem[];
}

export interface WorkList {
  specs: Spec[];
}
