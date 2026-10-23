import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const E = require('../pet-engine.js');
const fresh = (options = {}) => E.createGame({ mode: 'demo', seed: 42, startTime: 0, loanRate: 0, ...options });

test('partial long and short closes report allocated financing in net realized profit', () => {
  for (const side of ['long', 'short']) {
    const g = E.createGame({ initialCash: 1000, startTime: 0, loanRate: 0.01, instruments: [{ id: 'X', spread: 0 }] });
    g.ingestSamples([{ id: 'X', value: 100, time: 0 }]);
    const opened = side === 'long' ? g.buy('X', 2, { leverage: 2 }) : g.short('X', 2, { leverage: 2 });
    assert.equal(opened.direction, 'open'); assert.equal(opened.leverage, 2); assert.equal(opened.realizedPnl, undefined);
    g.tick({ time: 1000 });
    const interest = side === 'long' ? 1 : 2;
    assert.ok(Math.abs(g.positions.X.accruedInterest - interest) < 1e-9);
    g.ingestSamples([{ id: 'X', value: side === 'long' ? 110 : 90, time: 1001 }]);
    const close = () => side === 'long' ? g.sell('X', 1) : g.cover('X', 1);
    const first = close();
    assert.equal(first.grossPnl, 10); assert.ok(Math.abs(first.interest - interest / 2) < 1e-9);
    assert.ok(Math.abs(first.realizedPnl - (10 - interest / 2)) < 1e-9);
    assert.equal(first.pnlBasis, 'net-position-interest');
    const restored = E.restoreGame(g.snapshot()); assert.ok(Math.abs(restored.positions.X.accruedInterest - interest / 2) < 1e-9);
    const second = close(); assert.equal(second.realizedPnl, first.realizedPnl);
    assert.ok(Math.abs(E.equity(g) - 1000 - first.realizedPnl - second.realizedPnl) < 1e-9);
  }
  const legacy = fresh(); legacy.buy('CALM', 1); delete legacy.positions.CALM.accruedInterest;
  const closed = legacy.sell('CALM'); assert.equal(closed.pnlBasis, 'unknown'); assert.equal(closed.realizedPnl, undefined); assert.equal(closed.interest, undefined);
});

test('restore rejects malicious positions atomically and accepts legacy longs', () => {
  const g = E.createGame({ initialCash: 1000, startTime: 0, instruments: [{ id: 'X', spread: 0 }] });
  g.ingestSamples([{ id: 'X', value: 100, time: 0 }]); g.short('X', 1);
  const valid = g.snapshot();
  const corruptions = [{ side: 'garbage' }, { side: null }, { quantity: 0 }, { quantity: NaN }, { quantity: '1' }, { avgPrice: -1 }, { avgPrice: Infinity }, { margin: -1 }, { debt: -1 }, { debt: 1 }, { accruedInterest: -1 }, { accruedInterest: NaN }, { accruedInterest: undefined }, { instrumentId: 'OTHER' }];
  for (const patch of corruptions) {
    const bad = structuredClone(valid); Object.assign(bad.positions.X, patch);
    const before = structuredClone(bad);
    assert.throws(() => E.restoreGame(bad), /Invalid serialized position/);
    assert.deepEqual(bad, before);
    assert.deepEqual(g.snapshot(), valid);
  }
  const missing = structuredClone(valid); missing.positions.UNKNOWN = { ...missing.positions.X, instrumentId: 'UNKNOWN' }; delete missing.positions.X;
  assert.throws(() => E.restoreGame(missing), /Invalid serialized position/);
  for (const positions of [[], { X: null }]) assert.throws(() => E.restoreGame({ ...valid, positions }), /Invalid serialized/);
  const legacy = structuredClone(valid); delete legacy.positions.X.side; delete legacy.positions.X.accruedInterest;
  assert.deepEqual(E.restoreGame(legacy).positions, legacy.positions);
  assert.deepEqual(E.restoreGame(JSON.stringify(valid)).positions, valid.positions);
});

