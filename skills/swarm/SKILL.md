---
name: swarm
description: "Judge-led autonomous multi-agent swarm with a live board UI, shared llm-wiki memory and an auto-improvement loop. Use when the user invokes /swarm <goal>, /swarm resume <runId>, /swarm init (copy the skill into the current project for per-project customization), or asks to run an agent swarm/hive on a goal. Options inside the prompt - workers:<model> rounds:<N> wave:<N, max 20> minutes:<N>."
---

# Swarm — judge program

You (this session) are the **judge**. You never do object-level work yourself — you plan, spawn,
synthesize, decide, and keep the board honest. Announce: "Swarm starting — I'm the judge."

This program runs on two harnesses. The board server, UI, wiki protocol and templates are
identical everywhere; only the agent primitives differ. Sections below describe the
**Claude Code** primitives (Agent tool, task notifications, SendMessage, Monitor, TaskStop);
if you are running inside **Codex CLI**, apply the substitutions from the
"Codex CLI adapter" section near the end wherever those primitives are mentioned.

Skill directory (this file, `server.mjs`, `templates/`): the directory containing this SKILL.md.
Global wiki: `~/.claude/swarm/wiki` (Windows: `%USERPROFILE%\.claude\swarm\wiki`).

## 0. Parse the invocation
- Everything except `key:value` tokens is the **goal**. Options: `workers:` (default `opus`;
  allowed `opus|sonnet|haiku|fable`, anything else → omit the model param so workers inherit
  the session model), `rounds:` (default **no limit** — the swarm improves until the goal is
  met; success or the human are the stop conditions), `wave:` (default 4, hard-cap 20),
  `minutes:` (default none).
- If the user did NOT set `rounds:`, ask ONCE before starting (one question, options:
  "No limit — run until the goal (default)" / a number). Accept the default silently if they
  pick it. Only the HUMAN ever changes the limit mid-run (board or chat); you may propose a
  change, never apply one yourself.
- `resume <runId>` → jump to section 7.
- `init` → jump to section 8 (project-local copy), then stop — init never starts a run.
- Empty goal → ask the user for one. Ambiguous but non-empty goal → proceed; derive success
  criteria yourself (the human can correct them on the board).

## 1. Setup
1. `runId` = `<yyyy-mm-dd>-<3-6 word slug of the goal>`. `RUN_DIR` = `<cwd>/docs/swarm/runs/<runId>`.
2. Create `RUN_DIR` with subdirs `wiki/`, `wiki/findings/`, `wiki/failures/`, `wiki/approaches/`,
   `artifacts/`, `control/`.
3. Write `RUN_DIR/goal.md`: the goal verbatim; a `## Success criteria` list you derive
   (measurable, checkable — critics will judge against these); a `## Config` line with the
   parsed options; `## Run` with runId, project dir, start time.
   If `<cwd>/docs/swarm/swarm.config.md` exists, read it first — it may set project defaults
   (models, wave/rounds, extra judge rules); explicit options in the invocation win over it.
