import { defineStore } from "pinia";
import { FUELS } from "./constants";
import type {
  AuditAction,
  AuditEntry,
  PriceVersion,
  PricingState
} from "./types";

const STORAGE_KEY = "dfwlfront-9-pricing-v1";

function uid(): string {
  return crypto.randomUUID();
}

/** 同一油品当前有效（未撤销）版本，按生效时刻升序 */
function activeSorted(versions: PriceVersion[], fuel: string): PriceVersion[] {
  return versions
    .filter((v) => v.fuel === fuel && !v.revokedAt)
    .sort((a, b) => +new Date(a.effectiveAt) - +new Date(b.effectiveAt));
}

export interface NewVersionInput {
  fuel: string;
  price: number;
  effectiveIso: string;
  kind: "scheduled" | "revision";
  reason: string;
  operator: string;
}

function seedState(): PricingState {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();
  const mk = (
    fuel: string,
    price: number,
    offsetMs: number,
    reason: string,
    operator = "站长"
  ): PriceVersion => ({
    id: uid(),
    fuel,
    price,
    effectiveAt: iso(offsetMs),
    kind: "scheduled",
    reason,
    operator,
    createdAt: iso(offsetMs + 60_000),
    revokedAt: null,
    revokedBy: null,
    revokeReason: null
  });

  // 当前时间 2026-09：包含历史版本（可验证回落）、当前价、待生效未来版本
  const versions: PriceVersion[] = [
    mk("92号汽油", 7.42, 120 * 86_400_000, "上一周期调价"),
    mk("92号汽油", 7.62, 30 * 86_400_000, "本月正常调价"),
    mk("95号汽油", 8.11, 30 * 86_400_000, "本月正常调价"),
    mk("98号汽油", 9.05, 30 * 86_400_000, "本月正常调价"),
    mk("柴油", 7.18, 30 * 86_400_000, "本月正常调价", "值班经理"),
    // 待生效：92 号三天后涨价；乙醇汽油保持「未定价」
    mk("92号汽油", 7.78, -3 * 86_400_000, "接通知待调价")
  ];
  versions[5].createdAt = new Date(now - 86_400_000).toISOString();

  return {
    versions,
    audit: [
      {
        id: uid(),
        at: new Date(now - 31 * 86_400_000).toISOString(),
        action: "create",
        fuel: "92号汽油",
        versionId: versions[1].id,
        operator: "站长",
        detail: "录入价格版本 7.62 元/升",
        before: null,
        after: "7.62"
      },
      {
        id: uid(),
        at: new Date(now - 86_400_000).toISOString(),
        action: "create",
        fuel: "92号汽油",
        versionId: versions[5].id,
        operator: "站长",
        detail: "排期待生效版本 7.78 元/升",
        before: null,
        after: "7.78"
      }
    ]
  };
}

function loadState(): PricingState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seedState();
  try {
    const parsed = JSON.parse(raw) as PricingState;
    if (!Array.isArray(parsed.versions) || !Array.isArray(parsed.audit)) {
      return seedState();
    }
    return parsed;
  } catch {
    return seedState();
  }
}

