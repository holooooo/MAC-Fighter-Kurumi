'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemTelemetry, createTokenTelemetry, parseThreads, parseCount } = require('../system-telemetry.cjs');
const threadTable = 'USER PID TT %CPU STAT PRI STIME UTIME COMMAND\nu 1 ?? 0 S 1 0 0 proc\n 1 0.0 S 31R 0:00.00 0:00.00\n';
test('kernel counts parse finite whole counts and reject empty output', () => {
  assert.equal(parseCount('46080\n'), 46080);
  assert.equal(parseCount('0'), 0);
  for (const bad of ['', 'permission denied', '-1', '1.5']) assert.throws(() => parseCount(bad));
});
test('system commands are fixed bounded throttled and failures unavailable', async () => {
  let calls = 0, broken = false;
  const sampler = createSystemTelemetry({ platform: 'darwin', execFile(file, args, options, done) {
    calls++; assert.equal(options.shell, false); assert.equal(options.timeout, 1500); assert.equal(options.maxBuffer, file === '/usr/sbin/sysctl' ? 8192 : 1048576);
    assert.ok(['/bin/ps', '/usr/sbin/sysctl'].includes(file));
    done(broken ? new Error('denied') : null, file === '/bin/ps' ? threadTable : '7\n');
  } });
  const first = await sampler.sample(0); assert.equal(first.samples.length, 2); assert.equal(calls, 2);
  assert.equal((await sampler.sample(4999)).samples.length, 0); assert.equal(calls, 2);
  broken = true; const failed = await sampler.sample(5000); assert.equal(calls, 4);
  assert.equal(failed.samples.length, 0); assert.equal(failed.telemetry.threads.status, 'unavailable');
});
test('token deltas deduplicate conflicts reject and silence expires', () => {
  let time = 100000;
  const tokens = createTokenTelemetry({ now: () => time });
  assert.equal(tokens.sample().telemetry.dshTokens.status, 'unavailable');
  tokens.record({ eventId: 'a', tokens: 100 });
  assert.equal(tokens.record({ eventId: 'a', tokens: 100 }).duplicate, true);
  assert.throws(() => tokens.record({ eventId: 'a', tokens: 101 }));
  time += 1000;
  assert.equal(tokens.sample().telemetry.dshTokens.value, 100);
  time += 1000; assert.equal(tokens.sample().telemetry.dshTokens.value, 0);
  time += 15000; assert.equal(tokens.sample().telemetry.dshTokens.status, 'stale');
  assert.equal(tokens.sample().samples.length, 0);
  for (const body of [{ eventId: 'a b', tokens: 1 }, { eventId: 'x', tokens: -1 }, { eventId: 'x', tokens: 1.2 }, { eventId: 'x', tokens: 2, time: time - 61000 }]) assert.throws(() => tokens.record(body));
});
