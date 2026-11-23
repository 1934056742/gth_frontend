<template>
  <div class="ai-chat-panel">
    <!-- ========== 左侧：历史会话 ========== -->
    <aside class="conv-sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="conv-head">
        <el-button class="new-chat-btn" type="primary" @click="startNewChat">
          <el-icon style="margin-right: 4px;"><Plus /></el-icon>新建对话
        </el-button>
      </div>

      <div class="conv-list" v-loading="loadingConversations">
        <div
          v-for="item in conversations"
          :key="item.id"
          class="conv-item"
          :class="{ active: item.id === activeId }"
          @click="selectConversation(item.id)"
        >
          <el-icon class="conv-icon"><ChatDotRound /></el-icon>
          <div class="conv-body">
            <div class="conv-title" :title="item.title">{{ item.title || '新对话' }}</div>
            <div class="conv-sub">{{ item.messageCount ?? 0 }} 条消息 · {{ formatTime(item.updatedAt || item.createdAt) }}</div>
          </div>
          <el-dropdown trigger="click" @command="(cmd: string) => handleConvCommand(cmd, item)" @click.stop>
            <span class="conv-more" @click.stop><el-icon><MoreFilled /></el-icon></span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="rename">重命名</el-dropdown-item>
                <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <el-empty
          v-if="!loadingConversations && conversations.length === 0"
          description="还没有历史对话"
          :image-size="60"
        />
      </div>
    </aside>

    <!-- ========== 右侧：对话窗口 ========== -->
    <section class="chat-main">
      <header class="chat-header">
        <div class="chat-title">
          <el-button class="collapse-btn" text @click="sidebarCollapsed = !sidebarCollapsed">
            <el-icon><Expand v-if="sidebarCollapsed" /><Fold v-else /></el-icon>
          </el-button>
          <el-icon class="title-icon"><MagicStick /></el-icon>
          <span>{{ activeConversation?.title || 'AI 答疑助手' }}</span>
        </div>
        <div class="chat-actions">
          <el-button text @click="kbVisible = true">
            <el-icon style="margin-right: 4px"><Collection /></el-icon>知识库
          </el-button>
          <el-button text :disabled="sending || messages.length === 0" @click="startNewChat">
            清空当前对话
          </el-button>
        </div>
      </header>

      <!-- 消息区 -->
      <div ref="scrollRef" class="chat-body" @scroll="onScroll">
        <!-- 空状态：欢迎语 -->
        <div v-if="messages.length === 0" class="welcome">
          <div class="welcome-avatar"><el-icon><MagicStick /></el-icon></div>
          <h3>你好，我是 AI 答疑助手</h3>
          <p>在下方输入框直接提问即可，对话会自动保存到左侧历史记录里。</p>
        </div>

        <!-- 消息列表 -->
        <div v-for="msg in messages" :key="msg.id" class="msg-row" :class="msg.role">
          <div class="avatar">
            <el-icon v-if="msg.role === 'assistant'"><MagicStick /></el-icon>
            <span v-else>{{ userInitial }}</span>
          </div>
          <div class="msg-main">
            <div class="bubble" :class="{ error: msg.error }">
              <!-- 用户消息：保留换行，纯文本展示 -->
              <div v-if="msg.role === 'user'" class="bubble-text">{{ msg.content }}</div>
              <!-- AI 消息：Markdown 渲染（已在 utils/markdown 里做过转义） -->
              <div
                v-else
                class="markdown-body"
                v-html="renderMarkdown(msg.content, msg.streaming)"
              ></div>
              <span v-if="msg.streaming" class="cursor"></span>
            </div>

            <div class="msg-ops" v-if="msg.role === 'assistant' && !msg.streaming">
              <el-button text size="small" @click="copyMessage(msg)">
                <el-icon><CopyDocument /></el-icon>复制
              </el-button>
              <el-button text size="small" :disabled="sending" @click="regenerate(msg)">
                <el-icon><RefreshRight /></el-icon>重新生成
              </el-button>
            </div>

            <!-- 参考来源：后端检索到知识库片段时才会出现 -->
            <div v-if="msg.role === 'assistant' && msg.sources?.length" class="msg-sources">
              <div class="sources-head">
                <el-icon><Document /></el-icon>
                <span>参考来源（{{ msg.sources.length }}）</span>
              </div>
              <ul class="sources-list">
                <li v-for="(source, index) in msg.sources" :key="`${source.docId}-${source.seq}`">
                  <span class="source-index">{{ index + 1 }}.</span>
                  <el-tooltip :content="source.snippet" placement="top" :show-after="300">
                    <span class="source-name">{{ source.fileName }}</span>
                  </el-tooltip>
                  <span class="source-seq">第 {{ source.seq + 1 }} 段</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <!-- 等待首包时的三点动画 -->
        <div v-if="waiting" class="msg-row assistant">
          <div class="avatar"><el-icon><MagicStick /></el-icon></div>
          <div class="bubble typing"><span></span><span></span><span></span></div>
        </div>
      </div>

      <!-- 输入区 -->
      <footer class="chat-footer">
        <div class="input-box">
          <el-input
            ref="inputRef"
            v-model="draft"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 6 }"
            resize="none"
            placeholder="输入你的问题，Enter 发送，Shift + Enter 换行"
            :disabled="sending"
            @keydown="onKeydown"
          />
          <div class="input-ops">
            <span class="hint">Enter 发送 / Shift + Enter 换行</span>
            <el-button v-if="sending" class="send-btn" @click="stopGenerating">
              <el-icon><VideoPause /></el-icon>停止生成
            </el-button>
            <el-button v-else type="primary" class="send-btn" :disabled="!canSend" @click="send">
              <el-icon><Promotion /></el-icon>发送
            </el-button>
          </div>
        </div>
      </footer>
    </section>

    <!-- 知识库管理（上传 / 列表 / 删除），检索由后端自动完成 -->
    <KnowledgeBaseDialog v-model="kbVisible" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { InputInstance } from 'element-plus'
