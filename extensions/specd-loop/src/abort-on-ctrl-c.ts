import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { Key, matchesKey } from '@mariozechner/pi-tui';

export interface CtrlCWatcher {
  /**
   * Attach an AbortController so Ctrl+C will abort it. Returns a release
   * function — call it (e.g. in a `finally`) to detach the controller.
   * Calling `bind()` while another controller is bound replaces it; the
   * release fn for the displaced controller becomes a no-op.
   */
  bind: (controller: AbortController) => () => void;
  /** Detach the terminal-input listener; no further Ctrl+C aborts will fire. */
  unsubscribe: () => void;
}

/**
 * Watch terminal input for Ctrl+C and abort whichever AbortController is
 * currently bound. Loop drives this pattern so each phase gets a fresh
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
    bind: (c) => {
      current = c;
      // The release fn only clears `current` if it still points at the
      // controller we bound. If a later bind() displaced it, the release is
      // a no-op so the active controller isn't accidentally detached.
      return () => {
        if (current === c) current = null;
      };
    },
    unsubscribe: off,
  };
}
