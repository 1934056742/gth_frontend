<template>
      <!-- 新建成员框 -->
    <el-dialog
      v-model="createDialogVisible"
      :title="dialogType==='add'?'新建成员':'修改用户'"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-position="top">
        <el-form-item label="账号" prop="account">
          <el-input
            v-model="createForm.account"
            placeholder="请输入登录账号"
            size="large"
          />
        </el-form-item>

        <el-form-item label="姓名" prop="userName">
          <el-input
            v-model="createForm.userName"
            placeholder="请输入姓名"
            size="large"
          />
        </el-form-item>
        <el-form-item label="年龄" prop="age">
          <el-input
            v-model="createForm.age"
            placeholder="请输入年龄"
            size="large"
          />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input
            v-model="createForm.email"
            placeholder="请输入邮箱"
            size="large"
          />
        </el-form-item>
        <!-- <el-form-item label="密码" prop="password">
          <el-input
            v-model="createForm.password"
            type="password"
            show-password
            :placeholder="dialogType==='add' ? '请输入登录密码' : '留空表示不修改密码'"
            size="large"
          />
        </el-form-item> -->

      
     
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="handleCreateUser">
          {{dialogType==='add'?'创建':'修改'}}
        </el-button>
      </template>
    </el-dialog>

  <!-- 创建成功：展示系统生成的初始账号密码 -->
  <CreateSuccessDialog ref="CreateSuccessRef" />

</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick } from 'vue'
import { ElMessage, type FormInstance } from 'element-plus'
import type {UserData, CreateUserResult } from '@/types'
import {createUser as createUserApi,editUser as updateUserApi} from '@/api/userList'
import CreateSuccessDialog from '@/components/CreateSuccessDialog.vue'

const createDialogVisible = ref(false)
const creating = ref(false)
const editId = ref()
const createFormRef = ref<FormInstance>()
// 创建成功弹窗：展示后端返回的初始密码，并提供复制按钮
const CreateSuccessRef = ref<InstanceType<typeof CreateSuccessDialog>>()
const createForm = reactive<UserData>({
  account:'',
  userName:'',
  age:'',
  email:'',
})
// 校验规则：账号与密码新建时必填，修改时密码可留空（表示不改）
// 注意 rules 用 computed，否则 dialogType 变化后 required 不会重新计算
const createRules = computed(() => ({
  account: [{ required: true, message: '请输入登录账号', trigger: 'blur' }],
  userName: [{ required: true, message: '请输入用户姓名', trigger: 'blur' }],
  password: dialogType.value === 'add'
    ? [{ required: true, message: '请输入登录密码', trigger: 'blur' }]
    : []
}))
const dialogType = ref('add');
const emit = defineEmits(['getUserList'])

function openDialog(type:string,data?:UserData){
  dialogType.value = type;
  if(type ==='add'){
    createForm.account = '';
    createForm.userName = '';
    createForm.age ='';
    createForm.email = '';
    editId.value = undefined;
  }else if(type ==='edit'&& !!data){
    const {account,userName,age,email,id} = data;
    createForm.account = account || '';
    createForm.userName = userName || '';
    createForm.age = Number(age)>0?String(age):'';
    createForm.email = email || '';
    editId.value = id;
  }
  createDialogVisible.value = true;
  // 打开弹窗时清除上一次的校验提示
  nextTick(() => createFormRef.value?.clearValidate());

}

async function handleCreateUser(){
  if(!createFormRef.value) return
  createFormRef.value.validate(async (valid)=>{
    if(valid){
      const {email,userName,age,account}= createForm;
      const addParams ={
        account: account.trim(),
        userName: userName.trim(),
        email,
        age:age?Number(age):0,
      
      }
      try{
        if(dialogType.value=='add'){
          // 后端创建成功会返回系统生成的初始密码（password 字段），需要展示给用户
          const res = await createUserApi(addParams) as unknown as CreateUserResult
          createDialogVisible.value = false;
          emit('getUserList')
          CreateSuccessRef.value?.open(res?.account || addParams.account, res?.password || '')
          return
        }else{
          const editParams={id:editId.value,...addParams}
          await updateUserApi( editParams)
        }
        ElMessage.success('修改用户成功')
        emit('getUserList')
        createDialogVisible.value = false;
      }catch(error:any){
        // 错误提示已经由 request.ts 的响应拦截器统一弹出（会优先展示后端返回的 { error: '账号已存在' }），
        // 这里不能再弹一次，否则同一个错误会连续出现两条提示。
        // 只有网络异常等拿不到后端文案、且拦截器无法覆盖的极端情况才兜底提示。
        if(!error?.response){
          ElMessage.error(error?.message || '操作失败，请稍后重试')
        }
      }finally{
        creating.value=false
      }
    }else{
      creating.value=false
    }

  })
  

}
defineExpose({
  openDialog
})

</script>

<style scoped>

</style>
