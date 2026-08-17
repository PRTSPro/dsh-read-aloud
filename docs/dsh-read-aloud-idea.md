# DSH 语音朗读插件（dsh-read-aloud）— Idea 文档

> 状态：**v0.0.1 已开发并实测** ｜ 作者：用户 + DeepSeek ｜ 日期：2026-08
> **2026-08 重大更新①：OneCore 自然语音可用性已突破**（见 3.2 与 3.3）——本机 3 个 OneCore 音色（慧慧/瑶瑶/康康）经 dotnet 9 C#/WinRT 投影实测合成成功，插件音色池扩至 5 个，宿主方案升级为 dotnet 语音宿主。
> **2026-08 重大更新②：edge-tts 流式播放已实测**（见 3.4）——`edge-playback` 边合成边出声、**不需要先生成文件**，每句首音 2~3 秒；本机 edge-tts/edge-playback 已装、ffplay 已有。混合策略定型：本地 OneCore（即时）/ edge-tts 流式（高质量）/ 预合成缓存（复用零延迟）三档。
> **2026-08 重大更新③：插件已开发完成（v0.0.1）**——注入/热重载/双引擎/清洗管线/批提交全部实测通过；项目迁移至工作区 `D:\A-DSH\TTS-LLM-ASR\dsh-read-aloud\`；见文末「开发记录」。**订阅机制已按实测修正**（见 3.1）：事件源是 `session/event` 火线，不是 `ctx.on('assistant/chunk')`。
> 目标读者：未来动手开发时的自己（含全部已核实的调研结论与决策点）

---

## 0. 一句话定位

一个 DeepSeek Harness（DSH）插件：在用户与 DeepSeek 对话时，**监听 agent 的流式输出，通过本地 Windows SAPI 语音即时朗读出来**，实现"边打字边说话"。

---

## 1. 背景与动机

### 1.1 场景

用户在使用 DSH Web GUI 与 DeepSeek 对话时，希望 AI 的回答**不只用眼睛看**，还能**用耳朵听**——朗读输出，解放双眼（比如边做别的事边听答案、长文播报、语音验证回答完整性）。

### 1.2 为什么现在可行（三个现成基础）

| 基础 | 现状 |
|------|------|
| 本机 Windows 语音 | `System.Speech`（SAPI）可用：慧慧（中文女）/ Zira（英文女），**零延迟即时朗读**（已实测播报） |
| DSH 插件体系 | cordis 生态，四种形态（toolkit / daemon-loop / ui-panel / hybrid），可注入运行 |
| DSH 事件流 | `assistant/chunk` 事件携带模型输出流式 token（`text-delta`），是朗读的原料（源码已核实） |
| 既有 skill | `win-notification` 已安装到 `~/.dsh/skills/win-notification/`，语音/弹窗调用范式现成 |

### 1.3 与既有方案的差异

- **win-notification skill**：面向"任务完成/审批提醒"等**事后主动呼叫**，非对话实时朗读。
- **edge-tts 神经语音**：音质最好；文件模式固定 4~5 秒（本机实测短句 4.0s），但**流式模式（edge-playback）不落盘、每句首音 2~3 秒**（实测）——作为"高质量模式"可用。
- **本插件**：专注**对话过程中实时朗读**，本地 OneCore 即时为默认底座，edge-tts 流式为可选高质量档。

---

## 2. 目标与非目标

### 2.1 MVP 目标（第一版必须做到）

1. 插件安装后，DeepSeek 输出正文（`text-delta`）时**自动逐句朗读**（中文/英文）。
2. 朗读与生成**同步进行**（不等整段结束），句子边界切分自然。
3. 用户可随时**打断/暂停/恢复/静音**（关键词命令 + 可选 UI 开关）。
4. 失败静默降级（SAPI 不可用时不影响对话本身）。

### 2.2 非目标（第一版不做）

- ❌ 不朗读用户输入
- ❌ 不做多音色轮换/情感渲染（音色配置可留接口）
- ❌ 默认不接 edge-tts（作为"高质量模式"在阶段 3 接入：流式播放 + 预合成缓存）
- ❌ 不做跨进程 UI 面板（hybrid 形态可后续加）
- ❌ 不朗读历史会话（只读实时流）

---

## 3. 调研结论（已核实，含证据）

### 3.1 DSH 事件流 —— 朗读原料 ✅

**事件**：`assistant/chunk`（来源：`@deepseek-ai/dsh-session`，持久化事件目录）

```ts
// dsh-session/lib/types/types.d.ts（已核实）
'assistant/chunk': {
    turn: number;
    step: number;
    chunk: StreamChunk;   // dsh-llm 的流协议
};
```

**StreamChunk 类型**（`@deepseek-ai/dsh-llm/lib/types/types.d.ts`，已核实）：

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta';    index: number; text: string }   // ← 正文，朗读原料
  | { type: 'reasoning-delta'; index: number; text: string } // 推理过程（可选朗读）
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason };
```

