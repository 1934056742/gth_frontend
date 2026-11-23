<template>
  <div class="file-upload">
    <!-- 1. 拖拽上传区 -->
    <el-card shadow="never" class="upload-card">
      <template #header>
        <div class="card-header">
          <span>文件上传</span>
          <el-tag type="info" effect="plain">
            分片 {{ formatSize(chunkSize) }} · 并发 {{ concurrency }} · 支持秒传与断点续传
          </el-tag>
        </div>
      </template>

      <el-upload
        ref="uploadRef"
        drag
        multiple
        :auto-upload="false"
        :show-file-list="false"
        :disabled="!canUpload"
        :on-change="handleFileChange"
        class="drop-area"
      >
        <el-icon class="upload-icon"><UploadFilled /></el-icon>
        <div class="upload-text">
          将文件拖到此处，或 <em>点击选择文件</em>
        </div>
        <div class="upload-tip">
          大文件自动分片上传；服务端已存在的相同文件将秒传，中断后可从断点继续
        </div>
      </el-upload>

      <!-- 上传归属：分类 + 任务必须选（上传人是当前登录账号，页面不再展示） -->
      <div class="ownership-bar">
        <div class="ownership-item">
          <span class="label"><i class="required">*</i>文件分类</span>
          <el-select
            v-model="categoryId"
            placeholder="请选择文件分类"
            clearable
            filterable
            style="width: 200px"
            :loading="loadingCategories"
          >
            <el-option
              v-for="item in categories"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
          </el-select>
        </div>
        <div class="ownership-item">
          <span class="label"><i class="required">*</i>所属任务</span>
          <el-select
            v-model="taskIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="2"
            placeholder="请选择所属任务（可多选）"
            clearable
            filterable
            style="width: 320px"
            :loading="loadingTasks"
          >
            <el-option
              v-for="item in taskOptions"
              :key="item.id"
              :label="item.title"
              :value="item.id"
            />
          </el-select>
        </div>
        <span v-if="!canUpload" class="ownership-tip">
          请先选择文件分类和至少一个所属任务后，再选择文件上传
        </span>
      </div>

      <div class="toolbar">
        <div class="toolbar-left">
          <span class="label">分片大小</span>
          <el-select v-model="chunkSize" size="default" style="width: 120px">
            <el-option
              v-for="item in chunkSizeOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
          <span class="label">并发</span>
          <el-select v-model="concurrency" size="default" style="width: 110px">
            <el-option
              v-for="item in concurrencyOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </div>
        <div class="toolbar-right">
          <el-button :disabled="!hasActive" @click="handlePauseAll">全部暂停</el-button>
          <el-button :disabled="!hasPaused" @click="handleResumeAll">全部继续</el-button>
          <el-button :disabled="!hasDone" @click="handleClearFinished">清空已完成</el-button>
        </div>
      </div>
    </el-card>

    <!-- 2. 上传队列 -->
    <el-card shadow="never" class="upload-card">
      <template #header>
        <div class="card-header">
          <span>上传列表</span>
          <span class="sub-title">共 {{ tasks.length }} 个任务</span>
        </div>
      </template>

      <el-empty v-if="!tasks.length" description="暂无上传任务，拖入文件即可开始上传" />

      <div v-else class="task-list">
        <div v-for="task in tasks" :key="task.uid" class="task-item">
          <div class="task-main">
            <div class="task-title">
              <el-icon class="file-icon"><Document /></el-icon>
              <span class="file-name" :title="task.fileName">{{ task.fileName }}</span>
              <el-tag v-if="task.instant" type="success" effect="dark" size="small">秒传</el-tag>
              <!-- 直传标记：让用户一眼看出字节是走 OSS 还是经过我们的服务器 -->
              <el-tag v-if="task.channel === 'oss'" type="warning" effect="plain" size="small">
                对象存储直传
              </el-tag>
              <el-tag :type="statusTagType(task.status)" effect="plain" size="small">
                {{ statusLabel(task.status) }}
              </el-tag>
            </div>

            <!-- 归属标签：队列与任务详情页共用，标注清楚这张卡片属于哪个分类 / 任务，
                 避免在别的页面看到时误以为是当前选择的对象 -->
            <div class="task-ownership">
              <el-tag v-if="task.categoryId" size="small" effect="plain" type="info">
                分类：{{ categoryName(task.categoryId) }}
              </el-tag>
              <el-tag
                v-for="id in ownershipTaskIds(task)"
                :key="id"
                size="small"
                effect="plain"
                type="primary"
              >
                任务：{{ taskTitle(id) }}
              </el-tag>
            </div>

            <el-progress
              :percentage="task.progress"
              :status="progressStatus(task.status)"
              :stroke-width="8"
            />

            <div class="task-meta">
              <span>{{ formatSize(task.fileSize) }}</span>
              <!-- 直传没有「第几片」的概念（SDK 内部并发），改用已传字节 / 总字节，信息更准确 -->
              <span v-if="task.channel === 'oss'">
                {{ formatSize(Math.round((task.fileSize * task.progress) / 100)) }} /
                {{ formatSize(task.fileSize) }}
              </span>
              <span v-else>分片 {{ task.uploadedChunks.length }} / {{ task.totalChunks }}</span>
              <span v-if="task.status === 'uploading'" class="speed">
                {{ formatSpeed(task.speed) }} · 剩余 {{ formatRemaining(task.remaining) }}
              </span>
              <span v-if="task.status === 'hashing'">正在计算文件指纹...</span>
              <span v-if="task.status === 'checking'">正在校验服务端分片...</span>
              <span v-if="task.status === 'error'" class="error-text">{{ task.errorMsg }}</span>
              <span v-else-if="task.errorMsg" class="warn-text">{{ task.errorMsg }}</span>
            </div>
          </div>

          <div class="task-actions">
            <el-button v-if="isRunning(task.status)" size="small" @click="pauseTask(task.uid)">
              暂停
            </el-button>
            <el-button
              v-if="task.status === 'paused'"
              size="small"
              type="primary"
              @click="handleResume(task)"
            >
              继续
            </el-button>
            <el-button
              v-if="task.status === 'error'"
              size="small"
              type="warning"
              @click="retryTask(task.uid)"
            >
              重试
            </el-button>
            <el-button size="small" type="danger" plain @click="handleRemove(task)">移除</el-button>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 3. 服务端已上传文件 -->
    <el-card shadow="never" class="upload-card">
      <template #header>
        <div class="card-header">
          <span>已上传文件</span>
          <div class="header-actions">
            <el-select
              v-model="filterCategoryId"
              placeholder="按分类筛选"
              clearable
              size="small"
              style="width: 160px"
              @change="loadFiles"
            >
              <el-option
                v-for="item in categories"
                :key="item.id"
                :label="item.name"
                :value="item.id"
              />
            </el-select>
            <el-select
              v-model="filterTaskId"
              placeholder="按任务筛选"
              clearable
              size="small"
              style="width: 180px"
              @change="loadFiles"
            >
              <el-option
                v-for="item in taskOptions"
                :key="item.id"
                :label="item.title"
                :value="item.id"
              />
            </el-select>
            <el-button size="small" text type="primary" :loading="loadingFiles" @click="loadFiles">
              <el-icon style="margin-right: 4px"><Refresh /></el-icon>刷新
            </el-button>
            <!-- 批量删除：未勾选时禁用，勾选后显示条数，避免误删 -->
            <el-button
              size="small"
              type="danger"
              plain
              :disabled="!selectedRows.length || batchDeleting"
              :loading="batchDeleting"
              @click="handleBatchDelete"
            >
              批量删除{{ selectedRows.length ? `（${selectedRows.length}）` : '' }}
            </el-button>
          </div>
        </div>
      </template>

      <el-table
        ref="fileTableRef"
        :data="fileList"
        row-key="id"
        style="width: 100%"
        @selection-change="handleSelectionChange"
      >
        <!-- 复选框列：支持多选后一次性删除 -->
        <el-table-column type="selection" width="48" :selectable="isRowSelectable" />
        <el-table-column prop="fileName" label="文件名" show-overflow-tooltip />
        <el-table-column label="大小" width="120">
          <template #default="{ row }">{{ formatSize(row.fileSize) }}</template>
        </el-table-column>
        <el-table-column label="文件分类" width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag v-if="row.categoryName" size="small" effect="plain" type="success">
              {{ row.categoryName }}
            </el-tag>
            <span v-else class="empty-text">-</span>
          </template>
        </el-table-column>
        <el-table-column label="所属任务" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.taskTitle">{{ row.taskTitle }}</span>
            <span v-else class="empty-text">-</span>
          </template>
        </el-table-column>
        <el-table-column label="上传时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="上传人" width="120" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag v-if="row.uploaderName" size="small" effect="plain" type="info">
              {{ row.uploaderName }}
            </el-tag>
            <span v-else class="empty-text">-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <!-- 查看：复用任务详情页的预览弹窗能力，不支持的类型直接禁用并给出说明 -->
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
            <el-button size="small" link type="danger" @click="handleDeleteFile(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 提示：管理员可管理全部文件（不区分上传人） -->
      <div v-if="fileList.length" class="file-tip">
        勾选文件后可批量删除。此页展示系统中的全部文件（含其他成员上传），管理员均可查看、下载和删除。
      </div>
    </el-card>

    <!-- 在线查看弹窗 -->
    <FilePreviewDialog
      v-model:visible="previewVisible"
      :file="previewFile"
      @download="handleDownload"
    />

    <!-- 断点恢复时重新选择原文件 -->
    <input ref="restoreInputRef" type="file" class="hidden-input" @change="handleRestoreFile" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile, UploadInstance, TableInstance } from 'element-plus'
