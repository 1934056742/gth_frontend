import request from './request'
import type { FileCategory, CreateCategoryParams, UpdateCategoryParams } from '@/types'

// 获取分类列表（仅管理员，用于分类维护页）
export function getCategories() {
  return request.get<FileCategory[]>('/categories')
}

// 获取分类选项（所有登录用户可读，用于上传时选择文件分类）
export function getCategoryOptions() {
  return request.get<FileCategory[]>('/categoryOptions')
}

// 新建分类（名称重复时后端返回 400「分类名称已存在」）
export function createCategory(data: CreateCategoryParams) {
  return request.post<FileCategory>('/categories', data)
}

// 修改分类
export function updateCategory(id: number, data: UpdateCategoryParams) {
  return request.put<FileCategory>(`/categories/${id}`, data)
}

// 删除分类
export function deleteCategory(id: number) {
  return request.delete(`/categories/${id}`)
}
