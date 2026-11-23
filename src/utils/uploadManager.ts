import { reactive } from 'vue'
import axios from 'axios'
import { checkFile, uploadChunk, getFiles } from '@/api/upload'
import { calculateFileHash, buildFileKey } from '@/utils/hash'
import {
  uploadFileToOss,
  fetchOssCredential,
  isOssDisabledError,
  toSdkCheckpoint,
  OssUploadCanceled,
  type StoredCheckpoint
} from '@/utils/ossUpload'
import { DEFAULT_CHUNK_SIZE } from '@/types'
import type {
  UploadTask,
  UploadRecord,
  UploadFileItem,
  UploadOwnership,
  UploadFileQuery,
  OssCredential
} from '@/types'

/**
 * 文件上传核心引擎（OSS 直传 / 分片上传双通道 + 秒传 + 断点续传）
 *
 * 流程：
 * 1. Worker 计算文件 SHA-256 -> fileHash
 * 2. POST /upload/check 校验：exists=true 直接秒传完成（命中判定会自动区分 OSS / 本地）
 * 3. 拿 OSS 凭证直传（字节不经过服务器）；OSS 未配置时自动回退到分片上传
 * 4. 每成功一片就把进度写入 localStorage，刷新后仍能续传
 *
 * 为什么优先 OSS：原方案所有分片都要先上传到我们的服务器再合并，
 * 云主机上行带宽（常 1~10Mbps）会成为硬瓶颈；直传后只受用户自身带宽限制。
 */

/** 上传通道：oss = 浏览器直传对象存储；local = 原来的分片上传到后端 */
export type UploadChannel = 'oss' | 'local'

/**
 * 通道策略：
 *   auto（默认）→ 优先 OSS，凭证获取失败（未配置 / 签发异常）时回退本地；
 *   oss        → 只用 OSS，失败即报错（便于验证直传是否真的生效）；
 *   local      → 只用本地分片（老行为，排查问题 / 临时降级用）。
 */
let channelPolicy: 'auto' | 'oss' | 'local' = 'auto'

export function setUploadChannel(policy: 'auto' | 'oss' | 'local') {
  channelPolicy = policy
}

export function getUploadChannel(): 'auto' | 'oss' | 'local' {
  return channelPolicy
}


// 并发上传的分片数量（可在页面调整；默认 3 兼顾速度与浏览器连接数限制）
// 说明：HTTP/1.1 下同一域名浏览器最多 6 个并发连接，留出余量给其他请求
let maxConcurrency = 3

/**
 * 设置分片并发数（1~6）
 * 网络好时可调高提升吞吐，网络差或服务端压力大时调低。
 */
export function setMaxConcurrency(value: number) {
  maxConcurrency = Math.min(Math.max(Math.floor(value) || 1, 1), 6)
}

export function getMaxConcurrency() {
  return maxConcurrency
}

// 本地断点记录的 key
const RECORD_STORAGE_KEY = 'upload_records_v1'

// 当前的归属信息（分类 / 任务）：页面选定后写入，新增任务时复制一份到任务上，
// 这样上传过程中用户切换下拉框也不会让同一个任务的分片挂到不同归属下。
let currentOwnership: UploadOwnership | null = null

/**
 * 把归属里的任务整理成去重、升序的正整数数组
 *
 * 页面可能传来 taskId（单个）或 taskIds（多个），两种都接受，
 * 统一归一到 taskIds 之后，引擎内部只处理"一组任务"这一种形态。
 */
function normalizeTaskIds(ownership: UploadOwnership | null | undefined): number[] {
  if (!ownership) return []
  const raw = Array.isArray(ownership.taskIds)
    ? ownership.taskIds
    : ownership.taskId
      ? [ownership.taskId]
      : []
  const ids = raw
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
  // 去重并升序：稳定顺序让"已选任务"的展示与去重键不会因选择先后而变
  return Array.from(new Set(ids)).sort((a, b) => a - b)
}

/**
 * 设置后续新增任务的归属信息（分类 + 任务，任务可多个）
 * 上传前必须先选好，否则 addFiles 会直接拒绝
 */
export function setOwnership(ownership: UploadOwnership | null) {
  if (!ownership) {
    currentOwnership = null
    return
  }
  const taskIds = normalizeTaskIds(ownership)
  currentOwnership = {
    categoryId: ownership.categoryId,
    taskIds,
    ...(taskIds.length === 1 ? { taskId: taskIds[0] } : {})
  }
}

