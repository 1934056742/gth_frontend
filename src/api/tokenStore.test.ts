// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  saveAccessToken,
  saveTokens
} from '@/api/tokenStore'

/**
 * 双 token 本地存储测试
 *
 * 对应需求：请求头里放的 token 30 分钟失效、刷新 token 7 天失效。
 * 前端这边要保证：
 *   1. 登录后两个 token 都被保存下来（缺一个就没法无感刷新）；
 *   2. 访问令牌沿用原来的 'token' 键，路由守卫 / 直链预览读的是同一个；
 *   3. 刷新时只更新访问令牌，不能把刷新令牌弄丢；
 *   4. 登出（clearTokens）把两者和用户信息一起清干净。
 */

describe('tokenStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('登录返回的两个 token 都会被保存', () => {
    saveTokens({ token: 'access-1', refreshToken: 'refresh-1' })
    expect(getAccessToken()).toBe('access-1')
    expect(getRefreshToken()).toBe('refresh-1')
  })

  it('访问令牌沿用原来的 token 键（兼容已有路由守卫 / 预览直链）', () => {
    saveTokens({ token: 'access-1', refreshToken: 'refresh-1' })
    expect(localStorage.getItem('token')).toBe('access-1')
  })

  it('刷新时只更新访问令牌，刷新令牌保持不变', () => {
    saveTokens({ token: 'access-old', refreshToken: 'refresh-1' })
    saveAccessToken('access-new')
    expect(getAccessToken()).toBe('access-new')
    expect(getRefreshToken()).toBe('refresh-1')
  })

  it('刷新接口返回新刷新令牌时会被一并更新（后端轮换）', () => {
    saveTokens({ token: 'access-old', refreshToken: 'refresh-old' })
    saveTokens({ token: 'access-new', refreshToken: 'refresh-new' })
    expect(getAccessToken()).toBe('access-new')
    expect(getRefreshToken()).toBe('refresh-new')
  })

  it('只传访问令牌时不会误清刷新令牌', () => {
    saveTokens({ token: 'access-1', refreshToken: 'refresh-1' })
    saveTokens({ token: 'access-2' })
    expect(getRefreshToken()).toBe('refresh-1')
  })

  it('clearTokens 清空两个 token 和用户信息', () => {
    saveTokens({ token: 'access-1', refreshToken: 'refresh-1' })
    localStorage.setItem('user', '{"id":1}')
    clearTokens()
    expect(getAccessToken()).toBe('')
    expect(getRefreshToken()).toBe('')
    expect(localStorage.getItem('user')).toBeNull()
  })

  it('未登录时返回空字符串而不是 null（调用方不必判空）', () => {
    expect(getAccessToken()).toBe('')
    expect(getRefreshToken()).toBe('')
  })
})
