import { computed, reactive } from "vue";
import { defineStore } from "pinia";

export const FUELS = ["92号汽油", "95号汽油", "98号汽油", "柴油"] as const;

export type PriceVersion = {
  id: string;
  fuel: string;
  price: number;
  /** 生效时刻（ISO 字符串），版本区间按生效时刻依次衔接 */
  effectiveAt: string;
  reason: string;
  operator: string;
  createdAt: string;
  revokedAt: string | null;
  revokeReason: string;
};

export type AuditEntry = {
  id: string;
  at: string;
  action: "新建版本" | "补录修订" | "改期" | "撤销";
  fuel: string;
  versionId: string;
  operator: string;
  detail: string;
};

export type VersionInput = {
  fuel: string;
  price: number | null;
  effectiveAt: string;
  reason: string;
  operator: string;
};

type Persisted = {
  versions: PriceVersion[];
  audit: AuditEntry[];
};

const STORAGE_KEY = "dfwlfront-9-price";

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtPrice(price: number): string {
  return `¥${price.toFixed(2)}`;
}

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 某油品未撤销的版本链，按生效时刻升序 */
export function activeChain(versions: PriceVersion[], fuel: string): PriceVersion[] {
  return versions
    .filter((v) => v.fuel === fuel && !v.revokedAt)
    .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.createdAt.localeCompare(b.createdAt));
}

/** 当前挂牌价：已生效的最新版本；没有则返回 null（未定价） */
export function currentAt(chain: PriceVersion[], now: string): PriceVersion | null {
  let current: PriceVersion | null = null;
  for (const version of chain) {
    if (version.effectiveAt <= now) current = version;
    else break;
  }
  return current;
}

/** 待生效版本，按生效时刻升序 */
export function pendingAfter(chain: PriceVersion[], now: string): PriceVersion[] {
  return chain.filter((v) => v.effectiveAt > now);
}

function normalize(time: string): string | null {
  const d = new Date(time);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function seed(): Persisted {
  const rows: Array<[string, number, string, string, string, string]> = [
    // 油品, 价格, 生效时刻(本地), 原因, 操作员, 创建时间
    ["92号汽油", 7.62, "2026-06-30T08:00", "上半年调价备案", "站长", "2026-06-29T10:00:00.000Z"],
    ["92号汽油", 7.7, "2026-10-01T00:00", "国庆调价（待生效）", "值班经理", "2026-09-10T02:00:00.000Z"],
    ["95号汽油", 8.1, "2026-06-30T08:00", "上半年调价备案", "站长", "2026-06-29T10:00:00.000Z"],
    ["98号汽油", 8.85, "2026-08-01T08:00", "品质升级调价", "站长", "2026-07-28T10:00:00.000Z"],
    ["柴油", 7.18, "2026-06-30T08:00", "上半年调价备案", "值班经理", "2026-06-29T10:00:00.000Z"],
    ["柴油", 7.25, "2026-09-20T00:00", "秋收用油调价（待生效）", "值班经理", "2026-09-12T02:00:00.000Z"],
  ];
  const versions: PriceVersion[] = rows.map(([fuel, price, effectiveLocal, reason, operator, createdAt]) => ({
    id: crypto.randomUUID(),
    fuel,
    price,
    effectiveAt: new Date(effectiveLocal).toISOString(),
    reason,
    operator,
    createdAt,
    revokedAt: null,
    revokeReason: "",
  }));
  const audit: AuditEntry[] = versions.map((v) => ({
    id: crypto.randomUUID(),
    at: v.createdAt,
    action: v.effectiveAt <= v.createdAt ? "补录修订" : "新建版本",
    fuel: v.fuel,
    versionId: v.id,
    operator: v.operator,
    detail: `新建版本：${fmtPrice(v.price)}，生效时刻 ${fmtTime(v.effectiveAt)}；原因：${v.reason}`,
  }));
  return { versions, audit };
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed || !Array.isArray(parsed.versions) || !Array.isArray(parsed.audit)) return seed();
    return parsed;
  } catch {
    return seed();
  }
}

