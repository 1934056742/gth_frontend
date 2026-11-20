import request, { forceLogout, refreshAccessTokenShared } from './request'
import { getAccessToken } from './tokenStore'
import type {
  AiConversation,
  AiMessage,
  AiMessageRecord,
  AiSource,
  ChatCallbacks,
  ChatStreamHandle
} from '@/types'

// ============ 会话管理（普通 JSON 接口，走统一 axios 实例） ============

// 会话列表（后端按「最近活跃」倒序，已带 messageCount）
export function getConversations() {
  return request.get<AiConversation[]>('/ai/conversations')
}

// 新建空会话（一般不需要：直接 /chat 不传 conversationId，后端会自动建）
export function createConversation(title?: string) {
  return request.post<AiConversation>('/ai/conversations', { title })
}

// 重命名会话
export function renameConversation(id: number, title: string) {
  return request.patch<AiConversation>(`/ai/conversations/${id}`, { title })
}

// 删除会话（后端级联删消息）
export function deleteConversation(id: number) {
  return request.delete(`/ai/conversations/${id}`)
}

// 会话消息（刷新后恢复历史用）
export function getMessages(conversationId: number) {
  return request.get<AiMessage[]>(`/ai/conversations/${conversationId}/messages`)
}

// ============ 流式问答 ============

const API_BASE = import.meta.env.VITE_API_BASE || '/api'

/**
 * 从 SSE 缓冲区里切出完整事件
 *
 * SSE 协议：事件之间用空行分隔，单个事件内可能有多行（event: / data: / id: 等）。
 * 这里把「还完整的部分」按空行切开，剩下的半截留在 buffer 里等下一个 chunk。
 */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let rest = buffer
  let boundary = rest.search(/\r?\n\r?\n/)
  while (boundary !== -1) {
    events.push(rest.slice(0, boundary))
    // 跳过被匹配到的这一整组分隔符（\n\n 或 \r\n\r\n）
    const sep = rest.slice(boundary).match(/^\r?\n\r?\n/)![0]
    rest = rest.slice(boundary + sep.length)
    boundary = rest.search(/\r?\n\r?\n/)
  }
  return { events, rest }
}

/**
 * 解析单个 SSE 事件文本
 * @returns 解析出的事件名与数据；没有 data 行时返回 null
 */
export function parseSseEvent(raw: string): { event: string; data: any } | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue // 空行 / 注释（心跳）
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      // 规范里冒号后可带一个空格，去掉它而不是 trim，避免破坏正文前导空格
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    }
  }
  if (!dataLines.length) return null
  const text = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(text) }
  } catch {
    // 非 JSON 的 data 行按纯文本处理（后端目前都是 JSON）
    return { event, data: { content: text } }
  }
}

/**
 * 把后端推来的来源片段转成页面用的结构
 *
 * 后端字段可能缺失（例如未来改了字段名），这里统一兜底成安全值，
 * 避免界面出现 "undefined" 或 NaN。
 */
export function normalizeSource(raw: any): AiSource {
  const seq = Number(raw?.seq)
  const score = Number(raw?.score)
  return {
    docId: Number(raw?.docId) || 0,
    fileName: String(raw?.fileName ?? '') || '未命名文档',
    seq: Number.isFinite(seq) ? seq : 0,
    score: Number.isFinite(score) ? Math.round(score * 100) / 100 : 0,
    snippet: String(raw?.snippet ?? '')
  }
}

/**
 * 发起一次问答请求（不带重试逻辑，重试由 chatStream 控制）。
 * 每次调用都重新读取访问令牌，保证刷新之后拿到的是最新的那个。
 */
