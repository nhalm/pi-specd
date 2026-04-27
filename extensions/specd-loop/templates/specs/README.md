# Specifications

> Project specifications indexed below

## How Specs Work

Specs define **WHAT to build**, not HOW. You describe behavior, contracts, and interfaces. The agent decides the implementation.

**Status lifecycle:**

```
Draft → Ready → Implemented
  ↑              ↓ (regression found)
  └──── Ready ←──┘
```

- **Draft** — Being specified. Agents ignore it.
- **Ready** — Complete. Agents can implement and audit against it.
- **Implemented** — Code matches spec.

**Work items** live in [specd_work_list.yaml](../specd_work_list.yaml). During `/specd:plan`, work items are created alongside specs.

**Future items** marked with `(future)` are reference only. Do not implement.

**Dependencies** — Only implement features if their dependencies are Ready or Implemented.



## Spec Index

| Spec | Status | Description |
|------|--------|-------------|
| _Add specs here_ | | |

---

# Spec Format

Each spec is a markdown file in this directory.

## Required Sections

```markdown
# Feature Name

| | |
|--------|--------------|
| Status | Draft |

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

Optional: open questions to resolve before moving to Ready.

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
