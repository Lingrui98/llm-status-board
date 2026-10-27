import type { AccountConfig, AppConfig } from "./types";

/**
 * 合并后台轮转的 token：refresh_all / 测试连接可能在磁盘上写入了新 token，
 * 如果用户这次保存并没有改 token / refreshToken 字段（与 orig 快照一致），
 * 则采用磁盘上的最新值，避免用旧快照覆盖已轮换的凭证。
 *
 * @param next 用户当前要保存的配置
 * @param orig 用户这次编辑所基于的快照（上次成功持久化的配置；null 表示无基准，全部按用户输入）
 * @param disk 保存前一刻从磁盘重新读取的配置
 */
export function mergeRotatedTokens(next: AppConfig, orig: AppConfig | null, disk: AppConfig): AppConfig {
  return {
    ...next,
    accounts: next.accounts.map((a) => {
      const d = disk.accounts.find((x) => x.id === a.id);
      const o = orig?.accounts.find((x) => x.id === a.id);
      // 磁盘上没有（同 id 被删过）或无基准快照：以用户输入为准
      if (!d || !o) return a;
      const merged = { ...a };
      // token：用户没改（与 orig 相同）且磁盘上已被轮换 → 采用磁盘值
      if (a.token === o.token && d.token && d.token !== o.token) {
        merged.token = d.token;
      }
      // refreshToken：同理（空串归一化比较）
      if ((a.refreshToken ?? "") === (o.refreshToken ?? "") && (d.refreshToken ?? "") !== (o.refreshToken ?? "")) {
        merged.refreshToken = d.refreshToken;
      }
      return merged;
    }),
  };
}

/**
 * 账号排序：把指定账号上移 / 下移一位（与相邻项交换）。
 * 越界或找不到 id 时原样返回（引用不变，便于调用方跳过冗余渲染/保存）。
 */
export function moveAccount(accounts: AccountConfig[], id: string, dir: -1 | 1): AccountConfig[] {
  const i = accounts.findIndex((a) => a.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= accounts.length) return accounts;
  const copy = [...accounts];
  copy[i] = accounts[j];
  copy[j] = accounts[i];
  return copy;
}

/** Move an account directly to another account's position, preserving all other relative order. */
export function reorderAccount(accounts: AccountConfig[], id: string, targetId: string): AccountConfig[] {
  const from = accounts.findIndex((account) => account.id === id);
  const to = accounts.findIndex((account) => account.id === targetId);
  if (from < 0 || to < 0 || from === to) return accounts;
  const next = [...accounts];
  const [account] = next.splice(from, 1);
  next.splice(to, 0, account);
  return next;
}
