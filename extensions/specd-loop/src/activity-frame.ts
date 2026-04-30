import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';

/**
 * The pi `AssistantMessage` type. Pi-coding-agent re-exports
 * `AssistantMessageComponent` (the renderer) but not the message type itself,
 * and `@mariozechner/pi-ai` is only available as a transitive dependency, so
 * we recover the shape structurally from the discriminated event union pi
 * does export. This is the exact same type the viewer's
 * `AssistantMessageComponent.updateContent(message)` accepts at runtime.
 */
export type AssistantMessage = Extract<AgentSessionEvent, { type: 'message_start' }>['message'];

/**
 * Normalized activity stream produced by the sub-agent runner. Both the
 * rolling-log widget (in agent-runner.ts) and the tmux side-pane (in
 * viewer.mjs over a FIFO) consume frames from this stream.
 *
 * Frames are designed so the widget can render simple text and the rich
 * viewer can rebuild full pi components without holding a reference to pi's
 * internal `AgentSessionEvent` shape. The schema does carry the full pi
 * `AssistantMessage` and tool `result` in some frames so the viewer can pass
 * them straight to pi components — that coupling already existed (the viewer
 * imports `AssistantMessageComponent`); this just names it.
 */
export type ActivityFrame =
  | {
      kind: 'message-start';
      messageId: string;
      role: 'assistant';
      message: AssistantMessage;
    }
  | {
      kind: 'message-update';
      messageId: string;
      message: AssistantMessage;
      /** Pre-extracted text delta the widget can flatten without re-parsing the message. */
      textDelta?: string;
      /** Pre-extracted thinking delta the widget can flatten without re-parsing the message. */
      thinkingDelta?: string;
    }
  | {
      kind: 'message-end';
      messageId: string;
      message: AssistantMessage;
      finalText: string;
    }
  | {
      kind: 'tool-start';
      toolCallId: string;
      toolName: string;
      args: unknown;
      /** One-line summary for the widget log. */
      argsSummary: string;
    }
  | {
      kind: 'tool-update';
      toolCallId: string;
      partialResult: unknown;
    }
  | {
      kind: 'tool-end';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      /** Full payload so the viewer can pass it to pi components verbatim. */
      result: unknown;
      /** One-line snippet for the widget log. */
      resultSnippet: string;
    }
  | { kind: 'note'; level: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'agent-end' }
  | { kind: 'banner'; title: string }
  | { kind: 'control'; subtype: 'specd:title'; title: string };

/**
 * Mutable context threaded through `eventToFrames` so we can recover state
 * pi's `AgentSessionEvent` doesn't carry — currently just the args summary
 * we computed at `tool_execution_start` time, since `tool_execution_end`
 * events don't include args.
 */
export interface FrameContext {
  previousArgsSummary: Map<string, string>;
}

/** Convert a pi `AgentSessionEvent` into zero-or-more `ActivityFrame`s. */
export function eventToFrames(event: AgentSessionEvent, ctx: FrameContext): ActivityFrame[] {
  switch (event.type) {
    case 'message_start': {
      if (!isAssistantMessage(event.message)) return [];
      const messageId = messageIdOf(event.message);
      return [
        {
          kind: 'message-start',
          messageId,
          role: 'assistant',
          message: event.message,
        },
      ];
    }
    case 'message_update': {
      if (!isAssistantMessage(event.message)) return [];
      const messageId = messageIdOf(event.message);
      const sub = event.assistantMessageEvent;
      let textDelta: string | undefined;
      let thinkingDelta: string | undefined;
      const subType = (sub as { type?: string }).type;
      if (subType === 'text_delta') textDelta = getDelta(sub);
      else if (subType === 'thinking_delta') thinkingDelta = getDelta(sub);
      return [
        {
          kind: 'message-update',
          messageId,
          message: event.message,
          textDelta,
          thinkingDelta,
        },
      ];
    }
    case 'message_end': {
      if (!isAssistantMessage(event.message)) return [];
      const messageId = messageIdOf(event.message);
      return [
        {
          kind: 'message-end',
          messageId,
          message: event.message,
          finalText: extractMessageText(event.message),
        },
      ];
    }
    case 'tool_execution_start': {
      const argsSummary = summarizeToolArgs(event.toolName, event.args);
      ctx.previousArgsSummary.set(event.toolCallId, argsSummary);
      return [
        {
          kind: 'tool-start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          argsSummary,
        },
      ];
    }
    case 'tool_execution_update':
      return [
        {
          kind: 'tool-update',
          toolCallId: event.toolCallId,
          partialResult: event.partialResult,
        },
      ];
    case 'tool_execution_end': {
      const resultSnippet = stringifyToolResult(event.result);
      ctx.previousArgsSummary.delete(event.toolCallId);
      return [
        {
          kind: 'tool-end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          result: event.result,
          resultSnippet,
        },
      ];
    }
    case 'agent_end':
      return [{ kind: 'agent-end' }];
    case 'compaction_start':
      return [{ kind: 'note', level: 'info', text: '[compacting context...]' }];
    case 'compaction_end':
      return [{ kind: 'note', level: 'info', text: '[compaction complete]' }];
    case 'auto_retry_start': {
      const detail = event.errorMessage ? `: ${firstLine(event.errorMessage)}` : '';
      return [{ kind: 'note', level: 'warning', text: `[retrying after API error${detail}]` }];
    }
    case 'auto_retry_end':
      // No frame — the next message_update / turn_end speaks for itself.
      return [];
    default:
      // Other AgentSessionEvent variants (turn_start, turn_end, agent_start,
      // queue_update, session_info_changed, …) don't map to a useful frame.
      // The union is open from pi's side, so no exhaustiveness check.
      return [];
  }
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { role?: string }).role === 'assistant';
}

/**
 * Pi's `AssistantMessage` shape doesn't carry a stable id field on its own,
 * so we synthesize one from `timestamp` (always present) for the frame
 * stream. Two separate assistant messages within the same session always
 * have distinct timestamps (pi awaits stream completion before starting
 * the next).
 */
function messageIdOf(message: AssistantMessage): string {
  const m = message as { timestamp?: unknown; responseId?: unknown };
  if (typeof m.responseId === 'string') return m.responseId;
  if (typeof m.timestamp === 'number') return String(m.timestamp);
  return '';
}

function getDelta(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const e = event as Record<string, unknown>;
  if (typeof e.delta === 'string') return e.delta;
  if (typeof e.text === 'string') return e.text;
  if (typeof e.thinking === 'string') return e.thinking;
  return '';
}

export function extractMessageText(message: unknown): string {
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

export function stringifyToolResult(result: unknown): string {
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

export function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

export function summarizeToolArgs(toolName: string, args: unknown): string {
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

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