test('short proceeds stay restricted and partial covers realize spread-adjusted profit', () => {
  const g = E.createGame({ initialCash: 1000, startTime: 0, loanRate: 0, instruments: [{ id: 'X', spread: 0.01 }] });
  g.ingestSamples([{ id: 'X', value: 100, time: 1 }]);
  const opened = g.short('X', 2, { leverage: 2 });
  assert.equal(opened.action, 'short'); assert.equal(opened.price, 99);
  assert.equal(g.cash, 901); assert.equal(g.positions.X.margin, 99); assert.equal(g.positions.X.debt, 0);
  assert.equal(E.equity(g), 998);
  assert.throws(() => g.buy('X', 1), /Cover/); assert.throws(() => g.sell('X'), /cover/);
  g.ingestSamples([{ id: 'X', value: 80, time: 2 }]);
  const trade = g.cover('X', 1);
  assert.equal(trade.side, 'short'); assert.ok(Math.abs(trade.realizedPnl - 18.2) < 1e-9);
  assert.equal(g.positions.X.quantity, 1); assert.equal(g.positions.X.margin, 49.5);
  assert.deepEqual(E.restoreGame(g.snapshot()).positions, g.positions);
  g.cover('X'); assert.equal(g.positions.X, undefined); assert.ok(Math.abs(g.cash - 1036.4) < 1e-9);
  g.buy('X', 1); assert.throws(() => g.short('X', 1), /Sell/);
});

test('short financing uses elapsed time and gap loss stays inside collateral', () => {
  const g = E.createGame({ initialCash: 1000, startTime: 0, loanRate: 0.01, instruments: [{ id: 'X', spread: 0 }] });
  g.ingestSamples([{ id: 'X', value: 100, time: 0 }]); g.short('X', 2, { leverage: 2 });
  g.tick({ time: 1000 }); assert.ok(Math.abs(g.positions.X.accruedInterest - 2) < 1e-9);
  g.tick({ time: 1000 }); assert.ok(Math.abs(g.positions.X.accruedInterest - 2) < 1e-9);
  g.positions.X && (g.instruments[0].stale = true);
  assert.throws(() => g.cover('X'), /fresh/);
  g.ingestSamples([{ id: 'X', value: 1000, time: 2000 }]);
  assert.equal(g.positions.X, undefined); assert.equal(g.cash, 900); assert.equal(E.equity(g), 900);
  assert.ok(g.events.some(e => e.type === 'liquidation' && e.payload.side === 'short' && e.payload.realizedPnl === -100));
});

test('short bankruptcy asset value excludes restricted sale proceeds and empty interest cannot overflow', () => {
  const g = E.createGame({ initialCash: 1000, startTime: 0, instruments: [{ id: 'X', spread: 0 }] });
  g.ingestSamples([{ id: 'X', value: 100, time: 0 }]); g.short('X', 2, { leverage: 2 });
  g.ingestSamples([{ id: 'X', value: 80, time: 1 }]);
  const ledger = g.bankruptcy(); assert.equal(ledger.assetValue, 140); assert.equal(ledger.debt, 0); assert.equal(ledger.equity, 1040);
  g.tick({ time: 40000000000 }); assert.equal(E.equity(g), 0);
  const indebted = E.createGame({ startTime: 0 }); indebted.borrow(10);
  const before = indebted.snapshot(); assert.throws(() => indebted.tick({ time: 40000000000 }), /safety/);
  assert.deepEqual(indebted.snapshot(), before);
});

test('short boundary rejections are atomic and capped audit totals never block bankruptcy', () => {
  const g = E.createGame({ initialCash: 1000, startTime: 0, instruments: [{ id: 'X', spread: 0 }] });
  g.ingestSamples([{ id: 'X', value: 100, time: 0 }]);
  for (const quantity of [0, -1, Infinity, 1e100]) { const before = g.snapshot(); assert.throws(() => g.short('X', quantity)); assert.deepEqual(g.snapshot(), before); }
  g.short('X', 1); const before = g.snapshot();
  assert.throws(() => g.cover('X', 2)); assert.deepEqual(g.snapshot(), before);
  g.bankruptcyLedger.totalForgivenDebt = Number.MAX_SAFE_INTEGER;
  g.loanBalance = 1;
  g.bankruptcy(); assert.equal(g.bankruptcyLedger.totalsCapped, true);
  assert.equal(g.bankruptcyLedger.totalForgivenDebt, Number.MAX_SAFE_INTEGER);
  assert.equal(g.loanBalance, 0);
});

