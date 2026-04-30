import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createAgentSession, type AgentSessionEvent } from '@mariozechner/pi-coding-agent';

/**
 * Outcome of a single sub-agent run. The `kind` discriminator replaces the
 * older `success` / `aborted` boolean pair so callers can never observe the
 * nonsense combination `success: true, aborted: true`. `'error'` covers the
 * old `success: false, aborted: false` case (the runner caught an exception
 * mid-flight) and carries the original error along for diagnostics.
 */
export type AgentRunResult =
  | { kind: 'success'; output: string }
  | { kind: 'aborted'; output: string }
  | { kind: 'error'; output: string; error?: unknown };

/**
 * How the runner surfaces sub-agent activity to the user. Modeled as a
 * tagged union so the two render paths (rolling-log widget vs live event
 * stream to a side viewer) are mutually exclusive — previously a caller
 * could pass both `onLogUpdate` and `onEvent` and the runner would dutifully
 * fire both, which had no use case and just hid bugs.
 *
 * - `'log'`: the runner builds a bounded rolling activity log internally
 *   and calls `onUpdate(lines)` whenever it changes. Lines are ordered
 *   oldest → newest. Suited to a compact widget above the editor.
 * - `'events'`: the runner forwards every raw AgentSessionEvent to
 *   `onEvent` so a richer external UI (e.g. the tmux side pane) can
 *   render it however it wants. The internal log is still maintained
 *   for the transcript but no callback fires for it.
 */
export type DisplayMode =
  | { kind: 'log'; onUpdate: (lines: string[]) => void }
  | { kind: 'events'; onEvent: (event: AgentSessionEvent) => void };

/**
 * Live-input wiring for sub-agents we want to be able to steer mid-run.
 * The runner invokes `attachInput(steer)` once the session is created and
 * passes a `steer(text)` function that queues user input into the live
 * session. The caller returns a detacher the runner calls when the session
 * ends so any input subscription can be cleaned up.
 */
export interface InteractiveOptions {
  attachInput: (steer: (text: string) => void) => () => void;
}

export interface RunAgentOptions {
  display?: DisplayMode;
  interactive?: InteractiveOptions;
  /**
   * AbortSignal that, when triggered, calls session.abort() to stop the
   * running sub-agent. The returned result has `kind: 'aborted'`.
   */
  signal?: AbortSignal;
}

const MAX_ENTRIES = 6;
const MAX_LINE_LEN = 100;

interface Entry {
  id?: string;
  lines: string[];
}

/**
 * Run a one-shot prompt against a fresh in-process AgentSession.
 *
 * Each call creates a brand-new session with empty conversation history, then
 * disposes it. Sub-agent state never touches the parent session's context.
 */
