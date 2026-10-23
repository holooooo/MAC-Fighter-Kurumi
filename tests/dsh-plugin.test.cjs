'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const plugin = import(pathToFileURL(path.join(root, 'plugins/jiuliu-dsh/index.js')));
const drain = () => new Promise(resolve => setImmediate(resolve));

function harness(module, status = 204) {
  let clock = 1000000, timer, canceled = 0;
  const sent = [], options = [];
  const bridge = module.createTokenBridge({}, {
    now: () => clock,
    setInterval: fn => { timer = fn; return { unref() {} }; },
    clearInterval: () => { canceled++; },
    request(opts, callback) {
      options.push(opts);
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = body => {
        sent.push(JSON.parse(body));
        queueMicrotask(() => {
          const res = new EventEmitter();
          res.statusCode = status;
          res.resume = () => queueMicrotask(() => res.emit('end'));
          callback(res);
        });
      };
      return req;
    }
  });
  const session = { id: 'private-session-1' }, agent = { session };
  function start(attempt = 1, turn = 1, step = 1) {
    bridge.stream({ agent, frame: { type: 'start', attemptId: `${session.id}:${attempt}`, revision: attempt, turn, step } });
  }
  function usage(count, attempt = 1, extra = {}) {
    bridge.stream({ agent, frame: { type: 'chunk', attemptId: `${session.id}:${attempt}`, revision: 20, index: 7, time: clock, chunk: { type: 'usage', usage: { inputTokens: 5000, outputTokens: count, cacheReadTokens: 900, ...extra } } } });
  }
  function end(attempt = 1, seq = 7) {
    bridge.stream({ agent, frame: { type: 'end', attemptId: `${session.id}:${attempt}`, revision: 30, index: 9, outcome: { kind: 'committed', eventType: 'assistant/message', seq } } });
  }
  function durable(seq, count, type = 'assistant/message', extra = {}) {
    bridge.durable(session, { type, seq, time: clock, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'private-response' }] }, usage: { inputTokens: 1000, outputTokens: count }, ...extra } });
  }
  return { bridge, sent, options, start, usage, end, durable, session, agent,
    tick: (ms = 1000) => { clock += ms; timer(); },
    now: () => clock, canceled: () => canceled };
}

test('bundle uses actual installed DSH metadata and no install scripts or dependencies', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'plugins/jiuliu-dsh/package.json')));
  assert.equal(manifest.name, '@jiuliu/dsh-token-bridge');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.dependencies, undefined);
  const patch = await readFile(path.join(root, 'plugins/jiuliu-dsh/cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:/);
  assert.match(patch, /name: '@jiuliu\/dsh-token-bridge'/);
});

test('cumulative stream usage and durable settlement count only real positive deltas', async () => {
  const h = harness(await plugin);
  try {
    await drain();
    h.start(); h.usage(4); h.usage(4); h.usage(3);
    h.tick(); await drain();
    h.usage(11);
    // Real DSH ordering: session/event commits before stream end.
    h.durable(7, 11); h.end(); h.durable(7, 11);
    h.tick(); await drain();
    assert.deepEqual(h.sent.map(event => event.tokens), [0, 4, 7]);
    assert.equal(h.sent.reduce((sum, event) => sum + event.tokens, 0), 11);
  } finally { h.bridge.dispose(); }
});

test('retries in the same step are distinct attempts and partial output remains counted', async () => {
  const h = harness(await plugin);
  try {
    h.start(); h.usage(8);
    h.durable(7, undefined, 'assistant/attempt', { usage: undefined, stream: [{ type: 'chunk', time: h.now(), chunk: { type: 'usage', usage: { outputTokens: 8, inputTokens: 99 } } }] });
    h.end();
    h.bridge.durable(h.session, { type: 'llm/retry-started', seq: 8, data: { turn: 1, step: 1 } });
    h.start(2); h.usage(5, 2); h.durable(9, 5); h.end(2, 9);
    h.tick(); await drain();
    assert.equal(h.sent.reduce((sum, event) => sum + event.tokens, 0), 13);
    h.start(3, 2, 1); h.usage(2, 3);
    h.bridge.stream({ agent: h.agent, frame: { type: 'end', attemptId: `${h.session.id}:3`, revision: 44, index: 2, outcome: { kind: 'abandoned' } } });
    h.tick(); await drain();
    assert.equal(h.sent.reduce((sum, event) => sum + event.tokens, 0), 15);
  } finally { h.bridge.dispose(); }
});

test('durable-only final usage and attempt stream fallback deduplicate', async () => {
  const h = harness(await plugin);
  try {
    h.durable(10, 9); h.durable(10, 9); h.durable(11, 9);
    h.bridge.durable(h.session, { type: 'llm/retry-started', seq: 12, data: { turn: 1, step: 1 } });
    h.durable(13, undefined, 'assistant/attempt', { usage: undefined, stream: [{ type: 'text-chunks', time0: h.now(), index: 0, dt: [], texts: ['private'] }, { type: 'chunk', time: h.now(), chunk: { type: 'usage', usage: { outputTokens: 6 } } }] });
    h.tick(); await drain();
    assert.equal(h.sent.reduce((sum, event) => sum + event.tokens, 0), 15);
  } finally { h.bridge.dispose(); }
});

