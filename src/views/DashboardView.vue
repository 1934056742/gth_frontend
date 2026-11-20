<template>
  <div class="dashboard-wrapper">
    <!-- 看板工具栏：AI 智能总结 -->
    <div class="toolbar">
      <el-button class="ai-btn" plain @click="openAiDrawer">
        <el-icon style="margin-right: 4px;"><MagicStick /></el-icon>
        AI 智能总结
      </el-button>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-info">
          <h4>总任务</h4>
          <h2>{{ taskStore.totalCount }}</h2>
        </div>
        <div class="stat-dot" style="background: #3b82f6;"></div>
      </div>
      <div class="stat-card">
        <div class="stat-info">
          <h4>进行中</h4>
          <h2>{{ taskStore.doingCount }}</h2>
        </div>
        <div class="stat-dot" style="background: #d58923;"></div>
      </div>
      <div class="stat-card">
        <div class="stat-info">
          <h4>已完成</h4>
          <h2>{{ taskStore.doneCount }}</h2>
        </div>
        <div class="stat-dot" style="background: #22a06b;"></div>
      </div>
    </div>

    <!-- 三列看板 -->
    <div class="board">
      <BoardColumn
        title="待办"
        status="todo"
        :tasks="taskStore.todoTasks"
        @update-task="openEditDialog"
      />
      <BoardColumn
        title="进行中"
        status="doing"
        :tasks="taskStore.doingTasks"
        @update-task="openEditDialog"
      />
      <BoardColumn
        title="已完成"
        status="done"
        :tasks="taskStore.doneTasks"
        @update-task="openEditDialog"
      />
    </div>


    <!-- 新建任务按钮 -->
    <div class="add-task-fab">
      <el-button type="primary" circle size="large" @click="openCreateDialog">
        <el-icon><Plus /></el-icon>
      </el-button>
    </div>

    <!-- 新建任务对话框 -->
    <el-dialog
      v-model="createDialogVisible"
      title="新建任务"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-position="top">
        <el-form-item label="任务标题" prop="title">
          <el-input
            v-model="createForm.title"
            placeholder="请输入任务标题"
            size="large"
          />
        </el-form-item>
         <el-form-item label="任务描述" prop="title">
          <el-input
            v-model="createForm.description"
            placeholder="请输入任务描述"
            size="large"
            type="textarea"
          />
        </el-form-item>
        <el-form-item label="优先级" prop="priority">
          <el-radio-group v-model="createForm.priority">
            <el-radio-button value="high">高</el-radio-button>
            <el-radio-button value="medium">中</el-radio-button>
            <el-radio-button value="low">低</el-radio-button>
          </el-radio-group>
        </el-form-item>
           <el-form-item label="状态" prop="status">
          <el-radio-group v-model="createForm.status">
            <el-radio-button value="todo">待办</el-radio-button>
            <el-radio-button value="doing">进行中</el-radio-button>
            <el-radio-button value="done">已完成</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="handleCreateTask">
          创建
        </el-button>
      </template>
    </el-dialog>

    <!-- 编辑任务对话框 -->
    <el-dialog
      v-model="editDialogVisible"
      title="编辑任务"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form ref="editFormRef" :model="editForm" :rules="editRules" label-position="top">
        <el-form-item label="任务标题" prop="title">
          <el-input
            v-model="editForm.title"
            placeholder="请输入任务标题"
            size="large"
          />
        </el-form-item>
        <el-form-item label="任务描述">
          <el-input
            v-model="editForm.description"
            placeholder="请输入任务描述"
            size="large"
            type="textarea"
          />
        </el-form-item>
        <el-form-item label="优先级" prop="priority">
          <el-radio-group v-model="editForm.priority">
            <el-radio-button value="high">高</el-radio-button>
            <el-radio-button value="medium">中</el-radio-button>
            <el-radio-button value="low">低</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-radio-group v-model="editForm.status">
            <el-radio-button value="todo">待办</el-radio-button>
            <el-radio-button value="doing">进行中</el-radio-button>
            <el-radio-button value="done">已完成</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="editing" @click="handleEditTask">
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- AI 侧边栏 -->
    <AiDrawer ref="aiDrawerRef" />
  </div>
</template>


<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Plus, MagicStick } from '@element-plus/icons-vue'
import { useTaskStore } from '@/stores/task'
import type { Task, TaskStatus, TaskPriority } from '@/types'
import BoardColumn from '@/components/BoardColumn.vue'
import AiDrawer from '@/components/AiDrawer.vue'

const taskStore = useTaskStore()

const aiDrawerRef = ref<InstanceType<typeof AiDrawer>>()
const createDialogVisible = ref(false)
const creating = ref(false)
const createFormRef = ref<FormInstance>()

const createForm = reactive({
  title: '',
  description:'',
  priority: 'medium' as TaskPriority,
  status:'todo'  as TaskStatus

})

const createRules: FormRules = {
  title: [{ required: true, message: '请输入任务标题', trigger: 'blur' }]
}

// 编辑任务对话框状态
const editDialogVisible = ref(false)
const editing = ref(false)
const editFormRef = ref<FormInstance>()
const editingTaskId = ref<number | null>(null)

