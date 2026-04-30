import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';

export interface ViewerHandle {
  /** Forward a session event to the viewer. */
  send: (event: AgentSessionEvent) => void;
  /**
   * Subscribe to user input typed into the viewer pane. Each call returns
   * an unsubscribe function. Multiple subscribers are supported but each
   * input is delivered to all of them.
   */
  onInput: (handler: (text: string) => void) => () => void;
  /**
   * Subscribe to viewer-disconnect events (user closed the pane / pressed
   * Ctrl+D in it / it auto-exited). Used by the agent-runner's interactive
   * mode to know when to stop accepting follow-up prompts.
   */
  onClose: (handler: () => void) => () => void;
  /**
   * Close both FIFOs. By default the viewer pane is left alive (it'll
   * auto-exit ~30s after seeing FIFO EOF). Pass `{ kill: true }` to kill the
   * pane immediately — useful when the user explicitly aborted and doesn't
   * want the partial output lingering.
   */
  close: (opts?: { kill?: boolean }) => Promise<void>;
}

interface ActiveViewer {
  fd: number;
  fifo: string;
  reverseFifo: string;
  paneId: string;
  killOnClose: boolean;
}

const active = new Set<ActiveViewer>();
let exitHandlersRegistered = false;

function noop() {
  // intentionally empty
}

function cleanupOne(v: ActiveViewer) {
  try {
    closeSync(v.fd);
  } catch {
    // already closed
  }
  try {
    unlinkSync(v.fifo);
  } catch {
    // already gone
  }
  try {
    unlinkSync(v.reverseFifo);
  } catch {
    // already gone
  }
  if (v.killOnClose && v.paneId) {
    spawnSync('tmux', ['kill-pane', '-t', v.paneId]);
  }
}

function ensureExitHandlers() {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  process.on('exit', () => {
    for (const v of active) cleanupOne(v);
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (process.listenerCount(sig) <= 1) process.exit(128 + signalNumber(sig));
    });
  }
}

function signalNumber(sig: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): number {
  switch (sig) {
    case 'SIGHUP':
      return 1;
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
  }
}

/**
 * Spawn the renderer (viewer.mjs) in a side tmux pane and return a handle that
 * forwards AgentSessionEvents to it via a FIFO and receives user input from
 * the viewer's input box via a reverse FIFO.
 *
 * Returns null if not running inside tmux — the caller should fall back to the
 * widget-based progress display in that case.
 */
export async function spawnViewerPane(opts?: {
  title?: string;
  killOnClose?: boolean;
}): Promise<ViewerHandle | null> {
  if (!process.env.TMUX) return null;

  // Default to false so the viewer pane lingers after a run completes:
  // (1) the agent's final events may still be draining when the parent closes
  //     its end of the FIFO, and an immediate kill-pane drops them mid-render;
  // (2) it lets the user actually read the final state.
  // The viewer auto-exits ~30s after seeing FIFO EOF, so there's no leak.
  const killOnClose = opts?.killOnClose ?? false;
  const stamp = `${process.pid}-${Date.now()}`;
  const fifo = join(tmpdir(), `specd-viewer-${stamp}.fifo`);
  const reverseFifo = join(tmpdir(), `specd-viewer-${stamp}.rev.fifo`);

  const mk1 = spawnSync('mkfifo', ['-m', '600', fifo]);
  if (mk1.status !== 0) return null;
  const mk2 = spawnSync('mkfifo', ['-m', '600', reverseFifo]);
  if (mk2.status !== 0) {
    try {
      unlinkSync(fifo);
    } catch {
      // best-effort
    }
    return null;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const viewer = resolve(here, 'viewer.mjs');

  const cmd = `bash -c "node '${viewer}' '${fifo}' '${reverseFifo}'"`;

  const split = spawn('tmux', ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', cmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let paneId = '';
  split.stdout.on('data', (d: Buffer) => {
    paneId += d.toString();
  });
  const exit = await new Promise<number>((res) => {
    split.on('close', (code) => {
      res(code ?? 0);
    });
  });
  if (exit !== 0) {
    try {
      unlinkSync(fifo);
    } catch {
      // best-effort
    }
    try {
      unlinkSync(reverseFifo);
    } catch {
      // best-effort
    }
    return null;
  }
  paneId = paneId.trim();

  // Open the forward FIFO for writing. Blocks until the viewer opens it for read.
  const fd = openSync(fifo, 'w');
  const handle: ActiveViewer = { fd, fifo, reverseFifo, paneId, killOnClose };
  active.add(handle);
  ensureExitHandlers();

  // Open the reverse FIFO for reading. Each line is a JSON-encoded user message.
  const inputHandlers = new Set<(text: string) => void>();
  const closeHandlers = new Set<() => void>();
  let viewerClosed = false;
  const fireClose = () => {
    if (viewerClosed) return;
    viewerClosed = true;
    for (const h of closeHandlers) {
      try {
        h();
      } catch {
        // ignore handler errors
      }
    }
  };
  const reverseStream = createReadStream(reverseFifo);
  let inputBuffer = '';
  reverseStream.on('data', (chunk) => {
    inputBuffer += chunk.toString();
    let nl: number;
    while ((nl = inputBuffer.indexOf('\n')) !== -1) {
      const line = inputBuffer.slice(0, nl);
      inputBuffer = inputBuffer.slice(nl + 1);
      if (!line) continue;
      let text: string;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'string') continue;
        text = parsed;
      } catch {
        continue;
      }
      for (const h of inputHandlers) h(text);
    }
  });
  reverseStream.on('end', fireClose);
  reverseStream.on('close', fireClose);
  reverseStream.on('error', () => {
    fireClose();
  });

  let closed = false;
  return {
    send: (event) => {
      if (closed) return;
      try {
        writeSync(fd, `${JSON.stringify(event)}\n`);
      } catch {
        closed = true;
      }
    },
    onInput: (handler) => {
      inputHandlers.add(handler);
      return () => inputHandlers.delete(handler);
    },
    onClose: (handler) => {
      if (viewerClosed) {
        // Already closed — fire immediately on next tick.
        queueMicrotask(handler);
        // No-op unsubscribe: the close already fired, nothing to detach.
        return noop;
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close: async (opts) => {
      if (closed) return;
      closed = true;
      reverseStream.destroy();
      active.delete(handle);
      // The handle's killOnClose was the spawn-time default; an explicit
      // override here wins so the caller can decide per-call.
      cleanupOne({ ...handle, killOnClose: opts?.kill ?? handle.killOnClose });
    },
  };
}
