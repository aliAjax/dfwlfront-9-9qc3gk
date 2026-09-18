import { createPinia, setActivePinia } from "pinia";
import { usePricingStore, type NewVersionInput } from "../src/pricing/store";
import { localInputToIso } from "../src/pricing/time";

// ---- localStorage stub ----
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k)
};

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function expectThrow(fn: () => void, fragment: string, msg: string) {
  try {
    fn();
    ok(false, `${msg}（预期抛出含「${fragment}」的错误）`);
  } catch (e) {
    ok((e as Error).message.includes(fragment), `${msg}，实际错误：${(e as Error).message}`);
  }
}

function freshStore(now = new Date("2026-09-18T10:00:00+08:00").getTime()) {
  mem.clear();
  setActivePinia(createPinia());
  const store = usePricingStore();
  store.hydrate();
  store.nowMs = now;
  return store;
}

const iso = (s: string) => localInputToIso(s);

// ================= 1. 种子数据：当前价 / 待生效 / 未定价 =================
{
  const s = freshStore();
  console.log("1. 种子数据");
  ok(s.currentVersion("92号汽油")?.price === 7.62, "92号当前价为 7.62");
  ok(s.currentVersion("95号汽油")?.price === 8.11, "95号当前价为 8.11");
  ok(s.currentVersion("乙醇汽油") === null, "乙醇汽油未定价（无已生效版本）");
  const pend = s.pendingVersions("92号汽油");
  ok(pend.length === 1 && pend[0].price === 7.78, "92号有 1 个待生效版本 7.78");
  ok(s.pendingVersions("柴油").length === 0, "柴油无待生效版本");
}

// ================= 2. 排期 + 区间不重叠 =================
{
  const s = freshStore();
  console.log("2. 排期与不重叠校验");
  const input: NewVersionInput = {
    fuel: "95号汽油",
    price: 8.35,
    effectiveIso: iso("2026-09-25T00:00"),
    kind: "scheduled",
    reason: "接通知调价",
    operator: "站长"
  };
  s.createVersion(input);
  ok(s.pendingVersions("95号汽油").some((v) => v.price === 8.35), "未来版本进入待生效列表");
  ok(s.currentVersion("95号汽油")?.price === 8.11, "排期不影响当前价");

  expectThrow(
    () => s.createVersion({ ...input, price: 8.4 }),
    "不得重叠",
    "同油品同一生效时刻必须拒绝"
  );
  expectThrow(
    () => s.createVersion({ ...input, effectiveIso: iso("2026-09-26T00:00"), reason: "" }),
    "调价依据",
    "排期缺少依据必须拒绝"
  );
  expectThrow(
    () => s.createVersion({ ...input, effectiveIso: iso("2026-09-26T00:00"), price: -1 }),
    "大于 0",
    "非法价格必须拒绝"
  );
  // 撤销后同时刻允许重新排期
  const p = s.pendingVersions("95号汽油").find((v) => v.price === 8.35)!;
  s.revoke(p.id, "站长", "通知取消", false);
  s.createVersion({ ...input });
  ok(true, "撤销后同一时刻可重新排期");
}

// ================= 3. 时钟跨过边界：待生效自动成为当前价 =================
{
  const s = freshStore();
  console.log("3. 时间边界推进");
  ok(s.currentVersion("92号汽油")?.price === 7.62, "推进前当前价 7.62");
  s.nowMs = new Date("2026-09-22T00:00:00+08:00").getTime();
  ok(s.currentVersion("92号汽油")?.price === 7.78, "跨过生效时刻后自动变为 7.78");
  ok(s.pendingVersions("92号汽油").length === 0, "原待生效版本自动出队");
}

