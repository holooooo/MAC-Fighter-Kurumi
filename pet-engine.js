/*
 * Pet Engine: deterministic, framework-free market + state machine.
 * Browser script: window.PetEngine | Node CommonJS: require('./pet-engine.js')
 * Game methods are non-enumerable; all persisted state is plain JSON data.
 */
(function attachPetEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.PetEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPetEngineApi() {
  'use strict';

  const VERSION = 1;
  const DEFAULT_HISTORY_LIMIT = 120;
  const DEFAULT_EVENT_LIMIT = 100;
  const MAX_TICK_BATCH = 10000;
  const PERSONALITY_DEFAULTS = { riskTolerance: 0.5, discipline: 0.5, patience: 0.5, impulsiveness: 0.5, curiosity: 0.5 };
  const METRIC_DEFAULTS = {
    cpu: { value: 28, unit: '%', min: 0, max: 100, volatility: 5 },
    memory: { value: 56, unit: '%', min: 0, max: 100, volatility: 2.4 },
    mouseBattery: { value: 84, unit: '%', min: 0, max: 100, volatility: 0.25 },
    mouseFrequency: { value: 1000, unit: 'Hz', min: 125, max: 8000, volatility: 0 },
    codexActivity: { value: 0.35, unit: 'activity', min: 0, max: 1, volatility: 0.16 },
    claudeActivity: { value: 0.2, unit: 'activity', min: 0, max: 1, volatility: 0.16 },
    dshActivity: { value: 0.42, unit: 'activity', min: 0, max: 1, volatility: 0.18 }
  };
  const autoTimers = new WeakMap();
  let api;

  function finite(value, name, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new TypeError(`${name} must be a finite number`);
    if (min !== undefined && n < min) throw new RangeError(`${name} must be >= ${min}`);
    if (max !== undefined && n > max) throw new RangeError(`${name} must be <= ${max}`);
    return n;
  }
  function safeMoney(value, name = 'money') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new RangeError(`${name} exceeds numerical safety limit`);
    return value;
  }
  function bankruptcy(game) {
    assertGame(game);
    const debt = safeMoney(totalDebt(game));
    const net = safeMoney(equity(game));
    const pnl = safeMoney(net - game.initialCash);
    const old = game.bankruptcyLedger || { count: 0, totalForgivenDebt: 0, totalCrystallizedLoss: 0, records: [] };
    const record = { time: game.time, equity: net, pnl, debt, cash: game.cash, assetValue: safeMoney(net + debt - game.cash), crystallizedLoss: Math.max(0, -pnl), forgivenDebt: debt };
    const forgivenTotal = old.totalForgivenDebt + debt;
    const lossTotal = old.totalCrystallizedLoss + record.crystallizedLoss;
    const ledger = { count: Math.min(Number.MAX_SAFE_INTEGER, old.count + 1), totalForgivenDebt: Math.min(Number.MAX_SAFE_INTEGER, forgivenTotal), totalCrystallizedLoss: Math.min(Number.MAX_SAFE_INTEGER, lossTotal), totalsCapped: old.totalsCapped === true || forgivenTotal > Number.MAX_SAFE_INTEGER || lossTotal > Number.MAX_SAFE_INTEGER, records: [...old.records, record].slice(-20) };
    game.bankruptcyLedger = ledger;
    game.cash = 0; game.positions = {}; game.loanBalance = 0; game.initialCash = 0;
    game.automation.enabled = false;
    emit(game, 'bankruptcy', record, 'pet-bankruptcy');
    return record;
  }
  function positive(value, name) { return finite(value, name, Number.MIN_VALUE); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function assertGame(game) {
    if (!game || typeof game !== 'object' || game.version !== VERSION || !Array.isArray(game.instruments)) {
      throw new TypeError('Expected a game created by PetEngine.createGame()');
    }
    return game;
  }
  function attachMethods(game) {
    const methods = {
      ingestSamples: (samples) => api.ingestSamples(game, samples),
      snapshot: () => api.snapshot(game),
      tick: (options) => api.tick(game, options),
      short: (symbol, quantity, options) => api.short(game, symbol, quantity, options),
      cover: (symbol, quantity, options) => api.cover(game, symbol, quantity, options),
      buy: (symbol, quantity, options) => api.buy(game, symbol, quantity, options),
      sell: (symbol, quantity, options) => api.sell(game, symbol, quantity, options),
      bankruptcy: () => api.bankruptcy(game),
      borrow: (amount, options) => api.borrow(game, amount, options),
      repay: (amount) => api.repay(game, amount),
      setPersonality: (personality) => api.setPersonality(game, personality),
      addInstrument: (instrument) => api.addInstrument(game, instrument),
      equity: () => api.equity(game),
      setAutomation: (options) => api.setAutomation(game, options),
      setLeverage: (leverage) => api.setLeverage(game, leverage)
    };
    for (const [name, fn] of Object.entries(methods)) {
      Object.defineProperty(game, name, { configurable: true, enumerable: false, value: fn });
    }
    return game;
  }
  function rngFor(game) {
    game.randomState = (game.randomState >>> 0) || 0x6d2b79f5;
    return function random() {
      let x = game.randomState >>> 0;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      game.randomState = x >>> 0;
      return game.randomState / 0x100000000;
    };
  }
  function candle(time, open, high, low, close, volume) { return { time, open, high, low, close, volume }; }
  function trim(items, limit) { if (items.length > limit) items.splice(0, items.length - limit); }
  function emit(game, type, payload, cueName) {
    const id = `${game.tickCount}:${game.eventSequence++}`;
    const data = payload || {};
    const event = { id, type, tick: game.tickCount, time: game.time, payload: data };
    game.events.push(event); trim(game.events, game.eventLimit);
    if (cueName) {
      game.cues.push({ id: `${id}:cue`, name: cueName, tick: game.tickCount, time: game.time, payload: data });
      trim(game.cues, game.eventLimit);
    }
    return event;
  }
  function normalizeInstrument(input, game) {
    if (!input || typeof input !== 'object') throw new TypeError('instrument must be an object');
    const rawId = input.id || input.symbol || input.name;
    if (typeof rawId !== 'string' || rawId.trim() === '') throw new TypeError('instrument needs an id, symbol, or name');
    const id = rawId.trim().toUpperCase();
    if (game.instruments.some(item => item.id === id)) throw new Error(`Instrument already exists: ${id}`);
    const stability = input.stability === 'volatile' || input.stability === 'wild' ? 'volatile' : 'calm';
    const metric = input.metric === undefined || input.metric === null ? null : input.metric;
    if (metric !== null && (typeof metric !== 'string' || !Object.hasOwn(game.indicators, metric))) throw new TypeError('Unknown instrument.metric');
    const sensitivity = finite(input.sensitivity === undefined ? 1 : input.sensitivity, 'instrument.sensitivity', 0, 2);
    const price = finite(input.price === undefined ? (game.mode === 'live' ? 0 : 100) : input.price, 'instrument.price', 0);
    return {
      metric, sensitivity,
      id, symbol: String(input.symbol || id).trim().toUpperCase(), name: String(input.name || id),
      category: String(input.category || 'market'), stability, tradable: input.tradable !== false,
      price, previousPrice: price, change: 0, changePct: 0,
      volatility: finite(input.volatility === undefined ? (stability === 'volatile' ? 0.035 : 0.004) : input.volatility, 'instrument.volatility', 0, 2),
      drift: finite(input.drift === undefined ? 0 : input.drift, 'instrument.drift', -1, 1),
      spread: finite(input.spread === undefined ? 0.0005 : input.spread, 'instrument.spread', 0, 0.5),
      baseVolume: finite(input.baseVolume === undefined ? 1000 : input.baseVolume, 'instrument.baseVolume', 0),
      hasSamples: false, sampleTime: null, currentCandle: null,
      volume: 0, history: game.mode === 'live' ? [] : [candle(game.time, price, price, price, price, 0)]
    };
  }
  function makeMetric(name, spec, time, config) {
    const override = config && config[name];
    const value = finite(typeof override === 'number' ? override : (override && override.value !== undefined ? override.value : spec.value), `${name}.value`, spec.min, spec.max);
    const metric = { name, value, previousValue: value, change: 0, unit: spec.unit, min: spec.min, max: spec.max,
      volatility: spec.volatility, history: [candle(time, value, value, value, value, 0)] };
    if (override && typeof override === 'object') {
      if (override.unit !== undefined) metric.unit = String(override.unit);
      if (override.volatility !== undefined) metric.volatility = finite(override.volatility, `${name}.volatility`, 0);
    }
    return metric;
  }

  /** createGame(config?) -> mutable game state with non-enumerable instance methods. */
  function createGame(config) {
    const opts = config || {};
    const startTime = finite(opts.startTime === undefined ? Date.now() : opts.startTime, 'startTime');
    const historyLimit = Math.floor(finite(opts.historyLimit === undefined ? DEFAULT_HISTORY_LIMIT : opts.historyLimit, 'historyLimit', 2, 5000));
    const eventLimit = Math.floor(finite(opts.eventLimit === undefined ? DEFAULT_EVENT_LIMIT : opts.eventLimit, 'eventLimit', 1, 5000));
    const cash = finite(opts.initialCash === undefined ? 10000 : opts.initialCash, 'initialCash', 0);
    const maxLeverage = finite(opts.maxLeverage === undefined ? 5 : opts.maxLeverage, 'maxLeverage', 1, 100);
    const seed = (opts.seed === undefined ? Math.floor(Math.random() * 0xffffffff) : finite(opts.seed, 'seed')) >>> 0;
    const personality = { ...PERSONALITY_DEFAULTS };
    if (opts.personality !== undefined) {
      if (!opts.personality || typeof opts.personality !== 'object') throw new TypeError('personality must be an object');
      for (const key of Object.keys(PERSONALITY_DEFAULTS)) {
        if (opts.personality[key] !== undefined) personality[key] = finite(opts.personality[key], `personality.${key}`, 0, 1);
      }
    }
    const mode = opts.mode === undefined ? 'live' : opts.mode;
    if (!['live', 'demo'].includes(mode)) throw new TypeError('mode must be live or demo');
    const game = {
      mode, lastLiveTickTime: startTime,
      version: VERSION, seed, randomState: seed || 0x6d2b79f5, tickCount: 0, eventSequence: 0, time: startTime,
      cash, initialCash: cash, loanBalance: 0,
      credit: opts.credit?.unlimited === true ? { unlimited: true, minPerLoan: 100000, maxPerLoan: 3000000 } : null,
      bankruptcyLedger: { count: 0, totalForgivenDebt: 0, totalCrystallizedLoss: 0, records: [] },
      loanLimit: finite(opts.loanLimit === undefined ? 50000 : opts.loanLimit, 'loanLimit', 0),
      loanRate: finite(opts.loanRate === undefined ? 0.00002 : opts.loanRate, 'loanRate', 0, 1),
      leverage: finite(opts.leverage === undefined ? 1 : opts.leverage, 'leverage', 1, maxLeverage),
      risk: { maxLeverage }, personality,
      pet: { state: 'idle', previousState: 'idle', sinceTick: 0, mood: 0.5 },
      market: { tickMs: finite(opts.tickMs === undefined ? 1000 : opts.tickMs, 'tickMs', 1), historyLimit },
      automation: normalizeAutomation(opts.automation),
      eventLimit, instruments: [], positions: {}, indicators: {}, events: [], cues: []
    };
    for (const [name, spec] of Object.entries(METRIC_DEFAULTS)) {
      game.indicators[name] = makeMetric(name, spec, startTime, opts.metrics);
      if (mode === 'live') Object.assign(game.indicators[name], { value: null, previousValue: null, change: 0, status: 'unavailable', history: [] });
    }
    const configs = Array.isArray(opts.instruments) ? opts.instruments : [
      { id: 'CALM', symbol: 'CALM', name: '平稳指数', stability: 'calm', price: 100, volatility: 0.004, drift: 0.0001 },
      { id: 'WILD', symbol: 'WILD', name: '剧烈指数', stability: 'volatile', price: 100, volatility: 0.035 }
    ];
    for (const instrument of configs) game.instruments.push(normalizeInstrument(instrument, game));
    game.automation.lastTime = startTime;
    rngFor(game);
    return attachMethods(game);
  }

  function findInstrument(game, symbol) {
    if (typeof symbol !== 'string' || symbol.trim() === '') throw new TypeError('symbol must be a non-empty string');
    const key = symbol.trim().toUpperCase();
    const instrument = game.instruments.find(item => item.id === key || item.symbol === key);
    if (!instrument) throw new Error(`Unknown instrument: ${key}`);
    return instrument;
  }
  /** Ingest chronological samples per instrument; no missing buckets are fabricated.
   * history contains only completed observed buckets; currentCandle is separate.
   * volume counts samples (not traded financial volume).
   */
  function ingestSamples(game, samples) {
    assertGame(game);
    if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
    const times = new Map();
    const checked = samples.map(sample => {
      if (!sample || typeof sample !== 'object') throw new TypeError('invalid sample');
      const instrument = findInstrument(game, sample.id);
      if (typeof sample.value !== 'number' || !Number.isFinite(sample.value) || sample.value < 0) throw new TypeError('sample.value must be nonnegative and finite');
      if (typeof sample.time !== 'number' || !Number.isFinite(sample.time) || sample.time < 0) throw new TypeError('sample.time must be nonnegative milliseconds');
      const prior = times.has(instrument.id) ? times.get(instrument.id) : instrument.sampleTime;
      if (prior !== null && prior !== undefined && sample.time < prior) throw new RangeError('sample time is out of order');
      times.set(instrument.id, sample.time);
      return { instrument, value: sample.value, time: sample.time };
    });
    for (const { instrument: i, value, time } of checked) {
      if (!i.hasSamples) { i.history = []; i.currentCandle = null; }
      const bucket = Math.floor(time / 10000) * 10000;
      if (!i.currentCandle || bucket !== i.currentCandle.time) {
        if (i.currentCandle) { i.history.push(i.currentCandle); trim(i.history, game.market.historyLimit); }
        i.currentCandle = candle(bucket, value, value, value, value, 1);
      } else {
        i.currentCandle.high = Math.max(i.currentCandle.high, value);
        i.currentCandle.low = Math.min(i.currentCandle.low, value);
        i.currentCandle.close = value; i.currentCandle.volume += 1;
      }
      i.previousPrice = i.hasSamples ? i.price : value;
      i.price = value; i.change = value - i.previousPrice;
      i.changePct = i.previousPrice > 0 ? i.change / i.previousPrice : 0;
      i.hasSamples = true; i.stale = false; i.sampleTime = time; i.volume = i.currentCandle.volume;
      if (i.metric) Object.assign(game.indicators[i.metric], { value, previousValue: i.previousPrice, change: i.change, status: 'live' });
      game.time = Math.max(game.time, time);
      const p = game.positions[i.id];
      if (p?.side === 'short' && shortValue(p, value * (1 + i.spread)) <= 0) liquidateShort(game, i, value * (1 + i.spread));
      else if (p && p.debt > 0 && value * (1 - i.spread) * p.quantity <= p.debt) liquidate(game, i, value * (1 - i.spread));
    }
    return game;
  }
  function totalDebt(game) {
    let debt = game.loanBalance;
    for (const position of Object.values(game.positions)) if (position.side !== 'short') debt += position.debt;
    return debt;
  }
  function updateMetric(metric, time, value, volume, historyLimit) {
    const prior = metric.value; metric.previousValue = prior; metric.value = value; metric.change = value - prior;
    const wick = Math.abs(metric.change) * 0.25;
    metric.history.push(candle(time, prior, Math.max(prior, value) + wick,
      Math.max(metric.min, Math.min(prior, value) - wick), value, volume));
    trim(metric.history, historyLimit);
  }
  function validateMetrics(game, values) {
    if (values === undefined) return {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('metrics must be an object');
    const checked = {};
    for (const [name, value] of Object.entries(values)) {
      if (!Object.hasOwn(game.indicators, name)) throw new TypeError(`Unknown metric: ${name}`);
      const metric = game.indicators[name];
      if (typeof value !== 'number') throw new TypeError(`metrics.${name} must be a number`);
      checked[name] = finite(value, `metrics.${name}`, metric.min, metric.max);
    }
    return checked;
  }
  function updateIndicators(game, random, supplied) {
    const rates = [125, 250, 500, 1000, 2000, 4000, 8000];
    for (const [name, metric] of Object.entries(game.indicators)) {
      let value;
      if (Object.hasOwn(supplied, name)) value = supplied[name];
      else if (name === 'mouseBattery') value = clamp(metric.value - random() * 0.015, metric.min, metric.max);
      else if (name === 'mouseFrequency') value = random() < 0.035 ? rates[Math.floor(random() * rates.length)] : metric.value;
      else value = clamp(metric.value + (random() - 0.5) * 2 * metric.volatility, metric.min, metric.max);
      updateMetric(metric, game.time, value, 0, game.market.historyLimit);
    }
  }
  function marketStep(game, random) {
    let largestMove = { id: null, changePct: 0 };
    for (const instrument of game.instruments) {
      if (instrument.hasSamples) continue;
      const open = instrument.price;
      const shock = (random() - random()) * instrument.volatility;
      const jump = random() < (instrument.stability === 'volatile' ? 0.025 : 0.004)
        ? (random() - 0.5) * instrument.volatility * (instrument.stability === 'volatile' ? 5 : 2) : 0;
      const metric = instrument.metric ? game.indicators[instrument.metric] : null;
      // A 5% range floor avoids division blowups when activity starts at zero.
      const signal = metric ? clamp(metric.change / Math.max(Math.abs(metric.previousValue), (metric.max - metric.min) * 0.05, 1e-9), -1, 1) * instrument.sensitivity : 0;
      const pct = clamp(instrument.drift + signal + (shock + jump) * (metric ? 0.15 : 1), -0.9, 1.5);
      const close = Math.max(0.000001, open * (1 + pct));
      const high = Math.max(open, close);
      const low = Math.min(open, close);
      const volume = Math.round(instrument.baseVolume * (0.5 + random() * 1.5) * (1 + Math.abs(pct) * 10));
      instrument.previousPrice = open; instrument.price = close; instrument.change = close - open;
      instrument.changePct = open ? (close - open) / open : 0; instrument.volume = volume;
      instrument.history.push(candle(game.time, open, high, low, close, volume));
      trim(instrument.history, game.market.historyLimit);
      if (Math.abs(instrument.changePct) > Math.abs(largestMove.changePct)) largestMove = { id: instrument.id, changePct: instrument.changePct };
    }
    return largestMove;
  }
  function interestPlan(game, periods) {
    const shorts = Object.values(game.positions).filter(p => p.side === 'short');
    if (game.loanRate <= 0 || (totalDebt(game) === 0 && shorts.length === 0)) return null;
    const factor = Math.pow(1 + game.loanRate, periods);
    safeMoney(totalDebt(game) * factor);
    const accrued = shorts.map(p => safeMoney((p.accruedInterest || 0) * factor + p.avgPrice * p.quantity * (factor - 1)));
    for (const p of Object.values(game.positions)) if (p.side !== 'short' && p.accruedInterest !== undefined) safeMoney(p.accruedInterest + p.debt * (factor - 1));
    return { factor, shorts, accrued };
  }
  function chargeInterest(game, periods = 1) {
    const plan = interestPlan(game, periods);
    if (!plan) return;
    game.loanBalance *= plan.factor;
    for (const position of Object.values(game.positions)) if (position.side !== 'short') {
      if (position.accruedInterest !== undefined) position.accruedInterest += position.debt * (plan.factor - 1);
      position.debt *= plan.factor;
    }
    plan.shorts.forEach((p, i) => { p.accruedInterest = plan.accrued[i]; });
  }
  function normalizeAutomation(options) {
    const opts = options || {};
    const strategy = opts.strategy === undefined ? 'momentum' : opts.strategy;
    if (!['momentum', 'dip', 'dca'].includes(strategy)) throw new TypeError('Unknown automation.strategy');
    return {
      strategy, lastDecision: null, autoBorrow: opts.autoBorrow === true, lastBorrowTime: opts.lastBorrowTime ?? null,
      enabled: opts.enabled === true,
      everyTicks: Math.ceil(finite(opts.everyTicks === undefined ? 5 : opts.everyTicks, 'automation.everyTicks', 1, 10000)),
      budgetFraction: finite(opts.budgetFraction === undefined ? 0.1 : opts.budgetFraction, 'automation.budgetFraction', 0, 1),
      reserveCash: finite(opts.reserveCash === undefined ? 100 : opts.reserveCash, 'automation.reserveCash', 0),
      lastTime: 0, lastTick: 0
    };
  }
  function setAutomation(game, options) {
    assertGame(game);
    game.automation = normalizeAutomation({ ...game.automation, ...options, lastBorrowTime: game.automation.lastBorrowTime ?? null });
    game.automation.lastTick = game.tickCount;
    game.automation.lastTime = game.time;
    return copy(game.automation);
  }
  // Isolated, limited-loss simulation: gap deficits are written off, never
  // charged to other positions or free cash. Personal loans remain payable.
  function liquidate(game, instrument, price) {
    const p = game.positions[instrument.id];
    const proceeds = price * p.quantity;
    const payload = { instrumentId: instrument.id, quantity: p.quantity, price,
      side: 'long', direction: 'close', liquidated: true, time: game.time, notional: proceeds, costBasis: p.avgPrice * p.quantity, grossPnl: proceeds - p.avgPrice * p.quantity,
      pnlBasis: p.accruedInterest === undefined ? 'unknown' : 'net-position-interest',
      ...(p.accruedInterest === undefined ? {} : { interest: p.accruedInterest, realizedPnl: proceeds - p.avgPrice * p.quantity - p.accruedInterest + Math.max(0, p.debt - proceeds) }),
      proceeds, debt: p.debt, deficit: Math.max(0, p.debt - proceeds), marginLost: p.margin };
    game.cash += Math.max(0, proceeds - p.debt);
    delete game.positions[instrument.id];
    emit(game, 'liquidation', payload, 'pet-liquidated');
    return payload;
  }
  function checkLiquidations(game) {
    let closed = false;
    for (const instrument of game.instruments) {
      const p = game.positions[instrument.id];
      if (p?.side === 'short' && !instrument.stale && shortValue(p, instrument.price * (1 + instrument.spread)) <= 0) {
        liquidateShort(game, instrument, instrument.price * (1 + instrument.spread)); closed = true;
      } else if (p && p.debt > 0 && !instrument.stale) {
        const low = game.mode === 'live' || instrument.hasSamples ? instrument.price : instrument.history[instrument.history.length - 1].low;
        if (low * (1 - instrument.spread) * p.quantity <= p.debt) {
          liquidate(game, instrument, Math.min(instrument.price * (1 - instrument.spread), p.debt / p.quantity));
          closed = true;
        }
      }
    }
    return closed;
  }
  function autoInvest(game) {
    const a = game.automation;
    if (!a || !a.enabled) return;
    const due = game.mode === 'live' ? game.time - (a.lastTime ?? game.time) >= a.everyTicks * game.market.tickMs : game.tickCount - a.lastTick >= a.everyTicks;
    if (!due) return;
    a.lastTick = game.tickCount; a.lastTime = game.time;
    const scores = game.instruments.filter(i => i.tradable && !i.stale && (i.hasSamples || game.mode === 'demo') && i.history.length >= 2).map(i => {
      const closes = i.history.map(bar => bar.close);
      const first = closes[0], last = closes[closes.length - 1];
      const mean = closes.reduce((sum, value) => sum + value / closes.length, 0);
      const momentum = first > 0 ? last / first - 1 : 0;
      const dip = mean > 0 ? (mean - last) / mean : 0;
      const exposure = (game.positions[i.id]?.quantity || 0) * i.price;
      return { id: i.id, bars: closes.length, momentum, dip, exposure,
        score: a.strategy === 'momentum' ? momentum : a.strategy === 'dip' ? dip : -exposure };
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    function decision(action, reason, id) {
      const result = { strategy: a.strategy, action, reason, instrumentId: id || null, tick: game.tickCount, scores };
      a.lastDecision = result;
      emit(game, 'auto-decision', copy(result));
    }
    // Exit decisions also use the latest CLOSED bar, not the open bucket.
    if (a.strategy !== 'dca') for (const row of scores) {
      const position = game.positions[row.id];
      if (!position || position.side === 'short') continue;
      const i = findInstrument(game, row.id);
      const closedBar = i.history[i.history.length - 1];
      if (game.mode === 'live' && closedBar.time < (position.openedAt ?? game.time)) continue;
      const last = closedBar.close;
      const loss = last / position.avgPrice - 1;
      if (loss <= -(0.01 + (1 - game.personality.discipline) * 0.09)) {
        const trade = sell(game, row.id);
        decision('sell', '已收盘价格触发性格纪律参数对应的止损线', row.id);
        emit(game, 'auto-trade', trade, 'pet-auto-sell'); return;
      }
      if (a.strategy === 'dip' && row.dip <= 0) {
        const trade = sell(game, row.id);
        decision('sell', '已收盘价格回到完整历史均值，抄底仓获利退出', row.id);
        emit(game, 'auto-trade', trade, 'pet-auto-sell'); return;
      }
    }
    const row = scores.find(row => game.positions[row.id]?.side !== 'short' && findInstrument(game, row.id).price > 0 && (a.strategy === 'dca' || (!game.positions[row.id] && row.score > 0)));
    if (!row) { decision('hold', scores.length ? '没有满足入场条件且价格为正的品种' : '等待至少两根已收盘实测K线'); return; }
    // Cash-only autonomous orders; reserve all outstanding personal debt too.
    if (a.budgetFraction === 0) { decision('hold', '自动投资预算为零', row.id); return; }
    const risk = game.personality.riskTolerance;
    let spendable = Math.max(0, game.cash - a.reserveCash - (game.credit?.unlimited ? 0 : totalDebt(game)));
    if (spendable <= 1 && a.autoBorrow && game.credit?.unlimited) {
      if (risk < 0.35) { decision('hold', '谨慎性格拒绝自动借贷', row.id); return; }
      if (a.lastBorrowTime !== null && game.time - a.lastBorrowTime < 60000) { decision('hold', '自动借贷冷却中，至少间隔60秒', row.id); return; }
      const amount = 100000 + Math.floor(risk * 2900000);
      if (game.cash + amount > Number.MAX_SAFE_INTEGER || totalDebt(game) + amount > Number.MAX_SAFE_INTEGER) { decision('hold', '已达数值安全边界，停止自动融资', row.id); return; }
      borrow(game, amount, { purpose: 'signal-driven-auto-investment' });
      a.lastBorrowTime = game.time;
      spendable = Math.max(0, game.cash - a.reserveCash);
    }
    const budget = spendable * a.budgetFraction * (0.25 + risk * 0.75);
    if (budget <= 0.000001) { decision('hold', '现款预算不足，保留现金与债务偿还准备'); return; }
    const i = findInstrument(game, row.id);
    const trade = buy(game, row.id, budget / (i.price * (1 + i.spread)), { leverage: 1 });
    const reason = a.strategy === 'momentum' ? '完整已收盘历史涨幅最高的可入场品种' : a.strategy === 'dip' ? '相对完整已收盘历史均值折价最大的可入场品种' : '固定tick间隔定投，选择当前持仓市值最低的品种';
    decision('buy', reason, row.id);
    emit(game, 'auto-trade', trade, 'pet-auto-buy');
  }
  /** tick(game, {count=1, metrics={}}?) -> game.
   * Supplied numeric metric samples are held constant across the entire batch;
   * omitted metrics are simulated. All samples validate before any mutation.
   */
  function tick(game, options) {
    assertGame(game);
    const count = Math.floor(finite(options && options.count !== undefined ? options.count : 1, 'count', 1, MAX_TICK_BATCH));
    const suppliedMetrics = validateMetrics(game, options && options.metrics);
    const liveTime = game.mode === 'live' ? finite(options && options.time !== undefined ? options.time : game.time, 'time', 0) : null;
    const previousLiveTime = game.lastLiveTickTime ?? game.time;
    if (game.mode === 'live' && liveTime <= previousLiveTime) return game;
    const periods = game.mode === 'live' ? (liveTime - previousLiveTime) / game.market.tickMs : 1;
    interestPlan(game, periods * (game.mode === 'demo' ? count : 1));
    if (game.mode === 'live') { game.time = Math.max(game.time, liveTime); game.lastLiveTickTime = liveTime; }
    const random = rngFor(game);
    for (let i = 0; i < (game.mode === 'live' ? 1 : count); i += 1) {
      game.tickCount += 1;
      if (game.mode === 'demo') game.time += game.market.tickMs;
      let move = { id: null, changePct: 0 };
      if (game.mode === 'demo') {
        updateIndicators(game, random, suppliedMetrics);
        move = marketStep(game, random);
      } else {
        for (const [name, value] of Object.entries(suppliedMetrics)) {
          const m = game.indicators[name]; m.previousValue = m.value; m.change = value - m.value; m.value = value;
        }
      }
      chargeInterest(game, periods);
      const wasLiquidated = checkLiquidations(game);
      if (!wasLiquidated) autoInvest(game, random);
      const cue = Math.abs(move.changePct) >= 0.025 ? (move.changePct > 0 ? 'market-surge-up' : 'market-surge-down') : null;
      emit(game, 'tick', { instruments: game.instruments.length, largestMove: move }, cue);
      const emotionality = (game.personality.impulsiveness + (1 - game.personality.discipline)) / 2;
      if (cue && emotionality > 0.65) emit(game, 'reaction', { cue, emotionality }, 'pet-startled');
      const netWorth = equity(game);
      const activity = Math.max(game.indicators.codexActivity.value, game.indicators.claudeActivity.value, game.indicators.dshActivity.value);
      const mood = clamp(0.5 + (netWorth - game.initialCash) / Math.max(1, game.initialCash) * (2 - game.personality.discipline), 0, 1);
      const state = netWorth <= 0 ? 'distressed' : mood < 0.35 ? 'worried' : mood > 0.65 ? 'excited' : activity > 0.75 ? 'working' : 'idle';
      game.pet.mood = mood;
      if (state !== game.pet.state) {
        const previousState = game.pet.state;
        Object.assign(game.pet, { state, previousState, sinceTick: game.tickCount });
        emit(game, 'state-changed', { previousState, state, mood }, `pet-${state}`);
      }
    }
    return game;
  }
  function addInstrument(game, config) {
    assertGame(game); const instrument = normalizeInstrument(config, game); game.instruments.push(instrument);
    emit(game, 'instrument-added', { id: instrument.id, name: instrument.name }, 'instrument-pop-in'); return instrument;
  }
  /** buy(game, symbol, quantity, {leverage?, price?}?) -> trade record. */
  function buy(game, symbol, quantity, options) {
    assertGame(game); const instrument = findInstrument(game, symbol);
    if (!instrument.tradable) throw new Error(`Instrument is not tradable: ${instrument.id}`);
    if (game.positions[instrument.id]?.side === 'short') throw new Error('Cover the short position before buying long');
    const qty = positive(quantity, 'quantity'); const opts = options || {};
    if ((game.mode === 'live' && (!instrument.hasSamples || instrument.stale)) || instrument.price <= 0) throw new Error('Wait for a positive observed price');
    if (game.mode === 'live' && opts.price !== undefined) throw new Error('Live fill price cannot be overridden');
    const leverage = finite(opts.leverage === undefined ? game.leverage : opts.leverage, 'leverage', 1, game.risk.maxLeverage);
    const price = positive(opts.price === undefined ? instrument.price * (1 + instrument.spread) : opts.price, 'price');
    const notional = safeMoney(price * qty); const margin = notional / leverage; const borrowed = notional - margin;
    if (game.cash + 1e-9 < margin) throw new Error('Insufficient cash for margin');
    if (totalDebt(game) + borrowed > (game.credit?.unlimited ? Number.MAX_SAFE_INTEGER : game.loanLimit) + 1e-9) throw new Error('Loan limit exceeded');
    const key = instrument.id; const old = game.positions[key]; const oldQty = old ? old.quantity : 0; const newQty = oldQty + qty;
    const oldCost = old ? old.avgPrice * oldQty : 0; game.cash = Math.max(0, game.cash - margin);
    if (old) { old.avgPrice = (oldCost + notional) / newQty; old.quantity = newQty; old.margin += margin; old.debt += borrowed; }
    else game.positions[key] = { instrumentId: key, side: 'long', quantity: qty, avgPrice: price, margin, debt: borrowed, accruedInterest: 0, openedAt: game.time };
    const trade = { action: 'buy', side: 'long', direction: 'open', leverage, instrumentId: key, quantity: qty, price, notional, margin, borrowed, time: game.time, tick: game.tickCount };
    emit(game, 'trade', trade, 'trade-buy'); return trade;
  }
  function shortValue(position, price) {
    return position.margin + (position.avgPrice - price) * position.quantity - (position.accruedInterest || 0);
  }
  function liquidateShort(game, instrument, price) {
    const p = game.positions[instrument.id];
    const value = shortValue(p, price);
    const payload = { instrumentId: instrument.id, side: 'short', quantity: p.quantity, price,
      direction: 'close', liquidated: true, pnlBasis: 'net-position-interest', notional: price * p.quantity, costBasis: p.avgPrice * p.quantity, grossPnl: (p.avgPrice - price) * p.quantity, interest: p.accruedInterest,
      marginLost: p.margin, deficit: Math.max(0, -value), realizedPnl: -p.margin, time: game.time, tick: game.tickCount };
    delete game.positions[instrument.id];
    emit(game, 'liquidation', payload, 'pet-liquidated');
    return payload;
  }
  function short(game, symbol, quantity, options) {
    assertGame(game); const instrument = findInstrument(game, symbol); const opts = options || {};
    const old = game.positions[instrument.id];
    if (old && old.side !== 'short') throw new Error('Sell the long position before opening short');
    if (!instrument.tradable || (game.mode === 'live' && (!instrument.hasSamples || instrument.stale)) || instrument.price <= 0) throw new Error('Wait for a positive fresh tradable price');
    if (opts.price !== undefined) throw new Error('Short fill price cannot be overridden');
    const qty = positive(quantity, 'quantity');
    const leverage = finite(opts.leverage === undefined ? game.leverage : opts.leverage, 'leverage', 1, game.risk.maxLeverage);
    const price = positive(instrument.price * (1 - instrument.spread), 'price');
    const notional = safeMoney(price * qty); const margin = notional / leverage;
    if (margin > game.cash) throw new Error('Insufficient cash for margin');
    const newQty = safeMoney((old?.quantity || 0) + qty);
    const cost = safeMoney((old ? old.avgPrice * old.quantity : 0) + notional);
    const newMargin = safeMoney((old?.margin || 0) + margin);
    game.cash -= margin;
    game.positions[instrument.id] = { instrumentId: instrument.id, side: 'short', quantity: newQty, avgPrice: cost / newQty, margin: newMargin, debt: 0, accruedInterest: old?.accruedInterest || 0, openedAt: old?.openedAt ?? game.time };
    const trade = { action: 'short', side: 'short', direction: 'open', leverage, instrumentId: instrument.id, quantity: qty, price, notional, margin, time: game.time, tick: game.tickCount };
    emit(game, 'trade', trade, 'trade-sell');
    checkLiquidations(game);
    return trade;
  }
  function cover(game, symbol, quantity, options) {
    assertGame(game); const instrument = findInstrument(game, symbol); const p = game.positions[instrument.id];
    if (!p || p.side !== 'short') throw new Error('No short position to cover');
    if (!instrument.tradable || (game.mode === 'live' && (!instrument.hasSamples || instrument.stale))) throw new Error('Wait for a fresh tradable price');
    if (options?.price !== undefined) throw new Error('Cover fill price cannot be overridden');
    const qty = quantity === undefined ? p.quantity : positive(quantity, 'quantity');
    if (qty > p.quantity) throw new Error('Cover quantity exceeds position');
    const price = safeMoney(instrument.price * (1 + instrument.spread));
    if (shortValue(p, price) <= 0) return liquidateShort(game, instrument, price);
    const notional = safeMoney(price * qty);
    const fraction = qty / p.quantity;
    const marginReleased = p.margin * fraction; const accruedInterest = p.accruedInterest * fraction;
    const costBasis = safeMoney(p.avgPrice * qty);
    const grossPnl = safeMoney(costBasis - notional);
    const realizedPnl = safeMoney(grossPnl - accruedInterest);
    const released = Math.max(0, marginReleased + realizedPnl);
    const nextCash = safeMoney(game.cash + released);
    game.cash = nextCash;
    if (qty === p.quantity) delete game.positions[instrument.id];
    else { p.quantity -= qty; p.margin -= marginReleased; p.accruedInterest -= accruedInterest; }
    const trade = { action: 'cover', side: 'short', direction: 'close', pnlBasis: 'net-position-interest', costBasis, grossPnl, interest: accruedInterest, instrumentId: instrument.id, quantity: qty, price, notional, marginReleased, accruedInterest, realizedPnl, time: game.time, tick: game.tickCount };
    emit(game, 'trade', trade, 'trade-buy'); return trade;
  }
  /** sell(game, symbol, quantity?, {price?}?) -> trade record; omitted quantity closes all. */
  function sell(game, symbol, quantity, options) {
    assertGame(game); const instrument = findInstrument(game, symbol);
    if (!instrument.tradable) throw new Error(`Instrument is not tradable: ${instrument.id}`);
    if (game.mode === 'live' && instrument.stale) throw new Error('Wait for a fresh observed price');
    const position = game.positions[instrument.id];
    if (position?.side === 'short') throw new Error('Use cover to close a short position');
    if (!position || position.quantity <= 0) throw new Error(`No open position for ${instrument.id}`);
    const qty = quantity === undefined ? position.quantity : positive(quantity, 'quantity');
    if (qty > position.quantity + 1e-9) throw new Error('Sell quantity exceeds position');
    const opts = options || {};
    if (game.mode === 'live' && opts.price !== undefined) throw new Error('Live fill price cannot be overridden');
    const price = finite(opts.price === undefined ? instrument.price * (1 - instrument.spread) : opts.price, 'price', 0);
    if (position.debt > 0 && price * position.quantity <= position.debt) return liquidate(game, instrument, price);
    const fraction = qty / position.quantity; const debtRepaid = position.debt * fraction; const marginReleased = position.margin * fraction;
    const costBasis = position.avgPrice * qty; const proceeds = price * qty; const grossPnl = proceeds - costBasis;
    const interest = position.accruedInterest === undefined ? undefined : position.accruedInterest * fraction;
    const realizedPnl = interest === undefined ? undefined : grossPnl - interest;
    game.cash += proceeds - debtRepaid; position.quantity -= qty; position.debt -= debtRepaid; position.margin -= marginReleased;
    if (interest !== undefined) position.accruedInterest -= interest;
    if (position.quantity <= 1e-9) delete game.positions[instrument.id];
    const trade = { action: 'sell', side: 'long', direction: 'close', pnlBasis: interest === undefined ? 'unknown' : 'net-position-interest', notional: proceeds, grossPnl, ...(interest === undefined ? {} : { interest, realizedPnl }), instrumentId: instrument.id, quantity: qty, price, proceeds, debtRepaid, marginReleased, costBasis, time: game.time, tick: game.tickCount };
    emit(game, 'trade', trade, (realizedPnl ?? grossPnl) >= 0 ? 'trade-sell-win' : 'trade-sell-loss'); return trade;
  }
  /** borrow(game, amount, {purpose?}?) -> loan record. */
  function borrow(game, amount, options) {
    assertGame(game); const value = positive(amount, 'amount');
    if (game.credit?.unlimited && (value < game.credit.minPerLoan || value > game.credit.maxPerLoan)) throw new RangeError('Each virtual loan must be 100000–3000000');
    safeMoney(game.cash + value); safeMoney(totalDebt(game) + value);
    if (!game.credit?.unlimited && totalDebt(game) + value > game.loanLimit + 1e-9) throw new Error('Loan limit exceeded');
    game.cash += value; game.loanBalance += value;
    const loan = { action: 'borrow', amount: value, purpose: options && options.purpose ? String(options.purpose) : 'personal', time: game.time, tick: game.tickCount };
    emit(game, 'loan', loan, 'loan-borrow'); return loan;
  }
  /** repay(game, amount?) -> loan record; defaults to all affordable outstanding debt. */
  function repay(game, amount) {
    assertGame(game); const debt = totalDebt(game);
    const value = amount === undefined ? Math.min(Math.max(0, game.cash), debt) : positive(amount, 'amount');
    if (value > game.cash + 1e-9) throw new Error('Insufficient cash to repay');
    if (value > debt + 1e-9) throw new Error('Repayment exceeds outstanding debt');
    let remaining = value; const personal = Math.min(game.loanBalance, remaining); game.loanBalance -= personal; remaining -= personal;
    if (remaining > 0) for (const key of Object.keys(game.positions).sort()) {
      const position = game.positions[key]; const paid = Math.min(position.debt, remaining);
      position.debt -= paid; remaining -= paid; if (remaining <= 1e-9) break;
    }
    game.cash = Math.max(0, game.cash - value); const payment = { action: 'repay', amount: value, time: game.time, tick: game.tickCount };
    emit(game, 'loan', payment, 'loan-repay'); return payment;
  }
  function setLeverage(game, multiplier) {
    assertGame(game); game.leverage = finite(multiplier, 'leverage', 1, game.risk.maxLeverage);
    emit(game, 'leverage-changed', { leverage: game.leverage }, 'leverage-change'); return game.leverage;
  }
  function setPersonality(game, values) {
    assertGame(game);
    if (!values || typeof values !== 'object') throw new TypeError('personality must be an object');
    const next = { ...game.personality };
    for (const key of Object.keys(PERSONALITY_DEFAULTS)) if (values[key] !== undefined) next[key] = finite(values[key], `personality.${key}`, 0, 1);
    game.personality = next;
    emit(game, 'personality-changed', { personality: { ...game.personality } }, 'personality-change'); return game.personality;
  }
  function equity(game) {
    assertGame(game); let assets = 0;
    for (const position of Object.values(game.positions)) {
      const instrument = game.instruments.find(item => item.id === position.instrumentId);
      if (instrument) assets += position.side === 'short' ? Math.max(0, shortValue(position, instrument.price)) : instrument.price * position.quantity;
    }
    return game.cash + assets - totalDebt(game);
  }
  /** snapshot(game) -> detached JSON-safe copy. */
  function snapshot(game) { assertGame(game); return copy(game); }
  function serialize(game) { return JSON.stringify(snapshot(game)); }
  function restoreGame(value) {
    const game = copy(typeof value === 'string' ? JSON.parse(value) : value); assertGame(game);
    for (const key of ['cash', 'time', 'tickCount', 'randomState', 'loanBalance']) if (!Number.isFinite(game[key])) throw new TypeError(`Invalid serialized game: ${key}`);
    if (!game.positions || typeof game.positions !== 'object' || Array.isArray(game.positions) || !game.indicators || typeof game.indicators !== 'object') throw new TypeError('Invalid serialized game state');
    for (const [id, position] of Object.entries(game.positions)) {
      const invalid = () => new TypeError(`Invalid serialized position: ${id}`);
      if (!position || typeof position !== 'object' || Array.isArray(position) || position.instrumentId !== id || !game.instruments.some(item => item.id === id)) throw invalid();
      if (position.side !== undefined && position.side !== 'long' && position.side !== 'short') throw invalid();
      for (const key of ['quantity', 'avgPrice', 'margin', 'debt']) {
        const value = position[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (['quantity', 'avgPrice'].includes(key) && value === 0)) throw invalid();
      }
      if (position.accruedInterest !== undefined && (typeof position.accruedInterest !== 'number' || !Number.isFinite(position.accruedInterest) || position.accruedInterest < 0)) throw invalid();
      if (position.side === 'short' && (position.debt !== 0 || typeof position.accruedInterest !== 'number' || !Number.isFinite(position.accruedInterest) || position.accruedInterest < 0)) throw invalid();
    }
    return attachMethods(game);
  }
  /** startAutoTick(game, onTick?, {intervalMs=1000}?) -> stop function. */
  function startAutoTick(game, onTick, options) {
    assertGame(game); if (autoTimers.has(game)) return () => stopAutoTick(game);
    const opts = options || {}; const intervalMs = finite(opts.intervalMs === undefined ? 1000 : opts.intervalMs, 'intervalMs', 1);
    const callback = typeof onTick === 'function' ? onTick : null;
    const timer = setInterval(() => { tick(game); if (callback) callback(game, snapshot(game)); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    autoTimers.set(game, timer); return () => stopAutoTick(game);
  }
  function stopAutoTick(game) {
    if (!game || typeof game !== 'object') return false; const timer = autoTimers.get(game);
    if (timer === undefined) return false; clearInterval(timer); autoTimers.delete(game); return true;
  }
  function drainEvents(game) { assertGame(game); return { events: game.events.splice(0), cues: game.cues.splice(0) }; }
  function getPosition(game, symbol) { assertGame(game); const p = game.positions[findInstrument(game, symbol).id]; return p ? copy(p) : null; }

  api = Object.freeze({ VERSION, createGame, ingestSamples, tick, buy, sell, short, cover, borrow, repay, bankruptcy, addInstrument, snapshot,
    serialize, restoreGame, setLeverage, setPersonality, setAutomation, equity, getPosition, drainEvents, startAutoTick, stopAutoTick });
  return api;
});
