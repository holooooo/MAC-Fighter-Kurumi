'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentTelemetry, TTL_MS, HEARTBEAT_MS, SESSION_CAP } = require('../agent-telemetry.cjs');
function fixture() {
  let time = 0;
  const telemetry = createAgentTelemetry({ now: () => time });
  return { telemetry, at(value) { time = value; }, record(agent, sessionId, event) { return telemetry.record({ agent, sessionId, event }); } };
}

test('startup is unavailable, explicit start and stop create real one and zero observations', () => {
  const f = fixture();
  assert.deepEqual(f.telemetry.sample().samples, []);
  assert.equal(f.telemetry.sample().telemetry.codexActivity.status, 'unavailable');
  f.record('codex', 'cmd-1', 'start');
  const first = f.telemetry.sample();
  assert.deepEqual(first.samples, [{ id: 'CODEX', value: 1, time: 0 }]);
  assert.equal(first.telemetry.codexActivity.source, 'agent-command-lifecycle');
  assert.equal(first.telemetry.codexActivity.unit, 'active');
  assert.deepEqual(first, f.telemetry.sample()); // Same millisecond calls are valid.
  f.at(1000); f.record('codex', 'cmd-1', 'stop');
  assert.deepEqual(f.telemetry.sample().samples, [{ id: 'CODEX', value: 0, time: 1000 }]);
  f.at(1000 + TTL_MS);
  assert.equal(f.telemetry.sample().telemetry.codexActivity.status, 'stale');
  assert.deepEqual(f.telemetry.sample().samples, []);
});

test('multiple sessions merge correctly and agents remain separate', () => {
  const f = fixture();
  f.record('codex', 'one', 'start'); f.record('codex', 'two', 'start');
  f.record('claude', 'one', 'start'); f.record('dsh', 'one', 'start');
  assert.equal(f.telemetry.sample().telemetry.codexActivity.activeSessions, 2);
  f.record('codex', 'one', 'stop');
  assert.equal(f.telemetry.sample().telemetry.codexActivity.value, 1);
  assert.equal(f.telemetry.sample().telemetry.codexActivity.activeSessions, 1);
  f.record('codex', 'two', 'stop');
  assert.equal(f.telemetry.sample().telemetry.codexActivity.value, 0);
  assert.equal(f.telemetry.sample().telemetry.claudeActivity.value, 1);
});

test('heartbeats renew TTL but expired active sessions never manufacture zero', () => {
  const f = fixture();
  f.record('codex', 'lost', 'start');
  f.at(HEARTBEAT_MS); f.record('codex', 'lost', 'heartbeat');
  f.at(TTL_MS); assert.equal(f.telemetry.sample().telemetry.codexActivity.value, 1);
  f.at(TTL_MS + HEARTBEAT_MS);
  const stale = f.telemetry.sample();
  assert.equal(stale.telemetry.codexActivity.status, 'stale');
  assert.equal(stale.telemetry.codexActivity.value, null);
  assert.equal(stale.telemetry.codexActivity.activeSessions, 0);
  assert.deepEqual(stale.samples, []);
  f.record('codex', 'new', 'start');
  assert.equal(f.telemetry.sample().telemetry.codexActivity.value, 1);
  f.record('codex', 'new', 'stop');
  assert.equal(f.telemetry.sample().telemetry.codexActivity.status, 'stale');
});

test('invalid lifecycle records are rejected atomically', () => {
  const f = fixture();
  f.record('codex', 'ok', 'start');
  const before = f.telemetry.sample();
  for (const input of [null, [], {}, { agent: 'other', sessionId: 'a', event: 'start' },
    { agent: 'codex', sessionId: '../bad', event: 'start' },
    { agent: 'codex', sessionId: 'a'.repeat(65), event: 'start' },
    { agent: 'codex', sessionId: 'a', event: 'no' },
    { agent: 'codex', sessionId: 'missing', event: 'heartbeat' },
    { agent: 'codex', sessionId: 'missing', event: 'stop' }]) {
    assert.throws(() => f.telemetry.record(input));
    assert.deepEqual(f.telemetry.sample(), before);
  }
  f.at(NaN); assert.throws(() => f.record('codex', 'ok', 'stop'));
  f.at(0); assert.deepEqual(f.telemetry.sample(), before);
  f.record('codex', 'ok', 'stop');
  assert.throws(() => f.record('codex', 'ok', 'heartbeat'));
  f.record('codex', 'ok', 'start');
  assert.equal(f.telemetry.sample().telemetry.codexActivity.value, 1);
});

test('bounded capacity rejects new live sessions and reclaims expired entries', () => {
  const f = fixture();
  for (let n = 0; n < SESSION_CAP; n++) f.record('codex', `s${n}`, 'start');
  const before = f.telemetry.sample();
  assert.throws(() => f.record('dsh', 'overflow', 'start'), /capacity/);
  assert.deepEqual(f.telemetry.sample(), before);
  f.at(TTL_MS);
  f.record('dsh', 'reclaimed', 'start');
  assert.equal(f.telemetry.sample().telemetry.codexActivity.status, 'stale');
  assert.equal(f.telemetry.sample().telemetry.dshActivity.activeSessions, 1);
  for (let batch = 1; batch < 20; batch++) {
    f.at((batch + 1) * TTL_MS);
    for (let n = 0; n < SESSION_CAP; n++) f.record('claude', `batch${batch}-${n}`, 'start');
    assert.equal(f.telemetry.sample().telemetry.claudeActivity.activeSessions, SESSION_CAP);
  }
});

test('invalid sample times do not mutate observations', () => {
  const f = fixture(); f.at(100); f.record('dsh', 'work', 'start');
  const before = f.telemetry.sample();
  for (const time of [-1, 99, NaN, Infinity, '100', null]) assert.throws(() => f.telemetry.sample(time));
  assert.deepEqual(f.telemetry.sample(), before);
});
