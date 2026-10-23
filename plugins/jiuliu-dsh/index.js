import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const name = 'jiuliu-dsh-token-bridge';

const LIMITS = Object.freeze({ sessions: 128, attempts: 32, settlements: 256, queue: 128, stateMs: 300000, eventMs: 55000 });
const outputTokens = usage => Number.isSafeInteger(usage?.outputTokens) && usage.outputTokens >= 0 ? usage.outputTokens : undefined;
const position = data => Number.isSafeInteger(data?.turn) && Number.isSafeInteger(data?.step) ? `${data.turn}:${data.step}` : undefined;
function boundedSet(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

/** Only numeric provider usage is inspected. Text and reasoning are never tokenized. */
function durableUsage(data) {
  const direct = outputTokens(data?.usage);
  if (direct !== undefined) return direct;
  if (!Array.isArray(data?.stream)) return undefined;
  for (let i = data.stream.length - 1; i >= 0; i--) {
    const record = data.stream[i];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return outputTokens(record.chunk.usage);
  }
  return undefined;
}

/**
 * A nonblocking provider-usage observer for DSH 0.2.1-rc.2.
 * The second argument is a clock/transport seam for bounded failure tests.
 */
export function createTokenBridge(config = {}, runtime = {}) {
  const port = config.port ?? 8766;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Jiuliu port must be an integer from 1 to 65535');
  const now = runtime.now ?? Date.now;
  const request = runtime.request ?? http.request;
  const interval = runtime.setInterval ?? setInterval;
  const cancelInterval = runtime.clearInterval ?? clearInterval;
  const deadline = runtime.setTimeout ?? setTimeout;
  const cancelDeadline = runtime.clearTimeout ?? clearTimeout;
  const sessions = new Map();
  const agentLifetimes = new WeakMap();
  const queue = [];
  let disposed = false, scheduled = false, activeRequest, abortRequest, pendingTokens = 0, lastQueued = -Infinity, dropped = 0;

  function sessionState(session) {
    if (!session || typeof session.id !== 'string' || session.id.length > 1024) return undefined;
    let state = sessions.get(session.id);
    if (!state) {
      state = { attempts: new Map(), slots: new Map(), settlements: new Map(), active: undefined, agent: undefined, touched: now() };
      boundedSet(sessions, session.id, state, LIMITS.sessions);
    }
    state.touched = now();
    return state;
  }
  function schedulePump() {
    if (disposed || scheduled || activeRequest) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function enqueue(tokens) {
    if (disposed) return;
    const time = now();
    if (queue.length >= LIMITS.queue) {
      const heartbeat = queue.findIndex(item => item.body.tokens === 0);
      queue.splice(heartbeat < 0 ? 0 : heartbeat, 1);
      dropped++;
    }
    queue.push({ body: { eventId: randomUUID(), tokens, time }, tries: 0 });
    lastQueued = time;
    schedulePump();
  }
  function pump() {
    if (disposed || activeRequest || !queue.length) return;
    const item = queue.shift();
    if (now() - item.body.time > LIMITS.eventMs || item.body.time > now() + 5000) {
      dropped++;
      schedulePump();
      return;
    }
    const body = JSON.stringify(item.body);
    let req, timeout, completed = false;
    const complete = retryable => {
      if (completed) return;
      completed = true;
      if (timeout) cancelDeadline(timeout);
      activeRequest = undefined;
      abortRequest = undefined;
      // Reuse the event id: a timed-out response may already have been accepted.
      if (!disposed && retryable && item.tries++ < 1 && queue.length < LIMITS.queue) queue.unshift(item);
      schedulePump();
    };
    // Reserve the single transport slot even for synchronous request stubs/errors.
    activeRequest = true;
    try {
      req = request({ hostname: '127.0.0.1', port, path: '/api/dsh-tokens', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        const status = res.statusCode ?? 0;
        // Native HTTP has no redirect following and never consults HTTP(S)_PROXY.
        res.on('error', () => complete(true));
        res.on('end', () => complete(status >= 500 || status === 408 || status === 429));
        res.resume();
      });
      activeRequest = req;
      abortRequest = () => { complete(false); req.destroy(); };
      req.on('error', () => complete(true));
      timeout = deadline(() => { complete(true); req.destroy(); }, 1000);
      timeout?.unref?.();
      req.end(body);
    } catch {
      complete(true);
      req?.destroy();
    }
  }
  function observe(attempt, cumulative) {
    if (cumulative === undefined) return;
    attempt.known = true;
    // Ignore repeats, regressions and final snapshots already seen live.
    if (cumulative <= attempt.total) return;
    const delta = cumulative - attempt.total;
    attempt.total = cumulative;
    if (Number.isSafeInteger(pendingTokens + delta)) pendingTokens += delta;
    else dropped++; // Never send an imprecise integer.
  }

  function stream(payload) {
    const { agent, frame } = payload ?? {};
    if (disposed || !frame || typeof frame.attemptId !== 'string' || frame.attemptId.length > 2048) return;
    const state = sessionState(agent?.session);
    if (!state) return;
    let lifetime = agentLifetimes.get(agent);
    if (!lifetime) { lifetime = Symbol(); agentLifetimes.set(agent, lifetime); }
    if (state.agent !== lifetime) {
      state.agent = lifetime;
      state.attempts.clear();
      state.active = undefined;
    }
    let attempt = state.attempts.get(frame.attemptId);
    if (frame.type === 'start') {
      if (!attempt) {
        attempt = { total: 0, known: false, position: position(frame), ended: false };
        boundedSet(state.attempts, frame.attemptId, attempt, LIMITS.attempts);
      }
      if (attempt.ended) return;
      state.active = attempt;
      if (attempt.position !== undefined) boundedSet(state.slots, attempt.position, attempt, LIMITS.attempts);
      return;
    }
    if (frame.type === 'end') {
      if (attempt) attempt.ended = true;
      if (state.active === attempt) state.active = undefined;
      return;
    }
    if (frame.type !== 'chunk') return;
    if (!attempt) {
      // Mounting mid-attempt can miss start. The first usage is still an actual
      // provider total; the durable settlement will attach its position below.
      attempt = { total: 0, known: false, position: undefined, ended: false };
      boundedSet(state.attempts, frame.attemptId, attempt, LIMITS.attempts);
      state.active = attempt;
    }
    if (attempt.ended) return;
    if (frame.chunk?.type === 'usage') observe(attempt, outputTokens(frame.chunk.usage));
  }

  function durable(session, event) {
    if (disposed || !event) return;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt' && event.type !== 'llm/retry-started') return;
    const state = sessionState(session);
    if (!state) return;
    const key = position(event.data);
    if (key === undefined) return;
    if (event.type === 'llm/retry-started') { state.slots.delete(key); return; }
    // DSH commits are live-only; seeded/restored history never emits session/event.
    if (!Number.isSafeInteger(event.seq) || state.settlements.has(event.seq)) return;
    boundedSet(state.settlements, event.seq, true, LIMITS.settlements);
    let attempt = state.active;
    if (!attempt || (attempt.position !== undefined && attempt.position !== key)) attempt = state.slots.get(key);
    if (!attempt) attempt = { total: 0, known: false, position: key, ended: false };
    attempt.position = key;
    boundedSet(state.slots, key, attempt, LIMITS.attempts);
    observe(attempt, durableUsage(event.data));
    attempt.ended = true;
    if (state.active === attempt) state.active = undefined;
  }

  function tick() {
    if (disposed) return;
    const time = now();
    for (const [id, state] of sessions) if (!state.active && time - state.touched > LIMITS.stateMs) sessions.delete(id);
    if (pendingTokens > 0) {
      const tokens = pendingTokens;
      pendingTokens = 0;
      enqueue(tokens);
    } else if (time - lastQueued >= 5000 && ![...sessions.values()].some(state => state.active && !state.active.known)) {
      // Explicit idle/connected heartbeat. Unknown active usage never becomes zero.
      enqueue(0);
    }
  }
  const timer = interval(tick, 1000);
  timer?.unref?.();
  enqueue(0);
  return {
    stream, durable, tick,
    status: () => ({ sessions: sessions.size, queued: queue.length, pendingTokens, dropped, disposed }),
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelInterval(timer);
      queue.length = 0;
      pendingTokens = 0;
      sessions.clear();
      abortRequest?.();
    }
  };
}

/** Cordis owns hooks and timer cleanup through effects, including HMR unload. */
export function apply(ctx, config = {}) {
  const bridge = createTokenBridge(config);
  const listeners = [];
  ctx.effect(() => () => {
    for (const off of listeners) off();
    bridge.dispose();
  });
  listeners.push(ctx.on('agent/assistant-stream', bridge.stream, { global: true }));
  listeners.push(ctx.on('session/event', bridge.durable, { global: true }));
}
