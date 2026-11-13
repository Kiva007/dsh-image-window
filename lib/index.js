/**
 * dsh-image-window —— 图片滑动窗口（主动 offload，阈值=最近 N 个 assistant 步骤）
 *
 * 要解决的问题：computer-use 插件的截图作为 attachment 内联进会话后，会跟着
 * 历史每轮重编码重发（dsh-llm-pi-ai 源码注释原话："Every image in history is
 * re-encoded into every request body"）。DSH 唯一的自动清理
 * （@deepseek-ai/dsh-compaction-image-offload）只在请求图片总量爆了 pi-ai 的
 * 20MiB 闸（IMAGE_OFFLOAD_REQUIRED）时才兜底 offload 最旧的 N 张——是兜底，
 * 不是治理；不到闸就一路攒着（实测 SEER-RE 会话 23 张截图攒到上游 ack 超时）。
 *
 * 本插件把同一套 offload 机制改成主动滑动窗口：每个 agent 步骤的请求前，把
 * 「最近 keepSteps 个 assistant 步骤之外」的图片块标记 offloaded。渲染完全复用
 * 官方链路，本插件不注册自己的消息投影（同 type 重复注册会直接抛错）：
 *   1) 这里只追加 `image/offload` 事件（与官方插件完全相同的数据形状）；
 *   2) dsh-compaction-image-offload 注册的投影把事件折叠成 block.offloaded=true；
 *   3) dsh-llm 构建请求时把这些块投影成占位符文本，带本地只读路径
 *      （"Normalized copy (read-only...): <path>"），模型需要时可用 read_image 读回。
 *
 * 阈值语义（keepSteps，默认 2）：
 *   从 surface 末端向前数，assistant/message 节点计一个"步骤"；
 *   user/message 与 tool/result 节点里、位于最近 keepSteps 个步骤之外的图片块
 *   （且尚未 offloaded）全部进 targets，一次 append 一个事件。
 *   keepSteps=2 = 只保留最后两轮动作的截图，更早的变占位符；
 *   keepSteps=0 = 当前步之外的图全部立刻 offload（最激进）。
 *   assistant 节点的图片永不选（投影校验 target 必须是 user/message 或 tool/result）。
 *
 * 依赖：@deepseek-ai/dsh-compaction-image-offload 必须同在（dsh-base bundle
 * 内置，桌面 profile 默认启用）。它不在场时 append 会抛 projection 相关错误，
 * 本插件对该会话记一次 warn 并停摆，不会每步刷错误。
 *
 * 幂等：已 offloaded 的块跳过；没有新目标就不 append。compaction 把旧节点
 * 替换掉后，后续扫描自然看不到它们（与官方插件同口径）。
 */
const DEFAULT_KEEP_STEPS = 2

/** 阈值清洗：非安全整数或负数回退默认值。 */
function normalizeKeepSteps(value) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isSafeInteger(n) || n < 0) return DEFAULT_KEEP_STEPS
  return n
}

/**
 * 收集窗口外、尚未 offload 的图片出现。
 * @param session 活会话（agent.session）
 * @param keepSteps 保留最近多少个 assistant 步骤内的图片
 * @returns [{ seq, imageIndexes }] —— 与官方 offloadOldestImages 同形状
 */
function collectWindowTargets(session, keepSteps) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return []
  const targets = []
  let stepsAfter = 0
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const seq = nodes[i]
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    if (event === undefined || event === null) continue
    if (event.type === 'assistant/message') {
      stepsAfter += 1
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    if (stepsAfter < keepSteps) continue
    let message
    try {
      message = session.deriveEventMessage(event)
    } catch {
      continue
    }
    const content = message?.content
    if (!Array.isArray(content)) continue
    const imageIndexes = []
    let imageIndex = 0
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'image') {
        if (block.offloaded !== true) imageIndexes.push(imageIndex)
        imageIndex += 1
      }
    }
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  return targets
}

export const name = 'dsh-image-window'

/**
 * @param ctx cordis 插件上下文
 * @param config loader 条目配置（cordis.patch.yml 的 config 段）：{ keepSteps }
 */
export function apply(ctx, config) {
  const keepSteps = normalizeKeepSteps(config?.keepSteps)
  /** 因缺投影而停摆的会话（WeakSet 语义用 Set，会话对象随进程生命周期）。 */
  const disabled = /* @__PURE__ */ new Set()
  /** 已打过首条 info 日志的会话。 */
  const announced = /* @__PURE__ */ new Set()

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    const session = agent?.session
    const signal = payload?.signal
    try {
      if (signal !== undefined && signal !== null && typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
      if (session === undefined || session === null) return next()
      if (disabled.has(session)) return next()
      const targets = collectWindowTargets(session, keepSteps)
      if (targets.length === 0) return next()
      const count = targets.reduce((sum, target) => sum + target.imageIndexes.length, 0)
      session.append('image/offload', { targets })
      if (announced.has(session)) {
        ctx.logger?.debug?.(`[image-window] offloaded ${count} image(s) outside the ${keepSteps}-step window`)
      } else {
        announced.add(session)
        ctx.logger?.info?.(`[image-window] keepSteps=${keepSteps}: offloaded ${count} image(s) outside the window (placeholder keeps a read-only path; read_image to fetch)`)
      }
    } catch (error) {
      const text = String(error?.message ?? error)
      if (session !== undefined && session !== null && /projection/i.test(text)) {
        // image/offload 无人投影（dsh-compaction-image-offload 不在场）：停摆本插件。
        disabled.add(session)
        ctx.logger?.warn?.(`[image-window] disabled for this session (no image/offload projection): ${text}`)
      } else {
        ctx.logger?.debug?.(`[image-window] sweep skipped: ${text}`)
      }
    }
    return next()
  })
}
