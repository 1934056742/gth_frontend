<template>
  <el-drawer
    v-model="visible"
    title="智能建议"
    direction="rtl"
    size="380px"
    :with-header="false"
    class="ai-drawer"
  >
    <div class="ai-drawer-rail">
      <div class="close-area">
        <el-button class="close-btn" @click="visible = false">✕ 关闭</el-button>
      </div>

    <h3 class="drawer-title">智能建议</h3>

      <div class="ai-suggestion-card">
        <div class="title">
          <span class="dot"></span> 分析中...
        </div>
        <p class="suggestion-text">
          当前有 <strong>{{ todoCount }}</strong> 个待办，其中
          <span class="high-text">高优先级</span> 任务 {{ highCount }} 个。
        </p>
        <div class="suggestion-box">
          建议优先处理：<br />
          <strong>{{ topSuggestion }}</strong>
        </div>
        <el-button
          type="primary"
          class="adopt-btn"
          @click="adoptSuggestion"
        >
          采纳建议
        </el-button>
      </div>

      <div class="ai-footer">
        基于 千问 / ChatGPT 生成
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useTaskStore } from '@/stores/task'

const taskStore = useTaskStore()

const visible = ref(false)

const todoCount = computed(() => taskStore.todoTasks.length)
const highCount = computed(() => taskStore.todoTasks.filter(t => t.priority === 'high').length)

const topSuggestion = computed(() => {
  const highTasks = taskStore.todoTasks.filter(t => t.priority === 'high')
  if (highTasks.length > 0) {
    return `"${highTasks[0].title}"`
  }
  if (taskStore.todoTasks.length > 0) {
    return `"${taskStore.todoTasks[0].title}"`
  }
  return '暂无待办任务，可以创建新任务'
})

function open() {
  visible.value = true
}

function adoptSuggestion() {
  ElMessage.success('已采纳建议，正在优先处理该任务')
  visible.value = false
}

defineExpose({ open })
</script>

<style scoped>
.ai-drawer-rail {
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: 100%;
}

.close-area {
  display: flex;
  justify-content: flex-end;
}

.close-btn {
  background: var(--el-fill-color-light, #f2f3f5);
  border: none;
  border-radius: 8px;
  font-size: 14px;
}

.drawer-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #263238);
  margin: 0;
}

.ai-suggestion-card {
  background: var(--el-fill-color-light, #f7f8fa);
  border-radius: 12px;
  padding: 20px;
  border: 1px solid var(--border, #e6e8eb);
}

.title {
  font-weight: 600;
  color: var(--text-primary, #263238);
  margin-bottom: 12px;
  display: flex;
  gap: 10px;
  align-items: center;
}

.dot {
  width: 8px;
  height: 8px;
  background: var(--primary, #3b82f6);
  border-radius: 50%;
  display: inline-block;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% { opacity: 0.4; }
  50% { opacity: 1; }
  100% { opacity: 0.4; }
}

.suggestion-text {
  color: var(--text-primary, #263238);
  font-size: 15px;
  line-height: 1.6;
}

.high-text {
  color: var(--danger, #d54040);
}

.suggestion-box {
  background: #eaf1fd;
  padding: 12px;
  border-radius: 8px;
  margin-top: 12px;
  border-left: 3px solid var(--primary, #3b82f6);
  font-size: 14px;
  line-height: 1.6;
}

.adopt-btn {
  width: 100%;
  margin-top: 16px;
  border-radius: 8px;
  font-weight: 600;
}

.ai-footer {
  font-size: 13px;
  color: var(--text-muted, #909aa6);
  text-align: center;
  margin-top: auto;
}
</style>
