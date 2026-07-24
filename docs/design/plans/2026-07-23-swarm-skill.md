# Swarm Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/swarm` user-level Claude Code skill: a judge-led multi-agent swarm with a live localhost board UI (SSE), per-run llm-wiki memory in the project, global distilled-lesson wiki, and human STOP/ACCEPT controls.

**Architecture:** The invoking session becomes the judge (per spec `docs/2026-07-23-swarm-design.md`). A zero-dependency Node server (`server.mjs`) owns `board.jsonl` writes and streams them to `ui.html` via SSE. Workers are spawned with the Agent tool and talk to the board with `curl`. Prompt templates define worker/critic/distiller contracts. `SKILL.md` is the judge's program.

**Tech Stack:** Node ≥ 20.11 (machine has v24.13.1), `node:test` for server tests, vanilla HTML/CSS/JS for UI, Playwright MCP for UI verification, Git Bash for agent-side `curl`.

## Global Constraints

- **Zero npm dependencies.** No `package.json`, no `node_modules`. Node built-ins only.
- **Everything in English** — code, comments, UI copy, templates, SKILL.md.
- Server binds **`127.0.0.1` only**. Default port **4780**, on `EADDRINUSE` try next, up to 20 tries. `--port 0` = OS-assigned (for tests).
- **Run data lives in the project:** `<project>/docs/swarm/runs/<yyyy-mm-dd>-<slug>/`. **Global wiki:** `C:\Users\Arek\.claude\swarm\wiki\` — distilled lessons only.
- Limits: `rounds` default 8; `wave` default 4, **max 20**; optional `minutes`.
- Board roles enum: `judge | worker | critic | human | system`. Types enum: `msg | task | result | learning | round | system | final`. Everything (server, UI, templates, SKILL.md) uses exactly these.
- Repo = `C:\Users\Arek\.claude\skills\swarm\` (already git-initialized). Commit after every task. Windows: run git/node commands via the Bash tool (Git Bash).
- `state.json` is always written as **single-line JSON** (SSE frames are line-based).

## File Structure

```
C:\Users\Arek\.claude\skills\swarm\
  SKILL.md                Task 6 — judge program + frontmatter
  server.mjs              Tasks 1-3 — board server
  ui.html                 Task 1 placeholder, Task 4 full UI
  templates\worker.md     Task 5
  templates\critic.md     Task 5
  templates\distiller.md  Task 5
  test\server.test.mjs    Tasks 1-3
  docs\                   spec + this plan
```

Interfaces the whole system shares (defined once here, used verbatim everywhere):

- **Board line:** `{"seq":N,"ts":"ISO","from":"w1-researcher","role":"worker","type":"msg","text":"...","refs":["wiki/findings/x.md"]}`. `refs` are run-relative; global-wiki refs use prefix `global:lessons/x.md`.
- **`state.json`:** `{"goal":str,"runId":str,"projectDir":str,"status":"running|stopped|accepted|done|failed","round":N,"maxRounds":N,"wave":N,"workersModel":str,"minutes":N|null,"active":[{"id":str,"role":str,"task":str,"since":ISO}],"startedAt":ISO,"updatedAt":ISO}`
- **`server.json`** (written by server on listen): `{"port":N,"pid":N,"startedAt":ISO}`
- **HTTP API:** `GET /` (UI) · `GET /events` (SSE: `board` + `state` events) · `GET /state` · `GET /wikitree` → `{"run":[relpaths],"global":[relpaths]}` · `GET /wiki/run/<rel>` · `GET /wiki/global/<rel>` · `POST /post` `{from,role,type,text,refs?}` → `{ok,seq}` · `POST /control` `{action:"stop"|"accept"}` → `{ok:true}` + writes `control/<action>.flag`

---

### Task 1: Server core (static, /post, /state, /control, port retry)

**Files:**
- Create: `C:\Users\Arek\.claude\skills\swarm\server.mjs`
- Create: `C:\Users\Arek\.claude\skills\swarm\ui.html` (placeholder; replaced in Task 4)
- Test: `C:\Users\Arek\.claude\skills\swarm\test\server.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: the HTTP API endpoints `GET /`, `GET /state`, `POST /post`, `POST /control`; `postLine(entry)` and `json(res,code,obj)` and `readBody(req)` internals reused by Tasks 2-3; `server.json` contract; `SWARM_BOARD_URL=<url>` stdout line.

- [ ] **Step 1: Write failing tests**

Create `test\server.test.mjs`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SERVER = path.join(import.meta.dirname, '..', 'server.mjs');
let proc, base, runDir, globalWiki;

before(async () => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'));
  globalWiki = path.join(runDir, 'gwiki');
  proc = spawn(process.execPath, [SERVER, '--run', runDir, '--port', '0', '--global-wiki', globalWiki]);
  base = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => {
      out += d;
      const m = out.match(/SWARM_BOARD_URL=(\S+)/);
      if (m) resolve(m[1]);
    });
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('exit', c => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('timeout waiting for SWARM_BOARD_URL')), 5000);
  });
});
after(() => proc.kill());

test('GET / serves the UI', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Swarm/);
});

test('server.json written with real port', () => {
  const sj = JSON.parse(fs.readFileSync(path.join(runDir, 'server.json'), 'utf8'));
  assert.equal(typeof sj.port, 'number');
  assert.ok(sj.port > 0);
  assert.equal(typeof sj.pid, 'number');
});

