/**
 * dsh-empty-turn-guard
 *
 * 兜住一类「空回合」：模型整轮只产出思考（reasoning），没有正文、也没有调用任何工具，
 * agent 循环却把它当作正常完成收尾。表现是界面上只有思考气泡、标记「已完成」，一个字没输出。
 *
 * 常见成因有两条：
 *   1. 思考退化成重复循环（「做。做。做。…」），耗尽后直接停；
 *   2. 思考把输出额度吃光（max-tokens），还没轮到写正文就结束了。
 *
 * 本插件监听 `agent/turn-stopping`，纯结构判断（不调裁判模型），命中就往同一轮里
 * steer 一条提示，让循环再走一步。每轮有次数上限，避免无限循环。
 *
 * 与 dsh-loop-continue 的区别：那个治「写了要做但没调工具」（要求有文本、且此前调用过工具）；
 * 本插件治「连一个字都没有」，两条门槛都不需要。
 */

/** 插件 id，cordis.patch.yml 里的 id 要和它一致。 */
export const name = 'empty-turn-guard'

/** 注入需求：只用事件，不依赖额外服务。 */
export const inject = []

/** 注入消息的来源标记，便于在会话里区分是插件补的。 */
const PLUGIN_SOURCE = { kind: `plugin:${name}` }

/** 默认配置。 */
export const DEFAULTS = {
  enabled: true,
  /** 每轮最多补救几次。 */
  maxContinuations: 2,
  /** 思考少于这么多字就不管（可能是模型真的选择不回答）。 */
  minReasoningChars: 40,
  /** 是否检测重复退化。 */
  detectRepetition: true,
  /** 同一短语连续重复达到这个次数，判定为退化。 */
  repetitionMinRepeats: 6,
  /** 上下文窗口耗尽时的输出上限估算，用来判断是不是 max-tokens。 */
  assumedMaxOutputTokens: 4096,
  /** 常规补救提示。 */
  steerText: '你刚才的思考陷入了重复，整轮没有产生任何输出。请立刻停止重复推导，'
    + '直接给出结论，或者执行下一步动作（调用工具）。',
  /** 疑似输出额度耗尽时的补救提示。 */
  steerTextCapped: '上一轮你的思考占满了输出额度，正文没来得及写。请压缩思考过程，'
    + '这一轮直接输出结果或执行下一步动作。',
  debug: false,
}

// ---------------------------------------------------------------------------
// 纯函数部分（可单测）
// ---------------------------------------------------------------------------

/** 从 session 上取事件数组，兼容不同内核版本。 */
export function readEvents(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  if (session && Array.isArray(session.events)) return session.events
  return []
}

/**
 * 归纳某一轮的结构：有没有正文、有没有工具调用、思考多长、用量多少。
 * @param {Array} events 会话事件
 * @param {number} turn  回合号
 */
export function analyzeTurn(events, turn) {
  const out = {
    turn,
    messages: 0,
    hasText: false,
    hasToolCall: false,
    reasoning: '',
    textChars: 0,
    lastUsage: null,
  }

  for (const event of events) {
    const data = event?.data
    if (!data || data.turn !== turn) continue
    if (event.type !== 'assistant/message') continue

    out.messages++
    const blocks = data.message?.content ?? []
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.hasText = true
        out.textChars += b.text.trim().length
      } else if (b.type === 'tool-call') {
        out.hasToolCall = true
      } else if (b.type === 'reasoning' && typeof b.text === 'string') {
        out.reasoning += b.text
      }
    }
    if (data.usage) out.lastUsage = data.usage
  }

  return out
}

/**
 * 检测尾部的重复退化：从结尾往前找一个短单元，看它连续重复了多少次。
 * 「做。 做。 做。…」和「Let me go. Let me go. …」都能命中。
 * @param {string} text
 * @param {number} maxUnit 最大单元长度（字符）
 */
export function findRepetitionTail(text, maxUnit = 16) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length < 8) return { repeats: 1, unit: '', ratio: 0 }

  let best = { repeats: 1, unit: '', ratio: 0 }
  const window = s.slice(-Math.min(s.length, 400))

  for (let unit = 2; unit <= maxUnit; unit++) {
    if (window.length < unit * 2) break
    const tail = window.slice(-unit)
    // 从结尾往前数，有多少个连续相同的 tail
    let count = 0
    let i = window.length
    while (i - unit >= 0 && window.slice(i - unit, i) === tail) {
      count++
      i -= unit
    }
    if (count > best.repeats) {
      best = { repeats: count, unit: tail, ratio: (count * unit) / window.length }
    }
  }
  return best
}

