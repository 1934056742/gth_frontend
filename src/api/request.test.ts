// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 拦截器无感刷新测试
 *
 * 这是双 token 方案里最容易出问题的一块，重点锁住三件事：
 *   1. 访问令牌过期（401）→ 自动用刷新令牌换新 token → 原请求自动重发，用户无感；
 *   2. 并发多个请求同时 401 → 只发一次刷新请求（后端刷新会轮换旧令牌，
 *      重复刷新会把用户直接踢下线）；
 *   3. 刷新令牌也失效 → 清登录态、回登录页，且不无限重试。
 *
 * 做法：替换 axios 默认 adapter 来扮演后端，不联网。
 * axios.create() 会继承 defaults.adapter，所以在 import request 之前设置即可。
 */

type Handler = (config: any, callIndex: number) => Promise<any> | any

/** 记录到后端的所有请求（用于断言调用次数 / 请求头） */
let calls: Array<{ url: string; method: string; auth?: string; data?: any }> = []
/** 由每个用例指定的「后端行为」 */
let apiHandler: Handler
let refreshHandler: Handler

function makeResponse(config: any, status: number, data: any) {
  return Promise.resolve({ data, status, statusText: String(status), headers: {}, config })
}

/** 像真实后端一样：非 2xx 要让 axios 抛出，拦截器的错误分支才会执行 */
function rejectWith(status: number, data: any, config: any) {
  const error: any = new Error(`Request failed with status code ${status}`)
  error.config = config
  error.response = { status, data, headers: {}, config }
  error.isAxiosError = true
  return Promise.reject(error)
}

function installFakeBackend(axios: any) {
  axios.defaults.adapter = async (config: any) => {
    const url = String(config.url || '')
    const rawData = config.data
    calls.push({
      url,
      method: String(config.method || 'get'),
      auth: config.headers?.Authorization,
      data: typeof rawData === 'string' ? JSON.parse(rawData) : rawData
    })

    if (url.includes('/auth/refresh')) return refreshHandler(config, calls.length)
    return apiHandler(config, calls.length)
  }
}

async function loadRequest() {
  vi.resetModules()
  // ElMessage 会操作 DOM / 弹层，这里静默掉
  vi.doMock('element-plus', () => ({
    ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
  }))
  const axiosMod = await import('axios')
  installFakeBackend(axiosMod.default)
  return import('./request')
}

describe('request 拦截器 · 无感刷新', () => {
  beforeEach(() => {
    localStorage.clear()
    calls = []
    // jsdom 里改 location.href 会报「Not implemented」，换成可观测的桩
    delete (window as any).location
    ;(window as any).location = { pathname: '/task-manage', href: '' }
    apiHandler = (config) => makeResponse(config, 200, { ok: true })
    refreshHandler = (config) =>
      makeResponse(config, 200, { token: 'new-access', refreshToken: 'new-refresh' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('element-plus')
  })

  it('正常请求带上访问令牌', async () => {
    const request = (await loadRequest()).default
    localStorage.setItem('token', 'access-1')
    localStorage.setItem('refreshToken', 'refresh-1')

    await request.get('/tasks')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.auth).toBe('Bearer access-1')
  })

  it('访问令牌过期时自动刷新并重放原请求（用户无感）', async () => {
    const request = (await loadRequest()).default
    localStorage.setItem('token', 'expired')
    localStorage.setItem('refreshToken', 'refresh-1')

    apiHandler = (config) => {
      if (config.headers?.Authorization === 'Bearer expired') {
        return rejectWith(401, { error: '登录已过期', code: 'TOKEN_EXPIRED' }, config)
      }
      return makeResponse(config, 200, { ok: true })
    }

    const result: any = await request.get('/tasks')

    expect(result.ok).toBe(true)
    // 3 次调用：原请求 → 刷新 → 重放原请求（刷新走的是带 baseURL 的完整地址）
    expect(calls.map((c) => c.url)).toEqual(['/tasks', '/api/auth/refresh', '/tasks'])
    expect(calls[2]!.auth).toBe('Bearer new-access')
    // 本地换成新的访问令牌 + 后端轮换后的刷新令牌
    expect(localStorage.getItem('token')).toBe('new-access')
    expect(localStorage.getItem('refreshToken')).toBe('new-refresh')
  })

  it('并发多个请求同时 401：只刷新一次', async () => {
    const request = (await loadRequest()).default
    localStorage.setItem('token', 'expired')
    localStorage.setItem('refreshToken', 'refresh-1')

    // 让刷新慢一点，确保并发的请求都在刷新期间排队
    refreshHandler = async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return makeResponse(config, 200, { token: 'new-access', refreshToken: 'new-refresh' })
    }
    apiHandler = (config) => {
      if (config.headers?.Authorization === 'Bearer expired') {
        return rejectWith(401, { error: '登录已过期', code: 'TOKEN_EXPIRED' }, config)
      }
      return makeResponse(config, 200, { ok: true })
    }

    const results: any[] = await Promise.all([
      request.get('/a'),
      request.get('/b'),
      request.get('/c'),
      request.get('/d')
    ])

    expect(results.every((r) => r.ok)).toBe(true)
    expect(calls.filter((c) => c.url.includes('/auth/refresh'))).toHaveLength(1)
  })

  it('刷新令牌也失效：清登录态并跳登录页，不无限重试', async () => {
    const request = (await loadRequest()).default
    localStorage.setItem('token', 'expired')
    localStorage.setItem('refreshToken', 'refresh-invalid')
    localStorage.setItem('user', '{"id":1}')

    apiHandler = (config) => rejectWith(401, { error: '需要登录' }, config)
    refreshHandler = (config) =>
      rejectWith(401, { error: '刷新令牌无效', code: 'REFRESH_INVALID' }, config)

    await expect(request.get('/tasks')).rejects.toBeTruthy()

    expect(calls.filter((c) => c.url.includes('/auth/refresh'))).toHaveLength(1)
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('refreshToken')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
    expect(window.location.href).toBe('/login')
  })

  it('登录接口的 401 不触发刷新（账号密码错误）', async () => {
    const request = (await loadRequest()).default

    apiHandler = (config) => rejectWith(401, { error: '用户名或密码错误' }, config)

    await expect(
      request.post('/auth/login', { account: 'a', password: 'b' })
    ).rejects.toMatchObject({ message: '用户名或密码错误' })
    expect(calls.filter((c) => c.url.includes('/auth/refresh'))).toHaveLength(0)
  })

  it('重放后的请求仍然 401 时不再刷新（防止死循环）', async () => {
    const request = (await loadRequest()).default
    localStorage.setItem('token', 'expired')
    localStorage.setItem('refreshToken', 'refresh-1')

    apiHandler = (config) => rejectWith(401, { error: '需要登录' }, config)

    await expect(request.get('/tasks')).rejects.toBeTruthy()

    expect(calls.filter((c) => c.url.includes('/auth/refresh'))).toHaveLength(1)
  })
})
