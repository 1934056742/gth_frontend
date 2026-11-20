import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import {
  buildMenus,
  getFirstAccessiblePath,
  hasRouteAccess,
  isDeniedPath,
  parseRoles,
  resolvePath,
  setupRoleGuard
} from '@/utils/permission'

/**
 * 路由角色权限测试
 *
 * 覆盖三件事：
 *  1. parseRoles：冒号分隔的角色字符串解析（含容错）
 *  2. hasRouteAccess：不配 role = 不限制；配了 role 必须命中
 *  3. buildMenus / getFirstAccessiblePath：左侧菜单按角色过滤
 */

const stub = { render: () => null }

// 与 src/router/index.ts 保持一致的精简路由表
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/task-manage' },
  { path: '/login', component: stub, meta: { title: '登录', hidden: true } },
  {
    path: '/',
    component: stub,
    meta: { requiresAuth: true },
    children: [
      { path: 'userList', component: stub, meta: { title: '成员管理', icon: 'User', requiresAuth: true, role: 'admin' } },
      { path: 'task-manage', component: stub, meta: { title: '任务管理', icon: 'Tickets', requiresAuth: true, role: 'admin:member' } },
      { path: 'file-upload', component: stub, meta: { title: '文件上传', icon: 'Upload', requiresAuth: true, role: 'admin:member' } },
      { path: 'product-category', component: stub, meta: { title: '文件分类', icon: 'Operation', requiresAuth: true, role: 'admin' } },
      { path: 'dashboard', component: stub, meta: { title: 'AI 答疑', icon: 'MagicStick', requiresAuth: true } },
      { path: 'system-setting', component: stub, meta: { title: '系统设置', requiresAuth: true, hidden: true } }
    ]
  }
]

describe('parseRoles 角色字符串解析', () => {
  it('单个角色', () => {
    expect(parseRoles('admin')).toEqual(['admin'])
  })

  it('冒号分隔的多个角色', () => {
    expect(parseRoles('admin:member')).toEqual(['admin', 'member'])
  })

  it('兼容中文冒号、空格、大小写、空串', () => {
    expect(parseRoles(' Admin ： Member : ')).toEqual(['admin', 'member'])
    expect(parseRoles('')).toEqual([])
    expect(parseRoles(undefined)).toEqual([])
    expect(parseRoles(null)).toEqual([])
  })

  it('以后新增角色无需改代码', () => {
    expect(parseRoles('admin:member:auditor')).toEqual(['admin', 'member', 'auditor'])
  })
})

describe('hasRouteAccess 页面访问判断', () => {
  it('未配置 role → 任何角色都能访问', () => {
    expect(hasRouteAccess(undefined, 'admin')).toBe(true)
    expect(hasRouteAccess(undefined, 'member')).toBe(true)
    expect(hasRouteAccess('', 'member')).toBe(true)
  })

  it('role 为 admin → 只有管理员能访问', () => {
    expect(hasRouteAccess('admin', 'admin')).toBe(true)
    expect(hasRouteAccess('admin', 'member')).toBe(false)
  })

  it('role 为 admin:member → 两种角色都能访问', () => {
    expect(hasRouteAccess('admin:member', 'admin')).toBe(true)
    expect(hasRouteAccess('admin:member', 'member')).toBe(true)
    expect(hasRouteAccess('admin:member', 'auditor')).toBe(false)
  })

  it('没拿到角色信息（老缓存）→ 受限页面一律拦截', () => {
    expect(hasRouteAccess('admin:member', '')).toBe(false)
    expect(hasRouteAccess('admin:member', undefined)).toBe(false)
  })

  it('新增角色只需在 role 里加名字', () => {
    expect(hasRouteAccess('admin:auditor', 'auditor')).toBe(true)
    expect(hasRouteAccess('admin:auditor', 'member')).toBe(false)
  })
})

describe('buildMenus 按角色生成左侧菜单', () => {
  it('管理员看到全部 5 个菜单项', () => {
    expect(buildMenus(routes, 'admin').map((m) => m.title)).toEqual([
      '成员管理',
      '任务管理',
      '文件上传',
      '文件分类',
      'AI 答疑'
    ])
  })

  it('普通成员只看到 任务管理 / 文件上传 / AI 答疑', () => {
    expect(buildMenus(routes, 'member').map((m) => m.title)).toEqual(['任务管理', '文件上传', 'AI 答疑'])
  })

  it('菜单项包含绝对路径与图标名', () => {
    const menus = buildMenus(routes, 'member')
    expect(menus[0]).toMatchObject({ path: '/task-manage', title: '任务管理', icon: 'Tickets' })
    expect(menus[2]).toMatchObject({ path: '/dashboard', title: 'AI 答疑', icon: 'MagicStick' })
  })

  it('hidden 路由（登录页 / 系统设置）不会出现在菜单里', () => {
    const titles = buildMenus(routes, 'admin').map((m) => m.title)
    expect(titles).not.toContain('登录')
    expect(titles).not.toContain('系统设置')
  })
})