export function getOwnership(): UploadOwnership | null {
  if (!currentOwnership) return null
  return {
    categoryId: currentOwnership.categoryId,
    taskIds: [...currentOwnership.taskIds],
    ...(currentOwnership.taskId ? { taskId: currentOwnership.taskId } : {})
  }
}

// 队列中的任务（reactive 数组，模板可直接响应）
const tasks = reactive<UploadTask[]>([])

// 每个任务的运行时控制信息（AbortController、计时器等，不需要响应式）
interface TaskRuntime {
  controller?: AbortController
  // 是否允许继续跑（暂停/删除时置 false）
  running: boolean
  fileHash?: string
  // 本批次已上传字节数（用于计算速度）
  sessionLoaded: number
  sessionStart: number
  timer?: number
  // 速度采样窗口：只保留最近 N 次的 (时间, 累计字节) 样本，
  // 用窗口内增量算瞬时速度。若用全程平均值，长时间上传后速度会"钝化"（跟不上真实波动）。
  samples: Array<{ time: number; loaded: number }>
  // 已完成分片集合：增量维护，避免每次上传都重建并排序整个数组（O(n^2)）
  doneChunks: Set<number>
  // 各阶段耗时（用于可观测性）
  timings: { hash?: number; check?: number; upload?: number; total?: number }
}

const runtimes = new Map<string, TaskRuntime>()

function getRuntime(uid: string): TaskRuntime {
  let runtime = runtimes.get(uid)
  if (!runtime) {
    runtime = {
      running: false,
      sessionLoaded: 0,
      sessionStart: 0,
      samples: [],
      doneChunks: new Set<number>(),
      timings: {}
    }
    runtimes.set(uid, runtime)
  }
  return runtime
}

/* ------------------------- 本地断点记录 ------------------------- */

function readRecords(): Record<string, UploadRecord> {
  try {
    const raw = localStorage.getItem(RECORD_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, UploadRecord>) : {}
  } catch {
    return {}
  }
}

function writeRecords(records: Record<string, UploadRecord>) {
  try {
    localStorage.setItem(RECORD_STORAGE_KEY, JSON.stringify(records))
  } catch {
    // 本地存储写满时静默失败，不影响上传主流程
  }
}

function saveRecord(
  task: UploadTask,
  fileHash: string,
  ossCheckpoint?: UploadRecord['ossCheckpoint']
) {
  const records = readRecords()
  // 每张卡片只挂一个任务：多任务上传时同一文件会留下多条记录，各自记录自己的任务
  const taskId = task.taskId
  const previous = records[task.fileKey]
  // checkpoint 的保留规则：
  //   - 本次传了新的 → 用新的；
  //   - 本次没传，但上次是 OSS 通道留下的 → 保留（分片进度更新时不能把它冲掉）；
  //   - 本次明确走本地通道 → 清空（避免下次误用失效的 uploadId）。
  const checkpoint =
    ossCheckpoint ?? (task.channel === 'local' ? undefined : previous?.ossCheckpoint)
  records[task.fileKey] = {
    fileKey: task.fileKey,
    fileHash,
    fileName: task.fileName,
    fileSize: task.fileSize,
    totalChunks: task.totalChunks,
    chunkSize: task.chunkSize,
    uploadedChunks: [...task.uploadedChunks],
    categoryId: task.categoryId,
    taskIds: taskId ? [taskId] : (task.taskIds ?? []),
    taskId,
    ...(checkpoint ? { ossCheckpoint: checkpoint } : {}),
    updatedAt: Date.now()
  }
  writeRecords(records)
}

function removeRecord(fileKey: string) {
  const records = readRecords()
  if (records[fileKey]) {
    delete records[fileKey]
    writeRecords(records)
  }
}

/* ------------------------- 工具函数 ------------------------- */

export function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`
}

export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--'
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 时 ${minutes % 60} 分`
}

function getChunkIndexes(total: number): number[] {
  return Array.from({ length: total }, (_, index) => index)
}

function updateProgress(task: UploadTask) {
  // 用运行时集合的大小（增量维护）而不是每次重建数组
  const done = getRuntime(task.uid).doneChunks.size
  task.uploadedChunks = Array.from(getRuntime(task.uid).doneChunks).sort((a, b) => a - b)
  task.progress = task.totalChunks ? Math.floor((done / task.totalChunks) * 100) : 0
}

// 速度采样窗口的样本数量（约等于最近 5 秒的采样）
const SPEED_WINDOW = 5

/**
 * 输出任务各阶段耗时（可观测性）
 * 大文件上传出问题时，能快速判断瓶颈在"算哈希"、"校验"还是"网络传输"。
 * 也可在浏览器控制台用 window.__uploadTimings 查看历史记录。
 */
