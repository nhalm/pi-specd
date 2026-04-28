# Specifications

> Project specifications indexed below

## How Specs Work

Specs define **WHAT to build**, not HOW. You describe behavior, contracts, and interfaces. The agent decides the implementation.

**Work items** drive what gets implemented. They live in [specd_work_list.yaml](../specd_work_list.yaml) and are created during `/specd:plan`. Specs are edited in place — there is no draft/ready/implemented lifecycle.

**Future items** marked with `(future)` in a spec are reference only. Do not implement.

**Dependencies** — list them in the spec. Items in the work list use a `blocked: <reason>` field for inter-item ordering.

## Spec Index

| Spec             | Description |
| ---------------- | ----------- |
| _Add specs here_ |             |

---

# Spec Format

Each spec is a markdown file in this directory.

## Required Sections

```markdown
# Feature Name

## Overview

What this component does.

**Scope:**

- What it handles
- What it explicitly does NOT handle

**Dependencies:**

- other-spec.md — what we need from it

## Specification

Detailed behavior, contracts, and interfaces. Must be complete enough for implementation without asking questions.

### API (if applicable)

- Endpoint definitions
- Request/response formats
- Error codes

### Data Model (if applicable)

- Schema definitions
- Validations

## Notes

Optional: open questions to resolve before the spec is considered complete.
```

## Writing Good Specs

**Do:**

- Define behavior, not code structure
- Include concrete acceptance criteria
- Specify error cases and edge cases
- Use precise language ("returns X" not "should return X")

**Don't:**

- Prescribe file names or function names
- Specify implementation patterns
- Include rationale or "why" explanations
