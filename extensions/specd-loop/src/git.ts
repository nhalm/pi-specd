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

/**
 * Returns the count of commits reachable from HEAD that are not reachable
 * from `headBefore` (i.e. `git rev-list HEAD ^headBefore --count`).
 *
 * Used by the loop driver to distinguish a real new commit from an amend:
 * after `git commit --amend`, HEAD changes but no new commit descends from
 * the prior tip, so this returns 0.
 *
 * Returns 0 if git is unavailable or the command fails — callers should
 * treat 0 as "no forward progress".
 */
export async function getNewCommitCount(cwd: string, headBefore: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['rev-list', 'HEAD', `^${headBefore}`, '--count'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(0);
        return;
      }
      const n = parseInt(out.trim(), 10);
      resolve(isNaN(n) ? 0 : n);
    });
    proc.on('error', () => {
      resolve(0);
    });
  });
}
