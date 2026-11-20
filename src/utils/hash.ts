/**
 * 文件哈希计算工具（用于秒传 / 断点续传）
 *
 * 秒传与断点续传都依赖"同一文件得到同一标识"，这里采用
 * SHA-256(文件名 + 文件大小 + 文件内容) 作为文件唯一标识 fileKey。
 * - 计算通过分片 + Web Worker 完成，避免大文件阻塞页面；
 * - 计算过程中回调进度，页面可展示"计算中 xx%"。
 */

// 计算哈希时的分片大小：4MB（越大读取次数越少，内存占用仍恒定）
const HASH_CHUNK_SIZE = 4 * 1024 * 1024

export interface HashProgress {
  loaded: number
  total: number
}

// Worker 返回的消息结构
interface HashWorkerResult {
  type: 'progress' | 'done' | 'error'
  hash?: string
  loaded?: number
  message?: string
}

/**
 * 计算文件的 SHA-256 标识（内存占用恒定，支持几十 GB 大文件）
 * @param file 待计算的文件
 * @param onProgress 进度回调，0~1 的比例由 loaded/total 计算
 * @returns 十六进制哈希字符串
 */
export function calculateFileHash(
  file: File,
  onProgress?: (progress: HashProgress) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), {
      type: 'module'
    })

    worker.onmessage = (event: MessageEvent<HashWorkerResult>) => {
      const data = event.data
      if (data.type === 'progress') {
        onProgress?.({ loaded: data.loaded || 0, total: file.size })
      } else if (data.type === 'done') {
        worker.terminate()
        onProgress?.({ loaded: file.size, total: file.size })
        resolve(data.hash as string)
      } else {
        worker.terminate()
        reject(new Error(data.message || '文件哈希计算失败'))
      }
    }

    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || '文件哈希计算失败'))
    }

    // 只传 File 引用给 Worker，Worker 内部分块读取，不会复制整个文件
    worker.postMessage({ file, chunkSize: HASH_CHUNK_SIZE })
  })
}

/**
 * 给文件生成一个稳定的本地标识（用于断点记录的 key）
 * 注意：文件名中可能包含 "-" 等字符，统一编码后再使用
 */
export function buildFileKey(name: string, size: number, lastModified: number) {
  return `${encodeURIComponent(name)}-${size}-${lastModified}`
}
