# DSH provider output token bridge

## Package and install contract

The package lives in `plugins/jiuliu-dsh`, is named `@jiuliu/dsh-token-bridge`, and uses only Node builtins. It has no dependencies or lifecycle scripts. This is a Cordis Host plugin, not a wrapper around a CLI command or a log-file collector.

The following help was verified against the installed DSH `0.2.1-rc.2`:

```text
Usage: dsh plugin [options] [args...]
manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory
--profile <name>  the profile whose plugins to manage
```

Install:

```sh
# Run from the repository root
dsh plugin --profile desktop add "$PWD/plugins/jiuliu-dsh"
```

This is an absolute local package path; use the actual checkout path on another machine. The installed runtime's package-level bundle metadata is **`dsh.bundle.patch`**, pointing to `cordis.patch.yml`. The CLI's plugin manager automatically adds newly installed bundle dependencies to the profile-level **`dsh.profile.bundles` array**. A package field called `dsh.profile.bundle` would not activate this plugin in this runtime.

The patch inserts Host entry `jiuliu-dsh-token-bridge` with module name `@jiuliu/dsh-token-bridge`, default `config.port: 8766`. Both `apply` and `name` are ESM exports; Cordis' module loader accepts the namespace with an `apply` function.

The CLI's installation persists package/profile changes. In this verification run, the existing desktop Host mounted the newly installed package automatically: the profile selection was confirmed and the shared CLI observed actual positive provider usage. This is observed Host HMR behavior for this environment, not a guarantee that every CLI install or source edit will hot-reload. If the plugin does not mount, or the plugin manager reports `restart-required`, restart the existing DSH desktop application. A browser refresh alone does not restart Host. This package has no client assets or frontend development watcher requirement. Do not launch a second replacement DSH server to apply it.

An unrelated, pre-existing plugin compatibility failure can prevent profile startup even when adding this package exits successfully. Do not bypass version checks automatically or change unrelated plugins; resolve that existing profile issue separately and then verify mounting.

Uninstall:

```sh
dsh plugin --profile desktop remove @jiuliu/dsh-token-bridge
```

Restart Host after removal. `dsh plugin` forwards pnpm arguments; it does not expose a separate `enable` command. For an already-installed but disabled bundle, use the DSH plugin manager's enable control rather than guessing a CLI subcommand.

## Verified runtime hooks

The installed app is an ASAR archive, not an ordinary source checkout. Runtime API inspection used exact source entries extracted read-only from `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`. No session logs were read and no app/profile files were changed by the plugin implementation.

The inspected sources establish the following contract:

| Runtime package | Evidence |
| --- | --- |
| `@deepseek-ai/dsh-agent` | `agentEvents` injects `{ agent, ...payload }`; Cordis strips the event name and scope carrier before invoking the registered listener. |
| `@deepseek-ai/dsh-agent-loop` | `agent/assistant-stream` payload is `{ agent, frame }`. Frames are `start`, `chunk`, `end`; `chunk.chunk.type === 'usage'` carries provider usage. The request's durable event commits **before** its end frame. |
| `@deepseek-ai/dsh-session` | `session/event` listener receives `(session, event)`. Only newly committed events emit; constructor seed/restored history does not. |
| `@deepseek-ai/dsh-llm` | `AssistantStreamAccumulator` retains usage as `{ type: 'chunk', time, chunk: { type: 'usage', usage } }` in the compact durable `data.stream`. Text/reasoning packing does not change usage records. |
| `@deepseek-ai/dsh-token-meter` | `assistant/message` first reads `data.usage`; `assistant/message` and `assistant/attempt` otherwise read the last usage chunk in `data.stream`. The bridge follows the same precedence. |
| `@deepseek-ai/cordis` | `ctx.on` returns an owned listener disposer. `ctx.effect(() => disposer)` owns other resources. No generic `ctx.on('dispose')` notification is sent by this version. |
| `@deepseek-ai/dsh-plugin-manager` | Recognizes `manifest.dsh.bundle.patch`; reconciliation appends new bundle dependencies to `profile.bundles`. |

Registration:

```js
ctx.on('agent/assistant-stream', ({ agent, frame }) => { /* observe */ }, { global: true });
ctx.on('session/event', (session, event) => { /* reconcile */ }, { global: true });
```

The global option lets the Host observer receive main, subagent and teammate scopes without requiring a service import or modifying the generation pipeline. `ctx.effect` owns cleanup even during failed setup or HMR unload; cleanup explicitly releases both listeners, clears the timer/state/queue, and destroys the in-flight request.

## Counting and rate semantics

