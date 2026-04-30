/**
 * A coherent unit of work the loop driver runs as one sub-agent invocation.
 *
 * The driver calls `runOneShot` with the phase's prompt, then routes the
 * resulting AgentRunResult through a per-phase post-check to decide what
 * happens next. The phase itself is just a typed bundle of strings — it
 * doesn't carry the post-check, because each post-check is currently
 * distinct enough that lifting it would add more indirection than it saves.
 */
export interface Phase {
  /**
   * Short human-readable label, e.g. 'review intake' or 'cycle 2/5: [auth] add login'.
   * Drives the viewer banner and the rolling-log widget header.
   */
  label: string;
  /** The prompt text handed to the sub-agent. */
  prompt: string;
  /** Filename stem for log output (e.g. 'review-intake', 'implement-cycle-2', 'audit'). */
  logSlug: string;
}
