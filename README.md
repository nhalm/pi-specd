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
# Plan (interactive)
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

## Commands

### `/specd:setup`

Initialize specd in a new project. Detects build/test commands and conventions.

### `/specd:migrate`

Migrate an existing nhalm/specd project to specd-loop format (removes spec versions, status lifecycle, and changelogs).

### `/specd:plan`

Interactive planning. The agent helps you create specs and work items by asking questions and writing to `specd_work_list.yaml`.

### `/specd:loop [options]`

Run the full automated loop: review intake → implement (looped) → audit.

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

The working directory must contain `AGENTS.md`, `PROJECT.md`, and `specs/README.md`. `/specd:setup` creates all three.

## License

MIT
