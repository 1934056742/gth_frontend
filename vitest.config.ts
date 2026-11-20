import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

/**
 * 单元测试配置
 *
 * 独立于 vite.config.ts：
 *   - 测试用不到 Vue 插件，去掉可以显著加快启动；
 *   - 避免 Vite 构建配置的改动影响测试。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    // 纯逻辑测试，不需要浏览器环境
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: 'verbose',
    // 覆盖率：npm run test:coverage
    coverage: {
      provider: 'v8',
      include: ['src/utils/**/*.ts'],
      exclude: ['src/utils/**/*.test.ts', 'src/utils/hash.worker.ts', 'src/utils/hash.ts']
    }
  }
})
