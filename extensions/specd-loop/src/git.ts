import { spawn } from 'node:child_process';

/**
 * Returns the current HEAD commit hash, or null if `git` is unavailable
 * or the directory is not inside a git repository.
 */
export async function getHeadCommit(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on('close', (code) => {
      resolve(code === 0 ? out.trim() : null);
    });
    proc.on('error', () => {
      resolve(null);
    });
  });
}
