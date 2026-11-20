<template>
  <el-dialog
    v-model="visible"
    title="知识库"
    width="780px"
    :close-on-click-modal="false"
    class="knowledge-dialog"
    @open="load"
  >
    <div class="kb-tip">
      AI 答疑会先在你的知识库里检索，命中后再把资料作为「参考来源」一起回答。
      支持 <code>Word (.docx)</code>、<code>PDF</code> 和纯文本类文件（<code>txt / md / json / csv / xml / yml / html</code> 等），单文件不超过 10MB。
      <br />
      纯文本需为 UTF-8 编码；PDF 需是文字版（扫描件抽不出文字）；<code>.doc</code> 旧格式请先另存为 <code>.docx</code>。
    </div>

    <div class="kb-toolbar">
      <el-upload
        :show-file-list="false"
        :accept="KNOWLEDGE_ACCEPT"
        :http-request="handleUpload"
        :before-upload="beforeUpload"
        :disabled="uploading"
      >
        <el-button type="primary" :loading="uploading">
          <el-icon style="margin-right: 4px"><UploadFilled /></el-icon>
          上传文档
        </el-button>
      </el-upload>
      <el-button text :loading="loading" @click="load">
        <el-icon style="margin-right: 4px"><Refresh /></el-icon>刷新
      </el-button>
      <span class="kb-count">共 {{ docs.length }} 篇</span>
    </div>

    <el-table
      v-loading="loading"
      :data="docs"
      size="small"
      empty-text="还没有文档，上传后再来提问，回答里就会带上参考来源"
      max-height="360"
    >
      <el-table-column prop="fileName" label="文件名" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">
          <!-- 文件名做成链接：和「查看」按钮同一个入口，点名字就能看内容 -->
          <el-link type="primary" :underline="false" @click="openDetail(row)">{{ row.fileName }}</el-link>
        </template>
      </el-table-column>
      <el-table-column label="大小" width="90">
        <template #default="{ row }">{{ formatFileSize(row.fileSize) }}</template>
      </el-table-column>
      <el-table-column label="切块" width="70">
        <template #default="{ row }">{{ row.chunkCount }} 段</template>
      </el-table-column>
      <el-table-column prop="ownerName" label="上传者" width="110" show-overflow-tooltip />
      <el-table-column label="上传时间" width="130">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120" align="center">
        <template #default="{ row }">
          <el-button text type="primary" size="small" @click="openDetail(row)">查看</el-button>
          <el-button
            text
            type="danger"
            size="small"
            :disabled="row.canDelete === false"
            @click="handleDelete(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 查看文档内容：知识库只存解析后的文本，这里展示正文 -->
    <el-dialog
      v-model="detailVisible"
      :title="detail?.fileName || '文档内容'"
      width="760px"
      top="8vh"
      append-to-body
      destroy-on-close
      class="kb-detail-dialog"
    >
      <div v-loading="detailLoading" element-loading-text="文档加载中..." class="kb-detail-body">
        <el-empty v-if="detailError" :description="detailError" />
        <template v-else-if="detail">
          <div class="kb-detail-meta">
            <el-tag size="small" type="info">{{ getFileKindLabel(detail.fileName) }}</el-tag>
            <span>{{ formatFileSize(detail.fileSize) }}</span>
            <span>{{ detail.charCount }} 字</span>
            <span>{{ detail.chunkCount }} 段</span>
            <span v-if="detail.ownerName">上传者：{{ detail.ownerName }}</span>
            <span v-if="detail.createdAt">{{ formatTime(detail.createdAt) }}</span>
          </div>

          <el-alert
            v-if="showExtractTip"
            type="info"
            :closable="false"
            show-icon
            class="kb-detail-alert"
            title="以下是上传时从文件中抽取的纯文字，不含原文排版（图片、表格样式会丢失）"
          />
          <el-alert
            v-else-if="detail.truncated"
            type="warning"
            :closable="false"
            show-icon
            class="kb-detail-alert"
            title="文档较长，仅展示前面一部分内容"
          />

          <pre class="kb-detail-text">{{ detail.content || '（文档没有可展示的正文）' }}</pre>
        </template>
      </div>

      <template #footer>
        <div class="kb-detail-footer">
          <span class="kb-detail-count">{{ charSummary }}</span>
          <div class="kb-detail-actions">
            <el-button :disabled="!detail" @click="copyContent">复制全文</el-button>
            <el-button type="primary" @click="detailVisible = false">关 闭</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadRequestOptions } from 'element-plus'
import {
  KNOWLEDGE_ACCEPT,
  deleteKnowledgeDoc,
  formatFileSize,
  getKnowledgeDocDetail,
  getKnowledgeDocs,
  uploadKnowledgeDoc,
  validateKnowledgeFile
} from '@/api/knowledge'
import type { KnowledgeDoc, KnowledgeDocDetail } from '@/types'
import { getFileExt, getFileKindLabel } from '@/utils/filePreview'

/**
 * 知识库管理弹窗
 *
 * 做四件事：「查看 / 上传 / 删除」+ 检索交给后端自动完成（/ai/chat 里做 RAG）。
 *   检索不需要用户手动选文档，否则就退化成「先挑资料再提问」，
 *   失去了自动召回的意义；用户只需要维护资料本身。
 */

