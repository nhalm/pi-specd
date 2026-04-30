import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

import { type CtrlCWatcher } from './abort-on-ctrl-c.js';
import { runAgentSession, type AgentRunResult, type RunAgentOptions } from './agent-runner.js';
import { type ViewerHandle } from './viewer-host.js';

export interface OneShotOptions {
  /** Prompt text handed to the sub-agent. */
  prompt: string;
  /**
   * Phase label used to (a) seed the rolling-log widget header when the
   * tmux viewer isn't available, and (b) update the viewer banner on
   * entry. Pass something like 'review intake' or 'cycle 2/5: [auth] add login'.
   */
  label: string;
  /**
   * If provided, the helper drives this viewer (sends frames, sets title,
   * routes input). If null, falls back to widget mode.
   */
  viewer: ViewerHandle | null;
  /** Set true if the side pane was already closed in a prior phase. */
  isViewerClosed: boolean;
  /** Ctrl+C watcher for this run. The helper binds an AbortController for the duration. */
  ctrlC: CtrlCWatcher;
}

/**
 * Run a single sub-agent prompt to completion. Wires the standard widget /
 * viewer / steering / abort scaffold so loop.ts and migrate.ts don't each
 * repeat it.
 *
 * Note: this helper does NOT do the "user Ctrl+C'd → ask if they want to
 * continue" prompt. That belongs to the cycle-loop driver, not to a one-shot.
 * Callers receive a plain AgentRunResult and decide what to do next.
 */
export async function runOneShot(
  ctx: ExtensionCommandContext,
  opts: OneShotOptions,
): Promise<AgentRunResult> {
  const { prompt, label, viewer, isViewerClosed, ctrlC } = opts;
  const viewerLive = viewer !== null && !isViewerClosed;

  if (viewerLive) viewer.setTitle(label);

  const runOpts: RunAgentOptions = viewerLive
    ? {
        display: {
          kind: 'frames',
          onFrame: (frame) => {
            viewer.send(frame);
          },
        },
        interactive: { attachInput: (steer) => viewer.onInput(steer) },
      }
    : {
        display: {
          kind: 'log',
          onUpdate: (lines) => {
            ctx.ui.setWidget('specd-activity', [label, ...lines]);
          },
        },
      };

  const controller = new AbortController();
  const release = ctrlC.bind(controller);
  // try/finally so a Ctrl+C arriving between the `await` resolving and the
  // release can't fire against an already-finished controller. The
  // agent-runner currently no-ops on a post-completion abort, but relying on
  // that is brittle — release eagerly instead.
  let result: AgentRunResult;
  try {
    result = await runAgentSession(ctx.cwd, prompt, { ...runOpts, signal: controller.signal });
  } finally {
    release();
  }

  // Widget-mode runs leave a stale activity widget pinned above the editor
  // after the sub-agent exits — clear it so the next phase starts clean.
  // Viewer-mode runs don't paint the widget, so there's nothing to clear.
  if (!viewerLive) ctx.ui.setWidget('specd-activity', undefined);

  return result;
}
