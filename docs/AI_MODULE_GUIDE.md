# AI 答疑 + 知识库（RAG）· 精读手册

> 用途：面试前 1~2 小时快速过一遍，能用「自己的话 + 关键数字 + 踩过的坑」把这条链路讲清楚。
> 配套：`MODULE_GUIDE.md`（分片上传精读）、`UPLOAD_MODULE.md`（上传架构）、本文（AI / RAG）。

---

## 0. 三十秒速记版

一句话：**用户提问 → SSE 推给前端 → 后端用「中文二元切分 + BM25」从本人知识库里捞 4 段资料 → 拼进 system prompt → 调 OpenAI 兼容接口（DeepSeek）流式返回 → 边转发边落库。**

必须张口就来的事实：

| 项目 | 事实 |
| --- | --- |
| 模型接口 | OpenAI 兼容 `/chat/completions`，`DEEPSEEK_MODEL=deepseek-chat`，`temperature=0.3`，`stream=true` |
| 传输协议 | SSE（`text/event-stream`），事件：`meta` / `sources` / `delta` / `done` / `error` |
| 检索算法 | **BM25**（k1=1.2、b=0.75），不是向量检索 |
| 中文分词 | **汉字二元切分（bigram）**，不引入 nodejieba |
| 切块 | chunk 400 字，overlap 80 字，优先在 `。！？；\n` 处断开 |
| 召回 | Top-K = 4，分数 < 0.5 丢弃，上下文上限 2000 字 |
| 历史 | 最近 8 条（`AI_HISTORY_LIMIT`），只取 `role ∈ {user, assistant}` |
| 隔离 | 所有会话/文档按 `userId` 隔离；别人的一律 404（不区分「不存在」和「无权限」） |
| 测试 | 后端 `node:test` 共 195 个用例全绿；AI 相关在 `ai.test.ts`、`knowledge.test.ts`、`knowledgeRoutes.test.ts` |

---

## 1. 文件地图（被问「代码在哪儿」时能立刻指出来）

### 后端 `backend/src/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `ai.ts` | AI 路由 + 调模型 + SSE + 落库 | `registerAiRoutes`、`retrieveKnowledge`、`callModel`、`parseStreamChunk`、`buildErrorAnswer`、`redactSecret`、`resolveApiKey` |
| `knowledge.ts` | **纯函数**文本处理与检索（零 IO，好测） | `normalizeText`、`tokenize`、`splitIntoChunks`、`scoreChunks`、`buildContextBlock`、`buildRagSystemPrompt` |
| `knowledgeRoutes.ts` | 知识库增删查 + 文档解析 + 检索预览 | `registerKnowledgeRoutes`、`extractText`、`makeChunkRows`、`searchDocs`、`isAdminUser` |
| `prisma/schema.prisma` | `AiConversation`、`AiMessage`、`KnowledgeDoc`、`KnowledgeChunk` 四张表 | — |

### 前端 `frontend/src/`

| 文件 | 职责 |
| --- | --- |
| `api/ai.ts` | `fetch` + `response.body.getReader()` 读流；`splitSseEvents` / `parseSseEvent` 手工解析 SSE；返回 `{ abort }` 句柄 |
| `views/AiChatView.vue` | 对话页：会话列表 + 消息列表 + 输入框 |
| `components/AiChatPanel.vue` / `AiDrawer.vue` | 对话气泡、打字机效果、参考来源展示 |
| `utils/typewriter.ts` | 增量文本平滑输出（避免一次性刷屏） |
| `components/KnowledgeBaseDialog.vue` | 知识库上传 / 列表 / 删除 / 检索调试 |

> 分层口径（可以讲成设计亮点）：
> **`knowledge.ts` 全是纯函数（输入 chunks + query，输出带分数的片段），不做任何 IO**。
> 好处：① 单测不用 mock 数据库；② 以后想换向量检索，只替换 `scoreChunks` 一个函数即可。


---

## 2. 端到端链路（能画出来就赢一半）

