<template>
   <el-container id="userList">
    <div class="user-list-header">
      <el-input class="search-input" v-model="keyWords" placeholder="请输入用户名称" @change="getUser"></el-input>
      <!-- 新建成员：图标 + 文字，与任务管理 / 文件分类页的新建按钮保持一致 -->
      <el-button type="primary" @click="openDialog('add')">
        <el-icon><CirclePlus /></el-icon>
        <span>新建成员</span>
      </el-button>
    </div>
    <el-main class="user-list-main" style="overflow:hidden; width:100%">
          <el-table :data="tableData" style="width: 100%">
            <el-table-column prop="account" label="账号" min-width="140">
              <template #default="scope">
                {{ scope.row.account || '-' }}
              </template>
            </el-table-column>
            <el-table-column prop="userName" label="姓名"> </el-table-column>
            <el-table-column prop="age" label="年龄"> 
              <template #default="scope">
                {{ scope.row.age>0?scope.row.age:'-' }}
              </template>
            </el-table-column>
            <el-table-column prop="email" label="邮箱"> </el-table-column>
            <el-table-column prop="id" label="操作" width="280px"> 
                <template #default="scope">
                  <el-button v-if="scope.row.role=='member'" @click="resetPassWord(scope.row)">重置密码</el-button>
                   <el-button @click="openDialog('edit',scope.row)">修改</el-button>
                   <el-button @click="deleteUser(scope.row)">删除</el-button>
                </template>
            </el-table-column>
          </el-table>
    </el-main>
  </el-container>
  <AddUser ref="AddUserRef" @get-user-list="getUser"></AddUser> 
  <!-- 创建成功：展示系统生成的初始账号密码 -->
  <CreateSuccessDialog ref="CreateSuccessRef" />

</template>


<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import {type UserData} from '@/types'
import { CirclePlus } from '@element-plus/icons-vue';
import { ElMessageBox ,ElMessage} from 'element-plus'
import AddUser from '@/components/AddUser.vue'
import {getUser as getUserApi,deleteUser as deleteUserApi,resetPassword as resetPasswordApi} from '@/api/userList'
import CreateSuccessDialog from '@/components/CreateSuccessDialog.vue'
var tableData = reactive<UserData[]>([])
const keyWords = ref('')
const dialogType = ref('')
const AddUserRef = ref<InstanceType<typeof AddUser>>()
  // 创建成功弹窗：展示后端返回的初始密码，并提供复制按钮
const CreateSuccessRef = ref<InstanceType<typeof CreateSuccessDialog>>()

onMounted(()=>{
  getUser()
})


function openDialog(type:string,data?:UserData){
 
  dialogType.value = type;
  if(type==='add'){
    AddUserRef.value?.openDialog(type);
  }else{
    AddUserRef.value?.openDialog(type,data);
  }  
  

}
async function getUser(){
   const searchParams = {userName:keyWords.value}
   const res: any = await getUserApi(searchParams)
   tableData.length = 0;
   tableData.push(...(res||[]))

}

async function deleteUser(data:UserData){  
  const deleteId = Number(data.id);
  ElMessageBox.confirm(
    '确定要删除该用户吗？此操作不可恢复！',
    '删除确认',
    {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning',
    }
  )
    .then(async () => {
      // 用户点击了“确定删除”
      try {
        await deleteUserApi(deleteId)
        ElMessage.success('删除成功')
        // 刷新列表
        getUser()
      } catch (error: any) {
        // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
        if (!error?.response) {
          ElMessage.error(error?.message || '删除失败')
        }
      }
    })
    .catch(() => {
      // 用户点击了“取消”或关闭了弹窗
      ElMessage.info('已取消删除')
    })

    
  
}

async function resetPassWord(data:UserData){
  const id = Number(data.id);
  ElMessageBox.confirm(
    '确定要重置该成员的密码吗？重置后会生成一个新的初始密码，对方下次登录时会被提示修改密码。',
    '重置确认',
    {
      confirmButtonText: '确定重置',
      cancelButtonText: '取消',
      type: 'warning',
    }
  )
    .then(async () => {
      // 用户点击了“确定删除”
      try {
        const newData = await resetPasswordApi(id)
        // 刷新列表
        getUser()
        CreateSuccessRef.value?.open(newData?.account, newData?.password || '');
     
      } catch (error: any) {
        // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
        if (!error?.response) {
          ElMessage.error(error?.message || '重置失败')
        }
      }
    })
    .catch(() => {
      // 用户点击了“取消”或关闭了弹窗
      ElMessage.info('已取消重置')
    })

    

}


</script>

<style scoped>
#userList{
  background: var(--surface, #ffffff);
  min-height: 100%;
  width: 100%;
  padding: 0 0 24px;
  border-radius: 12px;
  border: 1px solid var(--border, #e6e8eb);
  display: flex;
  flex-direction: column;
}

/* 搜索 + 新增：靠右排列，顶部间距 10px */
.user-list-header{
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 10px 20px 0;
  margin-bottom: 16px;
}

.search-input{
  width: 240px;
}

/* 表格区域：左右间距 20px，占满内容区 */
.user-list-main{
  flex: 1;
  padding: 0 20px;
}

:deep(.el-table){
  border-radius: 8px;
  border: 1px solid #d3dce8;
}

/* 表头：天蓝色背景 */
:deep(.el-table th.el-table__cell){
  background: #dbeafb;
  color: #263238;
  font-weight: 600;
}

/* 表格线明显一点 */
:deep(.el-table td.el-table__cell),
:deep(.el-table th.el-table__cell){
  border-bottom: 1px solid #d3dce8;
}

:deep(.el-table .el-table__cell){
  border-right: 1px solid #e4eaf1;
}
</style>