describe('getFirstAccessiblePath / isDeniedPath', () => {
  it('管理员默认落地成员管理，普通成员默认落地任务管理', () => {
    expect(getFirstAccessiblePath(routes, 'admin')).toBe('/userList')
    expect(getFirstAccessiblePath(routes, 'member')).toBe('/task-manage')
  })

  it('无权访问的路径能被识别', () => {
    expect(isDeniedPath(routes, 'member', '/userList')).toBe(true)
    expect(isDeniedPath(routes, 'member', '/product-category')).toBe(true)
    expect(isDeniedPath(routes, 'member', '/task-manage')).toBe(false)
    expect(isDeniedPath(routes, 'admin', '/userList')).toBe(false)
  })
})

describe('resolvePath 路径拼接', () => {
  it('父子路由拼接为绝对路径', () => {
    expect(resolvePath('/', 'userList')).toBe('/userList')
    expect(resolvePath('/admin', 'userList')).toBe('/admin/userList')
    expect(resolvePath('', 'userList')).toBe('/userList')
    expect(resolvePath('/admin/', '/absolute')).toBe('/absolute')
  })
})

/**
 * 路由守卫测试：模拟“浏览器地址栏直接输入 URL / 刷新页面”时的跳转结果
 * 用真实的 createRouter + createMemoryHistory，执行真实的 beforeEach 链
 */
describe('setupRoleGuard 路由跳转拦截', () => {
  // role 传 null 表示“登录了但本地缓存里没有 user / role”，属于真实存在的场景，
  // 因此参数类型要允许 null，否则 vue-tsc 报 TS2345
  const buildRouter = (role: string | null, token: string | null, denied: string[] = []) => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    setupRoleGuard(router, routes, {
      getRole: () => role,
      hasToken: () => !!token,
      onDenied: (to) => denied.push(to.path)
    })
    return { router, denied }
  }

  it('普通成员直接在地址栏输入 /userList → 被拦回 /task-manage', async () => {
    const { router, denied } = buildRouter('member', 'fake-token')
    await router.push('/userList')
    expect(router.currentRoute.value.path).toBe('/task-manage')
    expect(denied).toEqual(['/userList'])
  })

  it('普通成员直接输入 /product-category → 也被拦回 /task-manage', async () => {
    const { router } = buildRouter('member', 'fake-token')
    await router.push('/product-category')
    expect(router.currentRoute.value.path).toBe('/task-manage')
  })

  it('管理员可以直接进入管理员专属页面', async () => {
    const { router, denied } = buildRouter('admin', 'fake-token')
    await router.push('/userList')
    expect(router.currentRoute.value.path).toBe('/userList')
    await router.push('/product-category')
    expect(router.currentRoute.value.path).toBe('/product-category')
    expect(denied).toEqual([])
  })

  it('普通成员可以进入公共页面（任务管理 / 文件上传 / AI 答疑）', async () => {
    const { router, denied } = buildRouter('member', 'fake-token')
    for (const path of ['/task-manage', '/file-upload', '/dashboard']) {
      await router.push(path)
      expect(router.currentRoute.value.path).toBe(path)
    }
    expect(denied).toEqual([])
  })

  it('未登录时直接输地址 → 一律回到 /login', async () => {
    const { router } = buildRouter(null, null)
    for (const path of ['/userList', '/task-manage', '/dashboard']) {
      await router.push(path)
      expect(router.currentRoute.value.path).toBe('/login')
    }
  })

  it('登录页本身不受角色限制', async () => {
    const { router } = buildRouter('member', null)
    await router.push('/login')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('角色缺失（本地缓存无 user）时，受限页面不允许进入', async () => {
    // 登录了（有 token）但本地没有 user 缓存 → 取不到角色，受限页面应被拦截
    const { router } = buildRouter(null, 'fake-token')
    await router.push('/userList')
    // 兜底到自己第一个可访问页面；没有角色时公共页面仍可访问
    expect(router.currentRoute.value.path).toBe('/dashboard')
  })
})

