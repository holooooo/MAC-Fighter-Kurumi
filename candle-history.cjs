'use strict';

// Real observations only. Compact persistence keeps three independent frames bounded.
const FRAMES = Object.freeze({ minute: 60000, hour: 3600000, day: 86400000 });
const MAX_BARS = 180;
const MAX_MARKETS = 64;
const MAX_TRADES = 500;
const MAX_HISTORY_BYTES = 1024 * 1024;
const DETAIL_NUMBERS = ['notional', 'leverage', 'margin', 'marginReleased', 'debtRepaid', 'costBasis', 'interest', 'grossPnl', 'borrowed', 'deficit', 'marginLost'];
const finite = Number.isFinite;
const timestamp = value => finite(value) && value >= 0 && value <= 8640000000000000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idValid = id => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const clone = value => JSON.parse(JSON.stringify(value));
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
function timeframe(value = 'minute') {
  if (!Object.hasOwn(FRAMES, value)) throw new TypeError('timeframe must be minute, hour, or day');
  return value;
}
function bucketStart(time, frame) {
  timeframe(frame);
  if (!timestamp(time)) throw new TypeError('Invalid observation time');
  if (frame !== 'day') return Math.floor(time / FRAMES[frame]) * FRAMES[frame];
  // Calendar midnight, not a fixed 24-hour step: DST days can be 23 or 25 hours.
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
function empty(episode = 1) {
  return { version: 1, timeZone: zone(), episode, partialHistory: true, truncated: false,
    frames: Object.fromEntries(Object.keys(FRAMES).map(key => [key, { markets: {}, equity: [] }])),
    cursors: { markets: {}, equity: null }, eventCursor: 0, trades: [], diaryStartedAt: null, tradesTruncated: false };
}
function checkOHLC(bar) {
  return object(bar) && timestamp(bar.time) && [bar.open, bar.high, bar.low, bar.close].every(finite)
    && bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close)
    && bar.high >= bar.low && Number.isSafeInteger(bar.count) && bar.count > 0;
}
function checkTrade(trade, latest) {
  if (!object(trade) || Object.keys(trade).some(key => !['id', 'time', 'instrumentId', 'action', 'side', 'price', 'quantity', 'realizedPnl', 'direction', 'pnlBasis', 'episode', 'liquidated', ...DETAIL_NUMBERS].includes(key))) return false;
  return typeof trade.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(trade.id) && timestamp(trade.time) && trade.time <= latest + 5000
    && idValid(trade.instrumentId) && ['buy', 'sell', 'short', 'cover'].includes(trade.action)
    && trade.side === (['short', 'cover'].includes(trade.action) ? 'short' : 'long')
    && finite(trade.price) && trade.price >= 0 && finite(trade.quantity) && trade.quantity > 0
    && (trade.realizedPnl === undefined || finite(trade.realizedPnl))
    && DETAIL_NUMBERS.every(key => trade[key] === undefined || (finite(trade[key]) && (key === 'grossPnl' || trade[key] >= 0)))
    && (trade.direction === undefined || trade.direction === (['buy', 'short'].includes(trade.action) ? 'open' : 'close'))
    && (trade.pnlBasis === undefined || ['unknown', 'net-position-interest'].includes(trade.pnlBasis))
    && (trade.episode === undefined || (Number.isSafeInteger(trade.episode) && trade.episode > 0))
    && (trade.liquidated === undefined || typeof trade.liquidated === 'boolean');
}
function validateStore(value, latest, ids) {
  if (!exact(value, ['version', 'timeZone', 'episode', 'partialHistory', 'truncated', 'frames', 'cursors', 'eventCursor', 'trades', 'diaryStartedAt', 'tradesTruncated']) || value.version !== 1 || value.timeZone !== zone()
    || !Number.isSafeInteger(value.eventCursor) || value.eventCursor < 0
    || !Number.isSafeInteger(value.episode) || value.episode < 1 || typeof value.partialHistory !== 'boolean' || typeof value.truncated !== 'boolean'
    || !exact(value.frames, Object.keys(FRAMES)) || !exact(value.cursors, ['markets', 'equity']) || !object(value.cursors.markets)
    || Object.keys(value.cursors.markets).length > MAX_MARKETS || !Array.isArray(value.trades) || value.trades.length > MAX_TRADES) return false;
  if ((value.diaryStartedAt !== null && (!timestamp(value.diaryStartedAt) || value.diaryStartedAt > latest + 5000)) || typeof value.tradesTruncated !== 'boolean') return false;
  const legal = id => idValid(id) && (!ids || ids.has(id));
  for (const [id, time] of Object.entries(value.cursors.markets)) if (!legal(id) || !timestamp(time) || time > latest + 5000) return false;
  const cursor = value.cursors.equity;
  if (cursor !== null && (!exact(cursor, ['time', 'value', 'stale']) || !timestamp(cursor.time) || cursor.time > latest + 5000 || !finite(cursor.value) || typeof cursor.stale !== 'boolean')) return false;
  for (const [frame, series] of Object.entries(value.frames)) {
    if (!exact(series, ['markets', 'equity']) || !object(series.markets) || Object.keys(series.markets).length > MAX_MARKETS) return false;
    for (const [id, bars] of [...Object.entries(series.markets), [null, series.equity]]) {
      if (id !== null && (!legal(id) || !Object.hasOwn(value.cursors.markets, id))) return false;
      if (!Array.isArray(bars) || bars.length > MAX_BARS) return false;
      let previous = -Infinity;
      for (const row of bars) {
        if (!Array.isArray(row) || row.length !== 7) return false;
        const [time, open, high, low, close, count, stale] = row;
        // The bucket containing epoch zero may begin on the previous local day.
        if (!finite(time) || time < -86400000 || time > latest + 5000 || time <= previous || ![open, high, low, close].every(finite)
          || high < Math.max(open, close) || low > Math.min(open, close) || high < low || !Number.isSafeInteger(count) || count < 1 || typeof stale !== 'boolean') return false;
        if (frame !== 'day' ? time % FRAMES[frame] !== 0 : (() => { const date = new Date(time); return date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0 || date.getMilliseconds() !== 0; })()) return false;
        if (id !== null && (low < 0 || stale || time > value.cursors.markets[id])) return false;
        if (id === null && (!cursor || time > cursor.time)) return false;
        previous = time;
      }
    }
  }
  const seen = new Set();
  for (const trade of value.trades) {
    if (!checkTrade(trade, latest) || seen.has(trade.id)) return false;
    seen.add(trade.id);
  }
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_HISTORY_BYTES;
}

