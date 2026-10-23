'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createService, createCpuSampler } = require('../server.cjs');

test('selected real candle frames and long/short fill journal share atomic service state', async t => {
  let time = 120000;
  const { port, post } = await fixture(t, { now: () => time });
  await post('/api/action', { action: 'automation', automation: { enabled: false } });
  assert.deepEqual((await request(port, '/api/state')).json.chartHistory.markets, {});
  assert.equal((await request(port, '/api/state?timeframe=week')).status, 400);
  assert.equal((await request(port, '/api/state?timeframe=minute&timeframe=hour')).status, 400);
  await post('/api/action', { action: 'add', instrument: { id: 'OHLC', name: 'Observed test' } });
  for (const value of [100, 80, 110, 90]) { await post('/api/samples', { samples: [{ id: 'OHLC', time, value }] }); time += 1000; }
  let state = (await request(port, '/api/state?timeframe=minute')).json;
  assert.deepEqual(state.chartHistory.markets.OHLC, [{ time: 120000, open: 100, high: 110, low: 80, close: 90, count: 4 }]);
  assert.equal(state.chartHistory.timeframe, 'minute');
  const opened = await post('/api/action', { action: 'short', symbol: 'OHLC', quantity: 10, options: { leverage: 2 } });
  assert.equal(opened.status, 200); assert.equal(opened.json.game.positions.OHLC.side, 'short');
  const beforeReject = (await request(port, '/api/state')).text;
  assert.equal((await post('/api/action', { action: 'cover', symbol: 'OHLC', price: 1 })).status, 400);
  assert.equal((await request(port, '/api/state')).text, beforeReject);
  time += 1000; await post('/api/samples', { samples: [{ id: 'OHLC', time, value: 70 }] });
  const covered = await post('/api/action', { action: 'cover', symbol: 'OHLC' });
  assert.equal(covered.status, 200); assert.equal(covered.json.chartHistory.trades.at(-1).action, 'cover');
  assert.equal(covered.json.chartHistory.trades.at(-1).realizedPnl, 200);
  await post('/api/action', { action: 'buy', symbol: 'OHLC', quantity: 1 }); await post('/api/action', { action: 'sell', symbol: 'OHLC' });
  state = (await request(port, '/api/state?timeframe=hour')).json;
  assert.equal(state.chartHistory.intervalMs, 3600000);
  assert.deepEqual(state.chartHistory.trades.map(trade => [trade.action, trade.side]), [['short', 'short'], ['cover', 'short'], ['buy', 'long'], ['sell', 'long']]);
  assert.equal(new Set(state.chartHistory.trades.map(trade => trade.id)).size, 4);
  assert.deepEqual(state.chartHistory.markets.OHLC, [{ time: 0, open: 100, high: 110, low: 70, close: 70, count: 5 }]);
  const reset = await post('/api/action', { action: 'bankruptcy' });
  assert.equal(reset.json.chartHistory.episode, 2); assert.equal(reset.json.chartHistory.trades.length, 4);
  for (const frame of ['minute', 'hour', 'day']) {
    const response = (await request(port, `/api/state?timeframe=${frame}`)).json;
    assert.deepEqual(response.tradeDiary, reset.json.tradeDiary);
    assert.equal(response.tradeDiary.entries[0].direction, 'open');
    assert.equal(response.tradeDiary.entries[0].realizedPnl, undefined);
    assert.equal(response.tradeDiary.entries[0].leverage, 2);
    assert.equal(response.tradeDiary.entries[1].interest, 0);
    assert.equal(response.tradeDiary.entries[1].realizedPnl, 200);
    assert.equal(response.tradeDiary.entries[1].pnlBasis, 'net-position-interest');
    const selected = response.chartHistory;
    assert.equal(selected.equity.length, 1); assert.equal(selected.equity[0].high, 0); assert.equal(selected.equity[0].low, 0); assert.equal(selected.markets.OHLC.length, 1);
  }
});

