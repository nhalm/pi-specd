import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

import { logOutput } from './logger.js';
import { runPiPrompt, type PiResult } from './pi-runner.js';
import { PLAN_PROMPT } from './prompts.js';

export async function runPlan(ctx: ExtensionCommandContext): Promise<PiResult> {
  const { cwd, ui } = ctx;
  ui.notify('📝 Starting planning session...', 'info');

  const result = await runPiPrompt(cwd, PLAN_PROMPT, 'sonnet');

  if (result.success) {
    const logPath = await logOutput('plan', result.output);
    ui.notify(`✅ Planning session complete (logged to: ${logPath})`, 'info');
  } else {
    ui.notify(`❌ Planning session failed: ${result.output}`, 'error');
  }

  return result;
}
