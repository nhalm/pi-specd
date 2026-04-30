import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

import { PLAN_PROMPT } from './prompts.js';

/**
 * Plan is collaborative — the prompt explicitly tells the agent to ask the
 * user clarifying questions. So instead of running an isolated sub-agent that
 * has no way to talk to the user, we hand the planning brief to the parent
 * session as a user message. The user's chat with pi becomes the planning
 * session: pi reads the brief, asks questions, and creates specs in response.
 */
export function runPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  ctx.ui.notify('📝 Starting planning session...', 'info');
  pi.sendUserMessage(PLAN_PROMPT);
}
