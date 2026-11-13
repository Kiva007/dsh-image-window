/**
 * dsh-image-window 单元测试：桩会话复刻官方 surface API 的最小面
 * （surface.nodes / eventAt / deriveEventMessage / append），验证窗口选择逻辑。
 * 运行：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/**
 * @param events [{ type, images, text }] —— images=该节点图片块数，text=是否带文字块
 * deriveEventMessage 会应用已 append 的 offload 事件（块级 offloaded 标记）。
 */
function makeSession(events) {
  const log = events.map((e, i) => ({ type: e.type, seq: i + 1, data: {} }))
  const nodes = log.map((e) => e.seq)
  const offloaded = [] // { seq, imageIndexes }
  return {
    surface: { nodes },
    eventAt: (seq) => log[seq - 1],
    deriveEventMessage(event) {
      const idx = log.indexOf(event)
      if (idx < 0) return null
      const e = events[idx]
      if (e.type !== 'user/message' && e.type !== 'tool/result' && e.type !== 'assistant/message') return null
      const content = []
      if (e.text) content.push({ type: 'text', text: 'hi' })
      for (let k = 0; k < (e.images ?? 0); k += 1) {
        const isOff = offloaded.some((o) => o.seq === event.seq && o.imageIndexes.includes(k))
        content.push(isOff ? { type: 'image', offloaded: true } : { type: 'image' })
      }
      return { role: e.type === 'assistant/message' ? 'assistant' : 'user', content }
    },
    append(type, data) {
      assert.equal(type, 'image/offload')
      offloaded.push(...data.targets)
      this.lastTargets = data.targets
      return { seq: 1000 + offloaded.length }
    },
    lastTargets: [],
    get offloadCount() {
      return offloaded.length
    },
  }
}

/** 活一个 ctx 桩，返回 { ctx, fire }；fire(payload) 跑 agent/pre-step 处理器。 */
function makeCtx(config) {
  let handler
  const ctx = {
    on(name, fn) {
      assert.equal(name, 'agent/pre-step')
      handler = fn
    },
    logger: { info() {}, warn() {}, debug() {} },
  }
  apply(ctx, config)
  return {
    fire(payload) {
      return handler(payload, () => 'decision')
    },
  }
}

const PAYLOAD = (session) => ({
  agent: { session },
  messages: [],
  turn: 1,
  step: 1,
  signal: { throwIfAborted() {} },
})

test('keepSteps=2：窗口外（更早两个步骤之外）的图进 targets，窗口内的不动', async () => {
  const session = makeSession([
    { type: 'user/message', images: 1, text: true }, // seq1：用户粘贴图
    { type: 'assistant/message', text: true }, // seq2
    { type: 'tool/result', images: 1 }, // seq3：第 1 轮截图
    { type: 'assistant/message', text: true }, // seq4
    { type: 'tool/result', images: 1 }, // seq5：第 2 轮截图
    { type: 'assistant/message', text: true }, // seq6
    { type: 'tool/result', images: 1 }, // seq7：第 3 轮截图（最新，stepsAfter=0）
  ])
  const { fire } = makeCtx({ keepSteps: 2 })
  const result = await fire(PAYLOAD(session))
  assert.equal(result, 'decision')
  assert.equal(session.offloadCount, 2) // seq1 与 seq3 各 1 张
})

