# 油品价格维护

- 行业：石油
- 技术栈：Vue3、Vite、TypeScript、Pinia、Naive UI
- 启动：`npm install && npm run dev`
- 构建：`npm run build`
- 业务测试：`npm test`（44 项核心不变量，纯 Node + esbuild，无需额外依赖）

数据默认保存在浏览器 localStorage（键：`dfwlfront-9-pricing-v1`），刷新后状态保持。

## 版本化价格模型

每种油品维护一组按生效时刻排序、**区间互不重叠**的价格版本（半开区间
`[effectiveAt, 下一版本.effectiveAt)`）：

- **当前挂牌价** = 已生效的最新一个未撤销版本；没有则显示「未定价」。
- **待生效版本**：生效时刻在未来，可**改期**或**撤销**，到点（每秒时钟校准）自动成为当前价。
- **撤销当前版本**：立即回落到上一版本；不存在上一版本则变为「未定价」。
- **补录修订**：只能新建一条带原因的修订版本（`kind: revision`），**绝不改写任何已生效历史**；
  已生效版本的生效时刻也不可改期，只能通过补录新修订来修正。
- 撤销不是删除：版本记录只打 `revokedAt/revokedBy/revokeReason` 标记。
- **审计记录**只追加：排期/录入、补录修订、改期（含前后时刻）、撤销（含原因）全部留痕。
- 所有查询（当前价、待生效、时间线）均由 Pinia getter 依据当前时钟实时推导，
  任何时间边界调整后当前价、待生效价与审计立即一致，并随持久化在刷新后保持。

## 目录

- `src/pricing/types.ts` — 版本与审计类型
- `src/pricing/store.ts` — Pinia store：不变量校验、排期/补录/改期/撤销、审计、localStorage 持久化
- `src/pricing/time.ts` — 时刻与 `datetime-local` 转换工具
- `src/App.vue` — 油品价格面板（当前价、待生效操作、版本时间线、审计记录、改期/撤销弹窗）
- `test/store.spec.ts` — 业务不变量测试
