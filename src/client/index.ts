// @ts-nocheck
/**
 * dsh-read-aloud client half — 对话栏朗读开关小图标按钮（conversation.input.left slot）。
 *
 * 三态视觉：
 *   - 已开启（待命）：喇叭 + 两道声波弧（品牌色）
 *   - 朗读中：喇叭呼吸 + 右侧三根音量条波动（CSS 动画）
 *   - 已关闭：喇叭 + 斜线（灰色、半透明）
 *   - host 不可达：整体降透明（offline 兜底）
 *
 * 交互：点击 → host RPC `toggle` 开关朗读；每 300ms 轮询 host RPC `state`
 * （muted/speaking/engine）驱动动画与提示。
 *
 * ⚠️ 本文件双重身份（勿改结构）：
 *   1. tsc 直编镜像源：`export const inject` 与单行 `slots.register({ name: ... })`
 *      锚点是注入器预检（clientSkeletonProblems）的识别特征——slot 名必须写字面量；
 *   2. scripts/build-client.mjs 的输入：抽取 `__mirror` 内 body 生成
 *      lib/client.js（window.__ModuleLoader__.load 包裹的浏览器 bundle）。
 *   因此 __mirror 内的 body 必须是纯 JS（无 TS 类型注解），运行时依赖
 *   React / host / ctx 均由 bundle 工厂闭包提供。
 */
