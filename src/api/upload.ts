import request from './request'
import { getAccessToken } from './tokenStore'
import type {
  CheckFileParams,
  CheckFileResult,
  UploadChunkResult,
  UploadFileItem,
  UploadFileQuery
} from '@/types'

// 查询文件的上传状态：用于秒传（exists=true）与断点续传（返回已上传分片）
export function checkFile(data: CheckFileParams) {
  return request.post<CheckFileResult>('/upload/check', data)
}

// 上传单个分片
// 说明：分片上传的进度通过 XMLHttpRequest 单独上报，这里不再声明 onProgress 参数
export function uploadChunk(data: FormData, signal?: AbortSignal) {
  return request.post<UploadChunkResult>('/upload/chunk', data, {
    timeout: 0,
    signal,
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

// 手动合并分片（服务端不支持自动合并时可使用）
export function mergeChunks(data: CheckFileParams) {
  return request.post<UploadFileItem>('/upload/merge', data)
}

// 获取已上传文件列表
// 说明：默认只返回当前登录人自己的文件；可选按分类 / 任务筛选
export function getFiles(query: UploadFileQuery = {}) {
  return request.get<UploadFileItem[]>('/upload/files', { params: query })
}

// 删除已上传文件
export function deleteFile(id: number) {
  return request.delete(`/upload/files/${id}`)
}

// ============ 预览地址 ============
// 背景：<video>/<audio>/<iframe>/<img> 都无法携带 Authorization 头，
//      所以不能直接指向需要带 token 的下载接口。
//
// 两种方案与取舍：
//   1) blob（老方案）：fetch 带 token 把整个文件读进内存 → createObjectURL。
//      小文件没问题，但视频会「全量下载完才能播」、不能真正流式、内存翻倍。
//   2) 直链 + 短期票据（现在用的）：后端签发一个绑定了文件 id 的短时效 token，
//      拼进 URL 的 query。浏览器组件直接请求该地址，天然支持 HTTP Range，
//      可以边下边播、任意拖动，内存占用恒定。
//
// 票据只是「访问凭证」，不是登录态：它只能读一个文件、几分钟后失效，
// 即使出现在日志/历史记录里，风险也可控。

/** 预览直链的有效期（毫秒），与后端签发保持一致，仅用于前端提前刷新 */
const PREVIEW_TOKEN_TTL = 5 * 60 * 1000

/**
 * 生成文件的预览直链（带短期票据）。
 * 后端下载接口已按文件类型返回正确 MIME + inline，并支持 Range，
 * 所以这个地址可以直接塞给 <video src> / <iframe src> 使用。
 */
export function getPreviewUrl(id: number, options: { download?: boolean } = {}): string {
  const baseURL = import.meta.env.VITE_API_BASE || '/api'
  const token = getAccessToken()
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (options.download) params.set('download', '1')
  const query = params.toString()
  return `${baseURL}/upload/files/${id}/download${query ? `?${query}` : ''}`
}

/** 预览直链的有效期（供组件判断是否需要刷新地址） */
export function getPreviewTtl(): number {
  return PREVIEW_TOKEN_TTL
}

// 取文件内容用于在线预览（blob 方案，仅用于文本类文件）
// 说明：文本需要读成字符串，仍然走 blob；图片/视频/音频/PDF 已改用 getPreviewUrl 直链。
//      调用方拿到 URL 后要在关闭预览时调用 URL.revokeObjectURL 释放内存。
export async function fetchFileBlobUrl(id: number, mime?: string): Promise<string> {
  const baseURL = import.meta.env.VITE_API_BASE || '/api'
  const token = getAccessToken()
  const response = await fetch(`${baseURL}/upload/files/${id}/download?download=1`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
  if (!response.ok) {
    let message = '加载文件失败'
    try {
      const data = await response.json()
      if (data && data.error) message = data.error
    } catch {
      /* 忽略解析错误 */
    }
    throw new Error(message)
  }
  const raw = await response.blob()
  // 类型一致时直接用原 blob，避免多复制一份内容
  const blob =
    mime && mime !== 'application/octet-stream' && raw.type !== mime
      ? new Blob([raw], { type: mime })
      : raw
  return URL.createObjectURL(blob)
}

// 下载已上传文件（支持大文件）
// 说明：下载接口需要鉴权（Authorization 头由请求拦截器自动带上），
//      普通 window.open 无法携带 token，因此改为 fetch + 流式读取，
//      边下载边写入磁盘（File System Access API），避免把整个文件塞进内存。
//      浏览器不支持该 API 时，回退到 blob 方式（文件会占用同等大小的内存）。
export async function downloadFile(
  id: number,
  fileName: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const baseURL = import.meta.env.VITE_API_BASE || '/api'
  const token = getAccessToken()
  const url = `${baseURL}/upload/files/${id}/download`

  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(signal ? { signal } : {})
  })
  if (!response.ok) {
    // 后端错误统一返回 JSON，这里尽量解析出 error 文案
    let message = '下载失败'
    try {
      const data = await response.json()
      if (data && data.error) message = data.error
    } catch {
      /* 忽略解析错误 */
    }
    throw new Error(message)
  }

  const total = Number(response.headers.get('content-length') || 0)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('当前浏览器不支持流式下载')

  // 优先使用 File System Access API：流式写盘，内存占用恒定
  const picker = (window as any).showSaveFilePicker as
    | ((options: any) => Promise<any>)
    | undefined
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: '文件', accept: { 'application/octet-stream': ['.*'] } }]
      })
      const writable = await handle.createWritable()
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await writable.write(value)
        received += value.byteLength
        if (total) onProgress?.(Math.min((received / total) * 100, 100))
      }
      await writable.close()
      onProgress?.(100)
      return
    } catch (error) {
      // 用户取消另存为：直接结束，不再走 blob 回退
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }
      // 其他异常（权限/不支持）走下方 blob 回退
    }
  }

  // 回退方案：分块读取后拼成 Blob，再触发浏览器下载
  const parts: BlobPart[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value as BlobPart)
    received += value.byteLength
    if (total) onProgress?.(Math.min((received / total) * 100, 100))
  }
  const blob = new Blob(parts, {
    type: response.headers.get('content-type') || 'application/octet-stream'
  })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // 释放内存（延迟一点，避免部分浏览器下载未开始就失效）
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  onProgress?.(100)
}

