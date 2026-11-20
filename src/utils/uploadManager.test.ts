// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 上传引擎（uploadManager）单元测试
 *
 * 覆盖点：
 *  1. 分片切分：总片数、最后一片长度、切片边界；
 *  2. 秒传：check 返回 exists=true 时不发送任何分片；
 *  3. 断点续传：check 返回已上传分片时，只传剩余部分；
 *  4. 分片重试：网络错误自动重试，鉴权错误不重试；
 *  5. 并发控制：同时在途的分片数不超过配置值；
 *  6. 暂停 / 移除：暂停后不再继续发送分片。
 *
 * 依赖全部 mock 掉：API 层、哈希计算、localStorage（jsdom 提供）。
 */

// ---------- mock 外部依赖（必须在 import 被测模块之前） ----------

const checkFileMock = vi.fn()
const uploadChunkMock = vi.fn()
const getFilesMock = vi.fn()
const calculateFileHashMock = vi.fn()

vi.mock('@/api/upload', () => ({
  checkFile: (...args: unknown[]) => checkFileMock(...args),
  uploadChunk: (...args: unknown[]) => uploadChunkMock(...args),
  getFiles: (...args: unknown[]) => getFilesMock(...args)
}))

vi.mock('@/utils/hash', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/utils/hash')
  return {
    ...actual,
    calculateFileHash: (...args: unknown[]) => calculateFileHashMock(...args)
  }
})

import {
  addFiles,
  clearFinished,
  formatRemaining,
  formatSize,
  formatSpeed,
  getMaxConcurrency,
  getOwnership,
  pauseTask,
  removeTask,
  restoreTasks,
  resumeByFile,
  setMaxConcurrency,
  setOwnership,
  tasks
} from '@/utils/uploadManager'
import type { UploadOwnership, UploadTask } from '@/types'
import { buildFileKey } from '@/utils/hash'

// 上传归属：分类 + 任务必选，测试里统一用同一份
const OWNERSHIP: UploadOwnership = { categoryId: 1, taskIds: [2], taskId: 2 }

// 简化调用：默认带上必选的归属信息
function addTestFiles(files: File[], chunkSize = 10) {
  return addFiles(files, chunkSize, OWNERSHIP)
}

// 生成指定大小的 File（内容用递增字节填充，便于校验切片位置）
function makeFile(size: number, name = 'test.bin'): File {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251
  return new File([bytes], name, { lastModified: 1_700_000_000_000 })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 收集每个分片请求的 index，用于断言"传了哪些片"
function trackIndexes(sink: number[]) {
  uploadChunkMock.mockImplementation(async (formData: FormData) => {
    sink.push(Number(formData.get('index')))
    return { index: Number(formData.get('index')) }
  })
}

// 清空状态，保证用例之间互不影响
function resetState() {
  localStorage.clear()
  ;[...tasks].forEach((task) => removeTask(task.uid))
  // 归属是模块级状态（用于重试 / 断点恢复兜底），用例之间必须复位
  setOwnership(null)
  vi.clearAllMocks()
  setMaxConcurrency(3)
}

beforeEach(() => {
  resetState()
  calculateFileHashMock.mockResolvedValue('a'.repeat(64))
  checkFileMock.mockResolvedValue({ exists: false, uploadedChunks: [] })
  uploadChunkMock.mockResolvedValue({ index: 0 })
  getFilesMock.mockResolvedValue([])
  // 屏蔽 uploadManager 的耗时日志，保持测试输出干净
  vi.spyOn(console, 'info').mockImplementation(() => {})
})


describe('格式化工具', () => {
  it('formatSize 按 1024 进制换算', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1024)).toBe('1.00 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.00 MB')
    expect(formatSize(1024 ** 3)).toBe('1.00 GB')
  })

  it('formatSpeed 追加 /s 后缀', () => {
    expect(formatSpeed(1024 * 1024)).toBe('1.00 MB/s')
  })

  it('formatRemaining 处理秒/分/时三级', () => {
    expect(formatRemaining(0)).toBe('--')
    expect(formatRemaining(Number.POSITIVE_INFINITY)).toBe('--')
    expect(formatRemaining(30_000)).toBe('30 秒')
    expect(formatRemaining(90_000)).toBe('1 分 30 秒')
    expect(formatRemaining(3_600_000)).toBe('1 时 0 分')
  })
})

