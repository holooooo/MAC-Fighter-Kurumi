'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { runBridge, localEndpoint, parseArguments } = require('../bin/kurumi-agent.cjs');
const BRIDGE = path.resolve(__dirname, '../bin/kurumi-agent.cjs');

async function serverFixture(t, handler) {
  const events = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      events.push({ path: req.url, body: JSON.parse(body) });
      if (handler) handler(req, res); else { res.writeHead(200); res.end('{}'); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, events, url: `http://127.0.0.1:${server.address().port}` };
}
function cli(args, url, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], { env: { ...process.env, KURUMI_URL: url }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; onChild?.(child, stdout); });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end();
  });
}

test('legacy child lifecycle remains diagnostic without generating removed or replacement markets', async t => {
  const { createService } = require('../server.cjs');
  const service = createService({ statePath: null });
  const { port } = await service.start(0);
  t.after(() => service.stop());
  const url = `http://127.0.0.1:${port}`;
  const result = await cli(['--agent','dsh','--',process.execPath,'-e','setTimeout(()=>process.exit(7),150)'], url);
  assert.equal(result.code,7);
  const state = await (await fetch(url+'/api/state')).json();
  assert.equal(state.telemetry.dshActivity.value,0);
  assert.equal(state.telemetry.dshActivity.source,'agent-command-lifecycle');
  assert.equal(state.game.instruments.some(i=>i.id==='CODEX'||i.id==='CLAUDE'),false);
  const instrument = state.game.instruments.find(i=>i.id==='DSH');
  assert.deepEqual(instrument.history,[]);
  assert.equal(instrument.currentCandle,null);
  assert.equal(instrument.price,0);
  assert.equal(instrument.hasSamples,false);
  assert.equal(instrument.sampleTime,null);
  assert.equal(state.telemetry.dshTokens.status,'unavailable');
  assert.equal(state.telemetry.dshTokens.value,null);
});

test('argument delimiter preserves literal child args and local URL rejects remote destinations', () => {
  assert.deepEqual(parseArguments(['--agent', 'codex', '--', 'command', '--help', 'a;b']), { agent: 'codex', command: 'command', args: ['--help', 'a;b'] });
  assert.equal(parseArguments(['--help']).help, true);
  assert.equal(localEndpoint('http://localhost:9999').href, 'http://127.0.0.1:9999/api/agent-events');
  for (const url of ['https://127.0.0.1:8766', 'http://example.com', 'http://127.0.0.1.evil.test', 'http://user:secret@127.0.0.1', 'http://127.0.0.1/x', 'http://127.0.0.1/?x=secret', 'http://127.0.0.1/#secret']) assert.throws(() => localEndpoint(url));
  assert.throws(() => parseArguments(['--agent', 'unknown', '--', 'node']));
});

