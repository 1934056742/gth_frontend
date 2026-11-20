import { describe, it, expect } from 'vitest'
import { renderMarkdown, balanceMarkdown } from './markdown'

describe('balanceMarkdown', () => {
  it('未闭合的代码块自动补齐收尾标记', () => {
    const out = balanceMarkdown('下面是示例：\n```js\nconst a = 1')
    expect(out.endsWith('```')).toBe(true)
    expect((out.match(/```/g) || []).length).toBe(2)
  })

  it('已闭合的代码块不再追加', () => {
    const text = '```js\nconst a = 1\n```'
    expect(balanceMarkdown(text)).toBe(text)
  })

  it('落单的行内反引号会被补齐', () => {
    expect(balanceMarkdown('用 `npm test 跑测试')).toBe('用 `npm test 跑测试`')
  })

  it('空输入不报错', () => {
    expect(balanceMarkdown('')).toBe('')
    expect(balanceMarkdown(undefined as unknown as string)).toBe('')
  })
})

describe('renderMarkdown', () => {
  it('渲染标题与列表', () => {
    const html = renderMarkdown('## 小标题\n\n- 第一条\n- 第二条')
    expect(html).toContain('<h2>小标题</h2>')
    expect(html).toContain('<li>第一条</li>')
  })

  it('渲染代码块并保留代码内容', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('<code')
    expect(html).toContain('const a = 1')
  })

  it('转义 HTML，防止脚本注入', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('流式模式下自动补全未闭合代码块', () => {
    const html = renderMarkdown('```js\nconst a = 1', true)
    expect(html).toContain('const a = 1')
    expect(html).toContain('<code')
  })

  it('空内容返回空字符串', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   ')).toBe('')
  })
})