import KnowledgeBaseDialog from '@/components/KnowledgeBaseDialog.vue'
import {
  getConversations,
  getMessages,
  renameConversation,
  deleteConversation,
  chatStream,
  toAiMessage
} from '@/api/ai'
import type { AiConversation, AiMessage, ChatStreamHandle } from '@/types'
import { renderMarkdown } from '@/utils/markdown'
import { createTypewriter } from '@/utils/typewriter'
import type { TypewriterWriter } from '@/utils/typewriter'
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()

// ---------- 状态 ----------
const conversations = ref<AiConversation[]>([]) //会话列表
const messages = ref<AiMessage[]>([]) //消息列表
const activeId = ref<number | null>(null) //是否是新会话
const loadingConversations = ref(false)
const loadingMessages = ref(false)

const draft = ref('') //输入框文本
const sending = ref(false) //是否正在生成

// 已发出请求但还没收到首个 delta（显示三点动画）
const waiting = ref(false) //是否开始生成数据 等待加载间隙

const sidebarCollapsed = ref(false)
// 知识库弹窗开关
const kbVisible = ref(false)
const scrollRef = ref<HTMLElement | null>(null)
const inputRef = ref<InputInstance | null>(null)

// 当前流式请求句柄（停止生成用）
let stream: ChatStreamHandle | null = null
// 组件卸载后不再更新状态，避免请求回来后操作已销毁的组件
let disposed = false
// 打字机缓冲：把网络脉冲式的 delta 转成平稳的打字机输出
let typewriter: TypewriterWriter | null = null
// 打字机把剩余内容刷完后的收尾动作（onDone 时暂存）
let pendingFinish: (() => void) | null = null

// ---------- 计算属性 ----------
const activeConversation = computed(
  () => conversations.value.find((item) => item.id === activeId.value) || null
)
const canSend = computed(() => draft.value.trim().length > 0 && !sending.value)
const userInitial = computed(() =>
  (userStore.user?.username || userStore.user?.account || 'U').charAt(0).toUpperCase()
)

