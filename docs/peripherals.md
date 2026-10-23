# 鼠标与键盘采样协议

原生宿主通过 `POST /api/peripherals` 上报显式读数或不可用状态。接口只在127.0.0.1监听，复用Host/Origin/请求大小保护和串行状态更新。来源标签不是密码学身份认证。

```json
{"samples":[{"id":"MOUSE_DISTANCE","value":125.5,"time":1792680000000},{"id":"MOUSE_CLICKS","value":2,"time":1792680000000}],"unavailable":[{"id":"KEYBOARD","reason":"permission-required"}]}
```

一次合计最多三个不同品种，仅允许MOUSE_DISTANCE、MOUSE_CLICKS、KEYBOARD。数值必须有限且非负。时间需新于同品种上次采样且在服务的时间窗口内；整体校验，失败不部分提交。不可用原因为permission-required/no-device/unsupported/read-error，不插入零价、历史保留且立即禁止交易。停止上报60秒后过期。

MOUSE_DISTANCE为屏幕点/秒：通过CoreGraphics listenOnly的鼠标移动与拖动事件，累计每次deltaX/deltaY的欧氏长度，除以单调时钟真实间隔。它包含系统指针加速及可能的触控板输入，不能换算成硬件毫米，也不是设备回报率。不保留坐标或轨迹。

MOUSE_CLICKS为clicks/s，来自左、右及其他鼠标按下事件计数；KEYBOARD为keys/s，来自keyDown事件计数（包含系统重复按键）。只采集数量，不读取键值、输入文本或应用内容。

约每秒采样，首个基线、计数回退、长于5秒的唤醒间隔均不生成样本。启动时只检查已有输入监控授权，不自动弹出权限请求。没有授权明确标permission-required。旧MOUSE_FREQUENCY与MOUSE_BATTERY已移除，旧历史不混入新单位。

线程数与TCP端点数另由有界系统采集器每5秒读取：线程来自 `ps -M -A` 枚举行计数，只有计数保存于内存；TCP来自 `sysctl net.inet.tcp.pcbcount`，包含监听及其他状态。错误或输出超限时明确不可用，不凭空生成零。
