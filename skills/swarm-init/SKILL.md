---
name: swarm-init
description: Copy the /swarm skill into the current project (.claude/skills/swarm) for per-project customization — custom agent roles, edited templates, tweaked server/UI. Use when the user invokes /swarm-init or asks to install/fork the swarm skill into this project.
---

# Swarm init (alias command)

This is a thin alias for `/swarm init`. Do not start a run.

Execute the init procedure defined in the main swarm skill — the single source of truth:

1. Locate the main swarm skill: the sibling directory of this SKILL.md — `../swarm/SKILL.md`
   relative to the directory containing this file (works for both `~/.claude/skills/` installs
   and plugin installs). Read its section **"8. Init (`/swarm init`)"**.
2. Follow it exactly: Node ≥ 20.11 check → copy the skill into `<cwd>/.claude/skills/swarm/` →
   write `SOURCE.md` with the source commit hash → bootstrap the global wiki → report the copy
   location, how to revert (delete the folder), and point at `templates/roles/` for custom
   agent roles.
3. If a copy already exists, compare versions via `SOURCE.md` and ask the user what to
   overwrite before touching anything — as the procedure specifies.

**Codex CLI behavior — do NOT ask, just configure:** Codex does not read project-scoped
skill directories, so the copy has no effect there. Under Codex, default to the
project-config init instead:
1. Create `<cwd>/docs/swarm/roles/` (project agent roles — the judge scans it on every
   harness) and `<cwd>/docs/swarm/swarm.config.md` with this starter content:

       # Swarm project config
       The judge reads this before every run. Invocation options override it.

       defaults: workers:<model> wave:4 rounds:no-limit
       ## Judge rules for this project
       - <e.g. never touch prod; all claims verified by execution>
       ## Roles
       Project roles live in docs/swarm/roles/ - add them with $swarm-role.

2. Report both paths and that the judge reads them automatically.
3. ALSO run the classic copy procedure only when the project visibly uses Claude Code
   (a `.claude/` directory exists) or the user explicitly asks for a fork.
