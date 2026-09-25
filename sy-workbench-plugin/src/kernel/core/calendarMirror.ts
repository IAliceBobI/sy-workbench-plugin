// □17 飞书日历回流读链·纯逻辑核：镜像形态/合并/滚动窗裁剪/内容等价/勾选规则/实例行归一。
// 零 siyuan/网络依赖（单测边界）；网络与存储副作用在 kernel/calendarMirror.ts 编排层。
// 镜像=自愈缓存非账本（真相源在飞书侧，删坏可全量重建）；键=calendar_id/event_id。
import { timestampToWallTime } from "./ledger";

/** 镜像内单事件（list 通道产物；循环系列=主事件定义，实例按需走 instance_view） */
export interface MirrorEvent {
    /** event_id（飞书侧） */
    id: string;
    /** 所属日历 */
    cal: string;
    summary: string;
    /** 全天=YYYY-MM-DD；定时=YYYY-MM-DDTHH:mm（UTC+8 墙上时间，与账本 timestampToWallTime 同则） */
    start: string;
    /** 同上；跨天事件 v1 只按 start 日显示 */
    end: string;
    allDay: boolean;
    /** 循环系列主事件（recurrence 非空）——不参与滚动窗裁剪（系列定义），月历不直接显示 */
    recurring: boolean;
}

export interface CalendarMirror {
    events: Record<string, MirrorEvent>;
    /** 滚动窗（YYYY-MM-DDTHH:mm）：窗=过去 365 天+未来 183 天（拍板「1~2 年滚动」） */
    winStart: string;
    winEnd: string;
    /** 镜像范围收缩时被清场的事件 id 集（□25 P0-1 守卫）：writeback/drift 判删前查——命中=我方
     *  清场（取消勾选/换账号）非用户删，不判删。挂镜像档本体=随 verified 写原子落盘（挂 meta
     *  则清场镜像已写、evicted 裸写失败=不可再生，P1-2）；只增不减（重勾选后事件回镜像自然免疫） */
    evicted?: Record<string, true>;
}

export interface MirrorCalInfo {
    id: string;
    summary: string;
    description: string;
    type: string;
}

export interface MirrorMeta {
    catalog: MirrorCalInfo[];
    /** 每历增量游标；全量重建=清空让下轮走 anchor 模式 */
    tokens: Record<string, string>;
}

export interface MirrorConf {
    /** calendarId→勾选；null/缺文件=默认规则（resolveChecked） */
    checked: Record<string, boolean> | null;
}

export interface InstanceRow {
    /** 实例行键=eventId+start（同系多实例去重；例外实例有独立 eventId 自然不撞） */
    id: string;
    eventId: string;
    summary: string;
    allDay: boolean;
    /** YYYY-MM-DD */
    date: string;
    /** HH:mm | null=全天 */
    time: string | null;
    cancelled: boolean;
}

export function emptyMirror(): CalendarMirror {
    return { events: {}, winStart: "", winEnd: "" };
}

/** 滚动窗边界（日粒度 YYYY-MM-DD——分钟级会让镜像每轮都「变化」击穿内容防抖=重载风暴）；
 *  与事件 start（datetime 串）字典序可比性保持（同 YYYY-MM-DD 前缀序） */
export function windowBounds(now: Date): { start: string; end: string } {
    const day = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
    return { start: day(new Date(now.getTime() - 365 * 86_400_000)), end: day(new Date(now.getTime() + 183 * 86_400_000)) };
}