// ================= 4. 撤销当前价：回落到上一版本，再撤销则未定价 =================
{
  const s = freshStore();
  console.log("4. 撤销当前价回落");
  const cur = s.currentVersion("92号汽油")!;
  ok(cur.price === 7.62, "当前 7.62");
  s.revoke(cur.id, "站长", "价格录入错误", true);
  const after = s.currentVersion("92号汽油");
  ok(after?.price === 7.42, "撤销后回落到上一版本 7.42");
  ok(!!s.versions.find((v) => v.id === cur.id)?.revokedAt, "被撤销版本仍保留并带撤销标记");

  const prev = s.currentVersion("92号汽油")!;
  s.revoke(prev.id, "站长", "老价格同样作废", true);
  ok(s.currentVersion("92号汽油") === null, "再撤销上一版本后显示未定价");
  ok(s.pendingVersions("92号汽油").length === 1, "待生效的 7.78 不受影响");

  // 历史（被取代且已撤销）版本不允许再撤销
  expectThrow(
    () => s.revoke(cur.id, "站长", "重复撤销", true),
    "已撤销",
    "重复撤销必须拒绝"
  );

  // 柴油只有一个当前版本：直接撤销即未定价
  const d = s.currentVersion("柴油")!;
  s.revoke(d.id, "值班经理", "临时撤价", true);
  ok(s.currentVersion("柴油") === null, "无上一版本时撤销当前价 → 未定价");
}

// ================= 5. 已生效历史不可改期；待生效可改期 =================
{
  const s = freshStore();
  console.log("5. 改期规则");
  const cur = s.currentVersion("92号汽油")!;
  expectThrow(
    () => s.reschedule(cur.id, iso("2026-10-01T00:00"), "站长", ""),
    "已生效",
    "已生效版本不能改期"
  );

  const p = s.pendingVersions("92号汽油")[0];
  s.reschedule(p.id, iso("2026-10-01T08:00"), "站长", "文件延期");
  ok(
    s.pendingVersions("92号汽油")[0].effectiveAt === iso("2026-10-01T08:00"),
    "待生效版本改期成功"
  );
  // 改期后仍按新生效时刻排序
  s.reschedule(p.id, iso("2026-09-19T08:00"), "站长", "提前执行");
  ok(
    s.pendingVersions("92号汽油")[0].effectiveAt === iso("2026-09-19T08:00"),
    "改期为更早时刻后顺序仍正确"
  );
  // 改期到另一个版本的时刻 → 冲突
  const other = s.createVersion({
    fuel: "92号汽油",
    price: 7.9,
    effectiveIso: iso("2026-12-01T00:00"),
    kind: "scheduled",
    reason: "年底调价",
    operator: "站长"
  });
  expectThrow(
    () => s.reschedule(p.id, iso("2026-12-01T00:00"), "站长", ""),
    "不得重叠",
    "改期到已占用时刻必须拒绝"
  );
  // 改期到过去 → 立即成为当前价
  s.reschedule(other.id, iso("2026-09-17T00:00"), "站长", "补生效");
  // other 现在已是已生效版本（在 7.62 之后），应成为当前
  ok(s.currentVersion("92号汽油")?.id === other.id, "改期到过去的版本立即成为当前价");
  ok(s.currentVersion("92号汽油")?.price === 7.9, "当前价即时一致（7.9）");
}