test('journal exceeds engine event retention and restores without duplicated candle seeds', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-candles-test-'));
  t.after(async () => { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'kurumi-candles-test-'))); await fs.rm(dir, { recursive: true, force: true }); });
  const statePath = path.join(dir, 'state.json'); let time = 1700000000000;
  const first = await fixture(t, { statePath, now: () => time });
  await first.post('/api/action', { action: 'automation', automation: { enabled: false } });
  await first.post('/api/action', { action: 'add', instrument: { id: 'JOURNAL', name: 'Journal test' } });
  await first.post('/api/samples', { samples: [{ id: 'JOURNAL', time, value: 10 }] });
  for (let n = 0; n < 60; n++) { await first.post('/api/action', { action: 'buy', symbol: 'JOURNAL', quantity: 1 }); await first.post('/api/action', { action: 'sell', symbol: 'JOURNAL' }); }
  const before = (await request(first.port, '/api/state')).json;
  assert.equal(before.game.events.length, 100); assert.equal(before.chartHistory.trades.length, 120);
  await first.service.stop(); assert.ok((await fs.stat(statePath)).size <= 2 * 1024 * 1024);
  time += 500;
  const second = await fixture(t, { statePath, now: () => time });
  const after = (await request(second.port, '/api/state')).json; assert.deepEqual(after.chartHistory, before.chartHistory); assert.deepEqual(after.tradeDiary, before.tradeDiary);
  await second.post('/api/samples', { samples: [{ id: 'JOURNAL', time, value: 11 }] });
  const traded = await second.post('/api/action', { action: 'short', symbol: 'JOURNAL', quantity: 1 });
  assert.equal(traded.status, 200); assert.equal(traded.json.chartHistory.trades.length, 121); assert.equal(traded.json.chartHistory.markets.JOURNAL[0].count, 2);
  await second.service.stop();
  const damaged = JSON.parse(await fs.readFile(statePath, 'utf8')); const cash = damaged.game.cash;
  damaged.candleHistory.frames.minute.markets.JOURNAL[0][2] = -100; await fs.writeFile(statePath, JSON.stringify(damaged));
  const third = await fixture(t, { statePath, now: () => time }); const recovered = (await request(third.port, '/api/state')).json;
  assert.equal(recovered.game.cash, cash); assert.equal(recovered.game.positions.JOURNAL.side, 'short'); assert.equal(recovered.chartHistory.partialHistory, true);
});

test('actual automated buys and short liquidations enter the independent journal once', async t => {
  let time = 200000;
  const { port, post, service } = await fixture(t, { now: () => time });
  await post('/api/action', { action: 'add', instrument: { id: 'FILL', name: 'Fill test' } });
  await post('/api/action', { action: 'automation', automation: { enabled: true, autoBorrow: false, strategy: 'dca', everyTicks: 1, budgetFraction: 0.1 } });
  await post('/api/samples', { samples: [{ id: 'FILL', time, value: 100 }] });
  time += 10000; await post('/api/samples', { samples: [{ id: 'FILL', time, value: 100 }] });
  time += 10000; await post('/api/samples', { samples: [{ id: 'FILL', time, value: 100 }] });
  await service.sample();
  let state = (await request(port, '/api/state')).json;
  assert.equal(state.chartHistory.trades.filter(trade => trade.instrumentId === 'FILL' && trade.action === 'buy').length, 1);
  await post('/api/action', { action: 'automation', automation: { enabled: false } });
  await post('/api/action', { action: 'sell', symbol: 'FILL' });
  await post('/api/action', { action: 'short', symbol: 'FILL', quantity: 10, options: { leverage: 2 } });
  time += 1000; await post('/api/samples', { samples: [{ id: 'FILL', time, value: 200 }] });
  state = (await request(port, '/api/state')).json;
  assert.equal(state.game.positions.FILL, undefined);
  assert.equal(state.chartHistory.trades.at(-1).action, 'cover'); assert.equal(state.chartHistory.trades.at(-1).side, 'short'); assert.equal(state.chartHistory.trades.at(-1).price, 200);
  const count = state.chartHistory.trades.length; await post('/api/action', { action: 'personality', personality: { curiosity: 0.2 } });
  assert.equal((await request(port, '/api/state')).json.chartHistory.trades.length, count);
});