test('POST /post appends a board line with seq and ts', async () => {
  const r = await fetch(base + '/post', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'w1-researcher', role: 'worker', type: 'msg', text: 'hello board' }),
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(typeof j.seq, 'number');
  const lines = fs.readFileSync(path.join(runDir, 'board.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.from, 'w1-researcher');
  assert.equal(last.text, 'hello board');
  assert.equal(last.seq, j.seq);
  assert.match(last.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('POST /post rejects missing text', async () => {
  const r = await fetch(base + '/post', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'x' }),
  });
  assert.equal(r.status, 400);
});

test('GET /state roundtrips state.json', async () => {
  fs.writeFileSync(path.join(runDir, 'state.json'),
    JSON.stringify({ goal: 'test goal', status: 'running', round: 1 }));
  const r = await fetch(base + '/state');
  const j = await r.json();
  assert.equal(j.goal, 'test goal');
});

test('POST /control writes flag and posts system line', async () => {
  const r = await fetch(base + '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'accept' }),
  });
  assert.equal((await r.json()).ok, true);
  assert.ok(fs.existsSync(path.join(runDir, 'control', 'accept.flag')));
  const lines = fs.readFileSync(path.join(runDir, 'board.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.role, 'human');
  assert.match(last.text, /ACCEPT/);
});

test('POST /control rejects unknown action', async () => {
  const r = await fetch(base + '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'explode' }),
  });
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/Users/Arek/.claude/skills/swarm && node --test test/`
Expected: FAIL — `Cannot find module ... server.mjs` (server does not exist yet).

- [ ] **Step 3: Write placeholder `ui.html`**

```html
<!-- Placeholder - full UI arrives in Task 4 -->
<title>Swarm Board</title>
<p>Swarm Board UI placeholder.</p>
```

- [ ] **Step 4: Write `server.mjs`**

```js
#!/usr/bin/env node
// Swarm board server - zero dependencies. Node >= 20.11.
// Owns all writes to board.jsonl so parallel agents never interleave.
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}

const RUN_DIR = path.resolve(arg('run', '.'));
const BASE_PORT = Number(arg('port', '4780'));
const GLOBAL_WIKI = path.resolve(arg('global-wiki', path.join(
  process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'swarm', 'wiki')));

const BOARD = path.join(RUN_DIR, 'board.jsonl');
const STATE = path.join(RUN_DIR, 'state.json');
const CONTROL = path.join(RUN_DIR, 'control');
const RUN_WIKI = path.join(RUN_DIR, 'wiki');
fs.mkdirSync(CONTROL, { recursive: true });
fs.mkdirSync(RUN_WIKI, { recursive: true });
if (!fs.existsSync(BOARD)) fs.writeFileSync(BOARD, '');

// seq continues from whatever is already on the board (resume case).
// Fallback direct appends may carry no seq; collisions are display-only.
let seq = 0;
for (const l of fs.readFileSync(BOARD, 'utf8').split('\n')) {
  if (!l) continue;
  try { const j = JSON.parse(l); if (j.seq > seq) seq = j.seq; } catch {}
}

function postLine(entry) {
  seq += 1;
  const line = JSON.stringify({ seq, ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(BOARD, line + '\n');
  return seq;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => resolve(b));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(HERE, 'ui.html')));
    } else if (req.method === 'GET' && p === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.existsSync(STATE) ? fs.readFileSync(STATE) : '{}');
    } else if (req.method === 'POST' && p === '/post') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      if (!body.from || !body.text) return json(res, 400, { ok: false, error: 'from and text required' });
      const s = postLine({
        from: String(body.from),
        role: String(body.role || 'worker'),
        type: String(body.type || 'msg'),
        text: String(body.text),
        refs: Array.isArray(body.refs) ? body.refs.map(String) : [],
      });
      json(res, 200, { ok: true, seq: s });
    } else if (req.method === 'POST' && p === '/control') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      if (!['stop', 'accept'].includes(body.action)) {
        return json(res, 400, { ok: false, error: 'action must be stop|accept' });
      }
      fs.writeFileSync(path.join(CONTROL, body.action + '.flag'), new Date().toISOString());
      postLine({ from: 'HUMAN', role: 'human', type: 'system',
        text: 'HUMAN pressed ' + body.action.toUpperCase(), refs: [] });
      json(res, 200, { ok: true });
    } else {
      json(res, 404, { ok: false, error: 'not found' });
    }
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

function listen(port, tries) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1);
    else { console.error('listen failed: ' + err.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    fs.writeFileSync(path.join(RUN_DIR, 'server.json'),
      JSON.stringify({ port: actual, pid: process.pid, startedAt: new Date().toISOString() }));
    console.log('SWARM_BOARD_URL=http://127.0.0.1:' + actual);
  });
}
listen(BASE_PORT, 20);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /c/Users/Arek/.claude/skills/swarm && node --test test/`
Expected: all Task 1 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/Arek/.claude/skills/swarm && git add -A && git commit -m "feat: board server core (post/state/control, port retry)"
```

---

### Task 2: SSE `/events` + board tail poller

**Files:**
- Modify: `C:\Users\Arek\.claude\skills\swarm\server.mjs`
- Test: `C:\Users\Arek\.claude\skills\swarm\test\server.test.mjs` (append tests)

**Interfaces:**
- Consumes: Task 1 internals (`BOARD`, `STATE`, `json`).
- Produces: `GET /events` — SSE stream. On connect: replays last 1000 board lines as `board` events, then current state as one `state` event, then live. The **poller is the only broadcaster** (single code path; picks up both server writes and direct-file-append fallback writes, ≤500 ms latency). `state` events fire on `state.json` mtime change.

- [ ] **Step 1: Append failing tests**

Append to `test\server.test.mjs`:

```js
// Reads an SSE stream until predicate(fullText) is true or timeout.
async function sseWait(url, predicate, ms = 4000) {
  const ctrl = new AbortController();
  const r = await fetch(url, { signal: ctrl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const t = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise(res => setTimeout(() => res({ done: false, value: null }), t)),
      ]);
      if (chunk.value) text += dec.decode(chunk.value, { stream: true });
      if (predicate(text)) return text;
      if (chunk.done) break;
    }
    throw new Error('sseWait timeout; got: ' + text.slice(-500));
  } finally { ctrl.abort(); }
}

test('SSE replays existing lines and streams new POSTs', async () => {
  const marker = 'sse-live-' + Date.now();
  const waiter = sseWait(base + '/events', t => t.includes(marker));
  await new Promise(r => setTimeout(r, 300)); // let the stream connect
  await fetch(base + '/post', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'judge', role: 'judge', type: 'msg', text: marker }),
  });
  const text = await waiter;
  assert.match(text, /event: board/);
  assert.ok(text.includes('hello board'), 'replay of earlier lines');
  assert.ok(text.includes(marker), 'live line arrived');
});

test('SSE picks up direct file appends (fallback path)', async () => {
  const marker = 'direct-append-' + Date.now();
  const waiter = sseWait(base + '/events', t => t.includes(marker));
  await new Promise(r => setTimeout(r, 300));
  fs.appendFileSync(path.join(runDir, 'board.jsonl'),
    JSON.stringify({ from: 'w9-coder', role: 'worker', type: 'msg', text: marker }) + '\n');
  const text = await waiter;
  assert.ok(text.includes(marker));
});

test('SSE emits state events on state.json change', async () => {
  const waiter = sseWait(base + '/events', t => t.includes('round-marker-7'));
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync(path.join(runDir, 'state.json'),
    JSON.stringify({ goal: 'round-marker-7', status: 'running', round: 7 }));
  const text = await waiter;
  assert.match(text, /event: state/);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd /c/Users/Arek/.claude/skills/swarm && node --test test/`
Expected: Task 1 tests PASS; the three new tests FAIL (404 on `/events`).

- [ ] **Step 3: Implement SSE + poller**

In `server.mjs`, add after the `seq` initialization block:

