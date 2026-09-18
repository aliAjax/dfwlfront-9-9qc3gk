<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { usePricingStore } from "./pricing/store";
import { FUELS } from "./pricing/constants";
import type { AuditEntry, PriceVersion } from "./pricing/types";
import {
  dateToLocalInput,
  defaultFutureInput,
  defaultPastInput,
  fmtDateTime,
  isoToLocalInput,
  localInputToIso
} from "./pricing/time";

const store = usePricingStore();
store.hydrate();

let timer: number | undefined;
onMounted(() => {
  timer = window.setInterval(() => store.tick(), 1000);
});
onUnmounted(() => {
  if (timer) window.clearInterval(timer);
});

/* ---------------- 新建 / 补录表单 ---------------- */

const form = reactive({
  fuel: FUELS[0] as string,
  price: "",
  effectiveInput: defaultFutureInput(store.nowMs),
  kind: "scheduled" as "scheduled" | "revision",
  reason: "",
  operator: "站长"
});
const formError = ref("");
const formOk = ref("");

watch(
  () => form.kind,
  (kind) => {
    form.effectiveInput =
      kind === "revision"
        ? defaultPastInput(store.nowMs)
        : defaultFutureInput(store.nowMs);
  }
);

const kindHint = computed(() =>
  form.kind === "revision"
    ? "补录只新建带原因的修订版本，绝不改写任何已生效历史。"
    : "排期一个未来时刻生效的新版本；到点自动成为挂牌价。"
);

function submitCreate() {
  formError.value = "";
  formOk.value = "";
  try {
    const v = store.createVersion({
      fuel: form.fuel,
      price: Number(form.price),
      effectiveIso: localInputToIso(form.effectiveInput),
      kind: form.kind,
      reason: form.reason,
      operator: form.operator
    });
    formOk.value = `已${form.kind === "revision" ? "补录修订" : "排期"}：${v.price} 元/升，${fmtDateTime(v.effectiveAt)} 生效`;
    form.price = "";
    form.reason = "";
  } catch (e) {
    formError.value = (e as Error).message;
  }
}

/* ---------------- 油品视图模型 ---------------- */

interface FuelView {
  fuel: string;
  current: PriceVersion | null;
  pending: PriceVersion[];
  timeline: PriceVersion[];
}

const fuelViews = computed<FuelView[]>(() =>
  FUELS.map((fuel) => ({
    fuel,
    current: store.currentVersion(fuel),
    pending: store.pendingVersions(fuel),
    timeline: store.fuelTimeline(fuel)
  }))
);

const metrics = computed(() => {
  const priced = fuelViews.value.filter((f) => f.current).length;
  const pending = fuelViews.value.reduce((acc, f) => acc + f.pending.length, 0);
  const prices = fuelViews.value
    .map((f) => f.current?.price)
    .filter((p): p is number => typeof p === "number");
  const avg = prices.length
    ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)
    : "—";
  return [
    { label: "已定价 / 油品总数", value: `${priced} / ${FUELS.length}` },
    { label: "未定价油品", value: FUELS.length - priced },
    { label: "待生效版本", value: pending },
    { label: "平均当前挂牌价", value: avg === "—" ? "—" : `${avg} 元/升` }
  ];
});

function versionState(v: PriceVersion, view: FuelView): string {
  if (v.revokedAt) return "revoked";
  if (+new Date(v.effectiveAt) > store.nowMs) return "pending";
  if (view.current?.id === v.id) return "current";
  return "history";
}

const stateMeta: Record<string, { text: string; cls: string }> = {
  current: { text: "当前生效", cls: "b-current" },
  pending: { text: "待生效", cls: "b-pending" },
  history: { text: "历史版本", cls: "b-history" },
  revoked: { text: "已撤销", cls: "b-revoked" }
};

const expanded = reactive<Record<string, boolean>>({});

/* ---------------- 改期 / 撤销弹窗 ---------------- */

