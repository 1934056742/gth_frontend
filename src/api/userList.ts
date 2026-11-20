import request from './request'
import type { UserData, CreateUserParams, CreateUserResult, UpdateUserParams,SearchParams,NewPassword} from '@/types'

// 获取所有用户
export function getUser(data:SearchParams) {
  return request.get<UserData[]>('/userList',{params:data})
}

// 创建用户（成功后返回系统生成的初始密码 password 字段）
export function createUser(data: CreateUserParams) {
  return request.post<CreateUserResult>('/addUser', data)
}

// 修改用户
export function editUser(data: UpdateUserParams) {
  return request.put<UserData>('/updateUser', data)
}

// 删除用户
export function deleteUser(id:number) {
  return request.delete(`/deleteUser/${id}`)
}
//重置密码
export function resetPassword(id:number): Promise<NewPassword>{
  return request.put(`/resetPassword/${id}`)
}

