// dataview B2：月度对账单纯函数层（零存储纯投影——契约 §1「面板=文档的视图」/§9 无 AI
// 全可用：全硬编码聚合）。「收据不是考卷」口径（ammo-concept A9）：只呈现事实，不评判
// 不施压——差值用带符号数字出示（多用/少用是算术不是评价），无达标/超额类字眼。
// 三块聚合：
//  ① 配额达成 buildReconQuota：各池月内配置配额（每日配置行聚合——池行配比+任务行配额）
//     vs 日账实际时长（闭合段 ΣdurationMin；跨零点读面已 +24h 归一；未闭合照实计数不计时长
//     ——buildMonthDuo 同款收据口径：进行中段动态折算不稳）；
//  ② 时段热力 buildReconHeat：日账闭合段时长按 日×小时 分桶（段跨小时切桶；跨零点段桶
//     归开始日的 hour%24——「账随开始日不迁移」B2.4）；
//  ③ 计划偏差 buildReconDeviation：班表锚点时刻 vs 锚点出发型打点 start（匹配键=B2.4 机器
//     指针 custom-ammo-task=班表块 id；同锚多笔取最早=首发）。未出发只计已过去的日子
//     （date<today——未来锚点未发生不是事实，收据不预写）。
// 数据源全走 B3 后文本通道：每日配置（dayConfigRowsSql 扫描行→parseConfigRow 单一判官）、
// 日账月文档（ammo-ledger-read days 窗 rpc 产物）、班表（boardRowsToSchedItems 产物）。
// 零 siyuan/网络/DOM 依赖（gui 纯逻辑层惯例——聚合口径单测钉死）。

import { AMMO_POOL_SLUGS, isPoolSlug, parseConfigRow, type AmmoPoolRow, type AmmoPoolSlug, type AmmoTaskRow } from "@/kernel/core/ammoQuadrant";
import type { AmmoLedgerEntry } from "@/kernel/core/ammoLedger";
import { hmToMin, isValidHM } from "@/kernel/core/schedule";
import type { SchedItem } from "@/kernel/core/schedule";
import type { DayConfigScanRow } from "./queries";

const pad2 = (n: number) => String(n).padStart(2, "0");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 月前缀（YYYY-MM——月内日过滤键） */
export function monthPrefix(year: number, month: number): string {
    return `${year}-${pad2(month)}`;
}

/** 月内逐日骨架（1 号~月末，YYYY-MM-DD 序——热力网格行序） */
export function monthDays(year: number, month: number): string[] {
    const last = new Date(year, month, 0).getDate(); // day=0=上月末日（month 不减一——取当月天数惯用法）
    const out: string[] = [];
    for (let d = 1; d <= last; d++) out.push(`${monthPrefix(year, month)}-${pad2(d)}`);
    return out;
}

/** 日账日窗行（rpc ammo-ledger-read days 产物形态） */
export interface LedgerDayRow {
    day: string;
    items: AmmoLedgerEntry[];
}

// ── ① 配额达成 ──

/** 一日配置聚合（B2 配额面原料：池行配比+任务行配额全留——dayConfigCounts 只计任务数，这里要分钟） */
export interface ReconDayConfig {
    pools: AmmoPoolRow[];
    tasks: AmmoTaskRow[];
}

/** 扫描行 → 逐日配置聚合（dayConfigCounts 同门：GROUP_CONCAT 首段归一+parseConfigRow 单一
 *  判官文本优先属性兜底；ratio/quota 列=B2 起老行属性兜底半边；坏 day/未认行静默跳过） */
export function reconDayConfigs(rows: DayConfigScanRow[]): Map<string, ReconDayConfig> {
    const out = new Map<string, ReconDayConfig>();
    for (const r of rows) {
        if (!r?.id) continue;
        const day = (r.day ?? "").split(",")[0].trim();
        if (!DATE_RE.test(day)) continue; // 容器缺日键/坏值=脏行
        const pool = (r.pool ?? "").split(",")[0] || null;
        const task = (r.task ?? "").split(",")[0] || null;
        const ratio = (r.ratio ?? "").split(",")[0].trim() || null;
        const quota = (r.quota ?? "").split(",")[0].trim() || null;
        // 属性合成按 getBlockAttrs 真实形态：未设键=缺席（dayConfigCounts 同注释）
        const attrs: Record<string, string> = {};
        if (pool) attrs["custom-ammo-pool"] = pool;
        if (task) attrs["custom-ammo-task"] = task;
        if (ratio) attrs["custom-ammo-ratio"] = ratio;
        if (quota) attrs["custom-ammo-quota"] = quota;
        const row = parseConfigRow(r.content, attrs);
        if (!row) continue; // 未认行 fail-soft（□8 体检另有专报）
        const c = out.get(day) ?? { pools: [], tasks: [] };
        if ("task" in row) c.tasks.push(row);
        else c.pools.push(row);
        out.set(day, c);
    }
    return out;
}