import { Document, Refresh, UploadFilled } from '@element-plus/icons-vue'
import { deleteFile, downloadFile, getFiles } from '@/api/upload'
import { getCategoryOptions } from '@/api/category'
import { getTasks } from '@/api/task'
import { DEFAULT_CHUNK_SIZE } from '@/types'
import type {
  FileCategory,
  Task,
  UploadStatus,
  UploadTask,
  UploadFileItem
} from '@/types'
import {
  addFiles,
  clearFinished,
  fileList,
  formatRemaining,
  formatSize,
  formatSpeed,
  getMaxConcurrency,
  pauseTask,
  removeTask,
  restoreTasks,
  resumeByFile,
  resumeTask,
  retryTask,
  setMaxConcurrency,
  setOwnership,
  tasks
} from '@/utils/uploadManager'
import { canPreview as canPreviewFile } from '@/utils/filePreview'
import FilePreviewDialog from '@/components/FilePreviewDialog.vue'

// 并发数：与引擎共用同一份配置，页面调整后立即生效（1~6）
const concurrency = ref(getMaxConcurrency())
const concurrencyOptions = [1, 2, 3, 4, 5, 6].map((value) => ({
  label: `${value} 并发`,
  value
}))

watch(concurrency, (value) => setMaxConcurrency(value))

