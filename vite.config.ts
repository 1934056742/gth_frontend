import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // 读取当前环境(.env / .env.development / .env.production)的变量
  const env = loadEnv(mode, process.cwd(), '')
  // 开发代理目标：默认指向本地后端 3000 端口，可用 VITE_PROXY_TARGET 覆盖
  // 注意：默认值用 127.0.0.1 而不是 localhost —— Node 18+ 解析 localhost 时
  // 可能优先得到 ::1（IPv6），而后端只监听了 IPv4，就会出现
  // 「AggregateError [ECONNREFUSED]」导致登录等所有 /api 请求失败。
  // .env.development 里已有 VITE_PROXY_TARGET，这里保证没有该变量时也能正常代理。
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://127.0.0.1:3000'

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      port: 5177,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true
        },
        // 上传后的文件静态目录（下载 / 预览时直接访问）
        '/uploads': {
          target: proxyTarget,
          changeOrigin: true
        }
      }
    },
    // 单元测试配置（vitest 会读取这里的 test 字段）
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
      reporters: 'verbose'
    }
  }
})
