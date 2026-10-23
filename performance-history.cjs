'use strict';

// Observations only: no synthetic initial-capital point or interpolation/backfill.
const SAMPLE_INTERVAL_MS = 10000;
const MAX_POINTS = 720;
const POINT_KEYS = ['time', 'equity', 'pnl', 'returnPct', 'stale'];
const LEGACY_KEYS = ['baseline', 'startedAt', 'points', 'current', 'sampleIntervalMs'];
const STATE_KEYS = [...LEGACY_KEYS, 'episode', 'lastRun'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => finite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const copyPoint = point => point === null ? null : { ...point };

function empty(baseline) {
  return { baseline, startedAt: null, points: [], current: null, sampleIntervalMs: SAMPLE_INTERVAL_MS, episode: 1, lastRun: null };
}
function measuredPoint(baseline, time, equity, stale) {
  if (!timestamp(time) || !finite(equity) || typeof stale !== 'boolean') throw new TypeError('Invalid performance observation');
  const pnl = equity - baseline;
  const returnPct = baseline === 0 ? null : pnl / baseline * 100;
  if (!finite(pnl) || (returnPct !== null && !finite(returnPct))) throw new RangeError('Performance arithmetic overflow');
  return { time, equity, pnl, returnPct, stale };
}
function validPoint(point, baseline, latestTime) {
  if (!exactKeys(point, POINT_KEYS) || !timestamp(point.time) || point.time > latestTime) return false;
  try {
    const expected = measuredPoint(baseline, point.time, point.equity, point.stale);
    return POINT_KEYS.every(key => point[key] === expected[key]);
  } catch { return false; }
}
function restore(baseline, value, latestTime) {
  const fallback = empty(baseline);
  try {
    if (exactKeys(value, LEGACY_KEYS)) value = { ...value, episode: 1, lastRun: null };
    if (!exactKeys(value, STATE_KEYS) || value.baseline !== baseline || value.sampleIntervalMs !== SAMPLE_INTERVAL_MS || !Array.isArray(value.points) || value.points.length > MAX_POINTS) return fallback;
    if (!Number.isSafeInteger(value.episode) || value.episode < 1) return fallback;
    if (value.lastRun !== null) {
      const run = value.lastRun;
      if (!exactKeys(run, ['episode', 'baseline', 'startedAt', 'endedAt', 'equity', 'pnl', 'returnPct', 'points']) || !Number.isSafeInteger(run.episode) || run.episode !== value.episode - 1 || !finite(run.baseline) || run.baseline < 0 || !timestamp(run.endedAt) || run.endedAt > latestTime || !Array.isArray(run.points) || run.points.length > 120 || run.points.length < 1) return fallback;
      const previous = restore(run.baseline, { baseline: run.baseline, startedAt: run.startedAt, points: run.points, current: run.points.at(-1), sampleIntervalMs: SAMPLE_INTERVAL_MS, episode: run.episode, lastRun: null }, latestTime);
      if (!previous.current || previous.current.time !== run.endedAt || previous.current.equity !== run.equity || previous.current.pnl !== run.pnl || previous.current.returnPct !== run.returnPct) return fallback;
    }
    if (value.points.length === 0) return fallback;
    if (!timestamp(value.startedAt) || value.startedAt > value.points[0].time) return fallback;
    let lastBucket = -1;
    for (const point of value.points) {
      if (!validPoint(point, baseline, latestTime)) return fallback;
      const bucket = Math.floor(point.time / SAMPLE_INTERVAL_MS);
      if (bucket <= lastBucket) return fallback;
      lastBucket = bucket;
    }
    const last = value.points[value.points.length - 1];
    if (!validPoint(value.current, baseline, latestTime) || !POINT_KEYS.every(key => value.current[key] === last[key])) return fallback;
    return { baseline, startedAt: value.startedAt, points: value.points.map(copyPoint), current: copyPoint(last), sampleIntervalMs: SAMPLE_INTERVAL_MS, episode: value.episode, lastRun: value.lastRun === null ? null : JSON.parse(JSON.stringify(value.lastRun)) };
  } catch { return fallback; }
}

/** baseline is initialCash, returnPct uses percent units (5 means +5%).
 * Invalid restored performance is discarded independently of account state.
 * Older live timestamps are ignored; the newest observation replaces its bucket.
 */
function createPerformanceHistory({ baseline, restored, now = Date.now } = {}) {
  if (!finite(baseline) || baseline < 0) throw new TypeError('baseline must be finite and nonnegative');
  const latestTime = now();
  if (!timestamp(latestTime)) throw new TypeError('Invalid performance clock');
  let state = restore(baseline, restored, latestTime);
  function snapshot() {
    return { baseline, startedAt: state.startedAt, points: state.points.map(copyPoint), current: copyPoint(state.current), sampleIntervalMs: SAMPLE_INTERVAL_MS, episode: state.episode, lastRun: state.lastRun === null ? null : JSON.parse(JSON.stringify(state.lastRun)) };
  }
  function record({ time, equity, stale = false } = {}) {
    const point = measuredPoint(baseline, time, equity, stale);
    if (state.current && time < state.current.time) return snapshot();
    if (state.startedAt === null) state.startedAt = time;
    const last = state.points[state.points.length - 1];
    if (last && Math.floor(last.time / SAMPLE_INTERVAL_MS) === Math.floor(time / SAMPLE_INTERVAL_MS)) state.points[state.points.length - 1] = point;
    else state.points.push(point);
    if (state.points.length > MAX_POINTS) state.points.splice(0, state.points.length - MAX_POINTS);
    state.current = point;
    return snapshot();
  }
  function reset({ baseline: nextBaseline = 0, time, reason = 'bankruptcy' } = {}) {
    if (!finite(nextBaseline) || nextBaseline < 0 || !timestamp(time) || (state.current && time < state.current.time) || reason !== 'bankruptcy') throw new TypeError('Invalid performance reset');
    const old = snapshot();
    const lastRun = old.current ? { episode: old.episode, baseline: old.baseline, startedAt: old.startedAt, endedAt: old.current.time, equity: old.current.equity, pnl: old.current.pnl, returnPct: old.current.returnPct, points: old.points.slice(-120) } : null;
    baseline = nextBaseline;
    state = { ...empty(baseline), episode: old.episode + 1, lastRun };
    return record({ time, equity: nextBaseline });
  }
  return Object.freeze({ record, snapshot, reset });
}

module.exports = { createPerformanceHistory, SAMPLE_INTERVAL_MS, MAX_POINTS };
