// ============ 任务详情页：文件预览 / 下载相关工具 ============
// 抽成纯函数放 utils 里，方便单测（组件里拿不到逻辑分支的覆盖）

/** 文件类型归类：决定「查看」按钮的行为 */
export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other'

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']
const VIDEO_EXT = ['mp4', 'webm', 'ogv', 'mov', 'm4v']
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']
const TEXT_EXT = [
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'xml', 'yml', 'yaml',
  'js', 'ts', 'css', 'html', 'sql', 'ini', 'conf'
]

/** 取小写扩展名（没有扩展名返回空串） */
export function getFileExt(fileName: string): string {
  const name = (fileName || '').trim()
  const dot = name.lastIndexOf('.')
  // dot <= 0 的情况：没有点，或者是以点开头的隐藏文件（如 .gitignore，没有扩展名）
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * 按扩展名判断文件类型。
 * 浏览器能直接渲染的（图片 / 视频 / 音频 / PDF）走 <img> / <video> / <audio> / <iframe>，
 * 文本类走 <pre> 展示，其余一律「不支持预览，请下载后查看」。
 */
export function getFileKind(fileName: string): FileKind {
  const ext = getFileExt(fileName)
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXT.includes(ext)) return 'text'
  return 'other'
}

/** 该文件是否支持在当前页面直接查看 */
export function canPreview(fileName: string): boolean {
  return getFileKind(fileName) !== 'other'
}

/** 文件大小格式化：1.2 MB / 320 KB */
export function formatFileSize(bytes?: number): string {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size < 0) return '-'
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  // 小体积保留两位便于区分（如 320.7 KB），大体积一位足够
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

/** 文件列表里展示的简短类型标签，如 PDF / 视频 / 图片 */
export function getFileKindLabel(fileName: string): string {
  const map: Record<FileKind, string> = {
    image: '图片',
    video: '视频',
    audio: '音频',
    pdf: 'PDF',
    text: '文本',
    other: '其他'
  }
  return map[getFileKind(fileName)]
}

/** 预览用布尔的 blob MIME：后端统一按 octet-stream 返回，这里按扩展名纠正，否则浏览器不渲染 */
export function getBlobMime(fileName: string): string {
  return exactMime(getFileExt(fileName))
}

/**
 * 扩展名 → MIME 的完整映射表（与后端 backend/src/mime.ts 保持同一份口径）。
 * 抽成独立函数，方便后端同学对照，也方便单测直接校验映射本身。
 */
function exactMime(ext: string): string {
  const exact: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    mov: 'video/quicktime',
    m4v: 'video/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    txt: 'text/plain',
    md: 'text/plain',
    markdown: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    log: 'text/plain',
    xml: 'application/xml',
    yml: 'text/plain',
    yaml: 'text/plain',
    js: 'text/plain',
    ts: 'text/plain',
    css: 'text/plain',
    html: 'text/plain',
    sql: 'text/plain',
    ini: 'text/plain',
    conf: 'text/plain'
  }
  return exact[ext] || 'application/octet-stream'
}
