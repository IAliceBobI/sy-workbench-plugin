// dataview □6：速记解析器（契约 §6——速记=输入法不是存储，解析完即弃，落盘永远是文档）。
// 硬编码常用集（非 AI；package.json 无 chrono 类依赖也不新增——手写）：
//   池   ：#前缀任意词位（#金/#gold/#黄金产出——别名见 POOL_ALIASES 常量表）
//   配额 ：30m / 30min / 30分钟 / 30分——**整词才认**（防「3分熟牛排」「番茄30分钟」类误剥）
//   日期 ：词形（今天/明天/后天/周N/本周N）词首剥、可与任务文本粘连；数形（N号/M-D/
//          YYYY-MM-DD）**整词才认**（防「3号电池」「3-5人团建」类误剥）
//   时刻 ：HH:mm（14:30）**整词才认且合法 24h 制**（25:00/14:3 不认——防「14:30开站会」
//          粘连与比分/比值误剥；两位时两位分缺一不认）
//   同类多个以最后一个为准（靠后输入=修正意图）；解析不出的一切当任务名普通文本，永不报错
//   （契约 §2 fail-soft：宁可少认不错认）。
// 「今天」走 getLogicalDay（与全插件同源）；纯函数零 siyuan/DOM 依赖（gui 纯逻辑层惯例）。

import { addDays, getLogicalDay } from "@/kernel/core/dates";
import { stripTaskMark } from "@/kernel/core/remind";
import type { AmmoPoolSlug } from "@/kernel/core/ammoQuadrant";

/** 池简写映射表（dataview □6 常量）：值=该池的全部别名（# 后可写任一形态）。
 *  英文 slug 与中文别名同表——映射表是唯一事实源，看板行内输入（□4）复用同表。 */
export const POOL_ALIASES: Record<AmmoPoolSlug, readonly string[]> = {
    gold: ["黄金产出", "黄金", "金", "gold"],
    deadline: ["当日死线", "死线", "deadline"],
    hearth: ["维持炉火", "炉火", "炉", "hearth"],
    crumbs: ["碎片杂项", "碎片", "屑", "crumbs"],
};

/** 别名→池（平坦查找表；POOL_ALIASES 的倒排——构建一次） */
const ALIAS_TO_POOL: ReadonlyMap<string, AmmoPoolSlug> = (() => {
    const m = new Map<string, AmmoPoolSlug>();
    for (const slug of Object.keys(POOL_ALIASES) as AmmoPoolSlug[]) {
        for (const alias of POOL_ALIASES[slug]) m.set(alias, slug);
    }
    return m;
})();

/** 整词配额：30m / 30min / 30分钟 / 30分（0/坏值不认——数字才是数据） */
const QUOTA_RE = /^(\d+)(?:min|m|分钟|分)$/i;

/** 词形日期（词首剥）：今天/明天/后天/周N/本周N（N=一二三四五六日天或1-7，7=周日；
 *  本周三=「本周」+星期字直接拼接——与「周三」同则，交替分支不吞双周字） */
const WORD_TODAY_RE = /^(今天|明天|后天)/;
const WORD_WEEK_RE = /^(本周|周)([一二三四五六日天1-7])/;
/** 整词数形日期：N号 / M-D / YYYY-MM-DD */
const NUM_DAY_RE = /^(\d{1,2})号$/;
const NUM_MD_RE = /^(\d{1,2})-(\d{1,2})$/;
const NUM_ISO_RE = /^(20\d{2})-(\d{1,2})-(\d{1,2})$/;

/** 整词时刻：HH:mm 严格两位时两位分+值域合法（24:00/14:3/9:30 均不认——HH:mm 字面形态，
 *  宁可少认不错认；值域与 schema TIME_RE/assertTimeValue 同口径） */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 周N 汉字/数字 → 1..6（周一~周六）；日/天/7 → 0（周日） */
const WEEKDAY_CHAR: Record<string, number> = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
    "日": 0, "天": 0, "7": 0,
    "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6,
};

export interface QuickParseResult {
    /** 任务名（认不出参数的剩余文本；全被认走=空串——调用方守卫） */
    name: string;
    /** 池 slug；null=未认出 */
    pool: AmmoPoolSlug | null;
    /** 配额分钟；null=未认出 */
    quota: number | null;
    /** 日期 YYYY-MM-DD；null=未认出 */
    date: string | null;
    /** 截止时刻 HH:mm；null=未认出（合法 24h 制整词才认） */
    dueTime: string | null;
}

// ── 日期解析（全部以 YYYY-MM-DD 字符串算术，正午锚点免疫时区/夏令时——dates.ts 同款） ──

