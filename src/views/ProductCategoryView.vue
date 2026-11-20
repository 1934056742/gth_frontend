<template>
  <div class="product-category">
    <el-card shadow="never">
      <template #header>
        <div class="category-header">
          <span>文件分类</span>
          <div class="category-header-right">
            <!-- 仅管理员可新建（路由 meta.role = 'admin'，这里再做一次兜底判断） -->
            <el-button v-if="isAdmin" type="primary" @click="openDialog('add')">
              <el-icon><CirclePlus /></el-icon>
              <span>新建分类</span>
            </el-button>
            <el-button @click="getCategoriesData">
              <el-icon><Refresh /></el-icon>
              <span>刷新</span>
            </el-button>
          </div>
        </div>
      </template>

      <!-- 列表只有两列：名称 / 操作 -->
      <el-table :data="tableData" v-loading="loading" width="100%">
        <el-table-column prop="name" label="名称" min-width="200">
          <template #default="{ row }">
            <span>{{ row.name || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160px">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDialog('edit', row)">修改</el-button>
            <el-button link type="danger" @click="deleteCategoryItem(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建 / 修改弹窗：两者只差一个名称输入框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogType === 'add' ? '新建分类' : '修改分类'"
      width="420px"
      @closed="resetForm"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px" @submit.prevent>
        <el-form-item label="名称" prop="name">
          <el-input
            v-model="form.name"
            placeholder="请输入分类名称"
            maxlength="50"
            show-word-limit
            clearable
            @keyup.enter="handleSubmit"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">
          {{ dialogType === 'add' ? '创建' : '保存' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件分类页面
 *
 * 权限：路由 meta.role = 'admin'，仅管理员可见（菜单与页面访问都由路由 meta 控制）
 * 功能：列表（名称 / 操作）+ 顶部新建 + 修改 / 删除
 * 名称唯一：前端先做一次重名校验（体验好、少一次请求），
 *          后端接口层再查重并返回 400「分类名称已存在」作为最终保证。
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { CirclePlus, Refresh } from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'
import { ROLE_ADMIN } from '@/utils/permission'
import type { FileCategory } from '@/types'
import {
  getCategories as getCategoriesApi,
  createCategory as createCategoryApi,
  updateCategory as updateCategoryApi,
  deleteCategory as deleteCategoryApi
} from '@/api/category'

const userStore = useUserStore()
// 当前角色（与其它页面保持一致：取登录时缓存的 role）
const isAdmin = computed(() => userStore.user?.role === ROLE_ADMIN)

const tableData = reactive<FileCategory[]>([])
const loading = ref(false)
const submitting = ref(false)

const dialogVisible = ref(false)
const dialogType = ref<'add' | 'edit'>('add')
const editId = ref<number>()
const formRef = ref<FormInstance>()

const form = reactive({ name: '' })

/**
 * 校验规则：名称必填 + 不能与已有分类重名
 * 注意点：
 *   1. 用 computed，这样 tableData 变化后校验能拿到最新列表；
 *   2. 修改时排除自己（editId），否则"原名保存"会被判成重复。
 */
const rules = computed<FormRules>(() => ({
  name: [
    { required: true, message: '请输入分类名称', trigger: 'blur' },
    {
      validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
        const name = String(value || '').trim()
        if (!name) {
          // 空值交给上面的 required 规则提示，避免出现两条提示
          callback()
          return
        }
        const duplicated = tableData.some(
          (item) => Number(item.id) !== editId.value && String(item.name).trim() === name
        )
        if (duplicated) {
          callback(new Error('分类名称已存在'))
          return
        }
        callback()
      },
      trigger: 'blur'
    }
  ]
}))

onMounted(() => {
  getCategoriesData()
})

// 拉取分类列表
async function getCategoriesData() {
  loading.value = true
  try {
    const res: any = await getCategoriesApi()
    tableData.length = 0
    tableData.push(...(res || []))
  } catch (error: any) {
    // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
    if (!error?.response) {
      ElMessage.error(error?.message || '加载分类列表失败')
    }
  } finally {
    loading.value = false
  }
}

// 打开新建 / 修改弹窗
function openDialog(type: 'add' | 'edit', row?: FileCategory) {
  if (!isAdmin.value) {
    ElMessage.warning('仅管理员可以维护文件分类')
    return
  }
  dialogType.value = type
  if (type === 'edit' && row) {
    editId.value = Number(row.id)
    form.name = row.name || ''
  } else {
    editId.value = undefined
    form.name = ''
  }
  dialogVisible.value = true
  // 打开弹窗时清掉上一次的校验提示
  formRef.value?.clearValidate()
}

// 弹窗关闭后重置表单，避免下次打开还残留上次的内容
function resetForm() {
  form.name = ''
  editId.value = undefined
  formRef.value?.clearValidate()
}

// 提交（新建 / 修改共用）
async function handleSubmit() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  const name = form.name.trim()
  submitting.value = true
  try {
    if (dialogType.value === 'add') {
      await createCategoryApi({ name })
      ElMessage.success('新建分类成功')
    } else {
      await updateCategoryApi(Number(editId.value), { name })
      ElMessage.success('修改分类成功')
    }
    dialogVisible.value = false
    getCategoriesData()
  } catch (error: any) {
    // 错误提示由 request.ts 拦截器统一弹出（含后端返回的「分类名称已存在」），
    // 这里只兜底拦截器之外抛出的异常，避免同一个错误弹两次
    if (!error?.response) {
      ElMessage.error(error?.message || '操作失败，请稍后重试')
    }
  } finally {
    submitting.value = false
  }
}

// 删除分类
async function deleteCategoryItem(row: FileCategory) {
  if (!isAdmin.value) {
    ElMessage.warning('仅管理员可以维护文件分类')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定要删除分类「${row.name}」吗？此操作不可恢复！`,
      '删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    // 用户点击取消 / 关闭弹窗
    return
  }
  try {
    await deleteCategoryApi(Number(row.id))
    ElMessage.success('删除成功')
    getCategoriesData()
  } catch (error: any) {
    // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
    if (!error?.response) {
      ElMessage.error(error?.message || '删除失败')
    }
  }
}
</script>

<style scoped>
.product-category {
  padding: 24px;
}
.product-category :deep(.el-card) {
  border-radius: 12px;
  border: 1px solid var(--border, #e6e8eb);
}

/* 卡片头部：左标题 / 右操作按钮 */
.category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.category-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

:deep(.el-table) {
  border-radius: 8px;
  border: 1px solid #d3dce8;
}

/* 表头：与成员管理页保持一致的浅蓝底 */
:deep(.el-table th.el-table__cell) {
  background: #dbeafb;
  color: #263238;
  font-weight: 600;
}

:deep(.el-table td.el-table__cell),
:deep(.el-table th.el-table__cell) {
  border-bottom: 1px solid #d3dce8;
}

:deep(.el-table .el-table__cell) {
  border-right: 1px solid #e4eaf1;
}
</style>
