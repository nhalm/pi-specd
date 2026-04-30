#!/usr/bin/env node
// Standalone viewer that renders sub-agent activity using pi's own TUI components.
//
// Usage: node viewer.mjs <events-fifo> <input-fifo>
//
// - events-fifo: parent → viewer. Newline-delimited JSON AgentSessionEvent stream.
// - input-fifo:  viewer → parent. Newline-delimited JSON-encoded user message strings.
//                Each line is a JSON-encoded string (e.g. `"hi"\n`); parent calls
//                session.steer() with the decoded text.

import { createReadStream, createWriteStream } from 'node:fs';

import { ProcessTerminal, TUI, Container, Input, Spacer, Text } from '@mariozechner/pi-tui';
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from '@mariozechner/pi-coding-agent';

initTheme();

const eventsFifo = process.argv[2];
const inputFifo = process.argv[3];
if (!eventsFifo || !inputFifo) {
  console.error('usage: viewer.mjs <events-fifo> <input-fifo>');
  process.exit(1);
}

const term = new ProcessTerminal();
const tui = new TUI(term);

const chatContainer = new Container();
tui.addChild(chatContainer);

// One-row pad so the top-anchored title overlay (which composites OVER content)
// doesn't cover the first line of the first chat entry. The Spacer is always
// the leading child of chatContainer; appendToChat preserves that invariant.
chatContainer.addChild(new Spacer(1));

// Banner pinned to the top via a non-capturing overlay so it stays visible
// while events scroll below it. Identifies which pane this is and what phase
// is running, so a user with both parent and child panes open can tell at a
// glance which input box steers the sub-agent. Updated via 'specd:title'
// control events on the events FIFO.
const titleText = new Text('specd');
tui.showOverlay(titleText, {
  anchor: 'top-left',
  width: '100%',
  offsetX: 0,
  offsetY: 0,
  nonCapturing: true,
});
function setTitle(text) {
  titleText.setText(`specd · ${text} — type below to steer the sub-agent`);
  tui.requestRender();
}

// Input box pinned to the bottom of the pane via an overlay (so it stays
// visible no matter how much the chat above scrolls).
const inputBox = new Input();
const inputOverlay = tui.showOverlay(inputBox, {
  anchor: 'bottom-left',
  width: '100%',
  offsetX: 0,
  offsetY: 0,
});
inputOverlay.focus();

// Open the reverse FIFO for writing user input back to the parent.
const inputWriter = createWriteStream(inputFifo);
let parentGone = false;
inputWriter.on('error', () => {
  // Parent closed the reverse FIFO (session ended). Stop accepting input.
  parentGone = true;
});
inputBox.onSubmit = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  inputBox.setValue('');
  if (parentGone) {
    tui.requestRender();
    return;
  }
  try {
    inputWriter.write(JSON.stringify(trimmed) + '\n');
  } catch {
    parentGone = true;
  }
  tui.requestRender();
};

// Let pi-tui drive terminal start: it sets up raw mode, queries cell size,
// installs the input handler, and dispatches keys through its overlay/focus
// stack (which includes Kitty key-release filtering, cell-size response
// consumption, and debug-key dispatch). Forwarding raw bytes straight to
// inputBox.handleInput would short-circuit all of that.
tui.start();

const markdownTheme = getMarkdownTheme();
const pendingTools = new Map();
let streamingAssistant = null;

// Input is now an overlay (not part of chatContainer), so we can just append.
function appendToChat(component) {
  chatContainer.addChild(component);
}

function handleEvent(event) {
  switch (event.type) {
    case 'message_start':
      if (event.message?.role === 'assistant') {
        streamingAssistant = new AssistantMessageComponent(
          undefined,
          false,
          markdownTheme,
          undefined,
        );
        streamingAssistant.updateContent(event.message);
        appendToChat(streamingAssistant);
      }
      break;

    case 'message_update':
      if (streamingAssistant && event.message?.role === 'assistant') {
        streamingAssistant.updateContent(event.message);
        for (const block of event.message.content ?? []) {
          if (!block || block.type !== 'toolCall') continue;
          if (typeof block.id !== 'string') continue;
          if (!pendingTools.has(block.id)) {
            const tool = new ToolExecutionComponent(
              block.name,
              block.id,
              block.arguments,
              { showImages: false },
              undefined,
              tui,
              process.cwd(),
            );
            appendToChat(tool);
            pendingTools.set(block.id, tool);
          } else {
            pendingTools.get(block.id)?.updateArgs(block.arguments);
          }
        }
      }
      break;

    case 'message_end':
      if (event.message?.role === 'assistant') {
        streamingAssistant?.updateContent(event.message);
        streamingAssistant = null;
        // Match pi's interactive mode: once the assistant message ends, every
        // pending tool's args are final. setArgsComplete() triggers diff
        // computation for edit-style tools so their args render as a diff
        // instead of raw partial text. Don't clear the map — tool_execution_end
        // still owns that.
        for (const component of pendingTools.values()) {
          component.setArgsComplete();
        }
      }
      break;

    case 'tool_execution_start': {
      let component = pendingTools.get(event.toolCallId);
      if (!component) {
        component = new ToolExecutionComponent(
          event.toolName,
          event.toolCallId,
          event.args,
          { showImages: false },
          undefined,
          tui,
          process.cwd(),
        );
        appendToChat(component);
        pendingTools.set(event.toolCallId, component);
      }
      component.markExecutionStarted();
      break;
    }

    case 'tool_execution_update': {
      const component = pendingTools.get(event.toolCallId);
      if (component && event.partialResult) {
        component.updateResult(event.partialResult, true);
      }
      break;
    }

    case 'tool_execution_end': {
      const component = pendingTools.get(event.toolCallId);
      if (component) {
        component.updateResult(event.result ?? { content: [], isError: event.isError }, false);
        pendingTools.delete(event.toolCallId);
      }
      break;
    }

    case 'agent_end':
      break;
  }
  tui.requestRender();
}

const stream = createReadStream(eventsFifo);
let buffer = '';
stream.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        continue;
      }
      if (parsed.type === 'specd:title' && typeof parsed.title === 'string') {
        setTitle(parsed.title);
        continue;
      }
      handleEvent(parsed);
    } catch (err) {
      console.error(`[viewer] parse error: ${err.message}`);
    }
  }
});

stream.on('end', () => {
  tui.requestRender(true);
  setTimeout(() => {
    // Restore the terminal (cursor, alt-screen, raw mode) before exiting so
    // the surrounding shell isn't left in a weird state — important when the
    // pane is killed mid-run.
    tui.stop();
    process.exit(0);
  }, 30_000);
});

stream.on('error', (err) => {
  console.error(`[viewer] stream error: ${err.message}`);
  tui.stop();
  process.exit(1);
});