describe('分片切分', () => {
  it('文件大小整除分片大小时，片数正确', async () => {
    const [task] = addTestFiles([makeFile(100)], 10)
    expect(task?.totalChunks).toBe(10)
    await vi.waitFor(() => expect(task?.status).toBe('done'))
  })

  it('不能整除时向上取整', () => {
    const [task] = addTestFiles([makeFile(105)], 10)
    expect(task?.totalChunks).toBe(11)
  })

  it('空文件也至少有 1 个分片', () => {
    const [task] = addTestFiles([makeFile(0)], 10)
    expect(task?.totalChunks).toBe(1)
  })

  it('最后一片按剩余长度切片，不会越界', async () => {
    const sizes: number[] = []
    uploadChunkMock.mockImplementation(async (formData: FormData) => {
      const blob = formData.get('file') as Blob
      sizes.push(blob.size)
      return { index: Number(formData.get('index')) }
    })

    addTestFiles([makeFile(105)], 10) // 10 片 * 10 + 5
    await vi.waitFor(() => expect(uploadChunkMock).toHaveBeenCalledTimes(11))

    expect(sizes.filter((size) => size === 10)).toHaveLength(10)
    expect(sizes.filter((size) => size === 5)).toHaveLength(1)
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(105)
  })
})

describe('秒传', () => {
  it('服务端已有文件时直接完成，不发送任何分片', async () => {
    checkFileMock.mockResolvedValue({ exists: true, uploadedChunks: [] })
    const [task] = addTestFiles([makeFile(100)], 10)

    await vi.waitFor(() => expect(task?.status).toBe('done'))
    expect(task?.instant).toBe(true)
    expect(task?.progress).toBe(100)
    expect(uploadChunkMock).not.toHaveBeenCalled()
    // 秒传命中后不残留断点记录
    expect(localStorage.getItem('upload_records_v1') ?? '{}').toBe('{}')
  })

  it('每个任务只计算一次文件哈希', async () => {
    const file = makeFile(100)
    const [task] = addTestFiles([file], 10)
    await vi.waitFor(() => expect(task?.status).toBe('done'))

    expect(calculateFileHashMock).toHaveBeenCalledTimes(1)
    expect(calculateFileHashMock.mock.calls[0]?.[0]).toBe(file)
  })

describe('断点续传', () => {
  it('服务端已存在部分分片时，只上传剩余分片', async () => {
    checkFileMock.mockResolvedValue({ exists: false, uploadedChunks: [0, 1] })
    const sent: number[] = []
    trackIndexes(sent)

    const [task] = addTestFiles([makeFile(50)], 10) // 5 片
    await vi.waitFor(() => expect(task?.status).toBe('done'))

    expect(task?.totalChunks).toBe(5)
    expect([...sent].sort((a, b) => a - b)).toEqual([2, 3, 4])
  })

  it('本地记录与服务端分片取并集，不重复上传', async () => {
    const file = makeFile(50)
    // 用与任务完全一致的 fileKey，确保本地记录能命中
    const fileKey = buildFileKey(file.name, file.size, file.lastModified)
    localStorage.setItem(
      'upload_records_v1',
      JSON.stringify({
        [fileKey]: {
          fileKey,
          fileHash: 'b'.repeat(64),
          fileName: file.name,
          fileSize: file.size,
          totalChunks: 5,
          chunkSize: 10,
          uploadedChunks: [0],
          updatedAt: Date.now()
        }
      })
    )
    // 服务端只有第 1 片
    checkFileMock.mockResolvedValue({ exists: false, uploadedChunks: [1] })
    const sent: number[] = []
    trackIndexes(sent)

    addTestFiles([file], 10)
    // 等任务完成（而不是固定次数，避免并发时序干扰）
    await vi.waitFor(() => expect(tasks[0]?.status).toBe('done'), { timeout: 5000 })

    // 本地已有 0，服务端已有 1，所以只应上传 2/3/4
    expect([...sent].sort((a, b) => a - b)).toEqual([2, 3, 4])
  })

  it('每片成功后记录会写进 localStorage（任务完成时清除）', async () => {
    setMaxConcurrency(1)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    uploadChunkMock.mockImplementation(async (formData: FormData) => {
      calls += 1
      // 第 2 片卡住，此时第 1 片已写入记录
      if (calls === 2) await gate
      return { index: Number(formData.get('index')) }
    })

    addTestFiles([makeFile(30)], 10) // 3 片
    await vi.waitFor(() => expect(uploadChunkMock).toHaveBeenCalledTimes(2))

    // 上传过程中：记录里应有第 0 片
    const during = JSON.parse(localStorage.getItem('upload_records_v1') || '{}')
    const record = Object.values(during)[0] as { uploadedChunks: number[] } | undefined
    expect(record?.uploadedChunks).toEqual([0])

    release?.()
    await vi.waitFor(() => expect(uploadChunkMock).toHaveBeenCalledTimes(3))
    // 全部完成后记录被清除（避免占用本地存储）
    await vi.waitFor(() => {
      const after = JSON.parse(localStorage.getItem('upload_records_v1') || '{}')
      expect(Object.keys(after)).toHaveLength(0)
    })
  })

  it('check 接口异常时按本地记录继续，不阻塞上传', async () => {
    checkFileMock.mockRejectedValue(new Error('服务不可用'))
    const sent: number[] = []
    trackIndexes(sent)

    const [task] = addTestFiles([makeFile(30)], 10) // 3 片
    await vi.waitFor(() => expect(task?.status).toBe('done'))

    expect(sent).toHaveLength(3)
  })
})

describe('分片重试', () => {
  it('网络错误自动重试，最终成功', async () => {
    setMaxConcurrency(1)
    let attempts = 0
    uploadChunkMock.mockImplementation(async (formData: FormData) => {
      attempts += 1
      if (attempts <= 2) throw new Error('Network Error')
      return { index: Number(formData.get('index')) }
    })

    const [task] = addTestFiles([makeFile(10)], 10)
    await vi.waitFor(() => expect(task?.status).toBe('done'), { timeout: 8000 })

    // 1 片 × 3 次尝试
    expect(attempts).toBe(3)
    expect(task?.progress).toBe(100)
  })

  it('鉴权错误（401）不重试，任务直接失败', async () => {
    uploadChunkMock.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { response: { status: 401 } })
    )

    const [task] = addTestFiles([makeFile(10)], 10)
    await vi.waitFor(() => expect(task?.status).toBe('error'))

    expect(uploadChunkMock).toHaveBeenCalledTimes(1)
    expect(task?.errorMsg).toBe('Unauthorized')
  })

  it('超过最大重试次数后标记失败', async () => {
    setMaxConcurrency(1)
    uploadChunkMock.mockRejectedValue(new Error('总是失败'))

    const [task] = addTestFiles([makeFile(10)], 10)
    await vi.waitFor(() => expect(task?.status).toBe('error'), { timeout: 8000 })

    // 最大尝试次数 5（首次 + 4 次重试）：大文件弱网下放宽重试，避免几百片白传
    expect(uploadChunkMock).toHaveBeenCalledTimes(5)
  }, 15000)
})