test('幂等：第二次扫描没有新目标，不重复 append', async () => {
  const session = makeSession([
    { type: 'user/message', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
  ])
  const { fire } = makeCtx({ keepSteps: 2 })
  await fire(PAYLOAD(session))
  assert.equal(session.offloadCount, 2)
  await fire(PAYLOAD(session))
  assert.equal(session.offloadCount, 2)
})

test('assistant 节点的图片永不选（投影校验 target 类型）', async () => {
  const session = makeSession([
    { type: 'assistant/message', images: 3 },
    { type: 'assistant/message', images: 3 },
    { type: 'assistant/message', images: 3 },
    { type: 'assistant/message', images: 3 },
    { type: 'assistant/message', images: 3 },
  ])
  const { fire } = makeCtx({ keepSteps: 0 })
  await fire(PAYLOAD(session))
  assert.equal(session.offloadCount, 0)
})

test('同节点多图：下标严格递增，文字块不占位', async () => {
  const session = makeSession([
    { type: 'user/message', images: 3, text: true },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
  ])
  const { fire } = makeCtx({ keepSteps: 2 })
  await fire(PAYLOAD(session))
  // 窗口外 = seq3（第 1 轮截图，stepsAfter=2）+ seq1（用户消息，stepsAfter=3）
  assert.equal(session.offloadCount, 2)
  assert.deepEqual(session.lastTargets, [
    { seq: 3, imageIndexes: [0] },
    { seq: 1, imageIndexes: [0, 1, 2] }, // 文字块在前但不计 imageIndex
  ])
})

test('keepSteps=0：连当前步的图也立刻 offload（最激进）', async () => {
  const session = makeSession([
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 2 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
  ])
  const { fire } = makeCtx({ keepSteps: 0 })
  await fire(PAYLOAD(session))
  // stepsAfter < 0 永不成立 → 三个节点的图全部 offload（1+2+1 个 target）
  assert.equal(session.offloadCount, 3)
})

test('keepSteps=1：只保留当前步，更早的全部 offload', async () => {
  const session = makeSession([
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 2 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
  ])
  const { fire } = makeCtx({ keepSteps: 1 })
  await fire(PAYLOAD(session))
  // 最新一步（seq5）保留；seq1 + seq3 进 targets
  assert.equal(session.offloadCount, 2)
  assert.deepEqual(session.lastTargets, [
    { seq: 3, imageIndexes: [0, 1] },
    { seq: 1, imageIndexes: [0] },
  ])
})

test('没有图片 / 空 surface：不 append', async () => {
  const session = makeSession([
    { type: 'user/message', text: true },
    { type: 'assistant/message', text: true },
    { type: 'tool/result', text: true },
    { type: 'assistant/message', text: true },
    { type: 'tool/result', text: true },
  ])
  const { fire } = makeCtx({ keepSteps: 2 })
  await fire(PAYLOAD(session))
  assert.equal(session.offloadCount, 0)

  const empty = makeSession([])
  await fire(PAYLOAD(empty))
  assert.equal(empty.offloadCount, 0)
})

test('非消息事件节点被跳过', async () => {
  const session = makeSession([
    { type: 'turn/start' },
    { type: 'user/message', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
    { type: 'turn/end' },
  ])
  const { fire } = makeCtx({ keepSteps: 2 })
  await fire(PAYLOAD(session))
  // turn/start、turn/end 既不计步骤也不选图；窗口外 = seq4 + seq2 两个 target
  assert.equal(session.offloadCount, 2)
  assert.deepEqual(session.lastTargets, [
    { seq: 4, imageIndexes: [0] },
    { seq: 2, imageIndexes: [0] },
  ])
})

test('缺投影时停摆而不是每步抛', async () => {
  const session = makeSession([
    { type: 'user/message', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
    { type: 'assistant/message' },
    { type: 'tool/result', images: 1 },
  ])
  session.append = () => {
    throw new Error('session message projection "image/offload" was removed or replaced; restore the session with its owning plugin')
  }
  const warnings = []
  const ctx = {
    on(name, fn) {
      this.handler = fn
    },
    logger: { info() {}, warn: (m) => warnings.push(m), debug() {} },
  }
  apply(ctx, { keepSteps: 2 })
  const payload = PAYLOAD(session)
  const r1 = await ctx.handler(payload, () => 'decision')
  assert.equal(r1, 'decision') // 不把错误冒泡出瀑布
  assert.equal(warnings.length, 1)
  const r2 = await ctx.handler(payload, () => 'decision')
  assert.equal(r2, 'decision')
  assert.equal(warnings.length, 1) // 停摆后不再刷
})