The only count accepted is a nonnegative safe integer `usage.outputTokens`. Input, cache, reasoning text, content lengths, tool invocations, and command activity are never converted into output token estimates. If the provider includes reasoning in its output usage, the bridge preserves the provider's definition rather than recounting it.

Per live attempt, only the positive difference from the largest observed cumulative output count contributes. Identical or decreasing usage snapshots add zero. Live `start` creates a distinct attempt even when a retry uses the same turn and step. A durable settlement reconciles against the active attempt, then closes it; its later end frame adds no tokens. The recent durable sequence set rejects repeat notifications. Durable-only observations retain the most recent turn/step slot, and `llm/retry-started` resets that replacement slot. Partial and abandoned attempts retain any actual usage already observed. Frames arriving after a settled attempt are ignored.

Mounting mid-attempt may miss start; its first live usage total is still provider-reported output and is reconciled with the subsequent durable settlement. This can include output generated before mounting, so installation takes clean effect from the next request. The bridge does not replay historical sessions.

Positive deltas across all observed scopes are coalesced into one event per one-second timer tick. Event timestamps are local aggregation/arrival times; they are not invented per-token generation timestamps. The service samples received increments and exposes:

```json
{"source":"dsh-token-events","unit":"tokens/s"}
```

The value is received provider output token deltas divided by the service's actual elapsed sampling interval. Providers with streaming usage can update at that cadence. Providers that report usage only at completion produce one final real-count burst; this cannot reveal instantaneous generation speed. No interpolation, chars-per-token conversion, or guessed rate is applied.

On mount, the plugin sends an explicit `tokens: 0` connection heartbeat. It sends another at most every five seconds while no counts arrive, except while an active attempt has never supplied valid usage. Unknown usage cannot manufacture measured zero. After an unknown request settles, idle heartbeat resumes. The service marks measurements stale after fifteen seconds without token events; a missing plugin is not presented as a working zero-rate source.

## HTTP and privacy contract

Requests go only to `http://127.0.0.1:<port>/api/dsh-tokens`; the sole user setting is a numeric port in `1..65535`. No arbitrary endpoint, proxy, redirect or remote URL is accepted.

```json
{"eventId":"dd1ec829-c199-4e8b-a5de-76f551f751ff","tokens":42,"time":1792681200000}
```

`eventId` is a fresh opaque UUID, satisfies `/^[A-Za-z0-9_.:-]{1,128}$/`, and remains unchanged across retries of that event. `tokens` is a nonnegative safe integer **delta**, never an attempt or session total. `time` is a millisecond local timestamp accepted within the service's past sixty-second/future five-second window.

No prompt, assistant text, reasoning, tool parameters, provider name, path, model, session ID, agent ID, attempt ID, credentials, or trace identifier crosses HTTP. Identities are used only as bounded, process-local deduplication keys. There is no filesystem scanning, subprocess, global HTTP monkey patch, custom LLM request, or retained transcript.

Node `http.request` uses a literal loopback hostname and `agent: false`; it does not consult proxy environment variables or follow 3xx responses. At most one request runs concurrently. An independent wall-clock timer destroys it after one second. Network errors and HTTP 5xx/408/429 retry at most once with the same payload/ID. Other 4xx and 3xx responses are discarded. An unavailable pet service never awaits or rejects the generation listener.

The queue holds at most 128 events; when full, an idle heartbeat is removed first, otherwise the oldest event is removed. Events older than fifty-five seconds are discarded rather than retimestamped. State holds at most 128 sessions, each with 32 attempts/positions and 256 durable sequence identities; inactive session state expires after five minutes. Limits intentionally trade complete accounting under prolonged failure/extreme concurrency for bounded memory and nonblocking real-time observation. This is telemetry rather than a billing ledger.

The pet service independently deduplicates up to 512 events for five minutes and uses a fifteen-second stale threshold. One-second coalescing keeps ordinary traffic below that deduplication budget. Dropped events are not fabricated or replayed after the permitted time window.

## Validation

Run the focused contract suite:

```sh
node --test tests/dsh-plugin.test.cjs
```

It covers real-shaped live frames and packed durable usage; cumulative deltas and final deduplication; retries, interrupted/abandoned output and mounting mid-attempt; durable-only fallback; invalid/absent usage and no character estimates; payload privacy; retry ID reuse; timeout, queue/session bounds, unreachable service and no redirect following; Cordis effect cleanup; and a real loopback HTTP receiver. Tests use a receiver or injected transport and do not make LLM calls or read private logs.

After mounting in DSH, use ordinary session output to verify `node bin/kurumi.cjs tokens`, or inspect the existing service's shared `/api/state` response. A working idle heartbeat proves mounting/transport; a positive increment requires provider usage to arrive. Do not synthesize a model invocation just to manufacture activity.