function normStr(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** list 通道事件行 → MirrorEvent（脏行=缺 id/summary/时间返回 null 静默跳过） */
export function eventToMirror(cal: string, ev: any): MirrorEvent | null {
    const id = normStr(ev?.event_id);
    if (!id || !cal) return null;
    const allDay = Boolean(ev?.start_time?.date);
    const start = allDay
        ? normStr(ev.start_time.date)
        : (timestampToWallTime(ev?.start_time?.timestamp) ?? "");
    const end = allDay
        ? normStr(ev?.end_time?.date)
        : (timestampToWallTime(ev?.end_time?.timestamp) ?? "");
    if (!start) return null; // 无起点=无法落格
    return {
        id,
        cal,
        summary: normStr(ev?.summary) || "(无标题)",
        start,
        end,
        allDay,
        recurring: Array.isArray(ev?.recurrence) ? ev.recurrence.length > 0 : Boolean(ev?.recurrence),
    };
}

export function mirrorKey(cal: string, id: string): string {
    return `${cal}/${id}`;
}

/** 合并增量批次到镜像：upsert 存活事件 / 删墓碑（status=cancelled）；
 *  非循环事件按 start 日期只裁**过去侧**窗外（循环主事件=系列定义不裁剪）。
 *  ⚠未来侧不裁（□25 复审 P1-1）：create 侧无上界（AI 可排数月后），sync_token 增量对远未来
 *  事件只交付一次——若同轮裁掉则 delta 已消费永不重发，镜像永久缺席；待 winEnd 滚到该日，
 *  planner 窗守卫失效=idx miss 被判删（本地误删+飞书孤儿）。过去侧滚出=planner 恒 skip，安全。
 *  resetCals=按历重建（anchor 全量拉的现存清单不含被删事件、无墓碑可删——不重建则删除滞留假在显；
 *  覆盖游标失效降级/meta 丢失/重勾选三条路径）。 */
export function mergeMirrorBatch(
    prev: CalendarMirror,
    batch: MirrorEvent[],
    tombstones: string[],
    bounds: { start: string; end: string },
    resetCals: string[] = [],
): CalendarMirror {
    const events: Record<string, MirrorEvent> = { ...prev.events };
    if (resetCals.length) {
        for (const [key, ev] of Object.entries(events)) if (resetCals.includes(ev.cal)) delete events[key];
    }
    for (const ev of batch) events[mirrorKey(ev.cal, ev.id)] = ev;
    for (const key of tombstones) delete events[key];
    // 过去侧窗外裁剪（非循环）：按日期段比（YYYY-MM-DD 切片）——datetime 串对同前缀日串字典序
    // 恒大，不切片会把「窗起日 00:00 前的定时事件」误判出窗（且增量 delta 已消费=永不自愈）
    for (const [key, ev] of Object.entries(events)) {
        if (ev.recurring) continue;
        if (ev.start.slice(0, 10) < bounds.start) delete events[key];
    }
    return { events, winStart: bounds.start, winEnd: bounds.end, ...(prev.evicted ? { evicted: prev.evicted } : {}) };
}

/** 规范化（键排序+字段定序）——序列化稳定，内容等价比较才有意义 */
export function canonicalMirror(m: CalendarMirror): CalendarMirror {
    const events: Record<string, MirrorEvent> = {};
    for (const key of Object.keys(m.events).sort()) {
        const e = m.events[key];
        events[key] = { id: e.id, cal: e.cal, summary: e.summary, start: e.start, end: e.end, allDay: e.allDay, recurring: e.recurring };
    }
    return { events, winStart: m.winStart, winEnd: m.winEnd, ...(m.evicted ? { evicted: m.evicted } : {}) };
}

export function mirrorEquals(a: CalendarMirror | null, b: CalendarMirror | null): boolean {
    return JSON.stringify(canonicalMirror(a ?? { events: {}, winStart: "", winEnd: "" }))
        === JSON.stringify(canonicalMirror(b ?? { events: {}, winStart: "", winEnd: "" }));
}

/** 盘上镜像防御性归一（缺文件/损坏/旧形态→null 空态重拉全量） */
export function normalizeMirror(raw: any): CalendarMirror | null {
    if (!raw || typeof raw !== "object" || !raw.events || typeof raw.events !== "object") return null;
    const out: Record<string, MirrorEvent> = {};
    for (const [key, v] of Object.entries(raw.events as Record<string, any>)) {
        if (!v || typeof v !== "object" || !v.id || !v.cal || !v.start) continue;
        out[key] = {
            id: String(v.id), cal: String(v.cal), summary: String(v.summary ?? "(无标题)"),
            start: String(v.start), end: String(v.end ?? ""), allDay: Boolean(v.allDay), recurring: Boolean(v.recurring),
        };
    }
    // evicted（旧档无此字段=空=守卫退化为现状）
    let evicted: Record<string, true> | undefined;
    if (raw?.evicted && typeof raw.evicted === "object") {
        evicted = {};
        for (const k of Object.keys(raw.evicted)) evicted[k] = true;
    }
    return { events: out, winStart: String(raw.winStart ?? ""), winEnd: String(raw.winEnd ?? ""), ...(evicted ? { evicted } : {}) };
}

export function normalizeMeta(raw: any): MirrorMeta {
    const catalog: MirrorCalInfo[] = [];
    for (const it of Array.isArray(raw?.catalog) ? raw.catalog : []) {
        if (!it?.id) continue;
        catalog.push({ id: String(it.id), summary: String(it.summary ?? ""), description: String(it.description ?? ""), type: String(it.type ?? "") });
    }
    const tokens: Record<string, string> = {};
    if (raw?.tokens && typeof raw.tokens === "object") {
        for (const [k, v] of Object.entries(raw.tokens)) if (typeof v === "string" && v) tokens[k] = v;
    }
    catalog.sort((a, b) => (a.id < b.id ? -1 : 1)); // 序稳定：目录比较对数组序敏感（review P1-4）
    return { catalog, tokens };
}

/** 默认勾选规则（拍板：全部日历，系统日历「节假日」默认不勾——防与 □16 本地历法层双显）。
 *  conf.checked 显式列出的日历以 conf 为准（新出现的日历不在 conf 里=默认规则判定）。 */
export function resolveChecked(catalog: MirrorCalInfo[], checked: Record<string, boolean> | null | undefined): Array<MirrorCalInfo & { on: boolean }> {
    return catalog.map((c) => {
        if (checked && Object.prototype.hasOwnProperty.call(checked, c.id)) return { ...c, on: Boolean(checked[c.id]) };
        const systemHoliday = /节假日|假期/.test(c.summary) || /节假日|假期/.test(c.description);
        return { ...c, on: !systemHoliday };
    });
}

/** instance_view 实例行归一（kernel 侧统一形态给前端；脏行 null 跳过） */
export function instanceToRow(ev: any): InstanceRow | null {
    const eventId = normStr(ev?.event_id);
    const allDay = Boolean(ev?.start_time?.date);
    const wall = allDay ? normStr(ev.start_time.date) : (timestampToWallTime(ev?.start_time?.timestamp) ?? "");
    if (!eventId || !wall) return null;
    return {
        id: `${eventId}#${wall}`,
        eventId,
        summary: normStr(ev?.summary) || "(无标题)",
        allDay,
        date: allDay ? wall : wall.slice(0, 10),
        time: allDay ? null : wall.slice(11, 16),
        cancelled: normStr(ev?.status) === "cancelled",
    };
}
