# dsh-read-aloud

DeepSeek Harness（DSH）对话实时朗读插件（**hybrid：host 朗读引擎 + client 对话栏按钮**）：监听当前会话的流式输出，把 DeepSeek 的**正常回复**逐句朗读出来——边生成边读，解放双眼。对话输入栏（composer）左侧有一个**朗读开关小图标按钮**，朗读中图标动态波动，点击即可开关朗读。

- ✅ 只读正文（`text-delta`），**不读思维链**（`reasoning-delta`）、不读工具调用、不读子代理会话
- ✅ **预合成管线**：播放批 i 时后台合成批 i+1（双文件槽轮换），**批间无停顿**；edge-tts **常驻合成进程**预热，首批/断流恢复 ~2s
- ✅ 双引擎（两段式）：edge-tts 神经语音（晓晓等，音质接近真人，首选）/ 本地 OneCore 兜底
- ✅ 10 层非文本清洗：URL、路径、哈希、代码块、表格线、emoji 等**不会被逐字符机械朗读**
- ✅ **符号静音**：`/`、`（）`、`-`、`——`、`"_`、`&`、`#` 等符号不读（括号内容保留，"（见上文）"读成"见上文"；`some_var` 读成 "some var"；`state-of-the-art` 读成 "state of the art"）
- ✅ **对话栏按钮**（`conversation.input.left`）：待命 / 朗读中波动 / 已关闭三态，点击开关
- ✅ **只读当前打开的会话**：对话栏按钮自动上报当前会话，多会话并存时不交错混读
- ✅ **朗读进度横条**：对话栏上方显示一条"🔊 朗读中 {当前句}"，随朗读滚动，与输入区一体
- ✅ **状态持久化**：静音/引擎选择存 `~/.dsh/super-injector/dsh-read-aloud-state.json`，host 重启自动恢复
- ✅ **自动装配**：已 `dev_install_package` 进 profile bundles，DSH 重启后自动加载（无需再注入）
- ✅ 关键词控制：别读了 / 继续朗读 / 切换音色引擎
- ✅ 失败静默降级（edge 断网自动回落本地），绝不干扰对话本身

## 快速开始

```text
# DSH 注入器环境内（super-injector 通道）
dev_build_plugin  {"dir": "<本目录>"}
dev_inject_plugin {"dir": "<本目录>"}          # 运行时注入（本机已装配进 profile，重启自动加载）

# 改代码后热重载（免重注入；client 改动浏览器需刷新一次页面）
dev_build_plugin  {"dir": "<本目录>"}
dev_reload_package {"packageName": "dsh-read-aloud"}

# 已执行过 dev_install_package：dsh.profile.bundles 已含本包，DSH 重启后自动装配
```

依赖：Windows + dotnet 9 运行时（OneCore 宿主）+ 本机 `ffplay` + `edge-tts`（`~/.local/bin/edge-tts.exe`，edge 档）。

## 对话栏按钮

- 位置：输入框卡片左下工具排（`conversation.input.left` slot，plan 右侧），30px 图标按钮。
- 视觉：**已开启**=喇叭+声波弧（品牌色）；**朗读中**=喇叭呼吸 + 右滑三根音量条波动（CSS 动画）；**已关闭**=喇叭+斜线（灰、半透明）。
- 交互：点击即 toggle（静音↔恢复，静音时打断当前播放）；每 300ms 轮询 host RPC `state` 驱动动画；host 不可达时图标降透明（offline 兜底）。
- 无障碍：`aria-label` / `aria-pressed`，支持 `prefers-reduced-motion`。
- 通信：host 注册 `/@dsh-external/dsh-read-aloud/api` 前缀路由（`state`/`toggle`/`stop`/`resume`），client 经 `fetch` POST 调用。

## 控制词（短消息生效，防误触发）

| 说 | 效果 |
|---|---|
| 别读了 / 停止朗读 / 安静 / 静音 | 立即停止并清空队列（按钮同步显示已关闭） |
| 继续朗读 / 接着读 / 开始朗读 | 恢复（按钮同步显示已开启） |
| 用晓晓读 / 用云端 / 高质量 | 切 edge-tts 流式（晓晓） |
| 用本地读 / 用慧慧 / 即时档 | 切回本地 OneCore |

## 配置（`src/index.ts` 的 `DEFAULTS`）

