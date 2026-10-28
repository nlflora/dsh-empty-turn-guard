import assert from 'node:assert/strict'
import { analyzeTurn, findRepetitionTail, decideRecovery, DEFAULTS } from './index.js'

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

function msg(turn, blocks, usage) {
  return { type: 'assistant/message', data: { turn, message: { content: blocks }, usage } }
}

console.log('analyzeTurn')

test('只有思考：判为无文本、无工具', () => {
  const a = analyzeTurn([msg(1, [{ type: 'reasoning', text: '想一下' }])], 1)
  assert.equal(a.hasText, false)
  assert.equal(a.hasToolCall, false)
  assert.equal(a.reasoning, '想一下')
})

test('有正文：hasText 为真', () => {
  const a = analyzeTurn([msg(1, [{ type: 'reasoning', text: 'x' }, { type: 'text', text: '答案' }])], 1)
  assert.equal(a.hasText, true)
})

test('空字符串正文不算文本', () => {
  const a = analyzeTurn([msg(1, [{ type: 'text', text: '   ' }])], 1)
  assert.equal(a.hasText, false)
})

test('工具调用能被识别', () => {
  const a = analyzeTurn([msg(1, [{ type: 'tool-call', name: 'pwsh' }])], 1)
  assert.equal(a.hasToolCall, true)
})

test('只统计指定回合', () => {
  const events = [msg(1, [{ type: 'text', text: 'a' }]), msg(2, [{ type: 'reasoning', text: 'b' }])]
  const a = analyzeTurn(events, 2)
  assert.equal(a.hasText, false)
  assert.equal(a.reasoning, 'b')
})

test('取到最后一轮的 usage', () => {
  const a = analyzeTurn([msg(1, [], { outputTokens: 123 })], 1)
  assert.equal(a.lastUsage.outputTokens, 123)
})

console.log('findRepetitionTail')

test('「做。做。做。」能检出重复', () => {
  const r = findRepetitionTail('思考一下。' + '做。 '.repeat(12))
  assert.ok(r.repeats >= 6, `repeats=${r.repeats}`)
})

test('英文句式重复能检出', () => {
  const r = findRepetitionTail('Let me go. '.repeat(10))
  assert.ok(r.repeats >= 6, `repeats=${r.repeats}`)
})

test('正常文本不算重复', () => {
  const r = findRepetitionTail('我先读一下文件，再改配置，最后跑测试验证结果。')
  assert.ok(r.repeats < 3, `repeats=${r.repeats}`)
})

test('过短文本不误判', () => {
  const r = findRepetitionTail('好')
  assert.equal(r.repeats, 1)
})

console.log('decideRecovery')

test('空回合要救', () => {
  const a = analyzeTurn([msg(1, [{ type: 'reasoning', text: '想'.repeat(100) }])], 1)
  const d = decideRecovery(a)
  assert.equal(d.recover, true)
})

test('有正文不救', () => {
  const a = analyzeTurn([msg(1, [{ type: 'text', text: '答案' }])], 1)
  assert.equal(decideRecovery(a).recover, false)
})

test('有工具调用不救', () => {
  const a = analyzeTurn([msg(1, [{ type: 'tool-call', name: 'pwsh' }])], 1)
  assert.equal(decideRecovery(a).recover, false)
})

test('思考太短不救', () => {
  const a = analyzeTurn([msg(1, [{ type: 'reasoning', text: '嗯' }])], 1)
  assert.equal(decideRecovery(a).recover, false)
})

test('关掉开关就不救', () => {
  const a = analyzeTurn([msg(1, [{ type: 'reasoning', text: '想'.repeat(100) }])], 1)
  assert.equal(decideRecovery(a, { enabled: false }).recover, false)
})

test('输出额度耗尽会标记 capped', () => {
  const a = analyzeTurn([msg(1, [{ type: 'reasoning', text: '想'.repeat(100) }], { outputTokens: 4096 })], 1)
  const d = decideRecovery(a)
  assert.equal(d.recover, true)
  assert.equal(d.capped, true)
})

test('低用量不算 capped', () => {
  const a = analyzeTurn([msg(1, [{ type: 'reasoning', text: '想'.repeat(100) }], { outputTokens: 300 })], 1)
  assert.equal(decideRecovery(a).capped, false)
})

test('默认值可被覆盖', () => {
  const a = analyzeTurn([msg(1, [{ type: 'reasoning', text: '想'.repeat(100) }])], 1)
  assert.equal(decideRecovery(a, { minReasoningChars: 1000 }).recover, false)
  assert.equal(DEFAULTS.maxContinuations, 2)
})

console.log(`\n全部通过：${passed} 项`)