// 分片大小，默认 5MB；小文件可切到 1MB 方便体验分片流程
const chunkSize = ref(DEFAULT_CHUNK_SIZE)
const chunkSizeOptions = [
  { label: '1 MB', value: 1 * 1024 * 1024 },
  { label: '5 MB', value: 5 * 1024 * 1024 },
  { label: '10 MB', value: 10 * 1024 * 1024 },
  { label: '20 MB', value: 20 * 1024 * 1024 },
  { label: '50 MB', value: 50 * 1024 * 1024 }
]

const uploadRef = ref<UploadInstance>()
const restoreInputRef = ref<HTMLInputElement>()
// 当前等待重新选择原文件的断点任务 uid
const restoringUid = ref('')
const loadingFiles = ref(false)
// 正在下载的文件 id（0 表示没有）
const downloadingId = ref(0)
// 当前下载进度（百分比）
const downloadPercent = ref(0)

/* ------------------------- 已上传文件：多选 / 批量删除 / 在线查看 ------------------------- */
// 已上传文件表格实例：清空选中、刷新后恢复选中都靠它
const fileTableRef = ref<TableInstance>()
// 当前勾选的文件行（由 el-table 的 selection-change 维护）
const selectedRows = ref<UploadFileItem[]>([])
// 批量删除进行中：避免重复点击
const batchDeleting = ref(false)
// 在线查看弹窗
const previewVisible = ref(false)
const previewFile = ref<UploadFileItem | null>(null)

