// 用户类型
export interface User {
  id: number
  username?: string
  account?: string
  createdAt?: string
  /** 角色：管理员 admin / 普通成员 member（与后端 User.role 对应） */
  role?: UserRole
  /**
   * 是否还在用初始密码（新建成员 / 管理员重置后为 true）
   * 登录后为 true 时前端提示「请尽快修改密码」
   */
  mustChangePassword?: boolean
}

// 用户角色（字符串联合，允许以后扩展新角色）
export type UserRole = 'admin' | 'member' | (string & {})


// 登录请求参数
export interface LoginParams {
  account: string
  password: string
}

// 登录响应
export interface LoginResult {
  /** 访问令牌：放请求头 Authorization，30 分钟后过期 */
  token: string
  /** 刷新令牌：只用于静默换新访问令牌，7 天后过期 */
  refreshToken?: string
  /** 访问令牌有效期（秒），后端下发，前端可用于提前续期 */
  accessTokenExpiresIn?: number
  /** 刷新令牌有效期（秒） */
  refreshTokenExpiresIn?: number
  user?: User
}

// 任务状态
export type TaskStatus = 'todo' | 'doing' | 'done'

// 任务优先级
export type TaskPriority = 'high' | 'medium' | 'low'

// 任务类型
export interface Task {
  id: number
  title: string
  description?:string
  status: TaskStatus
  priority: TaskPriority
  createdAt?: string
  userId?: number|null
  /** 完成人姓名（后端 completedPerson 字段，任务完成时写入） */
  completedPerson?: string | null
}

// 创建任务参数
// 状态由流转决定：新建时为「待办」，分配后变「进行中」，点「完成」后变「已完成」
// 所以新建表单不再让用户选择状态
export interface CreateTaskParams {
  title: string
  priority: TaskPriority
  description:string
}

// 更新任务参数
export interface UpdateTaskParams {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  /** 完成人 / 被分配人姓名（后端 completedPerson 字段） */
  completedPerson?: string
  userId?: number|null
}


// 任务查询参数：传了 page 才走后端分页（不传则返回全部，兼容看板 / 上传页的下拉数据）
export interface TaskQueryParams {
  page?: number
  pageSize?: number
}

// 任务分页结果
export interface TaskPageResult {
  list: Task[]
  total: number
  page: number
  pageSize: number
}

// 通用 API 响应
export interface ApiResponse<T = any> {
  code: number
  data: T
  message: string
}

//用户列表定义表格字段
// 注意：userName 是「姓名」（对应后端 User.name），
//      account 才是「账号」（对应后端 User.username，唯一、用于登录）
export interface UserData{
  id?:number,
  account:string
  userName:string
  age: string
  email:string
  /** 角色：admin 管理员 / member 普通成员（后端 userList 会返回） */
  role?: string
}


// 新建成员参数（account 即登录账号，对应后端 username）
export interface CreateUserParams {
  account: string
  userName?: string
  age: number
  email:string
  // 账号密码：新建时必填，修改时留空表示不修改
  password?: string
}

// 新建成员接口返回：后端会生成初始密码（明文只在这里返回一次，库里存的是哈希）
export interface CreateUserResult {
  id: number
  account: string
  userName: string
  age: number | null
  email: string
  /** 系统生成的初始密码（仅创建成功时返回，请提示用户自行保存） */
  password: string
}

// 修改用户参数
export interface UpdateUserParams {
  id:string
  account?: string
  userName?: string
  age?: number
  email?:string
  password?: string
}
// 删除用户参数
export interface DeleteUserParams {
  id:string
}
// 重置密码返回数据
export interface NewPassword {
  account:string,
  password:string
}

// 修改自己密码的参数（后端 PUT /api/auth/password）
export interface ChangePasswordParams {
  oldPassword: string
  newPassword: string
}
//用户列表搜索参数{}
export interface SearchParams{
   userName:string
}

// ============ 文件上传（秒传 / 断点续传）相关类型 ============

// 上传任务状态
export type UploadStatus =
  | 'pending' // 等待上传
  | 'hashing' // 计算文件哈希中
  | 'checking' // 校验服务端分片（秒传 / 续传查询）
  | 'uploading' // 上传中
  | 'paused' // 已暂停
  | 'merging' // 合并分片中
  | 'done' // 已完成
  | 'error' // 失败

// 分片大小预设（默认 5MB）
export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024

