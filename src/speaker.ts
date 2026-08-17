/**
 * 朗读执行层：FIFO 单消费者队列 + 预合成双缓冲管线。
 * 两档引擎（统一"合成到文件 → ffplay 播放"两段式）：
 *   onecore —— dotnet OneCore 宿主合成 wav → ffplay 播放（本地即时，<1s 合成）
 *   edge    —— edge-tts --write-media 合成 mp3 → ffplay 播放（音质接近真人）
 * - 预合成管线：播放批 i 时后台合成批 i+1（双文件槽轮换，合成进程串行），
 *   批间无停顿——合成耗时被播放时长覆盖（合成器不再堵播放器）。
 * - edge 合成失败自动逐句降级 onecore（fallbackToLocal；降级前校验代数防静音后回响）
 * - 队列积压超限丢新句（跟读模式：宁可漏不可积压）
 * - 打断（stop）：清队列 + kill 播放进程树 + 代数递增使 in-flight 失效
 *   （合成进程短命且结果会被代数校验丢弃，不打断）
 * - 一切失败静默降级：日志记录，不影响对话
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export type Engine = 'onecore' | 'edge'

export interface SpeakerOptions {
  voice: string
  rate: number
  hostExe: string
  ffplay: string
  maxQueue: number
  engine: Engine
  edgeVoice: string
  edgeRate: string
  /** edge-tts 可执行（纯合成不播放）。edge-playback 会保存后自播（双音），不可作合成器。 */
  edgeTts: string
  fallbackToLocal: boolean
  /** 初始静音态（持久化恢复） */
  paused?: boolean
  log: (msg: string) => void
  /** 状态变化回调（paused/speaking/engine 任一变化即触发；供 UI RPC 轮询侧留痕） */
  onState?: () => void
}

/** 面向 UI 的只读快照（纯 JSON 标量，可直接过 RPC）。 */
export interface SpeakerState {
  paused: boolean
  speaking: boolean
  engine: Engine
  queueLength: number
}

/** 句子来源元数据（用于朗读进度高亮定位所属会话/turn）。 */
export interface SentenceMeta {
  sessionId?: string
  turn?: number
}

/** 当前朗读位置（供 UI 轮询 → turn 尾指示条）。 */
export interface ReadingState {
  sessionId: string
  turn: number
  sentences: string[]
  index: number
  speaking: boolean
}

/** 中文朗读语速估算（字/秒），用于批内进度比例。 */
const CHARS_PER_SECOND = 4.5

const SYNTH_TIMEOUT_MS = 30_000
const PLAY_TIMEOUT_MS = 180_000
/**
 * 批提交粒度：攒 6 句或 180 字一批。
 * 2026-08-17 实测校准：edge-tts 合成固定成本 ~4s/批（含 python 进程启动），
 * 播放约 4-5 字/s——批过小（3 句短句只播 2~3s）预合成追不上 → 批间露间隔。
 * 6 句/180 字保证每批播放 ≥6s > 合成 4s，预合成总能提前完成。
 */
const BATCH_SENTENCES = 6
const BATCH_CHARS = 180

/** 一批待朗读文本：text=拼接全文（整批合成用），sentences=原句（降级逐句用），meta=来源定位。 */
interface Batch {
  text: string
  sentences: string[]
  meta: SentenceMeta
}

export class Speaker {
  private queue: Array<{ text: string; meta: SentenceMeta }> = []
  private pumping = false
  private paused: boolean
  private disposed = false
  private engine: Engine
  /** 打断代数：stop() 递增，in-flight 步骤醒来后发现代数不符即放弃。 */
  private generation = 0
  /** 正在出声（播放阶段）——驱动 UI 波动动画。 */
  private speaking = false
  /** 当前播放进程（可打断；合成进程短命不在此跟踪，防误杀与引用覆盖） */
  private current: ChildProcess | null = null
  private hostPath: string
  private ffplayPath: string
  private edgeTtsPath: string
  /** 双文件槽（无扩展名，ffplay 内容探测；合成写入槽与播放槽轮换互斥） */
  private slotPaths = [join(tmpdir(), 'dsh-ra-slot-0'), join(tmpdir(), 'dsh-ra-slot-1')]
  private slotIndex = 0
  /** 预合成结果（下一批待播音频文件列表） */
  private prebuffer: { text: string; files: string[] } | null = null
  /** 合成中任务（按文本复用，避免同一批双合成） */
  private synthInFlight: { text: string; promise: Promise<string[] | null> } | null = null
  /** 合成串行链：同一时刻只跑一个合成进程 */
  private synthChain: Promise<void> = Promise.resolve()
  /** 当前朗读位置（播放中有效；供 UI 轮询 → turn 尾指示条） */
  private reading: {
    sessionId: string
    turn: number
    sentences: string[]
    chars: number[]
    estimatedTotalMs: number
    playStart: number
  } | null = null

