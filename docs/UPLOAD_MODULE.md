# 大文件上传模块 · 架构与设计说明

> 秒传 · 断点续传 · 流式哈希 · 分片合并 · Range 下载
>
> 面向 GB 级文件设计，全链路内存占用恒定，不依赖任何上传组件库或对象存储 SDK。

---

## 1. 为什么需要单独设计

一个"选择文件 → POST"的朴素上传，在下面任何一个场景都会崩掉：

| 场景 | 朴素实现的问题 |
|---|---|
| 2GB 文件 | `FormData` 一次性读取全部内容，浏览器内存爆掉 / 请求超时 |
| 网络中断 | 进度归零，必须从头再传 |
| 用户传过同一个文件 | 重复占用带宽和磁盘 |
| 计算文件哈希做去重 | `crypto.subtle.digest()` 要求整个文件在内存里 |
| 下载 2GB 文件 | `await res.blob()` 把整个文件读进内存 |
| 下载中断 | 无法续传，只能重下 |
| 上传中断后放弃 | 服务端分片永久占盘 |

这个模块逐条解决了上述问题，每条都对应下面的一个设计点。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                         浏览器端                              │
│                                                              │
│  FileUpload.vue (UI)                                         │
│        │  addFiles()                                         │
│        ▼                                                     │
│  uploadManager.ts (调度引擎)                                  │
│        │                                                     │
│        ├──► hash.worker.ts (Web Worker)                      │
│        │        └──► sha256.ts (增量 SHA-256)                │
│        │                                                     │
│        ├──► POST /api/upload/check   → 秒传 / 已有分片        │
│        ├──► POST /api/upload/chunk   → 并发上传 + 重试        │
│        └──► localStorage             → 断点记录               │
│                                                              │
│  downloadFile() ──► fetch + stream ──► File System Access API │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         服务端                                │
│                                                              │
│  upload.ts                                                   │
│    ├── /check    归属认领 + 返回已有分片                       │
│    ├── /chunk    落盘 uploads/chunks/<hash>/<index>          │
│    ├── /merge    分片按序拼接 + 大小校验 + 原子替换            │
│    └── /download Range 流式传输 (206/416)                    │
│                                                              │
│  range.ts        Range 头解析（纯函数，可单测）                │
│  cleanup        僵尸分片定时回收                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 核心设计决策

### 3.1 文件唯一标识：`SHA-256(文件名 + 大小 + 内容)`

**为什么不用纯内容哈希？**
同内容但不同名的文件，在业务上是两个文件（用户期望看到两个条目）。加上文件名后：
- 同内容不同名 → 视为不同文件，各存一份（符合用户直觉）；
- 同名同内容 → 秒传命中；
- 内容改了 → 哈希完全不同，不会误判。

**为什么用 SHA-256 而不是 MD5？**
- MD5 已被证明存在实际碰撞攻击（2004 年王小云），用于"是否同一文件"这种判断，碰撞意味着**不同文件被误判为相同**，是数据安全问题；
- SHA-256 目前无实用攻击，碰撞空间 2^128，工程上足够。

**代价与取舍：**
SHA-256 比 MD5 慢。10GB 文件在普通笔记本上约需 30~60 秒（用 WASM 实现可降到 10 秒左右）。
取舍点：**只在首次上传时计算**，结果写入 localStorage，续传时直接复用，不重复算。

### 3.2 为什么自己实现增量 SHA-256

`crypto.subtle.digest('SHA-256', buffer)` 的参数必须是一个完整的 `ArrayBuffer`。

```ts
// 无法分块：必须先把 2GB 全读进内存
const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
```

自己实现的 `Sha256` 类提供 `update(chunk)` 接口：

```ts
const hasher = new Sha256()
for (let offset = 0; offset < file.size; offset += CHUNK) {
  const chunk = await file.slice(offset, offset + CHUNK).arrayBuffer()
  hasher.update(new Uint8Array(chunk))   // 内存占用 = CHUNK
}
const hash = toHex(hasher.digest())
```

**内存占用 = 单块大小（4MB），与文件大小无关。**

**踩过的坑（重要）：**
`digest()` 里要补 `0x80 + 0x00... + 8字节长度`。如果残留字节数 ≥ 56，需要补满**两个** 64 字节块。
最初的实现把"buffer 里的残留数据"先拼进 padding 数组，却**没有清空 `bufferLength`**，导致 `consume(padding)` 又把残留数据拼了一次 → 所有非空输入全部算错，只有空输入恰好正确。
修复方式：`this.bufferLength = 0` 后再 `consume(padding)`。
现在这个场景有专门的回归测试（`sha256.test.ts` → "padding 重复消费的 bug"）。

