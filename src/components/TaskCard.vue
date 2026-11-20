<template>
  <div class="task-card">
    <div class="task-body">
      <span class="task-title">{{ task.title }}</span>
      <span class="task-description">{{ task.description }}</span>
    </div>
    <div class="task-actions">
      <span class="task-tag" :class="`tag-${task.priority}`">
        {{ priorityLabel }}
      </span>
      <el-button text size="small" @click="openDialog()">修改</el-button>
      <el-button text size="small" type="danger" @click="taskStore.deleteTask(task.id)">删除</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Task, TaskPriority } from '@/types'
import { useTaskStore } from '@/stores/task'
const taskStore = useTaskStore()

const props = defineProps<{
  task: Task
}>()

const emit = defineEmits<{
  (e: 'update-task', task: Task): void
}>()

const priorityLabel = computed(() => {
  const map: Record<TaskPriority, string> = {
    high: '高',
    medium: '中',
    low: '低'
  }
  return map[props.task.priority]
})

function openDialog() {
  emit('update-task', props.task)
}
</script>

<style scoped>
.task-card {
  background: var(--surface, #ffffff);
  padding: 12px 14px;
  border-radius: 10px;
  margin-bottom: 10px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  border: 1px solid var(--border, #e6e8eb);
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.18s, box-shadow 0.18s;
}

.task-card:hover {
  border-color: #c6d8fb;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.task-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.task-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #263238);
  line-height: 1.5;
}

.task-description {
  font-size: 12px;
  color: var(--text-secondary, #6b7684);
  line-height: 1.5;
}

.task-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 10px;
  border-radius: 10px;
  background: var(--el-fill-color-light, #f2f3f5);
  color: var(--text-secondary, #6b7684);
  flex-shrink: 0;
}

.tag-high {
  background: #fdeaea;
  color: #d54040;
}

.tag-medium {
  background: #fdf3e3;
  color: #c97a1a;
}

.tag-low {
  background: #e7f2fd;
  color: #2e7bba;
}
</style>