// 上传任务（页面展示用）
export interface UploadTask {
  uid: string
  file: File
  fileName: string
  fileSize: number
  fileKey: string
  chunkSize: number
  totalChunks: number
  // 已完成分片下标（已上传到服务端或本地已计算）
  uploadedChunks: number[]
  progress: number
  status: UploadStatus
  // 秒传命中
  instant: boolean
  errorMsg?: string
  // 速度（字节/秒）与剩余时间（毫秒）
  speed: number
  remaining: number
  /** 文件分类 id（上传前必选） */
  categoryId?: number
  /**
   * 所属任务 id 列表（上传前必选，至少 1 个）
   *
   * 支持一次把同一个文件挂到多个任务下：每个任务对应一张独立的上传卡片，
   * 这样每张卡片能单独暂停 / 失败重试，进度也各自准确。
   */
  taskIds?: number[]
  /** 所属任务 id（单选时代的字段，保留用于兼容旧的断点记录） */
  taskId?: number
  /**
   * 是否为「刷新后恢复的占位任务」
   *
   * 浏览器无法用路径重新拿到 File 对象，restoreTasks() 只能用空壳 File 占位，
   * 这类任务必须由用户重新选择原文件才能继续（页面据此决定要不要弹文件选择框）。
   * 与 file.size === 0 等价，但语义明确，不依赖文件大小推断状态。
   */
  needsFile?: boolean
  /** 上传通道：OSS 直传 / 本地分片（由引擎实际选择后写入，页面可展示） */
  channel?: 'oss' | 'local'
}

// 文件记录的本地持久化结构（用于刷新后找回断点）
export interface UploadRecord {
  fileKey: string
  fileHash: string
  fileName: string
  fileSize: number
  totalChunks: number
  chunkSize: number
  uploadedChunks: number[]
  /** 归属：分类 / 任务（老版本记录没有这两个字段，恢复时需要用页面当前选择兜底） */
  categoryId?: number
  /** 所属任务 id 列表（多任务上传时一个文件会有多条记录，每条只记一个任务） */
  taskIds?: number[]
  /** 所属任务 id（单选时代 / 老记录字段） */
  taskId?: number
  /**
   * OSS 直传的断点信息（SDK 的 checkpoint）
   *
   * 为什么需要单独存：分片上传的断点靠「服务端已有分片列表」恢复，
   * 而直传的字节直接落在 OSS，我们服务器看不到 part 列表，
   * 只能把 SDK 返回的 checkpoint（含 uploadId + 已完成分片的 ETag）存下来，
   * 下次带着它调用 multipartUpload 就能跳过已传分片。
   */
  ossCheckpoint?: {
    name: string
    fileSize: number
    partSize: number
    uploadId: string
    doneParts: Array<{ number: number; etag: string }>
  }
  updatedAt: number
}


// 秒传/续传校验请求参数
// categoryId / taskId 为必填：每份文件都必须归到某个分类与某个任务下
export interface CheckFileParams {
  fileHash: string
  fileName: string
  fileSize: number
  totalChunks: number
  /** 文件分类 id（必填） */
  categoryId?: number
  /**
   * 所属任务 id（必填）
   *
   * 秒传 / 续传校验是按「单个任务」做的：同一文件挂到多个任务时会各发一次请求，
   * 后端据此为每个任务各留一条文件记录（磁盘文件仍是同一份）。
   */
  taskId?: number
}

// 秒传/续传校验结果
export interface CheckFileResult {
  // 是否已秒传（服务端已存在完整文件）
  exists: boolean
  // 服务端已存在的分片下标
  uploadedChunks: number[]
}

// 分片上传结果
export interface UploadChunkResult {
  index: number
  // 合并成功后的文件地址（仅最后一片合并时返回）
  url?: string
}

/**
 * OSS 直传凭证（后端 POST /upload/oss/credential 返回）
 *
 * 注意 key 由服务端算好，前端不能改：凭证（STS 临时密钥 + 策略）只对这一个
 * object key 有效，改 key 会直接被 OSS 拒绝（403）。
 */
export interface OssCredential {
  mode: 'sts'
  bucket: string
  /** bucket 访问域名（不带协议） */
  endpoint: string
  region: string
  /** 服务端算好的 object key，上传时原样使用 */
  key: string
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  /** 凭证过期时间（ISO 字符串） */
  expiration: string
  /** 服务端建议的分片大小（字节）：保证分片数不超过 OSS 的 10000 上限 */
  chunkSize: number
  /** 是否走分片直传（大文件）；false 表示 PutObject 一次传完 */
  multipart: boolean
}

