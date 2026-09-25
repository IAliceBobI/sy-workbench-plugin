// □24 段式时间控件纯逻辑：值↔五段转换/段步进（wrap）/段输入 clamp/墙上时间偏移/时长格式化。
// 零 siyuan 依赖（node 单测直跑）；时间语义=本地墙上时间（与 core/remind 同则）。
import { REMIND_AT_RE } from "../kernel/core/remind";

export type SegKey = "y" | "mo" | "d" | "h" | "mi";

export interface SegDef {
    key: SegKey;
    /** 输入位数（年 4 其余 2——满位自动跳段/宽度） */
    len: number;
    min: number;
    /** 静态上限；d 段实际=当月天数（daysInMonth 动态裁决） */
    max: number;
    /** true=越界回绕（月/日/时/分，macOS stepper 语义）；false=clamp（年） */
    wrap: boolean;
}

export const SEG_DEFS: readonly SegDef[] = [
    { key: "y", len: 4, min: 1, max: 9999, wrap: false },
    { key: "mo", len: 2, min: 1, max: 12, wrap: true },
    { key: "d", len: 2, min: 1, max: 31, wrap: true },
    { key: "h", len: 2, min: 0, max: 23, wrap: true },
    { key: "mi", len: 2, min: 0, max: 59, wrap: true },
];

export interface TimeSegs { y: string; mo: string; d: string; h: string; mi: string }

const pad = (n: number, len = 2): string => String(n).padStart(len, "0");

export function daysInMonth(y: number, mo: number): number {
    return new Date(y, mo, 0).getDate(); // Date(y, mo, 0)=当月最后一天（mo 1~12）
}

/** 值→段（非法/空 → null；段值即 pad 后字符串，与展示同构） */
export function valueToSegs(v: string): TimeSegs | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
    if (!m) return null;
    return { y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5] };
}

function segsComplete(s: TimeSegs): boolean {
    return SEG_DEFS.every((d) => s[d.key].length === d.len && /^\d+$/.test(s[d.key]));
}

/** 段→值：段不完整（编辑中间态）→ null；全段数值 clamp 进各自域后组装
 *  （月 13→12、日按当月月末——emit 即规范化，值流恒合法无非法中间值态） */
export function segsToValue(s: TimeSegs): string | null {
    if (!segsComplete(s)) return null;
    return normalizeDate(`${s.y}-${s.mo}-${s.d}T${s.h}:${s.mi}`);
}

/** 日期归一：段全满前提下的数值 clamp+日历复核（月/年变更后日可能越界——10-31 步月+1=11-31 不存在） */
function normalizeDate(joined: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(joined)!;
    const cl = (key: SegKey, n: number): number => {
        const def = SEG_DEFS.find((d) => d.key === key)!;
        let max = def.max;
        if (key === "d") max = daysInMonth(Number(m[1]), Number(m[2]));
        return Math.min(max, Math.max(def.min, n));
    };
    return `${pad(cl("y", Number(m[1])), 4)}-${pad(cl("mo", Number(m[2])))}-${pad(cl("d", Number(m[3])))}T${pad(cl("h", Number(m[4])))}:${pad(cl("mi", Number(m[5])))}`;
}

function joinSegs(s: TimeSegs): string {
    return `${s.y}-${s.mo}-${s.d}T${s.h}:${s.mi}`;
}

/** 段步进（±1）：wrap 段回绕（d 段按年月当月天数）；y 段 clamp；结果过日历复核
 *  （步月/年后日可能越界：10-31 月+1 → 11-30）；值非法 → 原样返回（调用方守卫空态） */
export function stepSeg(v: string, key: SegKey, delta: 1 | -1): string {
    const segs = valueToSegs(v);
    if (!segs) return v;
    const def = SEG_DEFS.find((d) => d.key === key)!;
    let max = def.max;
    if (key === "d") max = daysInMonth(Number(segs.y), Number(segs.mo));
    let n = Number(segs[key]) + delta;
    if (def.wrap) {
        if (n > max) n = def.min;
        else if (n < def.min) n = max;
    } else {
        n = Math.min(def.max, Math.max(def.min, n));
    }
    return normalizeDate(joinSegs({ ...segs, [key]: pad(n, def.len) }));
}

