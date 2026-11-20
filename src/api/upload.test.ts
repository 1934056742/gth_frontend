// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { getPreviewUrl } from '@/api/upload'

/**
 * 预览直链（getPreviewUrl）单元测试
 *
 * 背景：MP4「查看失败不能播放」的根因之一，是前端把整个视频 fetch 成 Blob 再播放，
 *      导致 30MB 视频必须全量下载完才可能播放、且不能拖动进度条。
 *      改用「直链 + query token」后，<video> 由浏览器直接发 Range 请求。
 *
 * 这里锁住直链的四个约定，任何一条错了视频都会再次播不出来：
 *  1. 指向后端的下载接口（不是前端路由）；
 *  2. 必须带上 token —— <video> 无法带 Authorization 头，只能放 query；
 *  3. 默认不要 download=1（那会变成附件下载而不是内联播放）；
 *  4. 下载按钮显式传 download 时才带上 download=1。
 */

describe('getPreviewUrl', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('指向后端下载接口，并带上 token', () => {
    localStorage.setItem('token', 'abc123')
    const url = getPreviewUrl(7)
    expect(url).toContain('/upload/files/7/download')
    expect(url).toContain('token=abc123')
  })

  it('默认是内联播放，不带 download=1', () => {
    localStorage.setItem('token', 'abc123')
    expect(getPreviewUrl(7)).not.toContain('download=1')
  })

  it('显式下载时带上 download=1', () => {
    localStorage.setItem('token', 'abc123')
    expect(getPreviewUrl(7, { download: true })).toContain('download=1')
  })

  it('未登录（无 token）时不拼出空的 token 参数', () => {
    const url = getPreviewUrl(7)
    expect(url).not.toContain('token=')
    expect(url).toContain('/upload/files/7/download')
  })

  it('id 不同的文件地址不同（避免缓存串到别的文件）', () => {
    localStorage.setItem('token', 'abc123')
    expect(getPreviewUrl(1)).not.toBe(getPreviewUrl(2))
  })
})
