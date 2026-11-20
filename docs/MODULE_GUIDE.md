# 大文件上传模块 · 精读手册

> 目标：读完后能**不看代码、在白板上画出全流程**，并解释每一行为什么这么写。

---

## 0. 五分钟速记版

面试时先说这段，再展开细节：

> 我做了一个面向 GB 级文件的上传模块，核心是四件事：
>
> **第一，文件标识**。用 `SHA-256(文件名 + 大小 + 内容)` 作为全局唯一键，同名同内容的文件第二次上传直接秒传。
>
> **第二，流式哈希**。`crypto.subtle.digest()` 必须把整个文件读进内存，2GB 就崩了。所以我自己实现了增量 SHA-256，放在 Web Worker 里跑，每 4MB update 一次，内存占用恒定。
>
> **第三，分片 + 断点续传**。5MB 分片、3 并发、每片失败重试 3 次（指数退避）。断点信息存在两个地方：服务端磁盘上的分片文件，和浏览器 localStorage。启动时取并集，保证换浏览器、清缓存、服务端重启都能续。
>
> **第四，服务端合并 + 流式下载**。合并用 `pipeline` 串行写入临时文件，再 `rename` 原子替换，避免用户下到半成品。下载支持 HTTP Range，前端用 `fetch` + `getReader()` 边下边写盘。
>
> 另外做了三个防御：分片目录归属校验（防越权）、僵尸分片定时回收、以及全套单元测试（75 个用例）。

---

## 1. 文件地图

| 文件 | 行数 | 职责 | 精读优先级 |
|---|---|---|---|
| `frontend/src/utils/sha256.ts` | ~180 | 增量 SHA-256 算法 | ★★★ 必读 |
| `frontend/src/utils/hash.worker.ts` | ~50 | Worker 里分块读文件 | ★★★ 必读 |
| `frontend/src/utils/hash.ts` | ~70 | Worker 的 Promise 封装 | ★★ |
| `frontend/src/utils/uploadManager.ts` | ~500 | **调度引擎（核心）** | ★★★ 必读 |
| `frontend/src/api/upload.ts` | ~130 | API + 流式下载 | ★★★ 必读 |
| `frontend/src/views/FileUpload.vue` | ~570 | 页面 | ★ |
| `backend/src/upload.ts` | ~730 | **服务端（核心）** | ★★★ 必读 |
| `backend/src/range.ts` | ~65 | Range 解析 | ★★ |

---

## 2. `sha256.ts` —— 增量哈希

### 2.1 要解决的问题

```ts
// 浏览器原生 API：必须一次性给完整数据
crypto.subtle.digest('SHA-256', arrayBuffer)
```

10GB 文件 → 需要 10GB 连续内存 → 必然崩溃。

### 2.2 核心数据结构

```ts
class Sha256 {
  private h = new Uint32Array([0x6a09e667, ...])  // 8 个 32 位状态字
  private buffer = new Uint8Array(64)             // 凑不满一块的残留
  private bufferLength = 0                        // 残留了多少字节
  private bytesHashed = 0                         // 累计处理了多少字节（用于填长度）
  private w = new Uint32Array(64)                 // 消息扩展数组（复用，减少 GC）
}
```

**为什么 `buffer` 是 64 字节？**
SHA-256 的压缩函数一次处理 **512 bit = 64 字节**。`update()` 的数据长度任意，所以需要把"不满 64 字节的尾巴"暂存，等下次数据来了拼满再压缩。

**为什么 `w` 放在实例上而不是函数内？**
每处理一个块都要一个 64 元素临时数组。10GB / 64B = 1.6 亿个块，每块新建数组 → 1.6 亿次内存分配 → GC 疯狂触发。复用同一个数组，分配次数从 1.6 亿降到 1。

### 2.3 `update` → `consume` 的三个分支

```ts
private consume(chunk: Uint8Array) {
  let offset = 0

  // 分支 A：先补齐上次的残留
  if (this.bufferLength > 0) {
    const need = 64 - this.bufferLength          // 还差多少
    const take = Math.min(need, chunk.length)    // 这次能给多少
    this.buffer.set(chunk.subarray(0, take), this.bufferLength)
    this.bufferLength += take
    offset += take
    if (this.bufferLength === 64) {              // 刚好拼满 → 压缩
      this.block(this.buffer, 0)
      this.bufferLength = 0
    }
  }

  // 分支 B：剩下的整块直接在原数组上压缩，不复制
  while (offset + 64 <= chunk.length) {
    this.block(chunk, offset)
    offset += 64
  }

  // 分支 C：最后的尾巴留到下次
  if (offset < chunk.length) {
    this.buffer.set(chunk.subarray(offset), 0)
    this.bufferLength = chunk.length - offset
  }
}
```