test('unlimited virtual credit enforces per-loan range and numerical safety only', () => {
  const game = fresh({ credit: { unlimited: true } });
  for (let n = 0; n < 40; n++) game.borrow(3000000);
  assert.equal(game.loanBalance, 120000000);
  assert.equal(E.equity(game), 10000);
  for (const amount of [0, 99999, 3000001, Infinity]) {
    const before = game.snapshot(); assert.throws(() => game.borrow(amount)); assert.deepEqual(game.snapshot(), before);
  }
  game.cash = Number.MAX_SAFE_INTEGER;
  assert.throws(() => game.borrow(100000), /safety/);
  const legacy = fresh({ loanLimit: 50 }); legacy.borrow(50); assert.throws(() => legacy.borrow(1), /limit/);
});

test('bankruptcy preserves loss ledger while clearing virtual balances without grants', () => {
  const game = fresh({ credit: { unlimited: true } });
  game.borrow(100000); game.buy('CALM', 1000, { price: 100 });
  game.instruments[0].price = 10;
  const history = JSON.stringify(game.instruments);
  const record = game.bankruptcy();
  assert.equal(record.equity, -80000);
  assert.equal(record.pnl, -90000);
  assert.equal(record.debt, 100000);
  assert.equal(record.assetValue, 10000);
  assert.equal(game.bankruptcyLedger.totalCrystallizedLoss, 90000);
  assert.equal(game.bankruptcyLedger.totalForgivenDebt, 100000);
  assert.equal(game.cash, 0); assert.equal(game.loanBalance, 0); assert.equal(game.initialCash, 0);
  assert.deepEqual(game.positions, {}); assert.equal(game.automation.enabled, false);
  assert.equal(JSON.stringify(game.instruments), history);
  assert.ok(game.cues.some(c => c.name === 'pet-bankruptcy'));
  game.borrow(100000); assert.equal(game.cash, 100000); assert.equal(E.equity(game), 0);
  for (let n = 0; n < 22; n++) game.bankruptcy();
  assert.equal(game.bankruptcyLedger.records.length, 20);
  assert.equal(game.bankruptcyLedger.count, 23);
  assert.equal(game.bankruptcyLedger.totalCrystallizedLoss, 90000);
  assert.deepEqual(E.restoreGame(game.snapshot()).bankruptcyLedger, game.bankruptcyLedger);
});

test('auto credit requires a funded positive signal, risk permission and real cooldown', () => {
  const make = risk => E.createGame({ startTime: 0, initialCash: 0, loanRate: 0, credit: { unlimited: true }, personality: { riskTolerance: risk }, instruments: [{ id: 'X', spread: 0 }], automation: { enabled: true, autoBorrow: true, everyTicks: 1, budgetFraction: 1, reserveCash: 0 } });
  const game = make(1);
  game.tick({ time: 1000 }); assert.equal(game.loanBalance, 0);
  game.ingestSamples([{ id: 'X', value: 1, time: 1000 }, { id: 'X', value: 2, time: 10000 }, { id: 'X', value: 2, time: 20000 }]);
  game.tick({ time: 20000 }); assert.equal(game.loanBalance, 3000000); assert.equal(game.cash, 0);
  game.positions = {}; // Isolated fixture simulates exhausted invested funds without inventing price history.
  game.tick({ time: 21000 }); assert.equal(game.loanBalance, 3000000); assert.match(game.automation.lastDecision.reason, /60/);
  game.setAutomation({ lastBorrowTime: null });
  game.tick({ time: 22000 }); assert.equal(game.loanBalance, 3000000);
  game.tick({ time: 80000 }); assert.equal(game.loanBalance, 6000000);
  const cautious = make(0.1);
  cautious.ingestSamples([{ id: 'X', value: 1, time: 0 }, { id: 'X', value: 2, time: 10000 }, { id: 'X', value: 2, time: 20000 }]);
  cautious.tick({ time: 20000 }); assert.equal(cautious.loanBalance, 0); assert.match(cautious.automation.lastDecision.reason, /谨慎/);
  cautious.setPersonality({ riskTolerance: 1 }); cautious.setAutomation({ budgetFraction: 0 });
  cautious.tick({ time: 21000 }); assert.equal(cautious.loanBalance, 0);
});

