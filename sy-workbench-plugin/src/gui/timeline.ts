// sloop □21 当天时间线数据层（纯函数）：五源（remind/task/burden/feishu/sched）当天压平一条线。
// 口径与 buildMonthModel 同源（isDone 过滤、脏行去重、账本分流、循环实例去重、班表托盘），
// 差异=模型带区间（startMin/endMin 当天分钟数）供三态（进行中/下一项/已过）与指针定位；
// 跨天区间与今天相交才收（昨日截入 startMin=0 / 跨出明天 endMin=1439）。
import { isDone } from "@/kernel/core/progressCalc";
import { normalizeLedger, timestampToWallTime } from "@/kernel/core/ledger";
import { parseBurdenKey } from "@/kernel/core/burden";
import { normalizeMirror, type InstanceRow } from "@/kernel/core/calendarMirror";
import { isIntervalTask } from "@/kernel/core/feishu";
import {
    parseRemindAt,
    parseRemindRepeat,
    remindEndValid,
    stripTaskMark,
    todayIsOccurrence,
} from "@/kernel/core/remind";
import type { SchedItem } from "@/kernel/core/schedule";
import type { AmmoLedgerEntry } from "@/kernel/core/ammoLedger";
import { dedupeById, type RemindScanRow, type TaskDueRow } from "./queries";

/** sloop □21 五源 + ammo □7 实况轴：live=日账打点段（实况本体——日账=唯一真相，时间线=投影） */
export type TimelineSource = "remind" | "task" | "burden" | "feishu" | "sched" | "live";

export interface TimelineItem {
    /** 开始（当天分钟数 0~1439；昨日跨入=0） */
    startMin: number;
    /** 结束（null=点事件，三态按默认窗）；跨出明天=1439（overnight 标注） */
    endMin: number | null;
    summary: string;
    source: TimelineSource;
    /** 点条目跳源块（feishu 原创/托盘 burden 无源块不可点） */
    blockId?: string;
    /** 班表硬性条目标记 */
    hard?: boolean;
    /** 今天开始但跨出明天（endMin 已裁 1439） */
    overnight?: boolean;
    /** 昨天开始的跨天区间截入今天（startMin=0） */
    fromYesterday?: boolean;
    /** live 源专属：池 slug（空=锚点出发型/无池临时） */
    pool?: string;
    /** live 源专属：锚点出发型打点（一键「出发」产生） */
    anchor?: boolean;
    /** live 源专属：未闭合（运行中——endMin 动态到当前分钟） */
    unclosed?: boolean;
}

export interface TimelineTrayItem {
    summary: string;
    source: TimelineSource;
    blockId?: string;
}

export type TimelineState = "past" | "active" | "upcoming";

export interface TimelineModel {
    /** YYYY-MM-DD（输入 now 的本地日） */
    date: string;
    /** startMin 升序（同刻按 endMin） */
    items: TimelineItem[];
    /** 无时刻条目（未定时班表+全天任务/burden/feishu） */
    tray: TimelineTrayItem[];
}

/** 点事件（无明确结束）的默认注意力窗（分钟）——与提醒事件默认时长同则 */
export const TL_POINT_WINDOW_MIN = 30;

export const MIN_PER_DAY = 24 * 60;

const SUMMARY_MAX = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const trunc = (s: string) => (s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + "…" : s);

/** 分钟数 → "HH:mm"（组件与测试共用同一格式源） */
export const fmtMin = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

/** "HH:mm" → 分钟数（非法 null） */
const parseHm = (s: string | null | undefined): number | null =>
    s && TIME_RE.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null;

/** 任务行 isDone 同款实参壳（progressCalc.TaskRow 形态，月历同款） */
const doneOf = (t: TaskDueRow) =>
    isDone({ id: t.id, content: t.content, markdown: t.markdown, updated: "", root_id: "" });