export async function runAgentSession(
  cwd: string,
  prompt: string,
  options: RunAgentOptions = {},
): Promise<AgentRunResult> {
  const { display, interactive, signal: callerSignal } = options;
  const onLogUpdate = display?.kind === 'log' ? display.onUpdate : undefined;
  const onEvent = display?.kind === 'events' ? display.onEvent : undefined;
  const attachInput = interactive?.attachInput;
  // Always work against an AbortSignal so `signal.aborted` is the single
  // source of truth for "was this run cancelled". If the caller didn't pass
  // one, allocate an internal controller whose signal will never fire —
  // the symmetry lets the rest of this function treat the signal as
  // unconditionally present.
  const signal: AbortSignal = callerSignal ?? new AbortController().signal;

  // All local state declared up front so any callback wired below (debug
  // loggers, abort handlers, process listeners) can reference these without
  // tripping a temporal-dead-zone ReferenceError if it fires synchronously.
  const transcript: string[] = [];
  const entries: Entry[] = [];
  // Args aren't carried on tool_execution_end, so remember them from _start.
  const toolArgs = new Map<string, string>();
  // Streaming text/thinking gets coalesced into a single multi-line entry.
  let streamingKind: 'text' | 'thinking' | null = null;
  let streamingBuffer = '';
  let streamingEntry: Entry | null = null;

  // Restrict the sub-agent to the standard built-in tools. Without this, pi
  // auto-discovers user-installed extensions (e.g. @mjakl/pi-subagent) and
  // exposes their tools to the sub-agent, which then wastes tokens trying to
  // delegate to named sub-sub-agents that aren't configured in this context.
  const { session } = await createAgentSession({
    cwd,
    tools: ['read', 'bash', 'edit', 'write'],
  });

  // Read `signal.aborted` through this helper everywhere below the
  // entry-guard. The lint rule's flow analysis sees the early-return
  // guard and narrows `signal.aborted` to literal `false` for the rest of
  // the function, which would make the post-prompt and post-throw checks
  // look like dead code. Going through a function defeats the narrowing.
  const isAborted = () => signal.aborted;

  // If the caller's signal was already aborted before we got here, bail out
  // immediately. Subscribing the abort listener and then falling into
  // session.prompt(prompt) on a session whose abort() has already fired is
  // undefined behavior in pi.
  if (signal.aborted) {
    session.dispose();
    return { kind: 'aborted', output: '' };
  }

  // Crash diagnostics: while this sub-agent is running, log any unhandled
  // rejection or uncaught exception to /tmp/specd-debug.log, regardless of
  // whether some other listener decides to exit the process. Pi may have its
  // own handler that calls process.exit() — we can't override that, but
  // appendFileSync runs synchronously so the trail is on disk before exit.
  const debugLog = `${tmpdir()}/specd-debug.log`;
  const writeDebug = (kind: string, err: unknown) => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    const stamp = new Date().toISOString();
    try {
      appendFileSync(debugLog, `\n[${stamp}] ${kind}\n${msg}\n`);
    } catch {
      // best-effort
    }
    transcript.push(`[${kind}] ${msg}\n`);
  };
  const onUnhandled = (err: unknown) => {
    writeDebug('unhandledRejection', err);
  };
  // For uncaught exceptions, we capture diagnostics and then re-throw on the
  // next tick so Node's default crash-and-exit semantics are preserved. If we
  // only logged and swallowed, the process would keep running in an undefined
  // state — worse than a crash.
  const onUncaught = (err: unknown) => {
    writeDebug('uncaughtException', err);
    process.nextTick(() => {
      throw err;
    });
  };
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);

  // `signal.aborted` is the canonical truth; we no longer mirror it into a
  // local boolean. The abort handler just forwards to the session.
  const onAbort = () => {
    void session.abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const reportSteerError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    transcript.push(`[steer-failed] ${msg}\n`);
    pushNote(`[steer failed] ${msg}`);
  };

  // Always route user input through session.steer(). Pi's _queueSteer queues
  // steers even before streaming starts and the agent picks them up on the
  // next turn, so steer is safe pre-stream. Calling session.prompt(text) while
  // the agent is processing throws "Agent is already processing" — there's a
  // race window between the initial prompt() returning to the event loop and
  // isStreaming flipping true that previously dropped the user's keystroke.
  const handleUserInput = (text: string) => {
    if (isAborted()) return;
    try {
      void session.steer(text).catch(reportSteerError);
    } catch (err) {
      reportSteerError(err);
    }
  };
  const detachInput = attachInput?.(handleUserInput);

  const emit = () => {
    if (!onLogUpdate) return;
    const flat: string[] = [];
    for (const e of entries) {
      for (const line of e.lines) flat.push(truncate(line, MAX_LINE_LEN));
    }
    onLogUpdate(flat);
  };

  const trimEntries = () => {
    while (entries.length > MAX_ENTRIES) {
      const dropped = entries.shift();
      if (dropped === streamingEntry) {
        streamingKind = null;
        streamingBuffer = '';
        streamingEntry = null;
      }
    }
  };

  const endStream = () => {
    streamingKind = null;
    streamingBuffer = '';
    streamingEntry = null;
  };

  const pushNote = (line: string) => {
    endStream();
    entries.push({ lines: [line] });
    trimEntries();
    emit();
  };

  const startTool = (id: string, line: string) => {
    endStream();
    entries.push({ id, lines: [line] });
    trimEntries();
    emit();
  };

  const finishTool = (id: string, line: string) => {
    const found = entries.find((e) => e.id === id);
    if (found) {
      found.lines = [line];
    } else {
      entries.push({ id, lines: [line] });
      trimEntries();
    }
    emit();
  };

  const updateStreaming = (kind: 'text' | 'thinking', delta: string) => {
    const label = kind === 'thinking' ? '[thinking]' : '[assistant]';
    if (streamingKind !== kind || !streamingEntry) {
      streamingKind = kind;
      streamingBuffer = delta;
      streamingEntry = { lines: [label] };
      entries.push(streamingEntry);
      trimEntries();
    } else {
      streamingBuffer += delta;
    }
    const lines = streamingBuffer
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    const indent = ' '.repeat(label.length + 1);
    streamingEntry.lines = lines.map((line, i) =>
      i === 0 ? `${label} ${line}` : `${indent}${line}`,
    );
    emit();
  };

  const unsubscribe = session.subscribe((event) => {
    onEvent?.(event);
    handleEvent(event, {
      transcript,
      pushNote,
      startTool,
      finishTool,
      updateStreaming,
      toolArgs,
    });
  });

  try {
    pushNote('starting…');
    await session.prompt(prompt);
    // Route through `isAborted()` rather than reading `signal.aborted`
    // directly so the lint rule can't narrow the early-return guard's
    // implication forward to here.
    return isAborted()
      ? { kind: 'aborted', output: `${transcript.join('')}\n[aborted]` }
      : { kind: 'success', output: transcript.join('') };
  } catch (err) {
    const output = `${transcript.join('')}\n[exception] ${err instanceof Error ? err.message : String(err)}`;
    // If the abort signal fired during/around the throw, classify as aborted
    // — the user-initiated cancel takes precedence over the resulting
    // exception (which is typically just the cancellation surfacing).
    return isAborted() ? { kind: 'aborted', output } : { kind: 'error', output, error: err };
  } finally {
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUncaught);
    signal.removeEventListener('abort', onAbort);
    detachInput?.();
    unsubscribe();
    session.dispose();
  }
}