const hasActive = computed(() => tasks.some((task) => isRunning(task.status)))
const hasPaused = computed(() => tasks.some((task) => task.status === 'paused'))
const hasDone = computed(() => tasks.some((task) => task.status === 'done'))

/* ------------------------- 上传归属：分类 / 任务 ------------------------- */

const route = useRoute()

const categories = ref<FileCategory[]>([])
const taskOptions = ref<Task[]>([])
const loadingCategories = ref(false)
const loadingTasks = ref(false)

// 当前选中的归属（上传前必选）
const categoryId = ref<number | undefined>()
// 所属任务：可多选，至少选一个，同一个文件会同时挂到选中的所有任务下
const taskIds = ref<number[]>([])
// 文件列表的筛选条件（可选，单选）
const filterCategoryId = ref<number | undefined>()
const filterTaskId = ref<number | undefined>()

// 分类必选 + 任务至少选一个，才允许选择文件
const canUpload = computed(() => !!categoryId.value && taskIds.value.length > 0)

// 因缺少分类 / 任务而暂未展示的断点任务数
const restoredSkipCount = ref(0)

// 选择变化后同步给上传引擎：任务创建时会把归属"拍照"保存，之后切换不影响已入队任务
watch([categoryId, taskIds], ([newCategoryId, newTaskIds]) => {
  const validTaskIds = (newTaskIds ?? []).filter((id) => Number.isInteger(id) && id > 0)
  setOwnership(
    newCategoryId && validTaskIds.length
      ? { categoryId: newCategoryId, taskIds: validTaskIds }
      : null
  )
  // 选好归属后，把之前因缺少归属而没能恢复的断点补上
  if (newCategoryId && validTaskIds.length && restoredSkipCount.value) {
    const skipped = restoreTasks({ categoryId: newCategoryId, taskIds: validTaskIds })
    if (skipped < restoredSkipCount.value) {
      ElMessage.success('已恢复可续传的断点任务')
    }
    restoredSkipCount.value = skipped
  }
})

onMounted(async () => {
  await Promise.all([loadCategories(), loadTasks()])
  // 刷新页面后恢复本地断点记录（显示为已暂停，需重新选择文件后继续）
  restoredSkipCount.value = restoreTasks(
    categoryId.value && taskIds.value.length
      ? { categoryId: categoryId.value, taskIds: taskIds.value }
      : undefined
  )
  void loadFiles()
})

// 分类下拉数据（来自「文件分类」维护页，仅管理员能改，成员只能选）
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

// 任务下拉数据（后端已按角色过滤：管理员看全部，成员看自己的）
async function loadTasks() {
  loadingTasks.value = true
  try {
    const res: any = await getTasks()
    taskOptions.value = (res?.data ?? res ?? []) as Task[]
    // 从任务详情页跳转过来时带 ?taskId=，自动预选所属任务
    const preselect = Number(route.query.taskId)
    if (!taskIds.value.length && Number.isInteger(preselect) && preselect > 0) {
      if (taskOptions.value.some((item) => Number(item.id) === preselect)) {
        taskIds.value = [preselect]
      }
    }
  } catch (error: any) {
    if (!error?.response) ElMessage.error(error?.message || '加载任务列表失败')
  } finally {
    loadingTasks.value = false
  }
}

// 通过 id 反查名称，用于上传队列里展示归属
function categoryName(id?: number) {
  if (!id) return '-'
  return categories.value.find((item) => item.id === id)?.name || `#${id}`
}

function taskTitle(id?: number) {
  if (!id) return '-'
  return taskOptions.value.find((item) => item.id === id)?.title || `#${id}`
}

/**
 * 卡片归属的任务 id 列表。
 *
 * 多任务上传时每个任务一张卡片（卡片上只有 taskId），老记录可能只有 taskIds，
 * 这里统一成一个数组，供模板渲染归属标签使用。
 */