  constructor(private readonly opts: SpeakerOptions) {
    this.engine = opts.engine
    this.paused = opts.paused ?? false
    this.hostPath = this.resolveHost()
    this.ffplayPath = opts.ffplay || 'ffplay'
    this.edgeTtsPath = this.resolveEdgeTts()
  }

  /** 尝试探测 OneCore 宿主：配置 > 插件 vendor > 已知 scratch 路径。 */
  private resolveHost(): string {
    const candidates = [
      this.opts.hostExe,
      join(PLUGIN_ROOT, 'vendor', 'onecore-host', 'onecore-host.exe'),
      'D:\\DS-Task\\.scratch\\onecore-host\\bin\\Debug\\net9.0-windows10.0.19041.0\\onecore-host.exe',
    ].filter(Boolean)
    for (const c of candidates) {
      if (existsSync(c)) {
        this.opts.log('host resolved: ' + c)
        return c
      }
    }
    this.opts.log('WARN: onecore-host.exe not found in any candidate path')
    return candidates[0] ?? ''
  }

  /** 探测 edge-tts：配置 > ~/.local/bin > PATH。 */
  private resolveEdgeTts(): string {
    const candidates = [
      this.opts.edgeTts,
      join(homedir(), '.local', 'bin', 'edge-tts.exe'),
      'edge-tts',
    ].filter(Boolean)
    for (const c of candidates) {
      if (c === 'edge-tts' || existsSync(c)) {
        this.opts.log('edge-tts resolved: ' + c)
        return c
      }
    }
    this.opts.log('WARN: edge-tts not found (edge tier disabled)')
    return ''
  }

  /** 切换引擎：打断当前播放、清队列、恢复。 */
  setEngine(engine: Engine): void {
    if (this.engine === engine || this.disposed) return
    this.engine = engine
    this.opts.log('engine switched to ' + engine)
    this.stop()
    this.paused = false
    this.notify()
    void this.pump()
  }

  /** 供 UI RPC 读取的只读快照（纯 JSON 标量）。 */
  getState(): SpeakerState {
    return { paused: this.paused, speaking: this.speaking, engine: this.engine, queueLength: this.queue.length }
  }

  /** 对话栏按钮开关：静音 ↔ 恢复。 */
  toggle(): SpeakerState {
    if (this.paused) this.resume()
    else this.stop()
    return this.getState()
  }

  private setSpeaking(v: boolean): void {
    if (this.speaking === v) return
    this.speaking = v
    this.notify()
  }

  private notify(): void {
    try {
      this.opts.onState?.()
    } catch {
      /* 回调异常静默 */
    }
  }

  speak(text: string, meta: SentenceMeta = {}): void {
    if (this.paused || this.disposed) return
    if (this.engine === 'edge' && !this.edgeTtsPath) {
      // edge 不可用且未启用降级时直接丢弃
      if (!this.opts.fallbackToLocal || !this.hostPath) return
    }
    if (this.queue.length >= this.opts.maxQueue) {
      // 队列满：丢队头（最旧句）保新句——跟读语义 = 跟上最新内容，
      // 而非丢新句（会让"读一半"——最新内容永久丢失，体验断裂）
      const dropped = this.queue.shift()
      this.opts.log('queue full(' + this.queue.length + '), dropping oldest: ' + String(dropped?.text ?? '').slice(0, 30))
    }
    this.queue.push({ text, meta })
    void this.pump()
  }

  /** 当前朗读位置（纯 JSON 标量，供 RPC → client 轮尾指示条）。 */
  getReading(): ReadingState | null {
    if (!this.reading || !this.speaking || this.disposed) return null
    const r = this.reading
    const elapsed = Date.now() - r.playStart
    const totalChars = r.chars.reduce((a, b) => a + b, 0)
    const pos = totalChars > 0 ? Math.min(totalChars, Math.max(0, (elapsed / Math.max(1, r.estimatedTotalMs)) * totalChars)) : 0
    let acc = 0
    let index = 0
    for (let i = 0; i < r.chars.length; i++) {
      acc += r.chars[i]
      if (acc >= pos) {
        index = i
        break
      }
      index = i
    }
    return { sessionId: r.sessionId, turn: r.turn, sentences: r.sentences, index, speaking: true }
  }

  /** 暂停并打断当前播放（关键词"别读了"/按钮关闭）。 */
  stop(): void {
    this.paused = true
    this.generation++
    this.queue = []
    this.clearPrebuffer()
    this.reading = null
    this.setSpeaking(false)
    this.killCurrent()
    this.opts.log('stopped')
    this.notify()
  }