test('live samples build only observed 10-second candles, preserving zero and gaps', () => {
  const game = E.createGame({ startTime: 0, instruments: [{ id: 'CPU', price: 0 }] });
  assert.equal(game.mode, 'live');
  assert.deepEqual(game.instruments[0].history, []);
  E.ingestSamples(game, [{ id: 'CPU', value: 0, time: 1000 }, { id: 'CPU', value: 4, time: 2000 }, { id: 'CPU', value: 2, time: 9999 }, { id: 'CPU', value: 8, time: 30000 }]);
  assert.deepEqual(game.instruments[0].history, [{ time: 0, open: 0, high: 4, low: 0, close: 2, volume: 3 }]);
  assert.equal(game.instruments[0].currentCandle.open, 8);
  const before = game.snapshot().instruments;
  game.tick({ count: 100 });
  assert.deepEqual(game.snapshot().instruments, before);
  const saved = game.snapshot();
  assert.throws(() => game.ingestSamples([{ id: 'CPU', value: 3, time: 40000 }, { id: 'CPU', value: -1, time: 41000 }]));
  assert.deepEqual(game.snapshot(), saved);
  assert.throws(() => game.ingestSamples([{ id: 'CPU', value: 3, time: 2000 }]));
  assert.deepEqual(game.snapshot(), saved);
});

test('live zero price is real but cannot be bought; samples trigger isolated liquidation', () => {
  const game = E.createGame({ startTime: 0, instruments: [{ id: 'CPU', price: 0, spread: 0 }] });
  assert.throws(() => game.buy('CPU', 1));
  game.ingestSamples([{ id: 'CPU', value: 100, time: 0 }]);
  game.buy('CPU', 10, { leverage: 2 });
  game.ingestSamples([{ id: 'CPU', value: 0, time: 1 }]);
  assert.equal(game.instruments[0].price, 0);
  assert.equal(game.positions.CPU, undefined);
  assert.equal(game.cash, 9500);
});


test('named strategies rank closed histories and explain decisions without borrowing', () => {
  for (const strategy of ['momentum', 'dip', 'dca']) {
    const game = E.createGame({ startTime: 0, leverage: 5, loanRate: 0,
      instruments: [{ id: 'UP', spread: 0 }, { id: 'DOWN', spread: 0 }],
      automation: { enabled: true, strategy, everyTicks: 2 } });
    game.ingestSamples([
      { id: 'UP', value: 10, time: 0 }, { id: 'UP', value: 20, time: 10000 }, { id: 'UP', value: 1, time: 20000 },
      { id: 'DOWN', value: 20, time: 0 }, { id: 'DOWN', value: 10, time: 10000 }, { id: 'DOWN', value: 100, time: 20000 }
    ]);
    game.setAutomation({ everyTicks: 2 });
    game.tick({ time: 21000 }); assert.deepEqual(game.positions, {});
    game.tick({ time: 22000 });
    assert.equal(game.automation.lastDecision.action, 'buy');
    assert.equal(game.automation.lastDecision.scores.length, 2);
    assert.ok(game.automation.lastDecision.reason.length > 0);
    assert.equal(game.automation.lastDecision.instrumentId, strategy === 'momentum' ? 'UP' : 'DOWN');
    assert.equal(Object.values(game.positions)[0].debt, 0);
    assert.equal(game.loanBalance, 0);
    assert.equal(game.automation.lastDecision.tick, 2);
    game.tick(); assert.equal(game.automation.lastDecision.tick, 2);
  }
});

test('momentum stop loss uses closed samples and stale refresh preserves history', () => {
  const game = E.createGame({ startTime: 0, loanRate: 0, instruments: [{ id: 'CPU', metric: 'cpu', spread: 0 }],
    personality: { discipline: 1 }, automation: { enabled: true, strategy: 'momentum', everyTicks: 1 } });
  assert.equal(game.indicators.cpu.value, null);
  game.ingestSamples([{ id: 'CPU', value: 10, time: 0 }, { id: 'CPU', value: 20, time: 10000 }, { id: 'CPU', value: 20, time: 20000 }]);
  game.tick(); assert.ok(game.positions.CPU);
  game.ingestSamples([{ id: 'CPU', value: 15, time: 21000 }, { id: 'CPU', value: 15, time: 30000 }]);
  game.tick();
  assert.equal(game.positions.CPU, undefined);
  assert.equal(game.automation.lastDecision.action, 'sell');
  const restored = E.restoreGame(game.snapshot());
  restored.instruments[0].stale = true;
  assert.throws(() => restored.buy('CPU', 1));
  const count = restored.instruments[0].history.length;
  restored.ingestSamples([{ id: 'CPU', value: 16, time: 31000 }]);
  assert.equal(restored.instruments[0].history.length, count);
  assert.equal(restored.instruments[0].stale, false);
  assert.equal(restored.indicators.cpu.value, 16);
  assert.equal(restored.indicators.cpu.status, 'live');
});

