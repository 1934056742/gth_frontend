<template>
  <div class="system-setting">
    <el-card shadow="never">
      <template #header>
        <span>系统设置</span>
      </template>
      <el-empty description="系统设置功能开发中" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
</script>

<style scoped>
.system-setting {
  padding: 24px;
}
.system-setting :deep(.el-card) {
  border-radius: 12px;
  border: 1px solid var(--border, #e6e8eb);
}
</style>
