import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PiResult {
  success: boolean;
  output: string;
}

export type PiModel = 'sonnet' | 'opus';

const TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

// Run pi -p with a prompt string
export async function runPiPrompt(cwd: string, prompt: string, model?: PiModel): Promise<PiResult> {
  // mkdtemp avoids collisions if multiple runners launch within the same ms
  const tempDir = await mkdtemp(join(tmpdir(), 'specd-prompt-'));
  try {
    const tempFile = join(tempDir, 'prompt.md');
    await writeFile(tempFile, prompt, 'utf-8');

    const args = ['-p', '--no-session', `@${tempFile}`];
    if (model) args.push('--model', model);

    return await new Promise<PiResult>((resolve) => {
      const proc = spawn('pi', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let settled = false;
      let timedOut = false;

      const settle = (r: PiResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };

      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        const remaining = MAX_BUFFER_BYTES - (target === 'stdout' ? stdout.length : stderr.length);
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const fits = chunk.length <= remaining;
        if (!fits) truncated = true;
        const text = fits ? chunk.toString() : chunk.subarray(0, remaining).toString();
        if (target === 'stdout') stdout += text;
        else stderr += text;
      };

      proc.stdout.on('data', (data: Buffer) => {
        append('stdout', data);
      });
      proc.stderr.on('data', (data: Buffer) => {
        append('stderr', data);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        // Hard-kill if it doesn't exit promptly
        setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
      }, TIMEOUT_MS);

      proc.on('close', (code) => {
        const merged =
          stdout + (stderr ? `\n${stderr}` : '') + (truncated ? '\n[output truncated]' : '');
        settle({
          success: code === 0 && !timedOut,
          output: timedOut ? `${merged}\n[killed: timeout after ${TIMEOUT_MS}ms]` : merged,
        });
      });

      proc.on('error', (err) => {
        settle({
          success: false,
          output: `Failed to spawn pi: ${err.message}`,
        });
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
