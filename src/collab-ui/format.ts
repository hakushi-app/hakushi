// Track T3 — tiny display formatting shared by IssuesTab / PrsTab.

/** "たった今" / "5分前" / "3時間前" / "2日前" / "4か月前" / "1年前". */
export function relativeTime(tsSec: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000) - tsSec);
  if (diff < 60) return "たった今";
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}か月前`;
  return `${Math.floor(months / 12)}年前`;
}

/** 「{page}#{block}: …」 anchor label (block omitted when null). */
export function anchorLabel(page: string, block: number | null): string {
  return block === null ? page : `${page}#${block}`;
}