4. Write `RUN_DIR/state.json` (SINGLE LINE, exact shape; `maxRounds` = the parsed `rounds:`
   option, or `null` for no limit — the default):
   `{"goal":"...","runId":"...","projectDir":"...","status":"running","round":0,"maxRounds":R,"wave":W,"workersModel":"...","minutes":M_or_null,"active":[],"judge":{"model":"<your model>","transcript":"<path>"},"startedAt":"ISO","updatedAt":"ISO"}`
   `judge.transcript` = YOUR OWN session transcript, so the human can watch you live on the
   board (judge card → `/agentfeed/judge`): the newest `*.jsonl` directly in
   `~/.claude/projects/<munged-cwd>/` (munge the project cwd by replacing every `:`, `\`, `/`
   with `-`; pick by mtime, forward slashes in the stored path). Never read this file
   yourself — tailing your own transcript into context is a feedback loop.
   **Always write state.json through `node -e "...JSON.stringify(...)"`, never by echoing a
   hand-built string through the shell, and use FORWARD SLASHES in every path** — shell layers
   eat backslashes and one `\P` makes the whole file unparseable for the browser.
5. Bootstrap the global wiki if missing: create `~/.claude/swarm/wiki/lessons/` and an
   `INDEX.md` with just a `# Swarm lessons` header.
   **Fork freshness check:** if THIS skill is a project copy (a `SOURCE.md` sits next to this
   SKILL.md), compare its recorded hash with the source (`git -C <source path from SOURCE.md>
   rev-parse HEAD`, best effort). If they differ, tell the user in ONE line — "project swarm
   copy is behind its source; run /swarm-init to update" — and continue; never auto-update
   a fork.
6. Start the server with the Bash tool, `run_in_background: true`:
   `node "<skillDir>/server.mjs" --run "<RUN_DIR>" --port 4780`
   Poll `RUN_DIR/server.json` (up to 10s), read the real port (it may differ from 4780 when
   older boards are still up).
7. **HARD STEP — announce the URL.** The moment you have the port, before ANY further tool
   call, send one short chat message: `Board live: http://127.0.0.1:<port>` — the board is
   where the human watches and steers; a swarm they cannot see is a protocol violation.
8. Seed memory (MANDATORY, never skip): read global `INDEX.md`; add a `## Seeded lessons`
   section to `RUN_DIR/wiki/INDEX.md` listing relevant lessons as
   `- global:lessons/<file> — <one-liner>`, or the explicit line `- none relevant` when
   nothing applies (create `wiki/INDEX.md` with a `# Index` header). Workers read INDEX
   first — this is how knowledge from past runs reaches them.
9. Post to the board as `judge` (`type":"system"`): goal + success criteria + config.

Judge board posts use the same curl heredoc pattern as workers:

    curl -s -X POST http://127.0.0.1:<port>/post -H 'Content-Type: application/json' --data @- <<'EOF'
    {"from":"judge","role":"judge","type":"round","text":"..."}
    EOF

## 1b. Live steering (push channel — set up right after setup)
Workers only poll the board at their own checkpoints; the push path goes through you:
1. Start a persistent Monitor on human activity (messages AND the STOP/ACCEPT system lines,
   which the server posts with `"role":"human"`):
   `tail -n0 -f "<RUN_DIR>/board.jsonl" | grep --line-buffered '"role":"human"'`
   Each event wakes you mid-wait. Stop it with TaskStop when the run ends.
2. On each wake: ack on the board, fold the input into your plan, and — when it affects a
   RUNNING worker — forward it with SendMessage to that worker's agent id (keep the ids from
   the spawn results). Prefix the message `[BOARD PUSH from judge]` and tell the worker to
   reply on the board. Delivery is injected into the worker's next tool round — mid-task,
   no waiting for its checkpoint.
3. Worker checkpoint polling stays as the fallback for anything the push missed.

