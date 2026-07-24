---
name: swarm-role
description: Create a new custom agent role for the /swarm skill (e.g. semantic-code-reviewer, security-auditor, benchmark-runner) so the judge knows about it and spawns it in future runs. Use when the user invokes /swarm-role <role idea>, or asks to add a new agent/role type to the swarm.
---

# Swarm role creator

You are authoring a new agent role for the swarm. The judge scans `templates/roles/*.md` when
planning each wave and adds those roles to its menu — a well-written file IS the deployment.

## 0. Authoring discipline

If the `superpowers:writing-skills` skill is available, invoke it first and apply its
authoring discipline here (clear triggers, concision, verification before deployment).
Whether or not it is available, the checklist in section 3 is mandatory.

## 1. Understand the role (ask only what you cannot infer)

From the user's description establish:
- **Job** — the one thing this agent does in a wave (single responsibility).
- **Trigger** — when should the judge pick it? Must be decidable from the goal/round state
  without guessing ("waves that touched code", "before any external claim ships", …).
- **Output contract** — what it writes where: wiki page path pattern
  (`wiki/findings/<role>-r{{ROUND}}.md`, failures for fatals), board posts, artifact edits.
- **Model hint** (optional) — cheap role → `haiku`; deep analysis → session default or `opus`.

One question at a time if something is genuinely unclear; otherwise proceed.

## 2. Write the role file

Target directory — **project copy wins**: if `<cwd>/.claude/skills/swarm/templates/roles/`
exists, write there; otherwise `~/.claude/skills/swarm/templates/roles/`. Tell the user which
one you used. File: `<slug>.md` in this exact shape (the judge reads it verbatim):

```markdown
# Role: <slug>

**When to use:** <trigger the judge can act on — one or two sentences. Say whether it runs
alongside normal workers, or gates like a critic.>

**Model hint:** <haiku | sonnet | opus | inherit — optional line, judge may override>

**Append to the worker task:**

<Imperative instructions for the worker: exactly what to examine/produce, in what order;
the output contract (wiki paths, board post types); what is OUT of scope. Use {{ROUND}}
where the round number belongs. Keep under ~15 lines — workers get the full worker
template too; this is the role-specific delta only.>
```

## 3. Checklist before saving (mandatory)

1. **Single responsibility** — one job; if the description needs "and", split into two roles.
2. **Decidable trigger** — could the judge, mid-run, decide yes/no from the board and goal
   alone? If not, sharpen it.
3. **Disjoint** — read the built-in menu (researcher / analyst / coder / tester /
   synthesizer / critic) and every existing file in `templates/roles/`. Overlap → either
   narrow the new role or update the existing file instead of duplicating.
4. **Output contract concrete** — named wiki path pattern, board post types. "Report your
   findings" without a destination is a placeholder, not a contract.
5. **Verify** — show the user the final file content and where it landed. If a board server
   from a live run is up, offer a smoke test: spawn one worker with this role on a
   trivially-scoped task and check it follows the contract (wiki page + board posts appear).

## 4. Report

Confirm: file path, one-line summary of the trigger, and that the next `/swarm` run picks it
up automatically (the judge's wave-planning step scans `templates/roles/`). If the project
uses a local copy (`SOURCE.md` present), remind the user the role lives in the fork, not the
global skill.