**辅助事件**（收尾/状态）：
- `turn/end` / `step/end`：一轮/一步结束（处理句尾余句）
- `assistant/message`：完整消息组装（可作回退源）

**订阅机制（2026-08 开发实测修正）⚠️**：`assistant/chunk` 是 **session 日志事件（SessionEvent）**，**不是** cordis 根事件——不能 `ctx.on('assistant/chunk')`。真实通道是根上下文上的唯一火线：

```ts
// dsh-session/lib/types/index.d.ts（已核实）：根 Events 只有 session/created|disposed|event|flush
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void

// 插件实际写法（src/index.ts）
ctx.on('session/event', (session, event) => {
  if (session.header.origin === 'subagent') return   // 只读主会话（scope 过滤）
  if (event.type !== 'assistant/chunk') return
  const { turn, step, chunk } = event.data           // 注意信封：{type, seq, time, data}
  if (chunk.type !== 'text-delta') return           // 只读正文，跳过 reasoning/tool-call
  // chunk.text → 切句 → 队列
})
```

附带两个已核实的有利事实：
1. **火线只推实时 append**——构造函数 seed（重放/fork/resume 的历史事件）不上火线，天然满足"不朗读历史会话"（零额外过滤）。
2. **`session/event` 是 scope-filtered 分发**——agent 作用域监听器只收本 agent 会话；根级监听器收全部（含子代理），所以必须用 `session.header.origin !== 'subagent'` 排除子代理噪音。主会话识别依据：`SessionHeader.origin?: 'subagent'` 与 `delegationDepth`（顶层缺省），类型在 dsh-session types.d.ts L60-77。

### 3.2 本机语音能力实测 ✅

| 项 | 结果 |
|----|------|
| SAPI 音色 | `Microsoft Huihui Desktop`（zh-CN 女）、`Microsoft Zira Desktop`（en-US 女） |
| **OneCore 自然语音** | ✅ **已突破可用**（dotnet 9 + C#/WinRT 投影实测）：慧慧（女）/ 瑶瑶（女）/ **康康（男）**，康康合成播放成功（WAV 280KB） |
| OneCore 宿主 | **dotnet 语音宿主**（`D:\DS-Task\.scratch\onecore-host`，net9.0-windows）：枚举/选音色/合成 wav，一条命令完成 |
| 即时性 | Speak 同步调用即读，**零网络延迟** |
| 语速 | SAPI：`$s.Rate = -10..10`；OneCore：`SpeechSynthesizer.Options.SpeakingRate`（0~3） |
| 异步 | `SpeakAsync` / `SpeakAsyncCancelAll`（打断用） |
| 输出文件 | `SetOutputToWaveFile` / `SynthesizeTextToStreamAsync`（可作预合成缓存） |
| ~~OneCore 在 PS 的可用性~~ | ~~PowerShell 5.1 WinRT 投影 bug 无法选择~~ → **改用 dotnet 宿主，问题不复存在** |

### 3.3 权限与沙箱限制 ⚠️（关键坑，已实测）

| 限制 | 实测结论 |
|------|---------|
| SAPI 初始化 | **受限令牌（沙箱）下失败**，报 "current security setting"；完整权限下成功 → 插件进程必须能拿到完整权限（DSH host 进程本身是用户会话进程，插件内直接调用应无此问题，但**必须在真实注入后验证**） |
| OneCore 可用性 | ~~PS 5.1 投影 bug 不可用~~ → **dotnet 9 宿主完全可用**（`net9.0-windows10.0.19041.0` TFM + C#/WinRT 投影，实测枚举+合成+播放全通） |
| Node 子进程管道 | 沙箱内 `child_process` 捕获输出（stdio pipe）会 EPERM；**用 `stdio: 'inherit'` / `'ignore'` 即可**（github-connect skill 已记录） |
| 调用方式（推荐） | 插件（Node）→ `child_process.spawn(dotnet 宿主 exe, [voice, text, out.wav], { stdio: 'ignore' })` → 合成 wav → 播放（或宿主直接 `MediaPlayer` 播放）；SAPI 备选：`spawn('powershell.exe', ..., { stdio: 'inherit' })` |