/** 绝对区间 [sMs, eMs)（eMs=null=点事件按默认窗）与当天相交→裁剪；不相交=null */
function clipRange(
    dayStart: number,
    sMs: number,
    eMs: number | null,
    base: Pick<TimelineItem, "summary" | "source"> & Partial<TimelineItem>,
): TimelineItem | null {
    if (!Number.isFinite(sMs)) return null;
    const dayEnd = dayStart + MIN_PER_DAY * 60_000;
    if (sMs >= dayEnd) return null; // 明天才开始
    const effEnd = eMs ?? sMs + TL_POINT_WINDOW_MIN * 60_000; // 点事件相交判定也按默认窗（如 23:50 提醒跨 0 点仍算今天）
    if (effEnd <= dayStart) return null; // 昨天已结束
    const fromYesterday = sMs < dayStart;
    const overnight = eMs !== null && eMs > dayEnd;
    return {
        ...base,
        startMin: Math.max(0, Math.floor((sMs - dayStart) / 60_000)),
        endMin: eMs === null ? null : Math.min(MIN_PER_DAY - 1, Math.floor((eMs - dayStart) / 60_000)),
        ...(fromYesterday ? { fromYesterday: true } : {}),
        ...(overnight ? { overnight: true } : {}),
    };
}

/** 剥时刻头（feishu 回流专用：班表行推飞书时 summary=整行文本带「12:10-12:40 」头，
 *  时刻已在事件时间轴/时间线左列，不剥=双前缀〔09-23 bear 走查实锤〕；`14:00- 摘要`
 *  半形态同剥；剥到空（纯时刻串）=保留原文）。 */
export function stripTimeHead(s: string): string {
    const m = /^\s*\d{1,2}:\d{2}\s*[-–~]\s*(?:\d{1,2}:\d{2})?\s+(.+)$/.exec(s);
    return m ? m[1].trim() : s;
}

/** 五源+实况 → 当天时间线模型（压平+排序+托盘分流）。输入原始行（SQL/档直出），脏值静默跳过。
 *  ammo □7：ledgerEntries=当日日账打点（实况轴本体——锚点硬块+sched 源照旧，打点段新 live 源，
 *  空白=未记录时段天然不渲染合并）。 */
