// Smoke test for the in-process agent runner with rolling log.
// Mirrors the same call shape the extensions use.
//
// Usage: node scripts/smoke-agent-runner.mjs ["prompt text"]

import { createAgentSession } from '@mariozechner/pi-coding-agent';
import { runAgentSession } from '../extensions/specd-loop/src/agent-runner.ts';

const prompt = process.argv[2] ?? 'List the files in the current dir then say done.';
const cwd = process.cwd();

console.log(`[smoke] cwd=${cwd}`);
console.log(`[smoke] prompt=${prompt}`);

const t0 = Date.now();
const result = await runAgentSession(cwd, prompt, {
  onLogUpdate: (lines) => {
    const t = `[+${((Date.now() - t0) / 1000).toFixed(2)}s]`;
    console.log(`${t} --- log (${lines.length} lines) ---`);
    for (const line of lines) console.log(`${t}   ${line}`);
  },
});

console.log(`[smoke] success=${result.success} elapsed=${Date.now() - t0}ms`);
console.log('[smoke] transcript:');
console.log(result.output);