function logTaskTiming(task: UploadTask, runtime: TaskRuntime, error?: string) {
  const record = {
    fileName: task.fileName,
    fileSize: task.fileSize,
    totalChunks: task.totalChunks,
    instant: task.instant,
    ...runtime.timings,
    // 吞吐量（字节/秒），只统计真正传输的时间
    throughput: runtime.timings.upload
      ? Math.round(task.fileSize / (runtime.timings.upload / 1000))
      : undefined,
    error
  }
  timingHistory.push(record)
  if (timingHistory.length > 50) timingHistory.shift()
  if (typeof location !== 'undefined' && location.hostname === 'localhost') {
    // 仅本地开发输出，避免线上刷屏
    console.info('[upload] 任务耗时', record)
  }
}

/**
 * 判断异常是否属于「用户主动取消」（暂停 / 移除任务导致的中止）。
 *
 * 需要同时覆盖三种来源，漏掉任何一种都会把取消误判成网络故障：
 *  1. axios 的 CanceledError（abort signal 触发）→ axios.isCancel 为 true；
 *  2. 浏览器原生 AbortError（DOMException）；
 *  3. 代码里手动抛出的 DOMException('已取消', 'AbortError')。
 */
function isAbortError(error: unknown): boolean {
  if (!error) return false
  if (axios.isCancel(error)) return true
  if (error instanceof DOMException) return error.name === 'AbortError'
  const name = (error as { name?: string }).name
  const code = (error as { code?: string }).code
  return name === 'AbortError' || name === 'CanceledError' || code === 'ERR_CANCELED'
}

/**
 * 把底层异常转换成用户能看懂的提示。
 *
 * 断网 / 弱网时 axios 抛出的是英文 `Network Error`、`timeout of 0ms exceeded`，
 * 直接贴到卡片上没人看得懂，这里统一换成中文说明并给出可执行的下一步。
 */
function toUserMessage(error: unknown): string {
  if (!(error instanceof Error)) return '上传失败，请重试'
  const raw = error.message || ''
  const code = (error as { code?: string }).code || ''
  const status = (error as { response?: { status?: number } }).response?.status

  // 网络中断 / 请求发不出去（断网、DNS 失败、跨域被拦）
  if (/network ?error/i.test(raw) || code === 'ERR_NETWORK') {
    return '网络已断开，上传已暂停，恢复网络后点「重试」继续'
  }
  // 请求超时
  if (/timeout/i.test(raw) || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return '网络超时，请检查网络后重试'
  }
  // 服务端主动断开连接
  if (code === 'ECONNRESET') {
    return '连接被中断，恢复网络后点「重试」继续'
  }
  // 文件过大被网关 / 反向代理拦截
  if (status === 413) {
    return '文件过大，服务器拒绝接收，请调大上传限制或换用更小的文件'
  }
  if (status === 429) {
    return '请求过于频繁，请稍后重试'
  }
  if (typeof status === 'number' && status >= 500) {
    return raw && !/^request failed/i.test(raw) ? raw : '服务器繁忙，请稍后重试'
  }
  return raw || '上传失败，请重试'
}

// 最近的耗时记录（供调试查看）
export const timingHistory: Array<Record<string, unknown>> = []

// 刷新速度与剩余时间：用滑动窗口内的增量计算瞬时速度，避免全程平均值"钝化"
function tickSpeed(task: UploadTask) {
  const runtime = getRuntime(task.uid)
  const now = Date.now()
  runtime.samples.push({ time: now, loaded: runtime.sessionLoaded })
  if (runtime.samples.length > SPEED_WINDOW) runtime.samples.shift()

  const first = runtime.samples[0]
  const elapsed = (now - first.time) / 1000
  if (!first || elapsed <= 0) return

  // 窗口内平均速度（窗口只有 5 个样本，波动被平滑但又能跟上真实变化）
  const speed = (runtime.sessionLoaded - first.loaded) / elapsed
  task.speed = speed
  const remainingBytes = Math.max(task.fileSize - runtime.doneChunks.size * task.chunkSize, 0)
  task.remaining = speed > 0 ? (remainingBytes / speed) * 1000 : 0
}

/* ------------------------- 核心流程 ------------------------- */