interface EventCtx {
  transcript: string[];
  pushNote: (line: string) => void;
  startTool: (id: string, line: string) => void;
  finishTool: (id: string, line: string) => void;
  updateStreaming: (kind: 'text' | 'thinking', delta: string) => void;
  toolArgs: Map<string, string>;
}

function handleEvent(event: AgentSessionEvent, c: EventCtx) {
  switch (event.type) {
    case 'tool_execution_start': {
      const summary = summarizeToolArgs(event.toolName, event.args);
      c.toolArgs.set(event.toolCallId, summary);
      const line = `[run] ${event.toolName}${summary ? `: ${summary}` : ''}`;
      c.transcript.push(`${line}\n`);
      c.startTool(event.toolCallId, line);
      break;
    }
    case 'tool_execution_end': {
      const summary = c.toolArgs.get(event.toolCallId) ?? '';
      const resultSnippet = stringifyToolResult(event.result);
      const status = event.isError ? '[err]' : '[ok]';
      const line = `${status} ${event.toolName}${summary ? `: ${summary}` : ''}${
        resultSnippet ? ` -> ${resultSnippet}` : ''
      }`;
      c.transcript.push(`${line}\n`);
      c.finishTool(event.toolCallId, line);
      c.toolArgs.delete(event.toolCallId);
      // Note: a tool returning isError is NOT a session failure. Bash
      // commands exit non-zero all the time (e.g. `ls missing || echo …`),
      // and the agent recovers naturally. Only crashes / unhandled
      // rejections / aborts mark the run as failed.
      break;
    }
    case 'message_update': {
      const sub = event.assistantMessageEvent;
      switch (sub.type) {
        case 'thinking_delta':
          c.updateStreaming('thinking', getDelta(sub));
          break;
        case 'text_delta':
          c.updateStreaming('text', getDelta(sub));
          break;
      }
      break;
    }
    case 'message_end': {
      const text = extractMessageText(event.message);
      if (text) c.transcript.push(`\n${text}\n`);
      break;
    }
    case 'agent_end':
      c.pushNote('done');
      break;
    case 'compaction_start':
      c.pushNote('[compacting context...]');
      break;
    case 'compaction_end':
      c.pushNote('[compaction complete]');
      break;
    case 'auto_retry_start': {
      const detail = event.errorMessage ? `: ${firstLine(event.errorMessage)}` : '';
      c.pushNote(`[retrying after API error${detail}]`);
      break;
    }
    case 'auto_retry_end':
      // No note — the next message_update / turn_end will speak for itself.
      break;
    default:
      // Other AgentSessionEvent variants (turn_start, turn_end, agent_start,
      // message_start, tool_execution_update, queue_update,
      // session_info_changed, …) are intentionally ignored — they don't map
      // to a useful side-pane line. The union is open from pi's side, so we
      // don't use an exhaustiveness check here.
      break;
  }
}

function getDelta(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const e = event as Record<string, unknown>;
  if (typeof e.delta === 'string') return e.delta;
  if (typeof e.text === 'string') return e.text;
  if (typeof e.thinking === 'string') return e.thinking;
  return '';
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as { role?: string; content?: unknown };
  if (m.role !== 'assistant' || !Array.isArray(m.content)) return '';
  const parts: string[] = [];
  for (const block of m.content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('');
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return truncate(firstLine(result), 80);
  if (result && typeof result === 'object') {
    const r = result as { content?: unknown };
    if (Array.isArray(r.content)) {
      for (const block of r.content) {
        if (block && typeof block === 'object') {
          const b = block as { type?: string; text?: unknown };
          if (b.type === 'text' && typeof b.text === 'string') {
            return truncate(firstLine(b.text), 80);
          }
        }
      }
    }
  }
  return '';
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  switch (toolName.toLowerCase()) {
    case 'bash': {
      const cmd = typeof a.command === 'string' ? a.command : '';
      return truncate(cmd.replace(/\s+/g, ' ').trim(), 80);
    }
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit': {
      const path =
        typeof a.file_path === 'string' ? a.file_path : typeof a.path === 'string' ? a.path : '';
      return truncate(path, 80);
    }
    case 'glob':
    case 'grep':
      return truncate(typeof a.pattern === 'string' ? a.pattern : '', 80);
    default:
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === 'string') return `${k}=${truncate(v, 60)}`;
      }
      return '';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
