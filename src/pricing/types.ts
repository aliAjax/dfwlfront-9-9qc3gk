/** 版本来源：排期新建 或 补录修订（补录必须带原因，且只新增不改写历史） */
export type VersionKind = "scheduled" | "revision";

/** 油品价格版本：同一油品按 effectiveAt 排序构成互不重叠的半开区间 [effectiveAt, next.effectiveAt) */
export interface PriceVersion {
  id: string;
  fuel: string;
  /** 挂牌价（元/升） */
  price: number;
  /** 生效时刻，ISO 字符串 */
  effectiveAt: string;
  kind: VersionKind;
  /** 原因/依据：补录修订必填，排期可填调价依据 */
  reason: string;
  operator: string;
  /** 录入时刻（审计用，不等于生效时刻） */
  createdAt: string;
  /** 撤销时刻；非空表示该版本已被撤销（审计留痕，记录不删除） */
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export type AuditAction = "create" | "revision" | "reschedule" | "revoke";

/** 只追加、不可变的审计记录 */
export interface AuditEntry {
  id: string;
  at: string;
  action: AuditAction;
  fuel: string;
  versionId: string | null;
  operator: string;
  detail: string;
  /** 改期等操作的前值/后值 */
  before: string | null;
  after: string | null;
}

export interface PricingState {
  versions: PriceVersion[];
  audit: AuditEntry[];
}
