'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const os = require('node:os');
const Engine = require('./pet-engine.js');
const { createAgentTelemetry } = require('./agent-telemetry.cjs');
const { createSystemTelemetry, createTokenTelemetry } = require('./system-telemetry.cjs');
const { createPerformanceHistory } = require('./performance-history.cjs');
const { createCandleHistory, timeframe } = require('./candle-history.cjs');

const ROOT = __dirname;
const RESERVED = new Set(['CPU', 'MEM', 'LOAD', 'MOUSE_DISTANCE', 'MOUSE_CLICKS', 'KEYBOARD', 'THREADS', 'CONNECTIONS', 'DSH']);
const PERIPHERALS = { MOUSE_DISTANCE: { metric: 'mouseDistance', unit: 'points/s', source: 'macos-pointer-distance' }, MOUSE_CLICKS: { metric: 'mouseClicks', unit: 'clicks/s', source: 'macos-click-counter' }, KEYBOARD: { metric: 'keyboard', unit: 'keys/s', source: 'macos-key-counter' } };
const AGENT_IDS = new Set(['CODEX', 'CLAUDE', 'DSH']);
const STATIC_FILES = new Set(['pet.html', 'pet.css', 'pet-ui.js', 'pet-engine.js', 'pet-bootstrap.js', 'pet-charts.js', 'pet-animation.js', 'pet-diary.js', 'pet-speech.js', 'pet-diary.css']);
const TYPES = { '.md': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp4': 'video/mp4', '.gif': 'image/gif' };
const MAX_BODY = 32768;
// Chart history has its own 1 MiB cap; the remaining budget holds account,
// 10-second strategy candles, performance episodes and bounded engine events.
const MAX_STATE = 2 * 1024 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });
const unavailable = () => ({ status: 'unavailable', value: null });

function createCpuSampler(provider) {
  let previous = null;
  return function sampleCpu() {
    const cpus = provider.cpus();
    if (!Array.isArray(cpus) || !cpus.length) { previous = null; return null; }
    const current = cpus.map(cpu => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((a, b) => a + b, 0) }));
    const before = previous;
    previous = current;
    if (!before || before.length !== current.length) return null;
    let idle = 0, total = 0;
    for (let i = 0; i < current.length; i++) {
      const dt = current[i].total - before[i].total;
      const di = current[i].idle - before[i].idle;
      if (dt < 0 || di < 0 || di > dt) return null;
      total += dt; idle += di;
    }
    return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { tooLarge = true; chunks = []; }
      else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(fail(413, 'Request body exceeds 32 KiB'));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('object required');
        resolve(value);
      } catch { reject(fail(400, 'Expected a JSON object')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(fail(400, 'Request aborted')));
  });
}

