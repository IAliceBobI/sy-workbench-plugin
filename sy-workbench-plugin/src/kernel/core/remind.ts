// 块提醒·纯逻辑层（remind □1）：属性解析/短文字/红态/事件载荷/剪枝决策/SQL 构造。
// 零 siyuan/网络依赖（kernel bundle 与前端 bundle 共用同一份源——channels 纪律：只允许零依赖纯函数）。
// 时间语义：值=本地墙上时间（Asia/Shanghai 语义），飞书侧换算显式锚 +08:00（core/feishu TZ_OFFSET 同则）。
import { dueToTimeRange, dualReminders, type EventPayload, type SyncMapping } from "./feishu";

/** 唯一事实源属性：任意块（含文档块）挂一次性提醒时间 */
export const ATTR_REMIND_AT = "custom-remind-at";
/** □2 循环规则属性：四种 v1 枚举（remind-at 兼作循环起始时间=DTSTART 锚）。
 *  weekly=ISO 星期 1(一)~7(日)（读侧宽容去重排序，面板写规范化形态）；monthly=1~31
 *  （短月无该日跳过该月=RFC/飞书 BYMONTHDAY 语义，与执行器一致）；every=每隔 N 天（N≥1，1 等价 daily） */
export const ATTR_REMIND_REPEAT = "custom-remind-repeat";
/** □16 结束时间属性：可空（空=开放时长，镜像用默认 30min——旧数据零迁移）；值形态同 remind-at。
 *  语义=事件时长（跨天允许：22:00~次日01:00）；循环时与 at 的差=每期 duration */
export const ATTR_REMIND_END = "custom-remind-end";
/** 值形态：YYYY-MM-DDTHH:mm（无秒无时区——秒粒度对提醒无意义，时区恒本地）；
 *  数字段带值域（13 月/25 时是脏值——手改属性防病态值进同步链） */
export const REMIND_AT_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/;
/** timed 事件时长（提醒锚点语义，非会议时长——与任务 due 同则） */
export const REMIND_EVENT_DURATION_MIN = 30;
const SUMMARY_MAX = 100;
const NO_CONTENT = "（无内容）";

export function parseRemindAt(v: string): Date | null {
    if (!REMIND_AT_RE.test(v)) return null;
    const d = new Date(v); // 无时区段=本地墙上时间解析（Date.parse 的 ES 规范行为）
    return Number.isNaN(d.getTime()) ? null : d;
}

/** T 拆 date/time（供 dueToTimeRange 与 datetime-local 初值复用）；非法 throw=写入口守卫 */
export function splitRemindAt(v: string): { date: string; time: string } {
    if (!REMIND_AT_RE.test(v)) throw new Error(`invalid ${ATTR_REMIND_AT}: ${v}`);
    const [date, time] = v.split("T");
    return { date, time };
}

/** 结束时间校验（□16）：空值合法（=开放时长）；非空须形态合法且严格晚于开始。
 *  手改属性直写库的脏值在同步链行级记 invalid（与 at/repeat 同纪律——脏值可见不静默吞） */
export function remindEndValid(end: string | null | undefined, remindAt: string): boolean {
    if (!end) return true;
    if (!REMIND_AT_RE.test(end)) return false;
    const d = new Date(end);
    const at = parseRemindAt(remindAt);
    return !Number.isNaN(d.getTime()) && at !== null && d.getTime() > at.getTime();
}

/** 短文字：同年 MM-DD HH:mm / 异年 YYYY-MM-DD HH:mm；非法值原样（图标容错显示）。
 *  □16 同日 end 平铺后缀（~HH:mm，信息不藏 hover）；跨日 end 不拼（跨零点场景锚点可读性优先） */
export function formatShortRemind(v: string, now: Date, end?: string | null): string {
    const d = parseRemindAt(v);
    if (!d) return v;
    const p = (n: number) => String(n).padStart(2, "0");
    const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    let s = d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
    if (end && REMIND_AT_RE.test(end)) {
        const e = new Date(end);
        if (!Number.isNaN(e.getTime())
            && d.getFullYear() === e.getFullYear() && d.getMonth() === e.getMonth() && d.getDate() === e.getDate()) {
            s += `~${p(e.getHours())}:${p(e.getMinutes())}`;
        }
    }
    return s;
}

/** 红态判据（拍板）：单次=remindAt 所在日 <= 今日（当天或已过）→红；
 *  循环=今日触发日且时刻已过（红到当天结束，跨日自然清——非任务块 v1 无完成概念=事件随日历滚动） */
export function isDueRemind(v: string, now: Date, repeat?: string | null): boolean {
    const d = parseRemindAt(v);
    if (!d) return false;
    const rp = repeat ? parseRemindRepeat(repeat) : null;
    if (!rp) {
        const y = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
        return y(d) <= y(now);
    }
    if (!todayIsOccurrence(v, rp, now)) return false;
    return now.getTime() >= new Date(now.getFullYear(), now.getMonth(), now.getDate(), d.getHours(), d.getMinutes()).getTime();
}