```
用户输入问题
   │
   ▼  POST /api/ai/chat  { question, conversationId? }
[ai.ts] 鉴权 authMiddleware → userId
   │
   ├─1 校验问题：normalizeQuestion → 去空白 / 压换行；长度 > 2000 字直接 400
   ├─2 会话：有 conversationId 就 findFirst({ id, userId })（不是本人的 → 404）
   │        没有就 create，title = 问题前 20 字
   ├─3 先落库 user 消息（拿到 userMessageId）
   ├─4 取历史：findMany({ conversationId, id < userMessageId, take: 8, orderBy: desc }) → reverse()
   │
   ├─5 openSse(res)  ← 到这里才发响应头，之前的错误都走普通 JSON（避免"200 但是错误事件"）
   │   sendEvent('meta', { conversationId, title })
   │
   ├─6 RAG 检索 retrieveKnowledge()
   │     searchDocs(prisma, userId, question)
   │       ├─ 可见文档：本人（管理员：全部）→ 再用 canListFileWithoutTask 过滤一次
   │       ├─ 一次性取出候选 chunk（docId in [...]）
   │       ├─ scoreChunks(chunks, query) → BM25 打分排序 → Top-4
   │       └─ buildContextBlock → 编号 + 文件名 + 正文（总长 ≤ 2000 字）
   │     命中 → sendEvent('sources', { sources })   ← 先推来源，气泡一出现就能渲染
   │
   ├─7 callModel(messages, onDelta, signal)
   │     fetch(`${AI_BASE_URL}/chat/completions`, { stream: true })
   │     逐行 parseStreamChunk → onDelta(delta) → sendEvent('delta', { content })
   │
   ├─8 收尾：assistant 消息落库 + 更新会话 updatedAt
   └─9 sendEvent('done', { messageId, content, saved }) → res.end()
```

失败路径（面试常追问）：

| 场景 | 行为 |
| --- | --- |
| 没配 key | `callModel` 抛 `NO_API_KEY` → **不伪造答案**，返回「AI 服务尚未配置完成」 |
| 模型 402 余额不足 / 401 key 无效 / 429 限流 / 5xx | 状态码映射成稳定错误码 → `buildErrorAnswer` 出人话 → 前端走 `error` 事件 |
| 模型返回空 | 补一句「抱歉，这次没有生成有效回答」再落库，历史里不留空洞 |
| 用户关页面 / 点「停止生成」 | `req.on('close')` → `abortController.abort()`，立刻掐断对模型的请求，**不白烧 token** |
| 知识库检索失败 | `try/catch` 后按「无资料」继续，**知识库坏了不许拖垮问答** |
| 落库失败 | 已生成的答案照常展示，`done.saved=false` + `error` 事件提示「保存历史失败」 |

---

## 3. RAG 落地细节（重点，面试官最爱问）

### 3.1 为什么是 BM25 而不是向量检索

按这个顺序讲（`knowledge.ts` 顶部注释就是这套逻辑）：

1. **DeepSeek 没有开放 Embedding 接口**，做向量检索得再引入一家 key + 一个向量库，增加部署和成本；
2. 知识库内容是**操作手册 / 规章制度**，术语固定（「上传失败」「审核流程」），**关键词召回已够用**；
3. **零额外调用成本、结果可解释**——能说清「命中了哪些词、每段多少分」，出问题好排查。

同时**主动说出局限**（面试官一定会追问）：「如果换成口语化提问、同义词多的场景（问『传不上去怎么办』而文档写『上传失败』），纯 BM25 会漏召回。这时我会加一路向量召回做混合检索（RRF 融合），或者先让模型把问题改写成关键词。代码上只需替换 `scoreChunks`，因为检索层是纯函数、边界干净。」

### 3.2 中文分词为什么不用 jieba

- `nodejieba` 需要本地编译（node-gyp / python / gcc），Windows 和 CI 上经常装不上，**部署成本高**；
- 自己实现**二元切分**：连续汉字切成相邻两字组合，「文件上传失败」→ `文件/件上/上传/传失/失败`；
- 英文 / 数字 / 下划线按**整词保留**（`upload` 不能拆成 `up/pl/lo`，否则报错信息、字段名全废）；
- 效果接近词级分词的召回，**不用维护词典**；
- 停用词表（`STOP_TOKENS`）过滤「的/了/是/of/the」这类高频噪声。

被问「二元切分有什么问题」：会产生无意义组合（「件上」）导致假阳性；但配合 IDF（稀有词权重高）+ 最小分阈值（0.5）能压住，实测足够。

### 3.3 切块策略（`splitIntoChunks`）

1. `normalizeText` 统一换行、去零宽字符、压缩空白（**保留换行**，切块靠它）；
2. 取 400 字窗口，若没到文末，就在**窗口后 40%（`chunkSize * 0.6` 之后）**找最后一个 `。！？；\n` 作为断点 —— 让块尽量结束在句子边界；
3. 下一块起点回退 80 字（overlap），保证被切断的句子在前后两块都完整出现；
4. 防御：`overlap` 必须 < `size`（否则原地打转死循环），代码里取 `min(overlap, size/2)`。

数字口径：**400 / 80**。太小会切断语义（召回片段读不懂），太大导致召回内容冗长、上下文被一两段占满还烧 token。

### 3.4 BM25 的三件事（公式能写出来最好）

```
score = Σ_term  IDF(term) · [ tf·(k1+1) ] / [ tf + k1·(1 - b + b·len/avgLen) ]

IDF(term) = ln( 1 + (N - df + 0.5) / (df + 0.5) )
k1 = 1.2（词频饱和：同一个词出现 10 次不该是 1 次的 10 倍分）
b  = 0.75（长度归一化：长片段天然容易命中，要降权）
```

