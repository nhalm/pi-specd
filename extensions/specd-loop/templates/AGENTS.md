# Spec Authority

**Specs are prescriptive, not descriptive.** The spec defines what code MUST do.

- **Spec is source of truth.** If code contradicts the spec, the code is wrong — refactor it.
- **Re-read specs on changes.** When a spec is updated, re-read it to understand the new requirements.
- **Don't build on broken foundations.** If existing code uses the wrong model (e.g., wrong ID scheme, wrong data flow), fix it first. Don't add new features on top of incorrect code.
- **Spec index:** `specs/README.md` lists all specifications.

# Audit Discipline

**Zero findings is a valid outcome.** An audit that confirms correctness is successful — do not manufacture findings to justify the work.

**The bar for a finding is: will this cause a bug in production?** Not "could this theoretically be a problem" — will it actually break?

Before reporting a finding:

- **Read the actual code, not just the spec.** Findings based on spec text alone are unreliable. The code is ground truth.
- **Check if it's actually reachable.** Trace the code path. If it requires multiple unlikely conditions, it's not a finding.
- **Check if the spec section is prescriptive.** "Notes" and "Design decisions" are commentary, not requirements.

# Loop System

The loop runs autonomously via the `/specd:loop` command. Commands are defined by the specd-loop extension.

| Command          | Purpose                                                   |
| ---------------- | --------------------------------------------------------- |
| `/specd:setup`   | Initialize specd in the project                           |
| `/specd:migrate` | Migrate from older nhalm/specd format                     |
| `/specd:loop`    | Run the automated loop: review intake → implement → audit |
| `/specd:plan`    | Create or update specs and work items                     |
| `/specd:status`  | Show current work list status                             |

## Work List

`specd_work_list.yaml` is the execution queue, but only certain workflows touch it:

- **Planning** writes new items.
- **Review intake** and **audit** append items derived from decisions or findings.
- **Implementation** does NOT read or write the work list — the loop driver picks one item and tells the implementer what to work on, then marks it complete after a successful commit. The driver verifies BOTH (a) no new review-finding was appended to `specd_review.yaml` during the cycle AND (b) a new commit actually landed (via `git rev-list HEAD ^${headBefore} --count` ≥ 1, which also rejects an `--amend` of the prior commit). If either gate fails, the item stays incomplete and the loop halts.

Items with a `blocked: <reason>` field are skipped until a planning pass clears the blocker.

## Review List

`specd_review.yaml` holds ambiguous findings that need human judgment. When the audit can't tell if code or spec is wrong, it writes here.

Between loop runs: edit this file, fill in your decision for each finding. On the next loop, remaining items become work items.
