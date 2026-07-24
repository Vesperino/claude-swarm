# Swarm Board — UI redesign brief

Copy-paste this whole document as the prompt for a design tool / design-focused Claude.

---

## What you are designing

**Swarm Board** — a live operations console for a multi-agent AI swarm. A "judge" AI orchestrates
waves of worker/critic agents toward a goal; every agent narrates its work onto a shared
append-only board. A human watches everything live, writes messages to the swarm, opens any
agent's live activity stream, browses the swarm's wiki memory, and can stop or accept the run
at any moment. Think: mission control / air-traffic radar for AI agents — dense, calm,
legible, dark. The current build is functional but visually utilitarian; make it feel like a
deliberately designed operations console without sacrificing density or legibility.

## Hard technical constraints (non-negotiable)

- **One file: `ui.html`.** All CSS and JS inline. No external requests of any kind — no CDN,
  no webfonts via URL, no icon libraries. System fonts or embedded data-URI assets only.
- Vanilla HTML/CSS/JS. No frameworks, no build step. Served by a tiny localhost Node server.
- Data arrives via **SSE** (`EventSource`): `board` events (one JSON message each) and `state`
  events (run status). The page also fetches JSON from `/wikitree`, text from `/wiki/<scope>/<path>`,
  and per-agent SSE streams from `/agentfeed/<id>`. Buttons POST to `/post` and `/control`.
- Desktop-first (it runs on localhost next to an IDE); should degrade gracefully to ~1100px.
- Dark theme is the primary identity. A light theme is optional, not required.
- Deliverable: a **static HTML mock** (same single-file constraint) with realistic sample
  content. It will be merged back into the live page by an engineer (me), so keep the
  **JS contract** below intact.

## JS contract — keep these IDs/classes/attributes exactly

The behavior layer targets these selectors. Restyle freely; do not rename or restructure them away:

- Header: `#goal`, `#round`, `#status` (status also gets a class from:
  `running | done | accepted | stopped | failed`), `#filterPill` > `#filterName` + `#filterClear`
- Feed: `#feed` > `.entry` (attrs `data-role` = `judge|worker|critic|human|system`, `data-from`);
  inside: `.time`, `.from` (clickable), `.body` > `.type` (also gets class = message type:
  `msg|task|result|learning|round|system|final`), `.text`, `.refchip[data-ref]` (clickable chips)
- Sidebar: `#agents` > `.agent[data-id]` (clickable; contains `b` = id, `.role`, model badge, `.task`),
  `#tree` > `.grp` group labels, `a[data-scope][data-file]` file links, `.empty` placeholder
- Slide-over panel: `#viewer` (+ `.open`), `.vhead` (sticky), `#vpath`, `#vclose`, `#vbody`;
  agent live stream inside: `#agstream` > `.act` rows with kind classes `tool|text|result|info`
- Composer: `#msg` input, `#send`, `#stopBtn`, `#acceptBtn`, `#mention` (autocomplete dropdown,
  children `[data-m]`)
- Wiki links in rendered markdown: `.wikilink[data-wl]`

## Current information architecture (keep the bones)

CSS grid, 3 rows × 2 cols: sticky header spans full width · main = live feed (left, flexible)
+ sidebar (right, ~300px) · footer composer spans full width. `#viewer` is a right slide-over
(~680px) used for two things: rendered wiki/markdown files, and an agent's live activity stream.

## Content & states the design must handle

- **Feed entry**: time (HH:MM:SS), sender, type tag, multi-line text (often long, technical,
  contains `@mentions`, `[[wiki-links]]`, inline `code`), 0..n file-reference chips. Senders are
  color-coded by role: judge (amber-ish), worker (blue-ish), critic (red/magenta-ish), human
  (green-ish, visually distinct row), system (muted). Hundreds of rows; auto-scroll pinned to
  bottom unless the user scrolled up.
- **Header**: goal (one line, truncates), round pill `round 2/8`, status pill with live states
  (`running` pulses subtly; `done`, `accepted`, `stopped`, `failed`), optional filter pill.
- **Agent card**: id, role, model badge (`sonnet`/`opus`/`haiku`/`fable`/`inherit`), one-line task,
  hover affordance ("click → live view"). Empty state: "no active agents".
- **Wiki tree**: three labelled groups (run wiki / artifacts / global wiki), file links with
  path-like names, empty-state line per group.
- **Slide-over, mode A (document)**: rendered markdown (h1-h3, paragraphs, lists, code blocks,
  wiki-links) — must be pleasant to read.
- **Slide-over, mode B (agent live stream)**: sticky header with `id · role · model` + close;
  the agent's task as a subtitle; then a fast-scrolling stream of small rows:
  `tool` rows (tool name + one-line detail), `says` rows (agent narration), `result` rows
  (muted tool output), `info` rows (final result, warnings). Must stay legible while appending
  ~1 row/second.
- **Composer**: text input with `@` autocomplete dropdown (dark popover, keyboard-friendly),
  Post button, and two destructive-ish controls: STOP (red identity) and ACCEPT (green/amber
  identity) — visually weighty, guarded by confirm dialogs, disabled once the run ends.
- **Confirm patterns** for STOP/ACCEPT; a "state error" status exists when the server sends
  a broken state file.

## Design direction (wants, not constraints)

- Terminal/mission-control aesthetic done deliberately: monospace for data (feed, cards,
  streams), a humanist sans for chrome; a restrained accent system derived from the role
  colors; consistent radii and spacing rhythm; subtle depth (no heavy glassmorphism).
- Respect `prefers-reduced-motion`; any pulse/stream animation must be subtle and disableable.
- Density is a feature: the feed is the hero, sidebar is glanceable, nothing decorative steals
  vertical space. Avoid generic "AI dashboard" tropes (purple gradients, emoji section headers,
  rounded-card soup).
- Accessibility: visible keyboard focus everywhere, WCAG AA contrast on all text, role colors
  never the only signal (keep the type tags / labels).

## Sample data for the mock

Use realistic content: a goal like "Produce a one-page brief comparing 3 approaches to
zero-dependency HTTP routing in Node, with a recommendation"; agents `w1-researcher`,
`w2-analyst`, `w3-synthesizer`, `critic-1`; a HUMAN line like "@all Jaki macie cel?"; judge
round-plan posts; a `learning` entry; file chips like `wiki/findings/urlpattern-routing.md`,
`artifacts/final-report.md`.
