import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ROLE_ADMIN, setupRoleGuard } from '@/utils/permission'
import { getAccessToken } from '@/api/tokenStore'

/**
 * 路由表（同时是左侧菜单的数据源）
 *
 * meta 字段说明：
 *   title       菜单 / 页面标题，有值才会渲染成菜单项
 *   icon        Element Plus 图标组件名（如 'User'），用于菜单图标
 *   requiresAuth 是否需要登录
 *   role        允许访问的角色，冒号分隔，可无限扩展：
 *               - 不写该字段 → 不限制角色（所有登录用户都能看）
 *               - 'admin'    → 仅管理员
 *               - 'admin:member' → 管理员 + 普通成员
 *
 * 当前规则：
 *   admin   → 成员管理、任务管理、文件上传、文件分类、AI 答疑（全部页面）
 *   member  → 任务管理、文件上传、AI 答疑
 */
export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/task-manage'
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    // 登录页不进菜单：hidden
    meta: { title: '登录', hidden: true }
  },
  {
    path: '/',
    component: () => import('@/components/AdminLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: 'userList',
        name: 'UserList',
        component: () => import('@/views/UserList.vue'),
        // 仅管理员可见
        meta: { title: '成员管理', icon: 'User', requiresAuth: true, role: ROLE_ADMIN }
      },
      {
        path: 'task-manage',
        name: 'TaskManage',
        component: () => import('@/views/TaskManage.vue'),
        // 管理员 + 普通成员都可见
        meta: { title: '任务管理', icon: 'Tickets', requiresAuth: true, role: 'admin:member' },
        
      },
      //任务详情：从任务管理页点「详情」进入，路径 /task-details/:id
      // 不进左侧菜单（hidden），但同样要登录 + 角色校验，否则地址栏直接输入可绕过权限
      {
        path: 'task-details/:id',
        name: 'TaskDetails',
        component: () => import('@/views/TaskDetails.vue'),
        meta: { title: '任务详情', requiresAuth: true, role: 'admin:member', hidden: true }
      },
      {
        path: 'file-upload',
        name: 'FileUpload',
        component: () => import('@/views/FileUpload.vue'),
        // 仅管理员可用：成员改为在「任务详情」页上传文件，
        // 因此菜单对成员隐藏，地址栏直接访问也会被 setupRoleGuard 拦回
        meta: { title: '文件上传', icon: 'Upload', requiresAuth: true, role: ROLE_ADMIN }
      },
      {
        path: 'product-category',
        name: 'ProductCategory',
        component: () => import('@/views/ProductCategoryView.vue'),
        // 仅管理员可见
        meta: { title: '文件分类', icon: 'Operation', requiresAuth: true, role: ROLE_ADMIN }
      },
      {
        path: 'ai-chat',
        name: 'AiChat',
        component: () => import('@/views/AiChatView.vue'),
        // AI 答疑（左侧历史会话 + 右侧流式对话），admin 与 member 都可用 → 不限制角色
        meta: { title: 'AI 答疑', icon: 'MagicStick', requiresAuth: true }
      },
      {
        path: 'system-setting',
        name: 'SystemSetting',
        component: () => import('@/views/SystemSetting.vue'),
        // 暂不开放，不进菜单
        meta: { title: '系统设置', icon: 'Setting', requiresAuth: true, hidden: true }
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// 统一守卫：未登录跳登录页 + 每次跳转（含地址栏直接输入 / 刷新）校验角色
// 注意：不再单独写“未登录”守卫，避免两个 beforeEach 相互覆盖
setupRoleGuard(router, routes, {
  // 角色实时从本地缓存读取（登录时由 userStore 写入，结构：{ id, account, role }）
  getRole: () => {
    try {
      return JSON.parse(localStorage.getItem('user') || 'null')?.role
    } catch {
      return undefined
    }
  },
  // 没有访问令牌视为未登录（读的是本地实际的 'token' 键）
  hasToken: () => !!getAccessToken(),
  // 有权限限制的页面被拦截时给出提示
  onDenied: (to) => {
    const title = (to.meta.title as string) || to.path
    ElMessage.warning(`无权访问「${title}」，已返回可访问页面`)
  },
  fallbackPath: '/task-manage'
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} - Geek Task Hub` : 'Geek Task Hub'
})

export default router
