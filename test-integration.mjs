/**
 * 集成测试：用假 ctx / 假 agent 跑一遍事件流，验证：
 *   1. 空回合会触发 steer
 *   2. 有正文 / 有工具调用时不触发
 *   3. 达到 maxContinuations 后不再触发
 *   4. turn/end 会清账
 *   5. 拿不到 @deepseek-ai/dsh-llm 时的兜底消息可用
 */

import assert from 'node:assert/strict'
import { apply } from './index.js'

let passed = 0
const test = (n, fn) => { fn(); passed++; console.log(`  ✓ ${n}`) }

function makeCtx() {
  const handlers = new Map()
  const logs = []
  return {
    handlers,
    logs,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) },
    async fire(event, ...args) {
      for (const fn of handlers.get(event) ?? []) await fn(...args)
    },
  }
}

function makeAgent(events) {
  const steered = []
  return {
    session: { snapshotEvents: () => events },
    steer(msg) { steered.push(msg) },
    steered,
  }
}

function reasoningEvent(turn, text) {
  return { type: 'assistant/message', data: { turn, message: { content: [{ type: 'reasoning', text }] } } }
}

const LONG_REASONING = '做。'.repeat(80)

console.log('集成测试')

await (async () => {
  // 1) 空回合触发
  {
    const ctx = makeCtx()
    apply(ctx, {})
    const agent = makeAgent([reasoningEvent(1, LONG_REASONING)])
    await ctx.fire('agent/turn-stopping', { agent, turn: 1 })
    test('空回合会 steer 一次', () => {
      assert.equal(agent.steered.length, 1, '应注入一条补救消息')
      const m = agent.steered[0]
      assert.ok(m.content?.[0]?.text?.length > 5, '补救消息要带文本')
      assert.ok(m.source?.kind?.startsWith('plugin:'), '要标记来源')
      assert.ok(ctx.logs.some((l) => l.includes('命中空回合')), '要记日志')
    })
  }

  // 2) 有正文不触发
  {
    const ctx = makeCtx()
    apply(ctx, {})
    const agent = makeAgent([{
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'reasoning', text: LONG_REASONING }, { type: 'text', text: '答案' }] } },
    }])
    await ctx.fire('agent/turn-stopping', { agent, turn: 1 })
    test('有正文时不 steer', () => assert.equal(agent.steered.length, 0))
  }

  // 3) 有工具调用不触发
  {
    const ctx = makeCtx()
    apply(ctx, {})
    const agent = makeAgent([{
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'tool-call', name: 'pwsh' }] } },
    }])
    await ctx.fire('agent/turn-stopping', { agent, turn: 1 })
    test('有工具调用时不 steer', () => assert.equal(agent.steered.length, 0))
  }

  // 4) 次数上限
  {
    const ctx = makeCtx()
    apply(ctx, { maxContinuations: 2 })
    const events = [reasoningEvent(1, LONG_REASONING)]
    const agent = makeAgent(events)
    for (let i = 0; i < 5; i++) {
      // 每次「补救」后补一条新事件，模拟回合确实又走了一步
      events.push(reasoningEvent(1, '又想了一遍。' + i))
      await ctx.fire('agent/turn-stopping', { agent, turn: 1 })
    }
    test('达到上限后停止补救', () => {
      assert.ok(agent.steered.length <= 2, `实际 ${agent.steered.length} 次，应 ≤ 2`)
    })
  }

  // 5) turn/end 清账：新回合可以重新补救
  {
    const ctx = makeCtx()
    apply(ctx, { maxContinuations: 1 })
    const events = [reasoningEvent(1, LONG_REASONING)]
    const agent = makeAgent(events)
    await ctx.fire('agent/turn-stopping', { agent, turn: 1 })
    assert.equal(agent.steered.length, 1)
    await ctx.fire('agent/turn-stopping', { agent, turn: 1 })
    assert.equal(agent.steered.length, 1, '同一轮不应超过上限')
    await ctx.fire('session/event', null, { type: 'turn/end', data: { turn: 1 } })
    events.push(reasoningEvent(2, LONG_REASONING))
    await ctx.fire('agent/turn-stopping', { agent, turn: 2 })
    test('turn/end 后新回合还能补救（账已清）', () => {
      assert.equal(agent.steered.length, 2, `实际 ${agent.steered.length}`)
    })
  }

  // 6) 关闭开关
  {
    const ctx = makeCtx()
    apply(ctx, { enabled: false })
    const agent = makeAgent([reasoningEvent(1, LONG_REASONING)])
    await ctx.fire('agent/turn-stopping', { agent, turn: 1 })
    test('enabled=false 时完全不干预', () => assert.equal(agent.steered.length, 0))
  }

  // 7) 兜底消息形状
  {
    const ctx = makeCtx()
    apply(ctx, {})
    const agent = makeAgent([reasoningEvent(1, LONG_REASONING)])
    await ctx.fire('agent/turn-stopping', { agent, turn: 1 })
    const m = agent.steered[0]
    test('兜底消息具备 role/content/source 三要素', () => {
      assert.equal(m.role, 'user')
      assert.ok(Array.isArray(m.content))
      assert.ok(m.source?.kind)
    })
  }

  console.log(`\n全部通过：${passed} 项`)

  // 打印插件自己的日志，便于人工确认
  const ctx = makeCtx()
  apply(ctx, {})
  await ctx.fire('agent/turn-stopping', { agent: makeAgent([reasoningEvent(9, LONG_REASONING)]), turn: 9 })
  console.log('\n插件日志样例:')
  for (const l of ctx.logs) console.log('  ' + l)
})()