// ================= 6. 补录修订：只增不改，带原因 =================
{
  const s = freshStore();
  console.log("6. 补录修订");
  const original = s.currentVersion("92号汽油")!;
  const snapshotPrice = original.price;
  const snapshotAt = original.effectiveAt;

  expectThrow(
    () =>
      s.createVersion({
        fuel: "92号汽油",
        price: 7.55,
        effectiveIso: iso("2026-08-25T00:00"),
        kind: "revision",
        reason: "",
        operator: "站长"
      }),
    "必须填写原因",
    "补录修订无原因必须拒绝"
  );

  s.createVersion({
    fuel: "92号汽油",
    price: 7.55,
    effectiveIso: iso("2026-07-01T00:00"),
    kind: "revision",
    reason: "原录入价格有误，依据调价文件补录",
    operator: "站长"
  });

  const untouched = s.versions.find((v) => v.id === original.id)!;
  ok(untouched.price === snapshotPrice && untouched.effectiveAt === snapshotAt, "已生效历史版本字段未被改写");
  ok(s.currentVersion("92号汽油")?.id === original.id, "补录到历史区间（7.42 与 7.62 之间）不改变当前价");
  ok(
    s.fuelTimeline("92号汽油").some((v) => v.kind === "revision" && v.price === 7.55),
    "修订版本出现在时间线中并标记为补录"
  );

  // 补录一个 5 分钟前的修订 → 立即成为当前价
  const now = s.nowMs;
  const fiveMinAgo = new Date(now - 5 * 60_000).toISOString();
  s.createVersion({
    fuel: "95号汽油",
    price: 8.2,
    effectiveIso: fiveMinAgo,
    kind: "revision",
    reason: "紧急调价文件补录",
    operator: "值班经理"
  });
  ok(s.currentVersion("95号汽油")?.price === 8.2, "补录到当前时刻之前立即生效为当前价");
}

// ================= 7. 撤销待生效版本 =================
{
  const s = freshStore();
  console.log("7. 撤销待生效版本");
  const p = s.pendingVersions("92号汽油")[0];
  expectThrow(() => s.revoke(p.id, "站长", "", false), "撤销必须填写原因", "无原因撤销必须拒绝");
  s.revoke(p.id, "站长", "总部通知暂缓", false);
  ok(s.pendingVersions("92号汽油").length === 0, "撤销后待生效列表为空");
  ok(s.currentVersion("92号汽油")?.price === 7.62, "撤销未来版本不影响当前价");
  expectThrow(
    () => s.reschedule(p.id, iso("2026-12-01T00:00"), "站长", ""),
    "已撤销",
    "已撤销版本不能改期"
  );
}

// ================= 8. 审计记录 + 持久化（刷新后一致） =================
{
  const s = freshStore();
  console.log("8. 审计与持久化");
  s.createVersion({
    fuel: "柴油",
    price: 7.25,
    effectiveIso: iso("2026-10-01T00:00"),
    kind: "scheduled",
    reason: "10 月调价",
    operator: "值班经理"
  });
  const pend = s.pendingVersions("柴油")[0];
  s.reschedule(pend.id, iso("2026-10-02T00:00"), "值班经理", "延期一天");
  s.revoke(pend.id, "值班经理", "计划取消", false);

  const actions = s.audit.map((a) => a.action);
  ok(actions[0] === "revoke" && actions[1] === "reschedule" && actions[2] === "create", "审计按时间倒序追加");
  const rs = s.audit.find((a) => a.action === "reschedule")!;
  ok(!!rs.before && !!rs.after && rs.before !== rs.after, "改期审计记录前后值");
  const rv = s.audit.find((a) => a.action === "revoke")!;
  ok(rv.after === null && rv.detail.includes("计划取消"), "撤销审计记录原因与回落语义");

  const raw = localStorage.getItem("dfwlfront-9-pricing-v1");
  ok(!!raw, "数据已写入 localStorage");

  // 模拟刷新：新 pinia、新 store 实例重新 hydrate
  setActivePinia(createPinia());
  const s2 = usePricingStore();
  s2.hydrate();
  s2.nowMs = new Date("2026-09-18T10:00:00+08:00").getTime();
  ok(s2.currentVersion("92号汽油")?.price === 7.62, "刷新后当前价一致");
  ok(s2.currentVersion("乙醇汽油") === null, "刷新后未定价状态保持");
  ok(
    s2.pendingVersions("柴油").length === 0 &&
      s2.versions.some((v) => v.id === pend.id && v.revokedAt),
    "刷新后撤销状态保持"
  );
  ok(s2.audit.length === s.audit.length, "刷新后审计记录完整");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
