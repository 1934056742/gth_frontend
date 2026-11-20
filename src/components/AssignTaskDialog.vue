<template>
  <!-- 分配任务：从成员列表中选择一名成员，分配成功后任务状态变为「进行中」 -->
  <el-dialog
    v-model="visible"
    title="分配任务"
    width="520px"
    :close-on-click-modal="false"
    @open="loadMembers"
  >
    <div class="assign-task" v-if="task">
      <span class="assign-label">任务</span>
      <span class="assign-value">{{ task.title }}</span>
    </div>

    <el-form label-position="top">
      <el-form-item label="选择成员">
        <el-select
          v-model="selectedId"
          placeholder="请选择要分配的成员"
          size="large"
          style="width: 100%"
          filterable
          :loading="loading"
          :disabled="loading"
        >
          <el-option
            v-for="item in members"
            :key="item.id"
            :label="`${item.userName || item.account}（${item.account}）`"
            :value="item.id as number"
          />
        </el-select>
      </el-form-item>
    </el-form>

    <div v-if="!loading && members.length === 0" class="assign-empty">
      暂无可分配的成员，请先在用户管理中新建成员账号
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!selectedId" @click="handleAssign">
        确认分配
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { Task, UserData } from '@/types'
import { getUser as getUserApi } from '@/api/userList'
import { updateTask as updateTaskApi } from '@/api/task'
import { ROLE_MEMBER } from '@/utils/permission'

const visible = ref(false)
const loading = ref(false)
const submitting = ref(false)
const task = ref<Task | null>(null)

// 可分配的成员列表（只展示 role = member 的账号）
const members = ref<UserData[]>([])
const selectedId = ref<number>()

const emit = defineEmits<{
  (e: 'success'): void
}>()

/**
 * 打开分配弹窗
 * @param row 要分配的任务
 */
function open(row: Task) {
  task.value = row
  selectedId.value = undefined
  members.value = []
  visible.value = true
}

// 拉取成员列表
async function loadMembers() {
  loading.value = true
  try {
    const res: any = await getUserApi({ userName: '' })
    const list: UserData[] = res || []
    members.value = list.filter((item) => item.role === ROLE_MEMBER && item.id !== undefined)
  } catch (error: any) {
    members.value = []
    // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
    if (!error?.response) {
      ElMessage.error(error?.message || '加载成员列表失败')
    }
  } finally {
    loading.value = false
  }
}

// 确认分配：更新任务状态为「进行中」
async function handleAssign() {
  if (!task.value) return
  if (!selectedId.value) {
    ElMessage.warning('请选择要分配的成员')
    return
  }
  submitting.value = true
  try {
    const member = members.value.find((item) => item.id === selectedId.value)
    await updateTaskApi(Number(task.value.id), {
      status: 'doing',
      completedPerson: member?.userName  || '',
      userId:member?.id||null
    })
    ElMessage.success(`任务已分配给 ${member?.userName || member?.account || '该成员'}`)
    visible.value = false
    emit('success')
  } catch (error: any) {
    // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
    if (!error?.response) {
      ElMessage.error(error?.message || '分配失败，请稍后重试')
    }
  } finally {
    submitting.value = false
  }
}

defineExpose({ open })
</script>

<style scoped>
.assign-task {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 16px;
  background: var(--primary-soft, #eff6ff);
  border-radius: 8px;
  font-size: 14px;
}

.assign-label {
  flex: none;
  color: #78909c;
}

.assign-value {
  flex: 1;
  color: #263238;
  font-weight: 600;
  word-break: break-all;
}

.assign-empty {
  font-size: 12px;
  color: #e6a23c;
}
</style>