export const usePricingStore = defineStore("pricing", {
  state: () => ({
    versions: [] as PriceVersion[],
    audit: [] as AuditEntry[],
    /** 当前时钟（毫秒），由 App 每秒驱动，保证跨过生效边界后视图立即一致 */
    nowMs: Date.now(),
    hydrated: false
  }),

  getters: {
    /** 当前已生效的最新版本（未撤销） */
    currentVersion(state) {
      return (fuel: string, at: number = state.nowMs): PriceVersion | null => {
        let result: PriceVersion | null = null;
        for (const v of activeSorted(state.versions, fuel)) {
          if (+new Date(v.effectiveAt) <= at) result = v;
          else break;
        }
        return result;
      };
    },

    /** 待生效的未来版本（按生效时刻升序） */
    pendingVersions(state) {
      return (fuel: string, at: number = state.nowMs): PriceVersion[] =>
        activeSorted(state.versions, fuel).filter(
          (v) => +new Date(v.effectiveAt) > at
        );
    },

    /** 同一油品的全部版本（含已撤销），按生效时刻倒序，供版本/审计时间线展示 */
    fuelTimeline(state) {
      return (fuel: string): PriceVersion[] =>
        state.versions
          .filter((v) => v.fuel === fuel)
          .sort((a, b) => +new Date(b.effectiveAt) - +new Date(a.effectiveAt));
    },

    fuels() {
      return [...FUELS];
    }
  },

  actions: {
    hydrate() {
      if (this.hydrated) return;
      const state = loadState();
      this.versions = state.versions;
      this.audit = state.audit;
      this.hydrated = true;
    },

    tick() {
      this.nowMs = Date.now();
    },

    persist() {
      const payload: PricingState = {
        versions: this.versions,
        audit: this.audit
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    },

    resetAll() {
      const state = seedState();
      this.versions = state.versions;
      this.audit = state.audit;
      this.persist();
    },

    addAudit(entry: {
      action: AuditAction;
      fuel: string;
      versionId: string | null;
      operator: string;
      detail: string;
      before?: string | null;
      after?: string | null;
    }) {
      this.audit.unshift({
        id: uid(),
        at: new Date(this.nowMs).toISOString(),
        before: null,
        after: null,
        ...entry
      });
    },

    /**
     * 新建版本：排期（未来）或补录修订（任意时刻，必须带原因）。
     * 校验：同一油品有效版本的生效时刻不得相同（区间不得重叠）。
     * 已生效历史永不改写 —— 补录只会插入一个新版本。
     */
    createVersion(input: NewVersionInput): PriceVersion {
      const price = Number(input.price);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error("挂牌价必须为大于 0 的数字");
      }
      if (!input.operator.trim()) throw new Error("请填写操作员");
      if (!input.reason.trim()) {
        throw new Error(
          input.kind === "revision" ? "补录修订必须填写原因" : "请填写调价依据"
        );
      }
      const at = +new Date(input.effectiveIso);
      if (!Number.isFinite(at)) throw new Error("生效时刻无效");

      const conflict = activeSorted(this.versions, input.fuel).find(
        (v) => +new Date(v.effectiveAt) === at
      );
      if (conflict) {
        throw new Error("该时刻已存在有效版本，版本区间不得重叠");
      }

      const version: PriceVersion = {
        id: uid(),
        fuel: input.fuel,
        price,
        effectiveAt: new Date(at).toISOString(),
        kind: input.kind,
        reason: input.reason.trim(),
        operator: input.operator.trim(),
        createdAt: new Date(this.nowMs).toISOString(),
        revokedAt: null,
        revokedBy: null,
        revokeReason: null
      };
      this.versions.push(version);

      const isFuture = at > this.nowMs;
      this.addAudit({
        action: input.kind === "revision" ? "revision" : "create",
        fuel: input.fuel,
        versionId: version.id,
        operator: version.operator,
        detail:
          input.kind === "revision"
            ? `补录修订版本 ${price} 元/升（原因：${version.reason}）`
            : isFuture
              ? `排期${isFutureLabel(at, this.nowMs)}生效版本 ${price} 元/升`
              : `录入价格版本 ${price} 元/升`,
        after: `${price}`
      });

      this.persist();
      return version;
    },

    /**
     * 改期：仅允许未来（待生效）版本调整生效时刻。
     * 已生效版本的时间边界不可改动。
     */
    reschedule(
      versionId: string,
      newLocalIso: string,
      operator: string,
      reason: string
    ) {
      const v = this.versions.find((x) => x.id === versionId);
      if (!v) throw new Error("版本不存在");
      if (v.revokedAt) throw new Error("版本已撤销，不能改期");
      const oldAt = +new Date(v.effectiveAt);
      if (oldAt <= this.nowMs) {
        throw new Error("版本已生效，时间边界不可调整（如需修正请补录修订版本）");
      }
      if (!operator.trim()) throw new Error("请填写操作员");

      const newAt = +new Date(newLocalIso);
      if (!Number.isFinite(newAt)) throw new Error("新生效时刻无效");
      if (newAt === oldAt) throw new Error("新生效时刻与原时刻相同");

      const clash = activeSorted(this.versions, v.fuel).find(
        (other) =>
          other.id !== v.id && +new Date(other.effectiveAt) === newAt
      );
      if (clash) throw new Error("目标时刻已存在有效版本，区间不得重叠");

      const beforeIso = v.effectiveAt;
      v.effectiveAt = new Date(newAt).toISOString();

      // 改期后若新时刻已落在过去（时钟刚跨过边界），它立即转为当前价；
      // 当前价/待生效价均由 getter 按 nowMs 实时推导，天然保持一致。
      const becameCurrent = newAt <= this.nowMs;
      this.addAudit({
        action: "reschedule",
        fuel: v.fuel,
        versionId: v.id,
        operator: operator.trim(),
        detail:
          `生效时刻改期${becameCurrent ? "（新时刻已到，即时生效）" : ""}` +
          (reason.trim() ? `；说明：${reason.trim()}` : ""),
        before: beforeIso,
        after: v.effectiveAt
      });
      this.persist();
    },

    /**
     * 撤销：仅允许未来（待生效）版本。
     * 当前生效版本的撤销 = 立即回落到上一版本；没有上一版本则显示「未定价」。
     * 撤销不删除记录，仅打标记并写审计。
     */
    revoke(
      versionId: string,
      operator: string,
      reason: string,
      allowCurrent: boolean
    ) {
      const v = this.versions.find((x) => x.id === versionId);
      if (!v) throw new Error("版本不存在");
      if (v.revokedAt) throw new Error("版本已撤销");
      if (!operator.trim()) throw new Error("请填写操作员");
      if (!reason.trim()) throw new Error("撤销必须填写原因");

      const at = +new Date(v.effectiveAt);
      const isFuture = at > this.nowMs;
      const isCurrent =
        !isFuture && this.currentVersion(v.fuel)?.id === v.id;

      if (isFuture) {
        // 待生效版本：直接撤销
      } else if (isCurrent && allowCurrent) {
        // 当前版本：撤销后回落到上一版本
      } else {
        throw new Error("已被取代的历史版本不能撤销（历史不可改写）");
      }

      v.revokedAt = new Date(this.nowMs).toISOString();
      v.revokedBy = operator.trim();
      v.revokeReason = reason.trim();

      this.addAudit({
        action: "revoke",
        fuel: v.fuel,
        versionId: v.id,
        operator: operator.trim(),
        detail: isFuture
          ? `撤销待生效版本 ${v.price} 元/升；原因：${reason.trim()}`
          : `撤销当前版本 ${v.price} 元/升，回落到上一版本（无则未定价）；原因：${reason.trim()}`,
        before: `${v.price}`,
        after: null
      });
      this.persist();
    }
  }
});

function isFutureLabel(at: number, now: number): string {
  const days = Math.round((at - now) / 86_400_000);
  return days >= 1 ? `${days} 天后` : "未来";
}