/** 一池月度配额对账行（四池固定序产出——AMMO_POOL_SLUGS 白名单序） */
export interface ReconQuotaRow {
    pool: AmmoPoolSlug;
    /** 配置过该池的天数（池行或任务行任一在即计） */
    days: number;
    /** Σ池配比分钟（gold=保底/hearth=上限语义在展示面；deadline/crumbs 行无数字恒 0） */
    planMin: number;
    /** Σ任务级配额分钟 */
    quotaMin: number;
    /** 实际闭合段合计分钟 */
    actualMin: number;
    /** 未闭合条数（进行中/悬账——照实出示不计时长） */
    unclosed: number;
}

/** 配额达成聚合：月内每日配置（配置侧）vs 日账（实际侧）。月外日/坏池 slug 静默剔（fail-soft）。
 *  配置侧口径：同日同池多行配比取首行（引擎整组写恒一行；重复行=脏行防御不重复计）。 */
export function buildReconQuota(input: { configs: Map<string, ReconDayConfig>; ledgerDays: LedgerDayRow[]; year: number; month: number }): ReconQuotaRow[] {
    const pref = monthPrefix(input.year, input.month);
    const rows = new Map<AmmoPoolSlug, ReconQuotaRow>(AMMO_POOL_SLUGS.map((p) => [p, { pool: p, days: 0, planMin: 0, quotaMin: 0, actualMin: 0, unclosed: 0 }]));
    // 配置侧
    for (const [day, c] of input.configs) {
        if (!day.startsWith(`${pref}-`)) continue;
        const seenPool = new Set<AmmoPoolSlug>();
        for (const p of c.pools) {
            if (!isPoolSlug(p.pool)) continue;
            const row = rows.get(p.pool)!;
            if (!seenPool.has(p.pool)) {
                seenPool.add(p.pool);
                row.days++;
                row.planMin += p.ratio ?? 0;
            }
        }
        for (const tk of c.tasks) {
            if (!isPoolSlug(tk.pool)) continue;
            const row = rows.get(tk.pool)!;
            if (!seenPool.has(tk.pool)) {
                seenPool.add(tk.pool);
                row.days++;
            }
            row.quotaMin += tk.quota ?? 0;
        }
    }
    // 实际侧
    for (const dayRow of input.ledgerDays) {
        if (!dayRow.day.startsWith(`${pref}-`)) continue;
        for (const e of dayRow.items) {
            if (!isPoolSlug(e.pool)) continue;
            const row = rows.get(e.pool as AmmoPoolSlug)!;
            if (!e.closed) row.unclosed++;
            else if (e.durationMin != null && e.durationMin > 0) row.actualMin += e.durationMin;
        }
    }
    return AMMO_POOL_SLUGS.map((p) => rows.get(p)!);
}

// ── ② 时段热力 ──

/** 月度热力模型（日×24 小时分桶） */
export interface ReconHeat {
    /** 月内逐日骨架（恒全月——空日照格子） */
    days: string[];
    /** day → 24 桶分钟（索引=小时 0..23；缺日=零桶） */
    buckets: Map<string, number[]>;
    /** 全月单桶峰值分钟（色阶分母；0=月内无闭合打点） */
    max: number;
}

/** 一条闭合段切进小时桶（cur 从 startMin 起步到 startMin+duration；跨小时按 60 分界切，
 *  hour%24 归一=跨零点段的后半桶落回开始日的 0~N 时——账随开始日 B2.4） */
function segmentIntoHours(bucket: number[], startMin: number, duration: number): void {
    let cur = startMin;
    const end = startMin + duration;
    while (cur < end) {
        const hourIdx = Math.floor(cur / 60);
        const nextBoundary = (hourIdx + 1) * 60;
        const seg = Math.min(nextBoundary, end) - cur;
        bucket[hourIdx % 24] += seg;
        cur += seg;
    }
}

/** 时段热力聚合：月内日账闭合段 → 日×小时分钟桶。start/end 非法或未闭合跳过（未闭合
 *  段时长动态折算不稳——月历 duo 同口径）；durationMin 信任读面产物（跨零点已归一）。 */