test('service bankruptcy preserves old losses while debt relief opens a separate zero episode', async t => {
  let time = 100000;
  const { port, post } = await fixture(t, { now: () => time });
  assert.equal((await post('/api/action', { action: 'borrow', amount: 99999 })).status, 400);
  assert.equal((await post('/api/action', { action: 'borrow', amount: 3000001 })).status, 400);
  const financed = await post('/api/action', { action: 'borrow', amount: 100000 });
  assert.equal(financed.json.game.credit.unlimited, true);
  await post('/api/action', { action: 'add', instrument: { id: 'LOSS', name: '实际采样测试' } });
  await post('/api/samples', { samples: [{ id: 'LOSS', value: 100, time }] });
  await post('/api/action', { action: 'buy', symbol: 'LOSS', quantity: 1000 });
  time += 1000;
  await post('/api/samples', { samples: [{ id: 'LOSS', value: 10, time }] });
  const before = (await request(port, '/api/state')).json;
  assert.equal(before.performance.current.pnl, -90000);
  const result = await post('/api/action', { action: 'bankruptcy' });
  assert.equal(result.status, 200);
  const state = result.json;
  assert.equal(state.game.cash, 0); assert.equal(state.game.loanBalance, 0);
  assert.equal(state.game.initialCash, 0); assert.deepEqual(state.game.positions, {});
  assert.equal(state.game.automation.enabled, false);
  assert.equal(state.game.bankruptcyLedger.count, 1);
  assert.equal(state.game.bankruptcyLedger.totalCrystallizedLoss, 90000);
  assert.equal(state.performance.lastRun.pnl, -90000);
  assert.equal(state.performance.episode, 2);
  assert.equal(state.performance.current.equity, 0); assert.equal(state.performance.current.pnl, 0);
  assert.equal(state.performance.current.returnPct, null);
  assert.deepEqual(state.game.instruments, before.game.instruments);
  const again = await post('/api/action', { action: 'borrow', amount: 3000000 });
  assert.equal(again.json.game.cash, 3000000);
  assert.equal(again.json.performance.current.pnl, 0);
  assert.equal(again.json.performance.episode, 2);
  const toggle = await post('/api/action', { action: 'automation', automation: { autoBorrow: false } });
  assert.equal(toggle.status, 200);
  assert.equal(toggle.json.game.automation.autoBorrow, false);
});

test('bankruptcy ledger and performance episode survive shutdown and service migration', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-bankruptcy-test-'));
  t.after(async () => { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'kurumi-bankruptcy-test-'))); await fs.rm(dir, { recursive: true, force: true }); });
  const statePath = path.join(dir, 'state.json');
  let time = Date.now();
  const first = await fixture(t, { statePath, now: () => time });
  await first.post('/api/action', { action: 'borrow', amount: 3000000 });
  const reset = await first.post('/api/action', { action: 'bankruptcy' });
  await first.service.stop();
  assert.ok((await fs.stat(statePath)).size <= 512 * 1024);
  time += 60000;
  const second = await fixture(t, { statePath, now: () => time });
  const loaded = (await request(second.port, '/api/state')).json;
  assert.deepEqual(loaded.game.bankruptcyLedger, reset.json.game.bankruptcyLedger);
  assert.deepEqual(loaded.performance, reset.json.performance);
  assert.equal(loaded.game.automation.enabled, false);
  assert.equal(loaded.game.credit.unlimited, true);
  const borrowed = await second.post('/api/action', { action: 'borrow', amount: 100000 });
  assert.equal(borrowed.json.performance.current.pnl, 0);
  assert.equal(borrowed.json.performance.episode, 2);
});

test('account performance starts empty, records actions and does not stale unheld sources', async t => {
  let time = 100000;
  const { service, port, post } = await fixture(t, { now: () => time });
  const initial = (await request(port, '/api/state')).json.performance;
  assert.equal(initial.startedAt, null); assert.equal(initial.current, null); assert.deepEqual(initial.points, []);
  let result = await post('/api/action', { action: 'borrow', amount: 100000 });
  assert.equal(result.json.performance.current.equity, 10000);
  assert.equal(result.json.performance.current.pnl, 0);
  assert.equal(result.json.performance.current.stale, false);
  result = await post('/api/action', { action: 'repay', amount: 100000 });
  assert.equal(result.json.performance.points.length, 1);
  assert.equal(result.json.performance.current.returnPct, 0);
  await post('/api/action', { action: 'add', instrument: { id: 'OWN', name: '持仓测试' } });
  await post('/api/samples', { samples: [{ id: 'OWN', value: 100, time }] });
  await post('/api/action', { action: 'buy', symbol: 'OWN', quantity: 1 });
  time += 1000;
  result = await post('/api/samples', { samples: [{ id: 'OWN', value: 110, time }] });
  assert.equal(result.json.performance.current.pnl, 10);
  assert.equal(result.json.performance.points.length, 1);
  const rejected = await post('/api/action', { action: 'buy', symbol: 'OWN', quantity: 1e9 });
  assert.equal(rejected.status, 400);
  assert.deepEqual((await request(port, '/api/state')).json.performance, result.json.performance);
  time += 20000;
  const stale = await service.sample();
  assert.equal(stale.performance.current.stale, true);
  const widget = (await request(port, '/api/widget-state')).json;
  assert.equal(widget.sampledAt, time);
  assert.equal(widget.equityStale, true);
  assert.equal(widget.equity, stale.performance.current.equity);
  assert.equal(stale.performance.points.length, 2);
  assert.equal(stale.performance.startedAt, 100000);
  assert.deepEqual(stale.performance.points.map(p => p.time), [101000, 121000]);
});

