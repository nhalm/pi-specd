import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { AuthStorage, ModelRegistry, createAgentSession } from '@mariozechner/pi-coding-agent';

import {
  eventToFrames,
  truncate,
  type ActivityFrame,
  type FrameContext,
} from './activity-frame.js';

/**
 * Pi's `Model<Api>` type, recovered structurally from `ModelRegistry`'s public
 * surface. Pi-coding-agent doesn't re-export `Model`/`Api` and
 * `@mariozechner/pi-ai` is only a transitive dependency (mirrors the
 * convention in activity-frame.ts), so we extract the type from
 * `getAvailable()`'s return rather than importing pi-ai directly.
 */
type PiModel = ReturnType<ModelRegistry['getAvailable']>[number];

/**
 * Resolve a model reference (bare id, e.g. "claude-sonnet-4-6", or canonical
 * "provider/modelId") to a `Model<Api>` object. Mirrors the matching rules
 * in pi's interactive-mode model resolver: prefer canonical match, then
 * provider/modelId match, then bare id (rejecting cross-provider ambiguity).
 *
 * Returns undefined if the reference doesn't unambiguously match a model
 * available with configured auth — the caller falls back to letting pi pick
 * its default model.
 */
function resolveSpecdModel(reference: string): PiModel | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  const registry = ModelRegistry.create(AuthStorage.create());
  const available = registry.getAvailable();
  const lower = trimmed.toLowerCase();
  const canonical = available.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash !== -1) {
    const prov = trimmed.slice(0, slash).trim().toLowerCase();
    const id = trimmed
      .slice(slash + 1)
      .trim()
      .toLowerCase();
    if (prov && id) {
      const matches = available.filter(
        (m) => m.provider.toLowerCase() === prov && m.id.toLowerCase() === id,
      );
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return undefined;
    }
  }
  const idMatches = available.filter((m) => m.id.toLowerCase() === lower);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

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
 * tagged union so the two render paths (rolling-log widget vs live frame
 * stream to a side viewer) are mutually exclusive — previously a caller
 * could pass both `onLogUpdate` and `onEvent` and the runner would dutifully
 * fire both, which had no use case and just hid bugs.
 *
 * - `'log'`: the runner builds a bounded rolling activity log internally
 *   and calls `onUpdate(lines)` whenever it changes. Lines are ordered
 *   oldest → newest. Suited to a compact widget above the editor.
 * - `'frames'`: the runner forwards every `ActivityFrame` to `onFrame` so
 *   a richer external UI (e.g. the tmux side pane) can render it however
 *   it wants. The internal transcript is still maintained but no log
 *   callback fires.
 */
export type DisplayMode =
  | { kind: 'log'; onUpdate: (lines: string[]) => void }
  | { kind: 'frames'; onFrame: (frame: ActivityFrame) => void };

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
  const onFrame = display?.kind === 'frames' ? display.onFrame : undefined;
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
  // Streaming text/thinking gets coalesced into a single multi-line entry.
  let streamingKind: 'text' | 'thinking' | null = null;
  let streamingBuffer = '';
  let streamingEntry: Entry | null = null;
  // Per-run frame context for eventToFrames. Stays alive across the full
  // session so tool_execution_start summaries can be remembered for the
  // matching tool_execution_end (pi events don't carry args on _end).
  const frameCtx: FrameContext = { previousArgsSummary: new Map() };

  // SPECD_MODEL pins the model for sub-agents independent of pi's settings.
  // Useful for deterministic loops (e.g. SPECD_MODEL=claude-sonnet-4-6 /specd:loop).
  // If unset, sub-agents inherit pi's currently-configured model.
  const modelRef = process.env.SPECD_MODEL?.trim();
  const model = modelRef ? resolveSpecdModel(modelRef) : undefined;

  // Restrict the sub-agent to the standard built-in tools. Without this, pi
  // auto-discovers user-installed extensions (e.g. @mjakl/pi-subagent) and
  // exposes their tools to the sub-agent, which then wastes tokens trying to
  // delegate to named sub-sub-agents that aren't configured in this context.
  const { session } = await createAgentSession({
    cwd,
    tools: ['read', 'bash', 'edit', 'write'],
    ...(model ? { model } : {}),
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

  // Crash diagnostics: while this sub-agent is running, capture any unhandled
  // rejection or uncaught exception in the in-memory transcript so the parent
  // can surface it. The persistent file trail at $TMPDIR/specd-debug.log is
  // gated behind the `SPECD_DEBUG` env var — set `SPECD_DEBUG=1 pi` to enable
  // it when triaging an issue. Without the gate every run would write to
  // /tmp on shared workstations, which the architecture review flagged as
  // unwanted side-effects. The listeners themselves stay registered
  // unconditionally because the `uncaughtException` handler also re-throws
  // on next tick to preserve Node's default crash-and-exit semantics — that
  // safety behavior must not depend on debug being on.
  const debugEnabled = !!process.env.SPECD_DEBUG;
  const debugLog = debugEnabled ? `${tmpdir()}/specd-debug.log` : null;
  const writeDebug = (kind: string, err: unknown) => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    if (debugLog) {
      const stamp = new Date().toISOString();
      try {
        appendFileSync(debugLog, `\n[${stamp}] ${kind}\n${msg}\n`);
      } catch {
        // best-effort
      }
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

  /**
   * Drive the widget log from a single ActivityFrame. The viewer pane
   * consumes frames separately via `onFrame` — both paths see the same
   * stream, just rendered differently. Frame kinds the widget doesn't use
   * (banner/control) and any future variants fall through harmlessly.
   */
  const consumeFrameForWidget = (frame: ActivityFrame): void => {
    switch (frame.kind) {
      case 'tool-start': {
        const line = `[run] ${frame.toolName}${frame.argsSummary ? `: ${frame.argsSummary}` : ''}`;
        transcript.push(`${line}\n`);
        startTool(frame.toolCallId, line);
        return;
      }
      case 'tool-end': {
        // Note: a tool returning isError is NOT a session failure. Bash
        // commands exit non-zero all the time (e.g. `ls missing || echo …`),
        // and the agent recovers naturally. Only crashes / unhandled
        // rejections / aborts mark the run as failed.
        const status = frame.isError ? '[err]' : '[ok]';
        const line = `${status} ${frame.toolName}${frame.resultSnippet ? ` -> ${frame.resultSnippet}` : ''}`;
        transcript.push(`${line}\n`);
        finishTool(frame.toolCallId, line);
        return;
      }
      case 'message-update': {
        if (frame.thinkingDelta) updateStreaming('thinking', frame.thinkingDelta);
        else if (frame.textDelta) updateStreaming('text', frame.textDelta);
        return;
      }
      case 'message-end': {
        if (frame.finalText) transcript.push(`\n${frame.finalText}\n`);
        return;
      }
      case 'agent-end':
        pushNote('done');
        return;
      case 'note':
        pushNote(frame.text);
        return;
      case 'message-start':
      case 'tool-update':
      case 'banner':
      case 'control':
        // Widget-irrelevant frames; the viewer pane handles these.
        return;
      default:
        // Forward-compat: future ActivityFrame variants render as a no-op
        // here so a pi update that ships new event types doesn't crash the
        // widget. The frame still reaches `onFrame` for the viewer.
        return;
    }
  };

  const unsubscribe = session.subscribe((event) => {
    const frames = eventToFrames(event, frameCtx);
    for (const frame of frames) {
      onFrame?.(frame);
      consumeFrameForWidget(frame);
    }
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
