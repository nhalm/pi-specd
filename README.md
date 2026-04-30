# pi-specd

Automates [specd](https://github.com/nhalm/specd) workflow iterations in [pi](https://github.com/mariozechner/pi-coding-agent). Each iteration runs in a fresh context to avoid context window bloat.

## Overview

specd is a spec-driven development framework. You describe what to build, agents implement autonomously, and audits verify against specs. This extension automates the implementation loop in pi.

## Quick Start

Install from npm:

```bash
pi install npm:@nhalm/pi-specd
```

Or install from GitHub:

```bash
pi install git:github.com/nhalm/pi-specd
```

Initialize specd in your project:

```bash
# In pi, in your project directory
/specd:setup
```

Existing nhalm/specd projects can migrate instead:

```bash
/specd:migrate
```

Then plan and run the loop:

```bash
# Plan (interactive — happens in the parent pi chat)
/specd:plan

# Run the loop (automated)
/specd:loop

# Check status
/specd:status
```

## Concepts

| Concept          | File                   | Purpose                                | Committed?     |
| ---------------- | ---------------------- | -------------------------------------- | -------------- |
| Specs            | `specs/*.md`           | What to build (behavior + contracts)   | Yes            |
| Agent guidelines | `AGENTS.md`            | How agents should approach the project | Yes            |
| Project facts    | `PROJECT.md`           | Build/test commands, conventions       | Yes            |
| Work queue       | `specd_work_list.yaml` | Concrete tasks for agents              | No (ephemeral) |
| Review queue     | `specd_review.yaml`    | Ambiguous findings awaiting decision   | No (ephemeral) |

`/specd:setup` creates all of the above and adds the ephemeral files to `.gitignore`.

## How a run looks

Each command runs work in a **separate sub-agent session** — a brand-new pi agent with its own conversation and context. That sub-agent runs to completion and disposes itself; nothing it sees or says leaks back into the parent pi chat unless the extension chooses to surface it.

How that sub-agent's progress is shown depends on whether you're running pi inside tmux.

### Inside tmux: live side pane

When pi detects `$TMUX`, every sub-agent run opens a horizontal side pane (`tmux split-window -h`) running a small viewer process. That viewer uses pi's own UI components — the same ones pi's interactive mode renders — so the side pane looks exactly like a regular pi chat: tool-call cards, syntax-highlighted code, streaming markdown, the works.

The pane is not just a log. It's interactive:

- Sub-agent activity (every tool call, every assistant message, every thinking block) renders into the pane in real time.
- The pane has its own input box pinned to the bottom. **Type into it and press Enter to talk to the sub-agent mid-run** — your message gets steered into the running session (interrupting the current turn) or queued as the next prompt if it's between turns. Useful for nudging the agent: "actually skip the changelog removal", "delete that file too", "answer in JSON instead", etc.
- For `/specd:loop`, the same pane is reused across all phases — review intake, every implement cycle, audit. Activity history scrolls; you can scroll back through completed cycles.
- The parent pi chat stays usable, but typing there talks to the parent agent, not the sub-agent. Cross-pane discipline matters: type into the _child_ pane to steer the _child_; type into the _parent_ pane for parent-level concerns.

### Outside tmux: rolling-log widget

If you're not running pi inside tmux, the side pane isn't available. Instead, the sub-agent's recent activity appears as a multi-line widget above the editor in the parent pi pane: tool calls with their args, file paths, streaming response snippets. The last six entries are kept; older activity scrolls off. You can't steer the sub-agent in this mode — that requires the side pane's input box.

### Ctrl+C and abort

While a sub-agent is running, Ctrl+C in the **parent** pi pane aborts the in-flight sub-agent. (Ctrl+C inside the side pane is captured by the pane's input box for editing, not for aborting the agent.)

- For `/specd:migrate`, an abort tears the side pane down immediately and cancels the migration.
- For `/specd:loop`, an abort stops the current phase and pi shows a confirm dialog: **Continue with the loop?** Choosing yes moves on to the next phase (next cycle, audit, etc.); choosing no ends the loop entirely. This lets you skip a stuck implement cycle without scrapping the whole loop.

### When a sub-agent finishes

`/specd:migrate`:

- Side pane closes.
- The sub-agent's structured summary (files modified / created / deleted / caveats / technical notes) is handed to the **parent** pi agent via a hidden trigger message. The parent agent then relays the summary to you in its own voice in the main pi chat. The trigger itself is not displayed; you only see the parent's response.

`/specd:loop`:

- Pane stays open after the loop completes (audit included), so you can scroll back through everything that happened. It auto-exits about 30 seconds after the parent closes its end.
- Final status appears in the main pi chat.

### Sub-agent tool surface

Sub-agents are restricted to the standard built-in tools: `read`, `bash`, `edit`, `write`. Extension tools that pi may have loaded for the parent (e.g. `@mjakl/pi-subagent`'s `subagent`) are intentionally hidden from the sub-agent so it doesn't try to delegate to agents that aren't configured in its context.

## Commands

### `/specd:setup`

Initialize specd in a new project. Detects build/test commands and conventions.

### `/specd:migrate`

Migrate an existing nhalm/specd project to specd-loop format (removes spec versions, status lifecycle, and changelogs). Runs in a sub-agent. After it finishes, the parent pi agent delivers a summary in chat. Tmux side pane is interactive while it runs.

### `/specd:plan`

Interactive planning. **Runs in the parent pi session itself**, not in a sub-agent — the planning brief is injected as a user message and pi takes a turn, asking clarifying questions, writing specs, and updating `specd_work_list.yaml`. There's no side pane for plan.

### `/specd:loop [options]`

Run the full automated loop: review intake → implement (looped) → audit. Each phase runs as its own sub-agent (fresh context per phase / per cycle). One side pane is reused for all phases.

| Option           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `--skip-audit`   | Skip the audit phase                           |
| `--max-cycles=N` | Override max implement iterations (default: 5) |

### `/specd:status`

Show the work list: ready items, blocked items, pending reviews, and the next action to take.

## Review items

When implementation or audit finds an ambiguous situation, the loop pauses and surfaces the finding. Edit `specd_review.yaml` and add a `decision:` field to each finding. The path to the file is printed when the loop pauses.

Common decisions:

- **`Fix the code`** → adds a work item to fix the code
- **`Update the spec`** → updates the spec, then adds a work item
- **`Ignore`** → deletes the finding, no action
- **`Keep as is`** → deletes the finding, code is correct

When you run `/specd:loop` again, the review intake interprets your decisions and updates accordingly.

## Requirements

- pi (`@mariozechner/pi-coding-agent`) installed and configured.
- The working directory must contain `AGENTS.md`, `PROJECT.md`, and `specs/README.md`. `/specd:setup` creates all three.
- For the side-pane viewer experience, pi must be running inside a tmux session. Otherwise the rolling-log widget fallback is used (no in-flight steering).

## License

MIT