test('performance persists with account and malformed history cannot reset money', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-performance-test-'));
  t.after(async () => { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'kurumi-performance-test-'))); await fs.rm(dir, { recursive: true, force: true }); });
  const statePath = path.join(dir, 'state.json');
  let time = Date.now();
  const first = await fixture(t, { statePath, now: () => time });
  await first.post('/api/action', { action: 'borrow', amount: 100000 });
  const expected = (await request(first.port, '/api/state')).json;
  await first.service.stop();
  const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.deepEqual(saved.performance, expected.performance);
  assert.ok((await fs.stat(statePath)).size <= 512 * 1024);
  time += 60000;
  const second = await fixture(t, { statePath, now: () => time });
  const restored = (await request(second.port, '/api/state')).json;
  assert.deepEqual(restored.performance, expected.performance);
  assert.equal(restored.game.cash, expected.game.cash);
  await second.service.stop();
  saved.performance = { ...saved.performance, baseline: -1, points: 'invalid' };
  await fs.writeFile(statePath, JSON.stringify(saved));
  const third = await fixture(t, { statePath, now: () => time });
  const recovered = (await request(third.port, '/api/state')).json;
  assert.equal(recovered.game.cash, expected.game.cash);
  assert.equal(recovered.game.loanBalance, 100000);
  assert.deepEqual(recovered.performance.points, []);
  assert.equal(recovered.performance.startedAt, null);
  assert.equal(recovered.performance.current, null);
});

test('DSH deltas deduplicate and removed default markets stay absent', async t => {
  let time = 100000;
  const { service, post, port } = await fixture(t, { now: () => time });
  const initial = (await request(port, '/api/state')).json;
  assert.deepEqual(initial.game.instruments.map(i => i.id), ['CPU', 'MEM', 'LOAD', 'MOUSE_DISTANCE', 'MOUSE_CLICKS', 'KEYBOARD', 'THREADS', 'CONNECTIONS', 'DSH']);
  for (let n = 0; n < 2; n++) assert.equal((await post('/api/dsh-tokens', { eventId: 'request1', tokens: 100 })).status, 200);
  assert.equal((await post('/api/dsh-tokens', { eventId: 'request1', tokens: 101 })).status, 400);
  time += 1000;
  const sample = await service.sample();
  assert.equal(sample.telemetry.dshTokens.value, 100);
  assert.equal(sample.game.instruments.find(i => i.id === 'DSH').price, 100);
  assert.equal((await post('/api/samples', { peripheral: true, samples: [{ id: 'DSH', value: 999, time: time + 1 }] })).status, 400);
});

test('retired legacy positions settle at saved price without changing equity', async t => {
  const E = require('../pet-engine.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-migration-test-'));
  t.after(async () => { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'kurumi-migration-test-'))); await fs.rm(dir, { recursive: true, force: true }); });
  const statePath = path.join(dir, 'state.json');
  const game = E.createGame({ mode: 'live', startTime: 0, instruments: ['CPU', 'MEM', 'LOAD', 'CODEX', 'CLAUDE', 'DSH', 'MOUSE_BATTERY', 'MOUSE_FREQUENCY'].map(id => ({ id, price: 0 })) });
  game.cash = 10;
  game.instruments.find(i => i.id === 'CODEX').price = 1;
  game.positions.CODEX = { instrumentId: 'CODEX', quantity: 10, debt: 30, margin: 10, avgPrice: 4 };
  const before = E.equity(game);
  await fs.writeFile(statePath, JSON.stringify({ version: 1, game: game.snapshot() }));
  const { port } = await fixture(t, { statePath });
  const restored = (await request(port, '/api/state')).json.game;
  assert.equal(E.equity(restored), before);
  assert.equal(restored.cash, 0);
  assert.equal(restored.loanBalance, 10);
  assert.equal(restored.positions.CODEX, undefined);
  assert.equal(restored.instruments.some(i => i.id === 'CODEX'), false);
  assert.equal(restored.instruments.find(i => i.id === 'DSH').category, 'token-rate-v1');
  assert.ok(restored.events.some(e => e.type === 'instrument-migrated'));
});

