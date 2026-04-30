import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

import { abortOnCtrlC } from './abort-on-ctrl-c.js';
import { type AgentRunResult } from './agent-runner.js';
import { TONE } from './prompts.js';
import { runOneShot } from './run-one-shot.js';
import { EXTENSION_VERSION } from './version.js';
import { spawnViewerPane } from './viewer-host.js';

const MIGRATE_PROMPT = `---
description: Migrate project from nhalm/specd format to specd-loop format
---

${TONE}

## Task

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

## Final Summary

After all file changes are complete, end your response with a clearly-marked summary block in exactly this format:

\`\`\`
SUMMARY:
- Files modified: <list paths or "none">
- Files created: <list paths or "none">
- Files deleted: <list paths or "none">
- Caveats: <any notes the user should know about, or "none">
- Notes: <2-3 sentences of additional technical context the user might want to know — what specifically changed in each file at a high level, anything that surprised you, anything you decided judgement-call style, or "none">
\`\`\`

Keep each bullet on one line (the Notes bullet may wrap). Use technical, objective language only. The SUMMARY block must be the last thing you output. Anything before it is internal detail the user won't see.
`;

export async function runMigrate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<AgentRunResult> {
  const { cwd, ui } = ctx;

  const proceed = await ui.confirm(
    'specd migrate',
    [
      'Migration will rewrite files in this repo:',
      '  - AGENTS.md',
      '  - specs/*.md (strips version, status, changelog)',
      '  - specs/README.md',
      '  - specd_work_list.yaml',
      '',
      'Recommended: commit or stash any pending changes first so the migration diff is easy to review.',
      '',
      'Proceed?',
    ].join('\n'),
  );
  if (!proceed) {
    ui.notify('Migration cancelled.', 'info');
    return { kind: 'aborted', output: '' };
  }

  ui.notify('Starting migration.', 'info');

  if (!process.env.TMUX) {
    ui.notify(
      'Running outside tmux: migration activity will appear in a compact log above this editor. For a live side pane and mid-run steering, launch pi inside a tmux session.',
      'info',
    );
  }

  // In tmux: open a side pane that renders sub-agent activity using pi's own
  // components. Outside tmux: fall back to the rolling-log widget.
  const viewer = await spawnViewerPane({ title: 'migration' });
  // Migrate is a single sub-agent run, so onClose mid-run can't cleanly
  // swap to widget mode — record the close and surface a short notice so
  // the user knows the live view is gone, then let the run finish.
  let announcedClose = false;
  const releaseClose = viewer?.onClose(() => {
    if (announcedClose) return;
    announcedClose = true;
    ui.notify(
      'Side pane closed; migration is still running and will report when finished.',
      'info',
    );
  });
  const ctrlC = abortOnCtrlC(ctx);
  // Default to a synthetic 'aborted' so the finally block has a defined
  // value even if runOneShot throws before returning. In that case the
  // exception still propagates past the finally; the only effect of this
  // default is that the viewer pane gets killed (via the aborted branch
  // below) instead of leaving an orphaned pane on the screen.
  let result: AgentRunResult = { kind: 'aborted', output: '' };
  try {
    result = await runOneShot(ctx, {
      prompt: MIGRATE_PROMPT,
      label: 'migration',
      viewer,
      isViewerClosed: false,
      ctrlC,
    });
  } finally {
    ctrlC.unsubscribe();
    releaseClose?.();
    // Aborts kill the pane immediately — the user explicitly walked away.
    // Successful or errored migrations send a 'specd:done' control frame so
    // the side pane shows a completion banner and stays up; the user
    // dismisses it manually. runOneShot already clears the activity widget
    // in widget-mode runs, and the parent chat carries the rich detail in
    // either mode.
    if (viewer) {
      if (result.kind === 'aborted') {
        await viewer.close({ kill: true });
      } else if (result.kind === 'success') {
        viewer.setDone('migration complete');
        await viewer.close({ kill: false });
      } else {
        viewer.setDone('migration failed — check chat for details');
        await viewer.close({ kill: false });
      }
    }
  }

  if (result.kind === 'aborted') {
    ui.notify('Migration aborted by user.', 'warning');
    return result;
  }

  if (result.kind === 'error') {
    ui.notify(`Migration failed: ${result.output}`, 'error');
    return result;
  }

  // Create .pi-specd after successful migration
  const specdFilePath = resolve(cwd, '.pi-specd');
  const specdNote = await writeSpecdMarker(specdFilePath);

  // Pass just the structured SUMMARY block (or a short tail fallback) to the
  // parent so it can announce the result without bloating its context with
  // the full transcript.
  const summary = extractSummary(result.output);
  // Send the trigger as a non-displayed custom message: the LLM sees it and
  // takes a turn, but the chat UI doesn't show this synthesized prompt — the
  // user only sees the parent agent's relayed response.
  pi.sendMessage(
    {
      customType: 'specd-migrate-summary',
      content:
        `The /specd:migrate sub-agent finished. ${specdNote}\n\n` +
        `Structured summary it produced:\n\n` +
        `\`\`\`\n${summary}\n\`\`\`\n\n` +
        `Relay this to me. Technical, objective, concise. No conversational filler, no pleasantries, no introductory or concluding remarks, no emoji. State what changed and any caveats; pull the technical detail from the Notes bullet. Do not run any commands or make further changes.`,
      display: false,
    },
    { triggerTurn: true },
  );

  return result;
}

async function writeSpecdMarker(path: string): Promise<string> {
  try {
    await writeFile(
      path,
      `${JSON.stringify({ version: EXTENSION_VERSION, migratedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf-8',
    );
    return `Wrote .pi-specd at ${path}.`;
  } catch (err) {
    return `Tried to write ${path} but it failed: ${String(err)}.`;
  }
}

/**
 * Pull just the SUMMARY block out of the transcript. The migration prompt
 * tells the sub-agent to end with a `SUMMARY:\n- Files modified: ...` block,
 * so we extract from the last `SUMMARY:` marker onwards. If the agent didn't
 * follow the format, fall back to a small tail of raw transcript.
 */
function extractSummary(output: string, fallbackTailBytes = 1000): string {
  const idx = output.lastIndexOf('SUMMARY:');
  if (idx >= 0) {
    // Strip optional trailing code-fence and trim
    return output
      .slice(idx)
      .replace(/```\s*$/m, '')
      .trim();
  }
  if (output.length <= fallbackTailBytes) return output;
  return `…(no SUMMARY block found, showing tail)…\n${output.slice(-fallbackTailBytes)}`;
}
