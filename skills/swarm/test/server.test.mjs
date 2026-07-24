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

test('wikitree lists artifacts and serves them', async () => {
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'artifacts', 'final-report.md'), '# Final report\n');
  const j = await (await fetch(base + '/wikitree')).json();
  assert.ok(j.artifacts.includes('final-report.md'));
  const r = await fetch(base + '/wiki/artifacts/final-report.md');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Final report/);
});

test('goal.md is served from run root and listed in wikitree', async () => {
  fs.writeFileSync(path.join(runDir, 'goal.md'), '# Goal\ntest goal file\n');
  const j = await (await fetch(base + '/wikitree')).json();
  assert.ok(j.run.includes('goal.md'));
  const r = await fetch(base + '/wiki/run/goal.md');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /test goal file/);
});

test('agentfeed streams summarized transcript events', async () => {
  const tr = path.join(runDir, 'fake-transcript.jsonl');
  fs.writeFileSync(tr,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: 'run the tests' } }] } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Now writing the summary section.' }] } }) + '\n');
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
    goal: 'g', status: 'running', round: 1,
    active: [{ id: 'w9-tester', role: 'tester', model: 'sonnet', task: 't', transcript: tr }],
  }));
  const text = await sseWait(base + '/agentfeed/w9-tester',
    t => t.includes('run the tests') && t.includes('writing the summary'));
  assert.match(text, /event: act/);
  assert.ok(text.includes('"label":"Bash"'));
});

test('agentfeed 404s for unknown agent', async () => {
  const r = await fetch(base + '/agentfeed/nope');
  assert.equal(r.status, 404);
});

test('GET /usage sums token usage from judge and subagent transcripts', async () => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-usage-'));
  const jt = path.join(tdir, 'session.jsonl');
  fs.mkdirSync(path.join(tdir, 'subagents'), { recursive: true });
  fs.writeFileSync(jt,
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 } } }) + '\n');
  fs.writeFileSync(path.join(tdir, 'subagents', 'agent-x.jsonl'),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1000, output_tokens: 200 } } }) + '\n');
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
    goal: 'g', status: 'running', round: 1, active: [], judge: { model: 'fable', transcript: jt },
  }));
  const j = await (await fetch(base + '/usage')).json();
  assert.equal(j.in, 100 + 20 + 30 + 1000);
  assert.equal(j.out, 50 + 5 + 200);
});

test('agentfeed/judge streams from state.judge.transcript', async () => {
  const tr = path.join(runDir, 'judge-transcript.jsonl');
  fs.writeFileSync(tr,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { description: 'spawn wave 3 workers' } }] } }) + '\n');
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
    goal: 'g', status: 'running', round: 1, active: [],
    judge: { model: 'fable', transcript: tr },
  }));
  const text = await sseWait(base + '/agentfeed/judge', t => t.includes('spawn wave 3 workers'));
  assert.ok(text.includes('"label":"Agent"'));
});

test('POST /control agent-stop writes per-agent flag and board line', async () => {
  const r = await fetch(base + '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'agent-stop', id: 'w7-coder' }),
  });
  assert.equal((await r.json()).ok, true);
  assert.ok(fs.existsSync(path.join(runDir, 'control', 'agent-stop-w7-coder.flag')));
  const lines = fs.readFileSync(path.join(runDir, 'board.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.role, 'human');
  assert.match(last.text, /STOP for @w7-coder/);
});

test('agent-stop rejects missing or malformed id', async () => {
  const r = await fetch(base + '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'agent-stop', id: '../evil' }),
  });
  assert.equal(r.status, 400);
});

test('server stale-exits a running run with no state updates and no viewers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-stale-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    status: 'running', updatedAt: '2020-01-01T00:00:00Z',
  }));
  const p2 = spawn(process.execPath, [SERVER, '--run', dir, '--port', '0',
    '--idle-exit-min', '0.02', '--stale-exit-hours', '0.001']);
  const code = await new Promise((resolve, reject) => {
    p2.on('exit', resolve);
    setTimeout(() => { p2.kill(); reject(new Error('server did not stale-exit')); }, 15000);
  });
  assert.equal(code, 0);
});

test('server idle-exits after a terminal status with no viewers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-idle-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ status: 'stopped' }));
  const p2 = spawn(process.execPath, [SERVER, '--run', dir, '--port', '0', '--idle-exit-min', '0.02']);
  const code = await new Promise((resolve, reject) => {
    p2.on('exit', resolve);
    setTimeout(() => { p2.kill(); reject(new Error('server did not idle-exit')); }, 15000);
  });
  assert.equal(code, 0);
});

test('image files are served with an image content-type', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'artifacts', 'shot.png'), png);
  const r = await fetch(base + '/wiki/artifacts/shot.png');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  const md = await fetch(base + '/wiki/run/INDEX.md');
  assert.match(md.headers.get('content-type'), /text\/plain/);
});

test('wiki path traversal is blocked', async () => {
  const r = await fetch(base + '/wiki/run/..%2F..%2Fstate.json');
  assert.equal(r.status, 404);
  const r2 = await fetch(base + '/wiki/run/' + encodeURIComponent('..\\..\\state.json'));
  assert.equal(r2.status, 404);
});
