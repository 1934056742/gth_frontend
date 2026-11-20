import { describe, expect, it } from 'vitest'
import {
  canPreview,
  formatFileSize,
  getBlobMime,
  getFileExt,
  getFileKind,
  getFileKindLabel
} from '@/utils/filePreview'

/**
 * 任务详情页「文件查看 / 下载」相关纯函数测试
 *
 * 覆盖：
 *  1. getFileExt：大小写、多级扩展名、无扩展名、隐藏文件
 *  2. getFileKind / canPreview：按扩展名归到 image/video/audio/pdf/text/other
 *  3. getBlobMime：预览时的 MIME 纠正（后端统一返回 octet-stream，不纠正浏览器不渲染）
 *  4. formatFileSize：单位换算与非法值兜底
 */

describe('getFileExt', () => {
  it('普通扩展名转小写', () => {
    expect(getFileExt('a.PDF')).toBe('pdf')
    expect(getFileExt('照片.JPeG')).toBe('jpeg')
  })

  it('多级扩展名只取最后一段', () => {
    expect(getFileExt('archive.tar.gz')).toBe('gz')
  })

  it('没有扩展名返回空串', () => {
    expect(getFileExt('README')).toBe('')
    expect(getFileExt('')).toBe('')
    expect(getFileExt('trailing.')).toBe('')
  })

  it('隐藏文件（以点开头）不当作扩展名', () => {
    expect(getFileExt('.gitignore')).toBe('')
  })

  it('中文文件名也能正确取扩展名', () => {
    expect(getFileExt('前端七年_张梅梅.pdf')).toBe('pdf')
  })
})

describe('getFileKind / canPreview', () => {
  it('图片', () => {
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg']) {
      expect(getFileKind(name)).toBe('image')
    }
  })

  it('视频与音频', () => {
    expect(getFileKind('lidong.mp4')).toBe('video')
    expect(getFileKind('a.webm')).toBe('video')
    expect(getFileKind('a.mp3')).toBe('audio')
    expect(getFileKind('a.wav')).toBe('audio')
  })

  it('PDF 与文本', () => {
    expect(getFileKind('26005962-采集表.pdf')).toBe('pdf')
    expect(getFileKind('notes.md')).toBe('text')
    expect(getFileKind('data.json')).toBe('text')
    expect(getFileKind('log.txt')).toBe('text')
  })

  it('未知类型归为 other 且不支持预览', () => {
    expect(getFileKind('setup.exe')).toBe('other')
    expect(getFileKind('archive.7z')).toBe('other')
    expect(getFileKind('noext')).toBe('other')
    expect(canPreview('setup.exe')).toBe(false)
  })

  it('可预览类型 canPreview 为 true', () => {
    expect(canPreview('a.png')).toBe(true)
    expect(canPreview('a.mp4')).toBe(true)
    expect(canPreview('a.pdf')).toBe(true)
    expect(canPreview('a.txt')).toBe(true)
  })

  it('类型标签用于列表展示', () => {
    expect(getFileKindLabel('a.pdf')).toBe('PDF')
    expect(getFileKindLabel('a.mp4')).toBe('视频')
    expect(getFileKindLabel('a.exe')).toBe('其他')
  })
})

describe('getBlobMime', () => {
  it('常见类型返回正确 MIME，保证浏览器能渲染', () => {
    expect(getBlobMime('a.pdf')).toBe('application/pdf')
    expect(getBlobMime('a.png')).toBe('image/png')
    expect(getBlobMime('a.jpg')).toBe('image/jpeg')
    expect(getBlobMime('a.mp4')).toBe('video/mp4')
    expect(getBlobMime('a.mp3')).toBe('audio/mpeg')
    expect(getBlobMime('a.txt')).toBe('text/plain')
  })

  it('未知扩展名回退为二进制流', () => {
    expect(getBlobMime('a.exe')).toBe('application/octet-stream')
    expect(getBlobMime('noext')).toBe('application/octet-stream')
  })
})

describe('formatFileSize', () => {
  it('小于 1KB 显示字节', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('按单位换算', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
    // 数值 ≥100 时取整，避免「313.2 KB」这种多余精度
    expect(formatFileSize(320723)).toBe('313 KB')
    expect(formatFileSize(32172749)).toBe('30.7 MB')
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('非法值兜底为 -', () => {
    expect(formatFileSize(undefined)).toBe('-')
    expect(formatFileSize(-1)).toBe('-')
    expect(formatFileSize(Number.NaN)).toBe('-')
  })
})
