# specd-loop

The implementation of the `pi-specd` extension. See the [top-level README](../../README.md) for usage and concepts.

## Layout

- `index.ts` — registers slash commands with pi
- `src/` — loop driver (`loop.ts`), in-process agent runner over pi sessions (`agent-runner.ts` via `createAgentSession`), one-shot helper (`run-one-shot.ts`), `Phase` type and `ActivityFrame` schema, abort watcher (`abort-on-ctrl-c.ts`), tmux viewer host plus the spawned renderer (`viewer-host.ts`, `viewer.mjs`), YAML loaders (`worklist.ts`, `review.ts`, `yaml-helpers.ts`), prompt strings (`prompts.ts`), git/commit verification (`git.ts`, `loop-verify.ts`), version constant (`version.ts`), per-phase log files (`logger.ts`), and the parent-pane UI surfaces (`ui.ts`, `widget.ts`).
- `templates/` — files copied into a project by `/specd:setup`. Today only `AGENTS.md` is copied verbatim; `PROJECT.md` and `specs/README.md` are generated from project detection. The two ephemeral YAML files (`specd_work_list.yaml`, `specd_review.yaml`) are copied as-is.
