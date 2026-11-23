import OSS from 'ali-oss'
import type { Checkpoint as SdkCheckpoint } from 'ali-oss'
import { getOssCredential, completeOssUpload } from '@/api/upload'
import type { CheckFileParams, OssCredential, UploadFileItem } from '@/types'

/**
 * OSS 直传引擎（浏览器 → OSS，字节不经过我们的服务器）
 *
 * 和原来的「分片上传到后端」相比，唯一不可替代的优势就是路径短：
 *   旧：浏览器 → 云主机（上行带宽常只有 1~10Mbps，还要落盘再合并）
 *   新：浏览器 → OSS（就近接入 + 分片并发，只受用户自身带宽限制）
 *
 * 为什么用 SDK 的 multipartUpload 而不是自己循环 uploadPart：
 *   1. 它内部已做「分片并发 + 失败自动重试 + 收集 ETag + Complete 按序提交」；
 *   2. 支持 checkpoint：暂停后带着它重新调用即可断点续传，不用自己维护分片表；
 *   3. 分片数上限（10000）、最小分片（100KB）这些硬规则由它兜住。
 */

/** 上传进度回调（loaded / total 单位都是字节） */
export type OssProgress = (info: { loaded: number; total: number }) => void

/**
 * 落盘用的断点：只保留「能序列化且后续续传必需」的字段。
 *
 * 为什么不能整个 Checkpoint 存下来：SDK 的 checkpoint 里有个 file（File 对象），
 * JSON.stringify 会把它变成 {}，下次续传时 SDK 拿到空文件对象会直接报错。
 */
export interface StoredCheckpoint {
  name: string
  fileSize: number
  partSize: number
  uploadId: string
  doneParts: Array<{ number: number; etag: string }>
}

/** 从 SDK 的 checkpoint 中挑出可以持久化的部分 */
export function toStoredCheckpoint(checkpoint: unknown): StoredCheckpoint | undefined {
  const raw = checkpoint as Partial<StoredCheckpoint> | null | undefined
  if (!raw?.uploadId || !raw.name || !Array.isArray(raw.doneParts)) return undefined
  return {
    name: raw.name,
    fileSize: Number(raw.fileSize || 0),
    partSize: Number(raw.partSize || 0),
    uploadId: raw.uploadId,
    doneParts: raw.doneParts.map((part) => ({ number: part.number, etag: part.etag }))
  }
}

/** 把落盘的断点还原成 SDK 需要的 checkpoint（file 由调用方在续传时重新挂上） */
export function toSdkCheckpoint(
  stored: StoredCheckpoint | undefined,
  file: File
): SdkCheckpoint | undefined {
  if (!stored) return undefined
  return { ...stored, file }
}

export interface OssUploadResult {
  file: UploadFileItem
  /** 上传完成后的 object key（排查问题 / 后续下载用） */
  key: string
}

export interface OssUploadOptions {
  /** 上传所需的文件元信息（fileHash / fileName / fileSize / 归属） */
  params: CheckFileParams
  file: File
  /** 已缓存的凭证（续传时可传入，省一次签发请求） */
  credential?: OssCredential
  /** 上次中断时保存的 checkpoint，传入即从断点续传 */
  checkpoint?: SdkCheckpoint
  onProgress?: OssProgress
  /** 暂停 / 取消：abort 时取消在途请求（服务端分片由后端定时任务清理） */
  signal?: AbortSignal
  /** 断点变化时回调（已剔除 File 等无法序列化的字段，可直接写 localStorage） */
  onCheckpoint?: (checkpoint: StoredCheckpoint) => void
  /** 凭证刷新回调：长传超过 STS 有效期（15 分钟）时由 SDK 调用 */
  refreshCredential?: () => Promise<OssCredential>
  /**
   * 分片并发数（页面上「N 并发」下拉框）。
   * 不传时用 DEFAULT_OSS_PARALLEL；注意这与旧分片上传共用同一个用户设置，
   * 但两者的「安全上限」不同，见 clampOssParallel 的说明。
   */
  parallel?: number
}

/** 主动取消（暂停 / 移除任务）时抛出，调用方应静默处理 */
export class OssUploadCanceled extends Error {
  constructor() {
    super('已取消上传')
    this.name = 'OssUploadCanceled'
  }
}

