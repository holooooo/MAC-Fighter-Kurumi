# Agent 命令生命周期桥

[命令包装器](../bin/kurumi-agent.cjs)运行真实命令，将该会话的开始、存活心跳和结束通知本地桌宠服务。它只证明被包装的进程仍在运行，不代表模型正在推理、产生 token、执行工具或完成工作。不包装的 Agent 不会自动被检测。

## 使用

从项目根目录执行：

```sh
node bin/kurumi-agent.cjs --agent codex -- codex
node bin/kurumi-agent.cjs --agent claude -- claude
node bin/kurumi-agent.cjs --agent dsh -- dsh
node bin/kurumi-agent.cjs --help
```

`--` 后的第一个参数是可执行文件，剩余参数逐项原样交给 `spawn`，不开启 shell。可执行文件必须已安装并在 PATH 中，或提供绝对路径。包装器不会安装命令，不解释管道、重定向、命令替换或 shell 表达式。终端中本来就由 shell 解析的字符仍需正常引用。

标准输入、标准输出、标准错误全部继承，用户继续直接与原命令交互；包装器不监听这些流，不保存内容，不把命令名、参数、工作目录或输出文本发送给服务。测试为了断言输出会捕获测试子进程，生产 CLI 使用 `stdio: inherit`。

## 本地接口

默认服务地址 `http://127.0.0.1:8766`。可通过 `KURUMI_URL` 指定本地 HTTP 端口；仅允许 `127.0.0.1` 或 `localhost`，后者固定解析为 IPv4 回环。禁止 HTTPS、远程主机、用户凭证、额外路径、查询参数或片段，不跟随重定向。错误配置返回 2，命令不会启动，以免静默发往错误目的地。

示例：

```sh
KURUMI_URL=http://127.0.0.1:8766 node bin/kurumi-agent.cjs --agent codex -- codex
```

每个会话随机生成 UUID v4，并 POST `/api/agent-events`：

```json
{"agent":"codex","sessionId":"UUID-v4","event":"start"}
```

`agent` 仅支持 `codex`、`claude`、`dsh`；`event` 为 `start`、`heartbeat`、`stop`。只有子进程发出 `spawn` 成功事件后才发送 start，默认每 5 秒一次 heartbeat，真实启动过的子进程退出后发 stop。不存在或无法启动的命令不发送任何活动事件。没有 Origin 的本地 Node 请求需由服务允许；服务接口由采集服务负责，本包装器不创建或修改服务。

每次请求有 1 秒总超时，同一时刻最多一个请求。前次请求尚未完成时跳过本次心跳，不排队补发；命令执行无需等服务响应。退出时仅等待当前一次有限请求，再尝试一次有限 stop，因此服务故障最多给退出增加约 2 秒延迟。网络不可达、拒绝、错误状态码或超时均不覆盖命令退出码，也不把服务响应写到终端。

完整 2xx 响应代表已注册；请求失败、超时或非 2xx 会标记未注册。只要真实子进程仍在运行，下一次心跳时机改发同一 sessionId 的 start，成功后恢复 heartbeat；服务重启丢失会话并拒绝 heartbeat 时也会走此恢复路径。不立即循环重试、不并发、不在子进程结束后重新注册；stop 仅尝试一次。服务端须按 sessionId 幂等处理 start，并以心跳过期清理丢失 stop 的会话。主机强制关机、SIGKILL 或包装器崩溃无法保证发送 stop。多会话共享 agent 类型时，服务端应按 sessionId 分别追踪，不能把一条 stop 当作所有会话已结束。

## 退出与信号

普通退出保持真实子进程退出码。子进程被信号终止时返回 `128 + 信号编号`。找不到可执行文件返回 127，其他启动失败返回 126；参数或地址配置错误返回 2。启动失败只输出通用错误，不复述命令参数。

收到 SIGINT／SIGTERM 后向当前直接子进程转发同一信号，等待它结束并发送 stop。若子进程自行处理信号并返回特定退出码，保留该码。包装器不根据端口杀进程、不杀其他会话，也不额外管理子进程创建的孙进程；命令忽略信号时需要由用户按该命令本身的退出方式处理。

该桥属于用户明确执行的本地工具。它不上报鼠标、键盘、文件、token 或后台 Agent 活动，也不把心跳伪装为生产力指标。除正常运行被包装命令外，不执行来自服务响应的代码或指令。

## 验证

```sh
node --test tests/agent-bridge.test.cjs
```

[测试](../tests/agent-bridge.test.cjs)使用临时回环端口和真实 Node 子进程，覆盖参数字面量、隐私字段约束、UUID 与事件顺序、真实五秒心跳、服务不可达、有限超时、无并发请求、子进程错误码、SIGTERM 转发、帮助及拒绝远程地址。测试不依赖真实 Agent 账户或外部网络。
