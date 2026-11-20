import { marked } from 'marked'

/**
 * Markdown 渲染工具（AI 回答展示用）
 *
 * 说明：
 *   - 用 marked 渲染成 HTML，渲染前先转义 HTML 里的尖括号 / 引号，
 *     避免模型输出（或知识库内容）里的 <script> 被当成标签执行；
 *   - 流式输出时，代码块往往「还没闭合」，这里自动补齐 ``` 与 **，避免整段样式错乱。
 */

// 把可能构成 HTML 标签 / 属性的字符转成实体（只要不出现标签，innerHTML 就安全）
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 补全流式输出里未闭合的语法
 * - 未闭合的代码块：追加 ```
 * - 落单的行内反引号：追加 `
 */
export function balanceMarkdown(input: string): string {
  const text = String(input ?? '')
  const fenceCount = (text.match(/```/g) || []).length
  let result = text
  if (fenceCount % 2 === 1) result += '\n```'
  // 去掉代码块后统计行内反引号（成对出现才是正常的行内代码）
  const withoutFence = result.replace(/```[\s\S]*?```/g, '')
  const ticks = (withoutFence.match(/`/g) || []).length
  if (ticks % 2 === 1) result += '`'
  return result
}

/**
 * Markdown → 安全的 HTML 字符串
 * @param streaming 是否仍在流式输出（为 true 时先补全未闭合语法）
 */
export function renderMarkdown(input: string, streaming = false): string {
  const source = streaming ? balanceMarkdown(input) : String(input ?? '')
  if (!source.trim()) return ''
  const html = marked.parse(escapeHtml(source), {
    async: false,
    gfm: true,
    breaks: true
  }) as string
  return html
}