export const usePriceStore = defineStore("price", () => {
  const data = reactive<Persisted>(load());

  const versions = computed(() => data.versions);
  const audit = computed(() => data.audit);

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ versions: data.versions, audit: data.audit }));
  }

  function pushAudit(entry: Omit<AuditEntry, "id" | "at">, at: string) {
    data.audit.push({ ...entry, id: crypto.randomUUID(), at });
  }

  /** 新建价格版本（含补录修订）。成功返回 null，失败返回错误信息。 */
  function addVersion(input: VersionInput): string | null {
    const fuel = input.fuel.trim();
    if (!(FUELS as readonly string[]).includes(fuel)) return "请选择油品";
    const price = Number(input.price);
    if (!Number.isFinite(price) || price <= 0) return "挂牌价必须大于 0";
    const iso = normalize(input.effectiveAt);
    if (!iso) return "生效时刻无效";
    const reason = input.reason.trim();
    if (!reason) return "补录或调价必须填写原因，只能新增修订版本，不能改写已生效历史";
    const operator = input.operator.trim() || "未署名";

    const chain = activeChain(data.versions, fuel);
    if (chain.some((v) => v.effectiveAt === iso)) {
      return "同一油品在相同生效时刻已存在版本，版本区间不得重叠";
    }

    const at = new Date().toISOString();
    const version: PriceVersion = {
      id: crypto.randomUUID(),
      fuel,
      price: Math.round(price * 100) / 100,
      effectiveAt: iso,
      reason,
      operator,
      createdAt: at,
      revokedAt: null,
      revokeReason: "",
    };
    data.versions.push(version);

    const backfill = iso <= at;
    pushAudit(
      {
        action: backfill ? "补录修订" : "新建版本",
        fuel,
        versionId: version.id,
        operator,
        detail: `${backfill ? "补录修订版本" : "新建版本"}：${fmtPrice(version.price)}，生效时刻 ${fmtTime(iso)}；原因：${reason}`,
      },
      at
    );
    persist();
    return null;
  }

  /** 未来版本改期。成功返回 null，失败返回错误信息。 */
  function reschedule(id: string, nextEffectiveAt: string, operator: string): string | null {
    const version = data.versions.find((v) => v.id === id);
    if (!version || version.revokedAt) return "版本不存在或已撤销";
    const at = new Date().toISOString();
    if (version.effectiveAt <= at) return "仅待生效的未来版本可以改期，已生效历史不可改写";
    const iso = normalize(nextEffectiveAt);
    if (!iso) return "新的生效时刻无效";
    if (iso <= at) return "改期后的生效时刻必须晚于当前时间";

    const chain = activeChain(data.versions, version.fuel).filter((v) => v.id !== id);
    if (chain.some((v) => v.effectiveAt === iso)) {
      return "同一油品在相同生效时刻已存在版本，版本区间不得重叠";
    }

    const before = version.effectiveAt;
    version.effectiveAt = iso;
    pushAudit(
      {
        action: "改期",
        fuel: version.fuel,
        versionId: id,
        operator: operator.trim() || "未署名",
        detail: `改期：${fmtPrice(version.price)} 的生效时刻由 ${fmtTime(before)} 调整为 ${fmtTime(iso)}`,
      },
      at
    );
    persist();
    return null;
  }

  /** 撤销当前版本或未来版本；撤销当前版本后自动回落到上一版本。 */
  function revoke(id: string, reason: string, operator: string): string | null {
    const version = data.versions.find((v) => v.id === id);
    if (!version || version.revokedAt) return "版本不存在或已撤销";
    const at = new Date().toISOString();

    const chain = activeChain(data.versions, version.fuel);
    const current = currentAt(chain, at);
    const isFuture = version.effectiveAt > at;
    if (!isFuture && current?.id !== version.id) {
      return "已生效的历史版本不可撤销，请通过补录修订版本更正";
    }

    version.revokedAt = at;
    version.revokeReason = reason.trim();

    const fallback = currentAt(activeChain(data.versions, version.fuel), at);
    const fallbackText = isFuture
      ? ""
      : fallback
        ? `；当前价回落至 ${fmtPrice(fallback.price)}（${fmtTime(fallback.effectiveAt)} 起版本）`
        : "；该油品当前未定价";
    pushAudit(
      {
        action: "撤销",
        fuel: version.fuel,
        versionId: id,
        operator: operator.trim() || "未署名",
        detail:
          `撤销${isFuture ? "待生效" : "当前"}版本：${fmtPrice(version.price)}（生效时刻 ${fmtTime(version.effectiveAt)}）` +
          (version.revokeReason ? `；说明：${version.revokeReason}` : "") +
          fallbackText,
      },
      at
    );
    persist();
    return null;
  }

  return { versions, audit, addVersion, reschedule, revoke };
});
