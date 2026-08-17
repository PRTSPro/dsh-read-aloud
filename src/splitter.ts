/**
 * 句子切分器：把流式 text-delta 累积为完整句，按句朗读。
 * - 终止符切句：。！？…；\n（中文）+ 英文 .!?（后跟空白/行尾才切，防小数点误判）
 * - 缓冲上限强制切（防超长句卡住听感）
 * - 非文本清洗管线（防止 TTS 机械式逐字符朗读）：
 *   ① ``` 代码围栏剔除（状态机，可跨 chunk）② 行内 `code` ③ markdown 链接只留文字
 *   ④ 裸 URL ⑤ emoji ⑥ 箭头 ⑦ 表格竖线 ⑧ 连续符号串 ⑨ 长英文/路径标识符 ⑩ 长数字串
 *   ⑪ 符号静音：/ （） - — – 等单个符号 → 空格（TTS 不读"斜杠/括号/减号"）
 *   最后：行首 markdown 装饰符清理 + 句子级过滤（无实质文字则丢弃）
 */

const SENTENCE_END = /[。！？…；\n]|[.!?](?=\s|$)/g

/** markdown 链接 [text](url)：保留 text；纯数字角标（引用标注）整组丢弃 */
const RE_LINK = /\[([^\]]*)\]\([^)]*\)/g
/** 裸 URL：删（尾部中文标点不吞） */
const RE_URL = /https?:\/\/[^\s。！？；，、」』）】\u4e00-\u9fff]*/gi
/** emoji 与符号区段 */
const RE_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu
/** 箭头 → 空格 */
const RE_ARROW = /[→←↑↓⇒⇐⇔↔]/g
/** 表格竖线 → 空格（表格行退化为连续词，分隔行成空行） */
const RE_PIPE = /\|/g
/** 3+ 连续非文字符号（---、===、……装饰线等）→ 删 */
const RE_SYMBOL_RUN = /[^\p{L}\p{N}\s]{3,}/gu
/** 长英文/路径/标识符候选（≥16 字符），由 isJunkToken 判定删留 */
const RE_LONG_TOKEN = /[A-Za-z0-9][A-Za-z0-9_.\-/\\:]{15,}/g
/** 长数字串（时间戳/ID ≥10 位）→ 删 */
const RE_LONG_NUM = /\d{10,}/g
/**
 * 符号静音 → 空格：TTS 不读"斜杠/括号/减号/引号/下划线"这类符号。
 * 括号内容保留（"（见上文）"读成"见上文"），只静音符号本身。
 * - 括号（中英文）、斜杠、反斜杠、破折号（em/en dash，含 2 连 —— 不在 3+ 规则内）
 * - 引号（中英文全角/半角）、下划线、& # * $ @ = ~ ^ | {} [] <> 【】〔〕
 * - 保留有语义/停顿的标点：. , ; : ! ? % + 与中文标点（，。！？；：、《》）
 * - ASCII 连字符/横线：拆复合词为自然词组（state-of-the-art → state of the art）
 * 放在 RE_LONG_NUM 之后：不干扰 isJunkToken 对含 - / 长 token 的先行判定。
 */