**关键设计：分支 B 不复制数据。**
如果每次都 `buffer.set(chunk)` 再 `block(buffer)`，10GB 文件要额外复制 10GB 数据。直接在原数组上按 `offset` 读，零拷贝。

### 2.4 `digest` 的填充（最容易写错的地方）

SHA-256 规定消息末尾必须补：
1. 一个 `0x80` 字节
2. 若干个 `0x00` 字节
3. 8 字节的**原始消息比特长度**（大端）

使总长度 ≡ 0 (mod 64)。

```
残留 bufferLength = L

情况 1：L < 56
  [L 字节数据] [0x80] [0x00 × (55-L)] [8 字节长度]
  └────────────── 共 64 字节 ──────────────┘

情况 2：L >= 56
  [L 字节数据] [0x80] [0x00 × (119-L)] [8 字节长度]
  └────────────────── 共 128 字节 ──────────────────┘
```

**为什么分界是 56？**

### 2.5 ⚠️ 那个 bug（一定要会讲）

```ts
digest() {
  const padding = new Uint8Array(padLength)
  padding.set(this.buffer.subarray(0, this.bufferLength), 0)  // ← 残留数据已进来
  padding[this.bufferLength] = 0x80
  // ...写入长度

  this.consume(padding)   // ❌ 此时 bufferLength 还是 L！
}
```

`consume` 的第一步是"把 `buffer` 的残留拼到 `chunk` 前面"。但 `padding` **已经包含**了残留数据，于是残留被拼了两次：

```
正确：  [数据L][0x80][0x00...][长度]
实际：  [数据L][数据L][0x80][0x00...]   ← 数据重复
```

**为什么只有空输入正确？** `bufferLength === 0` 时，`padding.set(buffer.subarray(0, 0))` 什么也没做，`consume` 的补齐分支也被跳过，恰好正确。

**修复：**
```ts
this.bufferLength = 0   // ← 关键一行
this.consume(padding)
```

**如何定位的（排查过程也很值钱）：**
1. 发现 `""` 通过、`"abc"` 失败 → 问题与"有残留数据"相关；
2. 用逐字节 update 测试，`1 字节`输入失败、`0 字节`通过 → 缩小到残留缓冲区；
3. 检查 `digest` 里传给 `consume` 的 `padding`，发现它与 `buffer` 内容重叠。

---

## 3. `hash.worker.ts` —— 为什么放 Worker

```ts
ctx.onmessage = async (event) => {
  const { file, chunkSize } = event.data
  const step = Math.max(chunkSize || 4 * 1024 * 1024, 1024 * 1024)

  const hasher = new Sha256()
  hasher.update(new TextEncoder().encode(`${file.name}-${file.size}-`))

  let offset = 0
  while (offset < file.size) {
    const end = Math.min(offset + step, file.size)
    const buffer = await file.slice(offset, end).arrayBuffer()
    hasher.update(new Uint8Array(buffer))
    offset = end
    ctx.postMessage({ type: 'progress', loaded: offset })
    await new Promise((r) => setTimeout(r, 0))   // ← 让出事件循环
  }

  ctx.postMessage({ type: 'done', hash: toHex(hasher.digest()) })
}
```

| 设计 | 原因 |
|---|---|
| 放 Worker | 哈希是纯 CPU 操作，主线程跑 2GB 会冻结几十秒 |
| `file.slice().arrayBuffer()` | 只读一块，内存 = 4MB，与文件大小无关 |
| `setTimeout(0)` 让出 | 不阻塞 Worker 自己的消息队列，用户点"暂停"时能及时响应 |

**`postMessage({ file })` 会复制整个文件吗？**
不会。`File` 是 `Blob` 的子类，结构化克隆算法**按引用传递**（底层是共享的文件句柄），不复制内容。这也是为什么直接把 `File` 传给 Worker 是安全的。

---

## 4. `uploadManager.ts` —— 调度引擎

### 4.1 两层数据结构

```ts
// 第一层：响应式，页面直接绑定
const tasks = reactive<UploadTask[]>([])

// 第二层：非响应式，纯运行时控制
const runtimes = new Map<string, TaskRuntime>()
```

**为什么要分两层？**
`AbortController`、`Set`、计时器句柄**不需要也不应该响应式**：
- 放进 `reactive` 会被深度代理，每次访问都有代理开销；
- 更重要的是，代理 `AbortController` 可能破坏其内部状态（`this` 绑定问题）。

