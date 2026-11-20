<template>
  <div class="column" :class="`col-${status}`">
    <div class="column-header">
      <span>{{ title }}</span>
      <span class="count-badge">{{ tasks.length }}</span>
    </div>

    <div class="column-body">
      <TaskCard
        v-for="task in tasks"
        :key="task.id"
        :task="task"
        @update-task="updateTask"
      />
      <el-empty
        v-if="tasks.length === 0"
        description="暂无任务"
        :image-size="60"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Task, TaskStatus } from '@/types'
import TaskCard from './TaskCard.vue'

defineProps<{
  title: string
  status: TaskStatus
  tasks: Task[]
}>()

const emit = defineEmits<{
  (e: 'update-task', task: Task): void
}>()

function updateTask(task: Task) {
  emit('update-task', task)
}
</script>

<style scoped>
.column {
  background: var(--surface, #ffffff);
  border-radius: 12px;
  padding: 14px;
  border: 1px solid var(--border, #e6e8eb);
  min-height: 200px;
  display: flex;
  flex-direction: column;
}

.column-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 2px 10px 2px;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary, #263238);
  border-bottom: 2px solid var(--border, #e6e8eb);
}

.col-todo .column-header {
  border-bottom-color: #d8dce1;
}

.col-doing .column-header {
  border-bottom-color: #3b82f6;
}

.col-done .column-header {
  border-bottom-color: #22a06b;
}

.count-badge {
  background: var(--el-fill-color-light, #f2f3f5);
  padding: 1px 9px;
  border-radius: 10px;
  font-size: 12px;
  color: var(--text-secondary, #6b7684);
}

.column-body {
  flex: 1;
  padding-top: 12px;
}
</style>
