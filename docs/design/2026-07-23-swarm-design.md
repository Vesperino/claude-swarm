# Swarm Skill — Design Spec

**Date:** 2026-07-23
**Status:** Draft for review
**Language policy:** The entire tool (SKILL.md, server, UI, prompt templates, wiki files) is written in English. The judge replies to the human in the human's language.

## 1. What it is

`/swarm <goal>` — a user-level Claude Code skill that turns the current session into a **judge** orchestrating waves of parallel worker agents (research / code / analysis) until the goal is reached, a limit is hit, or the human stops it.

Core properties:

- **Live board** — a local web UI (URL printed in chat) where the human watches all agent-to-agent communication in real time, can write messages onto the board, and can press **STOP** or **ACCEPT**.
- **Shared memory (llm-wiki)** — every run has a wiki folder agents must read before working and must extend with findings/failures before finishing. Lessons are distilled into a global wiki so future runs start smarter.
- **Auto-improvement loop** — each wave is planned from the previous wave's results, wiki failures, critic objections, and human board messages.
- **Success gate** — judge proposes success only when a wave of adversarial critics fails to refute the result; the human can also accept early via the UI.

## 2. Components & file layout

```
C:\Users\Arek\.claude\skills\swarm\        <- the skill (user-level, git-versioned)
  SKILL.md            judge instructions (the session that invokes the skill becomes the judge)
  server.mjs          board server - Node, zero dependencies
  ui.html             board UI served by server.mjs
  templates\
    worker.md         worker prompt template
    critic.md         adversarial critic prompt template
    distiller.md      end-of-run lesson distiller template
  docs\               this spec + future docs

<project>\docs\swarm\                      <- run data, inside the project where /swarm was invoked
  runs\<yyyy-mm-dd>-<slug>\   one run = one goal; knowledge isolated per run
    goal.md            goal, success criteria, limits, model config
    board.jsonl        append-only message log (the board)
    state.json         round number, status, agent counters
    wiki\              run memory: INDEX.md, findings\, failures\, approaches\, decisions.md
    artifacts\         working outputs + final deliverable
    control\           stop.flag / accept.flag (written by UI buttons)

C:\Users\Arek\.claude\swarm\wiki\          <- global llm-wiki: ONLY distilled lessons, never raw run data
  INDEX.md
  lessons\*.md
```

Run data is plain files in the project — the human can commit or `.gitignore` `docs/swarm/` as they prefer. Raw knowledge never mixes between runs; only the end-of-run distiller promotes 1-3 generalizable lessons to the global wiki.

## 3. Invocation

```
/swarm <goal in natural language> [workers:opus] [rounds:8] [wave:4] [minutes:120]
```

- **Judge model** = the current session's model (run the session on Fable to get a Fable judge).
- **Worker model** = `workers:` option, passed per-agent via the Agent tool (`opus` / `sonnet` / `haiku` / `fable`). Judge may override per worker when a cheap role (e.g. a formatting pass) deserves `haiku`.
- **Limits** = `rounds` (default 8) × `wave` (default 4, configurable up to **20 parallel agents per round**). This is the real cost limit; the session has no precise token meter, so we do not pretend to have one. Optional `minutes:` wall-clock limit. The harness may queue some of a large wave — all still run, just not all simultaneously.
- `/swarm resume <runId>` — reattach to a persisted run: judge reads `state.json` + board tail and continues.
- **Working directory** — workers inherit the project cwd where `/swarm` was invoked (code tasks act on that project); run data is created under `<project>/docs/swarm/runs/`.

## 4. The board (server + UI)

