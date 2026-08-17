# dsh-read-aloud

DeepSeek Harness（DSH）对话实时朗读插件：监听当前会话的流式输出，把 DeepSeek 的**正常回复**逐句朗读出来——边生成边读，解放双眼。

- ✅ 只读正文（`text-delta`），**不读思维链**（`reasoning-delta`）、不读工具调用、不读子代理会话
- ✅ 双引擎：本地 OneCore 即时（首音 <1s）/ edge-tts 神经语音流式（晓晓等，音质接近真人）
- ✅ 10 层非文本清洗：URL、路径、哈希、代码块、表格线、emoji 等**不会被逐字符机械朗读**
- ✅ 关键词控制：别读了 / 继续朗读 / 切换音色引擎
- ✅ 失败静默降级（edge 断网自动回落本地），绝不干扰对话本身

## 快速开始

```text
# DSH 注入器环境内（super-injector 通道）
dev_build_plugin  {"dir": "<本目录>"}
dev_inject_plugin {"dir": "<本目录>"}

# 改代码后热重载（免重注入）
dev_build_plugin  {"dir": "<本目录>"}
dev_reload_package {"packageName": "dsh-read-aloud"}
```

依赖：Windows + dotnet 9 运行时（OneCore 宿主）+ 本机 `ffplay`（OneCore 档播放）+ `edge-playback`（edge 档，可选）。

## 控制词（短消息生效，防误触发）

| 说 | 效果 |
|---|---|
| 别读了 / 停止朗读 / 安静 / 静音 | 立即停止并清空队列 |
| 继续朗读 / 接着读 / 开始朗读 | 恢复 |
| 用晓晓读 / 用云端 / 高质量 | 切 edge-tts 流式（晓晓） |
| 用本地读 / 用慧慧 / 即时档 | 切回本地 OneCore |

## 配置（`src/index.ts` 的 `DEFAULTS`）

| 项 | 默认 | 说明 |
|---|---|---|
| `engine` | `edge` | `edge` 流式 / `onecore` 即时 |
| `voice` | `Huihui` | OneCore 音色（慧慧/瑶瑶/康康） |
| `rate` | `1` | OneCore 语速 0~3 |
| `edgeVoice` | `zh-CN-XiaoxiaoNeural` | edge 音色（晓晓/晓伊/云希…） |
| `edgeRate` | `+0%` | edge 语速（`+10%` 形式） |
| `maxQueue` | `8` | 队列上限，超限丢新句（跟读模式） |
| `maxSentenceLen` | `200` | 单句强制切分上限 |
| `fallbackToLocal` | `true` | edge 失败自动降级 OneCore |

## 工作原理

```
DeepSeek 流式输出 → DSH session/event 火线（assistant/chunk）
  → 主会话过滤（跳过 subagent）→ 仅取 text-delta
  → 句子切分 + 10 层非文本清洗（splitter）
  → FIFO 队列 → 双引擎执行（speaker）
       onecore: dotnet 宿主合成 wav → ffplay
       edge:    edge-playback 流式（3 句一批，批内无缝）
  → 扬声器
```

关键点：DSH 的流式事件不直接以 `assistant/chunk` 广播，而是包在 `session/event` 火线的 `{type, seq, time, data}` 信封里；火线只推送实时 append，历史重放不上火线（天然满足"不读历史"）。

## 目录

```
src/index.ts      插件入口（订阅/控制词/装配）
src/splitter.ts   句子切分 + 非文本清洗管线
src/speaker.ts    队列 + 双引擎 + 降级链 + 打断
scripts/build.sh  WSL 构建（checkout 探测 + tsc）
vendor/onecore-host/  dotnet 9 OneCore 合成宿主
docs/              idea 调研文档（含全部实测结论）
AGENTS.md          Agent 开发指引（架构事实 Hub）
```

## 已知限制

- 批间（段落级）有 2~3 秒首音；预合成管线（播放时后台合成下一批）是下一迭代的彻底方案
- 表格退化为连续词朗读；超长句按 200 字强制切
- 只读实时流；重启后需重新注入（或经 `dev_install_package` 装配进 profile）

## License

BSD-3-Clause
