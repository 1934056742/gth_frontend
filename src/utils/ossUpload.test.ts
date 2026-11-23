// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  clampOssParallel,
  DEFAULT_OSS_PARALLEL,
  MAX_OSS_PARALLEL,
  stripBucketPrefix,
  toSdkCheckpoint,
  toStoredCheckpoint
} from '@/utils/ossUpload'

/**
 * OSS 直传引擎（ossUpload）纯函数单元测试
 *
 * 这里只测不依赖网络的逻辑：
 *  1. 并发数收敛：页面上的「N 并发」下拉框（1~6）如何映射成 SDK 的 parallel；
 *  2. checkpoint 序列化：SDK 的 checkpoint 带 File 对象，不能直接 JSON 化。
 */

describe('clampOssParallel - 直传并发数', () => {
  it('页面设置的值在 1~6 内时原样透传', () => {
    expect(clampOssParallel(1)).toBe(1)
    expect(clampOssParallel(4)).toBe(4)
    expect(clampOssParallel(MAX_OSS_PARALLEL)).toBe(MAX_OSS_PARALLEL)
  })

  it('超过上限时收敛到上限（受浏览器同域名连接数限制）', () => {
    expect(clampOssParallel(100)).toBe(MAX_OSS_PARALLEL)
  })

  it('未设置 / 非法值时用默认并发，避免 SDK 收到 NaN 后行为不确定', () => {
    expect(clampOssParallel(undefined)).toBe(DEFAULT_OSS_PARALLEL)
    expect(clampOssParallel(0)).toBe(DEFAULT_OSS_PARALLEL)
    expect(clampOssParallel(-3)).toBe(DEFAULT_OSS_PARALLEL)
    expect(clampOssParallel(Number.NaN)).toBe(DEFAULT_OSS_PARALLEL)
  })

  it('小数向下取整，保证传给 SDK 的是整数', () => {
    expect(clampOssParallel(2.9)).toBe(2)
  })

  it('默认并发与页面上「本地分片」的默认值一致', () => {
    // 两套通道共用页面同一个下拉框，默认值不一致会让用户觉得设置无效
    expect(DEFAULT_OSS_PARALLEL).toBe(3)
  })
})

describe('checkpoint - 序列化与还原', () => {
  const stored = {
    name: 'demo.bin',
    fileSize: 10 * 1024 * 1024,
    partSize: 1024 * 1024,
    uploadId: 'upload-abc',
    doneParts: [
      { number: 1, etag: 'etag-1' },
      { number: 2, etag: 'etag-2' }
    ]
  }

  it('从 SDK checkpoint 中只挑出可序列化字段（丢掉 File 对象）', () => {
    const sdkLike = { ...stored, file: new File(['x'], 'demo.bin') }
    const result = toStoredCheckpoint(sdkLike)
    expect(result).toEqual(stored)
    // 关键：不能残留 File，否则 JSON.stringify 后是 {}，下次续传 SDK 会报错
    expect(result).not.toHaveProperty('file')
    expect(JSON.parse(JSON.stringify(result))).toEqual(stored)
  })

  it('缺少 uploadId / doneParts 时视为无效断点', () => {
    expect(toStoredCheckpoint({ ...stored, uploadId: '' })).toBeUndefined()
    expect(toStoredCheckpoint({ ...stored, doneParts: undefined })).toBeUndefined()
    expect(toStoredCheckpoint(null)).toBeUndefined()
    expect(toStoredCheckpoint(undefined)).toBeUndefined()
  })

  it('还原时把当前选中的 File 重新挂回 checkpoint', () => {
    const file = new File(['x'], 'demo.bin')
    const restored = toSdkCheckpoint(stored, file)
    expect(restored).toEqual({ ...stored, file })
    expect(restored?.file).toBe(file)
  })

  it('没有断点时返回 undefined（从头开始传）', () => {
    expect(toSdkCheckpoint(undefined, new File(['x'], 'demo.bin'))).toBeUndefined()
  })
})

describe('stripBucketPrefix - endpoint 归一化', () => {
  it('去掉后端下发的 bucket 前缀，避免 SDK 拼成 bucket.bucket.endpoint', () => {
    // 这是线上真实踩过的坑：域名拼错后浏览器只报 CORS / 证书错误
    expect(stripBucketPrefix('gth-files.oss-cn-shanghai.aliyuncs.com', 'gth-files')).toBe(
      'oss-cn-shanghai.aliyuncs.com'
    )
  })

  it('本来就是裸地域节点时原样返回（幂等）', () => {
    expect(stripBucketPrefix('oss-cn-shanghai.aliyuncs.com', 'gth-files')).toBe(
      'oss-cn-shanghai.aliyuncs.com'
    )
    // 连调两次结果不变，说明重复调用是安全的
    expect(
      stripBucketPrefix(
        stripBucketPrefix('gth-files.oss-cn-shanghai.aliyuncs.com', 'gth-files'),
        'gth-files'
      )
    ).toBe('oss-cn-shanghai.aliyuncs.com')
  })

  it('兼容带协议、带尾斜杠的配置写法', () => {
    expect(stripBucketPrefix('https://gth-files.oss-cn-shanghai.aliyuncs.com/', 'gth-files')).toBe(
      'oss-cn-shanghai.aliyuncs.com'
    )
  })

  it('前缀匹配不区分大小写', () => {
    expect(stripBucketPrefix('GTH-Files.oss-cn-shanghai.aliyuncs.com', 'gth-files')).toBe(
      'oss-cn-shanghai.aliyuncs.com'
    )
  })

  it('自定义域名（不含 bucket 前缀）保持原样，交给 SDK 继续拼', () => {
    expect(stripBucketPrefix('files.example.com', 'gth-files')).toBe('files.example.com')
  })

  it('只有 bucket 名本身时退回原值，让配置错误直接暴露', () => {
    expect(stripBucketPrefix('gth-files', 'gth-files')).toBe('gth-files')
  })

  it('空值时返回空串而不是 undefined，避免 SDK 初始化报奇怪的类型错误', () => {
    expect(stripBucketPrefix('', 'gth-files')).toBe('')
  })
})