function ownershipTaskIds(task: UploadTask) {
  if (task.taskIds?.length) return task.taskIds
  return task.taskId ? [task.taskId] : []
}

// 上传时间格式化（后端返回 ISO 字符串，直接展示对用户不友好）
function formatTime(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function isRunning(status: UploadStatus) {
  return ['pending', 'hashing', 'checking', 'uploading'].includes(status)
}

function progressStatus(status: UploadStatus) {
  if (status === 'done') return 'success'
  if (status === 'error') return 'exception'
  return undefined
}

// el-upload 选择/拖入文件（auto-upload=false，交给我们自己的分片逻辑）
function handleFileChange(uploadFile: UploadFile) {
  if (uploadFile.raw) {
    // 分类与任务必选：没选就不让上传，避免文件"无主"
    if (!canUpload.value) {
      ElMessage.warning('请先选择文件分类和至少一个所属任务')
      uploadRef.value?.clearFiles()
      return
    }
    const pickedTaskIds = [...taskIds.value]
    const added = addFiles([uploadFile.raw], chunkSize.value, {
      categoryId: categoryId.value as number,
      taskIds: pickedTaskIds
    })
    if (!added.length) {
      ElMessage.warning(
        pickedTaskIds.length > 1
          ? '所选文件已挂到选中的全部任务下，无需重复上传'
          : '该文件已在队列中，请等待上传完成或先移除'
      )
    }
  }
  // 清空 el-upload 内部列表，页面使用自己的任务列表
  uploadRef.value?.clearFiles()
}

// 全部暂停
function handlePauseAll() {
  tasks.forEach((task) => {
    if (isRunning(task.status)) pauseTask(task.uid)
  })
  ElMessage.info('已暂停全部任务，断点已保存')
}

// 全部继续
// 注意：刷新后恢复的占位任务（手里没有真实 File）不能批量触发 ——
// 浏览器只会弹出最后一次文件选择框，restoringUid 也会被后面的任务覆盖，
// 所以这里跳过它们，提示用户逐个点“继续”并选择原文件。
function handleResumeAll() {
  const paused = tasks.filter((task) => task.status === 'paused')
  if (!paused.length) return
  const needFile = paused.filter(needsRestoreFile)
  paused.filter((task) => !needsRestoreFile(task)).forEach((task) => resumeTask(task.uid))
  if (needFile.length) {
    ElMessage.warning(`有 ${needFile.length} 个任务需要重新选择原文件，请逐个点击“继续”`)
  }
}

/**
 * 是否需要用户重新选择原文件
 *
 * 只有刷新页面后恢复出来的占位任务才需要：浏览器出于安全限制，无法通过路径重新拿到 File 对象。
 * 优先看引擎打的显式标记 needsFile，老数据没有该字段时退回 file.size === 0
 * （占位 File 是空壳）。普通暂停的任务手里仍有真实 File，直接按本地断点续传，
 * 不该再弹文件选择框 —— 以前用 errorMsg 判断，残留的错误提示会让正常暂停的任务也弹框。
 */
function needsRestoreFile(task: UploadTask) {
  return task.needsFile === true || task.file.size === 0
}

// 继续单个任务：仅断点恢复的占位任务需要先重新选择原文件
function handleResume(task: UploadTask) {
  if (task.status === 'paused' && needsRestoreFile(task)) {
    restoringUid.value = task.uid
    restoreInputRef.value?.click()
    return
  }
  resumeTask(task.uid)
}

// 断点恢复：重新选择了原文件
function handleRestoreFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !restoringUid.value) {
    input.value = ''
    return
  }
  const ok = resumeByFile(restoringUid.value, file)
  if (ok) {
    ElMessage.success('断点恢复成功，正在继续上传')
    restoringUid.value = ''
  } else {
    ElMessage.error('文件不匹配，请选择与断点记录同名、同大小的原文件')
  }
  input.value = ''
}