function fmtDay(y: number, m: number, d: number): string {
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 真实历法校验（2-30/13-1/平年2-29 → null；Date 溢出归一化后往返比对抓出） */
function validYmd(y: number, m: number, d: number): string | null {
    const dt = new Date(y, m - 1, d, 12);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return fmtDay(y, m, d);
}

/** 某日所在周的周一（(getDay()+6)%7=周一=0 惯例——report.ts/training.ts 同款） */
function mondayOf(day: string): string {
    const dow = new Date(`${day}T12:00:00`).getDay();
    return addDays(day, -((dow + 6) % 7));
}

/** 词形日期：今天/明天/后天 */
function offsetDay(word: string, today: string): string {
    return addDays(today, word === "今天" ? 0 : word === "明天" ? 1 : 2);
}

/** 词形日期：周N（未来最近——含今天，已过=下周同日）/ 本周N（字面本周，已过也照给） */
function weekdayDay(wd: number, thisWeek: boolean, today: string): string {
    const target = addDays(mondayOf(today), wd === 0 ? 6 : wd - 1);
    if (thisWeek || target >= today) return target;
    return addDays(target, 7);
}

/** 下月 N 号（构造器归一化自然处理 12月→次年1月；月末日溢出如 2-31 往返失败=不认） */
function nextMonthDay(y: number, m0: number, n: number): string | null {
    const dt = new Date(y, m0 + 1, n, 12); // m0=0基；+1=下月（13月自动进次年1月）
    if (dt.getDate() !== n) return null;
    return fmtDay(dt.getFullYear(), dt.getMonth() + 1, n);
}

/** 整词数形：N号 → 未来最近的 N 号（本月未到取本月；已过/本月无此日→下月同号） */
function monthDay(n: number, today: string): string | null {
    const t = new Date(`${today}T12:00:00`);
    const y = t.getFullYear();
    const m0 = t.getMonth();
    const thisM = validYmd(y, m0 + 1, n);
    if (thisM && thisM >= today) return thisM;
    return nextMonthDay(y, m0, n);
}

/** 整词数形：M-D → 未来最近的 M月D日（今年已过取明年） */
function monthDashDay(m: number, d: number, today: string): string | null {
    const y = Number(today.slice(0, 4));
    const first = validYmd(y, m, d);
    if (!first) return null; // 2-30 等——不认
    if (first >= today) return first;
    return validYmd(y + 1, m, d);
}

/** 词首剥一轮：命中返回 {day, rest}；未命中 null（rest 原样留在任务名） */
function wordDateAtStart(token: string, today: string): { day: string; rest: string } | null {
    const td = WORD_TODAY_RE.exec(token);
    if (td) return { day: offsetDay(td[1], today), rest: token.slice(td[1].length) };
    const week = WORD_WEEK_RE.exec(token);
    if (week) {
        const wd = WEEKDAY_CHAR[week[2]];
        if (wd === undefined) return null;
        return { day: weekdayDay(wd, week[1] === "本周", today), rest: token.slice(week[0].length) };
    }
    return null;
}

/** 整词数形日期：N号 / M-D / ISO（须整词—— glued 形态不认） */
function numDateOfToken(token: string, today: string): string | null {
    const day = NUM_DAY_RE.exec(token);
    if (day) return monthDay(Number(day[1]), today);
    const iso = NUM_ISO_RE.exec(token);
    if (iso) return validYmd(Number(iso[1]), Number(iso[2]), Number(iso[3])); // 全日期=字面值不外推
    const md = NUM_MD_RE.exec(token);
    if (md) return monthDashDay(Number(md[1]), Number(md[2]), today);
    return null;
}

/** 剥首尾悬挂分隔符（。，、;：·- 与空白——词形日期剥完常留尾巴） */
function stripDangling(s: string): string {
    return s.replace(/^[\s，。、,;；:：·\-]+/, "").replace(/[\s，。、,;；:：·\-]+$/, "");
}

/** 池别名查找（# 后文本；命中返回池 slug） */
function poolByAlias(s: string): AmmoPoolSlug | null {
    return ALIAS_TO_POOL.get(s) ?? null;
}

/**
 * 速记行解析：一行速记 → {任务名, 池, 配额, 日期, 截止时刻}。永不 throw、永不吞任务文本——
 * 认不出的部分全部留在 name（契约 §6「解析不出的部分当普通文本」）。
 * now 缺省=当前时刻（「今天」走 getLogicalDay 逻辑日）。
 */
export function quickParse(input: string, now: Date = new Date()): QuickParseResult {
    const today = getLogicalDay(now);
    let pool: AmmoPoolSlug | null = null;
    let quota: number | null = null;
    let date: string | null = null;
    let dueTime: string | null = null;
    const nameParts: string[] = [];
    for (const rawTok of stripTaskMark(input ?? "").split(/\s+/)) {
        if (!rawTok) continue;
        // ① #池（# 前缀=唯一池语法；裸词不认池——防「金鱼」「买金条」误剥）
        if (rawTok.startsWith("#")) {
            const p = poolByAlias(stripDangling(rawTok.slice(1)));
            if (p) {
                pool = p;
                continue;
            }
        }
        // ② 整词配额
        const q = QUOTA_RE.exec(rawTok);
        if (q && Number(q[1]) > 0) {
            quota = Number(q[1]);
            continue;
        }
        // ③ 整词时刻（与数形日期词形不交叉：冒号 vs 连字符/号——disjoint 模式）
        if (TIME_RE.test(rawTok)) {
            dueTime = rawTok;
            continue;
        }
        // ④ 整词数形日期
        const nd = numDateOfToken(rawTok, today);
        if (nd) {
            date = nd;
            continue;
        }
        // ⑤ 词形日期词首剥（≤2 轮：「明天周五开会」双剥）+ 余文进名
        let rest = rawTok;
        for (let i = 0; i < 2; i++) {
            const w = wordDateAtStart(rest, today);
            if (!w) break;
            date = w.day;
            rest = w.rest;
        }
        const piece = stripDangling(rest);
        if (piece) nameParts.push(piece);
    }
    return { name: nameParts.join(" "), pool, quota, date, dueTime };
}