/** 段输入规范化（blur 时）：非数字/空 → 段最小值（y 段空 → fallbackYear）；数值 clamp 进段域
 *  （d 段=当月月末）；改 mo/y 段后过日历复核。v 须已是完整值（中间态调用方跳过） */
export function clampSegInput(v: string, key: SegKey, raw: string, fallbackYear: number): string {
    const segs = valueToSegs(v);
    if (!segs) return v;
    const def = SEG_DEFS.find((d) => d.key === key)!;
    const digits = raw.replace(/\D/g, "");
    let n = digits === "" ? (key === "y" ? fallbackYear : def.min) : Number(digits);
    let max = def.max;
    if (key === "d") max = daysInMonth(Number(segs.y), Number(segs.mo));
    n = Math.min(max, Math.max(def.min, n));
    return normalizeDate(joinSegs({ ...segs, [key]: pad(n, def.len) }));
}

/** 墙上时间偏移（相对通道）：setMinutes 通道跨 DST 保墙上时钟语义；年溢出 1~9999 → null */
export function shiftMinutes(v: string, mins: number): string | null {
    if (!REMIND_AT_RE.test(v)) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    d.setMinutes(d.getMinutes() + mins);
    const y = d.getFullYear();
    if (y < 1 || y > 9999) return null;
    return `${pad(y, 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 分钟差（end>start 才有值；否则 null——摘要行/校验共用判据） */
export function durationMinutes(start: string, end: string): number | null {
    if (!REMIND_AT_RE.test(start) || !REMIND_AT_RE.test(end)) return null;
    const s = new Date(start).getTime(), e = new Date(end).getTime();
    if (Number.isNaN(s) || Number.isNaN(e)) return null;
    const m = Math.round((e - s) / 60000);
    return m > 0 ? m : null;
}

export interface DurWords { min: string; hour: string; day: string; month: string; year: string }

/** 日历月加法（日截断到目标月月末：1-31 +1 月 = 2-28，JS setMonth 溢出进位坑的正规通道） */
function addMonths(d: Date, n: number): Date {
    const target = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes());
    const dim = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(d.getDate(), dim));
    return target;
}

/** 时长格式化（日历换算分档：X 年 Y 个月 → X 个月 Y 天 → X 天 Y 小时 → X 小时 Y 分钟 → X 分钟；
 *  余 0 省尾）。start>=end → null（调用方不显示摘要行） */
export function formatDuration(start: string, end: string, w: DurWords): string | null {
    if (durationMinutes(start, end) === null) return null;
    const sd = new Date(start), ed = new Date(end);
    let months = (ed.getFullYear() - sd.getFullYear()) * 12 + (ed.getMonth() - sd.getMonth());
    let anchor = addMonths(sd, months);
    if (anchor.getTime() > ed.getTime()) {
        months -= 1;
        anchor = addMonths(sd, months);
    }
    const restMin = Math.floor((ed.getTime() - anchor.getTime()) / 60000);
    const years = Math.floor(months / 12);
    const remMonths = months - years * 12;
    const days = Math.floor(restMin / 1440);
    const hours = Math.floor((restMin % 1440) / 60);
    const rmin = restMin % 60;
    if (years >= 1) return remMonths > 0 ? `${years}${w.year} ${remMonths}${w.month}` : `${years}${w.year}`;
    if (months >= 1) return days > 0 ? `${months}${w.month} ${days}${w.day}` : `${months}${w.month}`;
    if (days >= 1) return hours > 0 ? `${days}${w.day} ${hours}${w.hour}` : `${days}${w.day}`;
    if (hours >= 1) return rmin > 0 ? `${hours}${w.hour} ${rmin}${w.min}` : `${hours}${w.hour}`;
    return `${rmin}${w.min}`;
}