describe('并发控制', () => {
  it('同时在途的分片数不超过 maxConcurrency', async () => {
    setMaxConcurrency(2)
    let inFlight = 0
    let peak = 0
    uploadChunkMock.mockImplementation(async (formData: FormData) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(5)
      inFlight -= 1
      return { index: Number(formData.get('index')) }
    })

    const [task] = addTestFiles([makeFile(120)], 10) // 12 片
    await vi.waitFor(() => expect(task?.status).toBe('done'), { timeout: 8000 })

    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(0)
    expect(uploadChunkMock).toHaveBeenCalledTimes(12)
  })

  it('每个分片只被上传一次（并发池游标不重复）', async () => {
    const sent: number[] = []
    uploadChunkMock.mockImplementation(async (formData: FormData) => {
      sent.push(Number(formData.get('index')))
      await sleep(1)
      return { index: Number(formData.get('index')) }
    })

    const [task] = addTestFiles([makeFile(200)], 10) // 20 片
    await vi.waitFor(() => expect(task?.status).toBe('done'), { timeout: 8000 })

    expect(sent).toHaveLength(20)
    expect(new Set(sent).size).toBe(20)
  })

  it('setMaxConcurrency 会把值限制在 1~6 之间', () => {
    setMaxConcurrency(100)
    expect(getMaxConcurrency()).toBe(6)
    setMaxConcurrency(0)
    expect(getMaxConcurrency()).toBe(1)
    setMaxConcurrency(4)
    expect(getMaxConcurrency()).toBe(4)
  })
})