/** 用户没设置并发数时的默认值（与旧分片上传的默认值保持一致） */
export const DEFAULT_OSS_PARALLEL = 3

/** 直传的并发上限：OSS 允许更高，但浏览器对同一域名仍有连接数限制 */
export const MAX_OSS_PARALLEL = 6

/**
 * 把用户设置的并发数收敛到直传可接受的区间。
 *
 * 为什么不像本地分片那样直接用：本地分片数越多，服务端的写压力越大，
 * 所以那里限制得紧；直传的压力在 OSS 侧，多开几个更容易跑满带宽。
 * 但同域名连接数（HTTP/1.1 约 6）这道天花板对两者一样，所以上限仍取 6。
 */
export function clampOssParallel(value: number | undefined): number {
  const numeric = Math.floor(Number(value))
  if (!Number.isFinite(numeric) || numeric < 1) return DEFAULT_OSS_PARALLEL
  return Math.min(numeric, MAX_OSS_PARALLEL)
}

/** 后端明确表示「没配 OSS」：调用方据此回退到本地分片上传 */
export function isOssDisabledError(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { code?: string } } })?.response
  return response?.status === 503 && response?.data?.code === 'OSS_NOT_CONFIGURED'
}

/**
 * 把「带 bucket 前缀的直连域名」还原成 SDK 需要的裸 endpoint。
 *
 * ali-oss 的 getReqUrl 会用 `${bucket}.${endpoint}` 拼请求域名，
 * 而后端下发的 `endpoint` 字段是给浏览器看的完整域名（含 bucket 前缀，
 * 也可能是自定义域名 / CDN）。若原样传进 SDK，就会得到
 * `gth-files.gth-files.oss-cn-shanghai.aliyuncs.com`，
 * 浏览器里只会看到 CORS 或证书错误，很容易被误判成凭证权限问题。
 *
 * 规则：
 *   - `{bucket}.xxx` → 去掉前缀，返回 `xxx`；
 *   - 已经是裸地域节点 → 原样返回；
 *   - 自定义域名（不含 bucket 前缀）→ 原样返回，交给 SDK 继续拼 bucket
 *     （这类域名本来就要求 wildcard 解析）。
 */
