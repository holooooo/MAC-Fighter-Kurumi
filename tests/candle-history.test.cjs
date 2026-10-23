'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createCandleHistory, MAX_HISTORY_BYTES } = require('../candle-history.cjs');
const clock = () => 1800000000000;
const sample = (time, value, id = 'X') => ({ id, time, value });

test('trade diary persists enriched details and reports retention without inventing old costs', () => {
  const h = createCandleHistory({ now: clock });
  for (let n = 0; n < 505; n++) h.recordTrades([{ id: `fill:${n}`, time: n, instrumentId: 'X', action: 'sell', side: 'long', price: 110, quantity: 1, direction: 'close', notional: 110, interest: 0.5, grossPnl: 10, realizedPnl: 9.5, pnlBasis: 'net-position-interest', episode: 1 }]);
  const diary = h.diary(); assert.equal(diary.entries.length, 500); assert.equal(diary.limit, 500); assert.equal(diary.truncated, true);
  assert.equal(diary.startedAt, 0); assert.equal(diary.oldestRetainedAt, 5);
  const loaded = createCandleHistory({ now: clock, restored: h.snapshot() });
  assert.deepEqual(loaded.diary(), diary); loaded.recordTrades([diary.entries.at(-1)]); assert.deepEqual(loaded.diary(), diary);
  loaded.resetEquity(2, 1000); assert.deepEqual(loaded.diary(), diary);
  const legacy = h.snapshot(); delete legacy.diaryStartedAt; delete legacy.tradesTruncated;
  legacy.trades = [{ id: 'old:1', time: 1, instrumentId: 'X', action: 'sell', side: 'long', price: 100, quantity: 1, realizedPnl: 5 }];
  const old = createCandleHistory({ now: clock, restored: legacy }).diary().entries[0];
  assert.equal(old.realizedPnl, 5); assert.equal(old.pnlBasis, 'unknown'); assert.equal(old.interest, undefined); assert.equal(old.notional, undefined);
});

test('actual observations aggregate all frames, preserving zero, ranges, counts and real gaps', () => {
  const h = createCandleHistory({ now: clock });
  h.recordSamples([sample(61000, 10), sample(62000, 0), sample(63000, 15), sample(64000, 8), sample(240000, 2)]);
  assert.deepEqual(h.view().markets.X, [
    { time: 60000, open: 10, high: 15, low: 0, close: 8, count: 4 },
    { time: 240000, open: 2, high: 2, low: 2, close: 2, count: 1 }
  ]);
  assert.deepEqual(h.view('hour').markets.X, [{ time: 0, open: 10, high: 15, low: 0, close: 2, count: 5 }]);
  const before = h.snapshot(); h.recordSamples([sample(62000, 999)]); assert.deepEqual(h.snapshot(), before);
  assert.throws(() => h.view('week'));
  const detached = h.view(); detached.markets.X[0].high = 999; assert.equal(h.view().markets.X[0].high, 15);
});

test('local calendar days use local midnight across 23 and 25 hour DST days', () => {
  const modulePath = require.resolve('../candle-history.cjs');
  const result = JSON.parse(execFileSync(process.execPath, ['-e', `const {bucketStart,createCandleHistory}=require(${JSON.stringify(modulePath)});const times=['2026-03-08T12:00:00-04:00','2026-03-09T12:00:00-04:00','2026-11-01T12:00:00-05:00','2026-11-02T12:00:00-05:00'].map(Date.parse);const h=createCandleHistory({now:()=>Date.parse('2026-11-03T00:00:00Z')});h.recordSamples(times.map((time,i)=>({id:'X',time,value:i})));console.log(JSON.stringify({zone:h.view('day').timeZone,buckets:times.map(t=>bucketStart(t,'day')),bars:h.view('day').markets.X}));`], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }));
  assert.equal(result.zone, 'America/New_York');
  assert.equal(result.buckets[1] - result.buckets[0], 23 * 3600000);
  assert.equal(result.buckets[3] - result.buckets[2], 25 * 3600000);
  assert.equal(result.bars.length, 4);
});

