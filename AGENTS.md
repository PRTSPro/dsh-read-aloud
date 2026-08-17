# AGENTS.md — dsh-read-aloud 开发指引

本文件供在此工作区工作的 Agent（人与 AI）阅读。改动代码前先读完本文件。

## 一句话

`@dsh-external/dsh-read-aloud` 是 DeepSeek Harness（DSH）的宿主端插件：监听当前会话的流式输出，把 **assistant 正常输出**（`text-delta`）逐句清洗后朗读，**不读思维链**（`reasoning-delta`）、不读工具调用、不读子代理会话。

## 目录结构

```
dsh-read-aloud/
├── src/
│   ├── index.ts      # 插件入口：session/event 订阅、控制词、装配
│   ├── splitter.ts   # 句子切分 + 10 层非文本清洗管线
│   └── speaker.ts    # FIFO 队列 + 双引擎执行层（onecore / edge）+ 降级链
├── scripts/build.sh  # WSL bash 构建：探测 checkout → 链接 scoped 包 → node tsc.js
├── vendor/onecore-host/  # dotnet 9 OneCore 合成宿主（构建产物，随库提交）
├── docs/dsh-read-aloud-idea.md  # 调研 idea 文档（含全部实测结论）
├── package.json / tsconfig.json
└── lib/              # 构建产物（勿手改；git 忽略）
```

## 核心架构事实（Hub，勿各自重建）

1. **事件源是 `session/event` 火线，不是 `ctx.on('assistant/chunk')`**。
   `ctx.on('session/event', (session, event) => ...)`；`event` 是信封 `{ type, seq, time, data }`；
   `event.type === 'assistant/chunk'` 时 `event.data = { turn, step, chunk }`。
   类型：`import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'`。
2. **只读主会话**：`session.header.origin === 'subagent'` 直接 return。
3. **只读 `chunk.type === 'text-delta'`**；`reasoning-delta` / `tool-call-delta` 一律跳过。
   `finish` 不冲刷（同 turn 多 step 连续输出）；跨 turn 与 `turn/end` 时冲刷缓冲。
4. **控制词**：来自 `user/message` 事件，仅 `source.kind === 'user'` 且消息 ≤ 30 字符才判定
   （防正常对话误触发）。停/继续/切引擎三组正则见 `src/index.ts` 顶部。
5. **双引擎**：
   - `onecore`：`vendor/onecore-host/onecore-host.exe <voiceSubstr> <text> <wav> [rate]` 合成 → `ffplay -nodisp -autoexit` 播放。首音 <1s。
   - `edge`：`edge-playback -t <text> -v <voice>`（**必须 -t/-v，位置参数会失败**，已实测）。批提交：攒 3 句或 120 字一批（`EDGE_BATCH_SENTENCES` / `EDGE_BATCH_CHARS`），批内无缝。首音 2~3s/批。
   - 降级链：edge 批失败 → 逐句回落 onecore（`fallbackToLocal`）。
6. **清洗管线**（`splitter.ts`，顺序敏感）：代码围栏 → 行内代码 → markdown 链接（角标整组删）→ 裸 URL → emoji → 箭头/竖线 → 3+ 连续符号 → 长 token（`isJunkToken` 判定，`state-of-the-art` 这类复合词保留）→ 10+ 位数字串 → 行首装饰符。**标题行与下文合并**（不单独成句）。句子级过滤：<2 个字母数字整句丢弃。
7. **运行时零第三方依赖**：`cordis`/`dsh-session` 均为 `import type`（编译后擦除）；无 schemastery 运行时依赖（Config 是纯常量 DEFAULTS）。这规避了宿主 node_modules 缺失问题——不要重新引入运行时 import。
8. **打断**：`stop()` = 清队列 + `child.kill()` + `taskkill /PID /T /F`（杀进程树，edge-playback 内部有子进程）+ generation 代数递增使 in-flight 失效。
9. **日志**：`~/.dsh/super-injector/dsh-read-aloud.log`（验证 fiber 状态与朗读触发的第一手段）。

## 构建 / 注入 / 热重载（DSH 注入器工具，由 agent 调用）

```text
改代码 → dev_build_plugin {"dir": "<本目录>"}      # WSL bash 跑 scripts/build.sh + npm pack
      → dev_reload_package {"packageName": "dsh-read-aloud"}   # 热重载（免重注入）
```

- 已注入状态：junction `C:\Users\17151\.dsh\profiles\web\node_modules\@dsh-external\dsh-read-aloud` → 本目录。
- 重新注入：`dev_uninject_plugin {"match": "dsh-read-aloud"}` → `dev_inject_plugin {"dir": "<本目录>"}`。
- 检查状态：`dev_plugin_status`（找 `@dsh-external/dsh-read-aloud [injected]`）+ 读日志文件尾部。

### build.sh 环境坑（已踩平，勿回退）

- dev_build_plugin 内 bash 是 **WSL**（`HOME=/root`，无 USERPROFILE）；探测用户目录顺序：`USERPROFILE → HOME → /mnt/c/Users/* → /c/Users/*`。
- checkout 探测：源码形态（`packages/`）→ npx cache 形态（`node_modules/@deepseek-ai/dsh-session`），优先 hash `1e7f6d9597241db0`（本机运行中的 harness）。
- tsc 定位：checkout 内无 typescript（pnpm 布局），从**任意 npx cache** 找 `node_modules/typescript/lib/tsc.js`，用 `node tsc.js` 跑（绕开 .bin interop）。
- 依赖链接用 **scoped 包名**（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-session`…）。WSL 建的是 Linux symlink，Windows 侧无效属正常（仅编译期用；运行时零第三方依赖所以无所谓）。
- `set -euo pipefail` 下 `find | head` 管道会静默退出——管尾必须 `|| true`。

## 验证方式

- 切句/清洗自测：`node D:\DS-Task\.scratch\test-splitter.mjs`（样例脚本，可追加用例；也可放 `.scratch` 下）。
- 端到端：插件生效期间让模型回复，读日志确认 `read-aloud ready` / `engine switched` / 降级记录；听感由用户确认。
- edge 链路裸测：`C:\Users\17151\.local\bin\edge-playback.exe -t 测试 -v zh-CN-XiaoxiaoNeural`（应出声且 exit 0）。

## 已知限制（当前版本）

- 只读实时流（不读历史）；多顶层会话同时朗读会叠加（罕见场景）。
- 批间仍有 2~3s 首音（段落级停顿）；彻底方案是预合成管线（播放批 i 时后台预合成批 i+1），见 idea 文档 5.6。
- 表格退化为连续词朗读；超长句按 200 字强制切。
- 关键词控制依赖用户消息文本，长消息内的控制词会被忽略（防误触发）。