Node single-file server, binds `127.0.0.1` only, port 4780 (busy → try next). Endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /` | board UI (`ui.html`) |
| `GET /events` | SSE — live stream of `board.jsonl` lines + `state.json` changes |
| `POST /post` | append a message line to `board.jsonl` (server is the single writer → no interleaving races between parallel agents) |
| `POST /control` | `{action: stop\|accept}` → creates `control/<action>.flag` + posts a system line to the board |
| `GET /state` | current `state.json` |
| `GET /wiki/*` | serves run-wiki and global-wiki files (client-side markdown render) |

Message line schema:

```json
{"ts": "...", "seq": 42, "from": "w3-researcher", "role": "worker|judge|critic|human|system",
 "type": "msg|task|result|learning|round|system|final", "text": "...", "refs": ["wiki/findings/x.md"]}
```

UI (dark theme): header (goal, round, status, active agent count) · live feed colored per role · sidebar (active agents, wiki tree with file preview) · footer: text input to **post to the board as HUMAN** + red **STOP** + green **ACCEPT**.

How agents post: `curl POST` from the Bash tool (Git Bash — avoids PowerShell quoting hell). Fallback if the server is down: direct append to `board.jsonl` — after restart the server streams from the file anyway.

## 5. Judge loop

```
Setup:  create run folder -> goal.md -> start server (background) -> print URL in chat
        -> read global wiki INDEX -> seed run wiki with relevant lessons
Round:  1. Plan the wave: N workers (default 4, up to the wave: cap, max 20), roles chosen per goal:
           researcher / analyst / coder / tester / synthesizer
        2. Spawn all in parallel (Agent tool, background, model per config)
        3. Each worker: reads wiki INDEX -> works -> posts to board
           (start / key findings / result / learning) -> writes wiki pages
        4. Wave done: judge reads results + new wiki pages, posts a round summary,
           updates state.json
        5. Checks: stop.flag -> graceful stop | accept.flag -> finalize
           | HUMAN board messages -> feed into next plan
           | round/time limit -> stop with best-so-far
        6. Success candidate? -> critic wave (2-3, adversarial: try to refute)
           -> no fatal objections -> DONE
           -> objections -> written to failures\ -> next round fixes them
End:    synthesizer -> final deliverable in artifacts\
        -> distiller -> 1-3 lessons into the global wiki (merged with similar
           existing lessons - anti-bloat rule)
        -> report in chat; server stays up for browsing the finished run
```

Stop works from two places: the UI button **or** a chat message — both take the graceful path: `TaskStop` on running agents, final board post, lesson distillation even on abort (failures are learning too).

## 6. Worker protocol (prompt template contract)

Every worker receives: the goal + its role and task + paths (run wiki, board URL) + this contract:

1. **First** read `wiki\INDEX.md` and pages relevant to your task (especially `failures\`) — do not repeat others' mistakes.
2. Post to the board: start, key findings, final result.
3. Before finishing: add a wiki page (finding/failure/approach), update INDEX, link with `[[name]]`.
4. Final output = structured: what was achieved, what failed and why, recommendation for the next wave.

## 7. Memory (llm-wiki)

- **Run wiki** — `INDEX.md` is the map (one line per page + status). Pages: `findings/` (facts + sources), `failures/` (what failed and why — the fuel of auto-improvement), `approaches/` (tried/planned, outcome), `decisions.md` (judge log). `[[name]]` linking convention.
- **Global wiki** — `lessons/*.md`: distilled, cross-project patterns with a link back to the evidence run. The distiller must merge into an existing similar lesson instead of creating near-duplicates.

## 8. Error handling

| Failure | Behavior |
|---|---|
| Port busy | try next port |
| Worker dies / returns null | judge notes it on the board, replans next round |
| Server dies | agents fall back to direct file append; judge restarts server |
| Session dies mid-run | run folder is persistent; `/swarm resume <runId>` continues |

## 9. Security

Server binds to localhost only, no auth (local machine trust). The board UI can post messages and flags — acceptable for a personal tool.

## 10. Verification plan

- Server tested standalone with curl (post → SSE echo, control → flag file).
- Smoke test: `/swarm` with a trivial research goal (`rounds:1 wave:2`) — verify: URL live, messages flow, STOP works, wiki pages appear, lesson lands in the global wiki.

## 11. Out of scope (v1)

- Precise token budgeting (no session-level meter exists).
- Remote/cloud board access (localhost only).
- Workflow-tool orchestration (may return later as a judge sub-tool for huge fan-outs).
- Multi-run concurrency on one board (one server per run, distinct ports).
