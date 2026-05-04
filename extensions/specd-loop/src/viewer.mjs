#!/usr/bin/env node
// Standalone viewer that renders sub-agent activity using pi's own TUI components.
//
// Usage: node viewer.mjs <events-fifo> <input-fifo>
//
// - events-fifo: parent → viewer. Newline-delimited JSON ActivityFrame stream.
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
// glance which input box steers the sub-agent. Updated via control frames
// (subtype 'specd:title') on the events FIFO.
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

// Once the parent sends a 'specd:done' control frame, render a completion
// banner inside the chat container and stop any pending FIFO-EOF auto-exit
// timer so the user has unbounded time to read the final state. The user
// dismisses the pane manually (close-pane keystroke / tmux kill-pane).
//
// `exitTimer` is the FIFO-EOF crash-safety fallback (see `stream.on('end')`
// at the bottom of the file); declared up here so showDoneBanner can clear it.
let doneBannerShown = false;
let exitTimer = null;
function showDoneBanner(summary) {
  if (doneBannerShown) return;
  doneBannerShown = true;
  const headline = summary && summary.length > 0 ? summary : 'complete';
  appendToChat(new Text(`\n══ ${headline} ══\nClose the pane to dismiss.`));
  if (exitTimer !== null) {
    clearTimeout(exitTimer);
    exitTimer = null;
  }
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
  // Parent closed the reverse FIFO (session ended) or other write error.
  // Mark parent gone so we stop accepting input, and destroy the writer to
  // drain its internal queue and release the fd; not destroying can leak
  // queued writes as unhandled rejections.
  parentGone = true;
  inputWriter.destroy();
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
// Cap stored children so a long-running session doesn't grow the chatContainer
// unboundedly (Container has no built-in eviction). The leading Spacer (added
// once at startup) is preserved so the title-overlay padding never disappears.
const MAX_CHAT_CHILDREN = 200;
function appendToChat(component) {
  chatContainer.addChild(component);
  // children[0] is the leading Spacer; evict the next-oldest entry first.
  while (chatContainer.children.length > MAX_CHAT_CHILDREN + 1) {
    const drop = chatContainer.children[1];
    if (!drop) break;
    chatContainer.removeChild(drop);
  }
}

function handleFrame(frame) {
  switch (frame.kind) {
    case 'message-start':
      if (frame.message?.role === 'assistant') {
        streamingAssistant = new AssistantMessageComponent(
          undefined,
          false,
          markdownTheme,
          undefined,
        );
        streamingAssistant.updateContent(frame.message);
        appendToChat(streamingAssistant);
      }
      break;

    case 'message-update':
      if (streamingAssistant && frame.message?.role === 'assistant') {
        streamingAssistant.updateContent(frame.message);
        for (const block of frame.message.content ?? []) {
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

    case 'message-end':
      if (frame.message?.role === 'assistant') {
        streamingAssistant?.updateContent(frame.message);
        streamingAssistant = null;
        // Match pi's interactive mode: once the assistant message ends, every
        // pending tool's args are final. setArgsComplete() triggers diff
        // computation for edit-style tools so their args render as a diff
        // instead of raw partial text. Don't clear the map — tool-end still
        // owns that.
        for (const component of pendingTools.values()) {
          component.setArgsComplete();
        }
      }
      break;

    case 'tool-start': {
      let component = pendingTools.get(frame.toolCallId);
      if (!component) {
        component = new ToolExecutionComponent(
          frame.toolName,
          frame.toolCallId,
          frame.args,
          { showImages: false },
          undefined,
          tui,
          process.cwd(),
        );
        appendToChat(component);
        pendingTools.set(frame.toolCallId, component);
      }
      component.markExecutionStarted();
      break;
    }

    case 'tool-update': {
      const component = pendingTools.get(frame.toolCallId);
      if (component && frame.partialResult) {
        component.updateResult(frame.partialResult, true);
      }
      break;
    }

    case 'tool-end': {
      const component = pendingTools.get(frame.toolCallId);
      if (component) {
        component.updateResult(frame.result ?? { content: [], isError: frame.isError }, false);
        pendingTools.delete(frame.toolCallId);
      }
      break;
    }

    case 'note':
      appendToChat(new Text(frame.text));
      break;

    case 'agent-end':
      // No banner needed — final message and the eventual FIFO EOF tell the
      // story. Kept as an explicit case so it doesn't hit the default branch.
      break;

    case 'banner':
      // banner frames are reserved for future use; render the title text as a
      // chat-level banner. Forward-compat: today nothing emits these.
      appendToChat(new Text(frame.title));
      break;

    case 'control':
      if (frame.subtype === 'specd:title' && typeof frame.title === 'string') {
        setTitle(frame.title);
      } else if (frame.subtype === 'specd:done') {
        showDoneBanner(typeof frame.summary === 'string' ? frame.summary : undefined);
      }
      break;

    default:
      // Forward-compat: unknown frame kinds are ignored. A future pi update
      // may add new ActivityFrame variants and we don't want the viewer to
      // crash mid-run on a bump.
      break;
  }
  tui.requestRender();
}

// utf-8 encoding so multi-byte sequences split across chunk boundaries are
// stitched back together by Node's StringDecoder; otherwise JSON.parse silently
// fails on the corrupted line and we drop a real event.
const stream = createReadStream(eventsFifo, { encoding: 'utf-8' });
let buffer = '';
stream.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.kind !== 'string') {
        continue;
      }
      handleFrame(parsed);
    } catch (err) {
      console.error(`[viewer] parse error: ${err.message}`);
    }
  }
});

// Crash-safety fallback. On a clean run the parent sends a 'specd:done'
// frame, which clears this timer and waits for the user to dismiss the pane
// manually. If the parent crashes before sending 'specd:done', the FIFO EOF
// fires here and the viewer self-exits after a long delay so an orphaned
// pane doesn't linger forever. 5 minutes is generous enough that a
// normally-completed run with the user reading the pane never auto-closes
// (specd:done would have already cancelled the timer in that case).
const FIFO_EOF_FALLBACK_MS = 5 * 60 * 1000;
stream.on('end', () => {
  tui.requestRender(true);
  if (doneBannerShown) {
    // User has the done banner visible; don't auto-exit. They'll close the
    // pane themselves when they're ready.
    return;
  }
  exitTimer = setTimeout(() => {
    // Restore the terminal (cursor, alt-screen, raw mode) before exiting so
    // the surrounding shell isn't left in a weird state — important when the
    // pane is killed mid-run.
    tui.stop();
    process.exit(0);
  }, FIFO_EOF_FALLBACK_MS);
});

stream.on('error', (err) => {
  console.error(`[viewer] stream error: ${err.message}`);
  tui.stop();
  process.exit(1);
});
