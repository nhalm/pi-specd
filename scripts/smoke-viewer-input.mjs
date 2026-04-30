// Smoke test for the viewer's reverse input channel.
// Spawns the viewer in a tmux pane, sends a few events to set the scene,
// then waits for input the user types in the viewer pane and prints it.
//
// Usage (must be inside tmux): node scripts/smoke-viewer-input.mjs

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (!process.env.TMUX) {
  console.error('Run me inside tmux.');
  process.exit(1);
}

const stamp = `smoke-${process.pid}-${Date.now()}`;
const fifo = join(tmpdir(), `${stamp}.fifo`);
const reverseFifo = join(tmpdir(), `${stamp}.rev.fifo`);
spawnSync('mkfifo', ['-m', '600', fifo]);
spawnSync('mkfifo', ['-m', '600', reverseFifo]);

const viewer = resolve('extensions/specd-loop/src/viewer.mjs');
const cmd = `bash -c "node '${viewer}' '${fifo}' '${reverseFifo}'"`;

const split = spawn('tmux', ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', cmd], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let paneId = '';
split.stdout.on('data', (d) => (paneId += d.toString()));
await new Promise((res) => split.on('close', res));
paneId = paneId.trim();
console.log(`[smoke] viewer pane: ${paneId}`);

const fd = openSync(fifo, 'w');
const send = (event) => writeSync(fd, `${JSON.stringify(event)}\n`);

// Subscribe to input from the viewer.
const reverseStream = createReadStream(reverseFifo);
let buf = '';
reverseStream.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const text = JSON.parse(line);
      console.log(`[smoke] got input from viewer: ${JSON.stringify(text)}`);
    } catch (err) {
      console.error(`[smoke] parse error: ${err.message}`);
    }
  }
});

// Set a brief scene so the viewer has something visible above the input box.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(500);
send({
  type: 'message_start',
  message: { role: 'assistant', content: [], timestamp: Date.now() },
});
send({
  type: 'message_update',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'Hi! Type something in the input box below and press Enter.',
      },
    ],
    timestamp: Date.now(),
  },
  assistantMessageEvent: { type: 'text_end' },
});

console.log('[smoke] viewer is up. Type into the right pane (use `tmux select-pane -t');
console.log(`           ${paneId}` + '`); the smoke will print whatever you submit.');
console.log('[smoke] this script will run 60s then exit and clean up.');

// Wait 60s then teardown.
await sleep(60_000);
console.log('[smoke] tearing down');

reverseStream.destroy();
closeSync(fd);
try {
  unlinkSync(fifo);
} catch {
  /* ok */
}
try {
  unlinkSync(reverseFifo);
} catch {
  /* ok */
}
spawnSync('tmux', ['kill-pane', '-t', paneId]);
console.log('[smoke] done');
