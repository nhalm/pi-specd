import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

export function showWidget(
  ctx: ExtensionCommandContext,
  phase: string,
  cycle: number,
  maxCycles: number,
  itemsRemaining: number,
  status: string,
) {
  ctx.ui.setWidget('specd-loop', [
    ` specd-loop | ${phase} | Cycle ${cycle}/${maxCycles} | ${itemsRemaining} items | ${status}`,
  ]);
}

export function clearWidget(ctx: ExtensionCommandContext) {
  ctx.ui.setWidget('specd-loop', undefined);
}