export function buildTimeline(input: {
    now: Date;
    remindRows: RemindScanRow[];
    taskRows: TaskDueRow[];
    ledger: unknown;
    mirror?: unknown;
    instances?: InstanceRow[];
    sched?: SchedItem[];
    /** ammo □7：当日日账打点条目（kernel rpc ammo-ledger-read 单日形态；缺=实况段缺席） */
    ledgerEntries?: AmmoLedgerEntry[];
}): TimelineModel {
    const date = isoDate(input.now);
    const dayStart = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate()).getTime();
    const items: TimelineItem[] = [];
    const tray: TimelineTrayItem[] = [];

    // remind：单次=at 当日或 end 区间跨入；循环=todayIsOccurrence（锚点钟面时刻搬到今天，逐次独立=点事件）；
    // 脏 end（非法/不晚于 at）忽略按点事件显示（同步链行级记 invalid，显示侧不吞不炸）
    for (const r of dedupeById(input.remindRows)) {
        if (r.sched_origin) continue; // 期② 去重：班表块由 sched 源压线（块扫描/petal 过渡双路不重复）
        const at = parseRemindAt(r.at);
        if (!at) continue;
        const summary = trunc(stripTaskMark(r.content ?? ""));
        const base = { summary, source: "remind" as const, blockId: r.id };
        const rp = r.repeat ? parseRemindRepeat(r.repeat) : null;
        let sMs: number;
        let eMs: number | null;
        if (rp) {
            if (!todayIsOccurrence(r.at, rp, input.now)) continue;
            sMs = new Date(
                input.now.getFullYear(), input.now.getMonth(), input.now.getDate(),
                at.getHours(), at.getMinutes(),
            ).getTime();
            eMs = null;
        } else {
            sMs = at.getTime();
            eMs = r.end && remindEndValid(r.end, r.at) ? new Date(r.end).getTime() : null;
        }
        const it = clipRange(dayStart, sMs, eMs, base);
        if (it) items.push(it);
    }

    // task：done 不显示；区间（isIntervalTask 单一口径）=start~due；非区间 timed=due 锚点点事件；全天=due 当天托盘
    for (const t of dedupeById(input.taskRows)) {
        if (!t.due_date || !DATE_RE.test(t.due_date)) continue;
        if (doneOf(t)) continue;
        const summary = trunc(stripTaskMark(t.content ?? ""));
        const dueHm = parseHm(t.due_time);
        if (dueHm === null) {
            if (t.due_date === date) tray.push({ summary, source: "task", blockId: t.id });
            continue;
        }
        const base = { summary, source: "task" as const, blockId: t.id };
        if (isIntervalTask({ blockId: t.id, startDate: t.start_date, startTime: t.start_time, dueDate: t.due_date, dueTime: t.due_time })) {
            const sMs = Date.parse(`${t.start_date}T${t.start_time}`);
            const eMs = Date.parse(`${t.due_date}T${t.due_time}`);
            const it = clipRange(dayStart, sMs, eMs, base);
            if (it) items.push(it);
        } else {
            const it = clipRange(dayStart, Date.parse(`${t.due_date}T${t.due_time}`), null, base);
            if (it) items.push(it);
        }
    }

    const ledger = normalizeLedger(input.ledger ?? null);

    // burden：账本 flashcard-burden: 条目（日期 sySnap 反解同月历），当天进托盘（信息性，无时刻）
    for (const [key, e] of Object.entries(ledger.entries)) {
        if (!key.startsWith("flashcard-burden:")) continue;
        const snap = (e.sySnap ?? "").split("¦");
        const summary = (snap[0] ?? "").trim();
        const rawStart = snap[1];
        if (!summary || !rawStart) continue;
        const d = DATE_RE.test(rawStart) ? rawStart : (timestampToWallTime(rawStart)?.slice(0, 10) ?? null);
        if (d !== date) continue;
        tray.push({ summary: trunc(summary), source: "burden", blockId: parseBurdenKey(key)?.projectId });
    }

    // feishu 回流：镜像一次性+循环实例，账本分流去重只显飞书原创（月历同则）。
    // 定时条目 end 同日=区间、跨日=1439+overnight（跨天按 start 日锚定——end 日不重复显示，月历同则）
    const pluginEventIds = new Set<string>();
    for (const [key, e] of Object.entries(ledger.entries)) {
        if (e.eventId && !key.startsWith("weather:")) pluginEventIds.add(e.eventId);
    }
    const mirrorOneOffIds = new Set<string>();
    const mirror = normalizeMirror(input.mirror ?? null);
    if (mirror) {
        for (const ev of Object.values(mirror.events)) {
            if (ev.recurring || pluginEventIds.has(ev.id)) continue;
            mirrorOneOffIds.add(ev.id);
            if (ev.start.slice(0, 10) !== date) continue;
            const summary = trunc(stripTimeHead(ev.summary));
            if (ev.allDay) {
                tray.push({ summary, source: "feishu" });
                continue;
            }
            const startMin = parseHm(ev.start.slice(11, 16));
            // 脏 start 丢弃与月历刻意分叉：月历对同脏串照显原串、时间线按点列对齐丢弃（显错位不如不显）
            if (startMin === null) continue;
            let endMin: number | null = null;
            let overnight = false;
            if (ev.end && ev.end.slice(0, 10) === date) {
                const em = parseHm(ev.end.slice(11, 16));
                endMin = em !== null && em > startMin ? em : null;
            } else if (ev.end && ev.end.slice(0, 10) > date) {
                endMin = MIN_PER_DAY - 1;
                overnight = true;
            }
            items.push({ startMin, endMin, summary, source: "feishu", ...(overnight ? { overnight: true } : {}) });
        }
    }
    const seenInstanceIds = new Set<string>();
    for (const row of input.instances ?? []) {
        if (row.cancelled || seenInstanceIds.has(row.id)) continue;
        if (pluginEventIds.has(row.eventId) || mirrorOneOffIds.has(row.eventId)) continue;
        if (row.date !== date) continue;
        seenInstanceIds.add(row.id);
        const startMin = parseHm(row.time);
        if (startMin !== null) items.push({ startMin, endMin: null, summary: trunc(stripTimeHead(row.summary)), source: "feishu" });
        else tray.push({ summary: trunc(stripTimeHead(row.summary)), source: "feishu" });
    }

    // sched：当天条目；timed=行（end 脏值/无=null 点事件——归一层已钳 end>start，此处防御同则）；未定时=托盘
    for (const it of input.sched ?? []) {
        if (it.date !== date) continue;
        const summary = trunc(it.summary);
        const s = parseHm(it.start);
        if (s === null) {
            tray.push({ summary, source: "sched" });
            continue;
        }
        const e = parseHm(it.end);
        items.push({
            startMin: s,
            endMin: e !== null && e > s ? e : null,
            summary,
            source: "sched",
            ...(it.hard ? { hard: true } : {}),
        });
    }

    // ammo □7 live 实况段：日账打点（闭合段=真实起止区间；未闭合=运行中到当前分钟动态；
    // 跨零点闭合段 +24h 归一→clipRange overnight 标注同源）。append-only 纪律的读面投射：
    // 池/锚点/未闭合旗标随行带出（渲染层胶囊），日账=唯一真相本层只投影。
    for (const entry of input.ledgerEntries ?? []) {
        const s = parseHm(entry.start);
        if (s === null) continue;
        const sMs = dayStart + s * 60_000;
        let eMs: number | null;
        if (!entry.closed || entry.end === null) {
            // 未闭合=运行中：动态画到当前分钟（三态恒 active；指针推进自然延长）
            eMs = dayStart + Math.max(s + 1, input.now.getHours() * 60 + input.now.getMinutes()) * 60_000;
        } else {
            const e = parseHm(entry.end);
            const durMin = e === null ? null : e >= s ? e - s : e + MIN_PER_DAY - s; // 跨零点 +24h（ledgerDurationMin 同口径）
            eMs = durMin === null ? null : sMs + Math.max(1, durMin) * 60_000;
        }
        const it = clipRange(dayStart, sMs, eMs, {
            summary: trunc(entry.summary),
            source: "live",
            blockId: entry.id,
            ...(entry.pool ? { pool: entry.pool } : {}),
            ...(entry.anchor ? { anchor: true } : {}),
            ...(!entry.closed ? { unclosed: true } : {}),
        });
        if (it) items.push(it);
    }

    items.sort((a, b) => a.startMin - b.startMin || (a.endMin ?? MIN_PER_DAY - 1) - (b.endMin ?? MIN_PER_DAY - 1));
    return { date, items, tray };
}

/** 三态：upcoming（未开始）/ active（默认注意力窗内）/ past（窗外已过）。
 *  overnight 条目 endMin 被裁 1439 但真实越界——按 1440 比较防「23:59 已过→00:00 复活」翻转（reasoning P2） */
export function tlStateOf(item: TimelineItem, nowMin: number): TimelineState {
    if (nowMin < item.startMin) return "upcoming";
    const end = item.endMin === null ? item.startMin + TL_POINT_WINDOW_MIN : item.overnight ? MIN_PER_DAY : item.endMin;
    return nowMin < end ? "active" : "past";
}

/** 指针后第一条未开始条目（=「下一项」徽标目标；重叠允许口径下与 active 并存） */
export function tlNextItem(items: TimelineItem[], nowMin: number): TimelineItem | null {
    return items.find((i) => i.startMin > nowMin) ?? null;
}

/** 指针插入位：最后一条 startMin<=nowMin 的条目之后（0=最顶、items.length=底部） */
export function tlNowIndex(items: TimelineItem[], nowMin: number): number {
    let idx = 0;
    for (let i = 0; i < items.length; i++) {
        if (items[i].startMin <= nowMin) idx = i + 1;
    }
    return idx;
}
