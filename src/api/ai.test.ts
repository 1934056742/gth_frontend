import { describe, it, expect } from 'vitest'
import { splitSseEvents, parseSseEvent, toAiMessage } from './ai'

describe('splitSseEvents', () => {
  it('按空行切出完整事件，半截留在 rest', () => {
    const buffer = 'event: meta\ndata: {"a":1}\n\nevent: delta\ndata: {"content":"你'
    const { events, rest } = splitSseEvents(buffer)
    expect(events).toEqual(['event: meta\ndata: {"a":1}'])
    expect(rest).toBe('event: delta\ndata: {"content":"你')
  })

  it('支持 \\r\\n\\r\\n 分隔', () => {
    const { events, rest } = splitSseEvents('event: done\r\ndata: {}\r\n\r\n')
    expect(events).toEqual(['event: done\r\ndata: {}'])
    expect(rest).toBe('')
  })

  it('一次多个事件全部返回', () => {
    const { events } = splitSseEvents('event: a\ndata: {}\n\nevent: b\ndata: {}\n\n')
    expect(events.length).toBe(2)
  })

  it('没有完整事件时 events 为空', () => {
    const { events, rest } = splitSseEvents('event: meta\ndata:')
    expect(events).toEqual([])
    expect(rest).toBe('event: meta\ndata:')
  })
})

describe('parseSseEvent', () => {
  it('解析事件名与 JSON 数据', () => {
    expect(parseSseEvent('event: delta\ndata: {"content":"你好"}')).toEqual({
      event: 'delta',
      data: { content: '你好' }
    })
  })

  it('没有 event 行时默认 message', () => {
    expect(parseSseEvent('data: {"content":"x"}')?.event).toBe('message')
  })

  it('多行 data 拼起来解析', () => {
    const parsed = parseSseEvent('event: delta\ndata: {"content":\ndata: "换行"}')
    expect(parsed?.data.content).toBe('换行')
  })

  it('非 JSON 的 data 按纯文本处理', () => {
    expect(parseSseEvent('event: delta\ndata: 纯文本')).toEqual({
      event: 'delta',
      data: { content: '纯文本' }
    })
  })

  it('忽略注释心跳行，没有 data 时返回 null', () => {
    expect(parseSseEvent(': ping')).toBeNull()
    expect(parseSseEvent('event: done')).toBeNull()
  })
})

describe('toAiMessage', () => {
  it('assistant 角色原样保留', () => {
    const msg = toAiMessage({ id: 3, role: 'assistant', content: 'hi' })
    expect(msg).toEqual({ id: 3, role: 'assistant', content: 'hi', createdAt: undefined })
  })

  it('未知角色按 user 处理，缺 id 时生成负数临时 id', () => {
    const msg = toAiMessage({ role: 'system', content: 'x' } as any, 1)
    expect(msg.role).toBe('user')
    expect(msg.id).toBeLessThan(0)
  })
})