- **TF**：词在片段里出现越多分越高，但有饱和；
- **IDF**：越少见的词越有区分度（「秒传」比「文件」值钱）；
- **长度归一化**：防止长片段靠「词多」刷分；
- 实现上：**df 是拿查询词在候选集里现算的**（不是全库）。因为知识库是「个人文档」量级（几十份），全量读进内存打分的成本远低于引入向量库或数据库全文索引。

### 3.5 防幻觉（`buildRagSystemPrompt`）

拼进 system prompt 的内容必须带三样：**编号 + 来源文件名 + 第几段**，并强约束：

- 「只依据下面资料回答，资料里没有就说不知道，不要用先验知识硬编」；
- 「引用时标注 [1][2]」，前端据此把「参考来源」渲染在气泡下方。

能加分的工程细节：`buildContextBlock` 超出 2000 字时**截断这一段而不是整段丢弃**（半段也比没有强），并且始终返回 `sources`，**让用户看得见答案来源**——这是 RAG 产品化的关键。

### 3.6 权限隔离（越权是 RAG 的高危区）

- 会话：`findFirst({ id, userId })`，不是本人 → **404**（不返回 403，避免攻击者探测「会话是否存在」）；
- 知识库：`searchDocs` 里先按 `ownerId` 取（管理员取全部），再复用 `canListFileWithoutTask` 过滤一遍，**与列表接口同一套规则** —— 避免「列表里看不到、却被 AI 引用」的信息越权；
- 文档 `ownerId` 来自 token，**前端不能传**。

---

## 4. SSE 流式实现（前后端都要会讲）

### 后端 `openSse` 的 5 个响应头缺一不可

```ts
res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
res.setHeader('Cache-Control', 'no-cache, no-transform')
res.setHeader('Connection', 'keep-alive')
res.setHeader('X-Accel-Buffering', 'no')   // 关掉 Nginx 缓冲，否则流会被「憋」成一整块
res.flushHeaders?.()                       // 立刻把响应头发出去，别让客户端干等
```

事件格式：`event: xxx\ndata: {json}\n\n`（**空行是 SSE 协议硬要求**）。

### 前端为什么不用 axios

> axios 的浏览器适配器要等整个响应读完后才 resolve，**拿不到增量**；
> 必须 `fetch` + `response.body.getReader()` 才能边收边渲染。

配套两个细节（很能体现「踩过坑」）：
1. **粘包 / 半包**：网络分片不保证按事件切分，所以维护 `buffer`，用 `splitSseEvents` 按空行切，**剩下的 `rest` 留到下一轮**；
2. **停止生成**：`AbortController.abort()` → 后端 `req.on('close')` 感知到就中止对模型的请求。

### 打字机效果

模型 delta 到达节奏不均匀（有时一次几十字），直接 `+=` 会一顿一顿。`utils/typewriter.ts` 把增量放进队列，用固定间隔逐步消费，视觉上更顺滑。

---

## 5. 知识库上传链路

```
上传文件 → extractText(fileName, buffer)
   ├─ txt/md/json/csv/log/yaml/js/ts/html/sql… → TextDecoder('utf-8', { fatal: true })
   │     （fatal: 非法 UTF-8 直接报错，而不是悄悄变乱码进知识库）
   ├─ docx → mammoth.extractRawText（不用 convertToHtml：HTML 标签是噪音词）
   ├─ pdf  → pdf-parse 的 PDFParse.getText({ pageJoiner: '' })
   │     （默认会加 "-- 1 of 5 --"，显式关掉；finally 里 destroy() 释放 worker）
   └─ doc  → 明确拒绝并提示「另存为 .docx」
   │
   ▼ normalizeText
   ▼ 校验：空 → 报错；docx/pdf 抽出 < 10 字 → 判定扫描件；> 50 万字 → 请拆分
   ▼ makeChunkRows：splitIntoChunks + tokenize → { seq, content, tokens, tokenCount }
   ▼ 写库：KnowledgeDoc + createMany(KnowledgeChunk)
```

可讲的坑：
- **扫描版 PDF 抽不出字**：不是笼统报「解析失败」，而是识别出「几乎没文字」并提示「请上传文字版」——错误提示要能指导用户下一步动作；
- **解析库动态 import**：只有真上传 word/pdf 才加载，不影响后端启动速度、测试也更快；
- **`POST /api/knowledge/search` 调试接口**：只返回召回片段不调模型。调 RAG 时 90% 的问题在「召回不准」而不是「模型不会答」，有这个接口能直接看命中片段和分数，**不必每次烧一次模型调用**。



---

## 6. 数据模型（4 张表，能说出索引就是加分）

