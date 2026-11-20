/**
 * 打字机缓冲（Typewriter Buffer）
 *
 * 背景：后端（deepseek-chat）的流式粒度是每块 1~2 个字，但吐字速率高达
 * 300+ 字/秒，远超人的阅读速度；而且多个 SSE 事件常常挤在同一毫秒到达，
 * 浏览器会按帧合批渲染，视觉上就变成「先冒出几个字 → 停住 → 一下子全出来」。
 *
 * 做法：把收到的增量先放进待输出队列，由定时器按稳定速率逐帧取出追加到
 * 展示文本上，让界面按照可控的节奏「打字」，而不是跟着网络脉冲跳动。
 *
 * 关键设计：
 *   1. 自适应当前帧吐出字数 —— 积压越多吐得越快，保证不会越落越远。
 *   2. 流结束时进入冲刺模式，以更高速度把剩余内容刷完，避免用户等太久。
 *   3. 与 UI 框架解耦：纯函数 + 定时器，方便单测。
 */

export interface TypewriterOptions {
  /** 每帧基础吐出字数 */
  charsPerFrame?: number
  /** 帧间隔（毫秒），约等于 16ms（60fps） */
  frameInterval?: number
  /** 积压超过该字数后开始加速 */
  rushThreshold?: number
  /** 最大加速倍数 */
  maxSpeedUp?: number
  /** 流结束后的冲刺倍数 */
  finishSpeedUp?: number
  /** 展示文本更新回调 */
  onUpdate: (text: string) => void
  /** 队列排空且已结束后回调 */
  onDrain?: () => void
}

export interface TypewriterWriter {
  /** 追加新到达的增量 */
  push: (delta: string) => void
  /** 标记流已结束，进入冲刺模式刷完剩余内容 */
  finish: () => void
  /** 立即把剩余内容全部吐出并停止（例如用户点停止生成） */
  flush: () => void
  /** 停止定时器，不再回调 */
  stop: () => void
  /** 当前展示文本 */
  getText: () => string
  /** 还没吐出来的字数 */
  pending: () => number
  /** 是否已彻底结束 */
  isDone: () => boolean
}

export function createTypewriter(options: TypewriterOptions): TypewriterWriter {
  const {
    charsPerFrame = 2,
    frameInterval = 16,
    rushThreshold = 24,
    maxSpeedUp = 6,
    finishSpeedUp = 4,
    onUpdate,
    onDrain
  } = options

  let shown = '' // 已展示的文本
  let queue = '' // 待输出积压
  let timer: ReturnType<typeof setInterval> | null = null
  let finished = false // 数据源已结束
  let drained = false // 已经排空并回调过
  let stopped = false

  function clearTimer() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /** 计算这一帧应该吐出多少字 */
  function frameBudget(): number {
    if (finished) {
      // 已结束：冲刺，尽快刷完
      return Math.max(1, Math.ceil(queue.length / 4), charsPerFrame * finishSpeedUp)
    }
    if (queue.length <= rushThreshold) return charsPerFrame
    // 积压越多加速越明显，但不超过上限
    const speedUp = Math.min(maxSpeedUp, 1 + (queue.length - rushThreshold) / rushThreshold)
    return Math.max(1, Math.round(charsPerFrame * speedUp))
  }

  function tick() {
    if (stopped) return

    if (queue.length > 0) {
      const take = Math.min(queue.length, frameBudget())
      shown += queue.slice(0, take)
      queue = queue.slice(take)
      onUpdate(shown)
    }

    if (queue.length === 0 && finished) {
      clearTimer()
      if (!drained) {
        drained = true
        onDrain?.()
      }
    }
  }

  function ensureTimer() {
    if (timer === null && !stopped) timer = setInterval(tick, frameInterval)
  }

  return {
    push(delta: string) {
      if (stopped || !delta) return
      queue += delta
      ensureTimer()
    },

    finish() {
      finished = true
      // 队列早已空了：直接结束，不用等下一帧
      if (queue.length === 0) {
        clearTimer()
        if (!drained) {
          drained = true
          onDrain?.()
        }
        return
      }
      ensureTimer()
    },

    flush() {
      if (queue.length > 0) {
        shown += queue
        queue = ''
        onUpdate(shown)
      }
      finished = true
      clearTimer()
      if (!drained) {
        drained = true
        onDrain?.()
      }
    },

    stop() {
      stopped = true
      clearTimer()
    },

    getText: () => shown,
    pending: () => queue.length,
    isDone: () => finished && queue.length === 0
  }
}
