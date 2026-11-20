import { describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { Sha256, sha256Hex, toHex } from '@/utils/sha256'

/**
 * 增量 SHA-256 正确性测试
 *
 * 测试策略：
 *  1. 标准测试向量（NIST / RFC 6234）：不依赖环境，任何人跑都能过；
 *  2. 与 Node crypto.createHash('sha256') 交叉验证：随机数据 + 多种分片尺寸；
 *  3. 边界尺寸：空串、55/56/57/63/64/65 字节（padding 分支切换点）；
 *  4. 分片方式无关性：同一份数据用不同切法 update，结果必须一致。
 */

// NIST / RFC 6234 官方测试向量
const VECTORS: Array<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'
  ]
]

function enc(text: string) {
  return new TextEncoder().encode(text)
}

describe('Sha256 标准测试向量', () => {
  it.each(VECTORS)('"%s" 的摘要应匹配官方值', (input, expected) => {
    expect(sha256Hex(enc(input))).toBe(expected)
  })

  it('512KB 的 a（大量完整块，无残留）应与 Node 一致', () => {
    const size = 512 * 1024
    const data = new Uint8Array(size).fill(0x61)
    expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'))
  })
})

describe('Sha256 与 Node crypto 交叉验证', () => {
  // 覆盖 padding 的所有关键分支：< 56、= 55、= 56、57~63、64 的整数倍
  const sizes = [0, 1, 2, 3, 54, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000, 4096, 65537, 1_000_003]

  it.each(sizes)('长度 %i 字节的一次性摘要一致', (size) => {
    const data = new Uint8Array(randomBytes(size))
    expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'))
  })

  // 同一份数据，用不同分片尺寸切分后增量 update，结果必须完全一致
  const chunkSizes = [1, 3, 7, 63, 64, 65, 1024, 4096, 65536]

  it.each(chunkSizes)('按 %i 字节分片增量计算，结果与一次性摘要一致', (chunkSize) => {
    const data = new Uint8Array(randomBytes(200_000))
    const expected = createHash('sha256').update(data).digest('hex')

    const hasher = new Sha256()
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      hasher.update(data.subarray(offset, Math.min(offset + chunkSize, data.length)))
    }
    expect(toHex(hasher.digest())).toBe(expected)
  })

  it('逐字节 update（最极端的分片方式）结果正确', () => {
    const data = new Uint8Array(randomBytes(1000))
    const expected = createHash('sha256').update(data).digest('hex')

    const hasher = new Sha256()
    data.forEach((byte) => hasher.update(new Uint8Array([byte])))
    expect(toHex(hasher.digest())).toBe(expected)
  })
})

describe('Sha256 回归测试：padding 重复消费的 bug', () => {
  /**
   * 历史 bug：digest() 里 padding 数组已经包含了 buffer 中的残留数据，
   * 但代码在调用 consume(padding) 前没有清空 bufferLength，
   * 导致 consume 又把残留数据重复拼到 padding 尾部 → 非空输入全部算错，
   * 只有空输入（bufferLength === 0）恰好正确。
   *
   * 这条用例专门锁死"输入非空但不足一个块"的场景。
   */
  it('55 字节输入（padding 边界）必须与 Node 一致', () => {
    const data = new Uint8Array(55).fill(0x42)
    expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'))
  })

  it('56 字节输入（需要补两个块）必须与 Node 一致', () => {
    const data = new Uint8Array(56).fill(0x42)
    expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'))
  })

  it('单字节输入必须与 Node 一致', () => {
    expect(sha256Hex(new Uint8Array([0x61]))).toBe(
      createHash('sha256').update(new Uint8Array([0x61])).digest('hex')
    )
  })
})

describe('toHex', () => {
  it('应输出小写、两位补齐的十六进制', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff')
  })
})
