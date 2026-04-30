import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createAgentSession, type AgentSessionEvent } from '@mariozechner/pi-coding-agent';

export interface AgentRunResult {
  success: boolean;
  output: string;
  aborted?: boolean;
}

export interface RunAgentOptions {
  /**
   * Called whenever the activity log changes — pass these lines to a widget so
   * the user can see what the sub-agent is actually doing. Lines are ordered
   * oldest → newest. Total flattened lines stay roughly bounded but each entry
   * (e.g. a streaming assistant message) can occupy multiple lines.
   */
  onLogUpdate?: (lines: string[]) => void;
  /**
   * Called for every raw AgentSessionEvent. Used to forward the live event
   * stream to a side viewer (e.g. a tmux pane running viewer.mjs).
   */
  onEvent?: (event: AgentSessionEvent) => void;
  /**
   * AbortSignal that, when triggered, calls session.abort() to stop the
   * running sub-agent. The returned result has `aborted: true`.
   */
  signal?: AbortSignal;
  /**
   * Setup callback fired once the AgentSession is created. Caller receives
   * a `steer(text)` function that injects user input into the live session
   * (interrupting the current turn). The returned function is called when
   * the session ends — caller uses it to detach any input subscription.
   */
  attachInput?: (steer: (text: string) => void) => () => void;
  /**
   * If provided, the runner stays alive after the initial prompt resolves and
   * keeps accepting follow-up prompts via `attachInput` until this promise
   * resolves. Lets the user have a continuing conversation with the sub-agent
   * (e.g. answer a clarifying question the agent asked at the end of the run).
   */
  stayAliveUntil?: Promise<void>;
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
  const { onLogUpdate, onEvent, signal, attachInput, stayAliveUntil } = options;
  // Restrict the sub-agent to the standard built-in tools. Without this, pi
  // auto-discovers user-installed extensions (e.g. @mjakl/pi-subagent) and
  // exposes their tools to the sub-agent, which then wastes tokens trying to
  // delegate to named sub-sub-agents that aren't configured in this context.
  const { session } = await createAgentSession({
    cwd,
    tools: ['read', 'bash', 'edit', 'write'],
  });

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
  const onUncaught = (err: unknown) => {
    writeDebug('uncaughtException', err);
  };
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);

  // The abort handler can flip this flag during any async boundary. We expose
  // it via a getter so the lint rule's flow analysis doesn't narrow it to its
  // initial value.
  let aborted = false;
  const wasAborted = () => aborted;
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    void session.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const reportSteerError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    transcript.push(`[steer-failed] ${msg}\n`);
    pushNote(`[steer failed] ${msg}`);
  };

  // Drive user input either as a steer (mid-turn) or a prompt (between turns).
  // Steer requires the agent to be currently streaming; prompt is the right
  // primitive when the previous turn has already settled.
  const handleUserInput = (text: string) => {
    if (aborted) return;
    try {
      const driver = session.isStreaming ? session.steer(text) : session.prompt(text);
      driver.catch(reportSteerError);
    } catch (err) {
      reportSteerError(err);
    }
  };
  const detachInput = attachInput?.(handleUserInput);

  const transcript: string[] = [];
  const entries: Entry[] = [];
  // Args aren't carried on tool_execution_end, so remember them from _start.
  const toolArgs = new Map<string, string>();
  // Streaming text/thinking gets coalesced into a single multi-line entry.
  let streamingKind: 'text' | 'thinking' | null = null;
  let streamingBuffer = '';
  let streamingEntry: Entry | null = null;

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
    if (stayAliveUntil && !wasAborted()) {
      // Keep the session alive so the user can continue the conversation in
      // the viewer. Each user input was already routed through handleUserInput
      // by attachInput; we just need to wait until told to stop.
      pushNote('[chat open — close the viewer pane to finish]');
      await Promise.race([
        stayAliveUntil,
        new Promise<void>((resolve) => {
          if (signal) {
            if (signal.aborted) resolve();
            else
              signal.addEventListener(
                'abort',
                () => {
                  resolve();
                },
                { once: true },
              );
          }
        }),
      ]);
    }
    const finalAborted = wasAborted();
    return {
      success: !finalAborted,
      aborted: finalAborted,
      output: transcript.join('') + (finalAborted ? `\n[aborted]` : ''),
    };
  } catch (err) {
    return {
      success: false,
      aborted,
      output: `${transcript.join('')}\n[exception] ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUncaught);
    if (signal) signal.removeEventListener('abort', onAbort);
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