// ── □2 循环：解析/展开/载荷部件 ──

export type RemindRepeat =
    | { kind: "daily" }
    | { kind: "weekly"; days: number[] }
    | { kind: "monthly"; day: number }
    | { kind: "every"; days: number };

/** every 上限（10 年，防脏值撑爆载荷/日历） */
export const REPEAT_DAYS_MAX = 3650;

export function parseRemindRepeat(v: string | null | undefined): RemindRepeat | null {
    if (!v) return null;
    if (v === "daily") return { kind: "daily" };
    let m = /^weekly:([1-7](?:,[1-7])*)$/.exec(v);
    if (m) return { kind: "weekly", days: [...new Set(m[1].split(",").map(Number))].sort((a, b) => a - b) };
    m = /^monthly:(\d{1,2})$/.exec(v);
    if (m) {
        const day = Number(m[1]);
        return day >= 1 && day <= 31 ? { kind: "monthly", day } : null;
    }
    m = /^every:(\d+)d$/.exec(v);
    if (m) {
        const days = Number(m[1]);
        return days >= 1 && days <= REPEAT_DAYS_MAX ? { kind: "every", days } : null;
    }
    return null;
}

const ISO_TO_BYDAY = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"];
/** 飞书 recurrence（spike 09-14 实锤：纯字符串 RFC5545 无 RRULE: 前缀，数组形态被拒；
 *  PATCH 带新串=整系列换规则、""=清除、create 也接受 ""——remind 载荷恒带该字段） */
export function repeatToRecurrence(rp: RemindRepeat): string {
    switch (rp.kind) {
        case "daily": return "FREQ=DAILY;INTERVAL=1";
        case "weekly": return `FREQ=WEEKLY;BYDAY=${rp.days.map((d) => ISO_TO_BYDAY[d]).join(",")}`;
        case "monthly": return `FREQ=MONTHLY;BYMONTHDAY=${rp.day}`;
        case "every": return rp.days === 1 ? "FREQ=DAILY;INTERVAL=1" : `FREQ=DAILY;INTERVAL=${rp.days}`;
    }
}

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** 今日是否为触发日（O(1)：every 走模运算防大间隔死循环；monthly 短月跳过天然规避；
 *  今日<锚日恒 false=DTSTART 边界与飞书一致） */
export function todayIsOccurrence(remindAt: string, rp: RemindRepeat, today: Date): boolean {
    const at = parseRemindAt(remindAt);
    if (!at) return false;
    const anchor = startOfDay(at), cur = startOfDay(today);
    if (cur < anchor) return false;
    const diffDays = Math.round((cur.getTime() - anchor.getTime()) / DAY_MS);
    switch (rp.kind) {
        case "daily": return true;
        case "weekly": return rp.days.includes(cur.getDay() === 0 ? 7 : cur.getDay());
        case "monthly": return cur.getDate() === rp.day;
        case "every": return diffDays % rp.days === 0;
    }
}

/** 循环短文字部件（频次词属语言层——core 零 i18n，前端 render/panel 拼装） */
export interface RepeatParts {
    kind: "daily" | "weekly" | "monthly" | "every";
    time: string;
    weekdays?: number[];
    monthDay?: number;
    interval?: number;
}

export function repeatParts(repeat: string, remindAt: string): RepeatParts | null {
    const rp = parseRemindRepeat(repeat);
    const at = parseRemindAt(remindAt);
    if (!rp || !at) return null;
    const p = (n: number) => String(n).padStart(2, "0");
    const time = `${p(at.getHours())}:${p(at.getMinutes())}`;
    if (rp.kind === "daily") return { kind: "daily", time };
    if (rp.kind === "weekly") return { kind: "weekly", time, weekdays: rp.days };
    if (rp.kind === "monthly") return { kind: "monthly", time, monthDay: rp.day };
    return { kind: "every", time, interval: rp.days };
}

/** upsert 映射键（calendar-upserts.json 命名空间：remind:<blockId>） */
export function remindKey(blockId: string): string {
    return `remind:${blockId}`;
}

/** 剥任务标记前缀（与 feishu.buildEventPayload 同则，内容块做 summary 用） */
export function stripTaskMark(s: string): string {
    return s.replace(/^\s*[-*+]\s*\[[ xX]\]\s*/, "").trim();
}