页面只关心 `progress / status / speed`，所以只有这些放 `reactive`。

### 4.2 完整执行流程

```ts
async function startTask(task: UploadTask) {
  const runtime = getRuntime(task.uid)
  if (runtime.running) return                    // 防重入
  runtime.running = true
  runtime.controller = new AbortController()

  // ── 阶段 1：算哈希（0~10% 进度）
  let fileHash = runtime.fileHash || records[task.fileKey]?.fileHash
  if (!fileHash) {
    fileHash = await calculateFileHash(task.file, (p) => {
      task.progress = Math.min((p.loaded / p.total) * 10, 10)
    })
    runtime.fileHash = fileHash
  }

  // ── 阶段 2：秒传 / 续传校验
  task.status = 'checking'
  const { exists, uploadedChunks } = await checkFile({ fileHash, ... })
  if (exists) {                                  // 秒传命中
    task.instant = true; task.status = 'done'; return
  }

  // ── 阶段 3：并发上传（10~100% 进度）
  task.status = 'uploading'
  await uploadPendingChunks(task, fileHash)

  // ── 阶段 4：完成
  task.status = 'done'
  removeRecord(task.fileKey)
}
```

**为什么要分阶段设置 `task.progress`？**
哈希和上传共用同一个 `progress` 字段。哈希占 0~10%，上传占 10~100%，用户看到的是连续进度条，而不是"先跑满再归零"。

### 4.3 并发池：为什么不需要锁

```ts
let cursor = 0
const worker = async () => {
  while (runtime.running && cursor < pending.length) {
    const index = pending[cursor]
    cursor += 1          // ← 同步执行，中间没有 await
    await uploadChunk(index)
  }
}
```

JS 单线程，`pending[cursor]` 读取与 `cursor += 1` 之间**不可能**插入另一个 worker 的执行，所以两个 worker 绝不会拿到同一个 index。

**如果是 Go / Java 呢？**
`cursor++` 不是原子操作（读-改-写三步），多线程下会丢更新，需要 `AtomicInteger.getAndIncrement()` 或互斥锁。这是"单线程模型省掉了什么"的经典例子。

**`while` 里的 `runtime.running`**
每取一个分片前检查一次，`pauseTask()` 置为 `false` 后 worker 在下一轮退出；已发出的请求由 `AbortController.abort()` 中断。


### 4.4 分片重试

```ts
async function uploadChunkWithRetry(formData, signal) {
  const maxRetries = 3
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await uploadChunk(formData, signal)
    } catch (error) {
      if (axios.isCancel(error) || error.name === 'AbortError') throw error  // 主动取消
      if (status === 401 || status === 403) throw error                      // 鉴权失败
      if (attempt >= maxRetries - 1) throw error                             // 次数用完
      await sleep(300 * 2 ** attempt)                                        // 300/600/1200ms
    }
  }
}
```

**为什么区分错误类型？**

| 错误 | 重试？ | 原因 |
|---|---|---|
| 网络抖动 / 5xx | ✅ | 瞬态故障，重试大概率成功 |
| 401 / 403 | ❌ | 令牌失效，重试 100 次也是 401 |
| AbortError | ❌ | 用户主动取消，重试违背用户意图 |
| 400（参数错误） | ❌ | 数据本身有问题，重试无用 |

**为什么指数退避？**
所有客户端同时失败时，固定间隔重试会造成**重试风暴**，把刚恢复的服务再次打挂。指数退避让客户端错开。

**为什么要限制次数？**
避免服务端持续故障时无限占用连接和带宽。

### 4.5 断点续传的完整链路

```
上传中：
  每片成功 → runtime.doneChunks.add(index)
           → saveRecord(task, fileHash)   // 写 localStorage

刷新页面：
  restoreTasks() 读 localStorage
    → 生成占位任务卡（status = 'paused'）
    → 提示"请重新选择原文件"

用户重新选文件：
  resumeByFile(uid, file)
    → 校验 name + size 一致
    → 复用 runtime.fileHash（跳过哈希计算！）
    → startTask()

续传：
  POST /check → 服务端返回磁盘上的分片 [0,1,2,5]
  与本地记录取并集 → doneChunks = {0,1,2,5}
  只上传 {3,4,6,7,...}
```

**为什么续传时校验名和大小而不是哈希？**
此时还没算哈希（算哈希要读整个文件，很慢）。名 + 大小一致已能过滤 99% 的误选，剩余风险由服务端 `fileHash` 兜底——内容真变了，`check` 返回的分片就对不上，最终合并会因大小校验失败。

---

## 5. `api/upload.ts` —— 流式下载

