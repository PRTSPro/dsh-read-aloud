/**
 * @dsh-external/dsh-read-aloud — 对话实时朗读插件。
 *
 * 订阅 session/event 火线（dsh-session 的 append 广播）：
 * - assistant/chunk 的 text-delta → 逐句切分 → OneCore 宿主合成 + ffplay 播放
 * - 仅读主会话（origin !== 'subagent'），不读 reasoning-delta（思维链）
 * - 关键词控制：别读了/停止/静音 ↔ 继续朗读/恢复
 * - 一切失败静默降级，不影响对话主流程
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { SentenceSplitter } from './splitter.js'
import { Speaker, type Engine } from './speaker.js'

export const name = '@dsh-external/dsh-read-aloud'
export const inject: string[] = []

export interface Config {
  voice: string
  rate: number
  hostExe: string
  ffplay: string
  maxQueue: number
  maxSentenceLen: number
  logFile: string
  engine: Engine
  edgeVoice: string
  edgeRate: string
  edgePlayback: string
  fallbackToLocal: boolean
}

/** 默认配置（无 UI 配置面板时生效；后续 hybrid 形态再引入 schema） */
const DEFAULTS: Config = {
  voice: 'Huihui',
  rate: 1,
  hostExe: '',
  ffplay: 'ffplay',
  maxQueue: 8,
  maxSentenceLen: 200,
  logFile: '',
  engine: 'edge',
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  edgeRate: '+0%',
  edgePlayback: '',
  fallbackToLocal: true,
}

const SHORT = 'dsh-read-aloud'

/** 控制关键词：短消息（≤30 字符）才判定，防正常对话误触发。 */
const STOP_RE = /(别读了|不要读了|别念了|停止朗读|停止播报|闭嘴|安静|停下|静音|mute|stop reading|^stop$|^pause$)/i
const RESUME_RE = /(继续朗读|接着读|恢复朗读|开始朗读|继续播报|接着念|resume|continue reading)/i
/** 引擎切换：edge-tts 高质量流式 ↔ 本地 OneCore 即时 */
const EDGE_RE = /(用晓晓|用晓伊|用云希|用云健|用云端|edge|高质量|自然音色|换音色)/i
const LOCAL_RE = /(用本地|用慧慧|用康康|用瑶瑶|即时档|onecore|本地音色)/i

interface Reader {
  splitter: SentenceSplitter
  lastTurn: number
}

export function apply(ctx: Context, raw?: Partial<Config>): void {
  const config: Config = { ...DEFAULTS, ...(raw ?? {}) }
  const logFile = config.logFile || join(homedir(), '.dsh', 'super-injector', SHORT + '.log')
  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch {
      /* 日志失败静默 */
    }
  }

  const speaker = new Speaker({
    voice: config.voice,
    rate: config.rate,
    hostExe: config.hostExe,
    ffplay: config.ffplay,
    maxQueue: config.maxQueue,
    engine: config.engine,
    edgeVoice: config.edgeVoice,
    edgeRate: config.edgeRate,
    edgePlayback: config.edgePlayback,
    fallbackToLocal: config.fallbackToLocal,
    log,
  })

  /** 每会话一个缓冲；key = session id */
  const readers = new Map<string, Reader>()

  const readerFor = (session: Session): Reader => {
    let r = readers.get(session.id)
    if (!r) {
      r = { splitter: new SentenceSplitter(config.maxSentenceLen), lastTurn: -1 }
      readers.set(session.id, r)
    }
    return r
  }

  const out = (sentence: string): void => {
    if (sentence.trim()) speaker.speak(sentence.trim())
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    // 只读主会话：子代理（subagent）会话静默
    if (session.header.origin === 'subagent') return

    switch (event.type) {
      case 'assistant/chunk': {
        const { turn, chunk } = event.data
        const reader = readerFor(session)
        // 跨 turn 隔离：新 turn 开始前冲刷旧 turn 余句
        if (turn !== reader.lastTurn) {
          reader.splitter.flush(out)
          reader.lastTurn = turn
        }
        if (chunk.type === 'text-delta') {
          // 仅朗读正常输出；reasoning-delta（思维链）与工具调用一律不读
          reader.splitter.push(chunk.text, out)
        }
        // chunk.type === 'finish'：不冲刷——同 turn 内可能有后续 step 继续输出
        break
      }
      case 'turn/end': {
        // 一轮收尾：冲刷余句（幂等）
        readerFor(session).splitter.flush(out)
        break
      }
      case 'user/message': {
        const msg = event.data
        // 仅响应人类直接输入（agent.inject 等合成消息不判定）
        if (msg.source.kind !== 'user') return
        const text = (msg.content as Array<{ type?: string; text?: string }>)
          .map((b) => (b && b.type === 'text' ? (b.text ?? '') : ''))
          .join('')
          .trim()
        if (!text || text.length > 30) return
        if (STOP_RE.test(text)) {
          log('control: STOP ← ' + text)
          speaker.stop()
        } else if (RESUME_RE.test(text)) {
          log('control: RESUME ← ' + text)
          speaker.resume()
        } else if (EDGE_RE.test(text)) {
          log('control: ENGINE→edge ← ' + text)
          speaker.setEngine('edge')
        } else if (LOCAL_RE.test(text)) {
          log('control: ENGINE→onecore ← ' + text)
          speaker.setEngine('onecore')
        }
        break
      }
      default:
        break
    }
  })

  // 插件卸载：释放队列与子进程（cordis effect disposer 机制）
  ctx.effect(() => {
    return () => {
      speaker.dispose()
      log('disposed')
    }
  }, 'dsh-read-aloud: dispose')

  log('read-aloud ready | engine=' + config.engine + ' voice=' + config.voice + ' rate=' + config.rate + ' edgeVoice=' + config.edgeVoice + ' maxQueue=' + config.maxQueue)
  ctx.logger?.info?.('[' + name + '] 朗读插件已就绪（仅读正文，不读思维链；engine=' + config.engine + '）')
}