| 项 | 默认 | 说明 |
|---|---|---|
| `engine` | `edge` | `edge` 神经语音 / `onecore` 本地即时 |
| `voice` | `Huihui` | OneCore 音色（慧慧/瑶瑶/康康） |
| `rate` | `1` | OneCore 语速 0~3 |
| `edgeVoice` | `zh-CN-XiaoxiaoNeural` | edge 音色（晓晓/晓伊/云希…） |
| `edgeRate` | `+0%` | edge 语速（`+10%` 形式） |
| `edgeTts` | 自动探测 | edge-tts 可执行（`~/.local/bin/edge-tts.exe` 优先）；纯合成不播放 |
| `maxQueue` | `24` | 队列上限；满时**丢最旧句保新句**（跟读跟上最新） |
| `maxSentenceLen` | `200` | 单句强制切分上限 |
| `fallbackToLocal` | `true` | edge 合成失败自动降级 OneCore |

> 注：`engine`/静音状态由 state.json 持久化（运行时切换会覆盖代码默认值）；其余配置项仍为代码常量。

## 工作原理

```
DeepSeek 流式输出 → DSH session/event 火线（assistant/chunk）
  → 主会话过滤（跳过 subagent）→ 仅取 text-delta
  → 句子切分 + 10 层非文本清洗（splitter）
  → FIFO 队列 → 预合成管线（speaker）
       合成器（后台，串行）:  edge-tts --write-media / onecore-host
       播放器（前台）:        ffplay，播放批 i 时预合成批 i+1
  → 扬声器
```

对话栏按钮通过 host webServer RPC 读取 `Speaker.getState()`（`muted`/`speaking`/`engine`）并与关键词控制走同一套 `stop()/resume()/toggle()` 状态机——按钮与"说一句话"完全等价。

关键点：DSH 的流式事件不直接以 `assistant/chunk` 广播，而是包在 `session/event` 火线的 `{type, seq, time, data}` 信封里；火线只推送实时 append，历史重放不上火线（天然满足"不读历史"）。

## 目录

```
src/index.ts        插件入口（订阅/控制词/装配 + webServer RPC + 状态持久化）
src/splitter.ts     句子切分 + 非文本清洗管线
src/speaker.ts      预合成管线（合成器/播放器分离 + 双缓冲）+ 双引擎 + 降级链 + 打断
src/client/index.ts 对话栏按钮 UI（conversation.input.left slot，纯 JS body）
scripts/build.sh         WSL 构建 host（checkout 探测 + tsc）
scripts/build-client.mjs   把 src/client/index.ts 抽成 lib/client.js（ModuleLoader bundle）
var vendor/onecore-host/  dotnet 9 OneCore 合成宿主
docs/              idea 调研文档（含全部实测结论）
AGENTS.md          Agent 开发指引（架构事实 Hub）
```

## 构建（host + client 双产物）

```text
dev_build_plugin {"dir": "<本目录>"}
#  → scripts/build.sh 编译 host：src/ → lib/index.js
#  → npm run build:client（scripts/build-client.mjs）→ lib/client.js（ModuleLoader bundle）
#  → npm pack → *.tgz
```

`lib/client.js` 由 `src/client/index.ts` 抽取生成：文件顶层保留 `export const inject = ['slots','timer']` + `const __mirror = ...` 镜像（供注入器 client 骨架预检锚点），`build-client.mjs` 提取 `__mirror` 内 body 包裹进 `window.__ModuleLoader__.load({ id, factory })`。**改 UI 源后必须重跑 `dev_build_plugin`**（lib/client.js 过期会被注入器构建预检拦截）。

## 已知限制

- 首批/断流恢复需等网络合成（~2s，edge-tts 常驻进程预热后）；之后批间无缝（预合成管线，批粒度 6 句/180 字保证播放时长 > 合成时长）
- **跟读滞后**：LLM 输出（~2 句/s）远快于播放（~0.36 句/s），队列满（24）时丢最旧句、保最新内容——长回复会"跳读"中间部分（旧版丢新句同样跳读且丢最新）
- **只读当前会话依赖 GUI**：client 按钮上报当前会话；若 host 无 web GUI 页面加载（activeSessionId 为空）则回退为朗读全部会话
- **对话栏上方进度横条为近似**：当前句按字符权重估算（无字幕时间轴），±1 句误差
- edge-tts 依赖微软在线服务，断网自动降级 onecore
- 只读实时流；表格退化为连续词朗读；超长句按 200 字强制切
- 关键词控制依赖用户消息文本，长消息内的控制词会被忽略（防误触发）
- 浏览器页面已打开时新增/升级 UI 需刷新一次才能看到按钮（client bundle 经 HMR 联动，但首装需重载页面）

## License

BSD-3-Clause
