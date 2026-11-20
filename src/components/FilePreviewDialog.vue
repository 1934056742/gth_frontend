<template>
  <!-- 文件在线查看：图片 / 视频 / 音频 / PDF 直接在弹窗内渲染，文本类读取后展示 -->
  <el-dialog
    :model-value="visible"
    :title="file?.fileName || '文件查看'"
    width="860px"
    top="6vh"
    destroy-on-close
    class="preview-dialog"
    @update:model-value="handleVisibleChange"
  >
    <div v-loading="loading" element-loading-text="文件加载中..." class="preview-body">
      <el-empty v-if="errorText" :description="errorText">
        <el-button type="primary" @click="emit('download', file!)">下载后查看</el-button>
      </el-empty>

      <template v-else-if="mediaUrl">
        <!-- 视频 / 音频 / 图片 / PDF 直接用后端直链：
             浏览器原生发送 Range 请求，边下边播、可拖动进度条，不占前端内存 -->
        <video
          v-if="kind === 'video'"
          :key="mediaUrl"
          ref="videoRef"
          :src="mediaUrl"
          class="preview-video"
          controls
          autoplay
          preload="metadata"
          @error="handleMediaError"
        />
        <audio
          v-else-if="kind === 'audio'"
          :key="mediaUrl"
          ref="audioRef"
          :src="mediaUrl"
          class="preview-audio"
          controls
          autoplay
          preload="metadata"
          @error="handleMediaError"
        />
        <img v-else-if="kind === 'image'" :src="mediaUrl" class="preview-image" :alt="file?.fileName" />
        <iframe
          v-else-if="kind === 'pdf'"
          :src="mediaUrl"
          class="preview-frame"
          title="PDF 预览"
        />
      </template>

      <!-- 文本类：需要读成字符串，仍走 blob -->
      <pre v-else-if="textContent" class="preview-text">{{ textContent }}</pre>
    </div>

    <template #footer>
      <div class="preview-footer">
        <span class="preview-meta">
          {{ kindLabel }}<template v-if="file"> · {{ formatFileSize(file.fileSize) }}</template>
        </span>
        <div class="preview-actions">
          <el-button @click="emit('download', file!)" :disabled="!file">下载</el-button>
          <el-button type="primary" @click="handleVisibleChange(false)">关 闭</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { UploadFileItem } from '@/types'
import { fetchFileBlobUrl, getPreviewUrl } from '@/api/upload'
import { formatFileSize, getFileKind, getFileKindLabel } from '@/utils/filePreview'

const props = defineProps<{
  visible: boolean
  file: UploadFileItem | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  // 交给父组件统一下载（父组件已有下载进度提示）
  (e: 'download', file: UploadFileItem): void
}>()

const loading = ref(false)
const errorText = ref('')
// 直链地址：视频 / 音频 / 图片 / PDF 用
const mediaUrl = ref('')
// 文本内容：只有文本类型才会赋值
const textContent = ref('')
const videoRef = ref<HTMLVideoElement | null>(null)
const audioRef = ref<HTMLAudioElement | null>(null)

const kind = computed(() => (props.file ? getFileKind(props.file.fileName) : 'other'))
const kindLabel = computed(() => (props.file ? getFileKindLabel(props.file.fileName) : ''))

// 释放上一次的资源：
// 直链是后端地址，不需要 revoke；但文本分支仍会创建 blob，必须释放
let textBlobUrl = ''
function revoke() {
  if (textBlobUrl) {
    URL.revokeObjectURL(textBlobUrl)
    textBlobUrl = ''
  }
  mediaUrl.value = ''
  textContent.value = ''
  videoRef.value = null
  audioRef.value = null
}

/**
 * 媒体元素加载失败的兜底提示。
 * <video>/<audio> 的 error 事件不给出可读原因，这里把 MediaError 映射成人话，
 * 避免用户只看到一块黑屏却不知道发生了什么。
 */
function handleMediaError() {
  const el = videoRef.value || audioRef.value
  const code = el?.error?.code
  const map: Record<number, string> = {
    1: '加载被中断，请重试',
    2: '网络异常，视频加载失败',
    3: '视频解码失败，可能是文件不完整或编码不受支持',
    4: '视频格式不被当前浏览器支持，请下载后播放'
  }
  errorText.value = (code && map[code]) || '视频加载失败，请下载后查看'
}

async function loadText(file: UploadFileItem) {
  // 文本必须读出内容再展示，这部分无法避免整份读取
  // （文本文件通常很小，不存在视频那种内存/卡顿问题）
  const blobUrl = await fetchFileBlobUrl(file.id, 'text/plain; charset=utf-8')
  try {
    const blob = await fetch(blobUrl).then((res) => res.blob())
    textContent.value = await blob.text()
    // 保留 blob 地址到关闭时统一释放
    textBlobUrl = blobUrl
  } catch {
    URL.revokeObjectURL(blobUrl)
    throw new Error('文本内容读取失败，请下载后查看')
  }
}

async function loadFile(file: UploadFileItem) {
  revoke()
  errorText.value = ''
  loading.value = true
  try {
    if (getFileKind(file.fileName) === 'text') {
      await loadText(file)
    } else {
      // 其余类型直接给后端直链：
      // 后端返回正确 Content-Type + inline，并支持 Range，
      // 浏览器会自己分段拉取，30MB 的视频也能秒开、可拖动。
      mediaUrl.value = getPreviewUrl(file.id)
      await nextTick()
    }
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '文件加载失败'
    ElMessage.error(errorText.value)
  } finally {
    loading.value = false
  }
}

// 打开时加载，关闭时释放
// 用字符串 key 而不是数组：数组每次都是新引用，会导致无关渲染时重复拉取文件
watch(
  () => `${props.visible ? 1 : 0}:${props.file?.id ?? ''}`,
  (key) => {
    const [visibleFlag, id] = key.split(':')
    if (visibleFlag === '1' && id) {
      loadFile(props.file as UploadFileItem)
    } else if (visibleFlag === '0') {
      revoke()
      errorText.value = ''
    }
  },
  { immediate: true }
)

function handleVisibleChange(value: boolean) {
  emit('update:visible', value)
}

onBeforeUnmount(revoke)
</script>

<style scoped>
.preview-body {
  min-height: 240px;
  max-height: 72vh;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f7f8fa;
  border-radius: 8px;
  padding: 12px;
}

.preview-image {
  max-width: 100%;
  max-height: 68vh;
  object-fit: contain;
  border-radius: 6px;
}

.preview-video {
  max-width: 100%;
  max-height: 68vh;
  background: #000;
  border-radius: 6px;
}

.preview-audio {
  width: 100%;
}

.preview-frame {
  width: 100%;
  height: 68vh;
  border: none;
  background: #fff;
}

.preview-text {
  width: 100%;
  margin: 0;
  padding: 12px;
  text-align: left;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: #263238;
}

.preview-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.preview-meta {
  color: #90a4ae;
  font-size: 13px;
}

.preview-actions {
  display: flex;
  gap: 8px;
}
</style>
