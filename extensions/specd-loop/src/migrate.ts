import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTENSION_VERSION } from './version.js';
import { runPiPrompt } from './pi-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(resolve(import.meta.url, '..'));

const MIGRATE_PROMPT = `---
description: Migrate project from nhalm/specd format to specd-loop format
---

You are helping migrate a project from nhalm/specd format to specd-loop format.

## What Changed

The new format:
- **No spec versioning** — specs are edited in place, no version numbers
- **No spec status** — removed Draft/Ready/Implemented lifecycle
- **No changelogs** — removed from spec files
- **Work list uses YAML format** — structured YAML instead of markdown-style

## Your Task

For each file that exists, make the following changes:

### specd_work_list.yaml
- Remove version numbers from spec headers (e.g., \`## auth v0.1\` → \`## auth\`)
- Remove \`status:\` lines under spec headers
- Convert to proper YAML format:
  \`\`\`yaml
  specs:
    - name: auth
      items:
        - description: Add login endpoint
          completed: false
        - description: Add logout endpoint
          completed: false
          blocked: Add user model
  \`\`\`

### specs/README.md
- Remove the "Status lifecycle" section and status lifecycle diagram
- Remove status column from the spec index table
- Remove "No versioning" note if present

### Individual spec files (specs/*.md)
- Remove version row from the header table (e.g., \`| Version | 0.1 |\`)
- Remove status row from the header table
- Remove "Last Updated" row if present
- Remove separator lines (|---|...) that were under removed rows
- Remove "## Changelog" section entirely

### AGENTS.md
- Replace with the new AGENTS.md content (will be provided)

## Rules

- Keep all actual content (descriptions, requirements, specifications)
- Only remove: version numbers, status rows, changelog sections
- Don't change the structure of the specification sections
- If a file doesn't exist, skip it

## Output

After making changes, output \`MIGRATION_COMPLETE: true\`
`;

export interface MigrateResult {
  success: boolean;
  output: string;
}

export async function runMigrate(
  cwd: string,
  ui?: { notify(msg: string, type: string): void },
): Promise<MigrateResult> {
  if (ui) {
    ui.notify('🚀 Starting migration...', 'info');
  }

  // Run the migration in a subprocess
  const result = await runPiPrompt(cwd, MIGRATE_PROMPT, 'sonnet');

  if (!result.success) {
    if (ui) {
      ui.notify(`❌ Migration failed: ${result.output}`, 'error');
    }
    return { success: false, output: result.output };
  }

  // Create .pi-specd after successful migration
  const specdFilePath = resolve(cwd, '.pi-specd');
  try {
    await writeFile(
      specdFilePath,
      JSON.stringify({ version: EXTENSION_VERSION, migratedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf-8',
    );
    if (ui) {
      ui.notify('✅ Migration complete. Created .pi-specd', 'info');
    }
  } catch (err) {
    if (ui) {
      ui.notify(`⚠️  Migration succeeded but failed to create .pi-specd: ${err}`, 'warn');
    }
  }

  return { success: true, output: result.output };
}
