import request from './request'
import { getAccessToken } from './tokenStore'
import type { KnowledgeDoc, KnowledgeDocDetail } from '@/types'

// ============ RAG 知识库 ============
// 后端支持的格式：纯文本类（直接按 UTF-8 解码）+ Word(.docx) + PDF（用解析库抽取文字）。
// 这里把同一份白名单复制到前端，用来在选文件时提前拦掉不支持的格式，
// 少一次「上传完才报错」的往返。
// 说明：真正的校验在后端 src/knowledgeRoutes.ts 的 extractText 里，前端只是体验优化。

export const KNOWLEDGE_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'xml', 'yml', 'yaml',
  'js', 'ts', 'css', 'html', 'sql', 'ini', 'conf',
  'docx', 'pdf'
] as const

/** 需要后端解析库抽取文字的格式（提示文案里单独说明） */
export const KNOWLEDGE_DOC_EXTENSIONS = ['docx', 'pdf'] as const

/** 单文件上限（与后端 RAG_MAX_DOC_SIZE 默认值一致：10MB） */
export const KNOWLEDGE_MAX_SIZE = 10 * 1024 * 1024

/** el-upload 的 accept 属性，同时也是文件选择框里的过滤条件 */
export const KNOWLEDGE_ACCEPT = KNOWLEDGE_EXTENSIONS.map((ext) => `.${ext}`).join(',')

/** 取小写扩展名（无扩展名 / 隐藏文件返回空串） */
export function getFileExt(fileName: string): string {
  const name = String(fileName || '').trim()
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * 上传前的前端校验
 * @returns 不通过时返回给用户看的提示，通过返回空串
 */
export function validateKnowledgeFile(file: { name: string; size: number }): string {
  const ext = getFileExt(file.name)
  if (!ext) return '文件没有扩展名，无法识别格式'
  // .doc 是 Word 97-2003 的二进制旧格式，解析不了，单独给一句能照做的提示
  if (ext === 'doc') return '不支持 .doc 旧格式，请用 Word 另存为 .docx 后再上传'
  if (!(KNOWLEDGE_EXTENSIONS as readonly string[]).includes(ext)) {
    return `暂不支持 .${ext} 格式，请上传 txt / md / docx / pdf 等文件`
  }
  if (file.size > KNOWLEDGE_MAX_SIZE) {
    return `文件超过 ${Math.round(KNOWLEDGE_MAX_SIZE / 1024 / 1024)}MB，请拆分后再上传`
  }
  if (file.size === 0) return '文件内容为空'
  return ''
}

/** 文档列表（普通成员只返回自己的，管理员返回全部） */
export function getKnowledgeDocs() {
  return request.get<KnowledgeDoc[]>('/knowledge/docs')
}

/**
 * 文档详情：列表里点「查看」时调用
 *
 * 返回解析后的正文全文，用于在弹窗里阅读文档内容
 * （知识库只存文本，docx / pdf 返回的是抽取出来的文字）。
 */
export function getKnowledgeDocDetail(id: number) {
  return request.get<KnowledgeDocDetail>(`/knowledge/docs/${id}`)
}

/**
 * 上传文档并建立索引
 *
 * 用 fetch 而不是 axios：与 ai.ts 的流式请求同理，这里需要拿到
 * 后端返回的具体错误文案（例如「文件不是 UTF-8 编码」），
 * 让 el-upload 的 onError 能原样展示，而不用再猜 axios 的错误结构。
 */
export async function uploadKnowledgeDoc(file: File): Promise<KnowledgeDoc> {
  const baseURL = import.meta.env.VITE_API_BASE || '/api'
  const token = getAccessToken()
  const form = new FormData()
  // 字段名必须是 file（后端 parseMultipartWithFile 按 name="file" 取）
  form.append('file', file, file.name)

  const response = await fetch(`${baseURL}/knowledge/docs`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form
  })

  if (!response.ok) {
    let message = '上传失败，请稍后重试'
    try {
      const data = await response.json()
      message = data?.error || data?.message || message
    } catch {
      /* 非 JSON 响应，用兜底文案 */
    }
    throw new Error(message)
  }
  return (await response.json()) as KnowledgeDoc
}

/** 删除文档（后端级联删除切块） */
export function deleteKnowledgeDoc(id: number) {
  return request.delete(`/knowledge/docs/${id}`)
}

/** 检索调试：只查不答，用于确认「问的问题能不能召回资料」 */
export function searchKnowledge(query: string) {
  return request.post('/knowledge/search', { query })
}

/** 把字节数格式化成易读文本 */
export function formatFileSize(bytes: number): string {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