// ---------- 工具 ----------
function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 是否已经贴到底部：只有贴底时才自动滚动，用户往上翻看历史时不打扰
let pinnedToBottom = true
function onScroll() {
  const el = scrollRef.value
  if (!el) return
  pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

async function scrollToBottom(force = false) {
  if (!force && !pinnedToBottom) return
  await nextTick()
  const el = scrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}

// ---------- 会话列表 ----------
async function loadConversations() {
  loadingConversations.value = true
  try {
    const res: any = await getConversations()
    const list: AiConversation[] = res?.data || res || []
    conversations.value = list
    // 刷新页面后自动恢复最近一次会话
    if (!activeId.value && list.length) {
      await selectConversation(list[0].id, false)
      await scrollToBottom(true)
    }
  } catch {
    // 拦截器已弹出提示，这里保持空列表即可
  } finally {
    loadingConversations.value = false
  }
}

async function selectConversation(id: number, scroll = true) {
  if (sending.value) {
    ElMessage.warning('当前回答还在生成中，请先等待完成或停止生成')
    return
  }
  if (id === activeId.value) return
  activeId.value = id
  loadingMessages.value = true
  try {
    const res: any = await getMessages(id)
    const list = res?.data || res || []
    messages.value = list.map((item: any, index: number) => toAiMessage(item, index))
    pinnedToBottom = true
    if (scroll) await scrollToBottom(true)
  } catch {
    messages.value = []
  } finally {
    loadingMessages.value = false
  }
}

function startNewChat() {
  if (sending.value) {
    ElMessage.warning('当前回答还在生成中，请先等待完成或停止生成')
    return
  }
  // 只是把界面切回「空白对话」，真正的会话在第一次提问时由后端自动创建，
  // 这样列表里不会堆出一堆没有消息的空会话
  activeId.value = null
  messages.value = []
  pinnedToBottom = true
  focusInput()
}

function handleConvCommand(command: string, item: AiConversation) {
  if (command === 'rename') return handleRename(item)
  if (command === 'delete') return handleDelete(item)
}

// 重命名：复用 el-message-box 的输入框，不额外引组件
async function handleRename(item: AiConversation) {
  try {
    const { value } = await ElMessageBox.prompt('请输入新的会话名称', '重命名', {
      inputValue: item.title,
      inputValidator: (val) => (!!val && !!val.trim() ? true : '名称不能为空'),
      confirmButtonText: '确定',
      cancelButtonText: '取消'
    })
    const title = (value || '').trim()
    const res: any = await renameConversation(item.id, title)
    const updated = res?.data || res
    item.title = updated?.title || title
    ElMessage.success('重命名成功')
  } catch {
    // 用户点了取消，或接口报错（提示已由拦截器给出）
  }
}

async function handleDelete(item: AiConversation) {
  try {
    await ElMessageBox.confirm(
      `确定删除会话「${item.title || '新对话'}」吗？删除后消息不可恢复。`,
      '删除会话',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await deleteConversation(item.id)
    conversations.value = conversations.value.filter((conv) => conv.id !== item.id)
    if (activeId.value === item.id) startNewChat()
    ElMessage.success('已删除')
  } catch {
    // 提示已由拦截器给出
  }
}

// 静默刷新会话列表（不触发 loading，不切换当前会话）
async function refreshConversationsQuietly() {
  try {
    const res: any = await getConversations()
    const list: AiConversation[] = res?.data || res || []
    if (disposed) return
    conversations.value = list
  } catch {
    // 忽略：列表刷新失败不影响对话
  }
}

function focusInput() {
  nextTick(() => {
    // el-input 的 textarea 需要再取一层
    const textarea = (inputRef.value as any)?.textarea as HTMLTextAreaElement | undefined
    textarea?.focus()
  })
}

// ---------- 提问 ----------
function onKeydown(event: Event | KeyboardEvent) {
  const e = event as KeyboardEvent
  if (e.key !== 'Enter') return
  // Shift + Enter 换行；中文输入法候选状态（isComposing）也不拦截
  if (e.shiftKey || e.isComposing) return
  e.preventDefault()
  if (canSend.value) send()
}

function send() {
  const question = draft.value.trim()
  if (!question || sending.value) return
  ask(question)
}

/**
 * 发起一次提问（send / 重新生成 都走这里）
 */
function ask(question: string) {
  const text = question.trim()
  if (!text || sending.value) return

  draft.value = ''

  // 先上屏用户消息与「空的 AI 气泡」，delta 到达后往里追加
  messages.value.push({ id: -Date.now(), role: 'user', content: text })
  messages.value.push({ id: -Date.now() - 1, role: 'assistant', content: '', streaming: true })
  // 关键：push 进 ref 数组后，数组里存的是 Vue 的响应式代理对象。
  // 如果继续用 push 时那个原始对象去改属性，**不会**触发视图更新，
  // 表现就是「打字机在跑、数据在变，但气泡纹丝不动」。
  // 所以这里取回数组里的代理对象，后续所有赋值才真正驱动渲染。
  const reply = messages.value[messages.value.length - 1] as AiMessage
  pinnedToBottom = true
  scrollToBottom(true)

  sending.value = true
  waiting.value = true

  // 每次提问都新建一个打字机缓冲，由它负责把 delta 平滑地打到气泡上
  pendingFinish = null
  typewriter?.stop()
  typewriter = createTypewriter({
    onUpdate(text) {
      if (disposed) return
      reply.content = text
      scrollToBottom()
    },
    onDrain() {
      if (disposed) return
      // 排空后执行收尾（onDone 早已到达时）
      const finish = pendingFinish
      pendingFinish = null
      typewriter = null
      finish?.()
    }
  })

  // 是不是新会话：用于在 meta 到达时把它插到左侧列表顶部
  const isNewConversation = activeId.value === null

  stream = chatStream(
    { question: text, conversationId: activeId.value ?? undefined },
    {
      onMeta(meta) {
        if (disposed) return
        if (Number.isInteger(meta.conversationId) && meta.conversationId > 0) {
          activeId.value = meta.conversationId
        }
        if (isNewConversation && activeId.value !== null) {
          conversations.value.unshift({
            id: activeId.value,
            title: meta.title || text.slice(0, 20),
            messageCount: 2,
            updatedAt: new Date().toISOString()
          })
        }
      },
      onSources(sources) {
        if (disposed) return
        // 来源在正文之前到达：先挂到气泡上，正文边打边显示引用
        reply.sources = sources
        scrollToBottom()
      },
      onDelta(delta) {
        if (disposed) return
        waiting.value = false
        if (!typewriter) return
        // 不直接写 reply.content，先进入打字机缓冲，由它按帧稳定吐出
        typewriter.push(delta)
        scrollToBottom()
      },
      onDone(result) {
        if (disposed) return
        // 先把最终状态准备好，等打字机把剩余内容刷完再一次性落定
        const finishContent = () => {
          reply.streaming = false
          reply.content = result.content || reply.content
          if (result.messageId) reply.id = result.messageId
          sending.value = false
          waiting.value = false
          scrollToBottom()
          // 标题 / 排序 / 消息条数以后端为准
          refreshConversationsQuietly()
        }
        if (typewriter && typewriter.pending() > 0) {
          // 还有字没打完：先让打字机冲刺刷完剩余内容，排空后落定
          pendingFinish = finishContent
          typewriter.finish()
        } else {
          typewriter?.stop()
          typewriter = null
          finishContent()
        }
      },
      onError(message) {
        if (disposed) return
        typewriter?.flush()
        typewriter = null
        reply.streaming = false
        waiting.value = false
        sending.value = false
        reply.error = true
        // 以服务端给的错误说明为准（错误前可能已经推过部分 delta）
        reply.content = message || reply.content
        ElMessage.error(message)
      },
      onAbort() {
        if (disposed) return
        typewriter?.flush()
        typewriter = null
        reply.streaming = false
        waiting.value = false
        sending.value = false
        if (!reply.content) {
          // 一点内容都没生成：移除空气泡，把问题放回输入框方便重发
          const index = messages.value.indexOf(reply)
          if (index !== -1) messages.value.splice(index, 1)
          draft.value = text
        } else {
          reply.content += '\n\n> 已停止生成。'
        }
        ElMessage.info('已停止生成')
      }
    }
  )
}

function stopGenerating() {
  stream?.abort()
  stream = null
}

// ---------- 消息操作 ----------
async function copyMessage(msg: AiMessage) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(msg.content)
    } else {
      // 非 https / 老浏览器兜底：临时 textarea + execCommand
      const textarea = document.createElement('textarea')
      textarea.value = msg.content
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    ElMessage.success('已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择复制')
  }
}

