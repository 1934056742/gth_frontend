<template>
  <!-- AI 答疑独立页面：左侧历史会话 + 右侧流式对话，具体逻辑全在 AiChatPanel 里 -->
  <div class="ai-chat-view">
    <AiChatPanel />
  </div>
</template>

<script setup lang="ts">
import AiChatPanel from '@/components/AiChatPanel.vue'
</script>

<style scoped>
.ai-chat-view {
  height: 100%;
  padding: 20px 24px;
  box-sizing: border-box;
  background: var(--app-bg, #f5f6f8);
}
</style>
