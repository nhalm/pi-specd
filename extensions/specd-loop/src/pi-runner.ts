import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PiResult {
  success: boolean;
  output: string;
  exitCode: number | null;
}

// Run pi -p with a prompt string
export async function runPiPrompt(cwd: string, prompt: string, model?: string): Promise<PiResult> {
  // Write prompt to temp file
  const tempFile = join(tmpdir(), `specd-prompt-${Date.now()}.md`);
  await writeFile(tempFile, prompt, 'utf-8');

  try {
    const args = ['-p', '--no-session', `@${tempFile}`];
    if (model) {
      args.push('--model', model);
    }

    return new Promise((resolve) => {
      const proc = spawn('pi', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

      let output = '';
      let errorOutput = '';

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          output: output + (errorOutput ? `\n${errorOutput}` : ''),
          exitCode: code,
        });
      });

      proc.on('error', (err) => {
        resolve({
          success: false,
          output: `Failed to spawn pi: ${err.message}`,
          exitCode: null,
        });
      });
    });
  } finally {
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
