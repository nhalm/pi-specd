// Spawn the viewer in a tmux pane and feed it canned events.
// Usage (must be in a tmux session): node scripts/smoke-viewer.mjs

import { spawn, spawnSync } from 'node:child_process';
import { openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (!process.env.TMUX) {
  console.error('Run me inside tmux.');
  process.exit(1);
}

const fifo = join(tmpdir(), `specd-smoke-${process.pid}.fifo`);
const mk = spawnSync('mkfifo', ['-m', '600', fifo]);
if (mk.status !== 0) {
  console.error(`mkfifo failed: ${mk.stderr}`);
  process.exit(1);
}

const viewer = resolve('extensions/specd-loop/src/viewer.mjs');
const errLog = join(tmpdir(), `specd-smoke-viewer.err`);
// Force bash so redirection / $? work regardless of the user's login shell
const cmd = `bash -c "node '${viewer}' '${fifo}' 2>'${errLog}'; echo viewer-exited-with-status=\\$?"`;

// Split a side pane that runs the viewer. -P prints the new pane id, -F formats it.
const split = spawn('tmux', ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', cmd], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let paneId = '';
split.stdout.on('data', (d) => (paneId += d.toString()));
await new Promise((res) => split.on('close', res));
paneId = paneId.trim();
console.log(`[smoke] viewer pane: ${paneId}`);

// Open the FIFO for writing. This unblocks the viewer's read stream.
const fd = openSync(fifo, 'w');
const send = (event) => writeSync(fd, `${JSON.stringify(event)}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk through a fake agent run.
await sleep(500);
send({
  type: 'message_start',
  message: { role: 'assistant', content: [], timestamp: Date.now() },
});

await sleep(500);
send({
  type: 'message_update',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'I need to list files and then summarize them. Let me start with bash.',
      },
    ],
    timestamp: Date.now(),
  },
  assistantMessageEvent: { type: 'thinking_end' },
});

await sleep(500);
send({
  type: 'tool_execution_start',
  toolCallId: 'call_1',
  toolName: 'bash',
  args: { command: 'ls -la /tmp | head -5' },
});

await sleep(800);
send({
  type: 'tool_execution_end',
  toolCallId: 'call_1',
  toolName: 'bash',
  result: {
    content: [
      {
        type: 'text',
        text: 'total 16\ndrwxrwxrwt   24 root  wheel    768 Apr 29 15:00 .\ndrwxr-xr-x   20 root  wheel    640 Apr 28 09:00 ..\ndrwx------    3 user  wheel     96 Apr 29 14:30 com.apple.launchd.x',
      },
    ],
    isError: false,
  },
  isError: false,
});

await sleep(500);
send({
  type: 'message_update',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '## Summary\n\nThe `/tmp` directory contains 24 entries. The first three:\n\n1. `.` — current\n2. `..` — parent\n3. `com.apple.launchd.x` — macOS launchd staging\n\nAll done.',
      },
    ],
    timestamp: Date.now(),
  },
  assistantMessageEvent: { type: 'text_end' },
});

await sleep(500);
send({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '## Summary\n\nThe `/tmp` directory contains 24 entries. The first three:\n\n1. `.` — current\n2. `..` — parent\n3. `com.apple.launchd.x` — macOS launchd staging\n\nAll done.',
      },
    ],
    stopReason: 'stop',
    timestamp: Date.now(),
  },
});

await sleep(200);
send({ type: 'agent_end', messages: [] });

console.log(
  '[smoke] events sent. Closing FIFO in 5s; viewer pane will linger 30s, then auto-exit.',
);
await sleep(5000);
closeSync(fd);
unlinkSync(fifo);
console.log(`[smoke] done. To kill the pane: tmux kill-pane -t ${paneId}`);
