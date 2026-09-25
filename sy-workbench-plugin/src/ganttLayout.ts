// 甘特泳道布局纯函数（2026-09-24 gantt-lanes spec）：四锚数据（SQL 行直译，与旧森林图
// 同链）→ 泳道行模型+分段时间映射。零 siyuan/window 依赖（可单测）。
// 行=项目主文档一行（行名=项目名，主文档直下任务归此行）+每条子文档一行（created 升序，
// folder-model 起子文档平铺直出无分拣层）；行底活跃跨度带=
// created→updated；四态横条（done 灰绿实色/active 主色/overdue 红边/future 浅色）+
// 里程碑菱形（只有 due 无区间）+行上小绿点（块引用果）+无日期未来任务 now 右排队条
// （FUTURE_SPAN_MS 均布，纯像素位不回写数据）。断轴压缩=语义锚点间空白 ≥48h 压成定宽
// 带。branchKindOf/parseKernelTs/dateAttrTs/daysBetween 自旧森林图布局层平移（原文件
// 随旧画布退役删除）；direction 字段废弃（竖/横双档随 SvelteFlow 退役）。

import { isDone } from "@/kernel/core/progressCalc";

// ---------- 常量 ----------

export const GANTT_PX_PER_DAY = 40;          // 固定天级密度（单档，无档位切换）
export const PX_PER_MS = GANTT_PX_PER_DAY / 86400_000;
export const GAP_MS_THRESH = 48 * 3600_000;  // 断轴阈（与森林图同值）
export const BREAK_W = 90;                   // 断轴定宽带宽 px
export const FUTURE_SPAN_MS = 36 * 3600_000; // 无日期排队区总时长（像素位语义承森林图）
export const ACTIVE_RECENT_MS = 7 * 86400_000;
export const DORMANT_AFTER_MS = 30 * 86400_000;
export const DOMAIN_MARGIN_MS = 6 * 3600_000; // 域尾余量

export const NAME_COL_W = 180;   // 左侧线名列宽（视图+测试同源）
export const ROW_H_BASE = 28;    // 单轨行高
export const TRACK_H = 22;       // 每加一轨的行高增量
export const TRACK_MAX = 4;      // 堆叠轨封顶
export const MILESTONE_W = 12;   // 菱形视宽
export const SHORT_BAR_W = 28;   // 无区间短条视宽
export const MIN_BAR_W = 6;      // 区间条最小可读宽
const ACTIVE_EPS_MS = 5 * 60_000; // active 无 due 贴 now 线右的微小偏移
const STACK_GAP_PX = 2;          // 同轨相邻条最小水平间隙

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 输入形态（SQL 行直译；ForestInput 同形态减 direction 加 compress） ----------

export interface ForestTaskRow {
    id: string;
    root_id: string;
    content: string;
    markdown: string;
    /** 内核 14 位时间戳 YYYYMMDDhhmmss */
    created: string;
    updated: string;
    due_date?: string | null;
    due_time?: string | null;
    start_date?: string | null;
    start_time?: string | null;
    /** 完成日期属性（custom-task-done-date，YYYY-MM-DD）——done 条时间锚优先源 */
    done_date?: string | null;
}

export interface ForestFruitRow {
    def_root_id: string;
    def_name: string;
    def_created: string;
    /** 引用所在文档（决定挂哪一行——bear 把引用挪进线文档后仍正确归属） */
    ref_root_id: string;
}

export interface GanttInput {
    now: number;
    today: string;
    project: { id: string; name: string; created: string; updated: string; status?: string };
    lines: Array<{ id: string; content: string; created: string; updated: string }>;
    tasks: ForestTaskRow[];
    fruits: ForestFruitRow[];
    /** 断轴压缩（默认 true）；false=纯线性 40px/天（图顶开关两态重排用） */
    compress?: boolean;
}

// ---------- 输出形态 ----------

export type BranchKind = "done" | "active" | "overdue" | "future";

export interface GanttBar {
    id: string;
    kind: BranchKind;
    /** 区间条两端（有 start 且锚≥start 才有）；短条/菱形只有 anchorTs */
    tsStart?: number;
    tsEnd?: number;
    anchorTs: number;
    /** 只有 due 无区间 → 菱形点挂锚（颜色同状态色） */
    milestone: boolean;
    /** 同行重叠堆叠轨（0 起，封顶 TRACK_MAX-1；视图按 trackCount 定行高） */
    stackRow: number;
    label: string;
    blockId: string;
    overdueDays?: number;
}

export interface GanttFutureBar {
    id: string;
    ts: number;
    stackRow: number;
    label: string;
    blockId: string;
}

export interface GanttFruitDot {
    ts: number;
    label: string;
    blockId: string;
}