// 文件实体（服务端返回的已上传文件）
export interface UploadFileItem {
  id: number
  fileName: string
  fileSize: number
  url: string
  createdAt?: string
  /** 上传人姓名（后端根据 token 记录，旧数据可能为空） */
  uploaderName?: string
  /** 文件分类 id */
  categoryId?: number
  /** 文件分类名称（后端补充返回，分类被删除时为空） */
  categoryName?: string
  /** 所属任务 id */
  taskId?: number
  /** 所属任务标题（后端补充返回，任务被删除时为空） */
  taskTitle?: string
}

/**
 * 上传任务的归属信息：上传前必须先选好分类与任务（任务可多选，至少 1 个）
 * 上传人不需要前端传，后端从 token 里取
 */
export interface UploadOwnership {
  categoryId: number
  /** 所属任务 id 列表，至少一个 */
  taskIds: number[]
  /**
   * 单个任务的快捷字段
   *
   * 引擎内部每张上传卡片只对应一个任务，用它表示「这张卡挂哪个任务」；
   * 页面传归属时也应同时给出它，方便旧代码（成员端任务详情页）继续按 taskId 工作。
   */
  taskId?: number
}

// 文件列表筛选参数
export interface UploadFileQuery {
  categoryId?: number
  taskId?: number
}

// ============ AI 答疑（对话窗口 + 会话历史）相关类型 ============

// 会话（对应后端 AiConversation）
export interface AiConversation {
  id: number
  title: string
  createdAt?: string
  updatedAt?: string
  /** 消息条数（列表接口用 _count 统计，新建的空会话为 0） */
  messageCount?: number
}

// 后端返回的消息记录（GET /ai/conversations/:id/messages）
export interface AiMessageRecord {
  id: number
  role: 'user' | 'assistant' | (string & {})
  content: string
  createdAt?: string
}

// 页面展示用的消息
export interface AiMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  /** 是否正在流式输出（用于显示光标 / 隐藏操作按钮） */
  streaming?: boolean
  /** 该条回答是否出错（展示为红色提示气泡） */
  error?: boolean
  /** 本条回答引用的知识库片段（后端 SSE 的 sources 事件，没有命中时不填） */
  sources?: AiSource[]
}

// 回答引用的知识库片段（后端 buildContextBlock 产出）
export interface AiSource {
  docId: number
  /** 原始文件名 */
  fileName: string
  /** 该片段在文档内的序号（从 0 开始） */
  seq: number
  /** BM25 相关度分数，仅供展示 / 调试 */
  score: number
  /** 摘要（截断后的片段内容） */
  snippet: string
}

// 流式事件的回调
export interface ChatCallbacks {
  /** 首包：会话 id / 标题 */
  onMeta?: (meta: { conversationId: number; title: string }) => void
  /** 参考来源：正文开始前推送，没有命中知识库时不会触发 */
  onSources?: (sources: AiSource[]) => void
  /** 增量文本 */
  onDelta?: (text: string) => void
  /** 结束：完整答案与是否已存历史 */
  onDone?: (result: { messageId: number; content: string; saved: boolean }) => void
  /** 出错（此时不会再触发 onDone） */
  onError?: (message: string) => void
  /** 用户主动「停止生成」 */
  onAbort?: () => void
}

// 流式请求句柄
export interface ChatStreamHandle {
  abort: () => void
}

// ============ RAG 知识库相关类型 ============

// 知识库文档（对应后端 KnowledgeDoc）
export interface KnowledgeDoc {
  id: number
  ownerId: number
  fileName: string
  /** 原始文件字节数 */
  fileSize: number
  /** 正文字符数 */
  charCount: number
  /** 切块数量（检索的最小单位） */
  chunkCount: number
  createdAt?: string
  /** 上传者显示名（用户名或账号） */
  ownerName?: string
  /** 是否可删除（本人或管理员） */
  canDelete?: boolean
}

// 知识库文档详情（对应后端 GET /api/knowledge/docs/:id）
// 知识库在上传时只保留解析后的纯文本，没有落盘原始字节，
// 所以「查看」拿到的是正文文字（docx / pdf 为抽取结果），而不是原文件。
export interface KnowledgeDocDetail extends KnowledgeDoc {
  /** 解析后的正文全文（超长时会被后端截断） */
  content: string
  /** 正文是否因超过后端上限被截断 */
  truncated: boolean
}

// ============ 文件分类相关类型 ============
// 文件分类（列表行）
// 名称在库里有唯一约束，接口层也会先查重后返回「分类名称已存在」
export interface FileCategory {
  id: number
  name: string
  createdAt?: string
}

// 新建分类参数
export interface CreateCategoryParams {
  name: string
}

// 修改分类参数
export interface UpdateCategoryParams {
  name: string
}