interface ModalState {
  mode: "reschedule" | "revoke";
  fuel: string;
  version: PriceVersion;
  isCurrent: boolean;
  effectiveInput: string;
  operator: string;
  reason: string;
}
const modal = ref<ModalState | null>(null);
const modalError = ref("");

function openReschedule(view: FuelView, v: PriceVersion) {
  modalError.value = "";
  modal.value = {
    mode: "reschedule",
    fuel: view.fuel,
    version: v,
    isCurrent: false,
    effectiveInput: isoToLocalInput(v.effectiveAt),
    operator: form.operator,
    reason: ""
  };
}

function openRevoke(view: FuelView, v: PriceVersion, isCurrent: boolean) {
  modalError.value = "";
  modal.value = {
    mode: "revoke",
    fuel: view.fuel,
    version: v,
    isCurrent,
    effectiveInput: "",
    operator: form.operator,
    reason: ""
  };
}

function closeModal() {
  modal.value = null;
}

function confirmModal() {
  const m = modal.value;
  if (!m) return;
  modalError.value = "";
  try {
    if (m.mode === "reschedule") {
      store.reschedule(
        m.version.id,
        localInputToIso(m.effectiveInput),
        m.operator,
        m.reason
      );
    } else {
      store.revoke(m.version.id, m.operator, m.reason, m.isCurrent);
    }
    modal.value = null;
  } catch (e) {
    modalError.value = (e as Error).message;
  }
}

/* ---------------- 审计 ---------------- */

const actionMeta: Record<AuditEntry["action"], { text: string; cls: string }> = {
  create: { text: "排期/录入", cls: "a-create" },
  revision: { text: "补录修订", cls: "a-revision" },
  reschedule: { text: "改期", cls: "a-reschedule" },
  revoke: { text: "撤销", cls: "a-revoke" }
};

function auditChange(e: AuditEntry): string {
  if (e.action === "reschedule" && e.before && e.after) {
    return `${fmtDateTime(e.before)} → ${fmtDateTime(e.after)}`;
  }
  if (e.before || e.after) {
    return `${e.before ?? "（无）"} → ${e.after ?? "（撤销/回落）"}`;
  }
  return "";
}

function resetAll() {
  if (window.confirm("确定恢复演示数据？本地保存的全部版本与审计记录将被重置。")) {
    store.resetAll();
  }
}

function hasPrev(view: FuelView): boolean {
  const cur = view.current;
  if (!cur) return false;
  return store.versions.some(
    (v) =>
      v.fuel === view.fuel &&
      !v.revokedAt &&
      +new Date(v.effectiveAt) < +new Date(cur.effectiveAt)
  );
}

