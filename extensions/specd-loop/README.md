# specd-loop

Automates specd workflow iterations in pi. Each iteration runs in a fresh context to avoid context window bloat.

## How it works

specd-loop runs three phases in sequence:

1. **Review intake** - Reads your decisions from `specd_review.yaml`, updates specs and work list
2. **Implement loop** - Runs implementation repeatedly until done (may create review items)
3. **Audit** - Checks specs against code, writes findings (may create review items)

## Files

| File                   | Purpose                               | Committed?     |
| ---------------------- | ------------------------------------- | -------------- |
| `specs/*.md`           | Spec documents                        | Yes            |
| `specd_work_list.yaml` | Work queue                            | No (ephemeral) |
| `specd_review.yaml`    | Ambiguous findings and your decisions | No (ephemeral) |

The YAML files are managed by the extension. They are not tracked in git.

## Commands & Prompts

### /specd:plan

Interactive planning prompt. The agent helps you create specs and work items by asking questions and writing to specd_work_list.yaml.

### /specd:loop [options]

Run the full automated loop. Options:

| Option           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `--full-audit`   | Audit all specs (Ready + Implemented)          |
| `--skip-audit`   | Skip the audit phase                           |
| `--max-cycles=N` | Override max implement iterations (default: 5) |

### /specd:status

Show work list status: unblocked items, blocked items, pending reviews.

## Typical workflow

```
# 1. Plan (interactive)
/specd:plan
→ Discuss what to build with the agent
→ Agent creates specs in specs/
→ Agent writes work items to specd_work_list.yaml
→ Tell agent: "mark all specs as ready"

# 2. Run the loop (automated)
/specd:loop
→ Review intake → Implement → Audit

# 3. Handle review items if found (loop pauses)
→ Review items are surfaced to you
→ Edit specd_review.yaml with your decision
→ Run /specd:loop again to continue

# 4. Check status anytime
/specd:status
```

## Review items

When implementation or audit finds an ambiguous situation (unclear if code or spec is wrong), the loop pauses and surfaces the finding to you.

### When this happens:

- During implementation: the agent encounters something confusing
- During audit: the agent finds a mismatch it can't resolve

### How to answer:

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
- **"Keep as is"** → deletes the review item, code is correct

When you run `/specd:loop` again, the review intake interprets your decision and updates accordingly.

## You handle everything else naturally

Just tell the agent what to do:

- "mark all specs ready"
- "add a work item for X"
- "show me the work list"
- "commit what we have"

The agent understands specd concepts and manages the files.

## Output

The extension sends progress messages to your main session:

```
🚀 Starting specd loop (audit: ready)
📋 Running review intake...
✅ Review intake complete
🔨 Cycle 1: 12 items to process
  ✓ Processed 1, 11 remaining
...
✅ Loop complete! 12 items, audit clean
```

When review items are found:

```
🔨 Cycle 1: 3 items to process
  ✓ Processed 1, 2 remaining
📋 2 review item(s) need your attention:
## auth
**Finding:** The spec says...
...
⏸️ Answer the review items above, then run /specd:loop to continue.
```

## Requirements

Working directory must contain:

- `specs/` directory with spec files
- `AGENTS.md` with agent guidelines
- `specs/README.md` with spec index

Prompts and file parsers are bundled with the extension.