function createService(options = {}) {
  const engine = options.engine || Engine;
  const provider = options.os || os;
  const now = options.now || Date.now;
  const root = path.resolve(options.root || ROOT);
  const statePath = options.statePath === null ? null : path.resolve(options.statePath || path.join(os.homedir(), '.kurumi', 'live-state.json'));
  const onError = options.onError || (error => console.error('[kurumi]', error.message));
  let game, performance, charts, timer, queue = Promise.resolve(), lastSaveAt = 0, dirty = false, stopping = false, scheduledSample = false;
  let message = null, expression = null, cueSequence = 0;
  const cues = [];
  let telemetry = { mode: 'live', sampledAt: null, cpu: unavailable(), memory: unavailable(), load: unavailable(), mouseDistance: unavailable(), mouseClicks: unavailable(), keyboard: unavailable(), threads: unavailable(), connections: unavailable(), dshTokens: unavailable(), codexActivity: unavailable(), claudeActivity: unavailable(), dshActivity: unavailable() };
  const cpu = createCpuSampler(provider);
  const agents = createAgentTelemetry({ now });
  const system = options.systemTelemetry || createSystemTelemetry({ now, platform: provider.platform(), execFile: options.execFile });
  const tokens = createTokenTelemetry({ now });
  function serial(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  }
  function heldQuotesStale(account, time) {
    return Object.values(account.positions).some(position => {
      if (!(position.quantity > 0)) return false;
      const instrument = account.instruments.find(item => item.id === position.instrumentId);
      return !instrument || instrument.stale === true || !instrument.hasSamples || !Number.isFinite(instrument.sampleTime) || time - instrument.sampleTime > 15000;
    });
  }
  function performanceView() {
    const result = performance.snapshot();
    // Persisted points describe past observations. Mark only the returned current
    // valuation stale after restart/disconnection; never rewrite its history.
    if (result.current && heldQuotesStale(game, now())) result.current.stale = true;
    return result;
  }
  function state(selected = 'minute') { return { game: game.snapshot(), performance: performanceView(), chartHistory: charts.view(selected), tradeDiary: charts.diary(), telemetry, message, expression, cues: [...cues], server: { mode: 'live', protocolVersion: 2, sampleIntervalMs: 1000, trading: 'virtual', persistence: statePath ? 'local' : 'disabled' } }; }
  function envelope(account = game, history = performance, time = now(), candles = charts) {
    return { version: 1, savedAt: time, game: account.snapshot(), performance: history.snapshot(), candleHistory: candles.snapshot() };
  }
  function enforceBudget(account = game, history = performance, candles = charts, time = now()) {
    const base = { version: 1, savedAt: time, game: account.snapshot(), performance: history.snapshot(), candleHistory: null };
    const room = Math.max(0, MAX_STATE - Buffer.byteLength(JSON.stringify(base)) - 32);
    candles.trimToBytes(Math.min(1024 * 1024, room));
    if (Buffer.byteLength(JSON.stringify(envelope(account, history, time, candles))) > MAX_STATE) throw fail(400, 'State size limit exceeded');
  }
  function cloneCharts(account, restored = charts.snapshot()) {
    return createCandleHistory({ restored, now, instrumentIds: account.instruments.map(item => item.id), episode: performance.snapshot().episode });
  }
  function recordPerformance(time = now()) {
    const value = engine.equity(game), stale = heldQuotesStale(game, time);
    performance.record({ time, equity: value, stale });
    charts.recordEquity({ time, value, stale });
    charts.recordEvents(game.events, game.eventSequence);
  }
  function validateSnapshot(snapshot) {
    if (snapshot.mode !== 'live' || !Array.isArray(snapshot.instruments) || snapshot.instruments.length > 64) throw new Error('Invalid live snapshot');
    if (snapshot.market?.historyLimit > 120 || snapshot.eventLimit > 100) throw new Error('Snapshot limits exceeded');
    if (!['CPU', 'MEM', 'LOAD'].every(id => snapshot.instruments.some(item => item.id === id))) throw new Error('Missing system instruments');
    for (const item of snapshot.instruments) if (item.history?.length > 120) throw new Error('History limit exceeded');
    return snapshot;
  }
  async function persist(force = false) {
    if (!statePath || !dirty || (!force && now() - lastSaveAt < 30000)) return;
    validateSnapshot(game.snapshot());
    enforceBudget();
    const text = JSON.stringify(envelope());
    await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    // Fixed, verified sibling path; atomic replacement applies only to this service's own state.
    const temporary = statePath + '.tmp';
    await fs.writeFile(temporary, text, { mode: 0o600 });
    await fs.rename(temporary, statePath);
    lastSaveAt = now(); dirty = false;
  }
  async function sample() {
    const time = now();
    const cpuValue = cpu();
    const total = provider.totalmem(), free = provider.freemem();
    const memoryValue = Number.isFinite(total) && total > 0 && Number.isFinite(free) && free >= 0 && free <= total ? (1 - free / total) * 100 : null;
    const loadValue = provider.platform() === 'win32' ? null : provider.loadavg()[0];
    const available = (value, unit) => Number.isFinite(value) && value >= 0 ? { status: 'available', value, unit, time } : unavailable();
    const agentState = agents.sample(time);
    const systemState = await system.sample(time);
    const tokenState = tokens.sample(time);
    telemetry = { ...telemetry, ...agentState.telemetry, ...systemState.telemetry, ...tokenState.telemetry, sampledAt: time, cpu: available(cpuValue, '%'), memory: available(memoryValue, '%'), load: available(loadValue, 'load') };
    const samples = [['CPU', telemetry.cpu], ['MEM', telemetry.memory], ['LOAD', telemetry.load]].filter(([, metric]) => metric.status === 'available').map(([id, metric]) => ({ id, value: metric.value, time }));
    samples.push(...systemState.samples, ...tokenState.samples);
    const received = new Set(samples.map(sample => sample.id));
    mutate(candidate => {
    for (const instrument of candidate.instruments) {
      if (RESERVED.has(instrument.id) && !Object.hasOwn(PERIPHERALS, instrument.id) && !received.has(instrument.id) && !(['THREADS', 'CONNECTIONS'].includes(instrument.id) && telemetry[instrument.id === 'THREADS' ? 'threads' : 'connections']?.status === 'available' && time - instrument.sampleTime < 6000)) {
        instrument.stale = true;
        if (instrument.metric && candidate.indicators[instrument.metric]) candidate.indicators[instrument.metric].status = 'unavailable';
      }
      if ((!RESERVED.has(instrument.id) || Object.hasOwn(PERIPHERALS, instrument.id)) && instrument.hasSamples && time - instrument.sampleTime > 15000) {
        instrument.stale = true;
        const peripheral = PERIPHERALS[instrument.id];
        if (peripheral && telemetry[peripheral.metric]) telemetry[peripheral.metric] = { ...telemetry[peripheral.metric], status: 'stale', value: null };
        if (instrument.metric && telemetry[instrument.metric]?.status === 'available') telemetry[instrument.metric] = { ...telemetry[instrument.metric], status: 'stale' };
      }
    }
    engine.ingestSamples(candidate, samples);
    // Live tick advances bookkeeping without inventing observations.
    engine.tick(candidate, { count: 1, time });
    }, samples);
    await persist();
    return state();
  }
  function mutate(action, observations = []) {
    // Account, curve and transaction journal commit together, including auto fills.
    const candidate = engine.restoreGame(game.snapshot());
    const time = now();
    candidate.time = time;
    action(candidate);
    if (candidate.instruments.length > 64) throw fail(400, 'At most 64 instruments');
    const nextPerformance = createPerformanceHistory({ baseline: candidate.initialCash, restored: performance.snapshot(), now: () => Math.max(time, performance.snapshot().current?.time || 0) });
    const value = engine.equity(candidate), stale = heldQuotesStale(candidate, time);
    nextPerformance.record({ time, equity: value, stale });
    const nextCharts = cloneCharts(candidate);
    nextCharts.recordSamples(observations.map(sample => ({ ...sample, id: candidate.instruments.find(item => item.id === sample.id.toUpperCase() || item.symbol === sample.id.toUpperCase()).id })));
    nextCharts.recordEquity({ time, value, stale });
    nextCharts.recordEvents(candidate.events, candidate.eventSequence);
    enforceBudget(candidate, nextPerformance, nextCharts, time);
    game = candidate; performance = nextPerformance; charts = nextCharts; dirty = true;
    return state();
  }
  function action(body) {
    if (body.action === 'bankruptcy') {
      const time = now();
      const candidate = engine.restoreGame(game.snapshot());
      candidate.time = time;
      const history = createPerformanceHistory({ baseline: game.initialCash, restored: performance.snapshot(), now });
      history.record({ time, equity: engine.equity(candidate), stale: heldQuotesStale(candidate, time) });
      engine.bankruptcy(candidate);
      history.reset({ baseline: 0, time, reason: 'bankruptcy' });
      const nextCharts = cloneCharts(candidate);
      nextCharts.recordEvents(candidate.events, candidate.eventSequence);
      nextCharts.resetEquity(history.snapshot().episode, time);
      enforceBudget(candidate, history, nextCharts, time);
      game = candidate; performance = history; charts = nextCharts; dirty = true;
      return state();
    }
    if (body.action === 'say' || body.action === 'expression') {
      const time = now();
      if (body.action === 'say') {
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 280) throw fail(400, 'Text must contain 1–280 characters');
        message = { text: body.text.trim(), time };
      } else {
        if (!['idle', 'buy', 'profit', 'sell', 'loss', 'liquidation', 'happy', 'worried', 'excited', 'working', 'distressed', 'sleep', 'calm', 'grit', 'greet'].includes(body.name)) throw fail(400, 'Unknown expression');
        expression = { name: body.name, time };
      }
      cues.push({ id: `service:${time}:${cueSequence++}`, name: body.action === 'say' ? 'say' : body.name, text: body.action === 'say' ? message.text : undefined, time, source: 'local-command' });
      if (cues.length > 50) cues.shift();
      return state();
    }
    return mutate(candidate => {
      const symbol = body.symbol ?? body.id;
      switch (body.action) {
        case 'buy': case 'sell': case 'short': case 'cover': {
          // Prices are owned by collectors; clients cannot override execution price.
          if (body.options?.price !== undefined || body.price !== undefined) throw fail(400, 'Execution price is server-owned');
          const leverage = body.options?.leverage ?? body.leverage;
          const opts = leverage === undefined ? {} : { leverage };
          engine[body.action](candidate, symbol, body.quantity, opts); break;
        }
        case 'leverage': case 'setLeverage': engine.setLeverage(candidate, body.leverage); break;
        case 'borrow': engine.borrow(candidate, body.amount); break;
        case 'repay': engine.repay(candidate, body.amount); break;
        case 'personality': case 'setPersonality': engine.setPersonality(candidate, body.personality ?? body.values); break;
        case 'automation': case 'setAutomation': engine.setAutomation(candidate, body.automation ?? Object.fromEntries(['enabled', 'autoBorrow', 'strategy', 'everyTicks', 'budgetFraction', 'reserveCash', 'tradeCooldownMs'].filter(key => body[key] !== undefined).map(key => [key, body[key]]))); break;
        case 'add': case 'addInstrument': {
          const item = body.instrument;
          if (!item || typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(item.id)) throw fail(400, 'Invalid instrument id');
          if (RESERVED.has(item.id.toUpperCase()) || RESERVED.has(String(item.symbol || '').toUpperCase())) throw fail(400, 'System instrument is reserved');
          if (typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 80) throw fail(400, 'Name must contain 1–80 characters');
          engine.addInstrument(candidate, { id: item.id, symbol: item.id, name: item.name, category: 'custom', price: 0, spread: 0, tradable: item.tradable !== false }); break;
        }
        default: throw fail(400, 'Unknown action');
      }
    });
  }
  function samples(body, isPeripheral = false) {
    if (!Array.isArray(body.samples) || body.samples.length < 1 || body.samples.length > 64) throw fail(400, 'Expected 1–64 samples');
    const seen = new Set();
    for (const item of body.samples) {
      if (!item || typeof item.id !== 'string' || typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0 || typeof item.time !== 'number' || !Number.isFinite(item.time) || item.time < 0) throw fail(400, 'Invalid sample');
      const instrument = game.instruments.find(i => i.id === item.id.toUpperCase() || i.symbol === item.id.toUpperCase());
      if (!instrument) throw fail(400, 'Unknown sample instrument');
      if (RESERVED.has(instrument.id) && !isPeripheral) throw fail(400, 'System samples are collector-owned');
      if (seen.has(instrument.id)) throw fail(400, 'Duplicate sample instrument');
      if (item.time > now() + 5000 || item.time < now() - 60000 || (instrument.sampleTime !== null && instrument.sampleTime !== undefined && item.time <= instrument.sampleTime)) throw fail(400, 'Sample time is stale, duplicate, or in the future');
      seen.add(instrument.id);
    }
    mutate(candidate => engine.ingestSamples(candidate, body.samples), body.samples);
    for (const item of body.samples) {
      const instrument = game.instruments.find(i => i.id === item.id.toUpperCase() || i.symbol === item.id.toUpperCase());
      if (instrument.metric && Object.hasOwn(telemetry, instrument.metric)) telemetry[instrument.metric] = { status: 'available', value: item.value, time: item.time, source: 'local-push', unit: game.indicators[instrument.metric]?.unit || '' };
    }
    return state();
  }
  function peripherals(body) {
    const readings = body.samples ?? [], missing = body.unavailable ?? [];
    const definitions = PERIPHERALS;
    if (!Array.isArray(readings) || !Array.isArray(missing) || readings.length + missing.length < 1 || readings.length + missing.length > 3) throw fail(400, 'Expected one to three peripheral observations');
    const seen = new Set();
    for (const item of [...readings, ...missing]) {
      if (!item || !Object.hasOwn(definitions, item.id) || seen.has(item.id)) throw fail(400, 'Invalid or duplicate peripheral id');
      seen.add(item.id);
    }
    for (const item of readings) if (item.id === 'MOUSE_BATTERY' && (typeof item.value !== 'number' || item.value > 100)) throw fail(400, 'Battery percent must be 0–100');
    for (const item of missing) if (!['permission-required', 'no-device', 'unsupported', 'read-error'].includes(item.reason)) throw fail(400, 'Invalid peripheral availability reason');
    // Validate and commit the readings before applying metadata; all later operations are nonthrowing.
    if (readings.length) samples({ samples: readings }, true);
    for (const item of readings) {
      const definition = definitions[item.id];
      telemetry[definition.metric] = { ...definition, status: 'available', value: item.value, time: item.time };
    }
    for (const item of missing) {
      const definition = definitions[item.id];
      telemetry[definition.metric] = { ...definition, status: 'unavailable', value: null, time: now(), reason: item.reason };
      const instrument = game.instruments.find(i => i.id === item.id);
      instrument.stale = true;
      if (game.indicators[definition.metric]) game.indicators[definition.metric].status = 'unavailable';
    }
    recordPerformance();
    dirty = true;
    return state();
  }
  function agentEvent(body) {
    const recorded = agents.record(body);
    const observation = agents.sample(recorded.time);
    telemetry = { ...telemetry, ...observation.telemetry };

    // Lifecycle events remain diagnostic only; DSH market uses token deltas.

    dirty = true;
    return state();
  }
  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  function guard(req) {
    const port = server.address()?.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!hosts.has(req.headers.host)) throw fail(403, 'Invalid local Host');
    if (req.headers.origin && ![`http://${req.headers.host}`].includes(req.headers.origin)) throw fail(403, 'Cross-origin request rejected');
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw fail(403, 'Cross-site request rejected');
  }
  async function staticFile(req, res, pathname) {
    let relative;
    try { relative = decodeURIComponent(pathname).replace(/^\//, '') || 'pet.html'; } catch { throw fail(400, 'Invalid URL encoding'); }
    if (relative.includes('\\') || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) throw fail(404, 'Not found');
    if (!STATIC_FILES.has(relative) && !/^(assets|vendor)\/.+/.test(relative)) throw fail(404, 'Not found');
    const candidate = path.resolve(root, relative);
    let real, stat;
    try { real = await fs.realpath(candidate); stat = await fs.stat(real); } catch { throw fail(404, 'Not found'); }
    const allowedRoot = STATIC_FILES.has(relative) ? root : path.join(root, relative.split('/')[0]);
    if (real !== candidate || !real.startsWith(allowedRoot + path.sep) || !stat.isFile() || !TYPES[path.extname(real).toLowerCase()]) throw fail(404, 'Not found');
    const extension = path.extname(real).toLowerCase();
    const media = TYPES[extension].startsWith('video/');
    const ancestors = extension === '.svg' ? "'self'" : "'none'";
    const headers = { 'Content-Type': TYPES[extension], 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'self'; frame-ancestors ${ancestors}; base-uri 'none'` };
    let status = 200, start = 0, end = stat.size - 1;
    if (media) {
      headers['Accept-Ranges'] = 'bytes';
      // RFC 9110 Range only changes GET; HEAD describes a full GET response.
      if (req.method === 'GET' && req.headers.range !== undefined && req.headers['if-range'] === undefined) {
        const match = /^bytes=(\d*)-(\d*)$/i.exec(req.headers.range.trim());
        let valid = Boolean(match && (match[1] || match[2]) && stat.size > 0);
        if (valid) {
          const size = BigInt(stat.size);
          if (!match[1]) {
            const suffix = BigInt(match[2]);
            valid = suffix > 0n;
            start = Number(suffix < size ? size - suffix : 0n);
          } else {
            const first = BigInt(match[1]), last = match[2] ? BigInt(match[2]) : size - 1n;
            valid = first < size && last >= first;
            if (valid) { start = Number(first); end = Number(last < size ? last : size - 1n); }
          }
        }
        if (!valid) {
          res.writeHead(416, { ...headers, 'Content-Length': 0, 'Content-Range': `bytes */${stat.size}` });
          res.end(); return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = end - start + 1;
      }
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || stat.size === 0) { res.end(); return; }
      // Backpressure and a fixed chunk size bound memory even for full video GETs.
      await pipeline(createReadStream(real, { start, end, highWaterMark: 64 * 1024 }), res);
      return;
    }
    const data = req.method === 'HEAD' ? null : await fs.readFile(real);
    res.writeHead(200, headers);
    res.end(data);
  }
  const server = http.createServer(async (req, res) => {
    try {
      guard(req);
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname === '/api/widget-state' && req.method === 'GET') return send(res, 200, await serial(() => ({
        sampledAt: telemetry.sampledAt, equity: engine.equity(game), cash: game.cash,
        equityStale: heldQuotesStale(game, now()),
        strategy: game.automation.strategy, automationEnabled: game.automation.enabled,
        cpu: telemetry.cpu.status === 'available' ? telemetry.cpu.value : null,
        memory: telemetry.memory.status === 'available' ? telemetry.memory.value : null,
        petMessage: message?.text || null
      })));
      if (pathname === '/api/state' && req.method === 'GET') {
        const params = new URL(req.url, 'http://127.0.0.1').searchParams;
        if (params.getAll('timeframe').length > 1) throw fail(400, 'Specify one timeframe');
        const selected = timeframe(params.get('timeframe') ?? 'minute');
        return send(res, 200, await serial(() => state(selected)));
      }
      if (['/api/action', '/api/samples', '/api/agent-events', '/api/peripherals', '/api/dsh-tokens'].includes(pathname) && req.method === 'POST') {
        if (stopping) throw fail(503, 'Server is stopping');
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw fail(415, 'Use application/json');
        const body = await readBody(req);
        const result = await serial(() => pathname === '/api/dsh-tokens' ? (tokens.record(body), state()) : pathname === '/api/action' ? action(body) : pathname === '/api/agent-events' ? agentEvent(body) : pathname === '/api/peripherals' ? peripherals(body) : samples(body));
        return send(res, 200, result);
      }
      if (pathname.startsWith('/api/')) throw fail(404, 'Unknown API route');
      if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Method not allowed');
      await staticFile(req, res, pathname);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.status || (error instanceof TypeError || error instanceof RangeError ? 400 : 400), { error: error.status ? error.message : 'Action or request rejected', detail: error.status ? undefined : String(error.message).slice(0, 160) });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));

  async function start(port = 8766) {
    if (typeof engine.ingestSamples !== 'function') throw new Error('Engine live sampling API is unavailable');
    game = engine.createGame({ mode: 'live', startTime: now(), credit: { unlimited: true }, maxLeverage: 20, leverage: 10, personality: { riskTolerance: 0.95, discipline: 0.25, patience: 0.2, impulsiveness: 0.9, curiosity: 0.8 }, historyLimit: 120, eventLimit: 100, automation: { enabled: true, autoBorrow: true, strategy: 'momentum', everyTicks: 10, budgetFraction: 1, reserveCash: 0, tradeCooldownMs: 60000 }, instruments: [
      { id: 'CPU', name: 'CPU 使用率', metric: 'cpu', price: 0, spread: 0 },
      { id: 'MEM', name: '内存使用率', metric: 'memory', price: 0, spread: 0 },
      { id: 'LOAD', name: '一分钟负载', price: 0, spread: 0 },
      { id: 'MOUSE_DISTANCE', name: '鼠标移动距离 · 点/秒', price: 0, spread: 0 },
      { id: 'MOUSE_CLICKS', name: '鼠标点击 · 次/秒', price: 0, spread: 0 },
      { id: 'KEYBOARD', name: '键盘按键 · 次/秒', price: 0, spread: 0 },
      { id: 'THREADS', name: '系统可枚举线程总数', price: 0, spread: 0 },
      { id: 'CONNECTIONS', name: 'TCP 连接对象 · 含监听', price: 0, spread: 0 },
      { id: 'DSH', name: 'DSH tokens/秒', category: 'token-rate-v1', price: 0, spread: 0 }
    ] });
    let savedCandles;
    performance = createPerformanceHistory({ baseline: game.initialCash, now });
    if (statePath) {
      try {
        const stat = await fs.stat(statePath);
        if (stat.size > MAX_STATE) throw new Error('Saved snapshot too large');
        const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
        if (saved.version !== 1) throw new Error('Unsupported saved schema');
        const defaults = game.instruments;
        const restored = engine.restoreGame(validateSnapshot(saved.game));
        const retired = restored.instruments.filter(i => ['CODEX', 'CLAUDE', 'MOUSE_BATTERY', 'MOUSE_FREQUENCY'].includes(i.id) || (i.id === 'DSH' && i.category !== 'token-rate-v1'));
        for (const instrument of retired) {
          const position = restored.positions[instrument.id];
          const settlement = !position ? 0 : position.side === 'short'
            ? Math.max(0, position.margin + (position.avgPrice - instrument.price) * position.quantity - (position.accruedInterest || 0))
            : instrument.price * position.quantity - position.debt;
          restored.cash += settlement;
          if (restored.cash < 0) { restored.loanBalance += -restored.cash; restored.cash = 0; }
          delete restored.positions[instrument.id];
          restored.events.push({ id: `migration:${restored.eventSequence++}`, type: 'instrument-migrated', tick: restored.tickCount, time: now(), payload: { instrumentId: instrument.id, price: instrument.price, quantity: position?.quantity || 0, debt: position?.debt || 0, settlement } });
        }
        restored.instruments = restored.instruments.filter(i => !retired.includes(i));
        restored.events = restored.events.slice(-restored.eventLimit);
        for (const instrument of defaults) {
          if (!restored.instruments.some(item => item.id === instrument.id)) {
            if (restored.instruments.length >= 64) throw new Error('Cannot migrate full instrument list');
            restored.instruments.push(instrument);
          }
        }
        restored.risk = { ...restored.risk, maxLeverage: 20 };
        restored.credit = { unlimited: true, minPerLoan: 100000, maxPerLoan: 3000000 };
        restored.automation.autoBorrow ??= true;
        restored.automation.lastBorrowTime ??= null;
        restored.automation.tradeCooldownMs ??= 60000;
        restored.automation.lastTradeTime ??= null;
        restored.bankruptcyLedger ??= { count: 0, totalForgivenDebt: 0, totalCrystallizedLoss: 0, records: [] };
        game = restored;
        game.lastLiveTickTime = now();
        game.time = Math.max(game.time, game.lastLiveTickTime);
        game.automation.lastTime = game.lastLiveTickTime;
        // A prior session's quote remains history, not a currently usable observation.
        for (const instrument of game.instruments) instrument.stale = true;
        performance = createPerformanceHistory({ baseline: game.initialCash, restored: saved.performance, now });
        savedCandles = saved.candleHistory;
      } catch (error) { if (error.code !== 'ENOENT') onError(new Error('Saved state rejected; starting a fresh live session')); }
    }
    charts = createCandleHistory({ restored: savedCandles, now, instrumentIds: game.instruments.map(item => item.id), episode: performance.snapshot().episode });
    charts.bootstrap(game.instruments, performance.snapshot());
    charts.recordEvents(game.events, game.eventSequence);
    enforceBudget();
    cpu(); // Establish a delta baseline, not a lifetime average or synthetic first sample.
    lastSaveAt = now();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    timer = setInterval(() => {
      if (scheduledSample || stopping) return;
      scheduledSample = true;
      serial(sample).catch(onError).finally(() => { scheduledSample = false; });
    }, 1000);
    return server.address();
  }
  async function stop() {
    if (stopping) return;
    stopping = true; clearInterval(timer);
    const closed = new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await serial(() => persist(true)).catch(onError);
    await closed;
  }
  return { server, start, stop, sample: () => serial(sample) };
}

module.exports = { createService, createCpuSampler };
if (require.main === module) {
  const service = createService();
  service.start().then(address => console.log(`韭留美实时桌宠 http://127.0.0.1:${address.port}/pet.html`)).catch(error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { service.stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
}