```js
let boardOffset = fs.statSync(BOARD).size;
let stateMtime = 0;
const clients = new Set();

function broadcast(event, data) {
  // SSE frames are line-based; state.json is single-line by contract,
  // but flatten defensively (JSON newlines only occur outside strings).
  const msg = 'event: ' + event + '\ndata: ' + data.replace(/\r?\n/g, ' ') + '\n\n';
  for (const res of clients) res.write(msg);
}

// Single broadcaster: tails board.jsonl so server writes and direct
// file-append fallbacks flow through one code path.
setInterval(() => {
  try {
    const size = fs.statSync(BOARD).size;
    if (size > boardOffset) {
      const fd = fs.openSync(BOARD, 'r');
      const buf = Buffer.alloc(size - boardOffset);
      fs.readSync(fd, buf, 0, buf.length, boardOffset);
      fs.closeSync(fd);
      boardOffset = size;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (j.seq > seq) seq = j.seq; } catch {}
        broadcast('board', line);
      }
    }
    const st = fs.statSync(STATE, { throwIfNoEntry: false });
    if (st && st.mtimeMs !== stateMtime) {
      stateMtime = st.mtimeMs;
      broadcast('state', fs.readFileSync(STATE, 'utf8'));
    }
  } catch {}
}, 500);
```

Add the `/events` route inside the request handler, before the 404 fallthrough:

```js
    } else if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      const lines = fs.readFileSync(BOARD, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines.slice(-1000)) {
        res.write('event: board\ndata: ' + line + '\n\n');
      }
      if (fs.existsSync(STATE)) {
        res.write('event: state\ndata: ' + fs.readFileSync(STATE, 'utf8').replace(/\r?\n/g, ' ') + '\n\n');
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/Users/Arek/.claude/skills/swarm && node --test test/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Arek/.claude/skills/swarm && git add -A && git commit -m "feat: SSE /events with single-broadcaster board tail poller"
```

---

### Task 3: Wiki endpoints (`/wikitree`, `/wiki/run/*`, `/wiki/global/*`)

**Files:**
- Modify: `C:\Users\Arek\.claude\skills\swarm\server.mjs`
- Test: `C:\Users\Arek\.claude\skills\swarm\test\server.test.mjs` (append tests)

**Interfaces:**
- Consumes: Task 1 internals (`RUN_WIKI`, `GLOBAL_WIKI`, `json`).
- Produces: `GET /wikitree` → `{"run":["INDEX.md","findings/x.md"],"global":["lessons/y.md"]}` (forward-slash relpaths, recursive). `GET /wiki/run/<rel>` and `GET /wiki/global/<rel>` → file content as `text/plain; charset=utf-8`; traversal outside the base → 404.

- [ ] **Step 1: Append failing tests**

```js
test('wikitree lists run and global wiki files recursively', async () => {
  fs.mkdirSync(path.join(runDir, 'wiki', 'findings'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'wiki', 'INDEX.md'), '# Index\n');
  fs.writeFileSync(path.join(runDir, 'wiki', 'findings', 'alpha.md'), '# Alpha finding\n');
  fs.mkdirSync(path.join(globalWiki, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(globalWiki, 'lessons', 'beta.md'), '# Beta lesson\n');
  const j = await (await fetch(base + '/wikitree')).json();
  assert.ok(j.run.includes('INDEX.md'));
  assert.ok(j.run.includes('findings/alpha.md'));
  assert.ok(j.global.includes('lessons/beta.md'));
});

test('wiki file content is served', async () => {
  const r = await fetch(base + '/wiki/run/findings/alpha.md');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Alpha finding/);
  const g = await fetch(base + '/wiki/global/lessons/beta.md');
  assert.match(await g.text(), /Beta lesson/);
});

test('wiki path traversal is blocked', async () => {
  const r = await fetch(base + '/wiki/run/..%2F..%2Fstate.json');
  assert.equal(r.status, 404);
  const r2 = await fetch(base + '/wiki/run/' + encodeURIComponent('..\\..\\state.json'));
  assert.equal(r2.status, 404);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd /c/Users/Arek/.claude/skills/swarm && node --test test/`
Expected: new tests FAIL with 404 on `/wikitree` (route missing).

- [ ] **Step 3: Implement**

Add helpers near `readBody`:

```js
function safeJoin(base, rel) {
  const p = path.resolve(base, rel.replaceAll('\\', '/'));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function listFiles(base, prefix = '') {
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(base, e.name), rel));
    else out.push(rel);
  }
  return out;
}
```

Add routes before the 404 fallthrough:

```js
    } else if (req.method === 'GET' && p === '/wikitree') {
      json(res, 200, { run: listFiles(RUN_WIKI), global: listFiles(GLOBAL_WIKI) });
    } else if (req.method === 'GET' && (p.startsWith('/wiki/run/') || p.startsWith('/wiki/global/'))) {
      const isRun = p.startsWith('/wiki/run/');
      const rel = p.slice(isRun ? '/wiki/run/'.length : '/wiki/global/'.length);
      const full = safeJoin(isRun ? RUN_WIKI : GLOBAL_WIKI, rel);
      if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        return json(res, 404, { ok: false, error: 'not found' });
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(fs.readFileSync(full));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/Users/Arek/.claude/skills/swarm && node --test test/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Arek/.claude/skills/swarm && git add -A && git commit -m "feat: wiki tree and file endpoints with traversal guard"
```

---

### Task 4: Board UI (`ui.html`)

**Files:**
- Rewrite: `C:\Users\Arek\.claude\skills\swarm\ui.html`

**Interfaces:**
- Consumes: entire HTTP API from Tasks 1-3 (enums and shapes from File Structure section).
- Produces: the human-facing board. No new API.

**Design tokens (dark, terminal-board aesthetic — this is a live operations console for agent chatter, monospace feed is the subject-appropriate choice):**
- bg `#14161a`, panel `#1c1f26`, border `#2a2e37`, text `#d6dae3`, dim `#8a91a0`
- roles: judge `#e8b34a`, worker `#5aa9e6`, critic `#e0596e`, human `#6dc98f`, system `#8a91a0`
- status pills: running `#6dc98f`, done `#5aa9e6`, stopped/failed `#e0596e`, accepted `#e8b34a`
- Chrome font: `system-ui`; feed/data font: `ui-monospace, Consolas, monospace`. Single-theme dark by choice (local ops console), no `prefers-color-scheme` needed.

**Layout:** CSS grid, 3 rows × 2 cols: header spans both cols; main = feed (left, flexible) + sidebar (right, 300px: state panel, active agents, wiki tree/viewer); footer spans both (HUMAN input + STOP + ACCEPT).

- [ ] **Step 1: Write `ui.html`**

