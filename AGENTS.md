# AGENTS.md — dsh-read-aloud 开发指引

本文件供在此工作区工作的 Agent（人与 AI）阅读。改动代码前先读完本文件。

## 一句话

`@dsh-external/dsh-read-aloud` 是 DeepSeek Harness（DSH）的 **hybrid 插件**（host 朗读引擎 + client 对话栏按钮）：监听当前会话的流式输出，把 **assistant 正常输出**（`text-delta`）逐句清洗后朗读，**不读思维链**（`reasoning-delta`）、不读工具调用、不读子代理会话；对话输入栏左侧提供**朗读开关小图标按钮**（朗读中动态波动，点击开关）。

## 目录结构

```
dsh-read-aloud/
├── src/
│   ├── index.ts        # host 入口：session/event 订阅、控制词、webServer RPC 装配
│   ├── splitter.ts     # 句子切分 + 10 层非文本清洗管线
│   ├── speaker.ts      # FIFO 队列 + 双引擎执行层（onecore / edge）+ 降级链 + speaking 状态
│   └── client/
│       └── index.ts    # client UI：conversation.input.left 朗读开关按钮（纯 JS body 镜像）
├── scripts/build.sh          # WSL bash 构建 host：探测 checkout → 链接 scoped 包 → node tsc.js
├── scripts/build-client.mjs  # client 构建：抽取 src/client/index.ts 的 __mirror body → lib/client.js
├── vendor/onecore-host/  # dotnet 9 OneCore 合成宿主（构建产物，随库提交）
├── docs/dsh-read-aloud-idea.md  # 调研 idea 文档（含全部实测结论）
├── package.json / tsconfig.json  # dsh.client 声明 + exports['./client'] + build:client 脚本
└── lib/              # 构建产物（index.js host + client.js bundle；勿手改；git 忽略）
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
5. **双引擎（统一"合成到文件 → ffplay 播放"两段式）**：
   - `onecore`：`vendor/onecore-host/onecore-host.exe <voiceSubstr> <text> <wav> [rate]` 合成 → `ffplay -nodisp -autoexit` 播放。合成 <1s。
   - `edge`：**`edge-tts.exe -t <text> -v <voice> [--rate] --write-media <file>`** 合成 mp3 → ffplay 播放。**必须用 edge-tts（纯合成不播放）；edge-playback 会保存后自播（双音）且不支持预合成，不可作合成器**（2026-08-17 实测）。
   - 降级链：edge 合成失败 → 逐句回落 onecore（`fallbackToLocal`），降级前/中校验代数防静音后回响。
6. **清洗管线**（`splitter.ts`，顺序敏感）：代码围栏 → 行内代码 → markdown 链接（角标整组删）→ 裸 URL → emoji → 箭头/竖线 → 3+ 连续符号 → 长 token（`isJunkToken` 判定，`state-of-the-art` 这类复合词保留）→ 10+ 位数字串 → 行首装饰符。**标题行与下文合并**（不单独成句）。句子级过滤：<2 个字母数字整句丢弃。
7. **运行时零第三方依赖**：`cordis`/`dsh-session` 均为 `import type`（编译后擦除）；无 schemastery 运行时依赖（Config 是纯常量 DEFAULTS）。这规避了宿主 node_modules 缺失问题——不要重新引入运行时 import。
8. **打断**：`stop()` = 清队列 + 清预合成缓冲 + `child.kill()` + `taskkill /PID /T /F`（杀进程树）+ generation 代数递增使 in-flight 失效。**只 kill 播放进程**（trackCurrent=true 的 ffplay）；合成进程短命（≤30s 超时）且结果由代数校验丢弃，不打断。
9. **日志**：`~/.dsh/super-injector/dsh-read-aloud.log`（验证 fiber 状态与朗读触发的第一手段）。
10. **预合成管线（批间无停顿）**：`pump()` 播放批 i 时后台预合成批 i+1——`requestSynth`（按文本复用 in-flight 任务，防双合成）+ `synthChain` 串行链（同时只跑一个合成进程）+ 双文件槽轮换（`tmpdir/dsh-ra-slot-0/1`，无扩展名 ffplay 内容探测；合成写入槽 ≠ 播放槽）。实测：3 句一批合成 4s、播放 8.4s——合成耗时被播放覆盖。首批仍要等合成（~4s），之后批间无缝。
11. **speaking 状态（UI 动画驱动）**：`Speaker` 持有 `paused`（静音）与 `speaking`（正在出声）双布尔；**speaking 仅覆盖播放阶段**（合成不算出声），`pump()` 播放前后置位，`stop()/resume()/setEngine()` 同步更新并触发 `onState` 回调。UI 走 300ms 轮询 RPC `state`，不依赖推送。
12. **状态持久化**：`~/.dsh/super-injector/dsh-read-aloud-state.json` 存 `{ muted, engine }`。apply 时读取恢复（Speaker 构造传 `paused`/engine），`onState` 回调里**差异写盘**（仅 muted/engine 变化时写，speaking 高频变化不落盘）。
13. **对话栏按钮（client 半）**：注册于 `conversation.input.left` slot（list，`id: 'read-aloud-toggle'`，order 20）。三态：待命=喇叭+声波弧（品牌色 `--dsw-alias-brand-primary`）/ 朗读中=喇叭呼吸+三根音量条 CSS 波动（`.ra-wave-bar`，`prefers-reduced-motion` 降级）/ 已关闭=喇叭+斜线（灰、半透明）；host RPC 不可达降透明（offline 兜底）。CSS 以 `<style>` 元素挂组件树内，随组件卸载自动清理。
14. **host↔client RPC 契约**：host 注册 webServer 前缀路由 `/@dsh-external/dsh-read-aloud/api`（`kind: 'prefix'`，挂 `ctx.effect`）。端点：`state`（GET/POST，返回 `{ muted, speaking, engine, queue }`）、`toggle`（静音↔恢复，同关键词状态机）、`stop`、`resume`。响应信封 `{ ok, result }`；client 端 `host.call(name, args)` = fetch POST。**关键词控制与按钮走同一套 `stop()/resume()`**——二者完全等价。
15. **client 骨架铁律（改 UI 源必读）**：`src/client/index.ts` 是"镜像文件"——顶层 `export const inject = ['slots','timer']` + `const __mirror = (function(){ return { name, inject, apply } })()`；**`__mirror` body 必须是纯 JS（无 TS 注解）**；`slots.register({ name: 'conversation.input.left', ... })` 的 slot 名**必须写字面量**（注入器 `clientSkeletonProblems` 按字面量锚点预检）。改 UI 后必须 `dev_build_plugin`（会跑 `build:client` 重新生成 `lib/client.js`；过期产物会被注入器预检拦截）。

## 开发流程规范（每轮任务收尾必做）

**每完成一轮任务（改代码/修 bug/升级功能/更新文档），必须提交 git 并推送到远程。**

```text
1. 更新 AGENTS.md / README.md（本轮做了什么、架构事实是否有变化）
2. git add -A && git commit -m "<本轮变更摘要>"
3. git push origin <当前分支>
4. 确认推送成功（git status 干净 / git log -1 查看提交）
```

- 仓库：本目录即 git 仓库（remote `origin` = https://github.com/PRTSPro/dsh-read-aloud.git）。
- 提交纪律：产物不入库——`lib/`、`*.tgz`、`node_modules/` 已在 .gitignore；只提交 `src/`、`scripts/`、文档、`package.json`、`tsconfig.json` 等源码与配置。
- 推送网络：本机 GitHub 走 Clash Verge 代理 127.0.0.1:7897（git 全局已配 `http.proxy` + `http.sslBackend=openssl`，无需额外参数）；直连 HTTPS 会被 TLS 重置，勿尝试。
- 提交信息风格：`<类型>: <一句话>`（如 `feat: 预合成管线消除批间停顿`、`docs: 记录开发流程规范`）。

## 构建 / 注入 / 热重载（DSH 注入器工具，由 agent 调用）

```text
改代码 → dev_build_plugin {"dir": "<本目录>"}      # ① WSL bash 跑 scripts/build.sh（host tsc）
                                                  # ② npm run build:client（build-client.mjs → lib/client.js）
                                                  # ③ npm pack → tgz
      → dev_reload_package {"packageName": "dsh-read-aloud"}   # 热重载（免重注入）