export function buildReconHeat(input: { ledgerDays: LedgerDayRow[]; year: number; month: number }): ReconHeat {
    const days = monthDays(input.year, input.month);
    const buckets = new Map<string, number[]>(days.map((d) => [d, new Array(24).fill(0)]));
    let max = 0;
    const pref = monthPrefix(input.year, input.month);
    for (const dayRow of input.ledgerDays) {
        if (!dayRow.day.startsWith(`${pref}-`)) continue;
        const bucket = buckets.get(dayRow.day);
        if (!bucket) continue; // 月骨架外（理论不到——防御）
        for (const e of dayRow.items) {
            if (!e.closed || !isValidHM(e.start) || e.durationMin == null || e.durationMin <= 0) continue;
            segmentIntoHours(bucket, hmToMin(e.start), e.durationMin);
        }
    }
    for (const b of buckets.values()) for (const v of b) if (v > max) max = v;
    return { days, buckets, max };
}

// ── ③ 计划偏差 ──

/** 单锚点偏差行（items 明细——收据逐条可追） */
export interface ReconDevItem {
    /** 班表块 id（跳源锚——openBlock 禁聚焦链） */
    key: string;
    summary: string;
    day: string;
    anchorHM: string;
    /** 实发时刻（锚点出发型打点 start）；null=未出发 */
    actualHM: string | null;
    /** 实发−锚点分钟（提前为负/延后为正）；null=未出发 */
    devMin: number | null;
}

/** 计划偏差统计（准点/提前/延后=已出发三态；未出发只计已过去的日子） */
export interface ReconDeviation {
    onTime: number;
    early: number;
    late: number;
    notDeparted: number;
    /** 已出发样本的有符号平均偏差分钟（提前为负；无样本=null） */
    avgDevMin: number | null;
    /** 锚点序明细（日+锚点时刻排序——末来未出发行不进：未来不是事实） */
    items: ReconDevItem[];
}

/** 计划偏差聚合：班表带时刻锚点 vs 锚点出发型打点。匹配键=B2.4 机器指针（打点
 *  custom-ammo-task=班表块 id+anchor 旗标——□3 出发链唯一写形；手打点无指针不硬配，
 *  宁少认不错认）。同锚多笔出发取最早（首发时刻）；班表块超保留窗被清/指针孤儿=两侧
 *  各自静默缺席（fail-soft）。未出发资格=锚点日已过（<today）——本月未来日不出行。 */
export function buildReconDeviation(input: { sched: SchedItem[]; ledgerDays: LedgerDayRow[]; year: number; month: number; today: string }): ReconDeviation {
    const pref = monthPrefix(input.year, input.month);
    // 出发索引：task 指针 → 最早出发时刻
    const departByTask = new Map<string, { hm: string; min: number }>();
    for (const dayRow of input.ledgerDays) {
        for (const e of dayRow.items) {
            if (!e.anchor || !e.task || !isValidHM(e.start)) continue;
            const min = hmToMin(e.start);
            const prev = departByTask.get(e.task);
            if (!prev || min < prev.min) departByTask.set(e.task, { hm: e.start, min });
        }
    }
    const out: ReconDeviation = { onTime: 0, early: 0, late: 0, notDeparted: 0, avgDevMin: null, items: [] };
    let devSum = 0;
    const anchors = input.sched.filter((s) => s.date.startsWith(`${pref}-`) && isValidHM(s.start));
    for (const s of anchors) {
        const anchorMin = hmToMin(s.start!);
        const dep = departByTask.get(s.key);
        if (dep) {
            const dev = dep.min - anchorMin;
            devSum += dev;
            if (dev < 0) out.early++;
            else if (dev > 0) out.late++;
            else out.onTime++;
            out.items.push({ key: s.key, summary: s.summary, day: s.date, anchorHM: s.start!, actualHM: dep.hm, devMin: dev });
        } else if (s.date < input.today) {
            out.notDeparted++;
            out.items.push({ key: s.key, summary: s.summary, day: s.date, anchorHM: s.start!, actualHM: null, devMin: null });
        }
        // 未来日锚点：未发生不是事实——不出行不计数
    }
    out.items.sort((a, b) => (a.day === b.day ? (a.anchorHM < b.anchorHM ? -1 : a.anchorHM > b.anchorHM ? 1 : 0) : a.day < b.day ? -1 : 1));
    const departed = out.onTime + out.early + out.late;
    if (departed > 0) out.avgDevMin = Math.round(devSum / departed);
    return out;
}
