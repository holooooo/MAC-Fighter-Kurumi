#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { constants } = require('node:os');

const HELP = `用法：node bin/kurumi-agent.cjs --agent codex|claude|dsh -- command [arg...]

通过 spawn（无 shell）运行真实命令，直接继承标准输入、输出和错误。
仅上报 start / heartbeat / stop，不采集命令参数或输入输出文本。
每 5 秒上报心跳；服务不可达不影响命令执行。
KURUMI_URL 可指定本地 HTTP 服务，默认 http://127.0.0.1:8766。
示例：node bin/kurumi-agent.cjs --agent codex -- codex
`;

function localEndpoint(value = 'http://127.0.0.1:8766') {
  let url;
  try { url = new URL(value); } catch { throw new Error('KURUMI_URL 必须是本地 HTTP 地址'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('KURUMI_URL 仅允许 http://127.0.0.1[:port] 或 http://localhost[:port]，不允许凭证、路径或查询');
  }
  // Pin localhost to IPv4 loopback without relying on DNS configuration.
  url.hostname = '127.0.0.1';
  url.pathname = '/api/agent-events';
  return url;
}

function parseArguments(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  if (argv.length < 4 || argv[0] !== '--agent' || !['codex', 'claude', 'dsh'].includes(argv[1]) || argv[2] !== '--' || !argv[3]) {
    throw new Error('参数错误。使用 --agent codex|claude|dsh -- command [arg...]；--help 查看说明。');
  }
  return { agent: argv[1], command: argv[3], args: argv.slice(4) };
}

function postEvent(endpoint, event, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let deadline;
    const finish = (success = false) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); resolve(success === true);
    };
    const body = JSON.stringify(event);
    const req = http.request(endpoint, {
      method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      // Responses are never parsed, logged, or followed as redirects.
      res.on('error', finish);
      res.resume();
      res.on('end', () => finish(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', finish);
    deadline = setTimeout(() => { req.destroy(); finish(); }, timeoutMs);
    req.end(body);
  });
}

async function runBridge({ agent, command, args = [], endpoint = localEndpoint(), heartbeatMs = 5000, timeoutMs = 1000, stdio = 'inherit', signalSource = process, onSpawnError = () => {} }) {
  if (!['codex', 'claude', 'dsh'].includes(agent)) throw new Error('Unsupported agent');
  // Validate injected endpoints too, including test callers.
  const url = endpoint instanceof URL ? new URL(endpoint) : new URL(endpoint);
  if (url.pathname === '/api/agent-events') url.pathname = '/';
  const target = localEndpoint(url.href);
  const sessionId = randomUUID();
  let pending = null, timer = null, ended = false, started = false, registered = false;
  const send = event => {
    if (pending) return pending;
    pending = postEvent(target, { agent, sessionId, event }, timeoutMs)
      .then(success => { registered = event !== 'stop' && success; return success; })
      .finally(() => { pending = null; });
    return pending;
  };
  const child = spawn(command, args, { shell: false, stdio });
  const forward = signal => { if (!ended && child.pid) { try { child.kill(signal); } catch {} } };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  signalSource.on('SIGINT', interrupt);
  signalSource.on('SIGTERM', terminate);
  const result = new Promise(resolve => {
    child.once('error', error => {
      ended = true;
      onSpawnError(error.code === 'ENOENT' ? '找不到可执行命令。' : '无法启动命令。');
      resolve(error.code === 'ENOENT' ? 127 : 126);
    });
    child.once('exit', (code, signal) => {
      ended = true;
      resolve(code === null ? 128 + (constants.signals[signal] || 1) : code);
    });
  });
  // Only the spawn event proves a command really started. Network I/O never gates it.
  child.once('spawn', () => {
    started = true;
    send('start');
    timer = setInterval(() => {
      if (!ended && !pending) send(registered ? 'heartbeat' : 'start');
    }, heartbeatMs);
  });
  try {
    const exitCode = await result;
    clearInterval(timer);
    // Drain only the one bounded in-flight request, then send one bounded stop.
    if (pending) await pending;
    if (started) await send('stop');
    return exitCode;
  } finally {
    clearInterval(timer);
    signalSource.removeListener('SIGINT', interrupt);
    signalSource.removeListener('SIGTERM', terminate);
  }
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  let options, endpoint;
  try {
    options = parseArguments(argv);
    if (options.help) { process.stdout.write(HELP); return 0; }
    endpoint = localEndpoint(environment.KURUMI_URL);
  } catch (error) { process.stderr.write(error.message + '\n'); return 2; }
  return runBridge({ ...options, endpoint, onSpawnError: text => process.stderr.write(text + '\n') });
}

module.exports = { main, runBridge, parseArguments, localEndpoint };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write('命令包装器发生内部错误。\n'); process.exitCode = 1; });