### 3.3 为什么放 Web Worker

哈希是**纯 CPU 密集**操作。在主线程跑 2GB 文件，页面会冻结几十秒——进度条不动、按钮点不了、用户以为卡死了。


### 3.4 分片策略

| 参数 | 默认值 | 为什么 |
|---|---|---|
| 分片大小 | 5MB（可选 1/5/10/20/50MB） | 太小 → 请求数爆炸（2GB/1MB = 2048 个请求）；太大 → 单片失败重传代价高、断点粒度粗 |
| 并发数 | 3（可调 1~6） | HTTP/1.1 同域最多 6 连接，留余地给其他请求；HTTP/2 可调高 |
| 重试次数 | 3 次，退避 300/600/1200ms | 大文件分片多，偶发抖动不应让整个任务失败 |

**并发池实现（游标模式）：**

```ts
let cursor = 0
const worker = async () => {
  while (runtime.running && cursor < pending.length) {
    const index = pending[cursor]   // 同步取出
    cursor += 1                     // 同步自增
    await uploadChunk(index)        // 异步上传
  }
}
await Promise.all(Array.from({ length: workers }, () => worker()))
```

`cursor` 的读取与自增之间没有 `await`，JS 单线程保证不会被打断，因此**两个 worker 不可能拿到同一个分片**。
这也是不需要互斥锁的原因（单线程模型的优势）。

### 3.5 断点续传的两层记录

断点信息存在于**两个地方**，启动时取并集：

| 位置 | 记录什么 | 为什么需要 |
|---|---|---|
| 服务端 `uploads/chunks/<hash>/<index>` | 实际落盘的分片 | 换浏览器 / 清缓存后仍能续传；以磁盘为准最可靠 |
| 浏览器 `localStorage.upload_records_v1` | `{fileKey, fileHash, uploadedChunks}` | 服务端不可用时也能续传；缓存 fileHash 避免重算 |

**取并集的原因：** 两边都可能比对方新。
- 本地更全：刚传完一片、`check` 请求还没到；
- 服务端更全：用户换了浏览器，本地记录是空的。

```ts
const localChunks = records[task.fileKey]?.uploadedChunks || []
localChunks.forEach((i) => runtime.doneChunks.add(i))
serverChunks.forEach((i) => runtime.doneChunks.add(i))
```

> 这个 bug 是写单测时发现的：注释写着"合并本地记录与服务端分片"，但代码只合并了服务端。

**刷新页面后为什么要重新选文件？**
浏览器出于安全限制，无法通过路径重新拿到 `File` 对象。所以刷新后只能展示"已暂停"的占位卡片，用户重新选择同一文件（校验名称+大小一致）后才能继续。

### 3.6 `uploadedChunks` 用 Set 增量维护

最初是：

```ts
task.uploadedChunks = [...task.uploadedChunks, index].sort((a, b) => a - b)  // O(n log n)
```

每传一片就重建+排序整个数组。2GB 文件 / 5MB 分片 = 400 片，最后一片要复制 399 个元素再排序。
500GB 文件 = 10 万片，这一步是 **O(n² log n)**，会明显掉帧。

改为 `runtime.doneChunks: Set<number>`，`add` 是 O(1)；只在渲染时（`updateProgress`）才转成排序数组。

### 3.7 合并：`pipeline` + 原子替换

```ts
const tmpPath = target + '.merging'
const out = createWriteStream(tmpPath)
for (let i = 0; i < totalChunks; i++) {
  await pipeline(createReadStream(chunkFile(hash, i)), out, { end: false })
}
await new Promise((r) => out.end(r))
await fs.rename(tmpPath, target)   // 原子替换
```

**三个关键点：**

1. **`pipeline` 替代手写 `pipe` + `drain`**
   手写需要监听 `'drain'` 事件并处理背压，一旦事件时序错乱（比如上一轮的 drain 还没触发就写下一片）就会丢数据。`pipeline` 内部封装了背压、错误传播、资源清理，`{ end: false }` 让多个源共用一个输出流。

2. **先写临时文件再 `rename`**
   `rename` 在同分区上是**原子操作**。如果边合并边写最终路径，用户可能下载到"合并到一半"的文件。写入临时文件 + rename 保证：要么没有，要么完整。

3. **合并后校验总大小**
   防止分片缺失/截断导致文件损坏。

### 3.8 越权防护：分片目录归属

