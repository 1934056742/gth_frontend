import type { Router, RouteLocationNormalized, RouteRecordNormalized, RouteRecordRaw } from 'vue-router'

/**
 * 路由角色权限工具
 *
 * 约定：菜单 / 页面能看哪些角色，全部写在路由的 meta.role 里：
 *   - 不写 meta.role      → 所有登录用户都能看
 *   - meta.role: 'admin'  → 只有管理员能看
 *   - meta.role: 'admin:member' → 管理员和普通成员都能看（英文冒号分隔，可无限扩展）
 *
 * 以后新增角色（例如 auditor）只需：
 *   1. 后端给用户返回 role: 'auditor'；
 *   2. 让某页面：meta: { role: 'admin:auditor' }。
 * 判断逻辑不用改，属于“配置驱动”。
 */

/** 角色常量（与后端 User.role 字段取值保持一致） */
export const ROLE_ADMIN = 'admin'
export const ROLE_MEMBER = 'member'

/** 角色字段分隔符：冒号 */
export const ROLE_SEPARATOR = ':'

/** 从路由 meta 中取出原始角色配置 */
export function getRouteRole(record: Pick<RouteRecordNormalized, 'meta'> | { meta?: Record<string, unknown> }) {
  const value = (record.meta as Record<string, unknown> | undefined)?.role
  return typeof value === 'string' ? value : ''
}

/**
 * 把 'admin:member' 解析成 ['admin', 'member']
 * 容错：忽略空串、多余空白、大小写差异，同时兼容中文冒号“：”
 */
