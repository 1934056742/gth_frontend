import axios from 'axios'
import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  saveTokens
} from './tokenStore'

// 创建 axios 实例
// baseURL 从环境变量读取：开发 /api（走代理），生产按 .env.production 配置
const service: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 15000
})

// 请求拦截器
service.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getAccessToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 取出后端返回的错误提示
// 后端业务错误统一返回 { error: '用户名或密码错误' }，部分老接口可能用 message
function getServerMessage(data: any): string | undefined {
  return data?.error || data?.message
}

// 当前请求是否是登录接口（登录接口的 401 是"账号密码错误"，不是"登录过期"）
function isLoginRequest(config?: InternalAxiosRequestConfig): boolean {
  const url = config?.url || ''
  return url.includes('/auth/login')
}

// 是否是刷新令牌接口本身（它返回 401 说明刷新令牌也失效了，不能再递归刷新）
function isRefreshRequest(config?: InternalAxiosRequestConfig): boolean {
  const url = config?.url || ''
  return url.includes('/auth/refresh')
}

// ============================================================
// 无感刷新（双 token 的核心）
//
// 流程：访问令牌 30 分钟过期 → 请求返回 401 且 code === 'TOKEN_EXPIRED'
//      → 用刷新令牌换一个新的访问令牌 → 自动重放刚才失败的请求。
// 用户完全感知不到，只有当刷新令牌（7 天）也失效时才回登录页。
//
// 两个必须处理的细节：
//   1. 并发去重：页面同时发 5 个请求，全部 401 时只应该刷新一次，
//      否则会用同一个刷新令牌打 5 次（后端轮换后，后 4 次会失败并踢人下线）。
//      用 refreshPromise 做单例，其余请求排队等它。
//   2. 请求重放：刷新成功后，把排队中的请求带上新 token 重发，
//      并标记 _retry 避免死循环。
// ============================================================

/** 标记：这个请求已经重试过一次，不再重试（防止无限循环） */
interface RetriableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean
}

/** 正在进行的刷新请求（单例：并发 401 只刷新一次） */
let refreshPromise: Promise<string> | null = null

/** 登录页跳转：避免多个请求同时失败时重复跳转 */
function redirectToLogin() {
  clearTokens()
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = '/login'
  }
}

/**
 * 用刷新令牌换新的访问令牌。
 * 注意：这里用独立的 axios 实例，避免走后端拦截器造成递归。
 */
async function refreshAccessToken(): Promise<string> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) {
    throw new Error('没有刷新令牌')
  }
  const baseURL = import.meta.env.VITE_API_BASE || '/api'
  const res = await axios.post(
    `${baseURL}/auth/refresh`,
    { refreshToken },
    { timeout: 15000 }
  )
  const data = res.data || {}
  if (!data.token) {
    throw new Error('刷新登录状态失败')
  }
  // 后端会轮换刷新令牌，这里一并存下
  saveTokens({ token: data.token, refreshToken: data.refreshToken })
  return data.token as string
}

/** 获取（或发起）当前唯一的刷新任务 */
function ensureRefreshing(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      // 无论成功失败都释放，让下一次过期能重新刷新
      refreshPromise = null
    })
  }
  return refreshPromise
}

/**
 * 供非 axios 的请求复用（如 AI 的 SSE 流式接口）。
 *
 * 为什么需要：SSE 用 fetch 实现，拿不到 axios 拦截器的自动刷新；
 * 但刷新逻辑必须只有一份——否则两边可能同时用同一个刷新令牌去刷新，
 * 后端一作废旧令牌，其中一方就会被踢下线。
 *
 * @returns 新的访问令牌
 */
export function refreshAccessTokenShared(): Promise<string> {
  return ensureRefreshing()
}

/** 供非 axios 的请求在刷新彻底失败时调用：清登录态并回登录页 */
export function forceLogout(): void {
  redirectToLogin()
}

// 响应拦截器
service.interceptors.response.use(
  (response: AxiosResponse) => {
    const res = response.data
    // 统一处理后端返回格式 { code, data, message }
    if (res.code !== undefined && res.code !== 0 && res.code !== 200) {
      const msg = getServerMessage(res) || '请求失败'
      ElMessage.error(msg)
      return Promise.reject(new Error(msg))
    }
    return res
  },
  async (error) => {
    if (error.response) {
      const { status, config } = error.response
      // 优先使用后端返回的具体提示（如"用户名或密码错误"），拿不到再用兜底文案
      const serverMsg = getServerMessage(error.response.data)

      // ---------- 访问令牌过期：静默刷新后重放 ----------
      if (
        status === 401 &&
        !isLoginRequest(config) &&
        !isRefreshRequest(config) &&
        !(config as RetriableConfig)?._retry
      ) {
        (config as RetriableConfig)._retry = true
        try {
          const newToken = await ensureRefreshing()
          // 用新 token 重放原请求
          config.headers = config.headers || {}
          config.headers.Authorization = `Bearer ${newToken}`
          return service(config)
        } catch {
          // 刷新也失败（刷新令牌过期 / 被新登录挤掉）→ 只能重新登录
          ElMessage.error('登录已过期，请重新登录')
          redirectToLogin()
          return Promise.reject(error)
        }
      }

      if (status === 401) {
        // 登录接口：账号/密码错误，只把提示透出给调用方（登录页自己弹提示），
        // 不做跳转，也不清 token，避免整页刷新把提示冲掉
        if (isLoginRequest(config)) {
          error.message = serverMsg || '用户名或密码错误'
          return Promise.reject(error)
        }
        // 其他情况（刷新令牌也失效 / 用户不存在）：清登录态并回到登录页
        ElMessage.error(serverMsg || '登录已过期，请重新登录')
        redirectToLogin()
      } else if (status === 403) {
        ElMessage.error(serverMsg || '没有权限访问')
      } else if (status === 500) {
        ElMessage.error(serverMsg || '服务器错误，请稍后重试')
      } else {
        ElMessage.error(serverMsg || '请求失败')
      }
      // 把后端文案挂到 error.message 上，页面 catch 里可直接展示，无需再猜字段
      if (serverMsg) error.message = serverMsg
    } else if (axios.isCancel(error) || (error as any)?.code === 'ERR_CANCELED') {
      // ---------- 用户主动取消（例如点击「暂停」中止分片上传） ----------
      // 这不是网络故障：绝不能弹「网络异常」，也不应该改写成网络错误文案，
      // 否则暂停大文件上传时用户会看到一个莫名其妙的报错提示。
      // 上层（uploadManager）通过 axios.isCancel 识别并静默处理。
    } else {
      ElMessage.error('网络异常，请检查网络连接')
      error.message = '网络异常，请检查网络连接'
    }
    return Promise.reject(error)
  }
)

export default service