### 5.1 为什么不能用 `<a href download>`

```
下载接口需要 Authorization 头
   ↓
<a> 标签无法携带自定义请求头
   ↓
只能用 fetch / XHR
   ↓
fetch 的 response.body 是 ReadableStream
   ↓
可以边读边处理，不必等整个文件下完
```

### 5.2 两种落盘方式

**方式 A：File System Access API（Chrome / Edge）**

```ts
const handle = await showSaveFilePicker({ suggestedName: fileName })
const writable = await handle.createWritable()

for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  await writable.write(value)   // 直接写盘
}
await writable.close()
```

内存占用：**恒定**（只有当前这一块）。

**方式 B：Blob 回退（Firefox / Safari）**

```ts
const parts: BlobPart[] = []
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  parts.push(value)
}
const blob = new Blob(parts)
const url = URL.createObjectURL(blob)
```

内存占用：**等于文件大小**。2GB 文件需要 2GB 内存，可能失败。

**用户取消另存为的处理：**
```ts
catch (error) {
  if (error instanceof DOMException && error.name === 'AbortError') {
    throw error   // 用户取消 → 直接结束，不走 Blob 回退
  }
  // 其他异常（权限/不支持）→ 走回退
}
```

不判断的话，用户点"取消"后会莫名其妙弹出一个 Blob 下载。


---

## 6. 服务端 `upload.ts`

### 6.1 目录结构

```
backend/uploads/
├── chunks/
│   └── <fileHash>/
│       ├── 0
│       ├── 1
│       └── 2
├── files/
│   └── <storedName>
├── files.json          # 文件元数据
└── chunk-owners.json   # 分片目录归属（防越权）
```

**为什么分片目录用 hash 命名？**
秒传和断点续传都需要"从 hash 直接定位到分片目录"，用 hash 做目录名可以 O(1) 找到。

### 6.2 合并实现

```ts
async function mergeChunksToFile(fileHash, state) {
  const tmpPath = target + '.merging'
  const out = createWriteStream(tmpPath)

  for (let i = 0; i < state.totalChunks; i++) {
    await pipeline(
      createReadStream(chunkFile(fileHash, i)),
      out,
      { end: false }          // ← 关键：不关闭输出流
    )
  }

  await new Promise((resolve) => out.end(resolve))
  await fs.rename(tmpPath, target)   // 原子替换
}
```

**`{ end: false }` 的作用**
`pipeline` 默认在源流结束时关闭目标流。多个分片共用一个 `out`，第一个分片就把它关了，后面全失败。`end: false` 让 `pipeline` 只负责"把数据搬完 + 处理背压"，不关闭目标。

**为什么用 `pipeline` 而不是手写 `pipe`？**
手写版本：

```ts
// ❌ 有隐患的写法
src.pipe(out, { end: false })
await new Promise((resolve) => out.once('drain', resolve))
```

问题：如果 `pipe` 内部已经处理了 drain（数据全写完了），`out.once('drain')` 就永远等不到 → **死锁**。这种时序竞争很难复现，但线上会遇到。`pipeline` 内部正确管理了背压和事件。

**为什么先写 `.merging` 再 rename？**
`fs.rename` 在同一文件系统上是**原子操作**。如果直接写最终路径，用户在合并过程中下载会拿到半个文件。临时文件 + rename 保证最终文件"要么不存在，要么完整"。

### 6.3 归属校验（防越权）

**漏洞场景 A：污染别人的文件**

```
攻击者知道受害者正在上传 report.pdf，hash = abc123
  ↓
调用 POST /upload/chunk { fileHash:'abc123', index:99, file:<伪造内容> }
  ↓
无归属校验 → 伪造分片写入受害者的分片目录
  ↓
受害者传完触发合并 → 得到被污染的文件
```

**漏洞场景 B：窃取别人的半成品**

```
受害者传完 9/10 片后中断
  ↓
攻击者调用 POST /upload/merge { fileHash:'abc123', totalChunks:10 }
  ↓
无归属校验 → 攻击者白白得到一个完整文件
```

**修复：**

```ts
async function claimChunkDir(fileHash, ownerId) {
  await loadChunkOwners()
  const current = chunkOwners[fileHash]

  if (current === undefined) {          // 首次使用 → 认领
    chunkOwners[fileHash] = ownerId
    await saveChunkOwners()
    return { ok: true }
  }
  if (current !== ownerId) {            // 别人已认领 → 403
    return { ok: false, reason: '无权操作该分片目录' }
  }
  return { ok: true }
}
```

三个入口都校验：`/check`、`/chunk`、`/merge`。合并完成或目录清理时释放归属记录。