  /** 恢复朗读（关键词"继续朗读"/按钮开启）。 */
  resume(): void {
    if (this.disposed) return
    this.paused = false
    this.opts.log('resumed')
    this.notify()
    void this.pump()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    // 清理残留槽文件（播放/合成中间态）
    for (const p of this.slotPaths) this.tryRm(p)
  }

  private clearPrebuffer(): void {
    if (this.prebuffer) {
      this.tryRmAll(this.prebuffer.files)
      this.prebuffer = null
    }
  }

  private killCurrent(): void {
    const c = this.current
    this.current = null
    if (!c) return
    try {
      c.kill()
    } catch {
      /* 进程可能已退出 */
    }
    // Windows：taskkill /T 确保子孙进程一并终止
    if (process.platform === 'win32' && c.pid) {
      try {
        spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        /* noop */
      }
    }
  }

  // ═══════════════ 预合成管线 ═══════════════

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.paused && !this.disposed && this.queue.length > 0) {
        const gen = this.generation
        const batch = this.takeBatch()
        // 1. 取音频：预合成命中直接播；未命中现合成（可能复用 in-flight 预合成任务）
        let files: string[] | null = this.takePrebuffer(batch.text)
        if (!files) {
          files = await this.requestSynth(batch, gen, false)
          if (gen !== this.generation) {
            this.tryRmAll(files)
            return
          }
          if (!files) {
            this.opts.log('synth failed (silent)')
            continue
          }
          // 若复用任务带 store 回调（预取发起），其结果已写入 prebuffer——
          // 消费后立即清理，防残留阻塞后续预取存储
          this.takePrebuffer(batch.text)
        }
        // 2. 立即预合成下一批（后台，不等待——批间停顿由此消除；结果存 prebuffer）
        const next = this.peekBatch()
        if (next) void this.requestSynth(next, gen, true)
        // 3. 播放（出声期间 UI 波动；记录朗读位置供轮尾指示条）
        this.setReading(batch)
        this.setSpeaking(true)
        const ok = await this.playFiles(files, gen)
        this.setSpeaking(false)
        this.reading = null
        this.tryRmAll(files)
        if (gen !== this.generation) return // 期间被 stop()/切引擎，放弃本轮
        if (!ok) this.opts.log('speak failed (silent)')
      }
    } finally {
      this.pumping = false
    }
  }

  /** 取批（不移除语义见 peekBatch；本方法消费队列头）。 */
  private takeBatch(): Batch {
    const sentences: string[] = []
    let chars = 0
    let meta: SentenceMeta = {}
    while (this.queue.length > 0 && sentences.length < BATCH_SENTENCES && chars < BATCH_CHARS) {
      const item = this.queue.shift()!
      sentences.push(item.text)
      chars += item.text.length
      if (!meta.sessionId && item.meta.sessionId) meta = item.meta
    }
    return { text: sentences.join(''), sentences, meta }
  }

  /** 预取下一批（不消费队列；用于预合成）。 */
  private peekBatch(): Batch | null {
    if (this.queue.length === 0) return null
    const sentences: string[] = []
    let chars = 0
    let meta: SentenceMeta = {}
    for (const item of this.queue) {
      if (sentences.length >= BATCH_SENTENCES || chars >= BATCH_CHARS) break
      sentences.push(item.text)
      chars += item.text.length
      if (!meta.sessionId && item.meta.sessionId) meta = item.meta
    }
    return { text: sentences.join(''), sentences, meta }
  }

  /** 记录当前朗读位置（批播放前调用；按句字符权重 + 估算语速推算进度）。 */
  private setReading(batch: Batch): void {
    this.reading = {
      sessionId: batch.meta.sessionId ?? '',
      turn: batch.meta.turn ?? 0,
      sentences: batch.sentences,
      chars: batch.sentences.map((s) => s.length),
      estimatedTotalMs: (batch.sentences.reduce((a, s) => a + s.length, 0) / CHARS_PER_SECOND) * 1000,
      playStart: Date.now(),
    }
  }

  private takePrebuffer(text: string): string[] | null {
    if (this.prebuffer && this.prebuffer.text === text) {
      const files = this.prebuffer.files
      this.prebuffer = null
      return files
    }
    return null
  }

  /**
   * 请求合成：文本相同的 in-flight 任务直接复用（防双合成）。
   * @param store true=预取语义：结果存入 prebuffer 供下轮直接消费（无人 await）。
   *              false=直接消费语义：调用者 await 拿结果，不写 prebuffer。
   */
  private requestSynth(batch: Batch, gen: number, store: boolean): Promise<string[] | null> {
    if (this.synthInFlight && this.synthInFlight.text === batch.text) return this.synthInFlight.promise
    const promise = this.enqueueSynth(batch, gen)
    this.synthInFlight = { text: batch.text, promise }
    const clear = (): void => {
      if (this.synthInFlight?.promise === promise) this.synthInFlight = null
    }
    if (store) {
      promise.then(
        (files) => {
          clear()
          if (files && files.length && !this.prebuffer) {
            this.prebuffer = { text: batch.text, files }
          }
        },
        () => clear(),
      )
    } else {
      promise.then(clear, clear)
    }
    return promise
  }

  /** 合成串行链：一次只跑一个合成进程；完成后代数不符即丢弃文件。 */
  private enqueueSynth(batch: Batch, gen: number): Promise<string[] | null> {
    const run = this.synthChain.then(async () => {
      if (gen !== this.generation || this.disposed || this.paused) return null
      const files = await this.doSynth(batch)
      if (gen !== this.generation || this.disposed || this.paused) {
        this.tryRmAll(files)
        return null
      }
      return files
    })
    this.synthChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** 合成一批到槽文件：edge 整批合成（失败重试 1 次防网络抖动）→ 逐句降级 onecore。返回文件列表或 null。 */
  private async doSynth(batch: Batch): Promise<string[] | null> {
    if (this.engine === 'edge' && this.edgeTtsPath) {
      const file = this.nextSlotPath()
      const args = ['-t', batch.text, '-v', this.opts.edgeVoice]
      if (this.opts.edgeRate && this.opts.edgeRate !== '+0%') args.push('--rate', this.opts.edgeRate)
      args.push('--write-media', file)
      let ok = await this.run(this.edgeTtsPath, args, SYNTH_TIMEOUT_MS, false)
      if (!ok || !existsSync(file)) {
        // 网络抖动/限流瞬断：重试一次再降级（edge-tts 偶发失败已实测多次）
        this.opts.log('edge synth failed, retrying once')
        this.tryRm(file)
        ok = await this.run(this.edgeTtsPath, args, SYNTH_TIMEOUT_MS, false)
      }
      if (ok && existsSync(file)) return [file]
      this.opts.log('edge synth failed again, falling back to onecore')
      this.tryRm(file)
    }
    if (!this.hostPath) return null
    const files: string[] = []
    for (const t of batch.sentences) {
      const file = this.nextSlotPath()
      const ok = await this.run(
        this.hostPath,
        [this.opts.voice, t, file, String(this.opts.rate)],
        SYNTH_TIMEOUT_MS,
        false,
      )
      if (!ok || !existsSync(file)) {
        this.tryRm(file)
        this.tryRmAll(files)
        return null
      }
      files.push(file)
    }
    return files
  }

  /** 轮换取槽文件路径（合成前清旧文件，防残留内容被探测播放）。 */
  private nextSlotPath(): string {
    const p = this.slotPaths[this.slotIndex % this.slotPaths.length]
    this.slotIndex++
    try {
      rmSync(p, { force: true })
    } catch {
      /* noop */
    }
    return p
  }

  /** 顺序播放一批文件；任一失败或代数变化即停。 */
  private async playFiles(files: string[], gen: number): Promise<boolean> {
    for (const f of files) {
      if (gen !== this.generation || this.paused || this.disposed) return false
      const ok = await this.run(
        this.ffplayPath,
        ['-nodisp', '-autoexit', '-loglevel', 'quiet', f],
        PLAY_TIMEOUT_MS,
        true,
      )
      if (!ok) return false
    }
    return true
  }

  private tryRm(file: string): void {
    try {
      rmSync(file, { force: true })
    } catch {
      /* noop */
    }
  }

  private tryRmAll(files: string[] | null): void {
    if (!files) return
    for (const f of files) this.tryRm(f)
  }

  /**
   * 跑一个子进程；trackCurrent=true 时登记为"可打断的播放进程"（stop() 可杀）。
   * 合成进程传 false：短命且结果由代数校验丢弃，无需打断，也不覆盖播放进程引用。
   */
  private run(exe: string, args: string[], timeoutMs: number, trackCurrent: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
      } catch (e) {
        this.opts.log('spawn failed for ' + exe + ': ' + String(e))
        resolve(false)
        return
      }
      if (trackCurrent) this.current = child
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          child.kill()
        } catch {
          /* noop */
        }
        this.opts.log('timeout after ' + timeoutMs + 'ms: ' + exe)
        if (trackCurrent && this.current === child) this.current = null
        resolve(false)
      }, timeoutMs)
      child.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.opts.log('proc error ' + exe + ': ' + String(err))
        if (trackCurrent && this.current === child) this.current = null
        resolve(false)
      })
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (trackCurrent && this.current === child) this.current = null
        resolve(code === 0)
      })
    })
  }
}