```

- 重载返回必须看到 `client ✓ (lib/client.js)`；若报 `client ✗`，先查 `clientStatus` 报错路径。
- **client-modules pkgMeta 负缓存**（2026-08-17 踩坑）：包在**未声明 dsh.client** 时被扫描过 → `clientModules.pkgMeta` 缓存 null（进程级永久）→ 补上 client 声明后重载仍报 client ✗。注入器 `refreshClientRow` 已加清缓存自愈（无需人工处理）；若再次遇到，检查 `D:\DS-Task\injector-release\lib\index.js` 的该函数是否被回退。
- 已注入状态：junction `C:\Users\17151\.dsh\profiles\web\node_modules\@dsh-external\dsh-read-aloud` → 本目录。
- 重新注入：`dev_uninject_plugin {"match": "dsh-read-aloud"}` → `dev_inject_plugin {"dir": "<本目录>"}`。
- 检查状态：`dev_plugin_status`（找 `@dsh-external/dsh-read-aloud [injected]`）+ 读日志文件尾部。
- 浏览器页面：client bundle 经 HMR 联动，但**新增 UI 后需刷新一次页面**才能看到按钮（首装场景）。

### build.sh 环境坑（已踩平，勿回退）

- dev_build_plugin 内 bash 是 **WSL**（`HOME=/root`，无 USERPROFILE）；探测用户目录顺序：`USERPROFILE → HOME → /mnt/c/Users/* → /c/Users/*`。
- checkout 探测：源码形态（`packages/`）→ npx cache 形态（`node_modules/@deepseek-ai/dsh-session`），优先 hash `1e7f6d9597241db0`（本机运行中的 harness）。
- tsc 定位：checkout 内无 typescript（pnpm 布局），从**任意 npx cache** 找 `node_modules/typescript/lib/tsc.js`，用 `node tsc.js` 跑（绕开 .bin interop）。
- 依赖链接用 **scoped 包名**（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-session`…）。WSL 建的是 Linux symlink，Windows 侧无效属正常（仅编译期用；运行时零第三方依赖所以无所谓）。
- `set -euo pipefail` 下 `find | head` 管道会静默退出——管尾必须 `|| true`。

## 验证方式

- 切句/清洗自测：`node D:\DS-Task\.scratch\test-splitter.mjs`（样例脚本，可追加用例；也可放 `.scratch` 下）。
- 端到端：插件生效期间让模型回复，读日志确认 `read-aloud ready`（含 muted 恢复态）/ `engine switched` / `edge synth failed` 降级记录；听感由用户确认（预合成后批间应无停顿）。
- RPC 冒烟（host 半）：`Invoke-RestMethod -Uri 'http://127.0.0.1:3080/@dsh-external/dsh-read-aloud/api/state' -Method Post -ContentType 'application/json' -Body '{}'` → 应返回 `{ ok: true, result: { muted, speaking, engine, queue } }`；`toggle` 应翻转 muted 并打断播放；**toggle 后检查 `~/.dsh/super-injector/dsh-read-aloud-state.json` 已更新**。
- client 半验证：`dev_reload_package` 返回 `client ✓ (lib/client.js)`；浏览器刷新后输入栏左侧出现喇叭按钮；朗读中图标波动；点击切换。
- 合成链路裸测：`edge-tts.exe -t 测试 -v zh-CN-XiaoxiaoNeural --write-media <tmp>` 应 exit 0 且文件 >0 字节（**合成不发声**）；`ffplay -nodisp -autoexit <tmp>` 应出声且 exit 0。
- 预合成时序参考：3 句一批合成 ~4s、播放 ~8.4s——播放可覆盖合成，批间无缝成立。

## 已知限制（当前版本）

- 只读实时流（不读历史）；多顶层会话同时朗读会叠加（罕见场景）。
- **首批仍需等合成（~4s）**才出声；之后批间无缝（预合成管线）。
- edge-tts 依赖网络（微软在线服务）；断网自动降级 onecore（fallbackToLocal）。
- 表格退化为连续词朗读；超长句按 200 字强制切。
- 关键词控制依赖用户消息文本，长消息内的控制词会被忽略（防误触发）。
- 按钮/静音/引擎状态已持久化（state.json），但设置项（音色/语速/默认引擎）仍为代码常量 DEFAULTS。