export function stripBucketPrefix(endpoint: string, bucket: string): string {
  const host = String(endpoint || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
  const prefix = `${bucket}.`
  if (bucket && host.toLowerCase().startsWith(prefix.toLowerCase())) {
    const rest = host.slice(prefix.length)
    // 只剩 bucket 本身（配置明显有误）时退回原值，让报错更直观
    return rest || host
  }
  return host
}

/** 从后端拿直传凭证（key 由后端按「用户 + hash + 文件名」算好，前端不可改） */
export async function fetchOssCredential(params: CheckFileParams): Promise<OssCredential> {
  // request 的响应拦截器已经把 response.data 解包返回了，
  // 但类型声明仍是 AxiosResponse，这里统一在封装层收敛掉，避免调用方到处写 as any
  const res = await getOssCredential(params)
  return (res as unknown as { data?: OssCredential }).data ?? (res as unknown as OssCredential)
}

function createClient(credential: OssCredential, refresh?: () => Promise<OssCredential>) {
  let current = credential
  return new OSS({
    region: current.region,
    bucket: current.bucket,
    // 注意：后端下发的 endpoint 是「浏览器直连域名」，已经带 bucket 前缀
    // （如 gth-files.oss-cn-shanghai.aliyuncs.com）。SDK 内部会自己拼
    // `${bucket}.${endpoint}`，若把整串传进来会变成 gth-files.gth-files.xxx，
    // 浏览器里表现为 CORS / 证书错误，看起来像「STS 没权限」，很难排查。
    // 所以这里必须先把 bucket 前缀剥掉，只留地域节点。
    endpoint: stripBucketPrefix(current.endpoint, current.bucket),
    accessKeyId: current.accessKeyId,
    accessKeySecret: current.accessKeySecret,
    stsToken: current.securityToken,
    secure: true,
    ...(refresh
      ? {
          // 每 5 分钟检查一次，快过期时由 SDK 自动换新凭证（大文件长传必须）
          refreshSTSTokenInterval: 5 * 60 * 1000,
          refreshSTSToken: async () => {
            current = await refresh()
            return {
              accessKeyId: current.accessKeyId,
              accessKeySecret: current.accessKeySecret,
              stsToken: current.securityToken
            }
          }
        }
      : {})
  })
}

/**
 * 把文件直传到 OSS，成功后通知后端登记元数据。
 *
 * @throws OssUploadCanceled 被暂停 / 移除时
 * @throws Error             网络 / 权限 / 大小校验失败时（message 可直接展示给用户）
 */
export async function uploadFileToOss(options: OssUploadOptions): Promise<OssUploadResult> {
  const { params, file, signal } = options
  const credential = options.credential ?? (await fetchOssCredential(params))

  // 提前检查：已经取消的任务不必再发请求
  if (signal?.aborted) throw new OssUploadCanceled()

  const client = createClient(credential, options.refreshCredential)

  // SDK 不支持 AbortSignal，用 cancel() + 自己的标记实现取消
  let canceled = false
  const onAbort = () => {
    canceled = true
    // 不传 abort 参数：只中断客户端请求；
    // 服务端残留的分片上传事件由后端定时任务（cleanupOssMultipartUploads）清理
    client.cancel()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  let checkpoint: SdkCheckpoint | undefined = options.checkpoint
  let lastStored: StoredCheckpoint | undefined

  try {
    const result = await client.multipartUpload(credential.key, file, {
      // 服务端建议的分片大小（保证片数 ≤ 10000）
      partSize: credential.chunkSize,
      // 并发跟随页面上的「N 并发」设置；太高在弱网下每片的有效带宽反而下降
      parallel: clampOssParallel(options.parallel),
      ...(checkpoint ? { checkpoint } : {}),
      // progress 的第一个参数是 0~1 的完成比例，第二个是断点信息
      progress: (percent: number, cpt: unknown) => {
        const stored = toStoredCheckpoint(cpt)
        if (stored) {
          lastStored = stored
          options.onCheckpoint?.(stored)
        }
        if (typeof percent === 'number') {
          options.onProgress?.({
            loaded: Math.min(Math.round(percent * file.size), file.size),
            total: file.size
          })
        }
      }
    })

    if (canceled) throw new OssUploadCanceled()

    // 服务端会用 HeadObject 实测大小，不信任前端上报值
    const metaRes = await completeOssUpload({ ...params, fileSize: file.size })
    const meta =
      (metaRes as unknown as { data?: UploadFileItem }).data ?? (metaRes as unknown as UploadFileItem)
    options.onProgress?.({ loaded: file.size, total: file.size })
    void lastStored
    return { file: meta, key: String((result as { name?: string }).name || credential.key) }
  } catch (error) {
    if (canceled) throw new OssUploadCanceled()
    // 后端返回的业务错误（401 / 409 / 503 等）已经是中文，原样抛出
    if ((error as { response?: unknown })?.response) throw error
    throw normalizeOssError(error)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 把 SDK 的原始错误翻译成人能看懂的提示。
 * SDK 抛的是 { name, code, status, message } 结构，直接透给用户往往是一堆英文。
 */
function normalizeOssError(error: unknown): Error {
  const code = String((error as { code?: string })?.code || '')
  const status = Number((error as { status?: number })?.status || 0)
  const raw = String((error as { message?: string })?.message || '')

  if (status === 403 || code === 'AccessDenied' || code === 'SignatureDoesNotMatch') {
    return new Error('上传凭证已失效或权限不足，请重试')
  }
  if (code === 'EntityTooLarge') return new Error('文件超出存储服务允许的大小上限')
  if (code === 'RequestTimeTooSkewed') {
    return new Error('本机时间与服务器相差过大，请校准系统时间后重试')
  }
  if (status >= 500) return new Error('存储服务繁忙，请稍后重试')
  if (code === 'NetworkError' || /network|timeout/i.test(raw)) {
    return new Error('网络异常，上传已中断，可点击重试继续')
  }
  return new Error(raw || '上传到对象存储失败，请重试')
}
