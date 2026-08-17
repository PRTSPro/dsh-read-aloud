/**
 * 朗读执行层：FIFO 单消费者队列。
 * 两档引擎：
 *   onecore —— dotnet OneCore 宿主合成 wav → ffplay 播放（本地即时，<1s 首音）
 *   edge    —— edge-playback 流式（边合成边播，首音 2~3s，音质接近真人；不落盘）
 * - edge 失败自动降级 onecore（fallbackToLocal）
 * - 队列积压超限丢新句（跟读模式：宁可漏不可积压）
 * - 打断（stop）：清队列 + kill 当前进程树 + 代数递增使 in-flight 步骤失效
 * - 一切失败静默降级：日志记录，不影响对话
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
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
  edgePlayback: string
  fallbackToLocal: boolean
  log: (msg: string) => void
}

const SYNTH_TIMEOUT_MS = 30_000
const PLAY_TIMEOUT_MS = 180_000
/** edge 批提交粒度：攒 3 句或 120 字一批（批内无缝，批间为段落级停顿） */
const EDGE_BATCH_SENTENCES = 3
const EDGE_BATCH_CHARS = 120

export class Speaker {
  private queue: string[] = []
  private pumping = false
  private paused = false
  private disposed = false
  private engine: Engine
  /** 打断代数：stop() 递增，in-flight 步骤醒来后发现代数不符即放弃。 */
  private generation = 0
  private current: ChildProcess | null = null
  private hostPath: string
  private ffplayPath: string
  private edgePath: string
  private wavPath = join(tmpdir(), 'dsh-read-aloud-sentence.wav')

  constructor(private readonly opts: SpeakerOptions) {
    this.engine = opts.engine
    this.hostPath = this.resolveHost()
    this.ffplayPath = opts.ffplay || 'ffplay'
    this.edgePath = this.resolveEdge()
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

  /** 探测 edge-playback：配置 > ~/.local/bin > PATH。 */
  private resolveEdge(): string {
    const candidates = [
      this.opts.edgePlayback,
      join(homedir(), '.local', 'bin', 'edge-playback.exe'),
      'edge-playback',
    ].filter(Boolean)
    for (const c of candidates) {
      if (c === 'edge-playback' || existsSync(c)) {
        this.opts.log('edge-playback resolved: ' + c)
        return c
      }
    }
    this.opts.log('WARN: edge-playback not found (edge tier disabled)')
    return ''
  }

  /** 切换引擎：打断当前播放、清队列、恢复。 */
  setEngine(engine: Engine): void {
    if (this.engine === engine || this.disposed) return
    this.engine = engine
    this.opts.log('engine switched to ' + engine)
    this.stop()
    this.paused = false
    void this.pump()
  }

  speak(text: string): void {
    if (this.paused || this.disposed) return
    if (this.engine === 'edge' && !this.edgePath) {
      // edge 不可用且未启用降级时直接丢弃
      if (!this.opts.fallbackToLocal || !this.hostPath) return
    }
    if (this.queue.length >= this.opts.maxQueue) {
      this.opts.log('queue full(' + this.queue.length + '), dropping: ' + text.slice(0, 30))
      return
    }
    this.queue.push(text)
    void this.pump()
  }

  /** 暂停并打断当前播放（关键词"别读了"）。 */
  stop(): void {
    this.paused = true
    this.generation++
    this.queue = []
    this.killCurrent()
    this.opts.log('stopped')
  }

  /** 恢复朗读（关键词"继续朗读"）。 */
  resume(): void {
    if (this.disposed) return
    this.paused = false
    this.opts.log('resumed')
    void this.pump()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
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
    // Windows：taskkill /T 确保子孙进程（edge-playback 内部的 ffplay）一并终止
    if (process.platform === 'win32' && c.pid) {
      try {
        spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        /* noop */
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.paused && !this.disposed && this.queue.length > 0) {
        const gen = this.generation
        let ok: boolean
        if (this.engine === 'edge') {
          // edge 批提交：攒 N 句一批，一次进程流式朗读 → 批内句间无缝
          const batch: string[] = []
          let chars = 0
          while (
            this.queue.length > 0 &&
            batch.length < EDGE_BATCH_SENTENCES &&
            chars < EDGE_BATCH_CHARS
          ) {
            const t = this.queue.shift()!
            batch.push(t)
            chars += t.length
          }
          ok = await this.sayEdgeBatch(batch)
        } else {
          const text = this.queue.shift()!
          ok = await this.say(text)
        }
        if (gen !== this.generation) return // 期间被 stop()/切引擎，放弃本轮
        if (!ok) this.opts.log('speak failed (silent)')
      }
    } finally {
      this.pumping = false
    }
  }

  /** 按当前引擎朗读一句；任何失败返回 false（静默降级）。 */
  private async say(text: string): Promise<boolean> {
    try {
      if (this.engine === 'edge') {
        return this.sayEdgeBatch([text])
      }
      return this.sayOnecore(text)
    } catch (e) {
      this.opts.log('say error: ' + String(e))
      return false
    }
  }

  /** 本地 OneCore：合成 wav → ffplay 播放。 */
  private async sayOnecore(text: string): Promise<boolean> {
    if (!this.hostPath) return false
    const synth = await this.run(
      this.hostPath,
      [this.opts.voice, text, this.wavPath, String(this.opts.rate)],
      SYNTH_TIMEOUT_MS,
    )
    if (!synth) return false
    return this.run(
      this.ffplayPath,
      ['-nodisp', '-autoexit', '-loglevel', 'quiet', this.wavPath],
      PLAY_TIMEOUT_MS,
    )
  }

  /** edge-tts 流式批：多句拼一段一次播放（文本走 -t，音色走 -v）；失败逐句降级本地。 */
  private async sayEdgeBatch(batch: string[]): Promise<boolean> {
    if (!this.edgePath || batch.length === 0) return false
    const text = batch.join('')
    const args = ['-t', text, '-v', this.opts.edgeVoice]
    if (this.opts.edgeRate && this.opts.edgeRate !== '+0%') args.push('--rate', this.opts.edgeRate)
    const ok = await this.run(this.edgePath, args, PLAY_TIMEOUT_MS)
    if (ok) return true
    if (this.opts.fallbackToLocal && this.hostPath) {
      this.opts.log('edge failed, falling back to onecore')
      for (const t of batch) {
        if (!(await this.sayOnecore(t))) return false
      }
      return true
    }
    return false
  }

  private run(exe: string, args: string[], timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
      } catch (e) {
        this.opts.log('spawn failed for ' + exe + ': ' + String(e))
        resolve(false)
        return
      }
      this.current = child
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
        resolve(false)
      }, timeoutMs)
      child.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.opts.log('proc error ' + exe + ': ' + String(err))
        resolve(false)
      })
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(code === 0)
      })
    })
  }
}