### 3.4 edge-tts 三模式实测（音质最佳档，流式已通）

**工具已就绪（本机实测）**：`edge-tts` / `edge-playback` 已安装（`C:\Users\17151\.local\bin\`），`ffplay`（Gyan.FFmpeg 8.1.2 完整版）已有 → **无需任何额外安装**。

| 模式 | 实测延迟 | 说明 |
|------|---------|------|
| **流式播放**（edge-playback → ffplay） | **首音约 2~3 秒**，边合成边出声 | 不落盘，一句话总时长 ≈ 首音 + 朗读时长（实测整句含播放 10.3s，其中播放本身占大头） |
| 文件模式（--write-media） | 合成 3~4 秒（短句 3.1~3.4s 实测） | 生成 mp3 后播放零等待；适合缓存复用 |
| 预合成缓存 | 第二次起 0 秒 | 常见句子/长回答先落盘，播放文件 |

**流程澄清**：不是"文档→生成→下载→朗读"四段串行——真实流程是 **文本提交（~0.5s 建连）→ 服务端流式合成（1~3s）→ 音频分片边传边播**，MP3 文件只是可选的落盘动作（`--write-media`），流式模式根本不需要文件。

**音色（女声实测）**：晓晓 `zh-CN-XiaoxiaoNeural`（温柔，最常用，实测 3.4s）/ 晓伊 `zh-CN-XiaoyiNeural`（甜美，实测 3.1s）；另有男声云希/云健等 100+ 音色。

**CLI 参数实测（2026-08 开发时修正）⚠️**：`edge-playback` **不接受位置参数文本**（位置传参会 usage 报错 exit 1）。正确形式：

```text
edge-playback -t <文本> -v <音色> [--rate +10%]
```

音色短参数是 `-v`（长参数 `--voice`）；`-t/--text`、`-f/--file`、`-l/--list-voices` 三选一必填。Windows 上 edge-playback 默认用 MCI 播放临时 mp3（非 ffplay），`--mpv` 才切 mpv。播放器选择不影响插件（进程树级 kill 统一打断）。

**句间间隔实测（2026-08）**：逐句提交时**每句**首音 2~3s（每句重新建连+合成），听感割裂、标题与正文间尤其明显。v0.0.1 已用**批提交**解决：攒 3 句（或 120 字）一批、一次进程流式朗读，批内由服务端连续合成无缝衔接，首音只在批头（段落级停顿 ≈ 自然呼吸）。彻底方案（下一迭代）：预合成管线——播放批 i 时后台预合成批 i+1，批间间隔也归零。

| | 本地 OneCore | edge-tts 流式 | edge-tts 文件 |
|---|---|---|---|
| 首音延迟 | **<0.1s（即时）** | 2~3 秒/句 | 3~4 秒/句 |
| 音质 | 良 | 优（接近真人） | 优 |
| 依赖 | 无 | 联网（直连已通，无需代理） | 联网 |
| 适合 | 默认即时跟读 | 高质量模式 | 预合成缓存复用 |

---

## 4. 总体架构

```
DeepSeek 模型流式输出
        │
        ▼
DSH session 事件流 ──► assistant/chunk（text-delta）
        │
        ▼
┌─ dsh-read-aloud 插件（cordis daemon-loop）─┐
│ ① 事件订阅层：ctx.on('session/event') 火线 → 过滤 origin!=subagent → assistant/chunk → 仅 text-delta │
│ ② 文本累积 + 句子切分 + 10 层非文本清洗（URL/路径/代码/符号…）│
│ ③ 朗读队列：FIFO，edge 档 3 句一批流式，可打断/清空 │
│ ④ 控制层：开/关/暂停/静音/切引擎（关键词命令）  │
│ ⑤ 执行层（双档可切换 + 自动降级）：
│    a. 本地即时：dotnet 语音宿主（OneCore 慧慧/瑶瑶/康康）→ 合成 wav → ffplay
│    b. 高质量：edge-playback 流式批（晓晓/晓伊…）→ 失败自动降级 a
│    c. 缓存：预合成管线（下一迭代，批间间隔归零）       │
└──────────────────────────────────────────────┘
        │
        ▼