function sendChatRequest(
  params: { question: string; conversationId?: number },
  signal: AbortSignal
): Promise<Response> {
  const token = getAccessToken()
  return fetch(`${API_BASE}/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(params),
    signal
  })
}

/**
 * 提问（SSE 流式）
 *
 * 用 fetch 而不是 axios：axios 的浏览器适配器会把整个响应读完才返回，
 * 拿不到增量；fetch + response.body.getReader() 才能边收边渲染。
 *
 * @returns 控制器：调用 abort() 会中止生成（后端检测到连接关闭后停止转发）
 */
export function chatStream(
  params: { question: string; conversationId?: number },
  callbacks: ChatCallbacks
): ChatStreamHandle {
  // 显式基于 lib.dom 的签名构造，避免 @types/node 里同名全局声明的干扰
  // （本文件同时引了 axios 链上的 node 类型，全局 AbortController 会被它覆盖成不可 new）
  const controller: AbortController = new (globalThis as any).AbortController() as AbortController

  // 异步流程不阻塞调用方，错误统一通过 callbacks.onError 告知
  (async () => {
    try {
      // 双 token：访问令牌 30 分钟就过期，长会话里很容易刚好过期。
      // 这里遇到 401 先用刷新令牌静默换一个新的，再把请求重发一次，
      // 失败（刷新令牌也失效）才回登录页。
      let response = await sendChatRequest(params, controller.signal)

      if (response.status === 401) {
        try {
          await refreshAccessTokenShared()
          response = await sendChatRequest(params, controller.signal)
        } catch {
          // 刷新失败：与 axios 拦截器保持一致，清登录态回登录页
          forceLogout()
          callbacks.onError?.('登录已过期，请重新登录')
          return
        }
      }

      // 出错时后端返回的是普通 JSON（如 404 会话不存在、400 问题为空）
      if (!response.ok) {
        let message = '请求失败，请稍后重试'
        try {
          const data = await response.json()
          message = data?.error || data?.message || message
        } catch {
          /* 非 JSON 响应，用兜底文案 */
        }
        if (response.status === 401) {
          forceLogout()
        }
        callbacks.onError?.(message)
        return
      }

      if (!response.body) {
        callbacks.onError?.('当前浏览器不支持流式响应')
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let fullText = ''
      let done = false

      const dispatch = (rawEvent: string) => {
        const parsed = parseSseEvent(rawEvent)
        if (!parsed) return
        const { event, data } = parsed

        if (event === 'meta') {
          callbacks.onMeta?.({
            conversationId: Number(data?.conversationId),
            title: String(data?.title ?? '')
          })
        } else if (event === 'sources') {
          const list = Array.isArray(data?.sources) ? data.sources : []
          if (list.length) callbacks.onSources?.(list.map(normalizeSource))
        } else if (event === 'delta') {
          const text = String(data?.content ?? '')
          if (!text) return
          fullText += text
          callbacks.onDelta?.(text)
        } else if (event === 'done') {
          done = true
          callbacks.onDone?.({
            messageId: Number(data?.messageId ?? 0),
            content: String(data?.content ?? fullText),
            saved: data?.saved !== false
          })
        } else if (event === 'error') {
          callbacks.onError?.(String(data?.error || '生成失败'))
        }
      }

      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })
        const { events, rest } = splitSseEvents(buffer)
        buffer = rest
        events.forEach(dispatch)
      }
      // 流结束时收尾：可能还有没被空行终结的最后一段
      buffer += decoder.decode()
      if (buffer.trim()) dispatch(buffer)

      // 后端异常断开（没收到 done 事件）也要让页面结束 loading
      if (!done) callbacks.onError?.(fullText ? '回答中断，请重试' : '生成失败，请重试')
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        callbacks.onAbort?.()
      } else {
        callbacks.onError?.(error?.message || '网络异常，请检查网络连接')
      }
    }
  })()

  return {
    abort: () => controller.abort()
  }
}

// ============ 消息转换工具 ============

/**
 * 把后端返回的消息记录转成页面用的消息结构
 * 后端 id 是数据库主键（AI 回复可能还没落库，此时用负数临时 id）
 */
export function toAiMessage(record: AiMessageRecord, index = 0): AiMessage {
  return {
    id: Number(record.id ?? -Date.now() - index),
    role: record.role === 'assistant' ? 'assistant' : 'user',
    content: String(record.content ?? ''),
    createdAt: record.createdAt
  }
}