/**
 * 添加文件到上传队列（自动去重）并立即开始
 *
 * 支持一次挂到多个任务：每个文件会按「文件 × 任务」展开成多张上传卡片，
 * 同一份文件的字节只需要传一次（后续任务走服务端秒传补齐记录），
 * 但每张卡片各自维护进度与状态，便于单独暂停 / 重试。
 *
 * @param ownership 归属信息（分类 + 任务，任务可多个）。不传时使用当前页面选中的归属；
 *                  两者都没有则拒绝添加 —— 每份文件都必须能说清"属于哪个分类、哪些任务"。
 * @returns 实际加入队列的任务（因缺少归属被拒绝时长度为 0）
 */
export function addFiles(files: File[], chunkSize = DEFAULT_CHUNK_SIZE, ownership?: UploadOwnership) {
  const source = ownership ?? currentOwnership
  const taskIds = normalizeTaskIds(source)
  if (!source || !source.categoryId || !taskIds.length) return []
  // 让后续手动重试 / 断点恢复也能拿到同一份归属
  currentOwnership = {
    categoryId: source.categoryId,
    taskIds,
    ...(taskIds.length === 1 ? { taskId: taskIds[0] } : {})
  }

  const added: UploadTask[] = []
  files.forEach((file) => {
    const fileKey = buildFileKey(file.name, file.size, file.lastModified)
    taskIds.forEach((taskId) => {
      // 去重键带上任务：同一文件挂到不同任务属于不同的上传卡片，不能互相顶掉
      if (
        tasks.some(
          (task) => task.fileKey === fileKey && task.taskId === taskId && task.status !== 'error'
        )
      ) {
        return
      }
      const task = reactive<UploadTask>({
        uid: `${fileKey}-${taskId}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        fileName: file.name,
        fileSize: file.size,
        fileKey,
        chunkSize,
        totalChunks: Math.max(Math.ceil(file.size / chunkSize), 1),
        uploadedChunks: [],
        progress: 0,
        status: 'pending',
        instant: false,
        speed: 0,
        remaining: 0,
        categoryId: source.categoryId,
        taskIds: [taskId],
        taskId
      })
      tasks.push(task)
      added.push(task)
    })
  })
  // 逐个启动，避免同时把浏览器 IO 打满
  added.forEach((task) => {
    void startTask(task)
  })
  return added
}
/**
 * 尝试用 OSS 直传完成本次上传。
 *
 * @returns true  = 已经传完并登记了元数据（调用方跳过后续步骤）
 *          false = 本次不走直传（未配置 / 策略为 local），调用方回退到分片上传
 *
 * 注意：这里只把「通道不可用」当作回退信号；一旦真正开始传字节之后失败，
 *      就抛错让整个任务进入 error 状态，由用户点重试 —— 因为半途换通道
 *      会导致「OSS 上有一半、服务器上有一半」，反而更难收拾。
 */
async function tryUploadViaOss(
  task: UploadTask,
  fileHash: string,
  records: Record<string, UploadRecord>
): Promise<boolean> {
  const runtime = getRuntime(task.uid)
  if (channelPolicy === 'local') {
    task.channel = 'local'
    return false
  }

  // 续传：只有当上次就是走 OSS 且留下了 checkpoint 时才带断点，
  // 否则从头开始（避免把别处的进度误判成 OSS 的分片进度）
  const savedCheckpoint = records[task.fileKey]?.ossCheckpoint
  // SDK 的 checkpoint 里带 file 对象，续传时必须把当前选择/持有的文件重新挂上
  const sdkCheckpoint = toSdkCheckpoint(savedCheckpoint, task.file)

  let credential: OssCredential
  try {
    credential = await fetchOssCredential({
      fileHash,
      fileName: task.fileName,
      fileSize: task.fileSize,
      totalChunks: task.totalChunks,
      categoryId: task.categoryId,
      taskId: task.taskId
    })
  } catch (error) {
    // 主动暂停：静默退出（外层会因 running=false 直接返回）
    if (isAbortError(error) || !runtime.running) throw error
    // 只有「服务端明确说没配 OSS」才回退；其它错误（401 / 500）应该暴露出来，
    // 否则会被误判成「直传不可用」，白白退回慢通道而不自知。
    if (channelPolicy === 'auto' && isOssDisabledError(error)) {
      task.channel = 'local'
      return false
    }
    throw error
  }

  task.channel = 'oss'
  // 直传不需要分片表：进度完全由 OSS SDK 上报，清空分片维度状态避免算错
  runtime.doneChunks = new Set<number>()
  task.uploadedChunks = []
  task.instant = false

  let lastSavedCheckpoint = savedCheckpoint
  await uploadFileToOss({
    params: {
      fileHash,
      fileName: task.fileName,
      fileSize: task.fileSize,
      totalChunks: task.totalChunks,
      categoryId: task.categoryId,
      taskId: task.taskId
    },
    file: task.file,
    credential,
    // 和本地分片共用页面上同一个「N 并发」设置，改了立刻对直传生效
    parallel: maxConcurrency,
    ...(sdkCheckpoint ? { checkpoint: sdkCheckpoint } : {}),
    ...(runtime.controller ? { signal: runtime.controller.signal } : {}),
    // 大文件可能传超过 STS 有效期（默认 15 分钟），到期前由 SDK 回调换新凭证
    refreshCredential: () =>
      fetchOssCredential({
        fileHash,
        fileName: task.fileName,
        fileSize: task.fileSize,
        totalChunks: task.totalChunks,
        categoryId: task.categoryId,
        taskId: task.taskId
      }),
    onProgress: ({ loaded, total }) => {
      // 直传进度按字节算，比分片比例更准（最后一片通常不满）
      runtime.sessionLoaded = loaded
      task.progress = total ? Math.min(Math.floor((loaded / total) * 100), 100) : 0
      tickSpeed(task)
    },
    onCheckpoint: (checkpoint: StoredCheckpoint) => {
      // 每完成一片回调一次；只有断点内容真的变了才写 localStorage（避免每片都全量序列化）
      const unchanged =
        !!lastSavedCheckpoint &&
        lastSavedCheckpoint.uploadId === checkpoint.uploadId &&
        lastSavedCheckpoint.doneParts.length === checkpoint.doneParts.length
      if (unchanged) return
      // 只含 uploadId / etag / partSize 等不敏感字段，可以落本地
      lastSavedCheckpoint = checkpoint
      saveRecord(task, fileHash, checkpoint)
    }
  })

  if (!runtime.running) throw new OssUploadCanceled()

  // 直传完成：进度 100%，元数据已由 uploadFileToOss 内部调 /oss/complete 登记
  task.progress = 100
  task.uploadedChunks = getChunkIndexes(task.totalChunks)
  runtime.fileHash = fileHash
  runtime.timings.upload = Date.now() - runtime.sessionStart
  return true
}



/**
 * 开始 / 继续一个任务（计算哈希 -> 校验 -> 上传剩余分片）
 */
async function startTask(task: UploadTask) {
  // 恢复出来的占位任务可能只从断点记录里拿到了分类、任务字段，这里补齐成卡片自己的一份；
  // 兜底用页面当前选中的任务，保证老记录也能继续传。
  if (!task.categoryId) task.categoryId = currentOwnership?.categoryId
  if (!task.taskId) {
    const fallbackTaskId =
      task.taskIds?.[0] ?? currentOwnership?.taskId ?? currentOwnership?.taskIds?.[0]
    if (fallbackTaskId) {
      task.taskId = fallbackTaskId
      task.taskIds = [fallbackTaskId]
    }
  }

  const runtime = getRuntime(task.uid)
  if (runtime.running) return
  runtime.running = true
  runtime.controller = new AbortController()
  // 每次启动重置运行时状态（续传时会用任务快照重新填充 doneChunks）
  runtime.doneChunks = new Set(task.uploadedChunks)
  runtime.sessionLoaded = 0
  runtime.samples = []
  runtime.timings = {}
  const startedAt = Date.now()
  task.status = 'hashing'
  task.errorMsg = undefined
  task.instant = false
  task.speed = 0
  task.remaining = 0

  try {
    // 1. 计算文件哈希（续传时复用缓存值，避免重复计算）
    const records = readRecords()
    let fileHash = runtime.fileHash || records[task.fileKey]?.fileHash
    if (!fileHash) {
      const hashStart = Date.now()
      fileHash = await calculateFileHash(task.file, (progress) => {
        // 计算阶段进度占 0~10%，上传阶段占 10~100%
        task.progress = progress.total
          ? Math.min(Math.floor((progress.loaded / progress.total) * 10), 10)
          : 0
      })
      runtime.fileHash = fileHash
      runtime.timings.hash = Date.now() - hashStart
    }
    if (!runtime.running) return

    // 2. 校验秒传 / 已上传分片
    task.status = 'checking'
    const checkStart = Date.now()
    let serverChunks: number[] = []
    try {
      const checkRes = await checkFile({
        fileHash,
        fileName: task.fileName,
        fileSize: task.fileSize,
        totalChunks: task.totalChunks,
        categoryId: task.categoryId,
        taskId: task.taskId
      })
      const checkData = (checkRes as any)?.data ?? checkRes ?? {}

      if (checkData.exists) {
        // 秒传：服务端已有完整文件
        const allChunks = getChunkIndexes(task.totalChunks)
        runtime.doneChunks = new Set(allChunks)
        task.uploadedChunks = allChunks
        task.instant = true
        task.status = 'done'
        task.progress = 100
        runtime.timings.check = Date.now() - checkStart
        runtime.timings.total = Date.now() - startedAt
        removeRecord(task.fileKey)
        logTaskTiming(task, runtime)
        await refreshFiles()
        return
      }
      serverChunks = checkData.uploadedChunks || []
    } catch (error) {
      // 暂停 / 移除任务导致的中断：直接退出，不要误当成"校验接口不可用"继续往下传
      if (isAbortError(error) || !runtime.running) return
      // 校验接口不可用时不阻塞上传，按本地记录继续
      serverChunks = records[task.fileKey]?.uploadedChunks || []
    }
    if (!runtime.running) return
    runtime.timings.check = Date.now() - checkStart

    // 合并本地断点记录与服务端分片，取并集。
    // 两边的数据都可能不完整：
    //   - 本地记录可能比服务端新（刚传完一片但 check 请求还没到）；
    //   - 服务端可能比本地新（换了浏览器 / 清了缓存）。
    // 只有取并集才能做到"一片都不重传"。
    const localChunks = records[task.fileKey]?.uploadedChunks || []
    localChunks.forEach((index) => runtime.doneChunks.add(index))
    serverChunks.forEach((index) => runtime.doneChunks.add(index))
    updateProgress(task)
    saveRecord(task, fileHash)

    // 3. 上传文件字节
    //    优先 OSS 直传（字节不经过服务器，速度只受用户带宽限制）；
    //    未配置 OSS / 签发凭证失败时回退到原来的分片上传，保证功能不退化。
    task.status = 'uploading'
    runtime.sessionLoaded = runtime.doneChunks.size * task.chunkSize
    runtime.sessionStart = Date.now()
    runtime.samples = [{ time: runtime.sessionStart, loaded: runtime.sessionLoaded }]
    runtime.timer = window.setInterval(() => {
      if (task.status === 'uploading') tickSpeed(task)
    }, 500)

    const uploadedViaOss = await tryUploadViaOss(task, fileHash, records);
    if (!uploadedViaOss) {
      await uploadPendingChunks(task, fileHash)
    }

    if (runtime.timer) window.clearInterval(runtime.timer)
    if (!runtime.running) return


    // 4. 完成
    task.status = 'done'
    task.progress = 100
    task.speed = 0
    task.remaining = 0
    runtime.timings.total = Date.now() - startedAt
    logTaskTiming(task, runtime)

    removeRecord(task.fileKey)
    await refreshFiles()
  } catch (error) {
    if (runtime.timer) window.clearInterval(runtime.timer)
    // 主动取消（暂停/删除任务）造成的错误：静默退出，不标记失败、不弹提示
    if (!runtime.running || isAbortError(error)) return
    task.status = 'error'
    runtime.timings.total = Date.now() - startedAt
    logTaskTiming(task, runtime, task.errorMsg)

    task.errorMsg = toUserMessage(error)
  } finally {
    if (runtime.timer) {
      window.clearInterval(runtime.timer)
      runtime.timer = undefined
    }

    runtime.running = false
  }
}

/**
 * 上传单个分片，失败时按指数退避重试。
 *
 * 为什么不是固定 3 次：大文件通常有几百上千个分片，弱网下一次抖动就会让 3 次重试
 * 全部耗尽 → 整个任务失败、已传的几百片白传。这里放宽到最多 5 次尝试
 * （首次 + 4 次重试）并加抖动（多 worker 同时失败时不会一起撞在同一个时间点）。
 *
 * 说明：暂停/取消（AbortError / CanceledError）不重试，直接抛出由上层静默处理。
 */
async function uploadChunkWithRetry(formData: FormData, signal?: AbortSignal) {
  const maxRetries = 5
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await uploadChunk(formData, signal)
    } catch (error) {
      // 主动取消（暂停 / 移除任务）：立即结束，不重试也不报错
      if (isAbortError(error)) throw error
      // 401 等鉴权错误重试也没意义
      const status = (error as { response?: { status?: number } })?.response?.status
      if (status === 401 || status === 403) throw error
      if (attempt >= maxRetries - 1) throw error
      // 300 / 600 / 1200 / 2400 ms 退避 + 0~250ms 随机抖动
      const backoff = 300 * 2 ** attempt + Math.random() * 250
      await new Promise((resolve) => setTimeout(resolve, backoff))
      if (signal?.aborted) {
        throw new DOMException('已取消', 'AbortError')
      }
    }
  }
}

/**
 * 并发上传未完成的分片（分片级断点：已成功的分片不会重传）
 */
async function uploadPendingChunks(task: UploadTask, fileHash: string) {
  const runtime = getRuntime(task.uid)
  task.channel = 'local'
  const pending = getChunkIndexes(task.totalChunks).filter(
    (index) => !runtime.doneChunks.has(index)
  )

  const uploadStart = Date.now()
  // 断点续传：sessionLoaded 从已传字节数起算，速度窗口才不会算错
  runtime.sessionLoaded = runtime.doneChunks.size * task.chunkSize

  // 并发池：持有 workers 个"工人"共享一个游标，游标自增是同步的，
  // 因此不会有两个工人拿到同一个分片（JS 单线程，cursor += 1 之间不会被打断）
  let cursor = 0
  const worker = async () => {
    while (runtime.running && cursor < pending.length) {
      const index = pending[cursor] as number
      cursor += 1

      const start = index * task.chunkSize
      const end = Math.min(start + task.chunkSize, task.fileSize)
      const blob = task.file.slice(start, end)

      const formData = new FormData()
      formData.append('file', blob, task.fileName)
      formData.append('fileHash', fileHash)
      formData.append('fileName', task.fileName)
      formData.append('index', String(index))
      formData.append('totalChunks', String(task.totalChunks))
      formData.append('chunkSize', String(task.chunkSize))
      formData.append('fileSize', String(task.fileSize))
      // 归属信息：首片上传时落库为文件记录的分类 / 任务（后端会校验存在性）
      if (task.categoryId) formData.append('categoryId', String(task.categoryId))
      if (task.taskId) formData.append('taskId', String(task.taskId))

      // 单片失败自动重试（大文件分片多，偶发网络抖动不应让整个任务失败）
      try {
        await uploadChunkWithRetry(formData, runtime.controller?.signal)
      } catch (error) {
        // 暂停 / 移除任务：安静退出这个 worker，不把取消当成失败向外抛，
        // 否则 Promise.all 会把 CanceledError 传出去，进而触发"网络异常"提示。
        if (isAbortError(error) || !runtime.running) return
        throw error
      }

      if (!runtime.running) return
      // 增量加入集合：O(1)，避免每次 [...array].sort() 的 O(n log n) 重建
      runtime.doneChunks.add(index)
      runtime.sessionLoaded += end - start
      updateProgress(task)
      tickSpeed(task)
      saveRecord(task, fileHash)
    }
  }

  const workers = Math.min(maxConcurrency, pending.length)
  if (workers > 0) {
    await Promise.all(Array.from({ length: workers }, () => worker()))
    runtime.timings.upload = (runtime.timings.upload || 0) + (Date.now() - uploadStart)
  }
}

/**
 * 暂停任务（已上传的分片会被记录，恢复时从断点继续）
 */
/**
 * 暂停任务（已上传的分片会被记录，恢复时从断点继续）
 *
 * 顺序很重要：先把 running 置 false，让所有 worker 的循环条件立即失效，
 * 再 abort 在途请求。这样即使 abort 抛出的取消异常向外传播，
 * 上层也会因为 running=false 直接静默返回，不会弹出"网络异常"。
 */
export function pauseTask(uid: string) {
  const task = tasks.find((item) => item.uid === uid)
  if (!task) return
  const runtime = getRuntime(uid)
  runtime.running = false
  try {
    runtime.controller?.abort()
  } catch {
    // 个别环境（已被其他逻辑 abort 过）会抛错，忽略即可
  }
  runtime.controller = undefined
  if (runtime.timer) {
    window.clearInterval(runtime.timer)
    runtime.timer = undefined
  }
  if (task.status !== 'done') {
    task.status = 'paused'
    task.speed = 0
    task.remaining = 0
    // 暂停是主动操作，不应残留上一次的错误提示
    task.errorMsg = undefined
  }
}

/**
 * 恢复任务：重新校验服务端分片后继续上传
 */
export function resumeTask(uid: string) {
  const task = tasks.find((item) => item.uid === uid)
  if (!task) return
  if (task.status === 'done' || task.status === 'uploading' || task.status === 'hashing') return
  void startTask(task)
}

/**
 * 重试失败任务
 */
export function retryTask(uid: string) {
  const task = tasks.find((item) => item.uid === uid)
  if (!task) return
  task.status = 'pending'
  task.errorMsg = undefined
  void startTask(task)
}

/**
 * 从队列中移除任务
 * @param removeRecordFlag 是否同时清除本地断点记录（true 表示放弃续传）
 */
export function removeTask(uid: string, removeRecordFlag = true) {
  const index = tasks.findIndex((item) => item.uid === uid)
  if (index === -1) return
  const task = tasks[index]
  pauseTask(uid)
  if (removeRecordFlag) removeRecord(task.fileKey)
  runtimes.delete(uid)
  tasks.splice(index, 1)
}

/**
 * 清空已完成任务
 */
export function clearFinished() {
  tasks
    .filter((task) => task.status === 'done')
    .forEach((task) => removeTask(task.uid))
}

/* ------------------------- 服务端文件列表 ------------------------- */

// 已上传到服务端的文件列表
const fileList = reactive<UploadFileItem[]>([])

export async function refreshFiles(query: UploadFileQuery = {}) {
  try {
    const res = await getFiles(query)
    const list: UploadFileItem[] = (res as any)?.data ?? (res as any) ?? []
    fileList.length = 0
    fileList.push(...list)
  } catch {
    // 后端未实现该接口时忽略，保持当前列表
  }
}

/* ------------------------- 刷新后的断点恢复 ------------------------- */

/**
 * 把本地断点记录还原成"已暂停"的任务卡片
 * 浏览器出于安全限制无法用路径重新拿到 File 对象，需用户重新选择同一文件后才能继续
 *
 * @param ownership 断点记录里缺少分类 / 任务时（老数据）使用的兜底归属
 * @returns 无法恢复的任务数量（缺少分类 / 任务且没有兜底）
 */
export function restoreTasks(ownership?: UploadOwnership): number {
  const records = readRecords()
  const fallbackTaskIds = normalizeTaskIds(ownership)
  let skipped = 0
  Object.values(records).forEach((record) => {
    if (tasks.some((task) => task.fileKey === record.fileKey)) return
    // 断点记录里的归属优先；老记录没有归属时用页面当前选中的兜底。
    // 任务只取一个：一条记录对应一张卡片（多任务上传时每个任务各有一条记录）。
    const categoryId = record.categoryId || ownership?.categoryId || 0
    const taskIds = normalizeTaskIds({
      categoryId: 0,
      taskIds: record.taskIds ?? (record.taskId ? [record.taskId] : [])
    })
    const taskId = taskIds[0] || fallbackTaskIds[0] || 0
    if (!categoryId || !taskId) {
      // 没有归属就无法通过后端校验，保留记录但不展示（下次选好归属还能恢复）
      skipped += 1
      return
    }
    // 占位 File，恢复后需用户重新选择文件替换
    const placeholder = new File([], record.fileName)
    const task = reactive<UploadTask>({
      uid: `restore-${record.fileKey}-${taskId}`,
      file: placeholder,
      fileName: record.fileName,
      fileSize: record.fileSize,
      fileKey: record.fileKey,
      chunkSize: record.chunkSize,
      totalChunks: record.totalChunks,
      uploadedChunks: [...record.uploadedChunks],
      progress: record.totalChunks
        ? Math.floor((record.uploadedChunks.length / record.totalChunks) * 100)
        : 0,
      status: 'paused',
      instant: false,
      speed: 0,
      remaining: 0,
      categoryId,
      taskIds: [taskId],
      taskId,
      // 占位任务：手里没有真实 File，点“继续”时页面要弹文件选择框
      needsFile: true,
      errorMsg: '断点已恢复，请重新选择原文件后点击"继续"'
    })
    getRuntime(task.uid).fileHash = record.fileHash
    tasks.push(task)
  })
  return skipped
}

/**
 * 断点恢复：用重新选择的文件替换占位文件并继续上传
 * @returns 文件是否与断点记录匹配（名称、大小一致）
 */
export function resumeByFile(uid: string, file: File) {
  const task = tasks.find((item) => item.uid === uid)
  if (!task) return false
  if (file.name !== task.fileName || file.size !== task.fileSize) return false

  const oldUid = task.uid
  const fileHash = getRuntime(oldUid).fileHash
  runtimes.delete(oldUid)

  task.file = file
  task.uid = `${task.fileKey}-${Math.random().toString(36).slice(2, 8)}`
  // 已经拿到真实 File，后续不需要再弹文件选择框
  task.needsFile = false
  task.errorMsg = undefined
  getRuntime(task.uid).fileHash = fileHash
  void startTask(task)
  return true
}

export { tasks, fileList }