test('unavailable system collector invalidates previously sampled quotes', async t => {
  let time = Date.now(), valid = true, calls = 0;
  const provider = { cpus: () => [{ times: { idle: ++calls * 50, user: calls * 50 } }], totalmem: () => valid ? 100 : 0, freemem: () => 50, platform: () => 'darwin', loadavg: () => [1, 1, 1] };
  const { service, post } = await fixture(t, { os: provider, now: () => time });
  await service.sample();
  assert.equal((await post('/api/action', { action: 'buy', symbol: 'MEM', quantity: 1 })).status, 200);
  valid = false; time += 1000;
  const state = await service.sample();
  assert.equal(state.game.instruments.find(i => i.id === 'MEM').stale, true);
  assert.equal((await post('/api/action', { action: 'buy', symbol: 'MEM', quantity: 1 })).status, 400);
  assert.equal((await post('/api/action', { action: 'sell', symbol: 'MEM' })).status, 400);
  valid = true; time += 1000; await service.sample();
  assert.equal((await post('/api/action', { action: 'sell', symbol: 'MEM' })).status, 200);
});

function request(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString();
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, buffer });
      });
    });
    req.on('error', reject); req.end(data);
  });
}
async function fixture(t, options = {}) {
  const service = createService({ statePath: null, systemTelemetry: { sample: async () => ({ samples: [], telemetry: {} }) }, ...options });
  const { port } = await service.start(0);
  t.after(() => service.stop());
  const post = (url, body, headers) => request(port, url, { method: 'POST', body, headers });
  return { service, port, post };
}

test('agent lifecycle events capture short commands and expire without fabricated zeros', async t => {
  let time = 100000;
  const { service, port, post } = await fixture(t, { now: () => time });
  const event = kind => post('/api/agent-events', { agent: 'codex', sessionId: 'test-command', event: kind });
  const start = await event('start');
  assert.equal(start.status, 200);
  assert.equal(start.json.telemetry.codexActivity.value, 1);
  time += 100;
  const stop = await event('stop');
  assert.equal(stop.status, 200);
  assert.equal(stop.json.game.instruments.some(i => ['CODEX', 'CLAUDE'].includes(i.id)), false);
  assert.equal(stop.json.telemetry.codexActivity.value, 0);
  assert.equal((await post('/api/samples', { samples: [{ id:'CODEX',value:1,time:time+1 }] })).status,400);
  assert.equal((await post('/api/agent-events', {agent:'codex',sessionId:'x',event:'start'},{Origin:'https://untrusted.test'})).status,403);
  time += 16000;
  const expired = await service.sample();
  assert.equal(expired.telemetry.codexActivity.status, 'stale');
  assert.equal(expired.game.instruments.some(i => i.id === 'CODEX'), false);
  assert.equal((await event('heartbeat')).status,400);
  time += 1;
  assert.equal((await event('start')).status,200);
  const state = (await request(port,'/api/state')).json;
  assert.equal(state.telemetry.codexActivity.activeSessions,1);
  assert.equal(state.telemetry.codexActivity.source,'agent-command-lifecycle');
});

test('peripheral readings preserve real zero and explicit unavailable states atomically', async t => {
  let time = 200000;
  const { post, port } = await fixture(t,{now:()=>time});
  const send = body => post('/api/peripherals',body);
  const reading = await send({samples:[{id:'MOUSE_CLICKS',value:0,time},{id:'MOUSE_DISTANCE',value:75,time}]});
  assert.equal(reading.status,200);
  assert.equal(reading.json.telemetry.mouseClicks.value,0);
  assert.equal(reading.json.telemetry.mouseClicks.unit,'clicks/s');
  assert.equal(reading.json.telemetry.mouseDistance.source,'macos-pointer-distance');
  time += 1000;
  const missing = await send({unavailable:[{id:'MOUSE_CLICKS',reason:'permission-required'},{id:'MOUSE_DISTANCE',reason:'no-device'}]});
  assert.equal(missing.status,200);
  assert.equal(missing.json.telemetry.mouseClicks.value,null);
  assert.equal(missing.json.telemetry.mouseClicks.reason,'permission-required');
  assert.equal(missing.json.game.instruments.find(i=>i.id==='MOUSE_DISTANCE').stale,true);
  assert.equal(missing.json.game.instruments.find(i=>i.id==='MOUSE_DISTANCE').price,75);
  const before = (await request(port,'/api/state')).text;
  assert.equal((await send({samples:[{id:'MOUSE_DISTANCE',value:-1,time}]})).status,400);
  assert.equal((await send({samples:[{id:'MOUSE_DISTANCE',value:20,time}],unavailable:[{id:'MOUSE_CLICKS',reason:'invented'}]})).status,400);
  assert.equal((await send({samples:[{id:'CPU',value:20,time}]})).status,400);
  assert.equal((await request(port,'/api/state')).text,before);
  assert.equal((await send({samples:[{id:'MOUSE_CLICKS',value:4,time}]})).status,200);
});