export const inject = ['slots', 'timer']
const __mirror = (function () {
  return {
    name: '@dsh-external/dsh-read-aloud',
    inject: ['slots', 'timer'],
    apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      const CSS = [
        '@keyframes ra-bar-anim{0%,100%{transform:scaleY(.3);opacity:.4}50%{transform:scaleY(1);opacity:1}}',
        '@keyframes ra-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}',
        '.ra-toggle-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;margin:0;border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#6b7280);transition:color .18s ease,background-color .18s ease,opacity .18s ease;flex-shrink:0}',
        '.ra-toggle-btn:hover{background:rgba(127,127,127,.16)}',
        '.ra-toggle-btn:active{background:rgba(127,127,127,.24)}',
        '.ra-toggle-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}',
        '.ra-toggle-btn.ra-on{color:var(--dsw-alias-brand-primary,#4f6ef7)}',
        '.ra-toggle-btn.ra-muted{color:var(--dsw-alias-label-secondary,#6b7280);opacity:.6}',
        '.ra-toggle-btn.ra-offline{opacity:.35}',
        '.ra-wave-bar{transform-box:fill-box;transform-origin:center;animation:ra-bar-anim .9s ease-in-out infinite}',
        '.ra-speaker-glyph{transform-box:fill-box;transform-origin:center}',
        '.ra-toggle-btn.ra-on.ra-speaking .ra-speaker-glyph{animation:ra-breathe 1.15s ease-in-out infinite}',
        // 对话栏上方朗读进度横条（conversation.input.dock）
        '.ra-progress-bar{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 12px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 22%,transparent);color:var(--dsw-alias-brand-primary,#4f6ef7);font-size:12px;line-height:1.5}',
        '.ra-progress-bar .ra-pb-bars{display:inline-flex;align-items:flex-end;gap:2px;height:12px;flex-shrink:0}',
        '.ra-progress-bar .ra-pb-bar{width:2.5px;border-radius:1px;background:currentColor;animation:ra-bar-anim .8s ease-in-out infinite;transform-box:fill-box;transform-origin:bottom}',
        '.ra-progress-bar .ra-pb-label{flex-shrink:0;font-weight:600;white-space:nowrap}',
        '.ra-progress-bar .ra-pb-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
        '@media (prefers-reduced-motion:reduce){.ra-wave-bar,.ra-speaker-glyph,.ra-progress-bar .ra-pb-bar{animation:none!important}}',
      ].join('\n')

      // 共享朗读进度 store：按钮轮询写，turnTail 组件订阅读（避免每 turn 各轮询）
      const readingStore = {
        data: { sessionId: '', turn: -1, sentence: '', speaking: false },
        listeners: new Set(),
        set(next) {
          const old = this.data
          const changed = old.sessionId !== next.sessionId || old.turn !== next.turn || old.sentence !== next.sentence || old.speaking !== next.speaking
          this.data = next
          if (changed) {
            const ls = [...this.listeners]
            for (const fn of ls) { try { fn() } catch (e) { /* noop */ } }
          }
        },
        subscribe(fn) {
          this.listeners.add(fn)
          return function () { readingStore.listeners.delete(fn) }
        },
      }


      function ReadAloudButton(props) {
        // owner props InputZone：当前会话快照（scope=session，切会话自动重渲染）
        const sessionId = (props && props.session && props.session.id) || (props && props.sessionId) || ''
        const [st, setSt] = React.useState({ muted: false, speaking: false, engine: '', ok: false })

        React.useEffect(function () {
          // 上报当前会话：host 只朗读该会话（多会话并存时不交错混读）。
          // 依赖 [sessionId]：切会话时无论重挂载还是 props 变化都会重上报。
          // 只设置不清理——下一次挂载/切换会覆盖，天然免竞态。
          if (sessionId) host.call('set-active-session', { sessionId }).catch(function () {})
        }, [sessionId])

        React.useEffect(function () {
          let alive = true
          const refresh = async function () {
            try {
              const s = await host.call('state', {})
              if (!alive) return
              if (s && typeof s === 'object') {
                setSt({ muted: !!s.muted, speaking: !!s.speaking, engine: String(s.engine || ''), ok: true })
              }
            } catch (e) {
              if (alive) setSt(function (p) { return { muted: p.muted, speaking: false, engine: p.engine, ok: false } })
            }
            // 朗读进度（轮尾指示条数据源）
            try {
              const r = await host.call('current-sentence', {})
              if (alive && r && typeof r === 'object') {
                readingStore.set({
                  sessionId: String(r.sessionId || ''),
                  turn: Number(r.turn || -1),
                  sentence: String(r.sentence || ''),
                  speaking: !!r.speaking,
                })
              } else if (alive) {
                readingStore.set({ sessionId: '', turn: -1, sentence: '', speaking: false })
              }
            } catch (e) {
              if (alive) readingStore.set({ sessionId: '', turn: -1, sentence: '', speaking: false })
            }
          }
          refresh()
          let stop = function () {}
          try { stop = ctx.interval(refresh, 300) } catch (e) { /* 定时器不可用则仅首帧 */ }
          return function () { alive = false; stop() }
        }, [])

        const onClick = function () {
          host.call('toggle', {}).then(function (s) {
            if (s && typeof s === 'object') {
              setSt({ muted: !!s.muted, speaking: !!s.speaking, engine: String(s.engine || ''), ok: true })
            }
          }, function () { /* 失败静默，下一轮轮询自愈 */ })
        }

        const speaking = st.ok && !st.muted && st.speaking
        const cls = 'ra-toggle-btn'
          + (st.ok ? (st.muted ? ' ra-muted' : ' ra-on' + (speaking ? ' ra-speaking' : '')) : ' ra-offline')
        const tip = st.ok
          ? '朗读开关：' + (st.muted ? '已关闭（点击开启）' : speaking ? '朗读中（点击停止）' : '已开启（点击关闭）') + (st.engine ? ' · ' + st.engine : '')
          : '朗读开关：host 服务不可用'

        return React.createElement('button', {
          type: 'button',
          className: cls,
          title: tip,
          'aria-label': st.muted ? '开启朗读' : '关闭朗读',
          'aria-pressed': st.ok && !st.muted,
          onClick: onClick,
        },
          React.createElement('style', { key: 'style' }, CSS),
          React.createElement('svg', {
            key: 'icon', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true',
          },
            // 喇叭本体（朗读中带呼吸动画）
            React.createElement('path', {
              key: 'glyph', className: 'ra-speaker-glyph',
              d: 'M3.8 9.6v4.8c0 .55.45 1 1 1h2.7l4.3 3.9c.58.53 1.46.09 1.46-.66V5.36c0-.75-.88-1.19-1.46-.66L7.5 8.6H4.8c-.55 0-1 .45-1 1Z',
              fill: 'currentColor',
            }),
            st.muted
              // 关闭态：斜线
              ? React.createElement('line', { key: 'x', x1: 14.7, y1: 9, x2: 20.5, y2: 15.2, stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' })
              : speaking
                // 朗读中：三根音量条波动
                ? React.createElement('g', { key: 'bars' },
                    React.createElement('rect', { className: 'ra-wave-bar', x: 14.2, y: 9.2, width: 1.9, height: 5.6, rx: 0.95, fill: 'currentColor' }),
                    React.createElement('rect', { className: 'ra-wave-bar', style: { animationDelay: '.15s' }, x: 17.2, y: 8, width: 1.9, height: 8, rx: 0.95, fill: 'currentColor' }),
                    React.createElement('rect', { className: 'ra-wave-bar', style: { animationDelay: '.3s' }, x: 20.2, y: 9.2, width: 1.9, height: 5.6, rx: 0.95, fill: 'currentColor' }),
                  )
                // 待命态：两道声波弧
                : React.createElement('path', { key: 'waves', d: 'M14.4 9.3c1.3 1.5 1.3 3.9 0 5.4M17 7.6c2.3 2.6 2.3 6.2 0 8.8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
          ),
        )
      }

      // 对话栏上方朗读进度横条：仅当本会话正在朗读时渲染（订阅共享 store）
      function ReadAloudProgressBar(props) {
        const [cur, setCur] = React.useState(readingStore.data)
        // owner props InputZone.session + standard sessionId
        const sessionId = (props && props.session && props.session.id) || (props && props.sessionId) || ''

        React.useEffect(function () {
          return readingStore.subscribe(function () {
            setCur(readingStore.data)
          })
        }, [])

        const active = cur.speaking && cur.sessionId === sessionId && !!cur.sentence
        if (!active) return null
        return React.createElement('div', { className: 'ra-progress-bar', role: 'status' },
          React.createElement('span', { className: 'ra-pb-bars', 'aria-hidden': 'true' },
            React.createElement('span', { className: 'ra-pb-bar', style: { animationDelay: '0s' } }),
            React.createElement('span', { className: 'ra-pb-bar', style: { animationDelay: '.15s' } }),
            React.createElement('span', { className: 'ra-pb-bar', style: { animationDelay: '.3s' } }),
          ),
          React.createElement('span', { className: 'ra-pb-label' }, '🔊 朗读中'),
          React.createElement('span', { className: 'ra-pb-text' }, cur.sentence),
        )
      }

      // fiber 卸载时 slots.inject 控制器与 register 的 effect 一并回收。
      // ⚠️ register 内 slot 名必须写字面量：注入器预检（clientSkeletonProblems）按字面量锚点识别
      ctx.effect(() => slots.inject('conversation.input.left', function () {
        return slots.register({ name: 'conversation.input.left', id: 'read-aloud-toggle', order: 20, label: '朗读开关' }, ReadAloudButton)
      }), 'dsh-read-aloud: composer toggle')
      // 对话栏上方朗读进度横条：list 类型，在 composer 卡上方一整行（todo/goal/queue 之下）
      ctx.effect(() => slots.inject('conversation.input.dock', function () {
        return slots.register({ name: 'conversation.input.dock', id: 'read-aloud-progress', order: 30, label: '朗读进度' }, ReadAloudProgressBar)
      }), 'dsh-read-aloud: input dock progress')
    },
  }
})()
export default __mirror
