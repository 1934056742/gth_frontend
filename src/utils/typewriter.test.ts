import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTypewriter } from './typewriter'

describe('createTypewriter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 创建一个把每次更新都记录下来的打字机 */
  function setup(opts: Partial<Parameters<typeof createTypewriter>[0]> = {}) {
    const updates: string[] = []
    const onDrain = vi.fn()
    const writer = createTypewriter({
      onUpdate: (text) => updates.push(text),
      onDrain,
      ...opts
    })
    return { writer, updates, onDrain }
  }

  it('增量不会立刻全部展示，而是按帧逐步吐出', () => {
    const { writer, updates } = setup({ charsPerFrame: 2, frameInterval: 16 })

    writer.push('0123456789')
    // 还没走定时器，界面上一片空白（这是打字机效果的前提）
    expect(writer.getText()).toBe('')
    expect(writer.pending()).toBe(10)

    vi.advanceTimersByTime(16)
    expect(writer.getText()).toBe('01')

    vi.advanceTimersByTime(16)
    expect(writer.getText()).toBe('0123')

    expect(updates).toEqual(['01', '0123'])
    writer.stop()
  })

  it('内容最终会完整吐出，不丢字', () => {
    const { writer } = setup({ charsPerFrame: 2, frameInterval: 16 })

    const chunks = ['JavaScript', ' ', '事件', '循环', '是', '异步', '的核心']
    chunks.forEach((c) => writer.push(c))
    writer.finish()
    vi.advanceTimersByTime(5000)

    expect(writer.getText()).toBe(chunks.join(''))
    expect(writer.pending()).toBe(0)
    expect(writer.isDone()).toBe(true)
  })

  it('积压变多时会自动加速，不会越落越远', () => {
    const { writer } = setup({ charsPerFrame: 2, frameInterval: 16, rushThreshold: 10 })

    // 模拟网络突发：一次性灌入大量积压
    writer.push('a'.repeat(300))
    vi.advanceTimersByTime(16)
    const firstStep = writer.getText().length
    // 积压远超阈值，单帧应吐出多于基础的 2 个字
    expect(firstStep).toBeGreaterThan(2)
    writer.stop()
  })

  it('finish() 后进入冲刺模式，很快排空队列', () => {
    const { writer, onDrain } = setup({ charsPerFrame: 2, frameInterval: 16 })

    writer.push('a'.repeat(200))
    writer.finish()
    // 冲刺模式下几帧内就应刷完
    vi.advanceTimersByTime(200)

    expect(writer.getText().length).toBe(200)
    expect(onDrain).toHaveBeenCalledTimes(1)
  })

  it('onDrain 只会触发一次', () => {
    const { writer, onDrain } = setup()

    writer.push('abc')
    writer.finish()
    vi.advanceTimersByTime(5000)
    vi.advanceTimersByTime(5000)

    expect(onDrain).toHaveBeenCalledTimes(1)
  })

  it('没有积压时 finish() 立即回调，不空转', () => {
    const { writer, onDrain } = setup()

    writer.finish()
    expect(onDrain).toHaveBeenCalledTimes(1)
    expect(writer.isDone()).toBe(true)
  })

  it('flush() 立即吐出全部剩余内容（用户点停止生成）', () => {
    const { writer } = setup({ charsPerFrame: 1, frameInterval: 16 })

    writer.push('hello world')
    writer.flush()

    expect(writer.getText()).toBe('hello world')
    expect(writer.pending()).toBe(0)
  })

  it('stop() 之后不再更新界面', () => {
    const { writer, updates } = setup({ charsPerFrame: 1, frameInterval: 16 })

    writer.push('abcdef')
    writer.stop()
    vi.advanceTimersByTime(1000)

    expect(updates).toEqual([])
    expect(writer.getText()).toBe('')
  })

  it('push 空字符串不会启动无意义的定时器', () => {
    const { writer, updates } = setup()

    writer.push('')
    vi.advanceTimersByTime(100)

    expect(updates).toEqual([])
    writer.stop()
  })

  it('中文与 emoji 不会被截断成乱码', () => {
    const { writer } = setup({ charsPerFrame: 1, frameInterval: 16 })

    writer.push('事件循环 🚀 完成')
    writer.finish()
    vi.advanceTimersByTime(5000)

    expect(writer.getText()).toBe('事件循环 🚀 完成')
  })
})