export function parseRoles(role?: string | null): string[] {
  if (!role) return []
  return role
    .split(ROLE_SEPARATOR)
    .flatMap((item) => item.split('：'))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 判断某个页面（路由记录）是否允许指定角色访问
 * @param role      路由 meta.role
 * @param userRole  当前登录人的角色
 */
export function hasRouteAccess(role: string | undefined | null, userRole: string | undefined | null): boolean {
  const allowed = parseRoles(role)
  // 没配置角色字段 → 不做角色限制（只要求登录）
  if (allowed.length === 0) return true
  const current = (userRole || '').trim().toLowerCase()
  if (!current) return false
  return allowed.includes(current)
}

/** 反向判断：当前角色是否“看不到”该页面 */
export function isRouteDenied(role: string | undefined | null, userRole: string | undefined | null): boolean {
  return !hasRouteAccess(role, userRole)
}

/** el-menu 菜单项（由路由 meta 自动生成） */
export interface MenuItem {
  /** 菜单跳转路径，同时也是 el-menu-item 的 index */
  path: string
  /** 菜单文字，取自 route.meta.title */
  title: string
  /** 图标名，取自 route.meta.icon（Element Plus 图标组件名，如 'User'） */
  icon?: string
  /** 原始角色配置，便于调试 / 扩展（如 'admin'、'admin:member'） */
  role?: string
}

/**
 * 当前登录人能访问的路由列表
 * 规则：配置了菜单标题（meta.title）且没有隐藏（meta.hidden）且角色匹配
 */
export function getAccessibleRoutes<T extends RouteRecordRaw | RouteRecordNormalized>(
  routes: readonly T[],
  userRole: string | undefined | null
): T[] {
  return routes.filter((record) => {
    const meta = (record.meta || {}) as Record<string, unknown>
    if (meta.hidden) return false
    const role = typeof meta.role === 'string' ? meta.role : undefined
    return hasRouteAccess(role, userRole)
  })
}

/**
 * 根据角色从路由表生成左侧菜单
 * 只取两层结构：Layout 根路由 → 设了 meta.title 且未 hidden 的子路由
 * 这样新增页面只要在 router 里加一条记录（带 title / icon / role），菜单自动出现，不用再改 AdminLayout
 */
export function buildMenus(routes: readonly RouteRecordRaw[], userRole: string | undefined | null): MenuItem[] {
  const menus: MenuItem[] = []

  const walk = (records: readonly RouteRecordRaw[], parentPath: string) => {
    for (const record of records) {
      const meta = (record.meta || {}) as Record<string, unknown>
      const fullPath = resolvePath(parentPath, record.path)

      // 有子路由但不是菜单节点 → 继续往下找（例如 Layout 根路由）
      if (record.children && record.children.length > 0) {
        if (typeof meta.title === 'string' && meta.title && !meta.hidden) {
          if (hasRouteAccess(meta.role as string | undefined, userRole)) {
            menus.push(toMenuItem(fullPath, meta))
          }
        } else {
          walk(record.children, fullPath)
        }
        continue
      }

      if (typeof meta.title !== 'string' || !meta.title) continue
      if (meta.hidden) continue
      if (!hasRouteAccess(meta.role as string | undefined, userRole)) continue
      // 带 :id 之类的动态路由不适合做菜单项
      if (fullPath.includes(':')) continue

      menus.push(toMenuItem(fullPath, meta))
    }
  }

  walk(routes, '')
  return menus
}

function toMenuItem(fullPath: string, meta: Record<string, unknown>): MenuItem {
  return {
    path: fullPath,
    title: meta.title as string,
    icon: typeof meta.icon === 'string' ? meta.icon : undefined,
    role: typeof meta.role === 'string' ? meta.role : undefined
  }
}

/** 拼接父子路由路径，返回以 / 开头的绝对路径 */
export function resolvePath(parentPath: string, path: string): string {
  if (path.startsWith('/')) return path
  if (!parentPath || parentPath === '/') return `/${path}`
  return `${parentPath.replace(/\/+$/, '')}/${path}`
}

/** 路由跳转字符串 → 路径（用于登录后跳转、无权限回退） */
export function toPath(target: string | { path?: string }): string {
  return typeof target === 'string' ? target : target.path || ''
}

/**
 * 当前角色第一个可访问的菜单路径
 * 用于：登录后默认落地页、访问无权限页面时的兜底跳转
 */
export function getFirstAccessiblePath(routes: readonly RouteRecordRaw[], userRole: string | undefined | null): string {
  return buildMenus(routes, userRole)[0]?.path || ''
}

/** 当前角色是否无权访问目标路径（目标不在角色可见菜单内即视为无权限） */
export function isDeniedPath(routes: readonly RouteRecordRaw[], userRole: string | undefined | null, target: string): boolean {
  if (!target) return false
  const menus = buildMenus(routes, userRole)
  if (menus.length === 0) return false
  return !menus.some((menu) => menu.path === target)
}

/**
 * 为路由安装角色校验守卫
 * 说明：守卫只做“页面级”拦截；菜单渲染由 buildMenus 完成。
 * 角色每次访问时实时读取，用户信息一更新，判断立即生效。
 *
 * 关键点：手动在浏览器地址栏输入 URL、刷新页面、菜单点击、router.push
 * 最终都会走 beforeEach，所以这里能兜住所有跳转入口。
 *   1. 取目标路由（含父级路由）meta.role 逐层校验；
 *   2. 未登录（没有 token）直接踢回登录页，不允许直接输地址绕登录；
 *   3. 已登录但无权限 → 提示 + 跳到自己第一个能看的页面。
 *
 * @param options.getRole  读取当前登录人角色
 * @param options.hasToken 是否已登录（默认读 localStorage 的 token）
 * @param options.onDenied 无权限时的回调（用于弹提示）
 * @param options.fallbackPath 当前角色均无权访问时的兜底路径（默认 /task-manage）
 */
export interface RoleGuardOptions {
  getRole: () => string | undefined | null
  hasToken?: () => boolean
  onDenied?: (to: RouteLocationNormalized) => void
  fallbackPath?: string
}

export function setupRoleGuard(router: Router, routes: readonly RouteRecordRaw[], options: RoleGuardOptions) {
  const { getRole, hasToken = () => !!localStorage.getItem('token'), onDenied, fallbackPath = '/task-manage' } = options

  router.beforeEach((to, _from, next) => {
    // 登录页本身不做角色限制
    if (to.path === '/login') return next()

    const token = hasToken()
    const needAuth = to.matched.some((record) => record.meta?.requiresAuth)

    // 1. 未登录：直接输地址也进不去，回到登录页（登录页与纯重定向路由除外）
    if (!token && (needAuth || to.matched.length > 0)) {
      return next('/login')
    }

    // 2. 角色校验：目标路由及其父级路由上配置的 role 都要满足
    const role = getRole()
    const denied = to.matched.some((record) => !hasRouteAccess(getRouteRole(record), role))
    if (!denied) return next()

    // 3. 无权限：提示并跳到当前角色第一个可访问页面（避免死循环则放行）
    //    注意：本地刷新 / 地址栏直接输入时 from 是空路由，所以这里不能依赖 from
    onDenied?.(to)
    const fallback = getFirstAccessiblePath(routes, role) || fallbackPath
    if (fallback && fallback !== to.path) {
      return next(fallback)
    }
    return next()
  })
}
