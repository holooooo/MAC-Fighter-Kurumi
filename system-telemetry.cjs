'use strict';
const { execFile: nativeExecFile } = require('node:child_process');
const PERIOD_MS = 5000;
function parseCount(text) {
  const value = text.trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid kernel thread count');
  return Number(value);
}
function parseThreads(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (!lines.length || !lines[0].includes('PID')) throw new Error('Missing ps thread header');
  const rows = lines.slice(1);
  if (!rows.length || rows.some(line => !/^\S+\s+\d+\s/.test(line.trim()) && !/^\d+\s+[\d.]+\s+[A-Za-z+<>]+\s+\d+[A-Za-z]?\s+\d+:\d+\.\d+\s+\d+:\d+\.\d+\s*$/.test(line.trim()))) throw new Error('Invalid thread listing');
  return rows.length;
}
function createSystemTelemetry({ now = Date.now, execFile = nativeExecFile, platform = process.platform } = {}) {
  let last = -Infinity, cached = {}, pending;
  function command(file, args) {
    return new Promise(resolve => execFile(file, args, { timeout: 1500, maxBuffer: file === '/usr/sbin/sysctl' ? 8192 : 1024 * 1024, encoding: 'utf8', shell: false }, (error, stdout) => resolve(error ? null : stdout)));
  }
  async function sample(time = now()) {
    if (!Number.isFinite(time) || time < 0) throw new TypeError('Invalid time');
    if (pending) return pending;
    if (time - last < PERIOD_MS) return { samples: [], telemetry: structuredClone(cached) };
    last = time;
    pending = (async () => {
      const values = platform === 'darwin' ? await Promise.all([command('/bin/ps', ['-M', '-A']), command('/usr/sbin/sysctl', ['-n', 'net.inet.tcp.pcbcount'])]) : [null, null];
      const samples = [], telemetry = {};
      for (const [index, id, key, parse, unit, source] of [[0, 'THREADS', 'threads', parseThreads, 'threads', 'macos-ps-thread-list'], [1, 'CONNECTIONS', 'connections', parseCount, 'connections', 'macos-kernel-tcp-count']]) {
        let value = null;
        try { if (values[index] !== null) value = parse(values[index]); } catch {}
        telemetry[key] = { status: value === null ? 'unavailable' : 'available', value, time, unit, source };
        if (value !== null) samples.push({ id, value, time });
      }
      cached = telemetry;
      return { samples, telemetry: structuredClone(telemetry) };
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { sample };
}
function createTokenTelemetry({ now = Date.now } = {}) {
  const events = new Map();
  let lastReport = null, pending = 0, lastSample = null, lastRate = null;
  function record(body) {
    if (!body || typeof body.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.eventId) || !Number.isSafeInteger(body.tokens) || body.tokens < 0) throw new TypeError('Invalid token event');
    const time = body.time === undefined ? now() : body.time;
    const clock = now();
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time < clock - 60000 || time > clock + 5000) throw new TypeError('Invalid token event time');
    const prior = events.get(body.eventId);
    if (prior) {
      if (prior.tokens !== body.tokens || (body.time !== undefined && prior.time !== time)) throw new Error('Conflicting token event');
      return { duplicate: true };
    }
    if (!Number.isSafeInteger(pending + body.tokens)) throw new RangeError('Token total overflow');
    for (const [id, event] of events) if (clock - event.receivedAt >= 300000) events.delete(id);
    if (events.size >= 512) throw new RangeError('Token dedup capacity exceeded');
    events.set(body.eventId, { time, tokens: body.tokens, receivedAt: clock });
    pending += body.tokens; lastReport = Math.max(lastReport ?? time, time);
    return { duplicate: false };
  }
  function sample(time = now()) {
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || (lastSample !== null && time < lastSample)) throw new TypeError('Invalid sample time');
    const fresh = lastReport !== null && time - lastReport < 15000;
    const advances = lastSample === null || time > lastSample;
    if (fresh && advances) {
      lastRate = pending / Math.max(1, (time - (lastSample ?? time - 1000)) / 1000);
      pending = 0; lastSample = time;
    }
    if (!fresh) { pending = 0; lastSample = time; }
    const available = fresh && lastRate !== null;
    const metric = { status: available ? 'available' : lastReport === null || fresh ? 'unavailable' : 'stale', value: available ? lastRate : null, time, unit: 'tokens/s', source: 'dsh-token-events' };
    return { samples: available && advances ? [{ id: 'DSH', value: lastRate, time }] : [], telemetry: { dshTokens: metric } };
  }
  return { record, sample };
}
module.exports = { createSystemTelemetry, createTokenTelemetry, parseThreads, parseCount, PERIOD_MS };
