# pi-specd

Automates [specd](https://github.com/nhalm/specd) workflow iterations in pi. Each iteration runs in a fresh context to avoid context window bloat.

## Overview

specd is a spec-driven development framework. You describe what to build, agents implement autonomously, and audits verify against specs. This extension automates the implementation loop in pi.

## How it works

`pi-specd` runs three phases in sequence:

1. **Review intake** - Reads your decisions from `specd_review.yaml`, updates specs and work list
2. **Implement loop** - Runs implementation repeatedly until done (may create review items)
3. **Audit** - Checks specs against code, writes findings (may create review items)

## Quick Start

```bash
pi install git:github.com:nhalm/pi-specd
```

Then in pi:

```bash
# Plan (interactive)
/specd:plan

# Run the loop (automated)
/specd:loop

# Check status
/specd:status
```

## Commands

### `/specd:plan`

Interactive planning prompt. The agent helps you create specs and work items by asking questions and writing to `specd_work_list.yaml`.

### `/specd:loop [options]`

Run the full automated loop.

| Option           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `--full-audit`   | Audit all specs (Ready + Implemented)          |
| `--skip-audit`   | Skip the audit phase                           |
| `--max-cycles=N` | Override max implement iterations (default: 5) |

### `/specd:status`

Show work list status: unblocked items, blocked items, pending reviews.

## Files

| File                   | Purpose                               | Committed?     |
| ---------------------- | ------------------------------------- | -------------- |
| `specs/*.md`           | Spec documents                        | Yes            |
| `specd_work_list.yaml` | Work queue                            | No (ephemeral) |
| `specd_review.yaml`    | Ambiguous findings and your decisions | No (ephemeral) |

The YAML files are managed by the extension. They are not tracked in git.

## Review Items

When implementation or audit finds an ambiguous situation, the loop pauses and surfaces the finding to you.

### How to answer

Edit `specd_review.yaml` and add your decision:

```yaml
## auth
finding: The spec says X but the code does Y
...
decision: Fix the code to match the spec
```

Common decisions:

- **"Fix the code"** → adds work item to fix the code
- **"Update the spec"** → updates spec first, then adds work item
- **"Ignore"** → deletes the review item, takes no action

When you run `/specd:loop` again, the review intake interprets your decision and updates accordingly.

## Requirements

Working directory must contain:

- `specs/` directory with spec files
- `AGENTS.md` with agent guidelines
- `specs/README.md` with spec index

## License

MIT
