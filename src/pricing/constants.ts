/** 受管理的油品目录 */
export const FUELS = ["92号汽油", "95号汽油", "98号汽油", "柴油", "乙醇汽油"] as const;

export type Fuel = (typeof FUELS)[number];