function createCandleHistory({ restored, now = Date.now, instrumentIds, episode = 1 } = {}) {
  const latest = now();
  if (!timestamp(latest)) throw new TypeError('Invalid history clock');
  if (!Number.isSafeInteger(episode) || episode < 1) throw new TypeError('Invalid episode');
  const ids = instrumentIds ? new Set(instrumentIds) : null;
  if (object(restored) && restored.diaryStartedAt === undefined && restored.tradesTruncated === undefined) restored = { ...restored, diaryStartedAt: restored.trades?.[0]?.time ?? null, tradesTruncated: (restored.trades?.length || 0) >= MAX_TRADES };
  let state = empty(episode), restoredOK = false;
  if (restored !== undefined && validateStore(restored, latest, ids) && restored.episode === episode) {
    state = clone(restored); restoredOK = true;
  }
  let tradeIds = new Set(state.trades.map(trade => trade.id));
  function prune() {
    // 64*3*180 full bars can exceed a modest app state. Enforce a second byte
    // budget as well as per-series caps, evicting oldest observations, not filling gaps.
    if (Buffer.byteLength(JSON.stringify(state)) <= MAX_HISTORY_BYTES) return;
    const lists = Object.values(state.frames).flatMap(series => [series.equity, ...Object.values(series.markets)]);
    const candidates = lists.flatMap(list => list.slice(0, -1).map(row => ({ list, time: row[0] })));
    candidates.sort((a, b) => a.time - b.time);
    const target = Math.floor(candidates.length / 8) + 1;
    for (let offset = 0; offset < candidates.length;) {
      for (const entry of candidates.slice(offset, offset + target)) { entry.list.shift(); state.truncated = true; }
      offset += target;
      if (Buffer.byteLength(JSON.stringify(state)) <= MAX_HISTORY_BYTES) return;
    }
  }
  function aggregate(list, frame, bar, stale = false) {
    const time = bucketStart(bar.time, frame), last = list.at(-1);
    if (last && time < last[0]) return;
    if (last && last[0] === time) {
      const count = last[5] + bar.count;
      if (!Number.isSafeInteger(count)) throw new RangeError('Candle observation count overflow');
      last[2] = Math.max(last[2], bar.high); last[3] = Math.min(last[3], bar.low); last[4] = bar.close; last[5] = count; last[6] ||= stale;
    } else {
      list.push([time, bar.open, bar.high, bar.low, bar.close, bar.count, stale]);
      if (list.length > MAX_BARS) { list.splice(0, list.length - MAX_BARS); state.truncated = true; }
    }
  }
  function ingestBars(id, bars, cursorTime) {
    if (!idValid(id) || (ids && !ids.has(id)) || !Array.isArray(bars) || bars.some(bar => !checkOHLC(bar) || bar.low < 0)) throw new TypeError('Invalid market observations');
    if (!Object.hasOwn(state.cursors.markets, id) && Object.keys(state.cursors.markets).length >= MAX_MARKETS) throw new RangeError('Market history capacity exceeded');
    const ordered = [...bars].sort((a, b) => a.time - b.time);
    let cursor = state.cursors.markets[id] ?? -Infinity;
    for (const bar of ordered) {
      if (bar.time <= cursor) continue;
      for (const [frame, series] of Object.entries(state.frames)) {
        if (!Object.hasOwn(series.markets, id)) Object.defineProperty(series.markets, id, { value: [], enumerable: true, writable: true, configurable: true });
        aggregate(series.markets[id], frame, bar);
      }
      cursor = bar.time;
    }
    if (cursor !== -Infinity) state.cursors.markets[id] = Math.max(cursor, timestamp(cursorTime) ? cursorTime : cursor);
  }
  function recordSamples(samples) {
    if (!Array.isArray(samples)) throw new TypeError('Expected samples');
    for (const sample of samples) if (!object(sample) || !idValid(sample.id) || (ids && !ids.has(sample.id)) || !timestamp(sample.time) || !finite(sample.value) || sample.value < 0) throw new TypeError('Invalid market observation');
    const added = new Set([...Object.keys(state.cursors.markets), ...samples.map(sample => sample.id)]);
    if (added.size > MAX_MARKETS) throw new RangeError('Market history capacity exceeded');
    for (const sample of samples) ingestBars(sample.id, [{ time: sample.time, open: sample.value, high: sample.value, low: sample.value, close: sample.value, count: 1 }]);
    prune();
  }
  function recordEquity({ time, value, stale = false }) {
    if (!timestamp(time) || !finite(value) || typeof stale !== 'boolean') throw new TypeError('Invalid equity observation');
    const last = state.cursors.equity;
    if (last && (time < last.time || (time === last.time && value === last.value && stale === last.stale))) return;
    const bar = { time, open: value, high: value, low: value, close: value, count: 1 };
    for (const [frame, series] of Object.entries(state.frames)) aggregate(series.equity, frame, bar, stale);
    state.cursors.equity = { time, value, stale };
    prune();
  }
  function recordTrades(trades) {
    if (!Array.isArray(trades) || trades.some(trade => !checkTrade(trade, now()))) throw new TypeError('Invalid transaction journal entry');
    for (const trade of trades) {
      if (tradeIds.has(trade.id)) continue;
      state.diaryStartedAt ??= trade.time;
      state.trades.push(clone(trade)); tradeIds.add(trade.id);
      while (state.trades.length > MAX_TRADES) { tradeIds.delete(state.trades.shift().id); state.tradesTruncated = true; }
    }
    prune();
  }
  function bootstrap(instruments, performance) {
    if (restoredOK) return;
    for (const instrument of instruments || []) {
      const bars = [...(instrument.history || []), ...(instrument.currentCandle ? [instrument.currentCandle] : [])]
        .filter(bar => Number.isSafeInteger(bar.volume) && bar.volume > 0)
        .map(bar => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, count: bar.volume }));
      // Seed full observed 10-second OHLC ranges, never substitute only the close.
      if (bars.length) ingestBars(instrument.id, bars, instrument.sampleTime);
    }
    for (const point of performance?.points || []) recordEquity({ time: point.time, value: point.equity, stale: point.stale === true });
    state.partialHistory = true; // Prior engine events are deliberately NOT replayed as a complete trade ledger.
    prune();
  }
  function resetEquity(nextEpisode, time) {
    if (!Number.isSafeInteger(nextEpisode) || nextEpisode < 1 || !timestamp(time)) throw new TypeError('Invalid equity episode');
    for (const series of Object.values(state.frames)) series.equity = [];
    state.episode = nextEpisode; state.cursors.equity = null;
    recordEquity({ time, value: 0 });
  }
  function recordEvents(events, eventSequence) {
    if (!Array.isArray(events) || !Number.isSafeInteger(eventSequence) || eventSequence < 0) throw new TypeError('Invalid event cursor');
    const trades = [];
    for (const event of events) {
      const sequence = typeof event?.id === 'string' && /^\d+:\d+$/.test(event.id) ? Number(event.id.split(':')[1]) : -1;
      if (!Number.isSafeInteger(sequence) || sequence < state.eventCursor || sequence >= eventSequence) continue;
      if (!['trade', 'liquidation'].includes(event.type)) continue;
      const payload = event.payload || {};
      const side = payload.side === 'short' || ['short', 'cover'].includes(payload.action) ? 'short' : 'long';
      const action = event.type === 'liquidation' ? (side === 'short' ? 'cover' : 'sell') : payload.action;
      const trade = { id: event.id, time: payload.time ?? event.time, instrumentId: payload.instrumentId, action, side, price: payload.price, quantity: payload.quantity,
        ...(finite(payload.realizedPnl) ? { realizedPnl: payload.realizedPnl } : {}) };
      trade.direction = ['buy', 'short'].includes(action) ? 'open' : 'close';
      trade.episode = state.episode;
      trade.pnlBasis = payload.pnlBasis || 'unknown';
      if (event.type === 'liquidation') trade.liquidated = true;
      for (const key of DETAIL_NUMBERS) if (finite(payload[key])) trade[key] = payload[key];
      if (checkTrade(trade, now())) trades.push(trade);
    }
    recordTrades(trades);
    state.eventCursor = Math.max(state.eventCursor, eventSequence);
  }
  function trimToBytes(maxBytes = MAX_HISTORY_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('Invalid history budget');
    let bytes = Buffer.byteLength(JSON.stringify(state));
    if (bytes <= maxBytes) return bytes;
    const lists = Object.values(state.frames).flatMap(series => [series.equity, ...Object.values(series.markets)]);
    const candidates = lists.flatMap(list => list.map(row => ({ list, time: row[0] }))).sort((a, b) => a.time - b.time);
    for (let offset = 0; bytes > maxBytes && offset < candidates.length;) {
      const batch = Math.max(1, Math.ceil((candidates.length - offset) / 8));
      for (const entry of candidates.slice(offset, offset + batch)) { entry.list.shift(); state.truncated = true; }
      offset += batch;
      bytes = Buffer.byteLength(JSON.stringify(state));
    }
    return bytes;
  }
  function diary() {
    return { entries: clone(state.trades).map(trade => ({ ...trade, direction: trade.direction || (['buy', 'short'].includes(trade.action) ? 'open' : 'close'), pnlBasis: trade.pnlBasis || 'unknown' })), limit: MAX_TRADES, truncated: state.tradesTruncated, startedAt: state.diaryStartedAt, oldestRetainedAt: state.trades[0]?.time ?? null, partialHistory: true };
  }
  function view(selected = 'minute') {
    const frame = timeframe(selected), series = state.frames[frame];
    const expand = row => ({ time: row[0], open: row[1], high: row[2], low: row[3], close: row[4], count: row[5], ...(row[6] ? { stale: true } : {}) });
    return { timeframe: frame, timeZone: state.timeZone, intervalMs: FRAMES[frame], episode: state.episode,
      markets: Object.fromEntries(Object.entries(series.markets).map(([id, bars]) => [id, bars.map(expand)])), equity: series.equity.map(expand),
      trades: clone(state.trades), partialHistory: state.partialHistory, truncated: state.truncated,
      historyBudget: { maxBarsPerSeries: MAX_BARS, maxTrades: MAX_TRADES, maxBytes: MAX_HISTORY_BYTES },
      oldestNotice: state.truncated ? '仅保留有界最近历史；更早观测已按容量淘汰，不补齐空白。' : '仅包含已实际记录的观测，尚无更早历史。',
      notice: '仅保存已观测行情与有凭据的实际成交；迁移前成交日志可能不完整。' };
  }
  return Object.freeze({ recordSamples, recordEquity, recordTrades, recordEvents, bootstrap, resetEquity, trimToBytes, view, diary, snapshot: () => clone(state), restored: restoredOK });
}

module.exports = { createCandleHistory, bucketStart, timeframe, FRAMES, MAX_BARS, MAX_MARKETS, MAX_TRADES, MAX_HISTORY_BYTES };
