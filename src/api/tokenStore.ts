// ============================================================
// 双 token 的本地存储
//
// 为什么要单独抽一层：
//   request.ts（axios 拦截器）、ai.ts（SSE 流式）、upload.ts（预览直链 / 下载）
//   以及 user store 都需要读 / 写 token。如果各处直接操作 localStorage，
//   键名一改就要全局搜一遍，容易漏。这里统一收口。
//
// 命名沿用原来的 'token' 键（存访问令牌），这样老版本留下的登录态
// 不会因为升级而丢失——只是升级后需要重新登录一次才能拿到刷新令牌。
// ============================================================

/** 访问令牌：放请求头 Authorization，30 分钟过期 */
const ACCESS_TOKEN_KEY = 'token';

/** 刷新令牌：只用于静默换新的访问令牌，7 天过期 */
const REFRESH_TOKEN_KEY = 'refreshToken';

export function getAccessToken(): string {
  return localStorage.getItem(ACCESS_TOKEN_KEY) || '';
}

export function getRefreshToken(): string {
  return localStorage.getItem(REFRESH_TOKEN_KEY) || '';
}

/** 保存登录返回的两个 token（登录 / 刷新成功时调用） */
export function saveTokens(tokens: { token?: string; refreshToken?: string }): void {
  if (tokens.token) localStorage.setItem(ACCESS_TOKEN_KEY, tokens.token);
  if (tokens.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
}

/**
 * 只更新访问令牌。
 * 刷新接口若没返回新的刷新令牌（理论上会轮换，这里做兼容），就不能把旧的清掉。
 */
export function saveAccessToken(token: string): void {
  if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token);
}

/** 清空所有登录凭证（登出 / 刷新失败时调用） */
export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem('user');
}
