// timeblock 期 2 ②：统一时间轴纯逻辑层（Calendar 日面板消费）。
// 四源（日记班表块 rpc 读/全库 remind 块 SQL/任务截止 SQL/飞书镜像过渡）+burden 托盘行 →
// 当日 slots（真占位：start/end/durationMin/lane 车道）+tray（未定时行）。
// 虚实标记：有块=实（可拖改属性）；无块=虚（飞书镜像，display-only）。
// 同步徽标：账本 sched:<块id> 有 entry=已同步飞书（schedSyncPlan 只镜像定时条目——徽标只挂 slots）。
// 15 分钟吸附=snapToStep；日窗闸在数据入口（boardRowsToSchedItems/schedBoardReadRpc）已过。
// 零 siyuan 运行时依赖（输入原始行/档直出，channels 纪律：kernel bundle 与前端共用同源）。
import { isDone } from "@/kernel/core/progressCalc";
import { isDueRemind, parseRemindAt, parseRemindRepeat, remindKey, stripTaskMark, todayIsOccurrence } from "@/kernel/core/remind";
import { parseBurdenKey } from "@/kernel/core/burden";
import { normalizeLedger, timestampToWallTime } from "@/kernel/core/ledger";
import { normalizeMirror, type InstanceRow } from "@/kernel/core/calendarMirror";
import { hmToMin, type SchedItem } from "@/kernel/core/schedule";
import type { AmmoLedgerEntry } from "@/kernel/core/ammoLedger";
import { liveLedgerKey } from "@/kernel/core/ammoLiveSync";
import type { RemindScanRow, TaskDueRow } from "./queries";
import { adoptability } from "./queries";

/** 点事件展示时长（无 end 的 remind/task/bare board 条目——真占位布局的最小可见块） */
export const DAY_AXIS_POINT_MIN = 30;
/** 槽视觉高度下限（分钟）：30min 点事件的槽要装下「时刻行+摘要行」两行文字
 *  （vision tb2c P1-1：下限 24min=19px 时摘要行被 overflow 裁掉大半）；车道判定同用此值
 *  保持视觉高度与重叠判定一致 */
export const DAY_AXIS_MIN_SLOT_MIN = 50;
/** 拖动吸附步长（分钟；bear 拍板 15） */
export const DAY_AXIS_SNAP_MIN = 15;

/** timeblock 期 2 ② 五源 + ammo □7 实况回填：live=日账打点段（回望形态——不可拖不可删，
 *  append-only 纪律：实况是发生过的历史，改历史=改日账本体，只读投影） */
export type DayAxisSource = "board" | "remind" | "task" | "feishu" | "burden" | "live";

/** 轴上定时槽位（真占位：top=start*pxPerMin、height=durationMin*pxPerMin） */
export interface DayAxisSlot {
    key: string;
    source: DayAxisSource;
    summary: string;
    start: string;
    end: string | null;
    /** 展示时长（分钟）=end-start 或点事件默认 */
    durationMin: number;
    /** 实块=有块 id（board/remind/task 可拖改属性）；虚=飞书镜像 */
    blockId?: string;
    virtual: boolean;
    /** board/live 源：账本有绑定 entry=已同步飞书（board=remind:/sched: 两前缀——期 4 起
     *  班表块走 remind 轨，只查旧 sched: 前缀=「假未同步」真 bug □7 顺修；live=ammo-live: 键） */
    synced: boolean;
    hard?: boolean;
    /** board 源 origin（report=周报 chip 语义） */
    origin?: SchedItem["origin"];
    /** remind 循环行=不可拖（改基础时刻会挪全部实例） */
    repeat: boolean;
    /** 红态：已到/已过（时刻级；board/feishu/burden 恒 false——班表不做截止压迫） */
    isDue: boolean;
    /** feishu 源：事件 id +落地可行性（□17 同则；③ 全映射后「存入班表」钮退役） */
    eventId?: string;
    adoptable?: boolean;
    adoptBlock?: "allDay" | "recurring" | "unrepresentable" | "too_old" | "already";
    /** live 源专属：池 slug（空=锚点出发型/无池临时） */
    pool?: string;
    /** live 源专属：锚点出发型打点 */
    anchor?: boolean;
    /** live 源专属：未闭合（运行中——槽动态画到当前分钟） */
    unclosed?: boolean;
    /** 重叠车道（0 起）+所在重叠簇的车道总数（宽度=1/lanes） */
    lane: number;
    lanes: number;
}