const nowLabel = computed(() =>
  dateToLocalInput(new Date(store.nowMs)).replace("T", " ")
);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 价格版本管理</p>
          <h1>油品挂牌价维护</h1>
          <p class="subtitle">
            每种油品维护按生效时刻排序、互不重叠的价格版本：当前挂牌价取已生效的最新版本，
            未来版本可改期或撤销；撤销当前版本回落到上一版本，没有上一版本则显示「未定价」。
          </p>
        </div>
        <div class="clock">
          <span class="clock-label">系统时刻（每秒校准）</span>
          <strong>{{ nowLabel }}</strong>
          <button class="secondary btn-sm" type="button" @click="resetAll">恢复演示数据</button>
        </div>
      </header>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <!-- 排期 / 补录 -->
        <form class="panel" @submit.prevent="submitCreate">
          <h2>排期新版本 / 补录修订</h2>
          <div class="seg">
            <label
              :class="{ active: form.kind === 'scheduled' }"
              @click="form.kind = 'scheduled'"
            >
              <input v-model="form.kind" type="radio" value="scheduled" hidden />
              排期（未来生效）
            </label>
            <label
              :class="{ active: form.kind === 'revision' }"
              @click="form.kind = 'revision'"
            >
              <input v-model="form.kind" type="radio" value="revision" hidden />
              补录修订（新建版本）
            </label>
          </div>
          <p class="hint">{{ kindHint }}</p>

          <div class="form-grid">
            <label>
              油品
              <select v-model="form.fuel" required>
                <option v-for="f in FUELS" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>
            <label>
              挂牌价（元/升）
              <input v-model="form.price" type="number" step="0.01" min="0.01" placeholder="例如 7.68" required />
            </label>
            <label>
              生效时刻
              <input v-model="form.effectiveInput" type="datetime-local" required />
            </label>
            <label>
              操作员
              <input v-model="form.operator" type="text" required />
            </label>
            <label>
              {{ form.kind === "revision" ? "修订原因（必填）" : "调价依据（必填）" }}
              <textarea
                v-model="form.reason"
                :placeholder="form.kind === 'revision'
                  ? '说明为何补录，例如：原录入价格有误，依据调价文件补录'
                  : '说明调价依据，例如：接总部 9 月调价通知'"
                required
              />
            </label>
            <button type="submit">
              {{ form.kind === "revision" ? "新建修订版本" : "排期生效" }}
            </button>
            <p v-if="formError" class="alert err">{{ formError }}</p>
            <p v-if="formOk" class="alert ok">{{ formOk }}</p>
          </div>
        </form>

        <!-- 油品卡片 -->
        <section class="list-panel">
          <div class="toolbar">
            <h2>各油品价格版本</h2>
          </div>

          <div class="fuel-grid">
            <article v-for="view in fuelViews" :key="view.fuel" class="fuel-card">
              <div class="fuel-head">
                <p class="fuel-name">{{ view.fuel }}</p>
                <span v-if="view.current" class="badge b-current">当前生效</span>
                <span v-else class="badge b-none">未定价</span>
              </div>

              <div class="price-line">
                <template v-if="view.current">
                  <strong class="price">{{ view.current.price.toFixed(2) }}</strong>
                  <span class="unit">元/升</span>
                  <span class="eff">自 {{ fmtDateTime(view.current.effectiveAt) }} 起</span>
                </template>
                <template v-else>
                  <strong class="price none">未定价</strong>
                  <span class="eff">尚无已生效版本，请排期或补录</span>
                </template>
              </div>

              <p v-if="view.current" class="reason-line">
                {{ view.current.kind === "revision" ? "修订" : "依据" }}：{{ view.current.reason }}
                <em>（{{ view.current.operator }}）</em>
              </p>

              <!-- 待生效 -->
              <div v-if="view.pending.length" class="pending-box">
                <p class="box-title">待生效（{{ view.pending.length }}）</p>
                <div v-for="v in view.pending" :key="v.id" class="pending-item">
                  <div>
                    <strong>{{ v.price.toFixed(2) }}</strong> 元/升
                    <span class="eff">{{ fmtDateTime(v.effectiveAt) }} 生效</span>
                    <span v-if="v.kind === 'revision'" class="mini-tag">修订</span>
                  </div>
                  <div class="row-actions">
                    <button class="btn-sm" type="button" @click="openReschedule(view, v)">改期</button>
                    <button class="danger btn-sm" type="button" @click="openRevoke(view, v, false)">撤销</button>
                  </div>
                </div>
              </div>

              <!-- 当前版本操作 -->
              <div v-if="view.current" class="current-actions">
                <button class="danger btn-sm" type="button" @click="openRevoke(view, view.current!, true)">
                  撤销当前价（回落到上一版本{{ hasPrev(view) ? "" : "，将显示未定价" }}）
                </button>
              </div>

              <!-- 时间线 -->
              <button class="link-btn" type="button" @click="expanded[view.fuel] = !expanded[view.fuel]">
                {{ expanded[view.fuel] ? "收起版本时间线 ▴" : `查看全部版本（${view.timeline.length}）▾` }}
              </button>
              <ul v-if="expanded[view.fuel]" class="timeline">
                <li v-for="v in view.timeline" :key="v.id" :class="['tl-item', versionState(v, view)]">
                  <div class="tl-top">
                    <span class="badge" :class="stateMeta[versionState(v, view)].cls">
                      {{ stateMeta[versionState(v, view)].text }}
                    </span>
                    <strong>{{ v.price.toFixed(2) }} 元/升</strong>
                    <span class="eff">{{ fmtDateTime(v.effectiveAt) }} 生效</span>
                  </div>
                  <p class="tl-reason">
                    {{ v.kind === "revision" ? "补录修订" : "排期" }}：{{ v.reason }}
                    <em>· {{ v.operator }} · 录入于 {{ fmtDateTime(v.createdAt) }}</em>
                  </p>
                  <p v-if="v.revokedAt" class="tl-revoke">
                    已于 {{ fmtDateTime(v.revokedAt) }} 由 {{ v.revokedBy }} 撤销：{{ v.revokeReason }}
                  </p>
                </li>
              </ul>
            </article>
          </div>
        </section>
      </section>

      <!-- 审计记录 -->
      <section class="audit-panel">
        <div class="toolbar">
          <h2>审计记录（只追加，不可改写）</h2>
          <span class="audit-count">共 {{ store.audit.length }} 条</span>
        </div>
        <div v-if="store.audit.length === 0" class="empty">暂无审计记录</div>
        <ul v-else class="audit-list">
          <li v-for="e in store.audit" :key="e.id" class="audit-item">
            <span class="badge" :class="actionMeta[e.action].cls">{{ actionMeta[e.action].text }}</span>
            <div class="audit-body">
              <p>
                <strong>{{ e.fuel }}</strong> · {{ e.detail }}
              </p>
              <p v-if="auditChange(e)" class="audit-change">{{ auditChange(e) }}</p>
            </div>
            <span class="audit-meta">{{ fmtDateTime(e.at) }} · {{ e.operator }}</span>
          </li>
        </ul>
      </section>
    </div>

    <!-- 改期 / 撤销弹窗 -->
    <div v-if="modal" class="overlay" @click.self="closeModal">
      <div class="modal">
        <h3>
          {{ modal.mode === "reschedule" ? "版本改期" : "撤销版本" }}
          <span class="modal-fuel">{{ modal.fuel }} · {{ modal.version.price.toFixed(2) }} 元/升</span>
        </h3>

        <p v-if="modal.mode === 'reschedule'" class="modal-warn">
          原生效时刻：{{ fmtDateTime(modal.version.effectiveAt) }}。仅待生效版本可改期；
          调整后当前价、待生效价与审计立即一致，刷新后保持。
        </p>
        <p v-else-if="modal.isCurrent" class="modal-warn danger-text">
          正在撤销<strong>当前生效价</strong>，提交后挂牌价立即回落到上一版本；
          若不存在上一版本，该油品将显示「未定价」。此操作留痕且历史不可删除。
        </p>
        <p v-else class="modal-warn">
          撤销该待生效版本后，它不会在 {{ fmtDateTime(modal.version.effectiveAt) }} 生效。
        </p>

        <div class="form-grid">
          <label v-if="modal.mode === 'reschedule'">
            新生效时刻
            <input v-model="modal.effectiveInput" type="datetime-local" />
          </label>
          <label>
            操作员
            <input v-model="modal.operator" type="text" />
          </label>
          <label>
            {{ modal.mode === "reschedule" ? "改期说明" : "撤销原因（必填）" }}
            <textarea v-model="modal.reason" :placeholder="modal.mode === 'reschedule' ? '可选：说明改期原因' : '请填写撤销原因'" />
          </label>
          <p v-if="modalError" class="alert err">{{ modalError }}</p>
          <div class="modal-actions">
            <button class="secondary" type="button" @click="closeModal">取消</button>
            <button :class="{ danger: modal.mode === 'revoke' }" type="button" @click="confirmModal">
              确认{{ modal.mode === "reschedule" ? "改期" : "撤销" }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script lang="ts">
// 供模板内联判断当前版本是否还有上一版本（回落目标）
import type { FuelView as _FV } from "./App.vue";
function hasPrev(_view: _FV): boolean {
  return false;
}
export default {};
</script>