describe('上传归属', () => {
  it('未指定分类 / 任务时不入队，也不发起任何请求', async () => {
    const added = addFiles([makeFile(100)], 10)
    expect(added).toHaveLength(0)
    expect(tasks).toHaveLength(0)

    await sleep(50)
    expect(checkFileMock).not.toHaveBeenCalled()
    expect(uploadChunkMock).not.toHaveBeenCalled()
  })

  it('任务会记住创建时的归属，check 请求带上 categoryId / taskId', async () => {
    const [task] = addTestFiles([makeFile(100)], 10)
    await vi.waitFor(() => expect(task?.status).toBe('done'))

    expect(task?.categoryId).toBe(OWNERSHIP.categoryId)
    expect(task?.taskId).toBe(OWNERSHIP.taskId)

    const checkParams = checkFileMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(checkParams.categoryId).toBe(OWNERSHIP.categoryId)
    expect(checkParams.taskId).toBe(OWNERSHIP.taskId)
  })

  it('分片请求的表单里带上归属信息，后端据此落库', async () => {
    addTestFiles([makeFile(20)], 10) // 2 片
    await vi.waitFor(() => expect(uploadChunkMock).toHaveBeenCalledTimes(2))

    const formData = uploadChunkMock.mock.calls[0]?.[0] as FormData
    expect(Number(formData.get('categoryId'))).toBe(OWNERSHIP.categoryId)
    expect(Number(formData.get('taskId'))).toBe(OWNERSHIP.taskId)
  })
})

