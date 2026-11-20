<template>
  <el-container class="admin-layout">
    <!-- 左侧菜单栏 -->
    <el-aside class="layout-aside" width="220px">
      <div class="aside-logo">
        <span class="logo-icon"><el-icon><Odometer /></el-icon></span>
        <span class="logo-text">Task Hub</span>
      </div>
      <el-menu
        :default-active="activeMenu"
        class="layout-menu"
        router
        @select="handleMenuSelect"
      >
        <!-- 菜单由路由表动态生成：只有 meta.title 且当前角色有权限的路由才会出现 -->
        <el-menu-item v-for="item in menuList" :key="item.path" :index="item.path">
          <el-icon v-if="item.icon">
            <component :is="resolveIcon(item.icon)" />
          </el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container class="layout-body">
      <!-- 公共头部 -->
      <el-header class="layout-header">
        <div class="header-left">
          <span class="breadcrumb-title">{{ pageTitle }}</span>
        </div>
        <div class="header-right">
          <el-dropdown trigger="click" @command="handleCommand">
            <div class="header-avatar">{{ avatarText }}</div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">
                  {{ userStore.user?.account || '用户' }}
                </el-dropdown-item>
                <el-dropdown-item command="password">修改密码</el-dropdown-item>
                <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <!-- 内容区 -->
      <el-main class="layout-main">
        <router-view />
      </el-main>
    </el-container>

    <!-- 修改密码弹窗（所有登录用户都可用，只能改自己的密码） -->
    <PasswordDialog ref="passwordDialogRef" />
  </el-container>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as ElementPlusIcons from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'
import { buildMenus } from '@/utils/permission'
import { routes } from '@/router'
import PasswordDialog from '@/components/PasswordDialog.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

// 密码管理弹窗
const passwordDialogRef = ref<InstanceType<typeof PasswordDialog>>()

// 当前登录人角色（后端 User.role，默认 member）
const currentRole = computed(() => userStore.user?.role || '')

// 左侧菜单：按当前角色过滤路由表生成，新增页面只需在 router 里加一条路由
const menuList = computed(() => buildMenus(routes, currentRole.value))

// 菜单图标：路由 meta.icon 写 Element Plus 图标名，这里从图标库里取组件
function resolveIcon(name: string) {
  const icons = ElementPlusIcons as Record<string, unknown>
  return icons[name] || undefined
}

// 当前高亮的菜单：取当前路由路径
const activeMenu = computed(() => route.path)

// 页面标题：来自路由 meta.title
const pageTitle = computed(() => (route.meta.title as string) || '')

const avatarText = computed(() => {
  const name = userStore.user?.username || 'U'
  return name.charAt(0).toUpperCase()
})

function handleMenuSelect() {
  // el-menu 配置了 router，点击会自动跳转；这里无需额外处理
}

function handleCommand(command: string) {
  if (command === 'logout') {
    // logout 会先请求后端作废刷新令牌，再清本地登录态；
    // 这里不 await 也能跳转（本地会立刻清空），但等它结束更稳妥，避免残留。
    userStore.logout()
    ElMessage.success('已退出登录')
    router.push('/login')
  } else if (command === 'password') {
    passwordDialogRef.value?.open()
  } else if (command === 'profile') {
    // 预留：个人中心
    ElMessage.info('个人中心开发中')
  }
}

/**
 * 还在使用初始密码时给出提醒。
 * 触发时机：登录成功跳转到本布局（登录页已弹过一次），
 * 以及刷新页面 / 换标签页重新进入时（从 localStorage 读回 user）。
 */
async function promptInitialPassword() {
  if (!userStore.mustChangePassword) return
  try {
    await ElMessageBox.confirm(
      '你当前还在使用初始密码，为了账号安全，建议立即修改为自己的密码。',
      '建议修改密码',
      {
        confirmButtonText: '立即修改',
        cancelButtonText: '稍后再说',
        type: 'warning',
        closeOnClickModal: false
      }
    )
    // 点「立即修改」→ 打开修改密码弹窗
    passwordDialogRef.value?.open()
  } catch {
    // 点「稍后再说」或关闭弹窗：不打扰用户
  }
}

onMounted(promptInitialPassword)
</script>

<style scoped>
.admin-layout {
  height: 100vh;
  width: 100%;
}

/* ---------- 左侧菜单（浅色清爽） ---------- */
.layout-aside {
  background: #ffffff;
  border-right: 1px solid var(--border, #e6e8eb);
  display: flex;
  flex-direction: column;
}

.aside-logo {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px;
  color: var(--text-primary, #263238);
  border-bottom: 1px solid var(--border, #e6e8eb);
}

.logo-icon {
  font-size: 18px;
  color: var(--primary, #3b82f6);
  display: inline-flex;
}

.logo-text {
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.2px;
  white-space: nowrap;
}

.layout-menu {
  flex: 1;
  background: transparent;
  border-right: none;
  padding: 8px;
}

.layout-menu :deep(.el-menu-item) {
  color: var(--text-secondary, #6b7684);
  height: 44px;
  line-height: 44px;
  border-radius: 8px;
  margin-bottom: 2px;
}

.layout-menu :deep(.el-menu-item:hover) {
  background: var(--el-fill-color-light, #f5f7fa);
  color: var(--text-primary, #263238);
}

.layout-menu :deep(.el-menu-item.is-active) {
  background: var(--primary-soft, #eff6ff);
  color: var(--primary, #3b82f6);
  font-weight: 600;
}

/* ---------- 右侧主体 ---------- */
.layout-body {
  flex-direction: column;
  min-width: 0;
}

.layout-header {
  background: #ffffff;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid var(--border, #e6e8eb);
}

.breadcrumb-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary, #263238);
}

.header-right {
  display: flex;
  align-items: center;
}

.header-avatar {
  width: 34px;
  height: 34px;
  background: var(--primary, #3b82f6);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  user-select: none;
  transition: opacity 0.15s;
}

.header-avatar:hover {
  opacity: 0.85;
}

.layout-main {
  background: var(--app-bg, #f5f6f8);
  padding: 0;
  overflow: auto;
}
</style>