扬声器：逐句朗读（默认 OneCore 即时；高质量模式走 edge-tts）
```

### 4.1 数据流时序（v0.0.1 实测实现）

1. 用户提问 → 模型开始生成
2. 插件收到 `session/event` 火线信封 → 过滤：主会话、`assistant/chunk`、`text-delta` → 追加到当前句缓冲
3. 缓冲内出现句子终止符（`。！？…\n` 等）→ 切出完整句 → 10 层清洗 → 入朗读队列
4. 朗读队列串行播放：edge 档攒 3 句一批（`edge-playback -t 批 -v 音色` 流式）；onecore 档逐句（宿主合成 → ffplay）
5. 跨 turn 或 `turn/end` → 冲刷句缓冲中的余句（`finish` 不冲刷：同 turn 多 step 连续输出）
6. 用户说"停/别读了/静音" → 清空队列 + kill 进程树（`taskkill /T /F`）

---

## 5. 核心设计决策

### 5.1 朗读范围（待用户拍板，默认建议）

| 选项 | 建议 |
|------|------|
| 只读正文 `text-delta` | ✅ **MVP 默认**（回答主体） |
| 正文 + 推理 `reasoning-delta` | ❌ 默认不读（会与正文混杂） |
| 工具调用说明 | ❌ 默认不读（打断听感） |

### 5.2 句子切分算法

- 终止符集合：`。！？；…\n`（中文），`.!?;\n`（英文，注意小数点/缩写误判——第一版可只按 `。！？\n` 切，安全优先）
- 缓冲上限：如 200 字强制切（防长句卡住听感）
- 切出的句子**原样朗读**（不做清洗第一版；后续可过滤 markdown 符号、代码块）

### 5.3 朗读队列

- FIFO + 单消费者（同一时间只读一句）
- 队列满（如 >10 句）：丢弃队尾新句（跟读模式宁可漏不可积压）
- 打断：清空队列 + CancelAll

### 5.4 控制方式（待用户拍板）

| 方式 | 说明 |
|------|------|
| 默认自动朗读 | 插件启用即读，用户喊"别读了/静音/停下"停止 |
| 默认关闭 | 用户说"朗读/开始朗读"才开 |
| 混合 | 默认自动 + 关键词控制 + 配置项切换默认态 |

- 建议 **MVP：默认自动 + 关键词控制**，与 win-notification 的"发声授权"理念一致（插件开关本身就是授权）。

### 5.5 音色与语速

- 默认：**OneCore 慧慧（女）**（音质优于 SAPI）；可选 瑶瑶（女）/ **康康（男）**；SAPI 备选 慧慧 Desktop / Zira（英文）
- 高质量模式（edge-tts）：晓晓（女，默认）/ 晓伊（女）/ 云希（男）/ 云健（男）等 100+ 在线音色
- 语速：SAPI `Rate`；OneCore `SpeakingRate`（0~3）；edge-tts `--rate`
- 配置项：`engine`（onecore / edge-tts / sapi）、`voice`、`rate`
- 英文内容：第一版仍用中文音色；后续可按内容语言自动切换

### 5.6 三档执行策略（核心决策：解决"流程太长"问题）

| 档位 | 引擎 | 首音 | 适用 |
|------|------|------|------|
| **即时档** | dotnet 宿主 → OneCore | <1s | 本地兜底、按需切换 |
| **高质量档（v0.0.1 默认）** | edge-playback 流式批 | 2~3s/批 | 默认朗读（音质接近真人） |
| **缓存档（下一迭代）** | 预合成 mp3/wav → 播放 | 0s（二次起） | 批间间隔归零（播放批 i 时后台预合成批 i+1） |

- **批提交（v0.0.1 实测定型）**：edge 档**不逐句起进程**（每句 2~3s 首音导致句间割裂），而是攒 3 句或 120 字一批、一次 `edge-playback` 进程流式朗读——批内由服务端连续合成无缝衔接，首音只在批头（段落级停顿，听感 ≈ 自然呼吸）。onecore 档仍逐句（本地合成快，间隔可忽略）
- **标题合并**：markdown 标题行清洗后与下文连成一句，消除"标题 → 正文"的明显停顿（实测痛点）
- **降级链**：edge 批失败 → 逐句自动降级 OneCore 即时档，对话不受影响

### 5.7 异常处理

- 进程失败（退出码非 0 / 超时）→ 静默跳过该句/批，不打扰对话；edge 失败按批逐句降级 onecore
- 插件整体异常 → 不影响 DSH 主流程（cordis fiber 隔离）
- 朗读卡死防护：单句合成 30s / 播放 180s 超时强制 kill
- 打断：`child.kill()` + `taskkill /PID <pid> /T /F` 杀进程树（edge-playback 内部还有播放子进程）+ 代数递增使 in-flight 步骤失效

### 5.8 非文本清洗管线（v0.0.1 实测，解决"机械式朗读"）

用户实测痛点：长英文串（URL/路径/哈希/驼峰标识符）与非文字符号（表格线、emoji、连续符号）会被 TTS 逐字符机械朗读。v0.0.1 在切句前执行 **10 层顺序敏感管线**（`src/splitter.ts`）：

| # | 规则 | 处理 |
|---|---|---|
| ① | ` ``` ` 代码围栏 | 整段剔除（状态机，可跨 chunk） |
| ② | 行内代码 | 剔除 |
| ③ | `[文字](url)` 链接 | 只留文字；纯数字角标整组删 |
| ④ | 裸 URL | 删 |
| ⑤ | emoji | 删 |
| ⑥⑦ | 箭头、表格竖线 | 变空格（表格退化为词序列） |
| ⑧ | 3+ 连续符号（`---` `===`） | 删 |
| ⑨ | 长 token（≥16 字符：含路径分隔/大小写混合/24+ 字符字母数字） | 删（`state-of-the-art` 类复合词保留） |
| ⑩ | ≥10 位数字串（时间戳/ID） | 删 |

