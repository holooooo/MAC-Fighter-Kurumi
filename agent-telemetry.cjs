'use strict';

// Explicit command lifecycle only. No process inspection or log inference.
const TTL_MS = 15000;
const HEARTBEAT_MS = 5000;
const SESSION_CAP = 128;
const AGENTS = Object.freeze({ codex: ['CODEX', 'codexActivity'], claude: ['CLAUDE', 'claudeActivity'], dsh: ['DSH', 'dshActivity'] });
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function createAgentTelemetry({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const sessions = new Map();
  const observations = Object.fromEntries(Object.keys(AGENTS).map(agent => [agent, { seen: false, unknown: false }]));
  let lastTime = -Infinity;

  function timestamp(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('time must be finite nonnegative milliseconds');
    if (value < lastTime) throw new RangeError('time must not move backwards');
    return value;
  }
  function expired(session, time) { return time - session.time >= TTL_MS; }
  function prune(time) {
    for (const [key, session] of sessions) {
      if (!expired(session, time)) continue;
      if (session.active) observations[session.agent].unknown = true;
      sessions.delete(key);
    }
  }

  /** record({agent, sessionId, event}) -> detached acknowledgement.
   * Heartbeat/stop require a known, fresh start. Start is idempotent and may
   * restart a stopped session. Session IDs are scoped to their agent.
   */
  function record(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('event must be an object');
    const { agent, sessionId, event } = input;
    if (typeof agent !== 'string' || !Object.hasOwn(AGENTS, agent)) throw new TypeError('unknown agent');
    if (typeof sessionId !== 'string' || !ID.test(sessionId)) throw new TypeError('invalid sessionId');
    if (!['start', 'heartbeat', 'stop'].includes(event)) throw new TypeError('unknown lifecycle event');
    const time = timestamp(now());
    const key = `${agent}/${sessionId}`;
    const prior = sessions.get(key);
    if (event !== 'start' && (!prior || expired(prior, time))) throw new Error('session needs a fresh start');
    if (event === 'heartbeat' && !prior.active) throw new Error('stopped session needs a new start');
    let freshCount = 0;
    for (const session of sessions.values()) if (!expired(session, time)) freshCount++;
    if ((!prior || expired(prior, time)) && freshCount >= SESSION_CAP) throw new RangeError('session capacity exceeded');
    // All rejection paths precede mutation, including cleanup and clock advance.
    prune(time);
    sessions.set(key, { agent, sessionId, active: event !== 'stop', time });
    observations[agent].seen = true;
    lastTime = time;
    return { agent, sessionId, event, time };
  }

  /** sample(time=now()) -> {samples,telemetry}.
   * A lost active session leaves an unknown marker after bounded reclamation.
   * Fresh activity overrides unknown (at least one session is definitely active),
   * but another session stopping cannot prove that a lost session stopped.
   */
  function sample(value) {
    const time = timestamp(value === undefined ? now() : value);
    prune(time);
    lastTime = time;
    const samples = [], telemetry = {};
    for (const [agent, [id, metric]] of Object.entries(AGENTS)) {
      let active = false, stopped = false, activeSessions = 0;
      for (const session of sessions.values()) {
        if (session.agent !== agent) continue;
        if (session.active) { active = true; activeSessions++; }
        else stopped = true;
      }
      const observed = observations[agent];
      const available = active || (stopped && !observed.unknown);
      const status = available ? 'available' : observed.seen ? 'stale' : 'unavailable';
      const result = available ? (active ? 1 : 0) : null;
      telemetry[metric] = { status, value: result, activeSessions, time, source: 'agent-command-lifecycle', unit: 'active' };
      if (available) samples.push({ id, value: result, time });
    }
    return { samples, telemetry };
  }
  return Object.freeze({ record, sample });
}

module.exports = { createAgentTelemetry, TTL_MS, HEARTBEAT_MS, SESSION_CAP };