test('real child output remains untouched, exit code and start/stop identity preserved', async t => {
  const { url, events } = await serverFixture(t);
  const literal = 'private-input; $(echo must-not-run)';
  const result = await cli(['--agent', 'codex', '--', process.execPath, '-e', 'process.stdout.write(process.argv[1]);process.stderr.write("private-error");process.exitCode=7;', literal], url);
  assert.equal(result.code, 7);
  assert.equal(result.stdout, literal);
  assert.equal(result.stderr, 'private-error');
  assert.deepEqual(events.map(e => e.body.event), ['start', 'stop']);
  assert.ok(events.every(e => e.path === '/api/agent-events'));
  assert.ok(events.every(e => JSON.stringify(e).includes('private') === false));
  for (const { body } of events) {
    assert.deepEqual(Object.keys(body).sort(), ['agent', 'event', 'sessionId']);
    assert.match(body.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(body.sessionId, events[0].body.sessionId);
  }
});

test('real five-second heartbeat is followed by stop', { timeout: 10000 }, async t => {
  const { url, events } = await serverFixture(t);
  const result = await cli(['--agent', 'claude', '--', process.execPath, '-e', 'setTimeout(()=>process.exit(0),5300)'], url);
  assert.equal(result.code, 0);
  assert.deepEqual(events.map(e => e.body.event), ['start', 'heartbeat', 'stop']);
});

test('unreachable or stalled telemetry never replaces child failure; no overlapping requests', async t => {
  const fixture = await serverFixture(t);
  await new Promise(resolve => fixture.server.close(resolve));
  const unavailable = await cli(['--agent', 'dsh', '--', process.execPath, '-e', 'process.exit(19)'], fixture.url);
  assert.equal(unavailable.code, 19);
  assert.equal(unavailable.stderr, '');
  let active = 0, maxActive = 0;
  const slow = await serverFixture(t, (req, res) => {
    active++; maxActive = Math.max(maxActive, active);
    res.once('close', () => active--);
    setTimeout(() => { if (!res.destroyed) res.end('{}'); }, 80);
  });
  const code = await runBridge({ agent: 'codex', command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(9),230)'], endpoint: slow.url, heartbeatMs: 10, timeoutMs: 100, stdio: 'ignore' });
  assert.equal(code, 9); assert.equal(maxActive, 1);
  assert.equal(slow.events[0].body.event, 'start');
  assert.equal(slow.events.at(-1).body.event, 'stop');
});

test('finite HTTP timeout and spawn failure preserve wrapper semantics', async t => {
  const { url, events } = await serverFixture(t, () => {});
  const start = Date.now();
  const code = await runBridge({ agent: 'dsh', command: process.execPath, args: ['-e', 'process.exit(11)'], endpoint: url, timeoutMs: 80, stdio: 'ignore' });
  assert.equal(code, 11);
  assert.ok(Date.now() - start < 2000);
  assert.deepEqual(events.map(e => e.body.event), ['start', 'stop']);
  const beforeFailure = events.length;
  const failed = await cli(['--agent', 'codex', '--', '/nonexistent-kurumi-command'], url);
  assert.equal(failed.code, 127);
  assert.match(failed.stderr, /找不到/);
  assert.equal(events.length, beforeFailure, 'spawn failure must not emit start or stop');
});

test('registration recovers from failed start and lost server session without overlapping', async t => {
  let count = 0, active = 0, maxActive = 0;
  const { url, events } = await serverFixture(t, (_req, res) => {
    count++; active++; maxActive = Math.max(maxActive, active);
    res.once('close', () => active--);
    res.writeHead(count === 1 ? 503 : count === 3 ? 400 : 200);
    res.end('{}');
  });
  const code = await runBridge({ agent: 'codex', command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(0),280)'], endpoint: url, heartbeatMs: 40, timeoutMs: 100, stdio: 'ignore' });
  assert.equal(code, 0);
  assert.deepEqual(events.slice(0, 5).map(e => e.body.event), ['start', 'start', 'heartbeat', 'start', 'heartbeat']);
  assert.equal(events.at(-1).body.event, 'stop');
  assert.equal(maxActive, 1);
  assert.equal(new Set(events.map(e => e.body.sessionId)).size, 1);
});

test('initially unreachable server accepts a new start when it returns', async t => {
  const { server, url, events } = await serverFixture(t);
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const running = runBridge({ agent: 'claude', command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(0),300)'], endpoint: url, heartbeatMs: 40, timeoutMs: 80, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 100));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  assert.equal(await running, 0);
  assert.equal(events[0].body.event, 'start');
  assert.ok(events.some(e => e.body.event === 'heartbeat'));
  assert.equal(events.at(-1).body.event, 'stop');
});

test('SIGTERM reaches real child and its explicit exit code survives with stop event', { timeout: 5000 }, async t => {
  const { url, events } = await serverFixture(t);
  let sent = false;
  const result = await cli(['--agent', 'codex', '--', process.execPath, '-e', 'process.on("SIGTERM",()=>process.exit(23));console.log("ready");setInterval(()=>{},1000)'], url, (child, stdout) => {
    if (!sent && stdout.includes('ready')) { sent = true; child.kill('SIGTERM'); }
  });
  assert.equal(result.code, 23);
  assert.deepEqual(events.map(e => e.body.event), ['start', 'stop']);
});

test('SIGINT produces signal-derived exit code and still sends stop', { timeout: 5000 }, async t => {
  const { url, events } = await serverFixture(t);
  let sent = false;
  const result = await cli(['--agent', 'dsh', '--', process.execPath, '-e', 'console.log("ready");setInterval(()=>{},1000)'], url, (child, stdout) => {
    if (!sent && stdout.includes('ready')) { sent = true; child.kill('SIGINT'); }
  });
  assert.equal(result.code, 130);
  assert.deepEqual(events.map(e => e.body.event), ['start', 'stop']);
});

test('help and invalid URL fail before executing the command', async () => {
  assert.match((await cli(['--help'], 'http://example.com')).stdout, /不采集/);
  const result = await cli(['--agent', 'codex', '--', process.execPath, '-e', 'console.log("MUST_NOT_RUN")'], 'http://example.com');
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
});
