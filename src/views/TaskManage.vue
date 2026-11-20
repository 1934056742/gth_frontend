<template>
  <div class="task-manage">
    <el-card shadow="never">
      <template #header>
        <div class="task-header">
          <span>任务管理</span>
          <div class="task-header-right">
            <!-- 管理员可新建任务（普通成员只读） -->
            <el-button v-if="isAdmin" type="primary" @click="openDialog('add')">
              <el-icon><CirclePlus /></el-icon>
              <span>新建任务</span>
            </el-button>
            <el-button @click="getTasksData">
              <el-icon><Refresh /></el-icon>
              <span>刷新</span>
            </el-button>
          </div>
        </div>
      </template>

      <el-table :data="tableData" v-loading="loading" width="100%">
          <el-table-column v-for="item in filedArr" :prop="item.name" :label="item.cName" :key="item.name" :width="item.width">
              <template #default="{ row, column }">
                <el-tag v-if="column.property=='status'" :type="getStatusType(row.status)">{{ getStatusLabel(row.status) }}</el-tag>
                <el-tag v-else-if="column.property=='priority'" :type="getPriorityType(row.priority)">{{ getPriorityLabel(row.priority) }}</el-tag>
                <span v-else>{{row[column.property] || '-'}}</span>
              </template>
          </el-table-column>
          <!-- 执行人：仅 admin 可见，取后端 completedPerson 字段（分配任务时写入） -->
          <el-table-column v-if="isAdmin" prop="completedPerson" label="执行人" width="120px">
            <template #default="{ row }">
              <span>{{ row.completedPerson || '-' }}</span>
            </template>
          </el-table-column>
          <!-- 操作列：admin 显示修改 / 分配 / 删除；所有角色只要任务「进行中」都可点「完成」 -->
          <el-table-column label="操作" width="300px" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="goDetail(row)">详情</el-button>
              <template v-if="isAdmin">
                <el-button link type="primary" @click="openDialog('edit', row)">修改</el-button>
                <el-button link type="primary" :disabled="row.status === 'done'" @click="openAssignDialog(row)">
                  分配
                </el-button>
                <el-button link type="danger" @click="deleteTaskItem(row)">删除</el-button>
              </template>
              <el-button
                v-if="row.status === 'doing'"
                link
                type="success"
                @click="completeTask(row)"
              >
                完成
              </el-button>
              <span v-if="!isAdmin && row.status !== 'doing'" class="task-no-action">-</span>
            </template>
          </el-table-column>
      </el-table>

      <div v-if="tableData.length === 0 && !loading" class="task-empty">暂无任务</div>

      <!-- 分页：数据量少于一页时自动隐藏（hide-on-single-page） -->
      <div v-if="total > 0" class="task-pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          background
          hide-on-single-page
          @current-change="getTasksData"
          @size-change="handleSizeChange"
        />
      </div>
    </el-card>

    <!-- 新建 / 修改任务弹窗 -->
    <TaskEditDialog ref="TaskEditRef" @refresh="getTasksData" />
    <!-- 分配任务弹窗（仅管理员） -->
    <AssignTaskDialog ref="AssignTaskRef" @success="getTasksData" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus'
import { CirclePlus, Refresh } from '@element-plus/icons-vue'
import {getTaskPage as getTaskPageApi, deleteTask as deleteTaskApi, updateTask as updateTaskApi} from '@/api/task'
import { useUserStore } from '@/stores/user'
import TaskEditDialog from '@/components/TaskEditDialog.vue'
import AssignTaskDialog from '@/components/AssignTaskDialog.vue'
const tableData = ref<Task[]>([]);
//引入你定义好的类型
import type {TaskStatus,Task,TaskPriority} from '@/types'
import { useRouter } from 'vue-router'
const router = useRouter()

// ---------- 分页状态 ----------
// 任务量会越来越多，表格改成后端分页：只取当前页，total 由后端返回
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)
const loading = ref(false)

// 当前登录人角色：只有 admin 才显示新建 / 修改 / 分配 / 删除入口
// 角色来自登录接口返回的 user.role，由 userStore 持久化在 localStorage
const userStore = useUserStore()
const isAdmin = computed(() => userStore.isAdmin)

const TaskEditRef = ref<InstanceType<typeof TaskEditDialog>>()
const AssignTaskRef = ref<InstanceType<typeof AssignTaskDialog>>()

//定义状态对应的文本和Element plus标签颜色类型
interface statusConfig{
  label:string,
  type:'success'|'warning'|'info'|'primary'|'danger'

}
const statusMaps:Record<TaskStatus,statusConfig>={
  'todo':{label:'待办',type:'info'},
  'doing':{label:'进行中',type:'warning'},
  'done':{label:'已完成',type:'success'}
}
const priorityMaps:Record<TaskPriority,statusConfig>={
  'high':{label:'高',type:'primary'},
  'medium':{label:'中',type:'warning'},
  'low':{label:'低',type:'info'}

}
function getStatusType(status:TaskStatus){
  return statusMaps[status].type
}
function getStatusLabel(status:TaskStatus){
  return statusMaps[status].label
}