**漏洞：** 分片目录以 `fileHash` 命名，而 hash 等于内容摘要——可以被推算/泄漏。没有归属校验时：
1. 攻击者拿到别人的 hash，就能往里写伪造分片，**污染对方正在合并的文件**；
2. 直接调 `/merge`，把别人的半成品**合并成自己的文件**。

**修复：** 独立的 `chunk-owners.json` 记录 `{hash: ownerId}`。

```
首次 /check 或 /chunk  → 认领归属（写入 ownerId）
后续请求               → 校验 ownerId，不匹配返回 403
合并完成 / 目录清理     → 释放归属记录
```

选独立文件而非塞进 `files.json`，是为了不必每次校验都遍历整个分片目录。

### 3.9 僵尸分片回收

分片是"边传边落盘"的中间产物。用户传一半关页面、或彻底放弃，这些分片永远不会被合并，却一直占磁盘。GB 级场景下几个残留就能吃掉大量空间。

**策略：**

| 项 | 值 | 说明 |
|---|---|---|
| TTL | 24 小时 | `UPLOAD_ORPHAN_TTL_MS` 可调 |
| 检查间隔 | 1 小时 | `UPLOAD_CLEANUP_INTERVAL_MS` 可调 |
| 判定依据 | `max(目录 mtime, 内存 lastActiveAt)` | 取最近的时间，避免误删正在上传的目录 |

用 `timer.unref()` 让定时器不阻塞进程退出。同时暴露 `POST /api/upload/cleanup` 支持手动触发（运维用）。


### 3.10 流式下载

```ts
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
const reader = res.body.getReader()
const writable = await handle.createWritable()   // File System Access API
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  await writable.write(value)   // 边下边写盘
}
await writable.close()
```

**为什么不直接 `<a href download>`？**
下载接口需要鉴权（`Authorization` 头），`<a>` 标签无法携带自定义头。

**三级兜底：**

| 环境 | 方案 | 内存占用 |
|---|---|---|
| Chrome / Edge | File System Access API 流式写盘 | 恒定（单块） |
| Firefox / Safari | 分块读入 → 拼 Blob → `URL.createObjectURL` | 等于文件大小 |
| 不支持 `body` | 报错提示 | — |

### 3.11 HTTP Range 支持（`range.ts`）

服务端实现完整的单段 Range 解析，遵循 RFC 7233：

| 请求 | 结果 |
|---|---|
| 无 Range / 格式非法 | 200，完整文件 |
| `bytes=0-99` | 206，`Content-Range: bytes 0-99/1000` |
| `bytes=900-` | 206，900 到末尾 |
| `bytes=-100` | 206，最后 100 字节 |
| `bytes=900-99999` | 206，end 截断到 999（**不报错**） |
| `bytes=1000-1099` | 416，`Content-Range: bytes */1000` |
| `bytes=500-100` | 416（start > end） |

**为什么 start 越界返回 416 而不是空 200？**
RFC 7233 规定 416 让客户端明确知道"这个范围不存在"，可以据此判断文件大小变化（比如下载中文件被替换）。

**为什么多段 Range 直接降级为 200？**
`multipart/byteranges` 需要生成 boundary、拼接多段头，实现复杂；浏览器和下载工具几乎只用单段。RFC 允许服务端忽略 Range，返回全量。

### 3.12 中文文件名

```ts
const encodedName = encodeURIComponent(downloadName)
const asciiName = downloadName.replace(/[^\x20-\x7e]/g, '_')
res.setHeader('Content-Disposition',
  `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`)
```

`filename=` 给老客户端兜底（非 ASCII 替换为 `_`），`filename*=UTF-8''` 才是 RFC 5987 标准的正确写法。两个都给，兼容性最好。

### 3.13 平滑速度估算

最初用"全程平均速度"：`sessionLoaded / (now - sessionStart)`。
问题：传了 10 分钟后速度值会**钝化**——网络突然变慢，显示的速度还要几分钟才降下来。

改为**滑动窗口**：保留最近 5 个采样点（每 500ms 一个），用窗口内增量计算：

```ts
runtime.samples.push({ time: now, loaded: sessionLoaded })
if (runtime.samples.length > 5) runtime.samples.shift()
const speed = (sessionLoaded - samples[0].loaded) / ((now - samples[0].time) / 1000)
```

窗口小 → 跟得上真实波动；窗口不至于只有一个点 → 不会剧烈抖动。

### 3.14 可观测性

每个任务结束时输出各阶段耗时：

```ts
{ fileName, fileSize, totalChunks, instant,
  hash: 1234,      // 算哈希耗时
  check: 12,       // 校验耗时
  upload: 45000,   // 传输耗时
  total: 46300,
  throughput: 2330100 }  // 字节/秒
}
```