test('widget summary is read-only, compact and preserves unavailable measurements', async t => {
  const { service, port } = await fixture(t);
  const initial = await request(port,'/api/widget-state');
  assert.equal(initial.status,200);
  assert.equal(initial.json.cpu,null);
  assert.equal(initial.json.memory,null);
  assert.ok(initial.text.length<1024);
  await service.sample();
  const summary = (await request(port,'/api/widget-state')).json;
  const state = (await request(port,'/api/state')).json;
  assert.equal(summary.memory,state.telemetry.memory.value);
  assert.equal(summary.sampledAt,state.telemetry.sampledAt);
  assert.equal(summary.cash,state.game.cash);
  assert.equal(Object.hasOwn(summary,'instruments'),false);
  assert.equal((await request(port,'/api/widget-state',{headers:{Host:'foreign.test'}})).status,403);
});

test('CPU is interval delta, including real zero and reset/unavailable', () => {
  let times = { idle: 50, user: 50, sys: 0 };
  const sample = createCpuSampler({ cpus: () => [{ times }] });
  assert.equal(sample(), null);
  times = { idle: 150, user: 50, sys: 0 }; assert.equal(sample(), 0);
  times = { idle: 200, user: 100, sys: 0 }; assert.equal(sample(), 50);
  assert.equal(sample(), null);
  times = { idle: 1, user: 1, sys: 0 }; assert.equal(sample(), null);
});

test('live probe collects actual host values, preserving unavailable peripherals', async t => {
  const { service, port } = await fixture(t);
  const initial = (await request(port, '/api/state')).json;
  assert.equal(initial.game.mode, 'live');
  assert.equal(initial.telemetry.cpu.status, 'unavailable');
  await service.sample();
  const result = await request(port, '/api/state');
  assert.equal(result.status, 200);
  const { game, telemetry } = result.json;
  assert.equal(telemetry.memory.status, 'available');
  assert.ok(telemetry.memory.value >= 0 && telemetry.memory.value <= 100);
  assert.ok(Math.abs(telemetry.memory.value - (1 - os.freemem() / os.totalmem()) * 100) < 5);
  if (os.platform() !== 'win32') assert.ok(Math.abs(telemetry.load.value - os.loadavg()[0]) < 1);
  for (const name of ['mouseDistance', 'mouseClicks', 'codexActivity', 'claudeActivity', 'dshActivity']) {
    assert.equal(telemetry[name].status, 'unavailable');
    assert.equal(telemetry[name].value, null);
    if (game.indicators[name]) assert.equal(game.indicators[name].value, null);
  }
  assert.equal(game.instruments.find(i => i.id === 'MEM').price, telemetry.memory.value);
  assert.ok(game.instruments.every(i => i.history.length <= 120));
});

