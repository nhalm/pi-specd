import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = join(tmpdir(), 'specd-loop');

export async function logOutput(phase: string, content: string): Promise<string> {
  await mkdir(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${phase}-${timestamp}.log`;
  const filepath = join(LOG_DIR, filename);
  await writeFile(filepath, content, 'utf-8');
  return filepath;
}
