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

import { ProcessTerminal, TUI, Container, Input } from '@mariozechner/pi-tui';
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

term.start(
  (data) => {
    // Forward all input to the focused component (which is the Input box).
    inputBox.handleInput(data);
    tui.requestRender();
  },
  () => tui.requestRender(true),
);

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
          if (block.type === 'toolCall' && !pendingTools.has(block.id)) {
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
          } else if (block.type === 'toolCall') {
            pendingTools.get(block.id)?.updateArgs(block.arguments);
          }
        }
      }
      break;

    case 'message_end':
      if (event.message?.role === 'assistant') {
        streamingAssistant?.updateContent(event.message);
        streamingAssistant = null;
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
      handleEvent(JSON.parse(line));
    } catch (err) {
      console.error(`[viewer] parse error: ${err.message}`);
    }
  }
});

stream.on('end', () => {
  tui.requestRender(true);
  setTimeout(() => process.exit(0), 30_000);
});

stream.on('error', (err) => {
  console.error(`[viewer] stream error: ${err.message}`);
  process.exit(1);
});