大文件上传出问题时，能一眼判断瓶颈在**算哈希**、**校验**还是**网络**。`timingHistory` 保留最近 50 条，供控制台查看。

---

## 4. 完整时序

### 4.1 首次上传

```
前端                      Worker                    服务端
 │                          │                         │
 ├─ addFiles() ────────────►│                         │
 │                          │ 分块读 4MB              │
 │◄── progress (0~10%) ─────┤                         │
 │◄── done(hash) ───────────┤                         │
 │                          │                         │
 ├─ POST /check {hash,...} ──────────────────────────►│
 │                          │            认领分片目录归属
 │◄───── {exists:false, uploadedChunks:[]} ───────────┤
 │                                                    │
 ├─ POST /chunk [0] (3 并发) ────────────────────────►│ 落盘
 ├─ POST /chunk [1] ─────────────────────────────────►│ 落盘
 ├─ POST /chunk [2] ─────────────────────────────────►│ 落盘
 │        ↑ 每片成功 → localStorage 记录               │
 │                          │                         │
 ├─ POST /chunk [n] (最后一片) ──────────────────────►│
 │                          │        received.size 达标
 │                          │        合并 → 原子 rename
 │◄───── {merged:true, url} ──────────────────────────┤
 │  status = done, 清 localStorage                     │
```

### 4.2 中断后刷新续传

```
浏览器重启
 │
 ├─ restoreTasks() 读 localStorage → 生成"已暂停"占位卡片
 │
 ├─ 用户重新选择同一文件 (名称+大小 校验通过)
 │
 ├─ resumeByFile() → 复用缓存的 fileHash，跳过哈希计算
 │
 ├─ POST /check → 服务端返回磁盘上已有分片 [0,1,2,5]
 │
 ├─ 与本地记录取并集 → doneChunks = {0,1,2,5}
 │
 └─ 只上传 {3,4,6,7,...}
```

---

## 5. 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload/check` | 秒传校验 + 返回已有分片（会认领归属） |
| POST | `/api/upload/chunk` | 上传单片（multipart），全部到齐自动合并 |
| POST | `/api/upload/merge` | 手动合并（服务端未自动合并时兜底） |
| GET | `/api/upload/files` | 当前用户的文件列表（返回裸数组） |
| GET | `/api/upload/files/:id/download` | 下载，支持 Range，需鉴权 |
| DELETE | `/api/upload/files/:id` | 删除，仅自己的文件 |
| POST | `/api/upload/cleanup` | 手动触发僵尸分片清理 |

**注意：** `/check` 是 **POST**（body 传 JSON），不是 GET + query。
`/files` 返回的是**裸数组** `[{...}]`，不是 `{files: [...]}`。

---

## 6. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `UPLOAD_MAX_CHUNK_SIZE` | 64MB | 单分片上限 |
| `UPLOAD_ORPHAN_TTL_MS` | 24h | 僵尸分片存活时间 |
| `UPLOAD_CLEANUP_INTERVAL_MS` | 1h | 清理任务间隔 |
| `UPLOAD_STATIC_OPEN` | false | 是否暴露静态目录（调试用，生产勿开） |

---

## 7. 测试

```bash
# 前端（Vitest，60 个用例）
cd frontend && npm test

# 后端（node:test，15 个用例）
cd backend && npm test
```

覆盖范围见 [`TESTING.md`](./TESTING.md)。

---

## 8. 已知限制与后续可做

| 限制 | 说明 | 改进方向 |
|---|---|---|
| 大文件哈希慢 | 纯 JS 约 100~200MB/s（10GB 需 30~60s） | 编译 WASM 版本，或用 `crypto.subtle` 分块 + 并行（需改算法） |
| Firefox 下载占内存 | 无 File System Access API，需拼 Blob | Service Worker 代理下载 / 分片下载 |
| 断点需重新选文件 | 浏览器安全限制无法持久化 File | Chrome 可用 `showOpenFilePicker` 存 `FileSystemFileHandle` 到 IndexedDB |
| 元数据存 JSON 文件 | 并发写有竞态风险 | 换 SQLite / 数据库 |
| 无跨域分片直传 | 所有分片走应用服务器 | 换对象存储 + 预签名 URL 直传 |
| 合并全量串行读 | GB 级合并耗时较长 | 预分配 + 并行写不同区间（`fs.write` 带 position） |

Worker 里跑，主线程全程可交互，只通过 `postMessage` 回传进度（每 4MB 一次）。
