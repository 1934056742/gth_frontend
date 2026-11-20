import request from './request'
import type {
  LoginParams,
  LoginResult,
  User,
  ChangePasswordParams
} from '@/types'

// 登录
export function login(data: LoginParams) {
  return request.post<LoginResult>('/auth/login', data)
}

// 注册
export function register(data: LoginParams) {
  return request.post<User>('/auth/register', data)
}

// 获取当前用户信息
export function getProfile() {
  return request.get<User>('/auth/profile')
}

// 修改自己的密码（校验原密码 → 设置新密码）
export function changePassword(data: ChangePasswordParams) {
  return request.put<{ message: string }>('/auth/password', data)
}

/**
 * 用刷新令牌换新的访问令牌。
 *
 * 说明：正常流程由 request.ts 的拦截器自动调用（用户无感），
 * 这里导出是为了页面初始化时也能主动续期（例如长时间挂着的页面）。
 */
export function refreshToken(data: { refreshToken: string }) {
  return request.post<LoginResult>('/auth/refresh', data)
}

/** 退出登录：后端会删除数据库里的刷新令牌，让该登录态彻底作废 */
export function logout(refreshToken: string) {
  return request.post<{ message: string }>('/auth/logout', { refreshToken })
}
