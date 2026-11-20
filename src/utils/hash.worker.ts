/**
 * File hash Worker
 *
 * 职责：分块读取 File 并增量计算 SHA-256，算法实现见 ./sha256.ts。
 *
 * 为什么要放在 Worker 里：
 *   大文件哈希是 CPU 密集操作，放在主线程会让页面卡死（进度条不动、按钮点不了）。
 *   Worker 里算完只回传进度和最终结果，主线程全程保持可交互。
 *
 * 计算内容：SHA-256(文件名 + "-" + 文件大小 + "-" + 文件内容)
 */

import { Sha256, toHex } from './sha256'

interface HashWorkerMessage {
  file: File
  chunkSize: number
}

// Worker 中通过 self 访问全局对象（避免引入额外类型依赖）
const ctx = self as unknown as {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent<HashWorkerMessage>) => void) | null
}

ctx.onmessage = async (event: MessageEvent<HashWorkerMessage>) => {
  const { file, chunkSize } = event.data
  // 单步读取至少 1MB，避免产生过多进度消息
  const step = Math.max(chunkSize || 4 * 1024 * 1024, 1024 * 1024)

  try {
    const hasher = new Sha256()
    // 头部信息：文件名 + 大小，避免"同内容不同名"被当成同一个文件
    hasher.update(new TextEncoder().encode(`${file.name}-${file.size}-`))

    let offset = 0
    while (offset < file.size) {
      const end = Math.min(offset + step, file.size)
      // 只读当前分块，内存占用恒定（与文件大小无关）
      const buffer = await file.slice(offset, end).arrayBuffer()
      hasher.update(new Uint8Array(buffer))
      offset = end
      ctx.postMessage({ type: 'progress', loaded: offset })
      // 让出事件循环，保证 Worker 能及时响应终止消息
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    ctx.postMessage({ type: 'done', hash: toHex(hasher.digest()) })
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : '未知错误'
    })
  }
}
