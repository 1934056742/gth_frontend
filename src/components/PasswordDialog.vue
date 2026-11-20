<template>
  <!-- 密码自助管理：所有登录用户都能改自己的密码，只作用于当前登录人自己的账号 -->
  <el-dialog
    v-model="visible"
    title="修改密码"
    width="440px"
    :close-on-click-modal="false"
    @closed="handleClosed"
  >
    <el-form
      ref="changeFormRef"
      :model="changeForm"
      :rules="changeRules"
      label-position="top"
      @submit.prevent
    >
      <el-form-item label="原密码" prop="oldPassword">
        <el-input
          v-model="changeForm.oldPassword"
          type="password"
          placeholder="请输入当前使用的密码"
          show-password
          :prefix-icon="Lock"
        />
      </el-form-item>

      <el-form-item label="新密码" prop="newPassword">
        <el-input
          v-model="changeForm.newPassword"
          type="password"
          placeholder="至少 6 位，需字母和数字混合"
          show-password
          :prefix-icon="Lock"
        />
      </el-form-item>

      <el-form-item label="确认新密码" prop="confirmPassword">
        <el-input
          v-model="changeForm.confirmPassword"
          type="password"
          placeholder="请再次输入新密码"
          show-password
          :prefix-icon="Lock"
          @keyup.enter="submitChange"
        />
      </el-form-item>
    </el-form>

    <div class="pwd-hint">修改成功后需要重新登录。</div>

    <template #footer>
      <el-button @click="visible = false">关 闭</el-button>
      <el-button type="primary" :loading="submitting" @click="submitChange">
        确认修改
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Lock } from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const userStore = useUserStore()

const visible = ref(false)
const submitting = ref(false)

const changeFormRef = ref<FormInstance>()

const changeForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
})

// 与后端 validateNewPassword 保持一致：6~32 位、不能纯数字 / 纯字母、不能有空格
function validatePassword(_rule: unknown, value: string, callback: (error?: Error) => void) {
  if (!value) return callback(new Error('请输入新密码'))
  if (value.length < 6) return callback(new Error('新密码至少 6 位'))
  if (value.length > 32) return callback(new Error('新密码最多 32 位'))
  if (/\s/.test(value)) return callback(new Error('新密码不能包含空格'))
  if (/^\d+$/.test(value)) return callback(new Error('新密码不能是纯数字，请混合字母'))
  if (/^[a-zA-Z]+$/.test(value)) return callback(new Error('新密码不能是纯字母，请混合数字'))
  callback()
}

function validateConfirm(_rule: unknown, value: string, callback: (error?: Error) => void) {
  if (!value) return callback(new Error('请再次输入新密码'))
  if (value !== changeForm.newPassword) return callback(new Error('两次输入的新密码不一致'))
  callback()
}

const changeRules: FormRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [{ validator: validatePassword, trigger: 'blur' }],
  confirmPassword: [{ validator: validateConfirm, trigger: 'blur' }]
}

/** 后端错误文案统一提取（request.ts 会把 error 挂到 message 上） */
function pickError(e: any, fallback: string) {
  return e?.response?.data?.error || e?.response?.data?.message || e?.message || fallback
}

/** 打开弹窗（无参数：本弹窗只有「修改密码」一件事） */
function open() {
  visible.value = true
}

/** 关闭后清空表单，避免下次打开还留着上次输入 */
function handleClosed() {
  changeForm.oldPassword = ''
  changeForm.newPassword = ''
  changeForm.confirmPassword = ''
  changeFormRef.value?.clearValidate()
}

/** 改密成功后：退出登录并回到登录页，让用户用新密码登录 */
function backToLogin(tip: string) {
  visible.value = false
  userStore.logout()
  ElMessage.success(tip)
  router.push('/login')
}

async function submitChange() {
  if (!changeFormRef.value || submitting.value) return
  const valid = await changeFormRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    await userStore.changePassword({
      oldPassword: changeForm.oldPassword,
      newPassword: changeForm.newPassword
    })
    backToLogin('密码修改成功，请使用新密码登录')
  } catch (e: any) {
    ElMessage.error(pickError(e, '修改密码失败，请稍后重试'))
  } finally {
    submitting.value = false
  }
}

defineExpose({ open })
</script>

<style scoped>
.pwd-hint {
  margin-top: 4px;
  font-size: 12px;
  color: #909aa6;
}

:deep(.el-form-item) {
  margin-bottom: 16px;
}

:deep(.el-form-item__label) {
  font-size: 13px;
  color: var(--text-secondary, #6b7684);
  padding-bottom: 4px;
}
</style>


