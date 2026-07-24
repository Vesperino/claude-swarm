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
const IDLE_EXIT_MIN = Number(arg('idle-exit-min', '60'));
const STALE_EXIT_HOURS = Number(arg('stale-exit-hours', '24'));

const BOARD = path.join(RUN_DIR, 'board.jsonl');
const STATE = path.join(RUN_DIR, 'state.json');
const CONTROL = path.join(RUN_DIR, 'control');
const RUN_WIKI = path.join(RUN_DIR, 'wiki');
const ARTIFACTS = path.join(RUN_DIR, 'artifacts');
fs.mkdirSync(CONTROL, { recursive: true });
fs.mkdirSync(RUN_WIKI, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });
if (!fs.existsSync(BOARD)) fs.writeFileSync(BOARD, '');

// seq continues from whatever is already on the board (resume case).
// Fallback direct appends may carry no seq; collisions are display-only.
let seq = 0;
for (const l of fs.readFileSync(BOARD, 'utf8').split('\n')) {
  if (!l) continue;
  try { const j = JSON.parse(l); if (j.seq > seq) seq = j.seq; } catch {}
}

let boardOffset = fs.statSync(BOARD).size;
let stateMtime = 0;
const clients = new Set();

// state.json must be valid JSON before it reaches the browser; a judge
// writing it through a shell can mangle backslashes, so validate here.
function readValidState() {
  try {
    const raw = fs.readFileSync(STATE, 'utf8');
    JSON.parse(raw);
    return raw;
  } catch (err) {
    console.error('state.json invalid, not broadcasting: ' + err.message);
    return null;
  }
}

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
      const raw = readValidState();
      if (raw) broadcast('state', raw);
    }
  } catch {}
}, 500);

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

// Turns one transcript JSONL line into 0..n lightweight display events.
function agentEvents(line) {
  const out = [];
  let j;
  try { j = JSON.parse(line); } catch { return out; }
  const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
  for (const c of content) {
    if (c.type === 'tool_use') {
      const inp = c.input || {};
      const detail = inp.description || inp.command || inp.file_path || inp.pattern || inp.url || '';
      out.push({ kind: 'tool', label: c.name, detail: String(detail).slice(0, 160) });
    } else if (c.type === 'text' && c.text && c.text.trim()) {
      out.push({ kind: 'text', label: 'says', detail: c.text.trim().slice(0, 220) });
    } else if (c.type === 'tool_result') {
      let t = '';
      if (typeof c.content === 'string') t = c.content;
      else if (Array.isArray(c.content)) t = c.content.map(x => (x && x.text) || '').join(' ');
      t = t.trim();
      if (t) out.push({ kind: 'result', label: 'result', detail: t.slice(0, 160) });
    }
  }
  if (j.type === 'result' && j.result) {
    out.push({ kind: 'info', label: 'final', detail: String(j.result).slice(0, 220) });
  }
  return out;
}

// Session token counter - free of LLM cost: sums usage records straight from
// the judge's session transcript + every subagent transcript next to it.
// Incremental: remembers a byte offset per file, re-reads only new bytes.
const usageOffsets = new Map();
const usageTotals = { in: 0, out: 0 };
function scanUsage() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const files = new Set();
    const jt = st.judge && st.judge.transcript;
    if (jt && fs.existsSync(jt)) {
      files.add(path.resolve(jt));
      const sub = path.join(path.dirname(jt), 'subagents');
      for (const f of listFiles(sub)) if (f.endsWith('.jsonl')) files.add(path.join(sub, f));
    }
    for (const a of st.active || []) {
      if (a.transcript && fs.existsSync(a.transcript)) files.add(path.resolve(a.transcript));
    }
    for (const file of files) {
      const size = fs.statSync(file).size;
      const off = usageOffsets.get(file) || 0;
      if (size <= off) continue;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - off);
      fs.readSync(fd, buf, 0, buf.length, off);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) continue;                     // no complete line yet
      usageOffsets.set(file, off + Buffer.byteLength(text.slice(0, lastNl + 1)));
      for (const line of text.slice(0, lastNl).split('\n')) {
        if (!line.includes('"usage"')) continue;
        try {
          const u = JSON.parse(line).message && JSON.parse(line).message.usage;
          if (u) {
            usageTotals.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            usageTotals.out += u.output_tokens || 0;
          }
        } catch {}
      }
    }
  } catch {}
}
setInterval(scanUsage, 10000);

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

// No-zombie policy: once the run reaches a terminal status, shut down after
// IDLE_EXIT_MIN minutes with no HTTP activity and no open SSE viewers.
let lastRequest = Date.now();
const TERMINAL = ['done', 'stopped', 'accepted', 'failed'];
setInterval(() => {
  try {
    if (clients.size > 0) return;
    if (Date.now() - lastRequest < IDLE_EXIT_MIN * 60000) return;
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (TERMINAL.includes(st.status)) {
      console.log('run ended and board idle for ' + IDLE_EXIT_MIN + ' min - shutting down');
      process.exit(0);
    }
    // Orphan guard: a "running" run whose judge died never reaches a terminal
    // status. No state update for STALE_EXIT_HOURS and no viewers -> shut down
    // (the run dir is persistent; /swarm resume restarts everything).
    const updated = Date.parse(st.updatedAt || 0) || 0;
    if (st.status === 'running' && Date.now() - updated > STALE_EXIT_HOURS * 3600000) {
      console.log('running run stale for ' + STALE_EXIT_HOURS + ' h with no viewers - shutting down');
      process.exit(0);
    }
  } catch {}
}, Math.max(1000, Math.min(60000, IDLE_EXIT_MIN * 60000 / 3)));

