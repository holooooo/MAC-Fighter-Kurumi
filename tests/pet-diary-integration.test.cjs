'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const os = require('node:os');
const Engine = require('../pet-engine.js');
const { createCandleHistory } = require('../candle-history.cjs');
const { createPerformanceHistory } = require('../performance-history.cjs');
const { createService } = require('../server.cjs');
const diaryModule = require('../pet-diary.js');

const root = path.resolve(__dirname, '..');

// GET only, to the ephemeral server this test creates. Never attach to a live port.
function get(port, route) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: route, agent: false }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
  });
}

test('isolated service serves diary assets and preserves the read-only diary across restart', async t => {
  const prefix = path.join(os.tmpdir(), 'kurumi-diary-integration-');
  const directory = await fs.mkdtemp(prefix);
  const services = [];
  t.after(async () => {
    for (const service of services) await service.stop();
    assert(directory.startsWith(prefix) && path.dirname(directory) === path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const statePath = path.join(directory, 'state.json');
  let time = 1700000000000;
  // Synthetic saved account only: no orders, resets, existing files or host sampling.
  const game = Engine.createGame({ mode: 'live', startTime: time, historyLimit: 120, eventLimit: 100, automation: { enabled: false }, instruments: [
    { id: 'CPU', name: 'Test CPU', price: 0 },
    { id: 'MEM', name: 'Test memory', price: 0 },
    { id: 'LOAD', name: 'Test load', price: 0 }
  ] });
  const history = createCandleHistory({ now: () => time, instrumentIds: ['CPU', 'MEM', 'LOAD'] });
  history.recordTrades([
    { id: 'fixture:1', time: time - 2000, instrumentId: 'CPU', action: 'sell', side: 'long', price: 11, quantity: 2, realizedPnl: 1.5, grossPnl: 2, interest: 0.5, pnlBasis: 'net-position-interest' },
    { id: 'fixture:2', time: time - 1000, instrumentId: 'MEM', action: 'cover', side: 'short', price: 9, quantity: 1, realizedPnl: 1 }
  ]);
  await fs.writeFile(statePath, JSON.stringify({ version: 1, savedAt: time, game: game.snapshot(), performance: createPerformanceHistory({ baseline: game.initialCash, now: () => time }).snapshot(), candleHistory: history.snapshot() }));
  const errors = [];
  async function start() {
    const service = createService({
      root, statePath, now: () => time, onError: error => errors.push(error.message),
      os: { platform: () => 'test', cpus: () => [], totalmem: () => NaN, freemem: () => NaN, loadavg: () => [] },
      systemTelemetry: { sample: async () => ({ samples: [], telemetry: {} }) }
    });
    services.push(service);
    const address = await service.start(0);
    return { service, port: address.port };
  }
  const first = await start();
  const before = JSON.parse((await get(first.port, '/api/state')).text);
  assert.deepEqual(before.tradeDiary, history.diary());
  const cash = before.game.cash;
  for (const [route, contentType] of [['/pet-diary.js', 'text/javascript'], ['/pet-diary.css', 'text/css']]) {
    const response = await get(first.port, route);
    assert.equal(response.status, 200, `${route} must be allowed by the service`);
    assert(response.headers['content-type'].startsWith(contentType));
    assert.equal(response.text, await fs.readFile(path.join(root, route.slice(1)), 'utf8'));
  }
  const page = await get(first.port, '/pet.html');
  assert.equal(page.status, 200);
  assert.match(page.text, /href="pet-diary\.css"/);
  time += 1000;
  await first.service.sample(); // Controlled no-data sample makes this fixture dirty for forced persistence.
  await first.service.stop();
  const second = await start();
  const restored = JSON.parse((await get(second.port, '/api/state')).text);
  assert.deepEqual(restored.tradeDiary, before.tradeDiary);
  assert.equal(restored.game.cash, cash, 'viewing and restarting must not trade');
  assert.equal(new Set(restored.tradeDiary.entries.map(entry => entry.id)).size, 2);
  const entries = diaryModule.sortedEntries(restored.tradeDiary);
  assert.equal(diaryModule.outcome(entries[0]).label, '旧口径收益 +1');
  assert.equal(diaryModule.outcome(entries[1]).label, '净收益 +1.5');
  assert.deepEqual(errors, [], 'fixture state must restore without fallback');
});

test('pet page loads the read-only diary before its UI consumer', async () => {
  const html = await fs.readFile(path.join(root, 'pet.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)><\/script>/g)].map(match => ({
    src: /\bsrc="([^"]+)"/.exec(match[1])?.[1],
    defer: /\bdefer\b/.test(match[1])
  }));
  const diaryIndex = scripts.findIndex(script => script.src === 'pet-diary.js');
  const uiIndex = scripts.findIndex(script => script.src === 'pet-ui.js');
  assert(diaryIndex >= 0, 'the page must include the diary module');
  assert(uiIndex > diaryIndex, 'deferred diary must execute before pet-ui');
  assert(scripts[diaryIndex].defer && scripts[uiIndex].defer);
  assert.equal(scripts.filter(script => script.src === 'pet-diary.js').length, 1);
  assert.match(html, /<link\b[^>]*rel="stylesheet"[^>]*href="pet-diary\.css"[^>]*>/);
  assert.match(html, /id="diary-notice"[^>]*aria-live="polite"/);
  assert(html.indexOf('id="diary-notice"') < html.indexOf('id="activity-log"'));

  const source = await fs.readFile(path.join(root, scripts[diaryIndex].src), 'utf8');
  // Evaluate the actual browser UMD branch, not only CommonJS require().
  // It must load without DOM access, network, storage or account capabilities.
  const browser = {};
  vm.runInNewContext(source, browser, { filename: 'pet-diary.js', timeout: 1000 });
  assert.equal(typeof browser.PetDiary?.render, 'function');
  assert.equal(typeof browser.PetDiary?.createRenderer, 'function');
  assert.doesNotThrow(() => browser.PetDiary.render(undefined));
  const ui = await fs.readFile(path.join(root, 'pet-ui.js'), 'utf8');
  assert.match(ui, /window\.PetDiary\?\.render\(state\.tradeDiary\)/);
});