/** 提醒事件载荷；单次已过期（now>=remindAt）照常建/留事件（calauth □3 bear 拍板「同步过去
 *  完整一点」——过期事件=日历历史，属性在即同步，删属性才是清除语义；红态块属性不动）；
 *  循环永续；脏 repeat→null（调用方记 invalid 行）。
 *  recurrence 恒带：循环=规则串、单次=""（PATCH 自动清旧规则，spike 09-14）。
 *  □16 结束时间：remindEnd 合法（晚于 at）→ end=真实值（跨天允许）；空/非法→默认 30min
 *  （行级校验已挡非法值进链，此处防御=手改属性绕过入口时的兜底不炸镜像） */
export function buildRemindEventPayload(
    input: { blockId: string; content: string; remindAt: string; repeat?: string | null; remindEnd?: string | null },
    opts: { reminderMinutes: number },
): EventPayload | null {
    const at = parseRemindAt(input.remindAt);
    if (!at) return null;
    const rp = input.repeat ? parseRemindRepeat(input.repeat) : null;
    if (input.repeat && !rp) return null;
    // 单次已过期不再返 null（□3）：past 时间戳照建——剪枝复核 alive 同经本函数自动对齐
    const { date, time } = splitRemindAt(input.remindAt);
    const t = dueToTimeRange(date, time, REMIND_EVENT_DURATION_MIN);
    let endTs = t.end;
    if (input.remindEnd && REMIND_AT_RE.test(input.remindEnd)) {
        const d = new Date(input.remindEnd);
        if (!Number.isNaN(d.getTime()) && d.getTime() > at.getTime()) {
            endTs = String(Math.floor(d.getTime() / 1000));
        }
    }
    const bare = stripTaskMark(input.content);
    const summary = bare.length > SUMMARY_MAX ? bare.slice(0, SUMMARY_MAX) + "…" : bare;
    return {
        summary: summary || NO_CONTENT,
        description: `块提醒（sy-workbench-plugin）\n在思源中打开: siyuan://blocks/${input.blockId}`,
        start_time: { timestamp: t.start, timezone: "Asia/Shanghai" },
        end_time: { timestamp: endTs, timezone: "Asia/Shanghai" },
        reminders: dualReminders(opts.reminderMinutes),
        vchat: { vc_type: "no_meeting" },
        attendee_ability: "can_see_others",
        recurrence: rp ? repeatToRecurrence(rp) : "",
    };
}

/** 全库块提醒扫描 SQL（kernel 每日/触发同步用；repeat/end/markdown 供循环、时长与任务完成判定）。
 *  期② 加 sched_origin 旗标列（班表块标记——消费面据此分流：镜像链跳过/显示路去重/notify 真身优先；
 *  无此属性的普通提醒块=NULL 零影响）。 */
export function listRemindBlocksSql(): string {
    return `SELECT a.block_id AS id, a.value AS at, r.value AS repeat, e.value AS end, b.content AS content, b.type AS type, b.markdown AS markdown, so.value AS sched_origin
    FROM attributes a
    LEFT JOIN attributes r ON r.block_id = a.block_id AND r.name='${ATTR_REMIND_REPEAT}'
    LEFT JOIN attributes e ON e.block_id = a.block_id AND e.name='${ATTR_REMIND_END}'
    LEFT JOIN attributes so ON so.block_id = a.block_id AND so.name='custom-sched-origin'
    JOIN blocks b ON b.id = a.block_id
    WHERE a.name='${ATTR_REMIND_AT}'`;
}

/** 限单文档（前端打开文档时初扫） */
export function docRemindSql(rootId: string): string {
    return `${listRemindBlocksSql()} AND b.root_id='${rootId}'`;
}

/** 剪枝决策：remind: 前缀键不在 liveKeys（过期/属性已删）→删事件清映射；非 remind: 键（burden/任务）不动 */
export function pruneRemindEntries(
    entries: Record<string, SyncMapping>,
    liveKeys: Set<string>,
): { next: Record<string, SyncMapping>; dropEvent: string[] } {
    const next: Record<string, SyncMapping> = {};
    const dropEvent: string[] = [];
    for (const key of Object.keys(entries)) {
        if (key.startsWith("remind:")) {
            if (liveKeys.has(key)) next[key] = entries[key];
            else dropEvent.push(key);
        } else {
            next[key] = entries[key];
        }
    }
    return { next, dropEvent };
}

/** 班表块防倒灌闸（timeblock 期 4 班表并入 remind 源）：带 sched_origin 的过去块
 *  （remind-at 所在日 < today）不**新建**飞书事件——对齐原 sched 镜像「过去条目不补建」
 *  语义，防退役切换时历史日记班表块一次性倒灌日历。已有条目（update/unchanged 路径）
 *  不经此闸；liveKeys 照进（防剪枝误删既有事件——过去班表块的事件=日历历史该留）。 */
export function pastBoardSkip(schedOrigin: string | null | undefined, remindAt: string, today: string): boolean {
    if (!schedOrigin) return false;
    return remindAt.slice(0, 10) < today;
}