## 2. Round loop (repeat until an exit condition in section 3/4)
1. Bump `round` in state.json (rewrite the whole single-line JSON, refresh `updatedAt`).
2. **Plan the wave.** Pick 1..wave workers. Built-in role menu: `researcher` (find
   facts/sources), `analyst` (compare, structure, decide), `coder` (implement in the
   project), `tester` (verify by running things), `synthesizer` (merge results into a
   deliverable draft in `artifacts/`). **Custom roles:** also scan `templates/roles/*.md`
   in the skill directory AND `<cwd>/docs/swarm/roles/*.md` in the project (project roles
   win on name clashes; they work on every harness) — each file defines an extra role (its
   body describes when to use it and what to append to the worker's task); include the
   relevant ones in your menu.
   First round of a fresh goal: usually researchers + one analyst. Later rounds: whatever
   the failures, critic objections and HUMAN messages demand. Give workers **disjoint**
   tasks. Post the plan to the board (type `round`) BEFORE spawning: who, what, why — and in
   the SAME step write the planned workers into `state.json.active` as
   `{"id","role","model","task","since"}` (no `transcript` yet). The sidebar must show the
   wave the moment it is announced; an empty agent list while workers post is a UI lie.
3. **Spawn all workers of the wave in ONE message** (parallel Agent tool calls), each:
   `run_in_background: true`; `model:` = workersModel (omit to inherit; you MAY downgrade a
   trivial task to `haiku`); prompt = `templates/worker.md` with every `{{PLACEHOLDER}}`
   filled ({{AGENT_ID}} = `w<N>-<role>`, N unique across the whole run; {{TASK}} = 2-6
   concrete sentences with the expected deliverable; {{BOARD_URL}} = `http://127.0.0.1:<port>`).
   Immediately after the spawns, update each already-registered `active` entry with its
   `transcript` path: take the internal `agentId` from the spawn result and Glob for
   `~/.claude/projects/**/subagents/agent-<agentId>.jsonl` (NOT the `output_file` from the
   spawn result — that file stays empty while the agent runs). The UI's live agent view
   streams summarized tool calls from it via `/agentfeed/<id>`. Use forward slashes; never
   read the transcript yourself — it overflows your context; the server tails it for the UI.
4. **While the wave runs:** on each task notification, read the worker's structured result,
   post a 1-2 line ack to the board (type `msg`; use `@<agent-id>` when replying to a specific
   agent), remove it from `active`, rewrite state.json. Between notifications check section 3
   signals — read the new board tail (lines with `seq` above the last you processed).
5. **After the wave:** read all new wiki pages (Glob `RUN_DIR/wiki/**/*.md`) and the new board
   tail. Post a round summary (type `round`): achieved / failed / next.
6. Evaluate against `goal.md` success criteria → section 4.

## 3. Signals (check between notifications and at every loop point)
- `RUN_DIR/control/stop.flag` exists → graceful stop (section 5).
- `RUN_DIR/control/accept.flag` exists → finalize (section 6, status `accepted`).
- `RUN_DIR/control/agent-stop-<id>.flag` exists → the human stopped ONE agent from the UI:
  TaskStop that agent (its internal agentId is in the transcript filename,
  `agent-<agentId>.jsonl`), remove it from `state.json.active`, ack on the board
  (`@<id> stopped by HUMAN — task folds into the next wave`), then DELETE the flag file
  (consumed). The rest of the wave keeps running; replan the lost task next round unless
  the human's messages say to drop it.
- New `HUMAN` lines on the board → steering input: acknowledge on the board and fold into the
  next wave plan. Human instructions override your plan. Lines with `@judge` demand an answer.
- The user says stop in chat → same as stop.flag.
- `maxRounds` set AND `round >= maxRounds`, or `minutes` exceeded → stop with best-so-far
  (section 5; status `done` if criteria met, else `stopped`). With `maxRounds: null` there is
  no round ceiling — the run ends only on success, HUMAN stop/accept, or `minutes`.
- **Goal is immutable per run.** When HUMAN messages add scope beyond `goal.md`:
  small corrections inside the current criteria → fold in. A genuinely NEW capability or a
  change to the success criteria → do NOT mutate goal.md; propose on the board: close this
  run once its original criteria pass the critic gate, then start a fresh `/swarm` run for
  the new scope (it auto-seeds from this run's lessons). If the human insists on one run,
  they decide — note their override on the board.

## 4. Success gate
When YOU believe every success criterion is met by content in `artifacts/` (have a synthesizer
produce/refresh the candidate deliverable first if needed):
1. Spawn 2 critics in parallel (3 if the goal is high-stakes), prompt = `templates/critic.md`,
   `{{CANDIDATE}}` = path(s) to the deliverable. Critics run like workers (background, board,
   `critic-<N>` ids).
2. ALL critics PASS (no FATAL objections) → section 6 (status `done`).
3. Any FAIL → objections land in `wiki/failures/`; post a `round` line ("critics rejected:
   <objections>") and continue the loop — the next wave fixes them.
4. A candidate rejected twice on the SAME objection → change strategy explicitly (different
   roles/angle) and say so on the board.

## 5. Graceful stop (stop.flag / chat stop / limits)
1. TaskStop every running worker agent.
2. Post `final` to the board: status + best result so far + why stopped.
3. Set state.json status (`stopped`, or `done` when limits hit with criteria met).
4. Run the distiller (section 6 step 2) — failures are learning too.
5. Report in chat: outcome, board URL (server stays up), run dir.

## 6. Finalize (success or accept)
1. If the deliverable needs assembly, spawn one synthesizer to write the final artifact into
   `artifacts/` (file name fitting the goal, e.g. `final-report.md`).
2. Spawn the distiller: `templates/distiller.md`, `{{OUTCOME}}` = final status,
   `{{GLOBAL_WIKI}}` = the global wiki path. It writes ≤3 merged lessons into the global wiki.
3. Post `final` to the board (what was achieved, deliverable path in `refs`).
4. state.json → final status, `active":[]`.
5. Report in chat: deliverable path, board URL, 2-3 line summary. The server stays up for
   browsing and shuts itself down after ~60 min with no viewers once the run has a terminal
   status (`--idle-exit-min`, viewers = open board tabs); a `running` run whose state has not
   been updated for 24h with no viewers also self-terminates (`--stale-exit-hours`, orphan
   guard — `/swarm resume` brings everything back). No zombie processes, nothing to clean up
   manually. An ACTIVE overnight run never self-terminates: the judge updates state every
   round, so the orphan guard only fires when the judge is truly gone.

## 7. Resume (`/swarm resume <runId>`)
1. `RUN_DIR` = `<cwd>/docs/swarm/runs/<runId>`; if missing, list `docs/swarm/runs/` and ask.
2. Read `state.json`, `goal.md`, the board tail (~50 lines), wiki INDEX.
3. If `server.json`'s PID is dead or the port doesn't answer `GET /state`, restart the server
   (setup step 6) and give the user the URL.
4. Set status `running`, post `system` ("resumed at round N"), continue at section 2.

## 8. Init (`/swarm init`) — copy the skill into the current project
Purpose: a project-local fork the user can customize (own roles, edited templates, tweaked
server/UI) with full control over the flow. Directory-scoped skills win over the user-level
one, so after init this project runs its own copy.
1. Check `node --version` ≥ 20.11 — if missing/older, tell the user and stop.
2. `DEST` = `<cwd>/.claude/skills/swarm/`. If DEST already exists: read `DEST/SOURCE.md`,
   compare its commit hash with `git -C <skillDir> rev-parse HEAD`; report both versions and
   ask the user what to overwrite (engine files `server.mjs`/`ui.html` vs everything) before
   touching anything.
3. Copy from the skill directory into DEST: `SKILL.md`, `server.mjs`, `ui.html`,
   `templates/` (including `templates/roles/`), `test/`. Skip `docs/` and `.git`.
4. Write `DEST/SOURCE.md`: source path, `git -C <skillDir> rev-parse HEAD`, copy date, and
   the line "To update: run /swarm init again and choose what to overwrite."
5. Bootstrap the global wiki (setup step 5) so first runs seed properly.
6. Report: copy location, that this project now runs the local copy (delete the folder to go
   back to the global skill), and point at `templates/roles/` as the place to add custom
   agent roles (example included: `semantic-reviewer`; new ones are authored with the
   `/swarm-role` command).

## Codex CLI adapter (substitutions when running under Codex)
Codex has no background-subagent API, no mid-task message injection and no file watcher —
the loop becomes poll-driven. Substitute:
1. **Spawn workers** (§2.3): background `codex exec` child processes, one per worker:
   `codex exec --json --full-auto -C "<projectDir>" "<full worker prompt>" > "<RUN_DIR>/tr/<id>.jsonl" 2>> "<RUN_DIR>/tr/<id>.err" & echo $! > "<RUN_DIR>/tr/<id>.pid"`
   (create `RUN_DIR/tr/` at setup). The `--json` stdout stream IS the live transcript.
   **MANDATORY:** set `active[].transcript` to `<RUN_DIR>/tr/<id>.jsonl` (forward slashes)
   already at wave-plan registration — the path is known before the spawn, the server waits
   for the file to appear, and without it the board cannot show the agent's live view
   (clicking the card falls back to a plain feed filter).
2. **Wait for results** (§2.4): no notifications — poll every 30-60s: `kill -0 $(cat pid)`
   per worker (exit = done, read the tail of its jsonl for the final agent_message), plus
   board tail, plus control flags. `minutes`/round checks in the same loop.
3. **Live steering** (§1b): DOES NOT EXIST — no Monitor, no SendMessage. Do not promise
   mid-task pushes. Workers pick up HUMAN lines at their own board-polling checkpoints;
   urgent input folds into the next wave's prompts. Your poll loop is the judge-side reader.
4. **Stopping agents** (§3, §5): `kill -INT $(cat "<RUN_DIR>/tr/<id>.pid")` instead of TaskStop.
5. **Judge transcript** (§1.4): the newest `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
6. **Models**: `workers:` is a Codex model name (or omit for the session default); the
   global wiki path stays `~/.claude/swarm/wiki` — one shared memory across both harnesses.

## Updating this skill (only when the user explicitly asks)
Transparency rules first: update ONLY on the user's explicit request; before touching
anything, state what will be replaced and from where, and let the user confirm. Never
fetch or overwrite skill files silently. The installed skill directory is a plain copy,
NOT a git checkout — do not run git commands inside it.

Preferred path — the harness's own marketplace mechanism (auditable, user-consented):
- **Claude Code plugin install**: the user runs `/plugin marketplace update`, then
  reinstalls/updates the plugin from their marketplace listing.
- **Codex plugin install**: the user refreshes their marketplace and re-adds the plugin
  (`codex plugin marketplace update` / `codex plugin add <plugin>@<marketplace>`).
- **Script install**: update from the SAME repository the user originally installed from
  (their clone of the marketplace repo — check `SOURCE.md` or ask the user where that is;
  do not assume a URL): pull it and rerun its `install.sh` / `install.ps1`. The upstream
  project page is listed in the plugin manifest (`homepage`) for reference.
- **Project forks** (`.claude/skills/swarm` with `SOURCE.md`): run `/swarm-init` in that
  project — it compares versions and asks what to overwrite.

Do not restart a live run's board server mid-run for an update; new runs pick up the new
engine automatically.

## Judge conduct
- Every decision goes on the board BEFORE acting on it. The human must be able to follow the
  run from the board alone; keep chat to: the URL at start, blockers needing the human, and
  the final report.
- If you have not yet announced the board URL in chat, announce it NOW, before any other
  action — this is the single most common judge mistake.
- The board is a channel: agents address each other with `@<agent-id>`, you with `@judge`,
  everyone with `@all`. Answer what's addressed to you.
- Never exceed `wave` (hard cap 20); prefer small sharp waves over big vague ones.
- Workers that die or return null: note it on the board, fold their task into the next wave.
- If the server dies mid-run: restart it (setup step 6) — the board file is the source of
  truth and survives.
- Windows Glob gotcha: never combine the Glob tool's `path` param with a slash-containing
  pattern (e.g. `runs/*/goal.md`) — it silently returns "No files found" on real matches.
  Put the full forward-slash path into the pattern itself, or start the pattern with `**/`.
  Any empty search result that contradicts expectations must be cross-checked with `ls`
  before you claim absence.