// 重新生成：找到该条 AI 回答前面的用户问题，移除这对消息后重新提问
function regenerate(msg: AiMessage) {
  if (sending.value) return
  const index = messages.value.findIndex((item) => item.id === msg.id)
  if (index <= 0) return
  const question = messages.value[index - 1]
  if (question.role !== 'user') return
  messages.value.splice(index - 1, 2)
  ask(question.content)
}

onMounted(async () => {
  await loadConversations()
  focusInput()
})

onBeforeUnmount(() => {
  disposed = true
  // 先停打字机，避免卸载后定时器还在跑
  typewriter?.stop()
  typewriter = null
  pendingFinish = null
  stream?.abort()
  stream = null
  // 防御性复位：onAbort 在 disposed 后会提前 return，这里兜底避免状态卡住
  sending.value = false
  waiting.value = false
})
</script>

<style scoped>
.ai-chat-panel {
  display: flex;
  height: 100%;
  background: var(--app-bg, #f5f6f8);
  overflow: hidden;
  position: relative;
  border: 1px solid var(--border, #e6e8eb);
  border-radius: 12px;
}

/* ---------- 左侧会话列表 ---------- */
.conv-sidebar {
  width: 260px;
  flex: 0 0 260px;
  background: #ffffff;
  border-right: 1px solid var(--border, #e6e8eb);
  display: flex;
  flex-direction: column;
  transition: width 0.2s, flex-basis 0.2s, opacity 0.2s;
}

.conv-sidebar.collapsed {
  width: 0;
  flex-basis: 0;
  opacity: 0;
  overflow: hidden;
  border-right: none;
}

.conv-head {
  padding: 16px;
}

.new-chat-btn {
  width: 100%;
  border-radius: 8px;
}

.conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 16px;
}

.conv-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 4px;
}

.conv-item:hover {
  background: var(--el-fill-color-light, #f5f7fa);
}

.conv-item.active {
  background: var(--primary-soft, #eff6ff);
}

.conv-item.active .conv-title {
  color: var(--primary, #3b82f6);
  font-weight: 600;
}

.conv-icon {
  color: var(--text-secondary, #8a94a6);
  font-size: 15px;
  flex: 0 0 auto;
}

.conv-body {
  flex: 1;
  min-width: 0;
}

.conv-title {
  font-size: 14px;
  color: var(--text-primary, #263238);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-sub {
  font-size: 12px;
  color: var(--text-secondary, #9aa4b2);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-more {
  color: var(--text-secondary, #9aa4b2);
  display: inline-flex;
  padding: 2px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.conv-item:hover .conv-more,
.conv-item.active .conv-more {
  opacity: 1;
}

/* ---------- 右侧对话窗口 ---------- */
.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #ffffff;
}

.chat-header {
  height: 56px;
  flex: 0 0 56px;
  padding: 0 20px 0 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border, #e6e8eb);
}

.chat-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary, #263238);
  min-width: 0;
}

.chat-title > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.collapse-btn {
  color: var(--text-secondary, #6b7684);
}

.title-icon {
  color: var(--primary, #3b82f6);
}

.chat-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

/* 欢迎页 */
.welcome {
  max-width: 640px;
  margin: 8vh auto 0;
  text-align: center;
  color: var(--text-secondary, #6b7684);
}

.welcome-avatar {
  width: 52px;
  height: 52px;
  margin: 0 auto 14px;
  border-radius: 50%;
  background: var(--primary-soft, #eff6ff);
  color: var(--primary, #3b82f6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
}

.welcome h3 {
  font-size: 18px;
  color: var(--text-primary, #263238);
  margin-bottom: 8px;
}

.welcome p {
  font-size: 13px;
  line-height: 1.7;
}

/* 消息行 */
.msg-row {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
  align-items: flex-start;
}

.msg-row.user {
  flex-direction: row-reverse;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex: 0 0 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: var(--primary, #3b82f6);
  user-select: none;
}

.msg-row.assistant .avatar {
  background: var(--primary-soft, #eff6ff);
  color: var(--primary, #3b82f6);
}

.msg-main {
  max-width: min(760px, 78%);
  min-width: 0;
}

.bubble {
  background: var(--el-fill-color-light, #f5f7fa);
  border-radius: 12px;
  padding: 12px 16px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--text-primary, #263238);
  word-break: break-word;
}

.msg-row.user .bubble {
  background: var(--primary, #3b82f6);
  color: #fff;
}

.bubble.error {
  background: #fef2f2;
  color: #b42318;
  border: 1px solid #fecdca;
}

.bubble-text {
  white-space: pre-wrap;
}

/* 流式输出时的光标 */
.cursor {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--primary, #3b82f6);
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  to {
    visibility: hidden;
  }
}

/* 等待首包的三点动画 */
.bubble.typing {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 16px;
}

.bubble.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-secondary, #9aa4b2);
  animation: bounce 1.2s infinite ease-in-out;
}

.bubble.typing span:nth-child(2) {
  animation-delay: 0.15s;
}

.bubble.typing span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.msg-ops {
  display: flex;
  gap: 2px;
  margin-top: 4px;
}

.msg-ops :deep(.el-button) {
  color: var(--text-secondary, #8a94a6);
  font-size: 12px;
}

/* ---------- 参考来源（RAG 引用） ---------- */
.msg-sources {
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--el-fill-color-lighter, #fafafa);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  font-size: 12px;
  max-width: 640px;
}

.sources-head {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary, #8a94a6);
  margin-bottom: 4px;
}

.sources-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.sources-list li {
  display: flex;
  align-items: center;
  gap: 4px;
  line-height: 1.9;
  min-width: 0;
}

.source-index {
  color: var(--text-secondary, #8a94a6);
  flex: none;
}

.source-name {
  color: var(--primary, #3b82f6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}

.source-seq {
  color: var(--text-secondary, #8a94a6);
  flex: none;
}

/* ---------- Markdown 内容（v-html 渲染，需用 :deep 穿透） ---------- */
.markdown-body :deep(> *:first-child) {
  margin-top: 0;
}

.markdown-body :deep(> *:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-size: 15px;
  font-weight: 600;
  margin: 14px 0 8px;
}

.markdown-body :deep(p) {
  margin: 8px 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 20px;
  margin: 8px 0;
}

.markdown-body :deep(li) {
  margin: 4px 0;
}

.markdown-body :deep(code) {
  background: rgba(0, 0, 0, 0.06);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 13px;
}

.markdown-body :deep(pre) {
  background: #1f2430;
  color: #e6e6e6;
  border-radius: 8px;
  padding: 12px 14px;
  overflow-x: auto;
  margin: 10px 0;
}

.markdown-body :deep(pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--border, #d9dde3);
  padding-left: 10px;
  color: var(--text-secondary, #6b7684);
  margin: 8px 0;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 13px;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border, #e6e8eb);
  padding: 6px 10px;
}

.markdown-body :deep(a) {
  color: var(--primary, #3b82f6);
  text-decoration: underline;
}

/* ---------- 输入区 ---------- */
.chat-footer {
  flex: 0 0 auto;
  padding: 12px 24px 18px;
  border-top: 1px solid var(--border, #e6e8eb);
  background: #ffffff;
}

.input-box {
  border: 1px solid var(--border, #e6e8eb);
  border-radius: 12px;
  padding: 8px 10px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.input-box:focus-within {
  border-color: var(--primary, #3b82f6);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.input-box :deep(.el-textarea__inner) {
  border: none;
  box-shadow: none;
  padding: 4px 6px;
  font-size: 14px;
  line-height: 1.7;
  background: transparent;
}

.input-ops {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 2px 0;
}

.hint {
  font-size: 12px;
  color: var(--text-secondary, #9aa4b2);
}

.send-btn {
  border-radius: 8px;
}

/* 响应式：窄屏侧边栏浮层展示 */
@media (max-width: 900px) {
  .conv-sidebar {
    position: absolute;
    z-index: 20;
    height: 100%;
    box-shadow: 2px 0 12px rgba(0, 0, 0, 0.08);
  }
  .msg-main {
    max-width: 88%;
  }
}
</style>