const RE_SILENT_SYM = /[()（）/—–‒"'«»‹›“”‘’_&$*@#=~^\[\]{}|<>【】〔〕\\]/g
const RE_HYPHEN = /-/g

/**
 * 长串是否为 TTS 垃圾（逐字符朗读会机械）：
 * - 含路径分隔符/冒号（路径、URL 残余、时间戳）
 * - 大小写混合（Camel/Pascal/kebab-case 标识符）
 * - ≥24 字符的字母数字混合串（哈希/编码串）
 * 全小写连字符复合词（state-of-the-art）保留。
 */
function isJunkToken(t: string): boolean {
  if (t.length < 16) return false
  if (/[/\\:_]/.test(t)) return true
  if (/[A-Z]/.test(t) && /[a-z]/.test(t)) return true
  if (/[A-Za-z]/.test(t) && /\d/.test(t) && t.length >= 24) return true
  return false
}

export class SentenceSplitter {
  private buffer = ''
  /** 是否处于 ``` 代码围栏内（可跨多个 delta） */
  private inCodeFence = false

  constructor(private readonly maxLen: number) {}

  /**
   * 喂入一段流式文本；产生的完整句立即交给 out。
   */
  push(text: string, out: (sentence: string) => void): void {
    const cleaned = this.clean(text)
    if (!cleaned) return
    this.buffer += cleaned
    this.cut(out, false)
  }

  /**
   * 冲刷余句（turn 结束/收尾时调用）。
   */
  flush(out: (sentence: string) => void): void {
    this.cut(out, true)
  }

  /** 丢弃当前缓冲（打断时调用）。 */
  reset(): void {
    this.buffer = ''
  }

  /** 句子级过滤：压空白、去纯符号/过短句。 */
  private emit(sentence: string, out: (s: string) => void): void {
    const t = sentence.replace(/\s+/g, ' ').trim()
    if (!t) return
    const letters = t.replace(/[^\p{L}\p{N}]/gu, '')
    if (letters.length < 2) return
    out(t)
  }

  private cut(out: (sentence: string) => void, force: boolean): void {
    // 围栏未闭合时不切句（内容正在被丢弃，buffer 为空，无需处理）
    if (this.inCodeFence) return

    SENTENCE_END.lastIndex = 0
    let m: RegExpExecArray | null
    let lastEnd = -1
    while ((m = SENTENCE_END.exec(this.buffer)) !== null) {
      lastEnd = m.index + m[0].length
    }
    if (lastEnd > 0) {
      const sentence = this.buffer.slice(0, lastEnd)
      this.buffer = this.buffer.slice(lastEnd)
      this.emit(sentence, out)
      // 切出后可能还有完整句，递归处理
      if (!force) this.cut(out, false)
    } else if (force && this.buffer.trim()) {
      this.emit(this.buffer, out)
      this.buffer = ''
    } else if (this.buffer.length >= this.maxLen) {
      // 超上限：在最近逗号/空格处强制切，避免把词切断
      let cutAt = this.maxLen
      const soft = Math.max(
        this.buffer.lastIndexOf('，', this.maxLen),
        this.buffer.lastIndexOf(',', this.maxLen),
        this.buffer.lastIndexOf(' ', this.maxLen),
      )
      if (soft > this.maxLen / 2) cutAt = soft + 1
      const sentence = this.buffer.slice(0, cutAt)
      this.buffer = this.buffer.slice(cutAt)
      this.emit(sentence, out)
      if (!force) this.cut(out, false)
    }
  }

  /**
   * 非文本清洗管线（顺序敏感）。围栏剔除是状态机，其余为正则替换。
   */
  private clean(text: string): string {
    // ① 代码围栏状态机
    let result = ''
    let i = 0
    while (i < text.length) {
      if (this.inCodeFence) {
        const fence = text.indexOf('```', i)
        if (fence === -1) return result // 围栏跨 chunk，丢弃余下
        this.inCodeFence = false
        i = fence + 3
        continue
      }
      const fence = text.indexOf('```', i)
      if (fence !== -1) {
        result += text.slice(i, fence)
        this.inCodeFence = true
        i = fence + 3
        continue
      }
      result += text.slice(i)
      break
    }

    // ②~⑩ 正则管线
    const body = result
      .replace(/`[^`]*`/g, ' ')
      .replace(RE_LINK, (_m, t: string) => (/^\d+$/.test(String(t).trim()) ? ' ' : t))
      .replace(RE_URL, ' ')
      .replace(RE_EMOJI, ' ')
      .replace(RE_ARROW, ' ')
      .replace(RE_PIPE, ' ')
      .replace(RE_SYMBOL_RUN, ' ')
      .replace(RE_LONG_TOKEN, (t) => (isJunkToken(t) ? ' ' : t))
      .replace(RE_LONG_NUM, ' ')
      .replace(RE_SILENT_SYM, ' ')
      .replace(RE_HYPHEN, ' ')

    // 行首装饰符（逐行）+ 保留换行供切句使用
    // 标题行（# 开头）与下文合并成一句，消除"标题 → 正文"的句间停顿
    return body
      .split('\n')
      .map((line) => {
        const head = line.match(/^\s*#{1,6}\s+/)
        if (head) return line.replace(head[0], '') + ' '
        return line
          .replace(/^\s*[-*+]\s+/, '')
          .replace(/^\s*>\s?/, '')
          .replace(/^\s*\d+[.)]\s+/, '')
          .replace(/\*\*|__/g, '')
          .trimEnd()
      })
      .join('\n')
  }
}
