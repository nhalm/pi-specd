# specd-loop

Spec-driven development workflow for pi. You describe what to build, specs guide implementation, and agents work autonomously against the spec list.

## Quick Start

```bash
# For new projects:
/specd:setup
# ... answer the prompts ...

# For existing nhalm/specd projects:
/specd:migrate
# ... confirm the migration ...

/specd:plan
# ... describe what to build ...

/specd:loop
```

## How It Works

1. **Setup/Migrate** — Initialize or migrate specd in your project.
2. **Plan** (`/specd:plan`) — Create specs describing what to build. Work items are generated automatically.
3. **Loop** (`/specd:loop`) — Agents implement work items, run audits, and surface decisions for you.
4. **Review** — Fill in decisions for ambiguous findings, then run the loop again.

## Commands

### /specd:migrate

Migrate an existing nhalm/specd project to specd-loop format. Removes:

- Spec versions and changelogs
- Spec status (Draft/Ready/Implemented)
- Status column from specs/README.md

### /specd:setup

Initialize specd in a new project. Detects your project's build/test commands and conventions.

Creates:

- `AGENTS.md` — Agent guidelines
- `PROJECT.md` — Your project settings
- `specs/README.md` — Spec index and format guide
- `specd_work_list.yaml` — Work queue
- `specd_review.yaml` — Decision queue
- `.pi-specd` — Version tracking
- Updates `.gitignore`

### /specd:plan

Create or update specs and work items.

### /specd:loop [options]

Run the automated loop.

| Option           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `--full-audit`   | Audit all specs (not just those in work list)  |
| `--skip-audit`   | Skip the audit phase                           |
| `--max-cycles=N` | Override max implement iterations (default: 5) |

### /specd:status

Show work list status: unblocked items, blocked items, pending reviews.

## Files

| File                   | Purpose                          | Committed? |
| ---------------------- | -------------------------------- | ---------- |
| `AGENTS.md`            | Agent instructions               | Yes        |
| `PROJECT.md`           | Build/test commands, conventions | Yes        |
| `specs/*.md`           | Your specifications              | Yes        |
| `specd_work_list.yaml` | Work queue                       | No         |
| `specd_review.yaml`    | Pending decisions                | No         |
| `.pi-specd`            | Version info                     | No         |

The work/review files and `.pi-specd` are gitignored.

## Review Items

When the audit finds something ambiguous, it pauses and writes a finding to `specd_review.yaml`.

To answer:

1. Edit `specd_review.yaml`
2. Fill in your decision for each finding
3. Run `/specd:loop` again

Common decisions:

- **"Fix the code"** — adds work item to fix code
- **"Update the spec"** — updates spec, then adds work item
- **"Ignore"** — deletes finding, no action
- **"Keep as is"** — deletes finding, code is correct
