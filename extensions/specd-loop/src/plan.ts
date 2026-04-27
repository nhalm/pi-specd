import { runPiPrompt } from './pi-runner.js';
import { PLAN_PROMPT } from './prompts.js';
import { logOutput } from './logger.js';

export async function runPlan(
  cwd: string,
  ui?: { notify(msg: string, type: string): void },
): Promise<{ success: boolean; output: string }> {
  if (ui) {
    ui.notify('📝 Starting planning session...', 'info');
  }

  const result = await runPiPrompt(cwd, PLAN_PROMPT, 'sonnet');

  if (result.success) {
    const logPath = await logOutput('plan', result.output);
    if (ui) {
      ui.notify(`✅ Planning session complete (logged to: ${logPath})`, 'info');
    }
  } else {
    if (ui) {
      ui.notify(`❌ Planning session failed: ${result.output}`, 'error');
    }
  }

  return { success: result.success, output: result.output };
}