再加：标题行与下文合并（5.6）、行首装饰符清理、句子级过滤（空白压缩 + <2 个字母数字整句丢弃）。10 组样本自测全部通过（`D:\DS-Task\.scratch\test-splitter.mjs`）。

---

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| ~~插件进程拿不到完整权限 → SAPI 初始化失败~~ | ~~高~~ **已化解** | v0.0.1 实测：DSH host 进程本身是完整权限用户会话进程，dotnet 宿主 + edge-playback 子进程全部正常运行（OneCore/edge 双链路已实测出声） |
| ~~Node 子进程命名管道限制~~ | ~~中~~ **已化解** | 插件统一 `stdio: 'ignore'`（不捕获输出），spawn 全部成功 |
| 朗读拖慢/干扰对话体验 | 中 | 队列丢弃策略 + 一键静音 + 批提交（已实施） |
| 中英文混排朗读生硬 | 低 | 第一版接受；后续按语言分段选音色 |
| 长回答朗读时间过长 | 低 | 用户随时可打断；后续可加"摘要模式"（只读结论段） |
| 与其它发声插件冲突 | 低 | 单例队列，可加互斥配置（后续） |
| **非文本机械式朗读（实测发现）** | ~~未预见~~ **已化解** | 10 层清洗管线（5.8），10 组样本自测通过 |
| **句间间隔割裂（实测发现）** | ~~未预见~~ **已缓解** | 批提交 + 标题合并（5.6）；彻底方案 = 预合成管线（下一迭代） |

---

## 7. 开发计划（✅ = 已完成，见文末开发记录）

### 阶段 0：骨架与注入 ✅（2026-08 完成）
- `dev_scaffold_plugin` 生成 daemon-loop 形态（`dsh-read-aloud`）
- 构建/注入链路踩坑与修复：WSL bash 探测（USERPROFILE/挂载）、npx cache 形态 checkout、tsc.js 定位（pnpm 布局）、scoped 包名（`@deepseek-ai/cordis` 等）——全部沉淀在 `AGENTS.md`

### 阶段 1：朗读链路打通 ✅
- 事件订阅：`session/event` 火线 → 过滤主会话 + `text-delta`（**实测修正**：非 `ctx.on('assistant/chunk')`，见 3.1）
- 切句 + 清洗管线 + 队列 + dotnet 宿主/edge-playback 双引擎
- 验证：正常对话逐句朗读（慧慧/晓晓双引擎均实测出声）

### 阶段 2：控制与健壮性 ✅
- 关键词控制：停/继续/静音/切引擎（≤30 字符才判定防误触发）
- 超时 kill、失败静默、队列丢弃、进程树打断、降级链

### 阶段 3：高质量模式 ✅ 部分
- ✅ edge-tts 流式档（批提交）+ 断网自动降级 OneCore + 引擎关键词切换
- ⏳ 预合成管线（批间间隔归零）
- ⏳ UI 开关（hybrid 形态 + client 面板）
- ⏳ 中英文自动切换音色