const editForm = reactive({
  title: '',
  description: '',
  priority: 'medium' as TaskPriority,
  status: 'todo' as TaskStatus
})

const editRules: FormRules = {
  title: [{ required: true, message: '请输入任务标题', trigger: 'blur' }]
}

onMounted(async () => {
  try {
    await taskStore.fetchTasks()
  } catch (e) {
    // 后端未启动时使用模拟数据
    loadMockData()
  }
})

// 模拟数据（后端未连接时使用）
function loadMockData() {
  const mockTasks: Task[] = [
    { id: 1, title: '修复登录页 Token 过期', status: 'todo', priority: 'high' },
    { id: 2, title: '设计看板拖拽交互', status: 'todo', priority: 'medium' },
    { id: 3, title: '编写 Prisma 迁移文件', status: 'todo', priority: 'low' },
    { id: 4, title: '接入大模型 API 接口', status: 'doing', priority: 'high' },
    { id: 5, title: '封装 Axios 请求拦截', status: 'doing', priority: 'medium' },
    { id: 6, title: '配置 Nginx 反向代理', status: 'doing', priority: 'medium' },
    { id: 7, title: '初始化 Vite + Vue3 项目', status: 'done', priority: 'low' },
    { id: 8, title: '设计 MySQL 用户表', status: 'done', priority: 'low' },
    { id: 9, title: '完成 JWT 鉴权中间件', status: 'done', priority: 'low' }
  ]
  taskStore.tasks = mockTasks
}

// 打开编辑任务对话框
function openEditDialog(task: Task) {
  editingTaskId.value = task.id
  editForm.title = task.title
  editForm.description = task.description || ''
  editForm.priority = task.priority
  editForm.status = task.status
  editDialogVisible.value = true
}

// 保存编辑任务
async function handleEditTask() {
  if (!editFormRef.value) return
  await editFormRef.value.validate(async (valid) => {
    if (!valid) return
    if (editingTaskId.value === null) return
    editing.value = true
    const id = editingTaskId.value
    try {
      await taskStore.updateTask(id, {
        title: editForm.title,
        description: editForm.description,
        priority: editForm.priority,
        status: editForm.status
      })
      ElMessage.success('任务更新成功')
      editDialogVisible.value = false
    } catch (e) {
      // 后端未连接时本地更新
      const index = taskStore.tasks.findIndex(t => t.id === id)
      if (index !== -1) {
        taskStore.tasks[index] = {
          ...taskStore.tasks[index],
          title: editForm.title,
          description: editForm.description,
          priority: editForm.priority,
          status: editForm.status
        }
      }
      ElMessage.success('任务更新成功')
      editDialogVisible.value = false
    } finally {
      editing.value = false
    }
  })
}


// 打开新建任务对话框
function openCreateDialog() {
  createForm.title = ''
  createForm.description = ''
  createForm.priority = 'medium'
  createForm.status = 'todo'
  createDialogVisible.value = true
}

// 创建任务
async function handleCreateTask() {
  if (!createFormRef.value) return
  await createFormRef.value.validate(async (valid) => {
    if (!valid) return
    creating.value = true
    try {
      await taskStore.createTask({
        title: createForm.title,
        priority: createForm.priority,
        description:createForm.description
      })
      ElMessage.success('任务创建成功')
      createDialogVisible.value = false
    } catch (e) {
      // 后端未连接时本地添加
      taskStore.tasks.push({
        id: Date.now(),
        title: createForm.title,
        status: 'todo',
        priority: createForm.priority
      })
      ElMessage.success('任务创建成功')
      createDialogVisible.value = false
    } finally {
      creating.value = false
    }
  })
}

// 打开 AI 侧边栏
function openAiDrawer() {
  aiDrawerRef.value?.open()
}
</script>

<style scoped>
.dashboard-wrapper {
  min-height: 100%;
  background: var(--app-bg, #f5f6f8);
  position: relative;
  padding: 20px 24px;
}

/* 看板工具栏 */
.toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 16px;
}

.ai-btn {
  border-radius: 8px;
  font-weight: 500;
}

/* 统计卡片 */
.stats-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

.stat-card {
  background: var(--surface, #ffffff);
  padding: 16px 20px;
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  border: 1px solid var(--border, #e6e8eb);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.stat-info h4 {
  color: var(--text-secondary, #6b7684);
  font-size: 13px;
  font-weight: 500;
}

.stat-info h2 {
  color: var(--text-primary, #263238);
  font-size: 28px;
  font-weight: 700;
  margin-top: 4px;
}

.stat-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

/* 看板 */
.board {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 16px;
}

/* 新建任务悬浮按钮 */
.add-task-fab {
  position: fixed;
  right: 32px;
  bottom: 32px;
  z-index: 10;
}

.add-task-fab .el-button {
  width: 52px;
  height: 52px;
  box-shadow: 0 6px 18px rgba(59, 130, 246, 0.3);
}

/* 响应式 */
@media (max-width: 900px) {
  .stats-row {
    grid-template-columns: 1fr;
  }
  .board {
    grid-template-columns: 1fr;
  }
}
</style>