test('live bookkeeping deduplicates time and compounds only elapsed periods', () => {
  const g = E.createGame({ startTime: 0, loanRate: 0.01 });
  g.borrow(100);
  g.tick({ time: 1000, count: 100 });
  assert.equal(g.loanBalance, 101);
  const saved = g.snapshot();
  g.tick({ time: 1000 }); g.tick({ time: 500 });
  assert.deepEqual(g.snapshot(), saved);
  g.tick({ time: 3000 });
  assert.ok(Math.abs(g.loanBalance - 103.0301) < 1e-8);
});

test('stale live quotes cannot sell or liquidate until fresh observations arrive', () => {
  const g = E.createGame({ startTime: 0, loanRate: 1, instruments: [{ id: 'X', spread: 0 }] });
  g.ingestSamples([{ id: 'X', value: 100, time: 0 }]);
  g.buy('X', 10, { leverage: 2 });
  g.instruments[0].stale = true;
  assert.throws(() => g.sell('X'), /fresh/);
  g.tick({ time: 1000 });
  assert.ok(g.positions.X);
  g.ingestSamples([{ id: 'X', value: 100, time: 1001 }]);
  assert.equal(g.positions.X, undefined);
});

test('live DCA cannot accelerate with repeated ticks or count batches', () => {
  const g = E.createGame({ startTime: 0, loanRate: 0, instruments: [{ id: 'X', spread: 0 }], automation: { enabled: true, strategy: 'dca', everyTicks: 2 } });
  g.ingestSamples([{ id: 'X', value: 10, time: 0 }, { id: 'X', value: 11, time: 10000 }, { id: 'X', value: 12, time: 20000 }]);
  g.tick({ time: 20000, count: 100 });
  g.tick({ time: 20000, count: 100 });
  g.tick({ time: 21000 });
  assert.equal(g.events.filter(e => e.type === 'auto-trade').length, 1);
  g.tick({ time: 22000 });
  assert.equal(g.events.filter(e => e.type === 'auto-trade').length, 2);
});

test('momentum ignores pre-entry closed bars for stoploss', () => {
  const g = E.createGame({ startTime: 0, loanRate: 0, instruments: [{ id: 'X', spread: 0 }], personality: { discipline: 1 }, automation: { enabled: true, strategy: 'momentum', everyTicks: 1 } });
  g.ingestSamples([{ id: 'X', value: 10, time: 0 }, { id: 'X', value: 20, time: 10000 }, { id: 'X', value: 100, time: 20000 }]);
  g.tick({ time: 20000 });
  g.tick({ time: 21000 });
  assert.ok(g.positions.X);
  assert.equal(g.events.filter(e => e.type === 'auto-trade').length, 1);
});

test('external metrics drive linked instruments and are held during batches', () => {
  const game = fresh({ metrics: { cpu: 40 }, instruments: [
    { id: 'CPU', metric: 'cpu', sensitivity: 0.5, volatility: 0, price: 100 },
    { id: 'FREE', volatility: 0, price: 100 }
  ] });
  game.tick({ metrics: { cpu: 48, mouseBattery: 50, mouseFrequency: 500 }, count: 2 });
  assert.equal(game.indicators.cpu.value, 48);
  assert.equal(game.indicators.mouseBattery.value, 50);
  assert.equal(game.indicators.mouseFrequency.value, 500);
  assert.ok(Math.abs(game.instruments[0].price - 110) < 1e-10);
  assert.equal(game.instruments[1].price, 100);
  game.tick({ metrics: { cpu: 24 } });
  assert.ok(Math.abs(game.instruments[0].price - 82.5) < 1e-10);
  const zero = fresh({ metrics: { codexActivity: 0 }, instruments: [{ id: 'AI', metric: 'codexActivity', sensitivity: 2, volatility: 0 }] });
  zero.tick({ metrics: { codexActivity: 1 } });
  assert.ok(Number.isFinite(zero.instruments[0].price));
});

