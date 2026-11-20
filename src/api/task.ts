import request from './request'
import type { Task, CreateTaskParams, UpdateTaskParams, TaskQueryParams, TaskPageResult } from '@/types'

// 获取任务列表
// 不传 page：后端返回 Task[]（看板、上传页下拉用，需要全量）
// 传了 page：后端返回 TaskPageResult（任务管理页表格分页用）
export function getTasks(params?: TaskQueryParams) {
  return request.get<Task[] | TaskPageResult>('/tasks', { params })
}

// 获取任务分页数据（强制分页，返回值一定带 total，页面用它算总页数）
export function getTaskPage(params: TaskQueryParams) {
  return request.get<TaskPageResult>('/tasks', { params: { page: 1, pageSize: 10, ...params } })
}

// 创建任务
export function createTask(data: CreateTaskParams) {
  return request.post<Task>('/tasks', data)
}

// 更新任务
export function updateTask(id: number, data: UpdateTaskParams) {
  return request.put<Task>(`/tasks/${id}`, data)
}

// 删除任务
export function deleteTask(id: number) {
  return request.delete(`/tasks/${id}`)
}
