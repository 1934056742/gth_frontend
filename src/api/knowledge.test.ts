import { describe, it, expect, vi } from 'vitest'
import request from './request'
import {
  KNOWLEDGE_ACCEPT,
  KNOWLEDGE_MAX_SIZE,
  formatFileSize,
  getFileExt,
  getKnowledgeDocDetail,
  validateKnowledgeFile
} from './knowledge'
import { normalizeSource } from './ai'
import type { KnowledgeDocDetail } from '@/types'

describe('getFileExt', () => {
  it('取小写扩展名', () => {
    expect(getFileExt('说明.MD')).toBe('md')
    expect(getFileExt('a.b.txt')).toBe('txt')
  })

  it('无扩展名 / 隐藏文件 / 以点结尾返回空串', () => {
    expect(getFileExt('README')).toBe('')
    expect(getFileExt('.gitignore')).toBe('')
    expect(getFileExt('trailing.')).toBe('')
    expect(getFileExt('')).toBe('')
  })
})

describe('validateKnowledgeFile', () => {
  it('支持的文本格式通过校验', () => {
    expect(validateKnowledgeFile({ name: '手册.md', size: 1024 })).toBe('')
    expect(validateKnowledgeFile({ name: 'data.json', size: 1 })).toBe('')
  })

  it('Word(.docx) 与 PDF 通过校验', () => {
    expect(validateKnowledgeFile({ name: '需求文档.docx', size: 2048 })).toBe('')
    expect(validateKnowledgeFile({ name: '说明书.PDF', size: 2048 })).toBe('')
  })

  it('.doc 旧格式提示另存为 docx', () => {
    const message = validateKnowledgeFile({ name: '旧简历.doc', size: 1024 })
    expect(message).toContain('.doc')
    expect(message).toContain('.docx')
  })

  it('不支持的格式给出提示', () => {
    const message = validateKnowledgeFile({ name: '简历.xlsx', size: 1024 })
    expect(message).toContain('.xlsx')
    expect(message).toContain('docx')
    expect(message).toContain('pdf')
  })

  it('accept 属性包含 docx 与 pdf', () => {
    expect(KNOWLEDGE_ACCEPT).toContain('.docx')
    expect(KNOWLEDGE_ACCEPT).toContain('.pdf')
  })

  it('没有扩展名时提示格式问题', () => {
    expect(validateKnowledgeFile({ name: 'README', size: 10 })).toContain('扩展名')
  })

  it('超过大小上限时提示拆分', () => {
    const message = validateKnowledgeFile({ name: 'big.txt', size: KNOWLEDGE_MAX_SIZE + 1 })
    expect(message).toContain('MB')
  })

  it('空文件被拦下', () => {
    expect(validateKnowledgeFile({ name: 'empty.txt', size: 0 })).toContain('为空')
  })
})

describe('KNOWLEDGE_ACCEPT', () => {
  it('是带点号的逗号分隔列表', () => {
    expect(KNOWLEDGE_ACCEPT.startsWith('.txt')).toBe(true)
    expect(KNOWLEDGE_ACCEPT.split(',')).toContain('.md')
  })
})

describe('formatFileSize', () => {
  it('按量级切换单位', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('非法值兜底为 0 B', () => {
    expect(formatFileSize(undefined as unknown as number)).toBe('0 B')
  })
})

describe('getKnowledgeDocDetail', () => {
  it('请求 GET /knowledge/docs/:id（列表页「查看」用的详情接口）', async () => {
    const calls: { method?: string; url?: string }[] = []
    const spy: any = vi.spyOn(request, 'get')
    spy.mockImplementation((url: string) => {
      calls.push({ method: 'get', url })
      return Promise.resolve({
        id: 7,
        ownerId: 1,
        fileName: '手册.md',
        fileSize: 12,
        charCount: 4,
        chunkCount: 1,
        content: '正文内容',
        truncated: false
      })
    })

    try {
      // 拦截器会解包成业务数据，这里直接把返回值当详情对象使用
      const detail = (await getKnowledgeDocDetail(7)) as unknown as KnowledgeDocDetail
      expect(calls).toEqual([{ method: 'get', url: '/knowledge/docs/7' }])
      // 详情必须带正文，否则「查看」弹窗没内容可展示
      expect(detail.content).toBe('正文内容')
      expect(detail.truncated).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('normalizeSource', () => {
  it('字段齐全时原样保留，分数保留两位小数', () => {
    expect(
      normalizeSource({ docId: 3, fileName: '手册.md', seq: 2, score: 1.23456, snippet: '片段' })
    ).toEqual({ docId: 3, fileName: '手册.md', seq: 2, score: 1.23, snippet: '片段' })
  })

  it('缺字段时给出安全兜底', () => {
    expect(normalizeSource({})).toEqual({
      docId: 0,
      fileName: '未命名文档',
      seq: 0,
      score: 0,
      snippet: ''
    })
  })
})