Full file (single file, no external requests):

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm Board</title>
<style>
  :root {
    --bg:#14161a; --panel:#1c1f26; --border:#2a2e37; --text:#d6dae3; --dim:#8a91a0;
    --judge:#e8b34a; --worker:#5aa9e6; --critic:#e0596e; --human:#6dc98f; --system:#8a91a0;
    --ok:#6dc98f; --warn:#e8b34a; --bad:#e0596e; --info:#5aa9e6;
    --mono:ui-monospace,Consolas,monospace;
  }
  * { box-sizing:border-box; margin:0; }
  html,body { height:100%; }
  body {
    background:var(--bg); color:var(--text); font:14px/1.5 system-ui,sans-serif;
    display:grid; grid-template-rows:auto 1fr auto; grid-template-columns:1fr 300px;
    grid-template-areas:"header header" "feed side" "footer footer"; height:100vh;
  }
  header { grid-area:header; display:flex; align-items:center; gap:12px;
    padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--border); }
  header h1 { font-size:15px; font-weight:600; white-space:nowrap; }
  #goal { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .pill { font:12px var(--mono); padding:2px 10px; border-radius:999px;
    border:1px solid var(--border); white-space:nowrap; }
  #status.running { color:var(--ok); border-color:var(--ok); }
  #status.done { color:var(--info); border-color:var(--info); }
  #status.accepted { color:var(--warn); border-color:var(--warn); }
  #status.stopped, #status.failed { color:var(--bad); border-color:var(--bad); }
  #feed { grid-area:feed; overflow-y:auto; padding:12px 16px; font-family:var(--mono); font-size:13px; }
  .entry { display:grid; grid-template-columns:64px 150px 1fr; gap:10px;
    padding:6px 8px; border-left:3px solid var(--border); margin-bottom:4px; border-radius:0 6px 6px 0; }
  .entry:hover { background:var(--panel); }
  .entry[data-role=judge]  { border-left-color:var(--judge); }
  .entry[data-role=worker] { border-left-color:var(--worker); }
  .entry[data-role=critic] { border-left-color:var(--critic); }
  .entry[data-role=human]  { border-left-color:var(--human); background:#1a2420; }
  .entry[data-role=system] { border-left-color:var(--system); opacity:.8; }
  .entry .time { color:var(--dim); }
  .entry .from { font-weight:600; overflow:hidden; text-overflow:ellipsis; }
  .entry[data-role=judge]  .from { color:var(--judge); }
  .entry[data-role=worker] .from { color:var(--worker); }
  .entry[data-role=critic] .from { color:var(--critic); }
  .entry[data-role=human]  .from { color:var(--human); }
  .entry .body { min-width:0; }
  .entry .text { white-space:pre-wrap; word-break:break-word; }
  .entry .type { display:inline-block; font-size:11px; color:var(--dim); margin-right:6px;
    border:1px solid var(--border); border-radius:4px; padding:0 5px; vertical-align:1px; }
  .entry .type.round, .entry .type.final { color:var(--warn); border-color:var(--warn); }
  .entry .type.learning { color:var(--human); border-color:var(--human); }
  .refchip { display:inline-block; font-size:11px; color:var(--info); cursor:pointer;
    border:1px solid var(--border); border-radius:4px; padding:0 6px; margin:3px 6px 0 0; }
  .refchip:hover { border-color:var(--info); }
  code { background:#262b34; border-radius:4px; padding:0 4px; }
  aside { grid-area:side; background:var(--panel); border-left:1px solid var(--border);
    overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:14px; }
  aside h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin-bottom:6px; }
  #agents .agent { font:12px var(--mono); padding:4px 6px; border-radius:6px; margin-bottom:3px; background:#20242c; }
  #agents .agent .role { color:var(--worker); }
  #agents .agent .task { color:var(--dim); display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #tree a { display:block; font:12px var(--mono); color:var(--text); text-decoration:none;
    padding:2px 6px; border-radius:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #tree a:hover { background:#262b34; color:var(--info); }
  #tree .grp { color:var(--dim); font-size:11px; margin:6px 0 2px; }
  #viewer { position:fixed; inset:0 0 0 auto; width:min(680px,90vw); background:var(--panel);
    border-left:1px solid var(--border); box-shadow:-12px 0 40px #000a; padding:16px 20px;
    overflow-y:auto; display:none; z-index:10; }
  #viewer.open { display:block; }
  #viewer .vhead { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  #viewer .vhead code { font-size:12px; }
  #viewer button { background:none; border:1px solid var(--border); color:var(--text);
    border-radius:6px; padding:2px 10px; cursor:pointer; }
  #vbody { font-size:14px; } #vbody h1,#vbody h2,#vbody h3 { margin:14px 0 6px; }
  #vbody p,#vbody ul,#vbody pre { margin:8px 0; } #vbody li { margin-left:20px; }
  #vbody pre { background:#12151a; padding:10px; border-radius:8px; overflow-x:auto; font-family:var(--mono); font-size:12px; }
  #vbody .wikilink { color:var(--info); cursor:pointer; text-decoration:underline dotted; }
  footer { grid-area:footer; display:flex; gap:10px; padding:10px 16px;
    background:var(--panel); border-top:1px solid var(--border); }
  #msg { flex:1; background:var(--bg); border:1px solid var(--border); border-radius:8px;
    color:var(--text); padding:8px 12px; font:13px var(--mono); }
  #msg:focus { outline:1px solid var(--human); }
  footer button { border:none; border-radius:8px; padding:8px 18px; font-weight:600; cursor:pointer; }
  footer button:focus-visible, #msg:focus-visible { outline:2px solid var(--info); }
  #send { background:#2a3b31; color:var(--human); }
  #stopBtn { background:#3b2429; color:var(--bad); }
  #acceptBtn { background:#3b3324; color:var(--warn); }
  footer button:disabled { opacity:.4; cursor:default; }
  @media (prefers-reduced-motion: no-preference) {
    #status.running::before { content:"● "; animation:pulse 1.6s infinite; }
    @keyframes pulse { 50% { opacity:.3; } }
  }
</style>
</head>
<body>
<header>
  <h1>🐝 Swarm</h1>
  <span id="goal" title=""></span>
  <span class="pill" id="round">round —</span>
  <span class="pill" id="status">connecting</span>
</header>

<div id="feed" aria-live="polite"></div>

<aside>
  <section><h2>Run</h2><div id="agents"><div class="agent">no active agents</div></div></section>
  <section><h2>Wiki</h2><div id="tree">loading…</div></section>
</aside>

<div id="viewer">
  <div class="vhead"><code id="vpath"></code><button id="vclose">close</button></div>
  <div id="vbody"></div>
</div>

<footer>
  <input id="msg" placeholder="Post to the board as HUMAN… (Enter to send)" aria-label="Message to the swarm">
  <button id="send">Post</button>
  <button id="stopBtn">■ STOP</button>
  <button id="acceptBtn">✔ ACCEPT</button>
</footer>

<script>
const $ = id => document.getElementById(id);
const feed = $('feed');
let maxSeq = 0;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Inline formatting for feed text: code spans, bold, [[wiki links]].
function fmtInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink" data-wl="$1">[[$1]]</span>');
}

