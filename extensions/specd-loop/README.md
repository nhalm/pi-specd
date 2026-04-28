# specd-loop

The implementation of the `pi-specd` extension. See the [top-level README](../../README.md) for usage and concepts.

## Layout

- `index.ts` — registers slash commands with pi
- `src/` — loop driver, prompt strings, YAML readers, subprocess runner
- `templates/` — files copied into a project by `/specd:setup` (`AGENTS.md`, `PROJECT.md`, `specs/README.md`, the two ephemeral YAML files)
