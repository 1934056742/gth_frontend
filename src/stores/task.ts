import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Task, TaskStatus, CreateTaskParams, UpdateTaskParams } from '@/types'
import { getTasks, createTask as createTaskApi, updateTask as updateTaskApi, deleteTask as deleteTaskApi } from '@/api/task'

export const useTaskStore = defineStore('task', () => {
  const tasks = ref<Task[]>([])

  // 按状态分组
  const todoTasks = computed(() => tasks.value.filter(t => t.status === 'todo'))
  const doingTasks = computed(() => tasks.value.filter(t => t.status === 'doing'))
  const doneTasks = computed(() => tasks.value.filter(t => t.status === 'done'))

  // 统计
  const totalCount = computed(() => tasks.value.length)
  const doingCount = computed(() => doingTasks.value.length)
  const doneCount = computed(() => doneTasks.value.length)

  // 获取所有任务（不传 page，后端返回全量数组，看板按状态分组要用完整数据）
  async function fetchTasks() {
    const res: any = await getTasks()
    tasks.value = res.data || res
    return tasks.value
  }

  // 创建任务
  async function createTask(params: CreateTaskParams) {
    const res: any = await createTaskApi(params)
    const task = res.data || res
    tasks.value.push(task)
    return task
  }

  // 更新任务
  async function updateTask(id: number, params: UpdateTaskParams) {
    const res: any = await updateTaskApi(id, params)
    const updated = res.data || res
    const index = tasks.value.findIndex(t => t.id === id)
    if (index !== -1) {
      tasks.value[index] = { ...tasks.value[index], ...updated }
    }
    return updated
  }

  // 删除任务
  async function deleteTask(id: number) {
    await deleteTaskApi(id)
    tasks.value = tasks.value.filter(t => t.id !== id)
  }

  // 移动任务状态（拖拽）
  async function moveTask(id: number, status: TaskStatus) {
    return updateTask(id, { status })
  }

  return {
    tasks,
    todoTasks,
    doingTasks,
    doneTasks,
    totalCount,
    doingCount,
    doneCount,
    fetchTasks,
    createTask,
    updateTask,
    deleteTask,
    moveTask
  }
})