// Tiny markdown renderer for wiki viewer: headings, fences, lists, paragraphs.
function renderMd(src) {
  const out = [];
  const lines = src.split(/\r?\n/);
  let inCode = false, buf = [];
  const flushP = () => { if (buf.length) { out.push('<p>' + fmtInline(buf.join(' ')) + '</p>'); buf = []; } };
  for (const line of lines) {
    if (line.startsWith('```')) { flushP();
      out.push(inCode ? '</pre>' : '<pre>'); inCode = !inCode; continue; }
    if (inCode) { out.push(esc(line) + '\n'); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { flushP(); out.push(`<h${h[1].length}>` + fmtInline(h[2]) + `</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) { flushP(); out.push('<li>' + fmtInline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'); continue; }
    if (!line.trim()) { flushP(); continue; }
    buf.push(line);
  }
  flushP(); if (inCode) out.push('</pre>');
  return out.join('');
}

function nearBottom() { return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80; }

function addEntry(m) {
  if (m.seq && m.seq <= maxSeq) return;       // skip SSE replay duplicates on reconnect
  if (m.seq) maxSeq = m.seq;
  const stick = nearBottom();
  const el = document.createElement('div');
  el.className = 'entry';
  el.dataset.role = m.role || 'system';
  const refs = (m.refs || []).map(r =>
    `<span class="refchip" data-ref="${esc(r)}">${esc(r)}</span>`).join('');
  el.innerHTML =
    `<span class="time">${esc((m.ts || '').slice(11, 19))}</span>` +
    `<span class="from">${esc(m.from || '?')}</span>` +
    `<div class="body"><span class="type ${esc(m.type || 'msg')}">${esc(m.type || 'msg')}</span>` +
    `<span class="text">${fmtInline(m.text)}</span><div>${refs}</div></div>`;
  feed.appendChild(el);
  if (stick) feed.scrollTop = feed.scrollHeight;
}

function setState(s) {
  $('goal').textContent = s.goal || '';
  $('goal').title = s.goal || '';
  $('round').textContent = `round ${s.round ?? '—'}/${s.maxRounds ?? '—'}`;
  $('status').textContent = s.status || '?';
  $('status').className = 'pill';
  $('status').classList.add(s.status || 'unknown');
  const list = (s.active || []).map(a =>
    `<div class="agent"><b>${esc(a.id)}</b> <span class="role">${esc(a.role)}</span>` +
    `<span class="task" title="${esc(a.task)}">${esc(a.task)}</span></div>`).join('');
  $('agents').innerHTML = list || '<div class="agent">no active agents</div>';
  const done = ['done', 'stopped', 'failed', 'accepted'].includes(s.status);
  $('stopBtn').disabled = done; $('acceptBtn').disabled = done;
  loadTree();
}

async function loadTree() {
  try {
    const t = await (await fetch('/wikitree')).json();
    const link = (scope, f) => `<a href="#" data-scope="${scope}" data-file="${esc(f)}">${esc(f)}</a>`;
    $('tree').innerHTML =
      '<div class="grp">run</div>' + (t.run.map(f => link('run', f)).join('') || '<span class="grp">empty</span>') +
      '<div class="grp">global</div>' + (t.global.map(f => link('global', f)).join('') || '<span class="grp">empty</span>');
  } catch { $('tree').textContent = 'wiki unavailable'; }
}

async function openWiki(scope, file) {
  const r = await fetch(`/wiki/${scope}/` + file.split('/').map(encodeURIComponent).join('/'));
  $('vpath').textContent = scope + ':' + file;
  $('vbody').innerHTML = r.ok ? renderMd(await r.text()) : 'not found';
  $('viewer').classList.add('open');
}
$('vclose').onclick = () => $('viewer').classList.remove('open');

document.addEventListener('click', e => {
  const ref = e.target.closest('[data-ref]');
  if (ref) { const r = ref.dataset.ref;
    if (r.startsWith('global:')) openWiki('global', r.slice(7));
    else openWiki('run', r.replace(/^wiki\//, ''));
    return; }
  const tl = e.target.closest('#tree a');
  if (tl) { e.preventDefault(); openWiki(tl.dataset.scope, tl.dataset.file); return; }
  const wl = e.target.closest('.wikilink');
  if (wl) { // resolve [[name]] against the run tree by filename match
    fetch('/wikitree').then(r => r.json()).then(t => {
      const n = wl.dataset.wl.toLowerCase().replaceAll(' ', '-');
      const hit = t.run.find(f => f.toLowerCase().includes(n)) || t.run.find(f => f.endsWith('INDEX.md'));
      if (hit) openWiki('run', hit);
    });
  }
});

async function post(text) {
  await fetch('/post', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'HUMAN', role: 'human', type: 'msg', text }) });
}
$('send').onclick = () => { const t = $('msg').value.trim(); if (t) { post(t); $('msg').value = ''; } };
$('msg').addEventListener('keydown', e => { if (e.key === 'Enter') $('send').onclick(); });

async function control(action, label) {
  if (!confirm(label)) return;
  await fetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }) });
}
$('stopBtn').onclick = () => control('stop', 'Stop all agents and end the run?');
$('acceptBtn').onclick = () => control('accept', 'Accept the current result and finalize?');

const es = new EventSource('/events');
es.addEventListener('board', e => { try { addEntry(JSON.parse(e.data)); } catch {} });
es.addEventListener('state', e => { try { setState(JSON.parse(e.data)); } catch {} });
es.onerror = () => { $('status').textContent = 'reconnecting…'; $('status').className = 'pill'; };
loadTree();
</script>
</body>
</html>
```

- [ ] **Step 2: Re-run server tests (UI change must not break `GET /`)**

Run: `cd /c/Users/Arek/.claude/skills/swarm && node --test test/`
Expected: all PASS.

- [ ] **Step 3: Verify live with Playwright**

Seed and start a demo run (Bash):

```bash
D=/c/Users/Arek/AppData/Local/Temp/claude-swarm-demo; rm -rf $D; mkdir -p $D/wiki/findings
cat > $D/state.json <<'EOF'
{"goal":"Demo: verify the board UI","runId":"demo","status":"running","round":2,"maxRounds":8,"wave":4,"workersModel":"opus","active":[{"id":"w1-researcher","role":"researcher","task":"survey options","since":"2026-07-23T10:00:00Z"}],"startedAt":"2026-07-23T10:00:00Z","updatedAt":"2026-07-23T10:05:00Z"}
EOF
printf '%s\n' \
 '{"seq":1,"ts":"2026-07-23T10:00:01Z","from":"judge","role":"judge","type":"round","text":"Round 2: spawning 2 workers","refs":[]}' \
 '{"seq":2,"ts":"2026-07-23T10:00:05Z","from":"w1-researcher","role":"worker","type":"msg","text":"Found candidate approach, see [[alpha]]","refs":["wiki/findings/alpha.md"]}' \
 '{"seq":3,"ts":"2026-07-23T10:00:09Z","from":"critic-1","role":"critic","type":"result","text":"FAIL: missing evidence for claim 2","refs":[]}' > $D/board.jsonl
printf '# Index\n- [[alpha]] - candidate approach\n' > $D/wiki/INDEX.md
printf '# Alpha\n\nDetails of the **alpha** approach.\n' > $D/wiki/findings/alpha.md
node /c/Users/Arek/.claude/skills/swarm/server.mjs --run $D --port 4791 &
```

Then with Playwright MCP tools (load via ToolSearch `select:mcp__plugin_playwright_playwright__browser_navigate,...` as needed):

1. `browser_navigate` → `http://127.0.0.1:4791/` ; `browser_snapshot` → expect: goal text "Demo: verify the board UI", pill "round 2/8", status "running", 3 feed entries with distinct roles, agent `w1-researcher` in sidebar, wiki tree shows `INDEX.md` + `findings/alpha.md`.
2. Live SSE: `curl -s -X POST http://127.0.0.1:4791/post -H 'Content-Type: application/json' -d '{"from":"w2-coder","role":"worker","type":"learning","text":"lesson: cache the parse"}'` then `browser_wait_for` text `lesson: cache the parse` (no reload).
3. HUMAN input: type "focus on approach alpha" into the message box, press Enter → entry appears with green HUMAN styling; `grep` board.jsonl for the text.
4. Wiki: click `findings/alpha.md` in tree → viewer shows rendered heading "Alpha" with bold "alpha".
5. STOP: click STOP → `browser_handle_dialog` accept → verify `$D/control/stop.flag` exists and a system line "HUMAN pressed STOP" is on the board.
6. `browser_take_screenshot` (show the user), `browser_close`, kill the server (`kill %1`).

Expected: every check passes; fix and re-verify otherwise.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/Arek/.claude/skills/swarm && git add -A && git commit -m "feat: board UI - live feed, agents, wiki viewer, human controls"
```

---

### Task 5: Prompt templates (worker, critic, distiller)

**Files:**
- Create: `C:\Users\Arek\.claude\skills\swarm\templates\worker.md`
- Create: `C:\Users\Arek\.claude\skills\swarm\templates\critic.md`
- Create: `C:\Users\Arek\.claude\skills\swarm\templates\distiller.md`

**Interfaces:**
- Consumes: HTTP API (`POST /post` via curl), run layout from Global Constraints.
- Produces: templates with `{{PLACEHOLDER}}` slots the judge fills: `{{AGENT_ID}} {{ROLE}} {{GOAL}} {{TASK}} {{ROUND}} {{RUN_DIR}} {{BOARD_URL}} {{PROJECT_DIR}}` (critic also `{{CANDIDATE}}`; distiller instead uses `{{RUN_DIR}} {{GLOBAL_WIKI}} {{GOAL}} {{OUTCOME}}`). SKILL.md (Task 6) depends on these exact placeholder names.

- [ ] **Step 1: Write `templates\worker.md`**

```markdown
You are **{{AGENT_ID}}**, a {{ROLE}} in a swarm working toward one goal. You are one of several
parallel agents; the board and the wiki are how the swarm thinks together.

## Goal (the swarm's, not yours alone)
{{GOAL}}

## Your task this round (round {{ROUND}})
{{TASK}}

## Paths
- Project working directory: `{{PROJECT_DIR}}`
- Run directory: `{{RUN_DIR}}`
- Run wiki: `{{RUN_DIR}}/wiki/`
- Board API: `{{BOARD_URL}}`

## 1. Read memory FIRST (mandatory, before any work)
1. Read `{{RUN_DIR}}/wiki/INDEX.md`.
2. Read every page under `{{RUN_DIR}}/wiki/failures/` — do NOT repeat a failed approach unless
   your task explicitly says to retry it differently.
3. Read pages linked from INDEX that are relevant to your task.
4. Read the last ~30 lines of `{{RUN_DIR}}/board.jsonl` — react to recent `HUMAN` messages; the
   human's instructions on the board override your task details.

## 2. Board protocol (use the Bash tool + curl; post at least: start, one progress, result)
Post a message (single-line JSON via heredoc — avoids all quoting issues):

    curl -s -X POST {{BOARD_URL}}/post -H 'Content-Type: application/json' --data @- <<'EOF'
    {"from":"{{AGENT_ID}}","role":"worker","type":"msg","text":"Starting: <one-line plan>"}
    EOF

- `type` must be one of: `msg` (progress/chatter), `result` (your final outcome),
  `learning` (a lesson worth remembering), `task` (only if you delegate/suggest work).
- Reference wiki pages you wrote via `"refs":["wiki/findings/<file>.md"]`.
- If curl fails (server down), append the same JSON as one line directly to
  `{{RUN_DIR}}/board.jsonl` and continue.

## 3. Do the work
Stay strictly on your task. Depth over breadth. If blocked, post a `msg` explaining the blocker
and pivot to the most useful adjacent thing within your task's scope.

## 4. Write memory BEFORE finishing (mandatory)
1. Add at least one page: `findings/<slug>.md` (facts + sources), `failures/<slug>.md`
   (what you tried, why it failed — exact errors), or `approaches/<slug>.md` (method + outcome).
   Use `[[other-page-slug]]` links where related.
2. Append one line for each new page to `{{RUN_DIR}}/wiki/INDEX.md`:
   `- [[<slug>]] — <one-line summary> (by {{AGENT_ID}}, r{{ROUND}})`
3. Post a `learning` to the board if you learned something the next wave must know.

## 5. Final output (your return value — structured, no prose around it)
    ## Achieved
    <what you completed, with file paths / evidence>
    ## Failed
    <what did not work and WHY — exact errors; "nothing" if none>
    ## Recommendation
    <what the next wave should do — one to three bullets>
    ## Wiki pages
    <list of pages you added/updated>
```

- [ ] **Step 2: Write `templates\critic.md`**

```markdown
You are **{{AGENT_ID}}**, an adversarial critic. The swarm believes it may have reached the goal.
Your ONLY job: try to REFUTE that. You earn your keep by finding real flaws; a lazy PASS is a
failure on your part. Be skeptical by default.

## Goal being judged
{{GOAL}}

## Candidate result
{{CANDIDATE}}

## Paths
- Project working directory: `{{PROJECT_DIR}}`
- Run directory: `{{RUN_DIR}}` (read `wiki/INDEX.md` and `goal.md` success criteria first)
- Board API: `{{BOARD_URL}}` — post exactly like a worker, but with `"role":"critic"`.

## Method
1. Read the success criteria in `{{RUN_DIR}}/goal.md`. Judge against THEM, not vibes.
2. Verify claims independently: open the files, run the commands, check the sources.
   A claim without evidence is a flaw.
3. Attack completeness (criteria not met), correctness (claims wrong), and robustness
   (works only in the happy path).
4. Post your verdict to the board (`type":"result"`).
5. For every FATAL objection, write `{{RUN_DIR}}/wiki/failures/critic-<slug>.md` explaining it
   and add it to INDEX.

## Final output (structured, nothing else)
    ## Verdict
    PASS | FAIL
    ## Objections
    - [FATAL|MINOR] <what> — evidence: <how you verified>
    (empty list allowed only with PASS)
```

- [ ] **Step 3: Write `templates\distiller.md`**

```markdown
You are the end-of-run distiller. The run is over (outcome: {{OUTCOME}}). Extract durable,
cross-project lessons — not task-specific facts — into the global wiki.

## What happened
Goal: {{GOAL}}
Run directory: `{{RUN_DIR}}` — read `wiki/INDEX.md`, all of `wiki/failures/`, and `board.jsonl`
(skim for `learning` lines).

## Global wiki
`{{GLOBAL_WIKI}}` — create `INDEX.md` and `lessons/` if missing.

## Rules (anti-bloat — these are hard rules)
1. Write **at most 3** lessons, only ones that would change how a FUTURE swarm on a DIFFERENT
   goal behaves. Zero lessons is a valid outcome.
2. Before creating a lesson, read `{{GLOBAL_WIKI}}/INDEX.md`. If a similar lesson exists,
   MERGE into that file (update it, append evidence) instead of creating a near-duplicate.
3. Lesson format — `lessons/<slug>.md`:
       # <imperative one-liner, e.g. "Verify API pagination before bulk-fetching">
       **Pattern:** <when this applies>
       **Do:** <what to do>
       **Evidence:** <run id / one sentence what happened> ({{RUN_DIR}})
4. Keep `INDEX.md` to one line per lesson: `- [[<slug>]] — <one-liner>`.

## Final output
List of lessons written/merged (or "none worth keeping"), one line each.
```

- [ ] **Step 4: Sanity-check placeholders**

Run: `cd /c/Users/Arek/.claude/skills/swarm && grep -ho '{{[A-Z_]*}}' templates/*.md | sort -u`
Expected exactly: `{{AGENT_ID}} {{BOARD_URL}} {{CANDIDATE}} {{GLOBAL_WIKI}} {{GOAL}} {{OUTCOME}} {{PROJECT_DIR}} {{ROLE}} {{ROUND}} {{RUN_DIR}} {{TASK}}` (order irrelevant).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Arek/.claude/skills/swarm && git add -A && git commit -m "feat: worker/critic/distiller prompt templates"
```

---

### Task 6: `SKILL.md` — the judge program

**Files:**
- Create: `C:\Users\Arek\.claude\skills\swarm\SKILL.md`

**Interfaces:**
- Consumes: `server.mjs` CLI (`--run`, `--port`, `SWARM_BOARD_URL=` stdout, `server.json`), template placeholders from Task 5, `state.json`/board contracts from File Structure.
- Produces: the invocable skill `/swarm`.

- [ ] **Step 1: Write `SKILL.md`**

```markdown
---
name: swarm
description: Judge-led autonomous multi-agent swarm with a live board UI, shared llm-wiki memory and an auto-improvement loop. Use when the user invokes /swarm <goal>, /swarm resume <runId>, or asks to run an agent swarm/hive on a goal. Options inside the prompt: workers:<opus|sonnet|haiku|fable> rounds:<N> wave:<N, max 20> minutes:<N>.
---

# Swarm — judge program

You (this session) are the **judge**. You never do object-level work yourself — you plan, spawn,
synthesize, decide, and keep the board honest. Announce: "Swarm starting — I'm the judge."

Skill directory (templates, server): the directory containing this SKILL.md.
Global wiki: `~/.claude/swarm/wiki` (`C:\Users\Arek\.claude\swarm\wiki` on this machine).

## 0. Parse the invocation
- Everything except `key:value` tokens is the **goal**. Options: `workers:` (default `opus`;
  allowed `opus|sonnet|haiku|fable`, anything else → omit the model param so workers inherit the
  session model), `rounds:` (default 8), `wave:` (default 4, hard-cap 20), `minutes:` (default none).
- `resume <runId>` → jump to section 7.
- Empty goal → ask the user for one. Ambiguous but non-empty goal → proceed; derive success
  criteria yourself (the human can correct them on the board).

## 1. Setup
1. `runId` = `<yyyy-mm-dd>-<3-6 word slug of the goal>`. `RUN_DIR` = `<cwd>/docs/swarm/runs/<runId>`.
2. Create `RUN_DIR` with subdirs `wiki/`, `wiki/findings/`, `wiki/failures/`, `wiki/approaches/`,
   `artifacts/`, `control/`.
3. Write `RUN_DIR/goal.md`: the goal verbatim; a `## Success criteria` list you derive
   (measurable, checkable — critics will judge against these); a `## Config` line with the
   parsed options; `## Run` with runId, project dir, start time.
4. Write `RUN_DIR/state.json` (SINGLE LINE, exact shape):
   `{"goal":"...","runId":"...","projectDir":"...","status":"running","round":0,"maxRounds":R,"wave":W,"workersModel":"...","minutes":M|null,"active":[],"startedAt":"ISO","updatedAt":"ISO"}`
5. Bootstrap global wiki if missing: create `~/.claude/swarm/wiki/lessons/` and an empty
   `INDEX.md` ("# Swarm lessons" header).
6. Start the server with the Bash tool, `run_in_background: true`:
   `node <skillDir>/server.mjs --run <RUN_DIR> --port 4780`
   Then poll `RUN_DIR/server.json` (up to 10s). Read the port. **Tell the user the URL now**:
   `http://127.0.0.1:<port>` — one short message; the board is where they watch and steer.
7. Seed memory: read global `INDEX.md`; for lessons plausibly relevant to this goal, add a
   `## Seeded lessons` section to `RUN_DIR/wiki/INDEX.md` listing each as
   `- global:lessons/<file> — <one-liner>`.
8. Post to the board (curl, as `judge`): type `system` — goal + success criteria + config.

## 2. Round loop (repeat until an exit condition in section 4)
1. Increment `round` in state.json (rewrite the full single-line JSON, update `updatedAt`).
2. **Plan the wave.** Pick 1..wave workers. Role menu: `researcher` (find facts/sources),
   `analyst` (compare, structure, decide), `coder` (implement in the project), `tester`
   (verify by running things), `synthesizer` (merge results into a deliverable draft in
   `artifacts/`). First round of a fresh goal: usually researchers + one analyst. Later rounds:
   whatever the failures and gaps demand. Post the plan to the board (type `round`): who, what,
   why — before spawning.
3. **Spawn all workers in ONE message** (parallel Agent tool calls), each:
   `run_in_background: true`; `model:` = workersModel (omit if inherit; judge MAY downgrade a
   trivial task to `haiku`); prompt = `templates/worker.md` with every `{{PLACEHOLDER}}` filled
   (`{{AGENT_ID}}` = `w<N>-<role>` with N globally unique across the run; `{{TASK}}` = 2-6
   sentences, concrete, with expected deliverable).
   Add each to `state.json.active` and rewrite it.
4. **While the wave runs:** on each task notification, read the worker's structured result,
   post a 1-2 line judge ack to the board (`msg`), remove it from `active`, rewrite state.json.
   Between notifications also check section 3 signals.
5. **After the wave:** read all new wiki pages (Glob `RUN_DIR/wiki/**/*.md`, mtime > round
   start) and the board tail. Post a round summary (type `round`): achieved / failed / next.
6. Evaluate against `goal.md` success criteria → section 4.

## 3. Signals (check between notifications and at every loop point)
- `RUN_DIR/control/stop.flag` exists → graceful stop (section 5, status `stopped`).
- `RUN_DIR/control/accept.flag` exists → finalize (section 6, status `accepted`).
- New `HUMAN` lines on the board → treat as steering input: acknowledge on the board and fold
  into the next wave plan. Human instructions override your plan.
- The user says stop in chat → same as stop.flag.
- `round >= maxRounds`, or `minutes` exceeded → stop with best-so-far (section 5, status `done`
  if criteria met, else `stopped`).

## 4. Success gate
When YOU believe every success criterion is met by content in `artifacts/` (have a synthesizer
produce/refresh the candidate deliverable first if needed):
1. Spawn 2 critics in parallel (3 if the goal is high-stakes), prompt = `templates/critic.md`,
   `{{CANDIDATE}}` = path(s) to the deliverable. Critics run like workers (background, board).
2. ALL critics PASS (no FATAL objections) → section 6 (status `done`).
3. Any FAIL → their objections are already in `wiki/failures/`; post a `round` line
   ("critics rejected: <objections>") and continue the loop — next wave fixes them.
4. A candidate rejected twice on the SAME objection → change strategy explicitly (different
   roles/angle), note the pivot on the board.

## 5. Graceful stop (stop.flag / chat stop / limits)
1. TaskStop every running worker agent. 2. Post `final` to the board: status + best result so
far + why stopped. 3. Set state.json status accordingly. 4. Run the distiller (section 6 step 2)
— failures are learning too. 5. Report in chat: outcome, URL (server stays up), run dir.

## 6. Finalize (success or accept)
1. If the deliverable needs assembly, spawn one synthesizer to write the final artifact into
   `artifacts/` (file name fitting the goal, e.g. `final-report.md`).
2. Spawn the distiller (foreground is fine): `templates/distiller.md`, `{{OUTCOME}}` = the
   status. It writes ≤3 merged lessons into the global wiki.
3. Post `final` to the board (what was achieved, where the deliverable lives, refs).
4. state.json → final status, `active:[]`.
5. Report in chat: deliverable path, board URL (left running for browsing), 2-3 line summary.
   Do NOT kill the server unless the user asks.

## 7. Resume (`/swarm resume <runId>`)
1. `RUN_DIR` = `<cwd>/docs/swarm/runs/<runId>` (error with a list of `docs/swarm/runs/` if missing).
2. Read `state.json`, `goal.md`, board tail (~50 lines), wiki INDEX.
3. If `server.json` PID is dead or the port doesn't answer `GET /state`, restart the server
   (same command as setup step 6) and give the user the URL.
4. Set status `running`, post `system` ("resumed at round N"), continue at section 2.

## Judge conduct
- Every decision goes on the board BEFORE acting on it. The human must be able to follow the
  run from the board alone.
- Never exceed `wave`; prefer small sharp waves over big vague ones. Give workers disjoint
  tasks — overlap wastes tokens.
- Workers that die or return null: note on the board, fold their task into the next wave.
- Keep chat quiet while the swarm runs (the board is the narrating surface): chat gets the
  URL at start, blockers needing the human, and the final report.
```

- [ ] **Step 2: Verify frontmatter + placeholder coverage**

Run: `cd /c/Users/Arek/.claude/skills/swarm && head -5 SKILL.md && grep -c '{{' SKILL.md`
Expected: frontmatter has `name: swarm` and a `description:`; `{{` count ≥ 4 (placeholder names referenced). Manually confirm every placeholder named in SKILL.md exists in the Task 5 sanity-check list.

- [ ] **Step 3: Commit**

```bash
cd /c/Users/Arek/.claude/skills/swarm && git add -A && git commit -m "feat: SKILL.md judge program"
```

---

### Task 7: End-to-end smoke run (MAIN SESSION ONLY)

**Files:** none created in the repo (run artifacts land in the test project).

**Interfaces:** Consumes everything. This task MUST be executed by the main session (it needs the Agent tool to spawn workers) — do NOT delegate it to a subagent.

- [ ] **Step 1: Full test suite green**

Run: `cd /c/Users/Arek/.claude/skills/swarm && node --test test/`
Expected: all PASS.

- [ ] **Step 2: Smoke run**

In `e:\Projekty\pustaApka`, follow `SKILL.md` end-to-end as the judge with:
goal = "Produce a one-page brief comparing 3 approaches to zero-dependency HTTP routing in Node, with a recommendation", options `rounds:2 wave:2 workers:sonnet`.

- [ ] **Step 3: Verify checklist (all must hold)**

1. Board URL printed early; `GET /` renders; feed shows judge plan → worker posts → results live.
2. `docs/swarm/runs/<runId>/` contains: `goal.md` (with derived success criteria), `board.jsonl` (≥ 8 lines, roles include judge+worker), `state.json` (single line), `wiki/INDEX.md` + at least 2 pages, `artifacts/` with the brief.
3. Critics ran before `done` (board shows critic lines) OR run ended by limit with honest status.
4. `C:\Users\Arek\.claude\swarm\wiki\INDEX.md` exists; if a lesson was distilled it is listed and its file exists; no near-duplicate lessons.
5. STOP path: during a wave (or a second mini-run), press STOP in the UI → workers TaskStopped, board gets `final`, state → `stopped`, distiller still ran.
6. UI screenshot captured (Playwright) and shown to the user.

- [ ] **Step 4: Fix anything that failed, re-verify, then commit**

```bash
cd /c/Users/Arek/.claude/skills/swarm && git add -A && git commit -m "chore: smoke-run fixes after E2E verification"
```

---

## Self-Review (done while writing)

- **Spec coverage:** board+SSE (T1-2), wiki endpoints+viewer (T3-4), STOP/ACCEPT+HUMAN posts (T1,T4), worker/critic/distiller contracts (T5), judge loop, limits, wave≤20, resume, seeding, per-run isolation + global distillation (T6), verification plan (T7). Out-of-scope items from spec §11 stay out.
- **Placeholders:** none — every step carries full code/content.
- **Type consistency:** enums, `state.json`, `server.json`, endpoint paths, and `{{PLACEHOLDER}}` names are defined once in File Structure/Global Constraints and used identically in T1-T6.
