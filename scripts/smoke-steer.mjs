// Repro: long prompt + concurrent steer.
// Goal: see exactly what happens when we call session.steer() while the
// agent is in various states (not yet streaming, mid-tool, mid-text).

import { createAgentSession } from '@mariozechner/pi-coding-agent';

const cwd = process.cwd();
console.log('[steer] creating session…');
const { session } = await createAgentSession({ cwd });

// Log every event so we can see exactly when steering would land.
session.subscribe((event) => {
  const t = `[+${((Date.now() - t0) / 1000).toFixed(2)}s]`;
  if (event.type === 'message_update') {
    const sub = event.assistantMessageEvent?.type ?? '?';
    console.log(`${t} message_update ${sub}`);
  } else {
    console.log(`${t} ${event.type}${'toolName' in event ? ` ${event.toolName}` : ''}`);
  }
});

const t0 = Date.now();
process.on('unhandledRejection', (err) => {
  console.error(`[steer] UNHANDLED REJECTION:`, err);
});
process.on('uncaughtException', (err) => {
  console.error(`[steer] UNCAUGHT EXCEPTION:`, err);
});

// Kick off a multi-step task, then try to steer at different moments.
const promptPromise = session.prompt(
  'Use bash to list files, then bash to print the date, then say done.',
);

// Try steering after a small delay (probably mid-stream)
setTimeout(() => {
  console.log('\n[steer] >>> calling session.steer("what time is it")');
  try {
    const p = session.steer('what time is it');
    if (p && typeof p.catch === 'function') {
      p.then(
        () => {
          console.log('[steer] steer resolved');
        },
        (err) => {
          console.error('[steer] steer rejected:', err);
        },
      );
    }
  } catch (err) {
    console.error('[steer] steer threw sync:', err);
  }
}, 1500);

// Try steering again with a "delete file" message
setTimeout(() => {
  console.log('\n[steer] >>> calling session.steer("delete the file PROJECTS.md")');
  try {
    const p = session.steer('delete the file PROJECTS.md');
    if (p && typeof p.catch === 'function') {
      p.then(
        () => {
          console.log('[steer] steer 2 resolved');
        },
        (err) => {
          console.error('[steer] steer 2 rejected:', err);
        },
      );
    }
  } catch (err) {
    console.error('[steer] steer 2 threw sync:', err);
  }
}, 4000);

await promptPromise;
console.log(`[steer] prompt done at +${((Date.now() - t0) / 1000).toFixed(2)}s`);
session.dispose();