/** 托盘行（未定时）：board 条目可拖上轴；feishu 全天/burden/无时刻任务=display-only */
export interface DayAxisTrayRow {
    key: string;
    source: DayAxisSource;
    summary: string;
    /** board 托盘条目=块 id（拖上轴改属性的唯一可写源） */
    blockId?: string;
    origin?: SchedItem["origin"];
    virtual: boolean;
    eventId?: string;
    adoptable?: boolean;
    adoptBlock?: "allDay" | "recurring" | "unrepresentable" | "too_old" | "already";
    /** 期 2 ③ 全映射 adopt：全天事件托盘行标记（渲染「全天」前缀） */
    allDay?: boolean;
}

export interface DayAxisModel {
    slots: DayAxisSlot[];
    tray: DayAxisTrayRow[];
}

/** 拖动落点分钟吸附（就近取整到 step 刻度；负值钳 0、贴 24:00 回退一刻——起点不得为 24:00） */
export function snapToStep(min: number, step: number = DAY_AXIS_SNAP_MIN): number {
    const snapped = Math.round(min / step) * step;
    return Math.max(0, Math.min(24 * 60 - step, snapped));
}

// ── 期 2 ⑤ 条目右键三动作矩阵（bear 二轮拍板：重建块/删除含块/去时间） ──

export type DayMenuAction = "rebuild" | "delete" | "untime";

/** 条目（槽/托盘行通用结构）→右键菜单动作清单。timed=是否定时槽（托盘行 false——
 *  「去时间」对无时刻条目无意义）。
 *  无块虚显（feishu）→重建块（adopt 落块）+删除（删飞书事件）；
 *  有块 board →删除（连块=remove 通道）+去时间（清时刻变托盘）；
 *  有块 remind/task →删除（连块删）+去时间（清时间属性退役出日程）；
 *  循环 remind=空（动基础属性挪全部实例，与不可拖同因）；burden 派生行=空；
 *  live 实况段=空（append-only 纪律：不动历史，□7）。 */
export function entryMenuActions(e: { source: DayAxisSource; virtual?: boolean; blockId?: string; repeat?: boolean; timed?: boolean; adoptable?: boolean; adoptBlock?: string }): DayMenuAction[] {
    if (e.source === "burden" || e.source === "live") return [];
    if (e.virtual || !e.blockId) {
        if (e.source !== "feishu") return [];
        // 循环实例行：删除=删整个飞书系列（与所见不符，review P1-1）、重建=纯层恒拒（P2-4）——无动作
        if (e.adoptBlock === "recurring") return [];
        return e.adoptable === false ? ["delete"] : ["rebuild", "delete"];
    }
    if (e.repeat) return [];
    return e.timed ? ["delete", "untime"] : ["delete"];
}

// ── caltab 期：月历事件条右键三动作（共识第 4 点：删除/跳到源块/在时间线中打开） ──

export type MonthMenuAction = "delete" | "jump" | "timeline";