test('migration aggregates full observed ten-second OHLC and seeds only once', () => {
  const h = createCandleHistory({ now: clock });
  const instruments = [{ id: 'X', sampleTime: 85000, history: [{ time: 60000, open: 4, high: 20, low: 1, close: 8, volume: 5 }], currentCandle: { time: 80000, open: 8, high: 12, low: 6, close: 10, volume: 2 } }];
  h.bootstrap(instruments, { points: [{ time: 65000, equity: -20, stale: true }] });
  assert.deepEqual(h.view().markets.X, [{ time: 60000, open: 4, high: 20, low: 1, close: 10, count: 7 }]);
  const saved = h.snapshot();
  const restored = createCandleHistory({ restored: saved, now: clock, instrumentIds: ['X'] });
  assert.equal(restored.restored, true); restored.bootstrap(instruments, {}); assert.deepEqual(restored.snapshot(), saved);
  restored.recordSamples([sample(85000, 999)]); assert.deepEqual(restored.snapshot(), saved);
});

test('strict malformed restores discard curves independently and reject malformed observations atomically', () => {
  const h = createCandleHistory({ now: clock }); h.recordSamples([sample(100000, 2)]); h.recordEquity({ time: 100000, value: -10 });
  for (const mutate of [s => { s.frames.minute.markets.X[0][2] = -1; }, s => { s.cursors.markets.X = Infinity; }, s => { s.extra = 1; }, s => { s.frames.hour.equity.push([...s.frames.hour.equity[0]]); }, s => { s.eventCursor = -1; }]) {
    const bad = h.snapshot(); mutate(bad); const fresh = createCandleHistory({ restored: bad, now: clock }); assert.equal(fresh.restored, false); assert.deepEqual(fresh.view().markets, {});
  }
  const before = h.snapshot(); assert.throws(() => h.recordSamples([sample(200000, 5), sample(200001, NaN)])); assert.deepEqual(h.snapshot(), before);
});

test('journal survives engine event rollover, deduplicates fills and preserves liquidation and short sides', () => {
  const h = createCandleHistory({ now: clock });
  for (let n = 0; n < 600; n++) h.recordEvents([{ id: `0:${n}`, type: n === 599 ? 'liquidation' : 'trade', time: 100000 + n, payload: { instrumentId: 'X', action: n % 2 ? 'cover' : 'short', side: 'short', quantity: 1, price: 10, realizedPnl: -1 } }], n + 1);
  const view = h.view(); assert.equal(view.trades.length, 500); assert.equal(view.trades[0].id, '0:100'); assert.equal(view.trades.at(-1).action, 'cover');
  const saved = h.snapshot(); h.recordEvents([{ id: '0:599', type: 'trade', time: 100599, payload: { instrumentId: 'X', action: 'buy', quantity: 1, price: 5 } }], 600); assert.deepEqual(h.snapshot(), saved);
  const restored = createCandleHistory({ now: clock, restored: saved }); assert.equal(restored.restored, true); assert.deepEqual(restored.view().trades, view.trades);
});

test('bankruptcy starts a separate equity episode while retaining markets and fills', () => {
  const h = createCandleHistory({ now: clock }); h.recordSamples([sample(61000, 1)]); h.recordEquity({ time: 61000, value: -90000, stale: true });
  h.recordTrades([{ id: '0:1', time: 61000, instrumentId: 'X', action: 'buy', side: 'long', price: 1, quantity: 5 }]);
  h.resetEquity(2, 62000);
  assert.deepEqual(h.view().equity, [{ time: 60000, open: 0, high: 0, low: 0, close: 0, count: 1 }]);
  assert.equal(h.view().episode, 2); assert.equal(h.view().markets.X.length, 1); assert.equal(h.view().trades.length, 1);
  const restored = createCandleHistory({ restored: h.snapshot(), episode: 2, now: clock }); assert.equal(restored.restored, true);
});

test('all frames and markets remain under bar caps and independent compact byte budget', () => {
  const h = createCandleHistory({ now: clock });
  for (let n = 0; n < 220; n++) h.recordSamples(Array.from({ length: 64 }, (_, id) => sample(1000000000000 + n * 86400000, Math.PI * (n + 1), `X${id}`)));
  assert.ok(Buffer.byteLength(JSON.stringify(h.snapshot())) <= MAX_HISTORY_BYTES);
  for (const frame of ['minute', 'hour', 'day']) for (const bars of Object.values(h.view(frame).markets)) assert.ok(bars.length <= 180);
  assert.equal(h.view().truncated, true);
  const trades = h.view().trades; h.trimToBytes(50000); assert.ok(Buffer.byteLength(JSON.stringify(h.snapshot())) <= 50000); assert.deepEqual(h.view().trades, trades);
});