test('Host, Origin, fetch metadata, static allowlist and body bounds', async t => {
  const { port, post } = await fixture(t);
  assert.equal((await request(port, '/api/state', { headers: { Host: 'attacker.test' } })).status, 403);
  assert.equal((await post('/api/action', { action: 'borrow', amount: 100000 }, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await post('/api/action', { action: 'borrow', amount: 100000 }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const url of ['/server.cjs', '/data.js', '/README.md', '/assets/', '/vendor/', '/assets/%2e%2e/server.cjs', '/assets/%2f..%2fserver.cjs', '/.git/config']) {
    assert.equal((await request(port, url)).status, 404, url);
  }
  const html = await request(port, '/pet.html');
  assert.equal(html.status, 200);
  assert.match(html.headers['content-security-policy'], /object-src 'self'/);
  assert.match(html.headers['content-security-policy'], /frame-ancestors 'none'/);
  const actor = await request(port, '/assets/kurumi-generated-idle.png');
  assert.equal(actor.status, 200);
  assert.match(actor.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(actor.headers['content-security-policy'], /object-src 'self'/);
  assert.match(actor.headers['content-type'], /image\/png/);
  assert.equal((await request(port, '/assets/meme-generated-profit.png')).status, 200);
  assert.equal((await request(port, '/api/state', { method: 'OPTIONS' })).status, 404);
  assert.equal((await post('/api/action', '{')).status, 400);
  assert.equal((await post('/api/action', 'x'.repeat(33000))).status, 413);
  assert.equal((await post('/api/action', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/action', { action: 'borrow', amount: 100000 }, { Origin: `http://127.0.0.1:${port}` })).status, 200);
});

test('generated GIFs and videos serve correct types, bounded byte ranges and existing static guards', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-media-test-'));
  t.after(async () => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'kurumi-media-test-'))); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'assets', 'kurumi-gifs'), { recursive: true });
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  for (const ext of ['mov', 'webm', 'mp4']) await fs.writeFile(path.join(root, 'assets', `reaction.${ext}`), bytes);
  await fs.writeFile(path.join(root, 'assets', 'empty.mov'), '');
  await fs.writeFile(path.join(root, 'assets', 'kurumi-gifs', 'reaction.gif'), 'GIF89a');
  await fs.writeFile(path.join(root, 'pet.html'), '<video src="assets/reaction.mov"></video>');
  await fs.writeFile(path.join(root, 'pet-animation.js'), 'window.PetAnimation = {};');
  const privateFile = path.join(root, 'private.mov'); await fs.writeFile(privateFile, bytes);
  await fs.symlink(privateFile, path.join(root, 'assets', 'linked.mov'));
  const { port } = await fixture(t, { root: await fs.realpath(root) });
  for (const [ext, type] of [['mov', 'video/quicktime'], ['webm', 'video/webm'], ['mp4', 'video/mp4']]) {
    const full = await request(port, `/assets/reaction.${ext}`);
    assert.equal(full.status, 200); assert.equal(full.headers['content-type'], type); assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.headers['content-length'], '256'); assert.deepEqual(full.buffer, bytes);
    assert.match(full.headers['content-security-policy'], /media-src 'self'/);
  }
  for (const [range, start, end] of [['bytes=0-1', 0, 1], ['bytes=128-', 128, 255], ['bytes=-3', 253, 255], ['bytes=250-999', 250, 255], ['bytes=-999', 0, 255], ['bytes=255-255', 255, 255], ['bytes=1-999999999999999999999999999', 1, 255]]) {
    const part = await request(port, '/assets/reaction.mov', { headers: { Range: range } });
    assert.equal(part.status, 206, range); assert.equal(part.headers['content-range'], `bytes ${start}-${end}/256`); assert.equal(part.headers['content-length'], String(end - start + 1));
    assert.deepEqual(part.buffer, bytes.subarray(start, end + 1));
  }
  for (const range of ['bytes=256-', 'bytes=5-4', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'items=0-2', 'bytes=999999999999999999999999999-']) {
    const rejected = await request(port, '/assets/reaction.mov', { headers: { Range: range } });
    assert.equal(rejected.status, 416, range); assert.equal(rejected.headers['content-range'], 'bytes */256'); assert.equal(rejected.buffer.length, 0);
  }
  const conditional = await request(port, '/assets/reaction.mov', { headers: { Range: 'bytes=0-1', 'If-Range': '"unknown-version"' } });
  assert.equal(conditional.status, 200); assert.deepEqual(conditional.buffer, bytes);
  const head = await request(port, '/assets/reaction.mov', { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
  assert.equal(head.status, 200); assert.equal(head.headers['content-length'], '256'); assert.equal(head.headers['content-range'], undefined); assert.equal(head.buffer.length, 0);
  const empty = await request(port, '/assets/empty.mov'); assert.equal(empty.status, 200); assert.equal(empty.buffer.length, 0);
  assert.equal((await request(port, '/assets/empty.mov', { headers: { Range: 'bytes=0-' } })).status, 416);
  const gif = await request(port, '/assets/kurumi-gifs/reaction.gif'); assert.equal(gif.status, 200); assert.equal(gif.headers['content-type'], 'image/gif');
  assert.equal((await request(port, '/pet-animation.js')).status, 200);
  assert.match((await request(port, '/pet.html')).headers['content-security-policy'], /media-src 'self'/);
  assert.equal((await request(port, '/assets/linked.mov')).status, 404);
  assert.equal((await request(port, '/assets/%2f..%2fprivate.mov')).status, 404);
  assert.equal((await request(port, '/assets/reaction.mov', { headers: { Host: 'foreign.test' } })).status, 403);
  assert.equal((await request(port, '/assets/reaction.mov', { headers: { Origin: 'https://foreign.test' } })).status, 403);
  // A video GET must never use the full-file loader used for small static assets.
  const originalReadFile = fs.readFile;
  fs.readFile = async function(file, ...args) { if (String(file).endsWith('.mov')) throw new Error('Unbounded video read'); return originalReadFile.call(this, file, ...args); };
  try { assert.deepEqual((await request(port, '/assets/reaction.mov')).buffer, bytes); }
  finally { fs.readFile = originalReadFile; }
});

test('custom samples remain explicit, protected system prices and transactional actions', async t => {
  const { port, post } = await fixture(t);
  let result = await post('/api/action', { action: 'add', instrument: { id: 'AGENT', name: '用户推送', price: 99 } });
  assert.equal(result.status, 200);
  assert.equal(result.json.game.instruments.find(i => i.id === 'AGENT').price, 0);
  assert.equal((await post('/api/action', { action: 'buy', symbol: 'AGENT', quantity: 1 })).status, 400);
  const time = Date.now();
  assert.equal((await post('/api/samples', { samples: [{ id: 'CPU', value: 99, time }] })).status, 400);
  assert.equal((await post('/api/samples', { samples: [{ id: 'AGENT', value: -1, time }] })).status, 400);
  result = await post('/api/samples', { samples: [{ id: 'AGENT', value: 0, time }] });
  assert.equal(result.status, 200);
  assert.equal(result.json.game.instruments.find(i => i.id === 'AGENT').price, 0);
  assert.equal((await post('/api/samples', { samples: [{ id: 'AGENT', value: 10, time }] })).status, 400);
  assert.equal((await post('/api/samples', { samples: [{ id: 'AGENT', value: 10, time: time + 1 }] })).status, 200);
  assert.equal((await post('/api/action', { action: 'buy', symbol: 'AGENT', quantity: 1, options: { price: 0.01 } })).status, 400);
  result = await post('/api/action', { action: 'buy', symbol: 'AGENT', quantity: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.json.game.positions.AGENT.quantity, 1);
  const before = result.json.game.cash;
  assert.equal((await post('/api/action', { action: 'buy', symbol: 'AGENT', quantity: 1e9 })).status, 400);
  assert.equal((await request(port, '/api/state')).json.game.cash, before);
  assert.equal((await post('/api/action', { action: 'personality', values: { patience: 0.8 } })).json.game.personality.patience, 0.8);
  assert.equal((await post('/api/action', { action: 'automation', strategy: 'dip', enabled: true })).json.game.automation.strategy, 'dip');
  assert.equal((await post('/api/action', { action: 'say', text: '<script>hello</script>' })).json.message.text, '<script>hello</script>');
  assert.equal((await post('/api/action', { action: 'expression', name: 'happy' })).json.expression.name, 'happy');
});

test('concurrent actions serialize without losing cash or debt updates', async t => {
  const { port, post } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 10 }, () => post('/api/action', { action: 'borrow', amount: 100000 })));
  assert.ok(responses.every(r => r.status === 200));
  const { game } = (await request(port, '/api/state')).json;
  assert.equal(game.cash, 1010000);
  assert.equal(game.loanBalance, 1000000);
});

test('bounded state persists on shutdown and restores stale without off-line ticks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-server-test-'));
  // Explicitly created test directory, verified prefix before cleanup.
  t.after(async () => { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'kurumi-server-test-'))); await fs.rm(dir, { recursive: true, force: true }); });
  const statePath = path.join(dir, 'state.json');
  const first = await fixture(t, { statePath });
  await first.service.sample();
  await first.post('/api/action', { action: 'borrow', amount: 100000 });
  const before = (await request(first.port, '/api/state')).json.game;
  await assert.rejects(fs.stat(statePath), { code: 'ENOENT' });
  await first.service.stop();
  assert.ok((await fs.stat(statePath)).size < 512 * 1024);
  const legacy = JSON.parse(await fs.readFile(statePath, 'utf8'));
  legacy.game.instruments = legacy.game.instruments.filter(i => ['CPU', 'MEM', 'LOAD'].includes(i.id));
  legacy.game.automation.enabled = false;
  legacy.game.risk.maxLeverage = 5;
  await fs.writeFile(statePath, JSON.stringify(legacy));
  const second = await fixture(t, { statePath });
  const restored = (await request(second.port, '/api/state')).json.game;
  assert.equal(restored.cash, before.cash);
  assert.equal(restored.tickCount, before.tickCount);
  assert.ok(restored.instruments.every(i => i.stale));
});