describe('任务管理', () => {
  it('同一文件重复添加时去重', async () => {
    const file = makeFile(100)
    const first = addTestFiles([file], 10)
    const second = addTestFiles([file], 10)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
    await vi.waitFor(() => expect(first[0]?.status).toBe('done'))
  })

  it('只传 taskIds、不带 taskId 时同样能入队（页面新写法）', async () => {
    const added = addFiles([makeFile(10)], 10, { categoryId: 1, taskIds: [2] })
    expect(added).toHaveLength(1)
    expect(added[0]?.taskId).toBe(2)
    await vi.waitFor(() => expect(added[0]?.status).toBe('done'))
  })

  it('pauseTask 后不再继续发送分片', async () => {
    setMaxConcurrency(1)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    uploadChunkMock.mockImplementation(async (formData: FormData) => {
      calls += 1
      if (calls === 1) await gate
      return { index: Number(formData.get('index')) }
    })

    const [task] = addTestFiles([makeFile(100)], 10) // 10 片
    await vi.waitFor(() => expect(uploadChunkMock).toHaveBeenCalledTimes(1))

    pauseTask(task!.uid)
    release?.()
    await sleep(80)

    // 暂停后不再发起新分片
    expect(uploadChunkMock).toHaveBeenCalledTimes(1)
    expect(task?.status).toBe('paused')
  })

  it('removeTask 会从队列中移除任务', async () => {
    const [task] = addTestFiles([makeFile(100)], 10)
    await vi.waitFor(() => expect(task?.status).toBe('done'))

    removeTask(task!.uid)
    expect(tasks).toHaveLength(0)
  })

  it('clearFinished 只清理已完成任务', async () => {
    const [done] = addTestFiles([makeFile(10)], 10)
    await vi.waitFor(() => expect(done?.status).toBe('done'))

    clearFinished()
    expect(tasks.some((task: UploadTask) => task.status === 'done')).toBe(false)
  })

  // 回归：大文件上传中点「暂停」曾弹出「网络异常，请检查网络连接」
  // 根因是 request.ts 的拦截器把 axios 的取消（CanceledError）当成网络故障处理。
  it('暂停在途分片时不产生未捕获异常，也不留下错误提示', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    setMaxConcurrency(1)
    // 模拟真实 axios：收到 abort 后 reject 一个 isCancel 的 CanceledError
    uploadChunkMock.mockImplementation(
      (_formData: FormData, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => _resolve({ index: 0 }), 500)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            const error = new Error('canceled') as Error & {
              __CANCEL__?: boolean
              code?: string
            }
            error.__CANCEL__ = true
            error.name = 'CanceledError'
            error.code = 'ERR_CANCELED'
            reject(error)
          })
        })
    )

    const [task] = addTestFiles([makeFile(100)], 10)
    await vi.waitFor(() => expect(uploadChunkMock).toHaveBeenCalled())

    pauseTask(task!.uid)
    await sleep(300)
    process.off('unhandledRejection', onUnhandled)

    expect(task?.status).toBe('paused')
    // 主动暂停不应被标记为失败，也不应残留错误文案
    expect(task?.errorMsg).toBeUndefined()
    // 普通暂停的任务手里仍有真实 File：点「继续」应直接续传，不能再弹文件选择框
    expect(task?.needsFile).toBeFalsy()
    expect(task?.file.size).toBeGreaterThan(0)
    expect(unhandled).toHaveLength(0)
  })
})

// 回归：刷新页面后恢复的断点任务需要重新选文件，用显式标记 needsFile 表示，
// 页面据此决定点「继续」时要不要弹文件选择框（以前靠 errorMsg 判断，正常暂停也会弹框）。
describe('断点恢复的占位任务', () => {
  it('恢复出来的任务标记 needsFile，重新选择原文件后清除', async () => {
    localStorage.setItem(
      'upload_records_v1',
      JSON.stringify({
        'restore.bin-100-1': {
          fileKey: 'restore.bin-100-1',
          fileHash: 'hash-1',
          fileName: 'restore.bin',
          fileSize: 100,
          totalChunks: 10,
          chunkSize: 10,
          uploadedChunks: [0, 1],
          categoryId: 1,
          taskIds: [2],
          taskId: 2,
          updatedAt: Date.now()
        }
      })
    )

    expect(restoreTasks()).toBe(0)
    const restored = tasks.find((task) => task.fileName === 'restore.bin')
    expect(restored?.status).toBe('paused')
    expect(restored?.needsFile).toBe(true)
    // 占位 File 拿不到真实内容
    expect(restored?.file.size).toBe(0)

    // 名称、大小一致的原文件可以续传，续传后不再需要选文件
    const matched = resumeByFile(restored!.uid, makeFile(100, 'restore.bin'))
    expect(matched).toBe(true)
    const resumed = tasks.find((task) => task.fileName === 'restore.bin')
    expect(resumed?.needsFile).toBe(false)
    expect(resumed?.errorMsg).toBeUndefined()
    await vi.waitFor(() => expect(resumed?.status).toBe('done'))
  })
})