// 移除任务
async function handleRemove(task: UploadTask) {
  if (isRunning(task.status)) {
    try {
      await ElMessageBox.confirm(
        '任务正在上传中，确定要移除吗？已上传的分片会保留，稍后可重新选择文件续传。',
        '移除确认',
        { confirmButtonText: '确定移除', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return
    }
    // 上传中移除：保留断点记录，方便之后重新续传
    removeTask(task.uid, false)
  } else {
    removeTask(task.uid)
  }
  ElMessage.success('已从列表移除')
}

// 清空已完成
function handleClearFinished() {
  clearFinished()
  ElMessage.success('已清空已完成任务')
}

// 状态展示
const statusMap: Record<UploadStatus, string> = {
  pending: '等待中',
  hashing: '计算指纹',
  checking: '校验中',
  uploading: '上传中',
  paused: '已暂停',
  merging: '合并中',
  done: '已完成',
  error: '失败'
}

const statusTagMap: Record<UploadStatus, 'success' | 'warning' | 'info' | 'primary' | 'danger'> = {
  pending: 'info',
  hashing: 'primary',
  checking: 'primary',
  uploading: 'primary',
  paused: 'warning',
  merging: 'warning',
  done: 'success',
  error: 'danger'
}

function statusLabel(status: UploadStatus) {
  return statusMap[status]
}

function statusTagType(status: UploadStatus) {
  return statusTagMap[status]
}

// 服务端文件列表（可按分类 / 任务筛选）
async function loadFiles() {
  loadingFiles.value = true
  try {
    const res = await getFiles({
      ...(filterCategoryId.value ? { categoryId: filterCategoryId.value } : {}),
      ...(filterTaskId.value ? { taskId: filterTaskId.value } : {})
    })
    const list: UploadFileItem[] = (res as any)?.data ?? (res as any) ?? []
    // 先清空勾选：列表变了之后旧选中项可能已不存在，留着会导致「看着没勾却能批量删」
    fileTableRef.value?.clearSelection()
    selectedRows.value = []
    fileList.length = 0
    fileList.push(...list)
  } catch {
    // 后端未提供该接口时静默忽略
  } finally {
    loadingFiles.value = false
  }
}

/* ------------------------- 多选 / 在线查看 ------------------------- */

function handleSelectionChange(rows: UploadFileItem[]) {
  selectedRows.value = rows
}

/**
 * 该页面仅管理员可访问（路由 meta.role = admin），后端对管理员也放开了文件可见性与
 * 删除权限，因此这里不再按上传人做限制：所有行都可以勾选、都可以删除。
 * 唯一保留的限制是「正在下载的文件不可删除」，避免边下边删。
 */
function isRowSelectable(row: UploadFileItem) {
  return !downloadingId.value || downloadingId.value !== row.id
}

function openPreview(row: UploadFileItem) {
  previewFile.value = row
  previewVisible.value = true
}

async function handleDownload(row: UploadFileItem) {
  // 下载接口需要鉴权，走 fetch 流式下载；同一时间只允许一个下载任务
  if (downloadingId.value) return
  downloadingId.value = row.id
  downloadPercent.value = 0
  // 正在下载的文件不允许被批量删除，若此前已被勾选则先取消勾选
  if (selectedRows.value.some((item) => item.id === row.id)) {
    fileTableRef.value?.toggleRowSelection(row, false)
    selectedRows.value = selectedRows.value.filter((item) => item.id !== row.id)
  }
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

/* ------------------------- 删除（单个 / 批量） ------------------------- */

async function handleDeleteFile(row: UploadFileItem) {
  try {
    await ElMessageBox.confirm(`确定要删除文件「${row.fileName}」吗？`, '删除确认', {
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
    loadFiles()
  } catch (error: any) {
    // 错误提示由 request.ts 拦截器统一弹出，这里只兜底拦截器之外抛出的异常
    if (!error?.response) {
      ElMessage.error(error?.message || '删除失败')
    }
  }
}

async function handleBatchDelete() {
  const rows = [...selectedRows.value]
  if (!rows.length || batchDeleting.value) return

  try {
    await ElMessageBox.confirm(
      `确定要删除选中的 ${rows.length} 个文件吗？删除后不可恢复。`,
      '批量删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }

  batchDeleting.value = true
  try {
    // 后端只有单条删除接口（DELETE /upload/files/:id），这里并发提交并用
    // allSettled 汇总结果：个别失败（例如别人的文件返回 404）不影响其余文件删除，
    // 最终按成功 / 失败数量给出明确反馈，而不是不管怎样都提示「删除成功」。
    const results = await Promise.allSettled(rows.map((row) => deleteFile(row.id)))
    const failed = results.filter((item) => item.status === 'rejected') as PromiseRejectedResult[]
    const successCount = results.length - failed.length

    if (!failed.length) {
      ElMessage.success(`已删除 ${successCount} 个文件`)
    } else if (successCount === 0) {
      ElMessage.error('删除失败，请稍后重试')
    } else {
      ElMessage.warning(`已删除 ${successCount} 个，${failed.length} 个删除失败`)
    }

    // 失败原因里如果包含鉴权 / 非 404 的服务端错误，拦截器已经弹过提示，这里不重复打扰
    const unexpected = failed.find((item) => !(item.reason as any)?.response)
    if (unexpected) {
      ElMessage.error((unexpected.reason as any)?.message || '部分文件删除失败')
    }
  } finally {
    batchDeleting.value = false
    loadFiles()
  }
}
</script>

<style scoped>
.file-upload {
  padding: 20px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.upload-card {
  border-radius: 12px;
  border: 1px solid var(--border, #e6e8eb);
}

.upload-card :deep(.el-card__header) {
  padding: 14px 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  color: var(--text-primary, #263238);
}

.sub-title {
  font-weight: 400;
  font-size: 13px;
  color: var(--text-secondary, #6b7684);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.empty-text {
  color: var(--text-muted, #909aa6);
}

/* 已上传文件列表底部提示 */
.file-tip {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.6;
  color: #90a4ae;
}

/* ---------- 拖拽上传区 ---------- */
.drop-area :deep(.el-upload-dragger) {
  padding: 36px 20px;
  border-radius: 12px;
  border: 1px dashed #bcd0ee;
  background: var(--primary-soft, #eff6ff);
  transition: border-color 0.15s, background 0.15s;
}

.drop-area :deep(.el-upload-dragger:hover) {
  border-color: var(--primary, #3b82f6);
  background: #e8f1fe;
}

.upload-icon {
  font-size: 52px;
  color: var(--primary, #3b82f6);
}

.upload-text {
  margin-top: 10px;
  font-size: 15px;
  color: var(--text-primary, #263238);
}

.upload-text em {
  color: var(--primary, #3b82f6);
  font-style: normal;
  font-weight: 600;
}

.upload-tip {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted, #909aa6);
}

/* ---------- 上传归属栏 ---------- */
.ownership-bar {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  margin-top: 16px;
  padding: 12px 16px;
  border-radius: 10px;
  background: #fbfcfe;
  border: 1px solid var(--border, #e6e8eb);
}

.ownership-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ownership-item .label {
  font-size: 13px;
  color: var(--text-secondary, #6b7684);
  white-space: nowrap;
}

.ownership-item .required {
  color: var(--danger, #e04f4f);
  font-style: normal;
  margin-right: 2px;
}

.ownership-tip {
  font-size: 12px;
  color: var(--warning, #d58923);
}

/* ---------- 工具栏 ---------- */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 16px;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toolbar-left .label {
  font-size: 13px;
  color: var(--text-secondary, #6b7684);
}

/* ---------- 任务列表 ---------- */
.task-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid var(--border, #e6e8eb);
  border-radius: 10px;
  background: #fbfcfe;
}

.task-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 归属标签（分类 / 所属任务）：换行排列，长任务名不撑破卡片 */
.task-ownership {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.file-icon {
  color: var(--primary, #3b82f6);
  flex-shrink: 0;
}

.file-name {
  font-weight: 500;
  color: var(--text-primary, #263238);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 520px;
}

.task-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: var(--text-secondary, #6b7684);
  flex-wrap: wrap;
}

.task-meta .speed {
  color: var(--primary, #3b82f6);
}

.task-meta .error-text {
  color: var(--danger, #e04f4f);
}

.task-meta .warn-text {
  color: var(--warning, #d58923);
}

.task-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.hidden-input {
  display: none;
}
</style>
