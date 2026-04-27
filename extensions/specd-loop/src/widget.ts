interface UiContext {
  setWidget(name: string, lines: string[] | undefined): void;
}

interface WidgetContext {
  ui: UiContext;
}

export function showWidget(
  ctx: WidgetContext,
  phase: string,
  cycle: number,
  maxCycles: number,
  itemsRemaining: number,
  status: string,
) {
  const lines = [
    ` specd-loop | ${phase} | Cycle ${cycle}/${maxCycles} | ${itemsRemaining} items | ${status}`,
  ];
  ctx.ui.setWidget("specd-loop", lines);
}

export function clearWidget(ctx: WidgetContext) {
  ctx.ui.setWidget("specd-loop", undefined);
}