/** 需要解析库抽取文字的格式（查看时提示「不是原文件排版」） */
const EXTRACT_EXTS = ['docx', 'pdf']

const visible = defineModel<boolean>({ required: true })

const docs = ref<KnowledgeDoc[]>([])
const loading = ref(false)
const uploading = ref(false)

// ---------- 查看文档内容 ----------
const detailVisible = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const detail = ref<KnowledgeDocDetail | null>(null)

/** docx / pdf 展示的是抽取后的文字，给一句说明，避免用户以为是排版丢了 */
const showExtractTip = computed(() =>
  detail.value ? EXTRACT_EXTS.includes(getFileExt(detail.value.fileName)) : false
)

/** 底栏字数统计：正文被截断时同时给出「已显示 / 共」两个数字 */
const charSummary = computed(() => {
  const content = detail.value?.content || ''
  if (!content) return ''
  return content.length > (detail.value?.charCount || 0)
    ? `已显示 ${content.length} 字 / 共 ${detail.value?.charCount} 字`
    : `共 ${content.length} 字`
})

/** 只取 axios 响应里的 data，兼容拦截器是否已解包 */
function unwrap<T>(res: any): T {
  return (res?.data ?? res) as T
}

async function load() {
  loading.value = true
  try {
    const list = unwrap<KnowledgeDoc[]>(await getKnowledgeDocs())
    docs.value = Array.isArray(list) ? list : []
  } catch {
    // 拦截器已提示，保持原列表
  } finally {
    loading.value = false
  }
}

/**
 * 打开文档内容
 *
 * 每次都重新拉取（而不是复用列表数据）：列表接口不返回正文，
 * 也避免列表里的信息过期（例如别人刚删掉了这份文档）。
 */
async function openDetail(row: KnowledgeDoc) {
  detailVisible.value = true
  detailLoading.value = true
  detailError.value = ''
  detail.value = null
  try {
    const data = unwrap<KnowledgeDocDetail>(await getKnowledgeDocDetail(row.id))
    detail.value = data && typeof data === 'object' ? { ...data, content: data.content ?? '' } : null
    if (!detail.value) detailError.value = '文档内容为空'
  } catch (error: any) {
    // 404（无权限 / 已删除）等错误由拦截器弹提示，这里只在弹窗内说明一句
    detailError.value = error?.message || '文档加载失败，请稍后重试'
  } finally {
    detailLoading.value = false
  }
}

/**
 * 复制正文
 *
 * 优先用 Clipboard API；非 https 环境下它不可用，退回 textarea + execCommand，
 * 否则内网部署（http）时「复制全文」会静默失效。
 */
async function copyContent() {
  const text = detail.value?.content || ''
  if (!text) {
    ElMessage.warning('没有可复制的内容')
    return
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败，请手动选择文本复制')
  }
}

/** el-upload 的「上传前」校验：不合格直接拦下，不用请求后端 */
function beforeUpload(file: any) {
  const message = validateKnowledgeFile({ name: file.name, size: file.size })
  if (message) {
    ElMessage.warning(message)
    return false
  }
  return true
}

/** 自定义上传：直接调 api 里的 uploadKnowledgeDoc，便于拿到后端的具体错误文案 */
async function handleUpload(options: UploadRequestOptions) {
  const file = options.file as File
  uploading.value = true
  try {
    const doc = await uploadKnowledgeDoc(file)
    docs.value = [doc, ...docs.value]
    ElMessage.success(`「${doc.fileName}」已入库，共 ${doc.chunkCount} 个片段`)
  } catch (error: any) {
    ElMessage.error(error?.message || '上传失败，请稍后重试')
  } finally {
    uploading.value = false
  }
}

async function handleDelete(row: KnowledgeDoc) {
  try {
    await ElMessageBox.confirm(
      `确定从知识库删除「${row.fileName}」吗？删除后 AI 不会再引用其中的内容。`,
      '删除文档',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await deleteKnowledgeDoc(row.id)
    docs.value = docs.value.filter((item) => item.id !== row.id)
    ElMessage.success('已删除')
  } catch {
    // 提示已由拦截器给出
  }
}

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<style scoped>
.kb-tip {
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary, #909399);
  background: var(--el-fill-color-lighter, #fafafa);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.kb-tip code {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--el-fill-color, #f0f2f5);
}

.kb-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.kb-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}

/* ---------- 查看文档内容 ---------- */
.kb-detail-body {
  min-height: 240px;
}

.kb-detail-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}

.kb-detail-alert {
  margin-bottom: 10px;
}

.kb-detail-text {
  max-height: 60vh;
  overflow: auto;
  margin: 0;
  padding: 14px 16px;
  background: var(--el-fill-color-lighter, #fafafa);
  border-radius: 8px;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.75;
  text-align: left;
  /* 保留原文换行与缩进，长串（如 URL / 无空格中文）自动折行，不出现横向滚动 */
  white-space: pre-wrap;
  word-break: break-word;
  color: #263238;
}

.kb-detail-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kb-detail-count {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}

.kb-detail-actions {
  display: flex;
  gap: 8px;
}
</style>