### 验收标准（MVP 完成定义）
1. 安装注入后，正常对话中 DeepSeek 正文被逐句中文朗读 ✅
2. 说"停止朗读"立即安静，说"继续朗读"恢复 ✅
3. 引擎失败时不报错、不影响对话（静默降级）✅
4. 卸载插件（`dev_uninject_plugin`）后无残留 ✅

---

## 8. 开放问题（已拍板）

1. **默认状态** → ✅ 默认自动朗读 + 关键词控制（与"发声授权"理念一致：插件开关即授权）
2. **朗读范围** → ✅ 只读正文 `text-delta`（用户拍板：不读思维链）
3. **中文为主还是中英都重要** → 中文为主；清洗管线保留正常英文单词；自动按语言切音色留后续
4. **是否需要 UI 开关** → 第一版纯关键词控制（daemon-loop 形态）；UI 面板留后续

---

## 9. 附录：关键技术引用（源码位置）

| 材料 | 位置 |
|------|------|
| `assistant/chunk` 事件定义 | `node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts`（L264） |
| `session/event` 火线与信封 | `node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts`（L32-76：Events 接口；L66 火线签名） |
| `SessionHeader.origin/delegationDepth`（主会话识别） | `node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts`（L60-77） |
| `StreamChunk` 流协议 | `node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts`（L267） |
| DSH 插件形态/构建 | `dev_scaffold_plugin` / `dev_build_plugin` / `dev_inject_plugin` / `dev_reload_package` 工具链 |
| win-notification skill（语音范式） | `~/.dsh/skills/win-notification/SKILL.md` |
| **OneCore 语音宿主（已就绪，源码+产物随插件 vendor 提交）** | `D:\DS-Task\.scratch\onecore-host`（dotnet 9 源码）；产物在 `vendor/onecore-host/` |
| **edge-tts 工具（已就绪）** | `C:\Users\17151\.local\bin\edge-tts.exe` / `edge-playback.exe`（uv tool 安装，**参数必须 -t/-v**）；`ffplay.exe`（Gyan.FFmpeg 8.1.2，WinGet 安装） |
| 沙箱命名管道限制记录 | `~/.dsh/skills/github-connect/SKILL.md`（诊断表） |
| **项目本体（工作区）** | `D:\A-DSH\TTS-LLM-ASR\dsh-read-aloud\`（src/scripts/vendor/docs/AGENTS.md/README.md） |
| **novel-workbench 注入先例（super-injector 通道）** | `D:\ds\novel-workbench\plugin\`（@dsh-external/dsh-novel-workbench，client 端流式取数用 `useSession` partial） |

---

## 10. 开发记录（2026-08，按时间序）

1. **事件源修正**：实测发现 `assistant/chunk` 不直接广播，真实通道 = `session/event` 火线（信封 `{type,seq,time,data}`）；只读主会话（`origin !== 'subagent'`）；火线只推实时 append（历史零过滤）。
2. **构建链路踩坑**：dev_build_plugin 内 bash 为 WSL（HOME=/root）→ build.sh 探测改 USERPROFILE/挂载多级；checkout 为 npx cache 形态（无 packages/、无根 typescript）→ tsc.js 从任意 cache 定位；依赖全部 scoped 包名（`@deepseek-ai/cordis` 等）。
3. **运行时零第三方依赖**：cordis/dsh-session 均 type-only；Config 用纯常量 DEFAULTS（无 schemastery）→ 规避宿主 node_modules 差异。
4. **edge 档静默失败 bug**：edge-playback 不接受位置参数（必须 `-t 文本 -v 音色`），首版一直静默降级 onecore；修复后实测晓晓流式出声（exit 0）。
5. **句间割裂 → 批提交 + 标题合并**：3 句/120 字一批流式（批内无缝），标题行并入下文；听感确认 OK。
6. **非文本机械朗读 → 10 层清洗管线**：URL/路径/哈希/代码/表格线/emoji/长数字等按序剔除；10 组样本自测通过。
7. **项目迁入工作区** `D:\A-DSH\TTS-LLM-ASR\dsh-read-aloud\`，junction 重建；AGENTS.md/README 落库。
8. **GitHub 公开仓库**：`git init` + `gh repo create --public` + 推送（走本机代理通道，见 github-connect skill）。

---

*本文档随调研进展更新；开发启动时以此为准，实测偏差就地修正。*
