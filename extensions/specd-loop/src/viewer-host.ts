import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, writeSync, unlinkSync, constants as fsConstants } from 'node:fs';
import { open as fsOpen, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { ActivityFrame } from './activity-frame.js';

export interface ViewerHandle {
  /** Forward an ActivityFrame to the viewer. */
  send: (frame: ActivityFrame) => void;
  /**
   * Update the banner pinned at the top of the viewer pane. The viewer
   * displays `specd · <title> — type below to steer the sub-agent`. Used by
   * the loop driver to identify the current phase per cycle.
   */
  setTitle: (title: string) => void;
  /**
   * Mark the run as finished. Sends a 'specd:done' control frame so the
   * viewer can render a completion footer. The pane stays open until the
   * user closes it or the FIFO timeout fires (whichever comes first).
   */
  setDone: (summary?: string) => void;
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
   * auto-exit ~5min after seeing FIFO EOF as a crash safety-net; on a clean
   * run the parent calls `setDone` first and the user dismisses the pane
   * manually). Pass `{ kill: true }` to kill the pane immediately — useful
   * when the user explicitly aborted and doesn't want the partial output
   * lingering.
   */
  close: (opts?: { kill?: boolean }) => Promise<void>;
}

interface ActiveViewer {
  handle: FileHandle;
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

// Idempotent: tolerates being called multiple times (e.g. from the explicit
// close() path and again from the process-exit handler). Each step is wrapped
// in its own try/catch so a no-op on one resource doesn't skip the rest, and
// FileHandle.close() rejects with EBADF on a second call which we swallow.
function cleanupOne(v: ActiveViewer) {
  try {
    void v.handle.close().catch(() => {
      // already closed / handle invalidated
    });
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
    try {
      spawnSync('tmux', ['kill-pane', '-t', v.paneId]);
    } catch {
      // pane already gone or tmux unavailable
    }
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
  // On clean exit the parent sends `specd:done` and the user dismisses the
  // pane manually. The viewer also auto-exits ~5min after seeing FIFO EOF as
  // a crash safety-net, so an orphaned pane can't linger forever.
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

  // Open the forward FIFO for writing without blocking. A non-blocking
  // write-side open of a FIFO whose reader hasn't connected yet returns ENXIO,
  // so we poll with a small backoff until the viewer opens its read end. If
  // viewer.mjs crashes during init (theme load, pi-tui import, terminal-size
  // weirdness) the read end never opens — without a timeout the parent would
  // hang forever, so we cap the wait and fall back to widget mode (null).
  //
  // Two-step open: first an O_NONBLOCK probe to detect the reader (or time
  // out), then a normal blocking re-open so subsequent writeSync calls retain
  // their original blocking semantics (the alternative would be EAGAIN errors
  // whenever the FIFO buffer briefly backs up).
  const openDeadlineMs = 3000;
  const openPollMs = 50;
  const startedAt = Date.now();
  let probeHandle: FileHandle | null = null;
  let openFatal = false;
  while (Date.now() - startedAt < openDeadlineMs) {
    try {
      probeHandle = await fsOpen(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENXIO') {
        await delay(openPollMs);
        continue;
      }
      // Any other error is fatal — can't recover.
      openFatal = true;
      break;
    }
  }
  let fileHandle: FileHandle | null = null;
  if (probeHandle && !openFatal) {
    // Reader is now attached. Close the non-blocking probe and reopen with
    // standard blocking write semantics so writeSync behaves as before.
    try {
      await probeHandle.close();
    } catch {
      // ignore
    }
    try {
      fileHandle = await fsOpen(fifo, 'w');
    } catch {
      fileHandle = null;
    }
  }
  if (!fileHandle) {
    // Viewer never connected (or the second open raced with a viewer crash).
    // Kill the pane (if any) and clean up the FIFOs; the caller will see null
    // and fall back to the widget progress display.
    if (paneId) {
      try {
        spawnSync('tmux', ['kill-pane', '-t', paneId]);
      } catch {
        // pane already gone
      }
    }
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

  const fd = fileHandle.fd;
  const handle: ActiveViewer = { handle: fileHandle, fifo, reverseFifo, paneId, killOnClose };
  active.add(handle);
  ensureExitHandlers();

  // Open the reverse FIFO for reading. Each line is a JSON-encoded user message.
  const inputHandlers = new Set<(text: string) => void>();
  const closeHandlers = new Set<() => void>();
  let viewerClosed = false;
  const fireClose = () => {
    if (viewerClosed) return;
    viewerClosed = true;
    // Snapshot so a handler that unsubscribes itself (or registers a new one)
    // doesn't perturb the in-flight iteration.
    for (const h of [...closeHandlers]) {
      try {
        h();
      } catch {
        // ignore handler errors
      }
    }
  };
  // Decode as UTF-8 here so multi-byte sequences split across chunk
  // boundaries are reassembled by Node's StringDecoder rather than corrupted
  // by per-chunk Buffer.toString() calls (which would yield invalid JSON the
  // catch below silently dropped).
  const reverseStream = createReadStream(reverseFifo, { encoding: 'utf-8' });
  let inputBuffer = '';
  reverseStream.on('data', (chunk: string) => {
    inputBuffer += chunk;
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
      // Snapshot so a handler that unsubscribes itself doesn't perturb the
      // iteration mid-flight.
      for (const h of [...inputHandlers]) h(text);
    }
  });
  reverseStream.on('end', fireClose);
  reverseStream.on('close', fireClose);
  reverseStream.on('error', () => {
    fireClose();
  });

  let closed = false;
  const writeLine = (payload: unknown) => {
    if (closed) return;
    try {
      writeSync(fd, `${JSON.stringify(payload)}\n`);
    } catch {
      closed = true;
    }
  };

  // Push the spawn-time title to the viewer immediately so the banner
  // identifies the pane before any frames arrive.
  if (opts?.title) {
    writeLine({ kind: 'control', subtype: 'specd:title', title: opts.title });
  }

  return {
    send: (frame) => {
      writeLine(frame);
    },
    setTitle: (title) => {
      writeLine({ kind: 'control', subtype: 'specd:title', title });
    },
    setDone: (summary) => {
      writeLine({ kind: 'control', subtype: 'specd:done', summary });
    },
    onInput: (handler) => {
      inputHandlers.add(handler);
      return () => inputHandlers.delete(handler);
    },
    onClose: (handler) => {
      if (viewerClosed) {
        // Already closed — fire immediately on next tick. Wrap in try/catch
        // so a throwing handler doesn't surface as an unhandled rejection in
        // the microtask queue (matches the in-flight fireClose contract).
        queueMicrotask(() => {
          try {
            handler();
          } catch {
            // ignore handler errors
          }
        });
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