/** 月历事件条 → 右键动作清单（月历侧消费；动作集与轴侧不同、语义与 entryMenuActions 同源）。
 *  删除：复用 entryMenuActions 语义含特判——真块（sched=班表块/remind/task）=删块/移除班表行，
 *   飞书虚显=删飞书事件；循环 remind（repeat）/循环实例行（adoptBlock=recurring）/burden 派生行
 *   不可删（动基础块/系列会波及全部实例——与轴侧同因）。
 *  跳到源块：有 blockId 即可（burden=项目主文档同可跳、与月历点条目行为一致；feishu 虚显无源块不跳）。
 *  在时间线中打开：恒有（任何事件条都属一天）。
 *  source 词汇映射：月历 sched（buildMonthModel 班表块源）=轴侧 board；入参与 gui/queries
 *  MonthEvent 结构兼容（MonthEvent 可整对象直传，repeat 旗标由月历侧从 RemindScanRow 补——
 *  MonthEvent 不携带该字段）。 */
export function monthEventMenuActions(e: {
    source: "remind" | "task" | "burden" | "feishu" | "sched" | "live";
    blockId?: string;
    /** remind 循环行旗标（调用方从 RemindScanRow.repeat 判得；缺失=按非循环处理） */
    repeat?: boolean;
    adoptable?: boolean;
    adoptBlock?: string;
}): MonthMenuAction[] {
    const axis = entryMenuActions({
        source: e.source === "sched" ? "board" : e.source,
        virtual: e.source === "feishu",
        blockId: e.blockId,
        repeat: e.repeat,
        timed: true,
        adoptable: e.adoptable,
        adoptBlock: e.adoptBlock,
    });
    const acts: MonthMenuAction[] = [];
    if (axis.includes("delete")) acts.push("delete");
    if (e.blockId) acts.push("jump");
    acts.push("timeline");
    return acts;
}

// ── caltab 增补一 □3：当前块判定（时间线走针的「进行中」描边） ──

/** 分钟落在槽视觉占位区间 → 该槽=进行中。区间=[startMin, startMin+max(durationMin,
 *  DAY_AXIS_MIN_SLOT_MIN))——与模板渲染高度/车道判定同源的视觉下限（点事件 end=null 无文字
 *  区间，按 50min 视觉占位判「正在发生」）；start 端含（恰跨 start 边界=进行中）、末端不含
 *  （落到 end=下一块的 start 归下一块）。重叠车道各自独立判（两道都盖住=都算进行中）。 */