```
User 1─n AiConversation 1─n AiMessage
          @@index([userId, updatedAt])          // 会话列表按活跃时间排序
                  @@index([conversationId, id]) // 取最近 N 条历史

User 1─n KnowledgeDoc 1─n KnowledgeChunk
          @@index([ownerId, createdAt])
                  @@index([docId, seq])         // 按文档取块

KnowledgeDoc:   content(@db.Text 全文) / charCount / chunkCount / fileSize
KnowledgeChunk: content(@db.Text) / tokens(@db.Text，空格分隔) / tokenCount / seq
```

设计取舍（会被问）：
- `tokens` 存**空格分隔字符串**而不是 JSON / 关联表 —— 写入简单、读取 `split(' ')` 即可；代价是不能用数据库做倒排检索（我们本来就全量读进内存打分）；
- 历史消息用 `id` 游标（`id < userMessageId`）而不是 offset —— 新消息不断插入也不会错位；
- `chunkCount` 是上传时的冗余字段，查看详情时用 `count()` 取真实值，避免重建索引后失真。

---

## 7. 高频面试题（附「怎么答」）

**Q1：你这个 RAG 和「把文档塞进 prompt」有什么区别？**
> 塞进去受上下文长度限制、成本随对话轮数线性上升、无关内容还会干扰模型。RAG 是**检索后才拼上下文**：只把 Top-4（≤2000 字）最相关的段落注入，成本可控，还能返回「参考来源」让用户核对。

**Q2：为什么不直接把整个知识库拼进 system prompt？**
> 几十万字的文档 token 费爆炸，而且模型注意力会被稀释（lost in the middle），关键信息反而被淹没。

**Q3：BM25 的 IDF 为什么加 1？**
> 标准 BM25 的 IDF 在 df > N/2 时可能为负，导致常见词「倒扣分」；`ln(1 + ...)` 保证非负。

**Q4：怎么评估检索效果？**
> 用 `/api/knowledge/search` 构造一组「问题 → 期望命中片段」的用例，看 Recall@4 和首条命中（MRR）；先固化成测试，再调 chunk 大小、overlap、minScore。

**Q5：chunk 400 字怎么定的？**
> 中文一句 20~40 字，400 字约 10~20 句，能容纳一个小节，语义完整；配 80 字 overlap 保证边界句不被切断。这是从「语义完整性」和「上下文预算（2000 字 / 4 段）」倒推的，真实项目要用评测集再调。

**Q6：多轮上下文怎么处理？会不会 token 爆炸？**
> 只取最近 8 条，且只保留 user/assistant —— **过滤前端可能伪造的 system 消息**。更远的对话靠「会话本身在库里」+ 用户自己开新会话解决。以后可以做滚动摘要压缩。

**Q7：SSE 还是 WebSocket？**
> 这里只需**服务端单向推**：SSE 基于 HTTP、天然支持断线重连、能过大部分代理、实现成本远低于 WS。WS 更适合双向实时通信（聊天室、协同编辑）。

**Q8：SSE 有哪些坑？**
> ① Nginx 缓冲（要 `X-Accel-Buffering: no`）；② HTTP/1.1 同域 6 连接限制，多标签页同时提问会占满；③ 网络分片导致粘包，前端必须自己按空行切 buffer；④ 客户端断开要能感知并中止上游请求。

**Q9：AI 服务挂了怎么办？为什么不给兜底答案？**
> 这是**刻意的产品决策**：用假数据糊弄用户比报错更糟。按错误码给「能做什么」的人话提示，技术细节只写后端日志，并做**密钥脱敏**（`redactSecret` 把 `sk-xxx` 抹成 `sk-***`，因为某些 HTTP 客户端会把 Authorization 头挂到 error 对象上）。

**Q10：密钥怎么管理？**
> 两种来源：`DEEPSEEK_API_KEY_FILE`（Docker secret / K8s 挂载，优先）和 `DEEPSEEK_API_KEY`（本地 .env）。本地开发和容器部署共用同一份代码，不用为「密钥怎么注入」改业务逻辑。

**Q11：这个 AI 模块要上生产，还缺什么？**
> ① 检索评测集 + 混合检索（BM25 + 向量）；② 按用户限流（QPS / token 预算）；③ 会话消息分页（现在一次取全量）；④ 内容审核；⑤ 可观测性（首包延迟 P95、token 消耗、检索命中率）。

**Q12：追问「你怎么证明这块代码是你写的 / 你真的懂？」**
> 现场打开三个文件讲：`knowledge.ts` 的 `tokenize` / `scoreChunks`（被问公式就画公式）、`ai.ts` 的 `openSse` + `callModel`（讲 SSE 5 个 header 和断流处理）、前端 `api/ai.ts` 的 `splitSseEvents`（讲粘包）。这三处最能体现「知道为什么这么写」。
