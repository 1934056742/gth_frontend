<template>
  <div class="task-details" v-loading="loading">
    <!-- 顶部导航：返回任务列表 -->
    <div class="page-bar">
      <el-button link :icon="ArrowLeft" @click="goBack">返回任务列表</el-button>
      <el-button :icon="Refresh" :loading="loading" @click="loadAll">刷新</el-button>
    </div>

    <!-- 1. 任务基本信息 -->
    <el-card shadow="never" class="detail-card">
      <template #header>
        <div class="card-header">
          <span>任务基本信息</span>
        </div>
      </template>

      <el-empty v-if="!task && !loading" :description="loadError || '任务不存在或无权访问'" />

      <el-descriptions v-else-if="task" :column="2" border>
        <el-descriptions-item label="任务标题" :span="2">
          {{ task.title || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="statusType(task.status)">{{ statusLabel(task.status) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="优先级">
          <el-tag :type="priorityType(task.priority)">{{ priorityLabel(task.priority) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="执行人">
          {{ task.completedPerson || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="创建时间">
          {{ formatTime(task.createdAt) }}
        </el-descriptions-item>
        <el-descriptions-item label="任务描述" :span="2">
          <div class="desc-text">{{ task.description || '-' }}</div>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <!-- 2. 任务相关文件 -->
    <el-card shadow="never" class="detail-card">
      <template #header>
        <div class="card-header">
          <span>相关文件</span>
          <div class="card-actions">
            <el-tag type="info" effect="plain" size="small">共 {{ files.length }} 个</el-tag>
          </div>
        </div>
      </template>

      <!-- 上传区：管理员与普通成员一致，都可以在任务详情里直接上传（归属固定为当前任务） -->
      <div class="upload-panel">
        <div class="upload-panel__head">
          <span class="upload-panel__title">上传文件到本任务</span>
          <span class="upload-panel__hint">
            上传人：{{ uploaderName || '-' }}（自动按当前登录账号记录）
          </span>
        </div>
        <div class="upload-panel__row">
          <el-select
            v-model="categoryId"
            placeholder="请选择文件分类"
            style="width: 200px"
            :loading="loadingCategories"
            clearable
          >
            <el-option
              v-for="item in categories"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
          </el-select>
          <el-button type="primary" :icon="UploadFilled" :disabled="!canUpload" @click="triggerPick">
            选择文件
          </el-button>
          <el-button :disabled="!hasActive && !hasPaused && !hasDone" @click="handleClearFinished">
            清空已完成
          </el-button>
          <span v-if="!canUpload" class="upload-panel__tip">请先选择文件分类</span>
        </div>

        <!-- 隐藏的原生选择框：与文件上传页保持同一套分片上传引擎 -->
        <input
          ref="fileInputRef"
          type="file"
          multiple
          class="hidden-input"
          @change="restoringUid ? handleRestoreFile($event) : handleFileChange($event)"
        />

        <!-- 上传队列：只显示属于当前任务的上传卡片 -->
        <div v-if="visibleUploadTasks.length" class="upload-list">
          <div v-for="item in visibleUploadTasks" :key="item.uid" class="upload-item">
            <div class="upload-item__head">
              <span class="upload-item__name" :title="item.fileName">{{ item.fileName }}</span>
              <span class="upload-item__meta">
                {{ formatSize(item.fileSize) }}
                <template v-if="item.status === 'uploading'">
                  · {{ formatSpeed(item.speed) }} · {{ item.progress }}%
                </template>
              </span>
            </div>
            <el-progress
              :percentage="item.progress"
              :status="progressStatus(item.status)"
              :stroke-width="6"
            />
            <div class="upload-item__actions">
              <span class="upload-item__status">{{ uploadStatusText(item) }}</span>
              <el-button
                v-if="item.status === 'uploading'"
                size="small"
                link
                type="primary"
                @click="pauseTask(item.uid)"
              >
                暂停
              </el-button>
              <el-button
                v-else-if="item.status === 'paused'"
                size="small"
                link
                type="primary"
                @click="handleResume(item)"
              >
                继续
              </el-button>
              <el-button
                v-else-if="item.status === 'error'"
                size="small"
                link
                type="primary"
                @click="retryTask(item.uid)"
              >
                重试
              </el-button>
              <el-button size="small" link type="danger" @click="removeTask(item.uid)">
                移除
              </el-button>
            </div>
          </div>
        </div>
      </div>

      <el-table :data="files" v-loading="loadingFiles" empty-text="该任务下暂无文件">
        <el-table-column label="文件名" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="file-name">
              <el-icon class="file-icon"><Document /></el-icon>
              {{ row.fileName }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">{{ kindLabel(row.fileName) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ formatFileSize(row.fileSize) }}</template>
        </el-table-column>
        <el-table-column label="分类" width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.categoryName || '-' }}</template>
        </el-table-column>
        <el-table-column label="上传人" width="120" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag v-if="row.uploaderName" size="small" effect="plain" type="info">
              {{ row.uploaderName }}
            </el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="上传时间" width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              link
              type="primary"
              :disabled="!canPreviewFile(row.fileName)"
              :title="canPreviewFile(row.fileName) ? '在线查看' : '该类型暂不支持在线查看，请下载'"
              @click="openPreview(row)"
            >
              查看
            </el-button>
            <el-button
              size="small"
              link
              type="primary"
              :loading="downloadingId === row.id"
              @click="handleDownload(row)"
            >
              {{ downloadingId === row.id ? `下载中 ${downloadPercent}%` : '下载' }}
            </el-button>
            <!-- 删除：管理员可删除任意文件，成员只能删除自己上传的 -->
            <el-button
              size="small"
              link
              type="danger"
              :disabled="!canDeleteFile(row)"
              :title="canDeleteFile(row) ? '删除该文件' : '只能删除自己上传的文件'"
              @click="handleDeleteFile(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 说明：该列表展示本任务下所有人的上传记录，uploaderName 用于区分上传人 -->
      <div v-if="files.length" class="file-tip">
        列表中包含该任务下所有成员上传的文件，可通过「上传人」列区分来源；
        当前账号：{{ uploaderName || '-' }}。
      </div>
    </el-card>

    <!-- 在线查看弹窗 -->
    <FilePreviewDialog
      v-model:visible="previewVisible"
      :file="previewFile"
      @download="handleDownload"
    />
  </div>
</template>


<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, Document, Refresh, UploadFilled } from '@element-plus/icons-vue'
import type {
  FileCategory,
  Task,
  TaskPriority,
  TaskStatus,
  UploadFileItem,
  UploadStatus,
  UploadTask
} from '@/types'
import { getTasks } from '@/api/task'
import { deleteFile, downloadFile, getFiles } from '@/api/upload'
import { getCategoryOptions } from '@/api/category'
import { useUserStore } from '@/stores/user'
import {
  addFiles,
  clearFinished,
  formatSize,
  formatSpeed,
  pauseTask,
  removeTask,
  restoreTasks,
  resumeByFile,
  resumeTask,
  retryTask,
  setOwnership,
  tasks as uploadTasks
} from '@/utils/uploadManager'
import {
  canPreview as canPreviewFile,
  formatFileSize,
  getFileKindLabel
} from '@/utils/filePreview'
import FilePreviewDialog from '@/components/FilePreviewDialog.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

// 任务 id 来自路由 /task-details/:id
const taskId = computed(() => Number(route.params.id))

const task = ref<Task | null>(null)
const files = ref<UploadFileItem[]>([])
const loading = ref(false)
const loadingFiles = ref(false)
const loadError = ref('')

// 在线查看
const previewVisible = ref(false)
const previewFile = ref<UploadFileItem | null>(null)

// 下载进度（同一时间只允许一个下载任务，和文件上传页保持一致）
const downloadingId = ref(0)
const downloadPercent = ref(0)

/* ------------------------- 任务详情页上传文件 ------------------------- */
// 管理员与普通成员一致：都在任务详情页直接上传，归属固定为当前任务。
// 上传人就是当前登录账号，不允许手填（后端按 token 再确认一次）
const uploaderName = computed(() => userStore.user?.username || userStore.user?.account || '')

const categories = ref<FileCategory[]>([])
const loadingCategories = ref(false)
// 归属里的任务固定是当前详情页的任务，只需选分类
const categoryId = ref<number | undefined>()
const canUpload = computed(() => !!categoryId.value && Number.isInteger(taskId.value))

const fileInputRef = ref<HTMLInputElement>()
// 等待重新选择原文件的断点任务 uid（断点恢复时需要用户再选一次同一个文件）
const restoringUid = ref('')

/**
 * 本页可见的上传卡片。
 *
 * 上传队列是全局单例（与「文件上传」页共用同一份 tasks），好处是切页面不会中断上传；
 * 但详情页只关心「当前这个任务」的文件，所以这里按任务过滤，
 * 避免把在别的任务 / 别的分类下上传的卡片也显示到本任务里。
 *
 * 过滤依据：卡片归属里的 taskId（多任务上传时每张卡片只挂一个任务）。
 */
const visibleUploadTasks = computed(() =>
  uploadTasks.filter((item) =>
    (item.taskIds?.length ? item.taskIds : item.taskId ? [item.taskId] : []).includes(taskId.value)
  )
)

const hasActive = computed(() => visibleUploadTasks.value.some((item) => isUploading(item.status)))
const hasPaused = computed(() => visibleUploadTasks.value.some((item) => item.status === 'paused'))
const hasDone = computed(() => visibleUploadTasks.value.some((item) => item.status === 'done'))

// 切换分类后同步给上传引擎；任务固定取当前详情页的任务
watch(categoryId, (value) => {
  setOwnership(
    value && Number.isInteger(taskId.value)
      ? { categoryId: value, taskIds: [taskId.value], taskId: taskId.value }
      : null
  )
})

// 状态 / 优先级文案与颜色（与任务管理页保持一致）
interface TagConfig {
  label: string
  type: 'success' | 'warning' | 'info' | 'primary' | 'danger'
}
const statusMaps: Record<TaskStatus, TagConfig> = {
  todo: { label: '待办', type: 'info' },
  doing: { label: '进行中', type: 'warning' },
  done: { label: '已完成', type: 'success' }
}
const priorityMaps: Record<TaskPriority, TagConfig> = {
  high: { label: '高', type: 'danger' },
  medium: { label: '中', type: 'warning' },
  low: { label: '低', type: 'info' }
}
function statusLabel(status: TaskStatus) {
  return statusMaps[status]?.label || status
}
function statusType(status: TaskStatus) {
  return statusMaps[status]?.type || 'info'
}
function priorityLabel(priority: TaskPriority) {
  return priorityMaps[priority]?.label || priority
}
function priorityType(priority: TaskPriority) {
  return priorityMaps[priority]?.type || 'info'
}
function kindLabel(fileName: string) {
  return getFileKindLabel(fileName)
}

// 后端返回 ISO 字符串，直接展示对用户不友好
function formatTime(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

// 查询任务详情：后端没有单条任务接口，这里复用列表接口再按 id 找。
// 不传 page，后端返回数组（管理员拿到全部，成员只拿到自己的），
// 因此成员访问别人的任务会得到空结果，不会越权看到内容。
async function loadTask() {
  loading.value = true
  loadError.value = ''
  try {
    const res: any = await getTasks()
    const list: Task[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
    task.value = list.find((item) => Number(item.id) === taskId.value) || null
    if (!task.value) {
      loadError.value = '任务不存在。可能已被删除，或不属于当前账号。'
    }
  } catch (error: any) {
    // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
    task.value = null
    loadError.value = error?.message || '加载任务失败'
    if (!error?.response) ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

// 查询该任务下的文件：
// 后端在带 taskId 时会返回该任务下所有人上传的文件（管理员与成员共享同一份附件）。
// 只重试刷新列表，不打扰上传流程。
async function loadFiles(silent = false) {
  if (!Number.isInteger(taskId.value)) {
    files.value = []
    return
  }
  loadingFiles.value = true
  try {
    const res: any = await getFiles({ taskId: taskId.value })
    files.value = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  } catch (error: any) {
    files.value = []
    if (!silent && !error?.response) {
      ElMessage.error(error?.message || '加载文件列表失败')
    }
  } finally {
    loadingFiles.value = false
  }
}

// 本页上传队列里「已成功」的文件数量：变化说明有新文件落库，需要刷新列表
const doneCount = computed(() => uploadTasks.filter((item) => item.status === 'done').length)
watch(doneCount, (current, previous) => {
  if (current > previous) {
    ElMessage.success('文件上传完成')
    void loadFiles(true)
  }
})

// 分类下拉（来自「文件分类」维护页，详情页只能选不能改）
async function loadCategories() {
  loadingCategories.value = true
  try {
    const res: any = await getCategoryOptions()
    categories.value = (res?.data ?? res ?? []) as FileCategory[]
  } catch (error: any) {
    if (!error?.response) ElMessage.error(error?.message || '加载文件分类失败')
  } finally {
    loadingCategories.value = false
  }
}

function isUploading(status: UploadStatus) {
  return status === 'pending' || status === 'uploading' || status === 'hashing'
}

function progressStatus(status: UploadStatus) {
  if (status === 'done') return 'success'
  if (status === 'error') return 'exception'
  return undefined
}

function uploadStatusText(item: UploadTask) {
  if (item.status === 'done') return item.instant ? '秒传完成' : '已完成'
  if (item.status === 'error') return item.errorMsg || '上传失败'
  if (item.status === 'paused') return '已暂停'
  if (item.status === 'hashing') return '校验中…'
  if (item.status === 'pending') return '排队中'
  return '上传中'
}

// 触发隐藏的原生文件选择框
function triggerPick() {
  if (!canUpload.value) {
    ElMessage.warning('请先选择文件分类')
    return
  }
  fileInputRef.value?.click()
}

// 选择文件后交给上传引擎（与「文件上传」页共用同一套分片 / 秒传 / 断点续传逻辑）
function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const picked = Array.from(input.files || [])
  // 清空 value，保证连续选择同一个文件也能触发 change
  input.value = ''
  if (!picked.length) return

  if (!categoryId.value) {
    ElMessage.warning('请先选择文件分类')
    return
  }

  const added = addFiles(picked, undefined, {
    categoryId: categoryId.value,
    taskIds: [taskId.value],
    taskId: taskId.value
  })
  if (!added.length) {
    ElMessage.info('所选文件已在队列中')
    return
  }
  ElMessage.success(`已加入 ${added.length} 个文件，开始上传`)
}

// 暂停中的任务：普通断点直接继续；恢复出来的占位任务需要重新选原文件
function handleResume(item: UploadTask) {
  if (item.needsFile === true || item.file.size === 0) {
    restoringUid.value = item.uid
    fileInputRef.value?.click()
    return
  }
  resumeTask(item.uid)
}

// 断点恢复：用户重新选择文件后校验并继续
function handleRestoreFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !restoringUid.value) return
  const matched = resumeByFile(restoringUid.value, file)
  restoringUid.value = ''
  if (!matched) {
    ElMessage.error('文件与断点记录不一致（名称或大小不同），请选择原文件')
    return
  }
  ElMessage.success('已继续上传')
}

function handleClearFinished() {
  clearFinished()
  ElMessage.success('已清空已完成的上传任务')
}

async function loadAll() {
  await loadTask()
  // 任务不存在时不再去查文件，避免白跑一次请求
  if (task.value) {
    await loadFiles()
  } else {
    files.value = []
  }
}

// 上传区对管理员与成员一致：都要加载分类，并恢复本任务下未完成的上传
onMounted(async () => {
  await loadAll()
  await loadCategories()
  // 切换分类后把归属同步给引擎，保证刷新页面也能恢复断点
  if (categoryId.value && Number.isInteger(taskId.value)) {
    setOwnership({ categoryId: categoryId.value, taskIds: [taskId.value], taskId: taskId.value })
  }
  // 刷新页面后恢复本任务下未完成的上传（显示为已暂停，需重新选择原文件后继续）
  if (categoryId.value && Number.isInteger(taskId.value)) {
    restoreTasks({ categoryId: categoryId.value, taskIds: [taskId.value], taskId: taskId.value })
  }
})

function goBack() {
  router.push('/task-manage')
}

function openPreview(row: UploadFileItem) {
  previewFile.value = row
  previewVisible.value = true
}

async function handleDownload(row: UploadFileItem) {
  if (downloadingId.value) return
  downloadingId.value = row.id
  downloadPercent.value = 0
  try {
    await downloadFile(row.id, row.fileName, (percent) => {
      downloadPercent.value = Math.round(percent)
    })
    ElMessage.success('下载完成')
  } catch (error) {
    // 用户主动取消另存为（AbortError）不算失败
    if (error instanceof DOMException && error.name === 'AbortError') {
      ElMessage.info('已取消下载')
    } else {
      ElMessage.error(error instanceof Error ? error.message : '下载失败')
    }
  } finally {
    downloadingId.value = 0
    downloadPercent.value = 0
  }
}

/**
 * 是否允许删除该文件。
 * - 管理员：可以删除任务下的任意文件（后端已放开管理员删除权限）；
 * - 普通成员：只能删除自己上传的文件（后端对他人文件返回 404）。
 *
 * 上传人字段由后端从 ownerId 回查，理论上可能为空（用户已被删除的历史数据）。
 * 这种情况无法可靠判断归属，放行交给后端裁决，避免把「自己的文件」错误锁死。
 */
function canDeleteFile(row: UploadFileItem) {
  if (userStore.isAdmin) return true
  const current = uploaderName.value
  if (!current || !row.uploaderName) return true
  return row.uploaderName === current
}

async function handleDeleteFile(row: UploadFileItem) {
  if (!canDeleteFile(row)) {
    ElMessage.warning('只能删除自己上传的文件')
    return
  }
  try {
    await ElMessageBox.confirm(`确定要从本任务中删除文件「${row.fileName}」吗？`, '删除确认', {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  try {
    await deleteFile(row.id)
    ElMessage.success('删除成功')
    // 只刷新文件列表，不影响上传队列
    await loadFiles(true)
  } catch (error: any) {
    // 404（已被别人删除 / 无权删除）由拦截器统一提示，这里只兜底拦截器之外的异常
    if (!error?.response) {
      ElMessage.error(error?.message || '删除失败')
    }
  }
}
</script>

<style scoped>
.task-details {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 顶部：返回 / 刷新 */
.page-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.detail-card {
  border-radius: 12px;
  border: 1px solid var(--border, #e6e8eb);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 描述较长时保留换行 */
.desc-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.7;
  color: #37474f;
}

.file-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.file-icon {
  color: #3b82f6;
}

.file-tip {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.6;
  color: #90a4ae;
}

/* ------------------------- 相关文件：任务详情上传区（管理员 / 成员一致） ------------------------- */
.upload-panel {
  margin-bottom: 16px;
  padding: 14px 16px;
  border: 1px dashed #cdd7e2;
  border-radius: 10px;
  background: #fafcff;
}

.upload-panel__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px 12px;
  margin-bottom: 12px;
}

.upload-panel__title {
  font-size: 14px;
  font-weight: 600;
  color: #37474f;
}

.upload-panel__hint {
  font-size: 12px;
  color: #90a4ae;
}

/* 下拉 + 按钮同一行；窄屏自动换行，避免按钮被挤出容器 */
.upload-panel__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.upload-panel__row .el-button + .el-button {
  margin-left: 0;
}

.upload-panel__tip {
  font-size: 12px;
  color: #e6a23c;
}

/* 原生文件选择框只做触发，不参与布局 */
.hidden-input {
  display: none;
}

/* 上传队列 */
.upload-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}

.upload-item {
  padding: 10px 12px;
  border: 1px solid #e6e8eb;
  border-radius: 8px;
  background: #fff;
}

.upload-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

/* 长文件名省略，避免把右侧大小信息挤走 */
.upload-item__name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #37474f;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.upload-item__meta {
  flex: none;
  font-size: 12px;
  color: #90a4ae;
}

.upload-item__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

/* 操作按钮保持原尺寸，不被状态文案挤压 */
.upload-item__actions .el-button {
  flex: none;
}

.upload-item__actions .el-button + .el-button {
  margin-left: 0;
}

/* 状态文案靠左，操作按钮靠右 */
.upload-item__status {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #78909c;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 表格与卡片内边距贴合，避免左右留白不一致 */
:deep(.el-card__body) {
  padding: 16px;
}

:deep(.el-table) {
  font-size: 13px;
}

:deep(.el-descriptions__label) {
  width: 110px;
  color: #546e7a;
  background: #f5f8fc;
}
</style>
