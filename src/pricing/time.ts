const pad = (n: number) => String(n).padStart(2, "0");

/** 格式化为 yyyy-MM-dd HH:mm */
export function fmtDateTime(input: string | number | Date): string {
  const d = new Date(input);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 字符串 -> datetime-local 输入框值（本地时区） */
export function isoToLocalInput(iso: string): string {
  return dateToLocalInput(new Date(iso));
}

export function dateToLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 输入框值 -> 标准化 ISO 字符串 */
export function localInputToIso(value: string): string {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) throw new Error("生效时刻格式无效");
  return new Date(t).toISOString();
}

/** 排期默认时刻：次日 09:00 */
export function defaultFutureInput(nowMs: number): string {
  const d = new Date(nowMs + 24 * 3600_000);
  d.setHours(9, 0, 0, 0);
  return dateToLocalInput(d);
}

/** 补录默认时刻：1 小时前 */
export function defaultPastInput(nowMs: number): string {
  return dateToLocalInput(new Date(nowMs - 3600_000));
}