const server = createServer(async (req, res) => {
  lastRequest = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(HERE, 'ui.html')));
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
        const raw = readValidState();
        if (raw) res.write('event: state\ndata: ' + raw.replace(/\r?\n/g, ' ') + '\n\n');
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
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
      if (body.action === 'agent-stop') {
        const id = String(body.id || '');
        if (!/^[\w-]{1,80}$/.test(id)) return json(res, 400, { ok: false, error: 'valid id required' });
        fs.writeFileSync(path.join(CONTROL, 'agent-stop-' + id + '.flag'), new Date().toISOString());
        postLine({ from: 'HUMAN', role: 'human', type: 'system',
          text: 'HUMAN requested STOP for @' + id, refs: [] });
        return json(res, 200, { ok: true });
      }
      if (!['stop', 'accept'].includes(body.action)) {
        return json(res, 400, { ok: false, error: 'action must be stop|accept|agent-stop' });
      }
      fs.writeFileSync(path.join(CONTROL, body.action + '.flag'), new Date().toISOString());
      postLine({ from: 'HUMAN', role: 'human', type: 'system',
        text: 'HUMAN pressed ' + body.action.toUpperCase(), refs: [] });
      json(res, 200, { ok: true });
    } else if (req.method === 'GET' && p === '/usage') {
      scanUsage();
      json(res, 200, usageTotals);
    } else if (req.method === 'GET' && p === '/wikitree') {
      const run = listFiles(RUN_WIKI);
      if (fs.existsSync(path.join(RUN_DIR, 'goal.md'))) run.unshift('goal.md');
      json(res, 200, { run, global: listFiles(GLOBAL_WIKI), artifacts: listFiles(ARTIFACTS) });
    } else if (req.method === 'GET' && (p.startsWith('/wiki/run/') || p.startsWith('/wiki/global/') || p.startsWith('/wiki/artifacts/'))) {
      const scope = p.startsWith('/wiki/run/') ? 'run' : p.startsWith('/wiki/global/') ? 'global' : 'artifacts';
      const bases = { run: RUN_WIKI, global: GLOBAL_WIKI, artifacts: ARTIFACTS };
      const rel = p.slice(('/wiki/' + scope + '/').length);
      // goal.md lives in the run root, not under wiki/ - special-case the exact name
      const full = scope === 'run' && rel === 'goal.md'
        ? path.join(RUN_DIR, 'goal.md')
        : safeJoin(bases[scope], rel);
      if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        return json(res, 404, { ok: false, error: 'not found' });
      }
      const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      const ct = MIME[path.extname(full).toLowerCase()] || 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(fs.readFileSync(full));
    } else if (req.method === 'GET' && p.startsWith('/agentfeed/')) {
      // Live "what is this agent doing" stream: tails the agent's transcript
      // JSONL (path recorded by the judge in state.json.active[].transcript)
      // and emits lightweight summarized events.
      const id = p.slice('/agentfeed/'.length);
      let entry = null;
      try {
        const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
        entry = id === 'judge'
          ? (st.judge && st.judge.transcript ? { transcript: st.judge.transcript } : null)
          : (st.active || []).find(a => a.id === id);
      } catch {}
      if (!entry || !entry.transcript || !fs.existsSync(entry.transcript)) {
        return json(res, 404, { ok: false, error: 'no live transcript for ' + id });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      const file = entry.transcript;
      let off = Math.max(0, fs.statSync(file).size - 65536);
      let firstRead = off > 0;
      const readNew = () => {
        try {
          const sz = fs.statSync(file).size;
          if (sz <= off) return;
          const fd = fs.openSync(file, 'r');
          const buf = Buffer.alloc(sz - off);
          fs.readSync(fd, buf, 0, buf.length, off);
          fs.closeSync(fd);
          off = sz;
          let lines = buf.toString('utf8').split('\n');
          if (firstRead) { lines = lines.slice(1); firstRead = false; } // drop partial first line
          for (const line of lines) {
            if (!line.trim()) continue;
            for (const ev of agentEvents(line)) {
              res.write('event: act\ndata: ' + JSON.stringify(ev) + '\n\n');
            }
          }
        } catch {}
      };
      readNew();
      const timer = setInterval(readNew, 700);
      req.on('close', () => clearInterval(timer));
    } else {
      json(res, 404, { ok: false, error: 'not found' });
    }
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

let announced = false;
function listen(port, tries) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1);
    else { console.error('listen failed: ' + err.message); process.exit(1); }
  });
  // Each retry calls server.listen again on the same object; every call's
  // callback fires once the server finally binds, so guard the side effects.
  server.listen(port, '127.0.0.1', () => {
    if (announced) return;
    announced = true;
    const actual = server.address().port;
    fs.writeFileSync(path.join(RUN_DIR, 'server.json'),
      JSON.stringify({ port: actual, pid: process.pid, startedAt: new Date().toISOString() }));
    console.log('SWARM_BOARD_URL=http://127.0.0.1:' + actual);
  });
}
listen(BASE_PORT, 20);