test('invalid metric inputs and mappings reject atomically', () => {
  const game = fresh();
  for (const metrics of [null, [], { cpu: 42, memory: 101 }, { cpu: NaN }, { cpu: Infinity },
    { cpu: '42' }, { cpu: null }, { unknown: 1 }, { mouseFrequency: 100 }, { dshActivity: -1 }]) {
    const before = game.snapshot();
    assert.throws(() => game.tick({ metrics, count: 3 }));
    assert.deepEqual(game.snapshot(), before);
  }
  for (const config of [{ id: 'BAD', metric: 'unknown' }, { id: 'BAD', sensitivity: -1 }, { id: 'BAD', sensitivity: 3 }]) {
    const before = game.snapshot();
    assert.throws(() => game.addInstrument(config));
    assert.deepEqual(game.snapshot(), before);
  }
});

test('browser global and CommonJS API work without a framework', async () => {
  const context = vm.createContext({});
  vm.runInContext(await readFile(new URL('../pet-engine.js', import.meta.url), 'utf8'), context);
  assert.equal(typeof context.PetEngine.createGame, 'function');
  assert.equal(context.PetEngine.createGame({ startTime: 0 }).snapshot().cash, 10000);
  assert.equal(typeof E.createGame, 'function');
});

test('snapshots detach state, methods stay out of JSON, and restoration resumes RNG', () => {
  const game = fresh();
  game.tick({ count: 25 });
  const saved = game.snapshot();
  assert.equal(saved.tick, undefined);
  saved.indicators.cpu.value = 999;
  assert.notEqual(game.indicators.cpu.value, 999);
  const restored = E.restoreGame(E.serialize(game));
  restored.tick({ count: 20 });
  game.tick({ count: 20 });
  assert.deepEqual(restored.snapshot(), game.snapshot());
});

test('metrics, candles and event queues remain bounded over long simulation', () => {
  const game = fresh({ historyLimit: 12, eventLimit: 9 });
  game.tick({ count: 1000 });
  assert.equal(game.time, 1000000);
  for (const metric of Object.values(game.indicators)) {
    assert.ok(metric.value >= metric.min && metric.value <= metric.max);
    assert.equal(metric.history.length, 12);
  }
  for (const instrument of game.instruments) {
    assert.equal(instrument.history.length, 12);
    for (const c of instrument.history) {
      assert.ok(c.high >= Math.max(c.open, c.close));
      assert.ok(c.low <= Math.min(c.open, c.close));
      assert.ok(c.close > 0);
    }
  }
  assert.equal(game.events.length, 9);
  assert.ok(game.cues.length <= 9);
});

test('leveraged partial sale accounts for margin, debt, basis and cash', () => {
  const game = fresh();
  const trade = game.buy('CALM', 10, { leverage: 2, price: 100 });
  assert.equal(trade.margin, 500);
  assert.equal(game.cash, 9500);
  assert.equal(E.equity(game), 10000);
  const sale = game.sell('CALM', 4, { price: 120 });
  assert.equal(sale.debtRepaid, 200);
  assert.equal(sale.realizedPnl, 80);
  assert.equal(game.cash, 9780);
  assert.equal(game.positions.CALM.quantity, 6);
  game.sell('CALM', undefined, { price: 100 });
  assert.equal(game.cash, 10080);
  assert.equal(game.positions.CALM, undefined);
});

test('borrowing, financing interest and repayment preserve accounting', () => {
  const game = fresh({ loanRate: 0.01 });
  game.borrow(1000);
  game.buy('CALM', 10, { price: 100, leverage: 2 });
  assert.equal(game.loanBalance, 1000);
  game.tick();
  assert.equal(game.loanBalance, 1010);
  assert.equal(game.positions.CALM.debt, 505);
  game.repay(1200);
  assert.equal(game.loanBalance, 0);
  assert.equal(game.positions.CALM.debt, 315);
  game.repay();
  assert.equal(game.positions.CALM.debt, 0);
});

test('invalid transactions reject without changing state', () => {
  const game = fresh({ initialCash: 100, loanLimit: 100 });
  for (const action of [
    () => game.buy('CALM', -1), () => game.buy('CALM', Infinity),
    () => game.buy('CALM', 100), () => game.buy('CALM', 1, { leverage: 101 }),
    () => game.sell('CALM', 1), () => game.borrow(101), () => game.repay(1)
  ]) {
    const before = game.snapshot();
    assert.throws(action);
    assert.deepEqual(game.snapshot(), before);
  }
});

