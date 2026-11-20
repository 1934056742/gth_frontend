/// <reference types="vite/client" />

import 'vue-router'

/**
 * 扩展 vue-router 的 RouteMeta，让 meta 字段有类型提示与校验
 * （声明放在 .d.ts 里，避免被路由文件里的方法引用干扰）
 */
declare module 'vue-router' {
  interface RouteMeta {
    /** 菜单 / 页面标题，有值才会渲染成菜单项 */
    title?: string
    /** 菜单图标：Element Plus 图标组件名，如 'User' */
    icon?: string
    /** 是否需要登录 */
    requiresAuth?: boolean
    /**
     * 允许访问的角色，英文冒号分隔，可无限扩展
     * - 不写：不限制角色（所有登录用户都可见）
     * - 'admin'：仅管理员
     * - 'admin:member'：管理员 + 普通成员
     */
    role?: string
    /** 不在菜单中显示 */
    hidden?: boolean
  }
}

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_PROXY_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
