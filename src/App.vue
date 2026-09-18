<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import {
  FUELS,
  activeChain,
  currentAt,
  fmtPrice,
  fmtTime,
  pendingAfter,
  toLocalInput,
  usePriceStore,
  type PriceVersion,
} from "./store";

const project = {
  title: "油品价格维护",
  subtitle:
    "为每种油品维护按生效时刻排序的价格版本：当前挂牌价取已生效的最新版本，未来版本可改期或撤销；补录只能新建带原因的修订版本，已生效历史不可改写。",
  industry: "石油",
  stack: ["Vue3", "Vite", "TypeScript", "Pinia", "Naive UI"],
};

const store = usePriceStore();

// 当前时间每秒推进，跨生效边界时当前价/待生效价自动切换
const now = ref(new Date().toISOString());
let timer = 0;
onMounted(() => {
  timer = window.setInterval(() => {
    now.value = new Date().toISOString();
  }, 1000);
});
onUnmounted(() => window.clearInterval(timer));

const operator = ref("站长");
const filter = ref("全部油品");

const form = reactive({
  fuel: "",
  price: null as number | null,
  effectiveAt: "",
  reason: "",
});
const formError = ref("");
const formNotice = ref("");

function submit() {
  formError.value = "";
  formNotice.value = "";
  const err = store.addVersion({
    fuel: form.fuel,
    price: form.price,
    effectiveAt: form.effectiveAt,
    reason: form.reason,
    operator: operator.value,
  });
  if (err) {
    formError.value = err;
    return;
  }
  formNotice.value = "价格版本已保存，当前价、待生效价与审计记录已同步更新。";
  form.price = null;
  form.effectiveAt = "";
  form.reason = "";
}

function chainOf(fuel: string) {
  return activeChain(store.versions, fuel);
}

function timelineOf(fuel: string) {
  return store.versions
    .filter((v) => v.fuel === fuel)
    .slice()
    .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || b.createdAt.localeCompare(a.createdAt));
}

const visibleFuels = computed(() =>
  filter.value === "全部油品" ? [...FUELS] : FUELS.filter((f) => f === filter.value)
);

const cards = computed(() =>
  visibleFuels.value.map((fuel) => {
    const chain = chainOf(fuel);
    return {
      fuel,
      current: currentAt(chain, now.value),
      next: pendingAfter(chain, now.value)[0] ?? null,
      timeline: timelineOf(fuel),
    };
  })
);

const metrics = computed(() => [
  { label: "油品数", value: FUELS.length },
  { label: "已定价油品", value: FUELS.filter((f) => currentAt(chainOf(f), now.value)).length },
  { label: "待生效版本", value: FUELS.reduce((sum, f) => sum + pendingAfter(chainOf(f), now.value).length, 0) },
  { label: "审计记录", value: store.audit.length },
]);

const chartRows = computed(() => FUELS.map((fuel) => ({ fuel, value: chainOf(fuel).length })));
const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

const auditDesc = computed(() =>
  store.audit.slice().sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
);

function statusOf(v: PriceVersion, current: PriceVersion | null): string {
  if (v.revokedAt) return "已撤销";
  if (v.effectiveAt > now.value) return "待生效";
  return current && current.id === v.id ? "生效中" : "历史版本";
}

function statusClass(v: PriceVersion, current: PriceVersion | null): string {
  const status = statusOf(v, current);
  if (status === "待生效") return "pending";
  if (status === "已撤销") return "revoked";
  if (status === "历史版本") return "history";
  return "";
}

function canReschedule(v: PriceVersion): boolean {
  return !v.revokedAt && v.effectiveAt > now.value;
}

function canRevoke(v: PriceVersion, current: PriceVersion | null): boolean {
  return !v.revokedAt && (v.effectiveAt > now.value || current?.id === v.id);
}

// 行内改期 / 撤销
const reschedulingId = ref<string | null>(null);
const rescheduleValue = ref("");
const revokingId = ref<string | null>(null);
const revokeReason = ref("");
const inlineError = ref("");

function closeInline() {
  reschedulingId.value = null;
  revokingId.value = null;
  inlineError.value = "";
}

function openReschedule(v: PriceVersion) {
  closeInline();
  reschedulingId.value = v.id;
  rescheduleValue.value = toLocalInput(v.effectiveAt);
}

function openRevoke(v: PriceVersion) {
  closeInline();
  revokingId.value = v.id;
  revokeReason.value = "";
}

function confirmReschedule(v: PriceVersion) {
  const err = store.reschedule(v.id, rescheduleValue.value, operator.value);
  if (err) {
    inlineError.value = err;
    return;
  }
  closeInline();
}