describe('一个文件同时上传到多个任务', () => {
  it('按「文件 × 任务」展开成多张卡片，各自记录自己的任务', async () => {
    const added = addFiles([makeFile(10)], 10, { categoryId: 7, taskIds: [3, 5] })
    expect(added).toHaveLength(2)
    expect(tasks).toHaveLength(2)
    expect(added.map((task) => task.taskId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([3, 5])
    // 每张卡片只挂一个任务，便于单独暂停 / 重试
    expect(added.every((task) => task.taskIds?.length === 1)).toBe(true)
    expect(added.every((task) => task.categoryId === 7)).toBe(true)
    // uid 必须唯一，否则列表渲染与运行时状态会互相覆盖
    expect(new Set(added.map((task) => task.uid)).size).toBe(2)

    await vi.waitFor(() => expect(added.every((task) => task.status === 'done')).toBe(true))
  })

  it('每个任务各发一次 check 请求，并带上各自的任务 id', async () => {
    const added = addFiles([makeFile(10)], 10, { categoryId: 7, taskIds: [3, 5] })
    await vi.waitFor(() => expect(added.every((task) => task.status === 'done')).toBe(true))

    expect(checkFileMock).toHaveBeenCalledTimes(2)
    const checkTaskIds = checkFileMock.mock.calls
      .map((call) => (call[0] as Record<string, unknown>).taskId)
      .sort((a, b) => Number(a) - Number(b))
    expect(checkTaskIds).toEqual([3, 5])
    // 分类是共用的
    expect(
      checkFileMock.mock.calls.every(
        (call) => (call[0] as Record<string, unknown>).categoryId === 7
      )
    ).toBe(true)
  })

  it('第一个任务传完后其余任务命中秒传，不再重复上传分片', async () => {
    const indexes: number[] = []
    trackIndexes(indexes)
    // 第一次 check 未命中；之后服务端已有该文件 → 秒传
    let checkCalls = 0
    checkFileMock.mockImplementation(async (params: Record<string, unknown>) => {
      checkCalls += 1
      return checkCalls === 1
        ? { exists: false, uploadedChunks: [] }
        : { exists: true, uploadedChunks: [0], file: { taskId: params.taskId } }
    })

    const added = addFiles([makeFile(10)], 10, { categoryId: 7, taskIds: [3, 5] })
    await vi.waitFor(() => expect(added.every((task) => task.status === 'done')).toBe(true))

    // 只有第一张卡片真正发了分片（1 片），第二张走秒传
    expect(indexes).toEqual([0])
    const instant = added.filter((task) => task.instant)
    expect(instant).toHaveLength(1)
    expect(instant[0]?.taskId).toBe(5)
  })

  it('多选任务时，同一文件重复添加会被全部去重', async () => {
    const file = makeFile(10)
    const first = addFiles([file], 10, { categoryId: 7, taskIds: [3, 5] })
    const second = addFiles([file], 10, { categoryId: 7, taskIds: [3, 5] })
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(0)

    // 只补一个任务中的差额：3 已在队列，5 也是 → 仍然全部去重
    const third = addFiles([file], 10, { categoryId: 7, taskIds: [3] })
    expect(third).toHaveLength(0)
    await vi.waitFor(() => expect(first.every((task) => task.status === 'done')).toBe(true))
  })

  it('未选任何任务时不入队（最少选一个）', async () => {
    const added = addFiles([makeFile(10)], 10, { categoryId: 7, taskIds: [] })
    expect(added).toHaveLength(0)
    expect(tasks).toHaveLength(0)
  })

  it('getOwnership 返回去重升序后的任务列表，供后续重试 / 断点恢复使用', async () => {
    addFiles([makeFile(10)], 10, { categoryId: 7, taskIds: [5, 3, 5] })
    const ownership = getOwnership()
    expect(ownership?.categoryId).toBe(7)
    expect(ownership?.taskIds).toEqual([3, 5])
    // 多任务时不给出单个 taskId，避免误用成「只有一个任务」
    expect(ownership?.taskId).toBeUndefined()
  })
})
})
