import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User, LoginParams, ChangePasswordParams } from '@/types'
import {
  login as loginApi,
  register as registerApi,
  getProfile,
  changePassword as changePasswordApi,
  logout as logoutApi
} from '@/api/auth'
import { clearTokens, getAccessToken, getRefreshToken, saveTokens } from '@/api/tokenStore'
import { ROLE_ADMIN, ROLE_MEMBER } from '@/utils/permission'

export const useUserStore = defineStore('user', () => {
  // 访问令牌（30 分钟）。刷新令牌只给拦截器用，页面无需关心，因此不放进 store
  const token = ref<string>(getAccessToken())
  const user = ref<User | null>(JSON.parse(localStorage.getItem('user') || 'null'))

  const isLoggedIn = computed(() => !!token.value)

  // 当前登录人角色（后端未返回时按普通成员处理）
  const role = computed(() => user.value?.role || ROLE_MEMBER)

  // 是否管理员
  const isAdmin = computed(() => role.value === ROLE_ADMIN)

  // 是否还在用初始密码：登录时由后端下发，改密成功后本地同步更新
  const mustChangePassword = computed(() => !!user.value?.mustChangePassword)

  // 重新拉取用户信息并写回本地（角色变更 / 老缓存没有 role 字段时使用）
  async function fetchProfile() {
    const res: any = await getProfile()
    const data = res?.data || res
    if (data) {
      user.value = { ...(user.value || {}), ...data }
      localStorage.setItem('user', JSON.stringify(user.value))
    }
    return user.value
  }

  // 登录
  async function login(params: LoginParams) {
    const res: any = await loginApi(params)
    const data = res.data || res
    token.value = data.token
    user.value = data.user
    // 同时保存访问令牌与刷新令牌：前者 30 分钟，后者 7 天
    saveTokens({ token: data.token, refreshToken: data.refreshToken })
    localStorage.setItem('user', JSON.stringify(data.user))
    return data
  }

  // 注册
  async function register(params: LoginParams) {
    const res: any = await registerApi(params)
    return res.data || res
  }

  // 退出登录
  // 说明：本地登录态立即清空（不依赖网络，避免后端不可用时退不出去），
  //      同时通知后端删除刷新令牌，否则该令牌在 7 天内仍然可用。
  async function logout() {
    const refreshToken = getRefreshToken()
    token.value = ''
    user.value = null
    clearTokens()
    if (refreshToken) {
      try {
        await logoutApi(refreshToken)
      } catch {
        /* 后端不可用 / 令牌已失效：本地已经清干净，忽略即可 */
      }
    }
  }

  // 本地更新「是否还在用初始密码」标记，并同步写到 localStorage，
  // 保证刷新页面后提示状态不会回退
  function setMustChangePassword(value: boolean) {
    if (!user.value) return
    user.value.mustChangePassword = value
    localStorage.setItem('user', JSON.stringify(user.value))
  }

  // 修改自己的密码：成功后后端已清掉初始密码标记，这里同步本地状态
  async function changePassword(params: ChangePasswordParams) {
    const res: any = await changePasswordApi(params)
    setMustChangePassword(false)
    return res?.data || res
  }

  return {
    token,
    user,
    isLoggedIn,
    role,
    isAdmin,
    mustChangePassword,
    login,
    register,
    fetchProfile,
    logout,
    setMustChangePassword,
    changePassword
  }
})
