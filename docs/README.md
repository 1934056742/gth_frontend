# 大文件上传模块（秒传 / 断点续传 / 流式哈希）

> 面向 **GB 级文件**设计的上传下载模块，全链路内存占用恒定。
> 167 个单元测试全绿（前端 116 + 后端 51），前后端类型检查零错误。

[![tests](https://img.shields.io/badge/tests-167%20passed-brightgreen)](#测试)
[![typescript](https://img.shields.io/badge/TypeScript-strict-blue)](#)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](#)

---

## 一句话说明

一个"朴素上传"在 2GB 文件、网络中断、重复上传、大文件下载这四个场景下都会崩。
这个模块逐条解决了它们，并补上了越权防护、磁盘回收和测试体系。

---

## 核心能力

| 能力 | 实现要点 | 关键取舍 |
|---|---|---|
| **秒传** | `SHA-256(文件名+大小+内容)` 作唯一键，按 `ownerId` 隔离 | 用 SHA-256 而非 MD5（抗碰撞）；拼文件名让"同内容不同名"不误判 |
| **流式哈希** | 自研增量 SHA-256 + Web Worker | 放弃 `crypto.subtle.digest`（要求全文件在内存），换取 GB 级支持 |
| **断点续传** | 服务端落盘分片 + 浏览器 localStorage，**取并集** | 双份记录增加复杂度，但换浏览器/清缓存/服务重启都能续 |
| **并发上传** | 共享游标并发池（默认 3，可调 1~6） | 受 HTTP/1.1 六连接限制，留余量给其他请求 |
| **分片重试** | 指数退避 300/600/1200ms，区分错误类型 | 401/取消不重试，避免无意义请求 |
| **分片合并** | `pipeline` 串行写入 + 临时文件 + 原子 `rename` | 放弃手写 `pipe`+`drain`（有死锁风险） |
| **流式下载** | `fetch` + `getReader()` + File System Access API | `<a download>` 无法携带 token |
| **Range 下载** | RFC 7233 单段解析，206/416 完整支持 | 不支持多段，降级为 200（规范允许） |
| **越权防护** | `chunk-owners.json` 记录分片目录归属 | 独立文件 O(1) 查表，避免遍历 |
| **磁盘回收** | 24h TTL 定时清理僵尸分片 | 取 `max(mtime, lastActiveAt)` 防误删 |

---

## 目录结构

```
frontend/
├── src/
│   ├── utils/
│   │   ├── sha256.ts           # 增量 SHA-256（零依赖，可单测）
│   │   ├── sha256.test.ts      # 37 个用例
│   │   ├── hash.worker.ts      # Worker：分块读文件
│   │   ├── hash.ts             # Worker 的 Promise 封装
│   │   ├── uploadManager.ts    # 调度引擎（核心）
│   │   ├── uploadManager.test.ts  # 26 个用例
│   │   └── ...
│   ├── api/upload.ts           # 接口 + 流式下载
│   ├── api/ai.ts               # AI 流式问答（SSE 解析 + 打字机缓冲接入）
│   └── views/FileUpload.vue    # 页面
├── vitest.config.ts
└── docs/
    ├── UPLOAD_MODULE.md        # 架构与设计说明
    ├── MODULE_GUIDE.md         # 精读手册（逐行讲解）
    ├── INTERVIEW_QA.md         # 30 个面试追问
    └── TESTING.md              # 测试清单

backend/
└── src/
    ├── upload.ts               # 服务端（核心）
    ├── range.ts                # Range 解析（纯函数）
    ├── range.test.ts           # 15 个用例
    ├── auth.ts                 # JWT 鉴权（JWT_SECRET 统一出口）
    └── ai.ts                   # AI 流式问答（SSE 转发）
```

---

## 快速开始

```bash
# 后端
cd backend
npm install
npm run dev            # http://localhost:3000

# 前端
cd frontend
npm install
npm run dev            # http://localhost:5177
```

打开 `http://localhost:5177/file-upload`（路由用的是 history 模式，地址里没有 `#`），登录后拖入文件即可。

---

## 测试

```bash
cd frontend && npm test      # 116 个用例（Vitest）
cd backend  && npm test      # 51 个用例（node:test）
```

```
✓ src/utils/sha256.test.ts        (37 tests)
✓ src/utils/uploadManager.test.ts (26 tests)
✓ src/utils/permission.test.ts    (23 tests)
✓ src/api/ai.test.ts              (11 tests)
✓ src/utils/typewriter.test.ts    (10 tests)
✓ src/utils/markdown.test.ts       (9 tests)

Test Files  6 passed (6)
     Tests  116 passed (116)
```

后端（`node --test`）：

```
# tests 51
# pass 51
# fail 0
```

详见 [TESTING.md](./docs/TESTING.md)。

---

## 技术亮点（面试可讲）

### 1. 自己写增量 SHA-256，并修了一个 padding bug

`crypto.subtle.digest()` 要求完整 `ArrayBuffer`，10GB 文件直接 OOM。
自研实现支持任意次、任意长度的 `update()`，内存占用 = 单块 4MB。

期间发现：`digest()` 里 padding 已含残留数据，却没清空 `bufferLength`，
导致 `consume()` 把残留数据拼了两次，**所有非空输入全部算错**。
排查过程、根因、修复方式详见 [MODULE_GUIDE.md §2.5](./docs/MODULE_GUIDE.md)。

### 2. 断点信息取并集（单测发现的真实 bug）

代码注释写着"合并本地记录与服务端分片"，但实现只合并了服务端。
测试用例「本地有 [0]、服务端有 [1]，应只传 [2,3,4]」直接暴露它。

### 3. 填了三个安全/运维缺口

| 缺口 | 后果 | 修复 |
|---|---|---|
| 分片目录无归属校验 | 他人可污染/窃取半成品 | `chunk-owners.json` + 403 |
| 僵尸分片无回收 | 磁盘无限膨胀 | 24h TTL 定时清理 |
| 并发池 O(n² log n) | 10 万片时掉帧 | `Set` 增量维护 |

### 4. 测试是照着代码分支设计的

哈希测试的输入尺寸（55/56/63/64/65 字节）不是随机选的，
每个对应一段代码分支——这说明测试者读过实现，而不是机械追求覆盖率。

---

## 文档

| 文档 | 内容 | 适合谁 |
|---|---|---|
| [UPLOAD_MODULE.md](./docs/UPLOAD_MODULE.md) | 架构、设计决策、时序图、接口清单；第 9 节：阿里云 OSS 直传（STS 凭证、双通道、兼容性） | 想快速了解全貌 |
| [MODULE_GUIDE.md](./docs/MODULE_GUIDE.md) | 逐文件逐函数精读，含 bug 排查过程 | 想彻底吃透代码 |
| [INTERVIEW_QA.md](./docs/INTERVIEW_QA.md) | 30 个追问 + 标准答法 + 白板题 | 准备面试（上传模块） |
| [AI_MODULE_GUIDE.md](./docs/AI_MODULE_GUIDE.md) | AI 对话 + RAG 知识库精读：链路、BM25、SSE、防幻觉、12 个追问 | 想讲清楚 AI 模块 |
| [INTERVIEW_PREP.md](./docs/INTERVIEW_PREP.md) | 3 天复习冲刺计划：跑通链路、画时序图、杀手锏问答、其余模块话术 | 面试前系统复习 |
| [TESTING.md](./docs/TESTING.md) | 用例清单 + 设计思路 | 评估测试质量 |

---

## 已知限制

诚实列出，也是"下一步做什么"：

- 大文件哈希纯 JS 约 100~200MB/s（WASM 可优化到 5 倍）
- Firefox 下载需拼 Blob（内存 = 文件大小）
- 刷新后需重新选文件（浏览器安全限制；Chrome 可用 `FileSystemFileHandle` 解决）
- `files.json` 并发写有竞态风险（应换 SQLite）
- 缺少集成测试与 E2E 测试

---

## License

MIT
