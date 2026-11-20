<template>
  <!-- 新建 / 修改任务：任务的「状态」由流转控制（新建=待办、分配=进行中、完成=已完成），
       因此表单里不提供状态选择 -->
  <el-dialog
    v-model="visible"
    :title="dialogType === 'add' ? '新建任务' : '修改任务'"
    width="480px"
    :close-on-click-modal="false"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="标题" prop="title">
        <el-input v-model="form.title" placeholder="请输入任务标题" size="large" maxlength="50" show-word-limit />
      </el-form-item>

      <el-form-item label="优先级" prop="priority">
        <el-select v-model="form.priority" placeholder="请选择优先级" size="large" style="width: 100%">
          <el-option v-for="(item, key) in priorityMaps" :key="key" :label="item.label" :value="key" />
        </el-select>
      </el-form-item>

      <el-form-item label="描述" prop="description">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="3"
          placeholder="请输入任务描述"
          maxlength="200"
          show-word-limit
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">
        {{ dialogType === 'add' ? '创建' : '保存' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import type { Task, TaskPriority, CreateTaskParams } from '@/types'
import { createTask as createTaskApi, updateTask as updateTaskApi } from '@/api/task'

const visible = ref(false)
const submitting = ref(false)
const dialogType = ref<'add' | 'edit'>('add')
const editId = ref<number>()
const formRef = ref<FormInstance>()

// 只包含标题 / 优先级 / 描述，状态不在表单里
const form = reactive<CreateTaskParams>({
  title: '',
  priority: 'medium',
  description: ''
})

// 优先级选项：与列表页展示的文案保持一致
const priorityMaps: Record<TaskPriority, { label: string }> = {
  high: { label: '高' },
  medium: { label: '中' },
  low: { label: '低' }
}

const rules = computed<FormRules>(() => ({
  title: [{ required: true, message: '请输入任务标题', trigger: 'blur' }],
  priority: [{ required: true, message: '请选择任务优先级', trigger: 'change' }]
}))

const emit = defineEmits<{
  (e: 'refresh'): void
}>()

/**
 * 打开弹窗
 * @param type 'add' 新建 | 'edit' 修改
 * @param data 修改时的任务数据
 */
function openDialog(type: string, data?: Task) {
  dialogType.value = type === 'edit' ? 'edit' : 'add'
  if (dialogType.value === 'add') {
    form.title = ''
    form.priority = 'medium'
    form.description = ''
    editId.value = undefined
  } else if (data) {
    form.title = data.title || ''
    form.priority = data.priority || 'medium'
    form.description = data.description || ''
    editId.value = Number(data.id)
  }
  visible.value = true
  // 打开弹窗时清除上一次的校验提示
  nextTick(() => formRef.value?.clearValidate())
}

async function handleSubmit() {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }

  submitting.value = true
  try {
    const params: CreateTaskParams = {
      title: form.title.trim(),
      priority: form.priority,
      description: form.description.trim()
    }
    if (dialogType.value === 'add') {
      // 不传 status，交给后端默认值（todo 待办）
      await createTaskApi(params)
      ElMessage.success('创建任务成功')
    } else {
      // 修改任务只更新标题 / 优先级 / 描述，不碰状态
      await updateTaskApi(Number(editId.value), {
        title: params.title,
        priority: params.priority,
        description: params.description
      })
      ElMessage.success('修改任务成功')
    }
    emit('refresh')
    visible.value = false
  } catch (error: any) {
    // 错误提示由 request.ts 拦截器统一弹出（后端业务错误如"任务不存在"也由它透出），
    // 这里只兜底拦截器之外抛出的异常，避免同一个错误弹两次
    if (!error?.response) {
      ElMessage.error(error?.message || '操作失败，请稍后重试')
    }
  } finally {
    submitting.value = false
  }
}

defineExpose({ openDialog })
</script>

<style scoped></style>
