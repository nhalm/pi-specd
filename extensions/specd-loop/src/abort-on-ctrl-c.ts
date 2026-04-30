import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { Key, matchesKey } from '@mariozechner/pi-tui';

export interface CtrlCWatcher {
  /**
   * Set the AbortController that Ctrl+C should abort. Pass null while no
   * sub-agent is active (e.g. during a confirm dialog) so keystrokes don't
   * abort anything stale.
   */
  setController: (controller: AbortController | null) => void;
  /** Detach the terminal input listener. */
  unsubscribe: () => void;
}

/**
 * Watch terminal input for Ctrl+C and abort whichever AbortController is
 * currently active. Loop drives this pattern so each phase gets a fresh
 * controller and Ctrl+C only aborts the in-flight sub-agent, not the
 * entire loop.
 *
 * Only Ctrl+C — not Escape. Terminal noise (mouse events, function keys,
 * paste fragments) often emits Esc-prefixed sequences, and treating bare
 * Escape as an abort produced false positives that killed sub-agents
 * mid-run.
 *
 * Uses pi-tui's matchesKey() so this works regardless of whether the Kitty
 * keyboard protocol is active (which encodes Ctrl+C as "\x1b[99;5u" instead
 * of "\x03").
 */
export function abortOnCtrlC(ctx: ExtensionCommandContext): CtrlCWatcher {
  let current: AbortController | null = null;
  const off = ctx.ui.onTerminalInput((data) => {
    if (!current || current.signal.aborted) return;
    if (matchesKey(data, Key.ctrl('c'))) {
      current.abort();
    }
  });
  return {
    setController: (c) => {
      current = c;
    },
    unsubscribe: off,
  };
}
