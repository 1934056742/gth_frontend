<template>
  <!-- 新建成员成功：展示初始账号密码，支持一键复制 -->
  <el-dialog
    v-model="visible"
    title="创建成功"
    width="440px"
    :close-on-click-modal="false"
  >
    <div class="created-tip">
      账号密码是：
    </div>

    <div class="created-row">
      <span class="created-label">账号</span>
      <span class="created-value">{{ account || '-' }}</span>
    </div>

    <div class="created-row">
      <span class="created-label">密码</span>
      <span class="created-value password-value">{{ password || '-' }}</span>
      <el-button class="copy-btn" type="primary" link @click="copyPassword">
        <el-icon><DocumentCopy /></el-icon>
        <span>复制密码</span>
      </el-button>
    </div>

    <div class="created-hint">
      密码仅本次展示，请复制后尽快告知该成员，并提醒其首次登录后修改密码。
    </div>

    <template #footer>
      <el-button type="primary" @click="visible = false">我知道了</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { DocumentCopy } from '@element-plus/icons-vue'

const visible = ref(false)
const account = ref('')
const password = ref('')

/**
 * 打开弹窗
 * @param account  新建成员的登录账号
 * @param pwd      后端 /addUser 返回的 password 字段（系统生成的初始密码）
 */
function open(accountValue: string, pwd: string) {
  account.value = accountValue || ''
  password.value = pwd || ''
  visible.value = true
}

/**
 * 复制密码到剪贴板
 * 优先用 Clipboard API（需要 https 或 localhost），不可用时降级到临时 textarea + execCommand
 */
async function copyPassword() {
  if (!password.value) {
    ElMessage.warning('暂无可复制的密码')
    return
  }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(password.value)
    } else {
      fallbackCopy(password.value)
    }
    ElMessage.success('密码已复制到剪贴板')
  } catch {
    try {
      fallbackCopy(password.value)
      ElMessage.success('密码已复制到剪贴板')
    } catch {
      ElMessage.error('复制失败，请手动选中密码复制')
    }
  }
}

function fallbackCopy(text: string) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!ok) throw new Error('execCommand copy failed')
}

defineExpose({ open })
</script>

<style scoped>
.created-tip {
  font-size: 15px;
  color: #263238;
  margin-bottom: 14px;
}

.created-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed #e4eaf1;
}

.created-row:last-of-type {
  border-bottom: none;
}

.created-label {
  width: 44px;
  flex: none;
  color: #78909c;
  font-size: 13px;
}

.created-value {
  flex: 1;
  font-size: 15px;
  color: #263238;
  word-break: break-all;
}

/* 密码用等宽字体，避免 0/O、l/1 混淆 */
.password-value {
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-weight: 600;
  color: var(--primary-active, #1e64d6);
  letter-spacing: 0.5px;
}

.copy-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.created-hint {
  margin-top: 14px;
  padding: 8px 10px;
  background: var(--primary-soft, #eff6ff);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: #5b6b7c;
}
</style>
