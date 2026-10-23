'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPerformanceHistory, MAX_POINTS } = require('../performance-history.cjs');
const Engine = require('../pet-engine.js');
const create = (baseline = 100, restored) => createPerformanceHistory({ baseline, restored, now: () => 100000000 });

test('bankruptcy reset archives loss and starts a zero-capital episode without a profit jump', () => {
  const history = create(10000);
  for (let n = 0; n < 150; n++) history.record({ time: n * 10000, equity: 10000 - n * 1000 });
  const ending = history.snapshot().current;
  history.reset({ baseline: 0, time: 1500000, reason: 'bankruptcy' });
  const result = history.snapshot();
  assert.equal(result.episode, 2); assert.equal(result.baseline, 0);
  assert.equal(result.current.pnl, 0); assert.equal(result.current.returnPct, null);
  assert.equal(result.points.length, 1); assert.equal(result.current.equity, 0);
  assert.equal(result.lastRun.pnl, ending.pnl);
  assert.equal(result.lastRun.points.length, 120);
  assert.deepEqual(create(0, result).snapshot(), result);
  history.record({ time: 1510000, equity: -100 });
  history.reset({ baseline: 0, time: 1520000 });
  assert.equal(history.snapshot().episode, 3);
  assert.equal(history.snapshot().lastRun.episode, 2);
  assert.equal(history.snapshot().lastRun.pnl, -100);
  assert.deepEqual(create(0, history.snapshot()).snapshot(), history.snapshot());
});

test('recording starts at actual first observation with no seed or backfilled gaps', () => {
  const h = create();
  assert.deepEqual(h.snapshot(), { baseline: 100, startedAt: null, points: [], current: null, sampleIntervalMs: 10000, episode: 1, lastRun: null });
  h.record({ time: 15200, equity: 105 });
  h.record({ time: 15200, equity: 106 });
  h.record({ time: 19999, equity: 104 });
  assert.equal(h.snapshot().points.length, 1);
  assert.equal(h.snapshot().startedAt, 15200);
  assert.equal(h.snapshot().current.returnPct, 4);
  h.record({ time: 90000, equity: 110, stale: true });
  assert.deepEqual(h.snapshot().points.map(p => p.time), [19999, 90000]);
  const saved = h.snapshot();
  h.record({ time: 10000, equity: 999 });
  assert.deepEqual(h.snapshot(), saved);
});

test('history is detached and bounded while preserving original recording start', () => {
  const h = create();
  for (let n = 0; n < 800; n++) h.record({ time: n * 10000, equity: 100 + n });
  const snapshot = h.snapshot();
  assert.equal(snapshot.points.length, MAX_POINTS);
  assert.equal(snapshot.startedAt, 0);
  assert.equal(snapshot.points[0].time, 800000);
  snapshot.points[0].equity = -999;
  snapshot.current.stale = true;
  assert.notEqual(h.snapshot().points[0].equity, -999);
  assert.equal(h.snapshot().current.stale, false);
  assert.deepEqual(create(100, h.snapshot()).snapshot(), h.snapshot());
});

test('zero capital and negative equity stay finite and meaningful', () => {
  const h = create(0);
  h.record({ time: 1, equity: -12 });
  assert.equal(h.snapshot().current.pnl, -12);
  assert.equal(h.snapshot().current.returnPct, null);
  assert.equal(create(0, h.snapshot()).snapshot().current.returnPct, null);
});

test('malformed restored curves drop independently and invalid observations are atomic', () => {
  const h = create(); h.record({ time: 1, equity: 120 });
  const valid = h.snapshot();
  const invalid = [null, {}, { ...valid, baseline: 200 }, { ...valid, extra: true },
    { ...valid, startedAt: 2 }, { ...valid, sampleIntervalMs: 1 },
    { ...valid, points: [valid.points[0], valid.points[0]] },
    { ...valid, points: Array(721).fill(valid.points[0]) },
    { ...valid, current: { ...valid.current, pnl: 123 } },
    { ...valid, points: [{ ...valid.points[0], time: Infinity }] },
    { ...valid, current: { ...valid.current, stale: 'false' } },
    { ...valid, points: [{ ...valid.points[0], equity: NaN }] }];
  for (const value of invalid) assert.equal(create(100, value).snapshot().points.length, 0);
  for (const value of [{ time: -1, equity: 1 }, { time: 1, equity: Infinity }, { time: 1, equity: 1, stale: 1 }]) {
    assert.throws(() => h.record(value)); assert.deepEqual(h.snapshot(), valid);
  }
});

test('actual engine equity includes spread and debt while borrow and repay are neutral', () => {
  const g = Engine.createGame({ mode: 'live', startTime: 0, initialCash: 1000, loanRate: 0, instruments: [{ id: 'X', spread: 0.01 }] });
  const h = create(1000);
  const observe = time => h.record({ time, equity: Engine.equity(g) }).current;
  assert.equal(observe(0).pnl, 0);
  g.borrow(100); assert.equal(observe(1).pnl, 0);
  g.repay(100); assert.equal(observe(2).pnl, 0);
  g.ingestSamples([{ id: 'X', value: 100, time: 3 }]);
  g.buy('X', 1, { leverage: 2 }); assert.equal(observe(3).pnl, -1);
  g.sell('X'); assert.equal(observe(4).pnl, -2);
  assert.equal(h.snapshot().points.length, 1);
});