export interface GanttRow {
    id: string;
    name: string;
    dormant: boolean;
    /** 行底活跃跨度带=created→updated（原「主干」信息） */
    spanTs: { start: number; end: number };
    bars: GanttBar[];
    futureBars: GanttFutureBar[];
    fruitDots: GanttFruitDot[];
    /** 行内最高 stackRow+1（下限 1）——视图行高=ROW_H_BASE+(trackCount-1)*TRACK_H 封顶 TRACK_MAX */
    trackCount: number;
}

export interface GanttBreak {
    t0: number;
    t1: number;
    px: number; // 带起点（相对时间域零点，不含名列宽）
    days: number;
}

export interface GanttTimeMap {
    xOf: (ts: number) => number;
    tOf: (px: number) => number;
    breaks: GanttBreak[];
    lenPx: number;
}

export interface GanttModel {
    rows: GanttRow[];
    timeDomain: { min: number; max: number };
    map: GanttTimeMap;
    nowX: number;
}

// ---------- 基础判定（自旧森林图布局层平移） ----------

/** 内核 14 位时间戳 → epoch ms（本地时区，与浏览器展示一致） */
export function parseKernelTs(s: string | null | undefined): number {
    if (typeof s !== "string" || !/^\d{14}$/.test(s)) return NaN;
    const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
    const h = +s.slice(8, 10), mi = +s.slice(10, 12), se = +s.slice(12, 14);
    const ts = new Date(y, mo - 1, d, h, mi, se).getTime();
    return Number.isFinite(ts) ? ts : NaN;
}

/** 四态判定（语义定稿；done 最优先） */
export function branchKindOf(t: ForestTaskRow, _now: number, today: string): BranchKind {
    if (isDone(t)) return "done";
    if (t.due_date) return t.due_date < today ? "overdue" : "active";
    if (t.start_date && t.start_date <= today) return "active";
    const updated = parseKernelTs(t.updated);
    if (!Number.isNaN(updated) && _now - updated <= ACTIVE_RECENT_MS) return "active";
    return "future";
}

/** YYYY-MM-DD（+可选 HH:mm）→ epoch ms；时/分缺省取正午/零点前的稳定锚 */
function dateAttrTs(date: string, time?: string | null, dayEnd = false): number {
    const hh = time ? +String(time).slice(0, 2) : dayEnd ? 23 : 12;
    const mm = time ? +String(time).slice(3, 5) : dayEnd ? 59 : 0;
    const ts = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm, dayEnd ? 59 : 0).getTime();
    return Number.isFinite(ts) ? ts : NaN;
}

function daysBetween(fromDay: string, toDay: string): number {
    return Math.round((Date.parse(toDay) - Date.parse(fromDay)) / 86400_000);
}

function taskLabel(t: ForestTaskRow): string {
    return t.content || t.markdown || "（空任务）";
}

// ---------- 分段压缩映射（算法承旧森林图 buildTimeMap，密度换 40px/天） ----------
// 锚点排序去重为段边界，段内空白 ≥GAP_MS_THRESH 压成定宽断轴带（段斜率=BREAK_W/span，
// 其余段恒 PX_PER_MS）；锚点处映射连续、斜率突变；域外钳首/按末段斜率延伸。
// compress=false → 纯线性恒等映射（开关关态）。

function buildTimeMap(anchorTs: number[], domainMin: number, domainMax: number, compress: boolean): GanttTimeMap {
    if (!compress) {
        return {
            xOf: (ts) => Math.max(0, (ts - domainMin) * PX_PER_MS),
            tOf: (px) => domainMin + px / PX_PER_MS,
            breaks: [],
            lenPx: (domainMax - domainMin) * PX_PER_MS,
        };
    }
    const list = [...new Set([...anchorTs.filter(Number.isFinite), domainMin, domainMax])].sort((a, b) => a - b);
    const breaks: GanttBreak[] = [];
    const segs: Array<{ t0: number; t1: number; px0: number; k: number }> = [];
    let px = 0;
    for (let i = 0; i + 1 < list.length; i++) {
        const a = list[i], b = list[i + 1], span = b - a;
        if (span <= 0) continue;
        if (span >= GAP_MS_THRESH) {
            breaks.push({ t0: a, t1: b, px, days: Math.round(span / 86400_000) });
            segs.push({ t0: a, t1: b, px0: px, k: BREAK_W / span });
            px += BREAK_W;
        } else {
            segs.push({ t0: a, t1: b, px0: px, k: PX_PER_MS });
            px += span * PX_PER_MS;
        }
    }
    if (!segs.length) {
        // 域内无有效段（防御：域两点重合）——退纯线性恒等映射
        const k = PX_PER_MS;
        return { xOf: (ts) => Math.max(0, (ts - domainMin) * k), tOf: (p) => domainMin + p / k, breaks: [], lenPx: (domainMax - domainMin) * k };
    }
    const first = segs[0], last = segs[segs.length - 1];
    const xOf = (ts: number): number => {
        if (ts <= domainMin) return 0;
        for (const s of segs) {
            if (ts <= s.t1) return s.px0 + (ts - s.t0) * s.k;
        }
        return last.px0 + (ts - last.t0) * last.k; // 域尾外按末段斜率延伸
    };
    const tOf = (pxQ: number): number => {
        if (pxQ <= 0) return first.t0;
        for (const s of segs) {
            const segEnd = s.px0 + (s.t1 - s.t0) * s.k;
            if (pxQ <= segEnd) return s.t0 + (pxQ - s.px0) / s.k;
        }
        return last.t0 + (pxQ - last.px0) / last.k;
    };
    return { xOf, tOf, breaks, lenPx: px };
}