**为什么单独用 `chunk-owners.json` 而不是塞进 `files.json`？**
`files.json` 是"已完成文件"的记录，分片目录是"未完成"的，语义和生命周期都不同。而且塞进 `files.json` 的话，每次校验都要遍历整个文件列表 O(n)；独立文件是 O(1) 查表。

### 6.4 僵尸分片回收

```ts
export async function cleanupOrphanChunks(ttlMs = ORPHAN_CHUNK_TTL) {
  const names = await fs.readdir(CHUNK_ROOT)

  for (const name of names) {
    const stat = await fs.stat(path.join(CHUNK_ROOT, name))
    const state = uploadStates.get(name)

    // 取 mtime 和内存记录中较新的那个
    const lastActive = Math.max(stat.mtimeMs, state?.lastActiveAt || 0)

    if (Date.now() - lastActive < ttlMs) continue   // 还在保留期

    await fs.rm(dir, { recursive: true, force: true })
    uploadStates.delete(name)
    await releaseChunkOwner(name)
  }
}
```

**为什么要取 `Math.max`？**
- 只看目录 mtime：某些文件系统上写文件不一定刷新父目录 mtime，可能误删正在进行的上传；
- 只看内存 `lastActiveAt`：服务重启后内存清空，所有目录的 `lastActiveAt` 都是 0，会被全部删掉。

取较新的那个，两种误删风险都规避。

**为什么用 `timer.unref()`？**
`setInterval` 会让 Node 进程保持存活。测试或 CLI 场景下，服务退出会卡住。`unref()` 让定时器不阻止进程退出。

### 6.5 Range 下载

```ts
const parsed = parseRange(req.headers.range, stat.size)

if (parsed.status === 'unsatisfiable') {
  res.setHeader('Content-Range', `bytes */${stat.size}`)
  return res.status(416).json({ error: 'Range 超出文件范围' })
}

let start = 0, end = stat.size - 1, status = 200
if (parsed.status === 'partial') {
  start = parsed.start
  end = parsed.end
  status = 206
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
}

res.setHeader('Content-Length', String(end - start + 1))

const stream = createReadStream(target, { start, end })
res.on('close', () => stream.destroy())   // 客户端断开 → 释放文件句柄

return stream.pipe(res.status(status))
```

**`res.on('close')` 为什么重要？**
用户取消下载时客户端断开，但服务端 `createReadStream` 还在读。不 `destroy()` 会泄漏文件句柄，反复取消几次就把句柄耗尽（Linux 默认 1024）。

**为什么 `Content-Length` 是 `end - start + 1`？**
HTTP 字节区间是**闭区间**（`bytes 0-99` 表示 100 个字节）。算成 `end - start` 会少 1 字节，客户端会一直等。

---

## 7. 数据一致性全景

| 环节 | 可能的不一致 | 兜底机制 |
|---|---|---|
| 前端本地记录 vs 服务端分片 | 一方比另一方新 | **取并集** |
| 分片文件缺失 | 磁盘被清 / 写失败 | 合并前校验总大小 |
| 合并中途崩溃 | 最终文件不完整 | 临时文件 + 原子 rename |
| 同一个 hash 多用户 | 归属冲突 | `chunk-owners.json` 校验 |
| 分片被伪造 | 内容污染 | 归属校验 + 合并后大小校验 |
| 元数据并发写入 | JSON 覆盖丢失 | ⚠️ **当前未解决**（见限制） |

---

## 8. 自我检查：合上文档能不能答出来

1. 为什么不用 `crypto.subtle.digest()`？
2. SHA-256 padding 为什么有时要补 128 字节？
3. 那个 padding bug 的具体表现？为什么空输入是对的？
4. `file.slice().arrayBuffer()` 和 `file.arrayBuffer()` 的内存差别？
5. 并发池为什么不需要锁？
6. 重试为什么要区分错误类型？
7. 断点信息为什么存两份？
8. 合并为什么要先写临时文件？
9. `pipeline` 的 `{ end: false }` 是干什么的？
10. 分片目录归属不校验会有什么后果？
11. 僵尸分片清理为什么要取 `Math.max`？
12. Range 请求 `bytes=-100` 是什么意思？
13. 为什么 `Content-Length` 要 +1？
14. File System Access API 相比 Blob 的优势？
15. 速度估算为什么要用滑动窗口而不是全程平均？

答不上来的，回去看对应章节。

末尾要留 8 字节放长度。`64 - 8 = 56`。如果残留数据 + 1 字节 `0x80` 超过 56，就没地方放长度，必须再补一整个块。
