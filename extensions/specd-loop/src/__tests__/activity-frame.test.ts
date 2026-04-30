import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { eventToFrames, type FrameContext } from '../activity-frame.js';

function freshCtx(): FrameContext {
  return { previousArgsSummary: new Map() };
}

// pi's AgentSessionEvent union is open and several variants carry pi-internal
// types that aren't worth reconstructing in tests; cast to satisfy tsc while
// keeping the test bodies focused on the bits eventToFrames actually reads.
function asEvent(e: object): AgentSessionEvent {
  return e as AgentSessionEvent;
}

describe('eventToFrames', () => {
  it('produces a tool-start frame with a summary for bash args', () => {
    const ctx = freshCtx();
    const frames = eventToFrames(
      asEvent({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'ls -la' },
      }),
      ctx,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      kind: 'tool-start',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'ls -la' },
      argsSummary: 'ls -la',
    });
    expect(ctx.previousArgsSummary.get('tool-1')).toBe('ls -la');
  });

  it('produces a tool-end frame even if no prior tool-start was seen', () => {
    const ctx = freshCtx();
    const frames = eventToFrames(
      asEvent({
        type: 'tool_execution_end',
        toolCallId: 'tool-orphan',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'output' }] },
        isError: false,
      }),
      ctx,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'tool-end',
      toolCallId: 'tool-orphan',
      toolName: 'bash',
      isError: false,
      resultSnippet: 'output',
    });
  });

  it('produces a message-update with textDelta populated from a text_delta sub-event', () => {
    const ctx = freshCtx();
    const message = {
      role: 'assistant',
      content: [],
      timestamp: 123,
    };
    const frames = eventToFrames(
      asEvent({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_delta', delta: 'hello', contentIndex: 0 },
      }),
      ctx,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'message-update',
      messageId: '123',
      textDelta: 'hello',
      thinkingDelta: undefined,
    });
  });

  it('translates compaction_start into an info note', () => {
    const ctx = freshCtx();
    const frames = eventToFrames(asEvent({ type: 'compaction_start', reason: 'threshold' }), ctx);
    expect(frames).toEqual([{ kind: 'note', level: 'info', text: '[compacting context...]' }]);
  });

  it('preserves isError on tool-end frames produced from tool_execution_end', () => {
    const ctx = freshCtx();
    const frames = eventToFrames(
      asEvent({
        type: 'tool_execution_end',
        toolCallId: 'tool-2',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'boom' }], isError: true },
        isError: true,
      }),
      ctx,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'tool-end',
      toolCallId: 'tool-2',
      toolName: 'bash',
      isError: true,
    });
  });
});