function getPriorityType(priority:TaskPriority){
   return priorityMaps[priority].type
}
function getPriorityLabel(priority:TaskPriority){
   return priorityMaps[priority].label
}
const filedArr=[
  {name:'title',cName:'标题',width:'100px'},
  {name:'status',cName:'状态',width:'180px'},
  {name:'priority',cName:'优先级',width:'100px'},  
  {name:'description',cName:'描述'},
]
onMounted(()=>{
  getTasksData()
})
//获取任务列表（后端分页：当前页数据 + 总数）
async function getTasksData(){
  loading.value = true
  try{
    const res:any = await getTaskPageApi({ page: page.value, pageSize: pageSize.value })
    // 统一兼容 res 直接是分页对象、或者被包了一层（{ code, data }）
    const data = res?.data || res || {}
    const list: Task[] = Array.isArray(data.list) ? data.list : []
    total.value = Number(data.total) || 0
    tableData.value = list

    // 删掉当前页最后一条后，页码会超出总页数，这时自动回到最后一页重新拉数据
    const maxPage = Math.max(1, Math.ceil(total.value / pageSize.value))
    if (page.value > maxPage) {
      page.value = maxPage
      await getTasksData()
    }
  }catch(error:any){
    // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
    if(!error?.response){
      ElMessage.error(error?.message || '加载任务列表失败')
    }
  }finally{
    loading.value = false
  }
}

// 切换每页条数：重置回第一页，否则页码可能超出新的总页数
function handleSizeChange(){
  page.value = 1
  getTasksData()
}

// 打开新建 / 修改弹窗（双重保险：模板已隐藏入口，这里再拦一次）
function openDialog(type:string, row?:Task){
  if(!isAdmin.value){
    ElMessage.warning('仅管理员可以维护任务')
    return
  }
  TaskEditRef.value?.openDialog(type, row)
}

// 打开分配弹窗（仅管理员可用）
function openAssignDialog(row:Task){
  if(!isAdmin.value){
    ElMessage.warning('仅管理员可以分配任务')
    return
  }
  AssignTaskRef.value?.open(row)
}

// 完成任务：任何角色只要任务处于「进行中」都可标记完成，确认后状态改为已完成
async function completeTask(row:Task){
  if(row.status !== 'doing'){
    ElMessage.warning('只有进行中的任务才能标记完成')
    return
  }
  try{
    await ElMessageBox.confirm(
      `确认任务「${row.title}」已完成吗？`,
      '完成确认',
      {
        confirmButtonText: '确认完成',
        cancelButtonText: '取消',
        type: 'warning',
      }
    )
  }catch{
    // 用户点击取消 / 关闭弹窗
    return
  }
  try{
    await updateTaskApi(Number(row.id), { status: 'done' })
    ElMessage.success('任务已完成')
    getTasksData()
  }catch(error:any){
    // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
    if(!error?.response){
      ElMessage.error(error?.message || '操作失败')
    }
  }
}

// 删除任务（仅管理员可用）
async function deleteTaskItem(row:Task){
  if(!isAdmin.value){
    ElMessage.warning('仅管理员可以维护任务')
    return
  }
  try{
    await ElMessageBox.confirm(
      `确定要删除任务「${row.title}」吗？此操作不可恢复！`,
      '删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning',
      }
    )
  }catch{
    // 用户点击取消 / 关闭弹窗
    return
  }
  try{
    await deleteTaskApi(Number(row.id))
    ElMessage.success('删除成功')
    getTasksData()
  }catch(error:any){
    // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
    if(!error?.response){
      ElMessage.error(error?.message || '删除失败')
    }
  }
}

function goDetail(row:Task){
    router.push({name:'TaskDetails',params:{id:row.id}})
}
</script>

<style scoped>
.task-manage {
  padding: 24px;
}
.task-manage :deep(.el-card) {
  border-radius: 12px;
  border: 1px solid var(--border, #e6e8eb);
}

/* 头部：标题左、操作按钮右 */
.task-header{
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.task-header-right{
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-header-right :deep(.el-button){
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 分页栏：靠右，与卡片内边距对齐 */
.task-pager{
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* 无数据提示 */
.task-empty{
  padding: 24px 0;
  text-align: center;
  color: #90a4ae;
  font-size: 13px;
}

/* 成员无操作权限时的占位 */
.task-no-action{
  color: #c0c4cc;
}
</style>