function confirmRevoke(v: PriceVersion) {
  const err = store.revoke(v.id, revokeReason.value, operator.value);
  if (err) {
    inlineError.value = err;
    return;
  }
  closeInline();
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ project.industry }}行业前端最小闭环</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="stack">
          <span v-for="item in project.stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="metric in metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submit">
          <h2>新建价格版本</h2>
          <p class="hint">
            补录历史或修正价格时，只能新增带原因的修订版本；已生效历史不可改写，同一生效时刻不得重叠。
          </p>
          <div class="form-grid">
            <label>
              油品
              <select v-model="form.fuel" required>
                <option value="">请选择</option>
                <option v-for="fuel in FUELS" :key="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              挂牌价（元/升）
              <input v-model.number="form.price" type="number" min="0.01" step="0.01" required />
            </label>
            <label>
              生效时刻
              <input v-model="form.effectiveAt" type="datetime-local" required />
            </label>
            <label>
              调价 / 补录原因
              <textarea v-model="form.reason" required placeholder="必填，随版本写入审计记录" />
            </label>
            <label>
              操作员（用于审计署名）
              <input v-model="operator" type="text" required />
            </label>
            <p v-if="formError" class="error">{{ formError }}</p>
            <p v-if="formNotice" class="ok">{{ formNotice }}</p>
            <button type="submit">保存价格版本</button>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>油品价格看板</h2>
            <select v-model="filter">
              <option>全部油品</option>
              <option v-for="fuel in FUELS" :key="fuel">{{ fuel }}</option>
            </select>
          </div>

          <div class="record-grid">
            <article v-for="card in cards" :key="card.fuel" class="fuel-card">
              <div class="fuel-head">
                <h3>{{ card.fuel }}</h3>
                <div class="current">
                  <template v-if="card.current">
                    <strong>{{ fmtPrice(card.current.price) }}</strong>
                    <span>当前挂牌价 · 自 {{ fmtTime(card.current.effectiveAt) }} 起生效</span>
                  </template>
                  <template v-else>
                    <strong class="unpriced">未定价</strong>
                    <span>暂无已生效的价格版本</span>
                  </template>
                </div>
              </div>

              <p v-if="card.next" class="pending-strip">
                待生效：{{ fmtPrice(card.next.price) }}，将于 {{ fmtTime(card.next.effectiveAt) }} 起生效（可改期或撤销）
              </p>

              <div class="version-list">
                <div
                  v-for="v in card.timeline"
                  :key="v.id"
                  class="version-row"
                  :class="{ revoked: !!v.revokedAt }"
                >
                  <div class="version-main">
                    <span class="version-price">{{ fmtPrice(v.price) }}</span>
                    <span class="status" :class="statusClass(v, card.current)">
                      {{ statusOf(v, card.current) }}
                    </span>
                  </div>
                  <div class="version-meta">
                    <span>生效时刻：{{ fmtTime(v.effectiveAt) }}</span>
                    <span>操作员：{{ v.operator }}</span>
                    <span>记录于：{{ fmtTime(v.createdAt) }}</span>
                  </div>
                  <p class="version-reason">原因：{{ v.reason }}</p>
                  <p v-if="v.revokedAt" class="version-reason revoked-info">
                    已于 {{ fmtTime(v.revokedAt) }} 撤销<template v-if="v.revokeReason">：{{ v.revokeReason }}</template>
                  </p>
                  <div v-if="canReschedule(v) || canRevoke(v, card.current)" class="version-actions">
                    <button v-if="canReschedule(v)" type="button" @click="openReschedule(v)">改期</button>
                    <button v-if="canRevoke(v, card.current)" type="button" class="danger" @click="openRevoke(v)">
                      撤销
                    </button>
                  </div>
                  <div v-if="reschedulingId === v.id" class="inline-form">
                    <input v-model="rescheduleValue" type="datetime-local" />
                    <button type="button" @click="confirmReschedule(v)">确认改期</button>
                    <button type="button" class="secondary" @click="closeInline">取消</button>
                  </div>
                  <div v-if="revokingId === v.id" class="inline-form">
                    <input v-model="revokeReason" type="text" placeholder="撤销说明（可选，写入审计）" />
                    <button type="button" class="danger" @click="confirmRevoke(v)">确认撤销</button>
                    <button type="button" class="secondary" @click="closeInline">取消</button>
                  </div>
                  <p v-if="(reschedulingId === v.id || revokingId === v.id) && inlineError" class="error">
                    {{ inlineError }}
                  </p>
                </div>
                <div v-if="card.timeline.length === 0" class="empty">暂无价格版本</div>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in chartRows" :key="row.fuel" class="bar">
              <span>{{ row.fuel }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </section>
      </section>

      <section class="panel audit-panel">
        <h2>审计记录</h2>
        <div class="audit-list">
          <div v-for="entry in auditDesc" :key="entry.id" class="audit-row">
            <span>{{ fmtTime(entry.at) }}</span>
            <span class="audit-action">{{ entry.action }}</span>
            <span>{{ entry.fuel }}</span>
            <span class="audit-detail">{{ entry.detail }}</span>
            <span>{{ entry.operator }}</span>
          </div>
          <div v-if="auditDesc.length === 0" class="empty">暂无审计记录</div>
        </div>
      </section>
    </div>
  </main>
</template>