test('mounting mid-attempt binds first usage to later durable position', async () => {
  const h = harness(await plugin);
  try {
    h.usage(12); h.durable(7, 12); h.end(); h.tick(); await drain();
    assert.equal(h.sent.reduce((sum, event) => sum + event.tokens, 0), 12);
  } finally { h.bridge.dispose(); }
});

test('missing or invalid provider usage never gets estimated from output or command activity', async () => {
  const h = harness(await plugin);
  try {
    await drain();
    h.start();
    for (const count of [undefined, null, '12', -1, 1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) h.usage(count);
    for (const chunk of [{ type: 'text-delta', text: 'a'.repeat(10000), index: 0 }, { type: 'reasoning-delta', text: 'thinking', index: 1 }, { type: 'tool-call-delta', argumentsDelta: '{"private":true}', index: 2 }, { type: 'finish', reason: 'stop' }]) {
      h.bridge.stream({ agent: h.agent, frame: { type: 'chunk', attemptId: `${h.session.id}:1`, revision: 25, chunk } });
    }
    h.bridge.durable(h.session, { type: 'tool/end', seq: 6, data: { outputTokens: 99 } });
    h.tick(6000); await drain();
    assert.deepEqual(h.sent.map(event => event.tokens), [0]);
    h.durable(7, undefined, 'assistant/message', { usage: undefined }); h.end();
    h.tick(5000); await drain();
    assert.deepEqual(h.sent.map(event => event.tokens), [0, 0]);
  } finally { h.bridge.dispose(); }
});

test('payload has only opaque eventId, integer output delta and local arrival time', async () => {
  const h = harness(await plugin);
  try {
    h.start(); h.usage(31, 1, { inputTokens: 999999, cacheWriteTokens: 888888, provider: 'private-provider' }); h.tick(); await drain();
    for (const body of h.sent) {
      assert.deepEqual(Object.keys(body).sort(), ['eventId', 'time', 'tokens']);
      assert.match(body.eventId, /^[A-Za-z0-9_.:-]{1,128}$/);
      assert.equal(body.time, h.now() - (body.tokens === 0 ? 1000 : 0));
      assert.doesNotMatch(JSON.stringify(body), /private|999999|888888|provider|session|prompt/);
    }
    assert.equal(new Set(h.sent.map(body => body.eventId)).size, h.sent.length);
    assert.equal(h.options[0].hostname, '127.0.0.1');
    assert.equal(h.options[0].path, '/api/dsh-tokens');
    assert.equal(h.options[0].agent, false);
  } finally { h.bridge.dispose(); }
});

test('HTTP retry preserves event id and bounded queue never blocks generation', async () => {
  const module = await plugin;
  let tick, clock = 1000, timeoutFn, destroyCount = 0;
  const bodies = [];
  const bridge = module.createTokenBridge({}, { now: () => clock,
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
    setTimeout: fn => { timeoutFn = fn; return 2; }, clearTimeout() {},
    request() { const req = new EventEmitter(); req.destroy = () => { destroyCount++; }; req.end = body => bodies.push(JSON.parse(body)); return req; }
  });
  try {
    await drain();
    const agent = { session: { id: 'secret' } };
    for (let i = 1; i <= 1000; i++) {
      bridge.stream({ agent, frame: { type: 'chunk', attemptId: 'attempt', chunk: { type: 'usage', usage: { outputTokens: i } } } });
      clock += 1000; tick();
    }
    assert.ok(bridge.status().queued <= 128);
    assert.ok(bridge.status().dropped > 0);
    // The old initial request has aged out, so retry gets dropped, not redated.
    timeoutFn(); await drain();
    assert.ok(destroyCount > 0);
  } finally { bridge.dispose(); }
  let attempts = 0;
  const h = harness({ createTokenBridge(config, runtime) {
    return module.createTokenBridge(config, { ...runtime, request(options, callback) {
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = body => {
        bodies.push(JSON.parse(body));
        queueMicrotask(() => {
          if (++attempts === 1) req.emit('error', new Error('response lost'));
          else { const res = new EventEmitter(); res.statusCode = 204; res.resume = () => res.emit('end'); callback(res); }
        });
      };
      return req;
    } });
  } });
  try { await drain(); assert.equal(attempts, 2); assert.deepEqual(bodies.at(-1), bodies.at(-2)); } finally { h.bridge.dispose(); }
});

test('unavailable service, malformed frames and redirect responses do not throw or follow redirects', async () => {
  const h = harness(await plugin, 302);
  try {
    for (const value of [undefined, null, {}, { agent: {}, frame: {} }, { frame: { type: 'chunk', attemptId: 'x' } }]) assert.doesNotThrow(() => h.bridge.stream(value));
    h.start(); h.usage(2); h.tick(); await drain();
    assert.equal(h.sent.length, 2);
    assert.equal(h.bridge.status().queued, 0);
  } finally { h.bridge.dispose(); }
  const module = await plugin;
  const bridge = module.createTokenBridge({}, { request() { throw new Error('ECONNREFUSED'); } });
  await drain();
  bridge.dispose();
  assert.equal(bridge.status().disposed, true);
});

test('bounded per-session state and disposal release all work', async () => {
  const h = harness(await plugin);
  for (let i = 0; i < 1000; i++) h.bridge.stream({ agent: { session: { id: `session-${i}` } }, frame: { type: 'start', attemptId: `attempt-${i}`, turn: 1, step: 1 } });
  assert.ok(h.bridge.status().sessions <= 128);
  h.bridge.dispose(); h.bridge.dispose();
  h.tick(); await drain();
  assert.equal(h.canceled(), 1);
  assert.deepEqual(h.bridge.status(), { sessions: 0, queued: 0, pendingTokens: 0, dropped: 0, disposed: true });
});

test('Cordis apply registers real listener signatures and owns cleanup in an effect', async () => {
  const { apply } = await plugin;
  const listeners = new Map(), disposers = [], removed = [];
  const ctx = { effect(fn) { disposers.push(fn()); }, on(name, callback, opts) { listeners.set(name, callback); assert.equal(opts.global, true); return () => { removed.push(name); listeners.delete(name); }; } };
  apply(ctx);
  assert.equal(listeners.size, 2);
  assert.equal(typeof listeners.get('agent/assistant-stream'), 'function');
  assert.equal(typeof listeners.get('session/event'), 'function');
  for (const dispose of disposers) dispose();
  await drain();
  assert.deepEqual(removed.sort(), ['agent/assistant-stream', 'session/event']);
});

test('final usage corrections add only the unseen remainder and agent lifecycles can restart counters', async () => {
  const h = harness(await plugin);
  try {
    h.start(); h.usage(4); h.durable(7, 9); h.end();
    // A replaced Agent may restart its attempt counter for the same Session.
    const replacement = { session: h.session };
    h.bridge.stream({ agent: replacement, frame: { type: 'start', attemptId: `${h.session.id}:1`, turn: 2, step: 1 } });
    h.bridge.stream({ agent: replacement, frame: { type: 'chunk', attemptId: `${h.session.id}:1`, chunk: { type: 'usage', usage: { outputTokens: 3 } } } });
    h.bridge.durable(h.session, { type: 'assistant/message', seq: 8, data: { turn: 2, step: 1, usage: { outputTokens: 3 } } });
    h.tick(); await drain();
    assert.equal(h.sent.reduce((sum, event) => sum + event.tokens, 0), 12);
  } finally { h.bridge.dispose(); }
});

test('long unknown active requests do not expire into measured zero', async () => {
  const h = harness(await plugin);
  try {
    await drain(); h.start(); h.tick(301000); await drain();
    assert.deepEqual(h.sent.map(event => event.tokens), [0]);
    h.usage(7); h.tick(); await drain();
    assert.equal(h.sent.at(-1).tokens, 7);
  } finally { h.bridge.dispose(); }
});

test('bridge payload feeds the shared real token sampler without cumulative inflation', async () => {
  const { createTokenTelemetry } = require('../system-telemetry.cjs');
  const h = harness(await plugin);
  const sampler = createTokenTelemetry({ now: h.now });
  let consumed = 0;
  function sample() {
    for (; consumed < h.sent.length; consumed++) sampler.record(h.sent[consumed]);
    return sampler.sample(h.now()).telemetry.dshTokens;
  }
  try {
    await drain(); assert.equal(sample().value, 0);
    h.start(); h.usage(5); h.tick(); await drain();
    assert.deepEqual(sample(), { status: 'available', value: 5, time: h.now(), unit: 'tokens/s', source: 'dsh-token-events' });
    h.usage(12); h.durable(7, 12); h.end(); h.tick(); await drain();
    assert.equal(sample().value, 7);
    // A lost response retry reuses one payload; service dedup accepts it once.
    assert.equal(sampler.record(h.sent.at(-1)).duplicate, true);
    h.bridge.dispose(); h.tick(16000);
    assert.equal(sampler.sample(h.now()).telemetry.dshTokens.status, 'stale');
  } finally { h.bridge.dispose(); }
});

test('native HTTP transport posts the expected loopback contract', async () => {
  const { createTokenBridge } = await plugin;
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', part => { raw += part; });
    req.on('end', () => { bodies.push(JSON.parse(raw)); res.writeHead(204); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridge = createTokenBridge({ port: server.address().port });
  try {
    await new Promise((resolve, reject) => {
      const limit = setTimeout(() => reject(new Error('No heartbeat received')), 1500);
      server.once('request', () => { clearTimeout(limit); resolve(); });
    });
    await drain();
    assert.equal(bodies[0].tokens, 0);
  } finally {
    bridge.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