test('custom instruments, personality, events and cue draining', () => {
  const game = fresh({ instruments: [] });
  game.addInstrument({ id: 'custom', name: 'Custom', stability: 'volatile', price: 10, volatility: 0, drift: 0.04 });
  game.setPersonality({ discipline: 0, impulsiveness: 1 });
  game.setLeverage(2);
  game.tick();
  assert.equal(game.instruments[0].price, 10.4);
  assert.ok(game.cues.some(c => c.name === 'pet-startled'));
  const drained = E.drainEvents(game);
  assert.ok(drained.events.length > 0);
  assert.equal(game.events.length, 0);
  assert.equal(game.cues.length, 0);
  assert.throws(() => game.addInstrument({ id: 'custom' }), /already exists/);
});

test('pet state transitions expose deterministic animation cues', () => {
  const game = fresh({ metrics: { codexActivity: { value: 1, volatility: 0 } } });
  game.tick();
  assert.equal(game.pet.state, 'working');
  assert.ok(game.cues.some(c => c.name === 'pet-working'));
  const before = game.snapshot();
  assert.throws(() => game.setPersonality({ discipline: 0, curiosity: 2 }));
  assert.deepEqual(game.snapshot(), before);
});

test('isolated liquidation handles exact exhaustion and gaps without touching cash or other positions', () => {
  for (const drift of [-0.5, -0.9]) {
    const game = fresh({ instruments: [
      { id: 'DROP', price: 100, drift, volatility: 0, spread: 0 },
      { id: 'SAFE', price: 100, volatility: 0, spread: 0 }
    ] });
    game.buy('DROP', 10, { leverage: 2 });
    game.buy('SAFE', 2);
    const cash = game.cash;
    game.tick();
    assert.equal(game.positions.DROP, undefined);
    assert.equal(game.positions.SAFE.quantity, 2);
    assert.equal(game.cash, cash);
    assert.ok(game.events.some(e => e.type === 'liquidation'));
    assert.ok(game.cues.some(c => c.name === 'pet-liquidated'));
    game.tick();
    assert.equal(game.events.filter(e => e.type === 'liquidation').length, 1);
  }
});

test('manual underwater close is isolated and debt interest can trigger liquidation', () => {
  const game = fresh();
  game.buy('CALM', 10, { leverage: 2, price: 100 });
  game.sell('CALM', 1, { price: 1 });
  assert.equal(game.cash, 9500);
  assert.equal(game.positions.CALM, undefined);
  const financed = fresh({ loanRate: 1, instruments: [{ id: 'FIXED', price: 100, volatility: 0, spread: 0 }] });
  financed.buy('FIXED', 10, { leverage: 2 });
  financed.tick();
  assert.equal(financed.positions.FIXED, undefined);
  assert.equal(financed.cash, 9500);
});

test('automatic investment is opt-in, personality-driven, bounded and reproducible', () => {
  const disabled = fresh(); disabled.tick({ count: 50 });
  assert.deepEqual(disabled.positions, {});
  for (const riskTolerance of [0, 1]) {
    const game = fresh({ leverage: 3, personality: { riskTolerance, curiosity: 0, patience: 0, impulsiveness: 1 },
      automation: { enabled: true, strategy: 'dca', everyTicks: 1, budgetFraction: 0.5, reserveCash: 100 } });
    game.tick();
    assert.ok(Object.keys(game.positions).length > 0);
    assert.ok(game.cash >= 100);
    assert.ok(game.events.some(e => e.type === 'auto-trade'));
    const restored = E.restoreGame(game.snapshot());
    game.tick({ count: 100 }); restored.tick({ count: 100 });
    assert.deepEqual(game.snapshot(), restored.snapshot());
    assert.ok(game.cash >= 0);
    game.setAutomation({ enabled: false });
    assert.equal(game.automation.enabled, false);
  }
  const empty = fresh({ initialCash: 0, loanLimit: 0, automation: { enabled: true, everyTicks: 1 } });
  assert.doesNotThrow(() => empty.tick({ count: 10 }));
  assert.deepEqual(empty.positions, {});
  assert.equal(empty.cash, 0);
});

test('automatic ticks start once and stop without serializing timers', async () => {
  const game = fresh();
  let calls = 0;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('auto tick timeout')), 500);
    const stop = E.startAutoTick(game, () => {
      calls++;
      if (calls === 3) { stop(); clearTimeout(timeout); resolve(); }
    }, { intervalMs: 5 });
    E.startAutoTick(game, () => { throw new Error('duplicate timer'); }, { intervalMs: 5 });
  });
  assert.equal(game.tickCount, 3);
  assert.equal(E.stopAutoTick(game), false);
  assert.doesNotThrow(() => E.serialize(game));
});