/**
 * 判断这一轮要不要补救。
 * @returns {{recover: boolean, why: string, capped: boolean}}
 */
export function decideRecovery(analysis, config = {}) {
  const cfg = { ...DEFAULTS, ...config }

  if (!cfg.enabled) return { recover: false, why: 'disabled', capped: false }
  if (analysis.hasText) return { recover: false, why: 'has-text', capped: false }
  if (analysis.hasToolCall) return { recover: false, why: 'has-tool-call', capped: false }
  if (analysis.messages === 0) return { recover: false, why: 'no-message', capped: false }
  if (analysis.reasoning.trim().length < cfg.minReasoningChars) {
    return { recover: false, why: 'reasoning-too-short', capped: false }
  }

  // 是不是把输出额度烧光了
  const used = analysis.lastUsage?.outputTokens ?? 0
  const capped = used >= cfg.assumedMaxOutputTokens * 0.95

  if (cfg.detectRepetition) {
    const rep = findRepetitionTail(analysis.reasoning)
    if (rep.repeats >= cfg.repetitionMinRepeats) {
      return { recover: true, why: `degenerate-repeat(${rep.repeats}x)`, capped }
    }
  }

  // 没有明显重复也照样救：只有思考没有输出，本来就不是一个有效的答复
  return { recover: true, why: capped ? 'output-cap' : 'reasoning-only', capped }
}

/** 兼容旧内核：拿不到 createUserMessage 时手搓一个符合形状的用户消息。 */
function fallbackUserMessage(spec) {
  return {
    role: 'user',
    content: spec.content,
    source: spec.source,
    time: Date.now(),
  }
}

let cachedFactory = null
async function getCreateUserMessage() {
  if (cachedFactory) return cachedFactory
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    cachedFactory = mod.createUserMessage ?? fallbackUserMessage
  } catch {
    cachedFactory = fallbackUserMessage
  }
  return cachedFactory
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  /** 每轮已经补救了几次 */
  const spent = new Map()
  /** 每轮补救后的日志长度，用来判断上一次补救有没有生效 */
  const probe = new Map()

  const log = (msg) => ctx.logger?.info?.(`[${name}] ${msg}`)
  const warn = (msg) => ctx.logger?.warn?.(`[${name}] ${msg}`)

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const cfg = { ...DEFAULTS, ...config }
    const used = spent.get(turn) ?? 0
    if (used >= cfg.maxContinuations) return

    const events = readEvents(agent?.session)
    const analysis = analyzeTurn(events, turn)
    const decision = decideRecovery(analysis, cfg)

    // 上一次补救之后如果又是空轮，说明补救无效，别再烧了
    if (probe.has(turn)) {
      const at = probe.get(turn)
      probe.delete(turn)
      if (!decision.recover) {
        // 救回来了（这轮有输出），清账
      } else if (events.length <= at) {
        spent.set(turn, cfg.maxContinuations)
        warn(`turn ${turn}: 上一次补救没有产生新内容，停止补救`)
        return
      }
    }

    if (!decision.recover) return

    const text = decision.capped ? cfg.steerTextCapped : cfg.steerText
    try {
      const createUserMessage = await getCreateUserMessage()
      agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: PLUGIN_SOURCE,
      }))
      spent.set(turn, used + 1)
      probe.set(turn, events.length)
      log(`turn ${turn}: 命中空回合（${decision.why}），第 ${used + 1} 次补救`)
    } catch (error) {
      warn(`turn ${turn}: 补救失败 ${String(error)}`)
    }
  })

  /** 回合真正结束后清账，避免 Map 无限增长。 */
  ctx.on('session/event', (_session, event) => {
    if (event?.type === 'turn/end') {
      spent.delete(event.data?.turn)
      probe.delete(event.data?.turn)
    }
  })

  log(`已加载（最多补救 ${config.maxContinuations ?? DEFAULTS.maxContinuations} 次/轮）`)
}
