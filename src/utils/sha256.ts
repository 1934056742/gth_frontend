/**
 * 增量 SHA-256 实现（零依赖，纯函数模块）
 *
 * 为什么自己实现而不直接用 crypto.subtle.digest()：
 *   crypto.subtle.digest() 只接受完整的 ArrayBuffer，必须先把整个文件读进内存。
 *   10GB 文件 → 10GB 内存，页面直接崩溃。
 *   增量版本每读一块就 update 进状态，内存占用恒定（约等于单块大小）。
 *
 * 正确性保证：
 *   - update() 可任意次、任意长度切分调用，结果与一次性摘要完全一致；
 *   - 已用 Node crypto.createHash('sha256') 交叉验证（见 src/utils/__tests__/sha256.test.ts）。
 *
 * 特别说明 digest() 的填充逻辑：
 *   SHA-256 最后要补 0x80 + 若干 0x00 + 8 字节长度（大端）。
 *   如果 残留字节数 >= 56，一轮 64 字节不够，必须补到 128 字节（两个块）。
 */

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

// SHA-256 轮常量（前 64 个素数立方根小数部分的前 32 位）
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

export class Sha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  // 不足 64 字节的残留数据
  private buffer = new Uint8Array(64)
  private bufferLength = 0
  private bytesHashed = 0
  // 复用消息扩展数组，避免每块都新建（GC 压力）
  private w = new Uint32Array(64)

  // 处理一个完整的 64 字节块
  private block(data: Uint8Array, offset: number) {
    const w = this.w
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4
      // 大端序取 4 字节
      w[i] =
        (((data[j] as number) << 24) |
          ((data[j + 1] as number) << 16) |
          ((data[j + 2] as number) << 8) |
          (data[j + 3] as number)) >>>
        0
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] as number
      const w2 = w[i - 2] as number
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0
    }

    let a = this.h[0] as number
    let b = this.h[1] as number
    let c = this.h[2] as number
    let d = this.h[3] as number
    let e = this.h[4] as number
    let f = this.h[5] as number
    let g = this.h[6] as number
    let h = this.h[7] as number

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    this.h[0] = ((this.h[0] as number) + a) >>> 0
    this.h[1] = ((this.h[1] as number) + b) >>> 0
    this.h[2] = ((this.h[2] as number) + c) >>> 0
    this.h[3] = ((this.h[3] as number) + d) >>> 0
    this.h[4] = ((this.h[4] as number) + e) >>> 0
    this.h[5] = ((this.h[5] as number) + f) >>> 0
    this.h[6] = ((this.h[6] as number) + g) >>> 0
    this.h[7] = ((this.h[7] as number) + h) >>> 0
  }

  // 追加数据，可多次调用
  update(chunk: Uint8Array) {
    this.bytesHashed += chunk.length
    this.consume(chunk)
  }

  // 把数据喂进哈希状态
  private consume(chunk: Uint8Array) {
    let offset = 0

    // 先补齐上次残留的不足 64 字节
    if (this.bufferLength > 0) {
      const need = 64 - this.bufferLength
      const take = Math.min(need, chunk.length)
      this.buffer.set(chunk.subarray(0, take), this.bufferLength)
      this.bufferLength += take
      offset += take
      if (this.bufferLength === 64) {
        this.block(this.buffer, 0)
        this.bufferLength = 0
      }
    }

    // 处理完整的块，直接在原数组上读，不复制
    while (offset + 64 <= chunk.length) {
      this.block(chunk, offset)
      offset += 64
    }

    // 剩余不足 64 字节的留到下次
    if (offset < chunk.length) {
      this.buffer.set(chunk.subarray(offset), 0)
      this.bufferLength = chunk.length - offset
    }
  }

  // 结束计算，输出 32 字节摘要（调用后实例不可再用）
  digest(): Uint8Array {
    const totalBits = this.bytesHashed * 8
    // 残留 < 56 字节：补满 64 字节即可；>= 56：需要两个块（128 字节）
    const padLength = this.bufferLength < 56 ? 64 : 128
    const padding = new Uint8Array(padLength)
    padding.set(this.buffer.subarray(0, this.bufferLength), 0)
    padding[this.bufferLength] = 0x80
    const view = new DataView(padding.buffer)
    view.setUint32(padLength - 8, Math.floor(totalBits / 0x100000000))
    view.setUint32(padLength - 4, totalBits >>> 0)

    // padding 已经包含了 buffer 里的残留数据，
    // 必须先清空 bufferLength，否则 consume 会把它重复拼进 padding 尾部。
    this.bufferLength = 0
    this.consume(padding)

    const out = new Uint8Array(32)
    for (let i = 0; i < 8; i += 1) {
      const value = this.h[i] as number
      out[i * 4] = (value >>> 24) & 0xff
      out[i * 4 + 1] = (value >>> 16) & 0xff
      out[i * 4 + 2] = (value >>> 8) & 0xff
      out[i * 4 + 3] = value & 0xff
    }
    return out
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] as number).toString(16).padStart(2, '0')
  }
  return out
}

/**
 * 便捷方法：对内存中的字节数组一次性求 SHA-256
 */
export function sha256Hex(data: Uint8Array): string {
  const hasher = new Sha256()
  hasher.update(data)
  return toHex(hasher.digest())
}
