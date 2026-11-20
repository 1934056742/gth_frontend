<template>
  <div class="login-wrapper">
    <div class="login-card">
      <div class="login-head">
        <div class="login-logo">Task Hub</div>
        <h1>欢迎回来</h1>
        <p class="login-sub">登录以继续使用任务管理</p>
      </div>

      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item label="用户名" prop="account">
          <el-input
            v-model="form.account"
            placeholder="请输入用户名"
            size="large"
            :prefix-icon="User"
          />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            size="large"
            show-password
            :prefix-icon="Lock"
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <el-button
          type="primary"
          class="login-btn"
          size="large"
          :loading="loading"
          @click="handleLogin"
        >
          登 录
        </el-button>
      </el-form>

      <!-- 忘记密码：系统不提供自助重置，统一由管理员重置 -->
      <div class="login-links">
        <a href="#" @click.prevent="handleForgotPassword">忘记密码？</a>
      </div>

      <!-- 注册入口：目前后端注册接口未开放，保留入口方便后续启用 -->
      <div class="login-footer">
        还没有账号？ <a href="#" @click.prevent="handleRegister">去注册</a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'
import { getFirstAccessiblePath } from '@/utils/permission'
import { routes } from '@/router'

const router = useRouter()
const userStore = useUserStore()

const formRef = ref<FormInstance>()
const loading = ref(false)

const form = reactive({
  account: 'admin',
  password: '123456'
})

const rules: FormRules = {
  account: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

async function handleLogin() {
  if (!formRef.value) return
  if (loading.value) return // 防止重复点击 / 重复回车
  // 表单校验：没填账号密码直接提示，不发请求
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  loading.value = true
  try {
    await userStore.login({ ...form })
    // 提示分两处，避免弹两个框：
    //   - 这里只给一条轻提示（不阻塞、不打断跳转）；
    //   - 真正带「立即修改」按钮的确认框由 AdminLayout 挂载后弹出（刷新页面也有效）。
    if (userStore.mustChangePassword) {
      ElMessage.warning('你还在使用初始密码，请尽快修改')
    } else {
      ElMessage.success('登录成功')
    }
    // 登录后落到当前角色第一个有权限的页面（admin → 成员管理，member → 任务管理）
    const target = getFirstAccessiblePath(routes, userStore.role)
    router.push(target || '/task-manage')
  } catch (e: any) {
    // 后端登录失败返回 { error: '用户名或密码错误' }，
    // request.ts 已把它挂到 error.message 上，这里优先展示，拿不到再用兜底文案
    const msg =
      e?.response?.data?.error ||
      e?.response?.data?.message ||
      e?.message ||
      '登录失败，请稍后重试'
    ElMessageBox.alert(msg, '登录失败', {
      confirmButtonText: '我知道了',
      type: 'error',
      // 弹窗不能因为点遮罩/按 ESC 就关掉，保证用户能看到
      closeOnClickModal: false,
      closeOnPressEscape: false
    }).catch(() => {})
  } finally {
    loading.value = false
  }
}

// 注册入口：后端注册接口未开放，这里先给出提示（需要时直接替换为跳转注册页）
function handleRegister() {
  ElMessage.info('注册功能开发中，请使用默认账号登录')
}

/**
 * 忘记密码
 * 说明：本系统不提供自助重置密码（普通成员无法自己重置），
 * 统一由管理员在「成员管理」中为该账号重置，重置后会拿到一个新的初始密码。
 */
function handleForgotPassword() {
  ElMessageBox.alert(
    '本系统不提供自助重置密码。\n\n请携带账号信息联系管理员，由管理员在「成员管理」中为你重置密码，重置后会得到一个初始密码，登录后建议立即在右上角「修改密码」里改成自己的密码。',
    '忘记密码怎么办',
    {
      confirmButtonText: '我知道了',
      type: 'info',
      // 保留换行显示
      customStyle: { whiteSpace: 'pre-line' }
    }
  ).catch(() => {})
}
</script>

<style scoped>
.login-wrapper {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  background: linear-gradient(135deg, #e8f1fc 0%, #dce9fb 45%, #edf4fc 100%);
  padding: 40px 20px;
}

.login-card {
  background: #ffffff;
  border-radius: 16px;
  box-shadow: 0 10px 30px -8px rgba(0, 0, 0, 0.08);
  border: 1px solid var(--border, #e6e8eb);
  padding: 40px 44px;
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.login-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.login-logo {
  font-size: 13px;
  font-weight: 700;
  color: var(--primary, #3b82f6);
  letter-spacing: 0.3px;
  margin-bottom: 8px;
}

.login-head h1 {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-primary, #263238);
}

.login-sub {
  font-size: 14px;
  color: var(--text-muted, #909aa6);
}

.login-btn {
  width: 100%;
  border-radius: 8px;
  font-weight: 600;
  font-size: 15px;
  margin-top: 8px;
  height: 44px;
}

.login-links {
  text-align: right;
  font-size: 13px;
  margin-top: -8px;
}

.login-links a {
  color: var(--primary, #3b82f6);
  text-decoration: none;
}

.login-links a:hover {
  text-decoration: underline;
}

.login-footer {
  text-align: center;
  font-size: 14px;
  color: var(--text-secondary, #6b7684);
}

.login-footer a {
  color: var(--primary, #3b82f6);
  font-weight: 600;
  text-decoration: none;
}

/* Element Plus 输入框样式微调 */
:deep(.el-form-item) {
  margin-bottom: 22px;
}

:deep(.el-input__wrapper) {
  border-radius: 8px;
  padding: 2px 14px;
}

:deep(.el-form-item__label) {
  font-size: 13px;
  color: var(--text-secondary, #6b7684);
}
</style>