// ---------- 布局 ----------

export function layoutGantt(input: GanttInput): GanttModel {
    const { now, today, project, lines, tasks, fruits } = input;
    const compress = input.compress !== false;

    // 行分桶：主文档行恒在（行名=项目名），线行按 created 升序。索引脏行防御：blocks 表
    // 偶发同 id 物理重复行（森林图防线平移——重复行喂毒 keyed each=整面板冻结），按 id 去重保首行
    const seenLine = new Set<string>();
    const rowDefs = [
        { id: project.id, name: project.name, created: project.created, updated: project.updated },
        ...lines
            .filter((l) => (seenLine.has(l.id) ? false : (seenLine.add(l.id), true)))
            .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0))
            .map((l) => ({ id: l.id, name: l.content || "（无标题）", created: l.created, updated: l.updated })),
    ];

    const tasksByRow = new Map<string, ForestTaskRow[]>();
    const seenTask = new Set<string>();
    for (const t of tasks) {
        if (seenTask.has(t.id)) continue; // 同 id 脏行去重保首行（keyed each 不喂毒）
        seenTask.add(t.id);
        const arr = tasksByRow.get(t.root_id) ?? [];
        arr.push(t);
        tasksByRow.set(t.root_id, arr);
    }
    const fruitsByRow = new Map<string, ForestFruitRow[]>();
    const seenFruit = new Set<string>();
    for (const f of fruits) {
        if (seenFruit.has(f.def_root_id)) continue; // 多引用同目标=一果
        seenFruit.add(f.def_root_id);
        const arr = fruitsByRow.get(f.ref_root_id) ?? [];
        arr.push(f);
        fruitsByRow.set(f.ref_root_id, arr);
    }

    const archived = project.status === "archived";
    const anchors: number[] = [now];

    const rows: GanttRow[] = rowDefs.map((def) => {
        const rowTasks = tasksByRow.get(def.id) ?? [];
        const rowFruits = fruitsByRow.get(def.id) ?? [];
        const bars: GanttBar[] = [];
        const futureBars: GanttFutureBar[] = [];
        const fruitDots: GanttFruitDot[] = [];
        const moments: number[] = [];

        let futureIdx = 0;
        const futureTotal = rowTasks.filter((t) => branchKindOf(t, now, today) === "future").length;
        for (const t of rowTasks) {
            const kind = branchKindOf(t, now, today);
            const startTs = t.start_date && DATE_RE.test(t.start_date) ? dateAttrTs(t.start_date, t.start_time) : undefined;
            let anchorTs: number;
            let overdueDays: number | undefined;
            if (kind === "done") {
                // done_date 属性优先（正午锚，勾选日比 updated 更真实）；畸形回退 updated
                anchorTs = t.done_date && DATE_RE.test(t.done_date) ? dateAttrTs(t.done_date) : NaN;
                if (Number.isNaN(anchorTs)) anchorTs = parseKernelTs(t.updated);
            } else if (kind === "overdue") {
                anchorTs = dateAttrTs(t.due_date!, t.due_time, true);
                overdueDays = daysBetween(t.due_date!, today);
            } else if (kind === "active") {
                anchorTs = t.due_date ? dateAttrTs(t.due_date, t.due_time) : now + ACTIVE_EPS_MS;
            } else {
                anchorTs = t.due_date ? dateAttrTs(t.due_date, t.due_time)
                    : startTs !== undefined && !Number.isNaN(startTs) ? startTs : NaN;
            }
            if (kind === "future" && !t.due_date && (startTs === undefined || Number.isNaN(startTs))) {
                // 无日期未来任务：now 右排队条（FUTURE_SPAN_MS 均布，纯像素位不回写数据）
                const ts = now + ((futureIdx + 1) * FUTURE_SPAN_MS) / (futureTotal + 1);
                futureIdx++;
                futureBars.push({ id: t.id, ts, stackRow: 0, label: taskLabel(t), blockId: t.id });
                moments.push(ts);
                continue;
            }
            if (Number.isNaN(anchorTs)) anchorTs = startTs ?? parseKernelTs(t.created);
            if (Number.isNaN(anchorTs)) continue;
            moments.push(anchorTs);
            if (startTs !== undefined && !Number.isNaN(startTs)) moments.push(startTs);
            const hasRange = startTs !== undefined && !Number.isNaN(startTs) && anchorTs >= startTs;
            bars.push({
                id: t.id,
                kind,
                tsStart: hasRange ? startTs : undefined,
                tsEnd: hasRange ? anchorTs : undefined,
                anchorTs,
                milestone: !hasRange && !!t.due_date, // 只有 due 无区间 → 菱形挂锚
                stackRow: 0,
                label: taskLabel(t),
                blockId: t.id,
                overdueDays,
            });
        }
        for (const f of rowFruits) {
            const ts = parseKernelTs(f.def_created);
            if (Number.isNaN(ts)) continue;
            moments.push(ts);
            fruitDots.push({ ts, label: f.def_name || "（无标题）", blockId: f.def_root_id });
        }

        // 行底活跃跨度带=created→updated（畸形回退锚点域/now，空行也有带）
        const createdTs = parseKernelTs(def.created);
        const updatedTs = parseKernelTs(def.updated);
        const spanStart = Number.isNaN(createdTs)
            ? (moments.length ? Math.min(...moments, now) : now)
            : createdTs;
        const spanEnd = Number.isNaN(updatedTs)
            ? (moments.length ? Math.max(...moments, spanStart) : now)
            : Math.max(updatedTs, spanStart);
        anchors.push(spanStart, spanEnd, ...moments);

        const dormant = archived || (!Number.isNaN(updatedTs) && now - updatedTs > DORMANT_AFTER_MS);
        return { id: def.id, name: def.name, dormant, spanTs: { start: spanStart, end: spanEnd }, bars, futureBars, fruitDots, trackCount: 1 };
    });

    // 全图时间域：min=最早锚（果/任务可早于项目 created，钳入域防 xOf 归零堆积）；
    // max=max(now, 最远锚, 排队区右界)+余量
    const domainMin = Math.min(...anchors);
    const domainMax = Math.max(now + FUTURE_SPAN_MS, ...anchors) + DOMAIN_MARGIN_MS;
    const map = buildTimeMap(anchors, domainMin, domainMax, compress);

    // 同行重叠堆叠：px 区间 sweep——区间条按起止，菱形/短条/排队条按视宽居中锚点；
    // 放不进任何空轨→开新轨，轨数到 TRACK_MAX 封顶后塞最早腾空的轨（诚实重叠，极密集行罕见）
    for (const row of rows) {
        interface Slot { x0: number; x1: number; target: { stackRow: number } }
        const slots: Slot[] = [];
        for (const b of row.bars) {
            let x0: number, x1: number;
            if (b.tsStart !== undefined && b.tsEnd !== undefined) {
                x0 = map.xOf(b.tsStart);
                x1 = Math.max(x0 + MIN_BAR_W, map.xOf(b.tsEnd));
            } else {
                const w = b.milestone ? MILESTONE_W : SHORT_BAR_W;
                x0 = map.xOf(b.anchorTs) - w / 2;
                x1 = x0 + w;
            }
            slots.push({ x0, x1, target: b });
        }
        for (const fb of row.futureBars) {
            const x0 = map.xOf(fb.ts) - SHORT_BAR_W / 2;
            slots.push({ x0, x1: x0 + SHORT_BAR_W, target: fb });
        }
        slots.sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1);
        const trackEnd: number[] = [];
        let maxTrack = 0;
        for (const s of slots) {
            let idx = trackEnd.findIndex((lx) => lx + STACK_GAP_PX <= s.x0);
            if (idx === -1 && trackEnd.length < TRACK_MAX) idx = trackEnd.length; // 开新轨
            if (idx === -1) {
                idx = 0; // 封顶：塞最早腾空的轨
                for (let k = 1; k < trackEnd.length; k++) if (trackEnd[k] < trackEnd[idx]) idx = k;
            }
            if (idx === trackEnd.length) trackEnd.push(s.x1);
            else trackEnd[idx] = Math.max(trackEnd[idx], s.x1);
            s.target.stackRow = idx;
            maxTrack = Math.max(maxTrack, idx + 1);
        }
        row.trackCount = Math.max(1, maxTrack);
    }

    return { rows, timeDomain: { min: domainMin, max: domainMax }, map, nowX: map.xOf(now) };
}