export function slotIsActiveAt(s: { start: string; durationMin: number }, min: number): boolean {
    if (!Number.isFinite(min) || min < 0 || min >= 24 * 60) return false;
    const startMin = hmToMin(s.start);
    const endMin = startMin + Math.max(s.durationMin, DAY_AXIS_MIN_SLOT_MIN);
    return min >= startMin && min < endMin;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUMMARY_MAX = 100;
const MIN_PER_DAY = 24 * 60;

function truncSummary(s: string): string {
    return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + "…" : s;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hmOf = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** 时长（分钟）：end 合法且>start 用真值；否则点事件默认 */
function durationOf(start: string, end: string | null): number {
    if (end && TIME_RE.test(end) && hmToMin(end) > hmToMin(start)) return hmToMin(end) - hmToMin(start);
    return DAY_AXIS_POINT_MIN;
}

/** 重叠车道打包（真占位布局）：按 start 升序贪心配道——同道内永不重叠（贴边=可共道）；
 *  重叠链成簇（b.start < 簇末端即入簇），簇内 lanes=最大道数（宽度分母簇内一致）。 */
function packLanes(slots: Array<{ start: string; durationMin: number }>): Array<{ lane: number; lanes: number }> {
    const out: Array<{ lane: number; lanes: number }> = [];
    const laneEnds: number[] = []; // 每车道当前占用末端（分钟）
    let clusterEnd = -1; // 当前簇末端（起点≥它=分新簇）
    let clusterStartIdx = 0;
    let clusterMaxLanes = 0;
    slots.forEach((s, i) => {
        const startMin = hmToMin(s.start);
        const endMin = startMin + s.durationMin;
        if (clusterEnd >= 0 && startMin >= clusterEnd) {
            for (let j = clusterStartIdx; j < i; j++) out[j].lanes = clusterMaxLanes;
            clusterStartIdx = i;
            clusterMaxLanes = 0;
            laneEnds.length = 0;
            clusterEnd = -1;
        }
        let lane = laneEnds.findIndex((e) => e <= startMin);
        if (lane === -1) {
            lane = laneEnds.length;
            laneEnds.push(endMin);
        } else {
            laneEnds[lane] = endMin;
        }
        out[i] = { lane, lanes: lane + 1 };
        clusterMaxLanes = Math.max(clusterMaxLanes, lane + 1);
        clusterEnd = Math.max(clusterEnd, endMin);
    });
    for (let j = clusterStartIdx; j < slots.length; j++) out[j].lanes = clusterMaxLanes;
    return out;
}

/** 四源+burden+实况 → 当日统一时间轴模型。输入原始行（SQL/rpc/档直出），脏值静默跳过；
 *  remind 行带 sched_origin 旗标=班表块（board 路渲染，此处跳过——双路不重复）。
 *  ammo □7：ledgerEntries=当日日账打点（live 槽=回望形态，不可拖不可删；未闭合段动态画到 now）。 */
export function buildDayAxis(input: {
    day: string;
    today: string;
    now: Date;
    boardItems: SchedItem[];
    remindRows: RemindScanRow[];
    taskRows: TaskDueRow[];
    mirror?: unknown;
    instances?: InstanceRow[];
    ledger?: unknown;
    /** ammo □7：当日日账打点条目（kernel rpc ammo-ledger-read 单日形态；缺=实况段缺席） */
    ledgerEntries?: AmmoLedgerEntry[];
}): DayAxisModel {
    const { day, today, now } = input;
    const slots: DayAxisSlot[] = [];
    const tray: DayAxisTrayRow[] = [];
    const ledger = normalizeLedger((input.ledger as any) ?? null);

    // 班表块（rpc 日读，已过日窗闸）：定时=slot（synced=账本 remind:/sched: 两前缀任一有
    // entry——期 4 起班表块走 remind 轨推飞书，只查旧 sched: 前缀=恒「未同步」假态，□7 顺修）；
    // 托盘=tray 行
    for (const it of input.boardItems) {
        if (it.date !== day) continue;
        if (!it.start) {
            tray.push({ key: it.key, source: "board", summary: truncSummary(it.summary), blockId: it.key, origin: it.origin, virtual: false, ...(it.allDay ? { allDay: true } : {}) });
            continue;
        }
        slots.push({
            key: it.key,
            source: "board",
            summary: truncSummary(it.summary),
            start: it.start,
            end: it.end,
            durationMin: durationOf(it.start, it.end),
            blockId: it.key,
            virtual: false,
            synced: Boolean(ledger.entries[remindKey(it.key)] ?? ledger.entries[`sched:${it.key}`]),
            hard: it.hard,
            origin: it.origin,
            repeat: false,
            isDue: false,
            lane: 0,
            lanes: 1,
        });
    }

    // remind 块（全库 SQL）：非班表块（sched_origin 有值=board 路已渲染）；循环=今日触发日
    for (const r of input.remindRows) {
        if (r.sched_origin) continue;
        const at = parseRemindAt(r.at);
        if (!at) continue;
        const rp = r.repeat ? parseRemindRepeat(r.repeat) : null;
        const isToday = rp ? todayIsOccurrence(r.at, rp, new Date(day + "T00:00")) : isoDate(at) === day;
        if (!isToday) continue;
        const start = hmOf(at);
        const endHM = r.end && isoDate(parseRemindAt(r.end) ?? at) === isoDate(at) && parseRemindAt(r.end)! > at ? hmOf(parseRemindAt(r.end)!) : null;
        slots.push({
            key: r.id,
            source: "remind",
            summary: truncSummary(stripTaskMark(r.content ?? "")),
            start,
            end: endHM,
            durationMin: durationOf(start, endHM),
            blockId: r.id,
            virtual: false,
            synced: false,
            repeat: Boolean(rp),
            isDue: day < today ? true : day === today ? isDueRemind(r.at, now, r.repeat) : false,
            lane: 0,
            lanes: 1,
        });
    }

    // 任务截止：done 不显示（isDone 同源）；有 due_time=slot 点事件；无=托盘
    for (const t of input.taskRows) {
        if (t.due_date !== day || !t.due_date || !DATE_RE.test(t.due_date)) continue;
        if (isDone({ id: t.id, content: t.content, markdown: t.markdown, updated: "", root_id: "" })) continue;
        if (t.due_time && TIME_RE.test(t.due_time)) {
            slots.push({
                key: t.id,
                source: "task",
                summary: truncSummary(t.content ?? ""),
                start: t.due_time,
                end: null,
                durationMin: DAY_AXIS_POINT_MIN,
                blockId: t.id,
                virtual: false,
                synced: false,
                repeat: false,
                isDue: day < today ? true : day === today ? hmToMin(t.due_time) <= now.getHours() * 60 + now.getMinutes() : false,
                lane: 0,
                lanes: 1,
            });
        } else {
            tray.push({ key: t.id, source: "task", summary: truncSummary(t.content ?? ""), blockId: t.id, virtual: false });
        }
    }

    // 飞书镜像过渡（□17 同则）：账本已绑事件分流去重（块源渲染）；只显飞书原创
    const pluginEventIds = new Set<string>();
    for (const [key, e] of Object.entries(ledger.entries)) if (e.eventId && !key.startsWith("weather:")) pluginEventIds.add(e.eventId);
    const allBoundIds = new Set<string>();
    for (const [, e] of Object.entries(ledger.entries)) if (e.eventId) allBoundIds.add(e.eventId);
    const mirror = normalizeMirror(input.mirror ?? null);
    const mirrorOneOffIds = new Set<string>();
    if (mirror) {
        for (const ev of Object.values(mirror.events)) {
            if (ev.recurring || pluginEventIds.has(ev.id)) continue;
            if (ev.start.slice(0, 10) !== day) continue;
            mirrorOneOffIds.add(ev.id);
            if (ev.allDay) {
                tray.push({
                    key: ev.id,
                    source: "feishu",
                    summary: truncSummary(ev.summary),
                    virtual: true,
                    eventId: ev.id,
                    ...(allBoundIds.has(ev.id) ? { adoptable: false, adoptBlock: "already" as const } : adoptability(ev, today)),
                });
                continue;
            }
            const start = ev.start.slice(11, 16);
            const endHM = ev.end && ev.end.slice(0, 10) === ev.start.slice(0, 10) && ev.end.slice(11, 16) > start ? ev.end.slice(11, 16) : null;
            slots.push({
                key: ev.id,
                source: "feishu",
                summary: truncSummary(ev.summary),
                start,
                end: endHM,
                durationMin: durationOf(start, endHM),
                virtual: true,
                synced: false,
                repeat: false,
                isDue: false,
                eventId: ev.id,
                ...(allBoundIds.has(ev.id) ? { adoptable: false, adoptBlock: "already" as const } : adoptability(ev, today)),
                lane: 0,
                lanes: 1,
            });
        }
    }
    // 循环系列实例：cancelled 跳过；恒不可落地（镜像只有系列定义）
    const seenInstanceIds = new Set<string>();
    for (const row of input.instances ?? []) {
        if (row.cancelled || row.date !== day || seenInstanceIds.has(row.id)) continue;
        if (pluginEventIds.has(row.eventId) || mirrorOneOffIds.has(row.eventId)) continue;
        seenInstanceIds.add(row.id);
        if (row.time) {
            slots.push({
                key: row.id,
                source: "feishu",
                summary: truncSummary(row.summary),
                start: row.time,
                end: null,
                durationMin: DAY_AXIS_POINT_MIN,
                virtual: true,
                synced: false,
                repeat: false,
                isDue: false,
                eventId: row.eventId,
                adoptable: false,
                adoptBlock: "recurring",
                lane: 0,
                lanes: 1,
            });
        } else {
            tray.push({ key: row.id, source: "feishu", summary: truncSummary(row.summary), virtual: true, eventId: row.eventId, adoptable: false, adoptBlock: "recurring" });
        }
    }

    // burden：账本信息性全天事件 → 托盘行
    for (const [key, e] of Object.entries(ledger.entries)) {
        if (!key.startsWith("flashcard-burden:")) continue;
        const snap = (e.sySnap ?? "").split("¦");
        const summary = (snap[0] ?? "").trim();
        const rawStart = snap[1];
        if (!summary || !rawStart) continue;
        const date = DATE_RE.test(rawStart) ? rawStart : (() => { const w = timestampToWallTime(rawStart); return w ? w.slice(0, 10) : null; })();
        if (date !== day) continue;
        tray.push({ key, source: "burden", summary, blockId: parseBurdenKey(key)?.projectId, virtual: false });
    }

    // ammo □7 live 实况段（回望形态）：日账打点=真实起止区间槽；未闭合=运行中动态画到
    // 当前分钟（durationMin 随 now 长大——axis 重算挂广播驱动非轮询）；跨零点闭合段画到
    // 轴底（+24h 归一的真时长在 24h 轴上无意义，裁到 24:00+overnight 语义由回望注承担）。
    // synced=账本 ammo-live: 键有 entry（实况推飞书过）；append-only：不可拖不可删（右键无动作）。
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (const entry of input.ledgerEntries ?? []) {
        if (!TIME_RE.test(entry.start)) continue;
        const unclosed = !entry.closed || entry.end === null;
        const endHM = unclosed ? null : entry.end;
        let durationMin: number;
        if (unclosed) {
            durationMin = Math.max(DAY_AXIS_MIN_SLOT_MIN, nowMin - hmToMin(entry.start));
        } else if (endHM && TIME_RE.test(endHM) && hmToMin(endHM) > hmToMin(entry.start)) {
            durationMin = hmToMin(endHM) - hmToMin(entry.start);
        } else if (endHM && TIME_RE.test(endHM) && hmToMin(endHM) < hmToMin(entry.start)) {
            durationMin = MIN_PER_DAY - hmToMin(entry.start); // 跨零点（end<start）——画到轴底
        } else {
            // 零长闭合段（end==start，秒级开始停止）与脏 end 同兜底=点事件时长
            // （P1-A：等值误走跨零点分支会把段画到 24:00 轴底——视觉下限仍保最小占位）
            durationMin = DAY_AXIS_POINT_MIN;
        }
        slots.push({
            key: entry.id,
            source: "live",
            summary: truncSummary(entry.summary),
            start: entry.start,
            end: unclosed ? null : endHM,
            durationMin,
            blockId: entry.id,
            virtual: false,
            synced: Boolean(ledger.entries[liveLedgerKey(entry.id)]),
            repeat: false,
            isDue: false,
            ...(entry.pool ? { pool: entry.pool } : {}),
            ...(entry.anchor ? { anchor: true } : {}),
            ...(unclosed ? { unclosed: true } : {}),
            lane: 0,
            lanes: 1,
        });
    }

    slots.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    // 车道重叠判定按视觉下限时长（与模板渲染高度同源——不一致时相邻点事件会同道视觉重叠）
    const lanes = packLanes(slots.map((s) => ({ start: s.start, durationMin: Math.max(s.durationMin, DAY_AXIS_MIN_SLOT_MIN) })));
    slots.forEach((s, i) => {
        s.lane = lanes[i].lane;
        s.lanes = lanes[i].lanes;
    });
    return { slots, tray };
}
