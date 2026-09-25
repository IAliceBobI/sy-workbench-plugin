// 作息训练·期 4（sloop □6）：照镜子周报·纯逻辑层。
// 四段内容（设计档 §4）：①规律度（五锚点保持率：起床/睡/锻炼/晒太阳/深度块——行为类锚
// 走画像首末活跃对照口述目标，班表类锚走对账三态；无数据如实标，收据不是考卷）
// ②结构迁移（vs 冻结基线，只记变化不评分）③异常周判定（口述标记扫描+缺数据信号，
// 剔除不进学习——判定存档供期 6 消费）④下周建议（最多动一两个锚点，结构慢变铁律）。
// 首份周报有义务重校初版（§5 onboarding 闭环句）：baseline.draft 低置信条目逐条
// 「保持/微调/放弃」。零 siyuan/网络/DOM 依赖（channels 纪律）；语言双轨 zh/en
// （TS 单一制不进 i18n json，i18n 双轨惯例——handoffSeed/formlib 同款）。

import { circDeltaMin, hmToMin, type SchedItem, type SchedView } from "./schedule";
import { isHourKey, shiftDay, type DayProfile } from "./behavior";
import type { OnboardStore } from "./onboard";

// ── 周窗与生成窗裁决 ──

/** 生成窗起点时刻：周日 20:00 起目标周=本周；此前=上周（补窗：周日晚上思源没开，
 *  周内任何首跑补上——抗断签自愈，与晨间滚动同哲学） */
export const REPORT_HOUR = 20;
/** 周报表保留窗（周）：firstWeek 锚+滚动历史；再旧的记录剪掉（班表条目另走 60 天窗） */
export const WEEKLY_KEEP = 8;

export interface ReportTarget {
    /** 周一 YYYY-MM-DD */
    weekStart: string;
    /** 周日 YYYY-MM-DD */
    weekEnd: string;
}

/** 目标周裁决（幂等键=weekStart）：任何时刻都返回「最近一个周日 20:00 已过的完整周」 */
export function reportDue(now: Date): ReportTarget {
    const p = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const monday = shiftDay(today, -((now.getDay() + 6) % 7));
    const sunday = shiftDay(monday, 6);
    if (today === sunday && now.getHours() >= REPORT_HOUR) return { weekStart: monday, weekEnd: sunday };
    return { weekStart: shiftDay(monday, -7), weekEnd: shiftDay(sunday, -7) };
}

/** 周编号（「照镜子·第 N 周」）：从第一份周报的 weekStart 起数；差值按 7 天整除取整
 *  （DST 日的 1h 误差被 round 吸收——onboard.ts observeDayNum 同款防错号哲学）；
 *  clamp≥1（时钟回拨/乱钟首生成时不产「第 0 周」——review P2-3） */
export function weekNumOf(firstWeek: string | null, weekStart: string): number {
    if (!firstWeek) return 1;
    const diff = new Date(weekStart + "T00:00:00").getTime() - new Date(firstWeek + "T00:00:00").getTime();
    return Math.max(1, Math.round(diff / 604800000) + 1);
}

/** 周窗逐日（周一~周日，恒 7 天） */
export function weekDays(t: ReportTarget): string[] {
    const days: string[] = [];
    for (let i = 0; i < 7; i++) days.push(shiftDay(t.weekStart, i));
    return days;
}

/** 目标周有一丝可写证据才生成（空周不产空报也不记档——下轮重查，有数据自然补） */
export function weekHasEvidence(profiles: DayProfile[], sched: SchedView, t: ReportTarget): boolean {
    // O2① 读面兜底：activeHours 判在场用 isHourKey 键域（脏键-only 日不算活动证据）
    const hasProfile = profiles.some(
        (p) => (p.docs?.length ?? 0) > 0 || Object.keys(p.activeHours ?? {}).some(isHourKey) || (p.stays?.length ?? 0) > 0,
    );
    const hasSched = Object.values(sched.items).some((i) => i.date >= t.weekStart && i.date <= t.weekEnd);
    const hasRecon = Object.keys(sched.recon).some((d) => d >= t.weekStart && d <= t.weekEnd);
    return hasProfile || hasSched || hasRecon;
}

// ── 五锚点桶（规律度段；启发式关键词——匹配≠定论，报告句都带证据口径） ──

export type AnchorKind = "wake" | "sleep" | "exercise" | "sun" | "deep";

const ANCHOR_KEYWORDS: Record<AnchorKind, string[]> = {
    wake: ["起床", "醒来", "晨间", "早起", "wake", "getup", "morning"],
    sleep: ["睡", "熄灯", "熄屏", "就寝", "sleep", "bedtime", "bed"],
    exercise: ["锻炼", "运动", "健身", "跑步", "快走", "骑行", "gym", "run", "exercise", "workout", "sport"],
    sun: ["晒太阳", "晒背", "日光", "散步", "遛", "出门", "sun", "sunlight", "outside", "stroll"],
    deep: ["深度", "专注", "写作", "编程", "代码", "学习", "读书", "阅读", "deep", "focus", "writing", "code", "coding", "study", "reading"],
};

function normKey(s: string): string {
    return (s ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** summary→锚点族分类（□8 起 training.ts 结构守卫同用——单一分类器，勿建第二套） */
export function anchorOf(summary: string): AnchorKind | null {
    const s = normKey(summary);
    if (!s) return null;
    for (const kind of ["sun", "wake", "sleep", "exercise", "deep"] as AnchorKind[]) {
        // sun 先于 exercise 判（「散步」归晒太阳桶而非锻炼——户外语义优先）
        for (const kw of ANCHOR_KEYWORDS[kind]) {
            if (s.includes(normKey(kw))) return kind;
        }
    }
    return null;
}

// ── 睡眠锚点第二级回退（□26 plan_context：onboard 口述缺失时，从最近班表锚条目取习惯位） ──
// 注意与规律度段的分野：周报侧 wake/sleep 走画像首末活跃（设计分野），此处是排期侧的
// 「最近把睡觉/起床排在几点」——供 AI 排明日方案时参照，非行为证据。

export interface RecentAnchorHit {
    /** 命中条目的日期 YYYY-MM-DD（新鲜度证据） */
    date: string;
    start: string;
}

/** 锚候选时刻软过滤（review P1-2）：睡=晚间 20:00 后或凌晨 6 点前；起床=4~12 点——
 *  「午睡 13:00」/「bedroom 打扫 15:00」这类关键词劫持被时间窗拦下，窗口外直接不算命中。 */
const ANCHOR_WINDOW: Record<"wake" | "sleep", (min: number) => boolean> = {
    sleep: (m) => m >= 20 * 60 || m < 6 * 60,
    wake: (m) => m >= 4 * 60 && m < 12 * 60,
};

/** 锚负面词（同上 P1-2）：「午睡/回笼/小睡/nap」永不当睡锚——窗内也不算（凌晨补觉回笼 ≠ 就寝习惯位） */
const ANCHOR_NEGATIVE: Record<"wake" | "sleep", string[]> = {
    sleep: ["午睡", "小睡", "回笼", "nap", "siesta"],
    wake: [],
};

/** 近 lookback 天（含 today）班表里最近一条睡/起床锚条目的 start；无命中=null */
export function recentAnchorOfKind(
    items: SchedItem[],
    kind: "wake" | "sleep",
    today: string,
    lookback = 7,
): RecentAnchorHit | null {
    const cut = shiftDay(today, -(lookback - 1));
    let best: { hit: RecentAnchorHit; sortKey: string } | null = null;
    for (const it of items) {
        if (it.date < cut || it.date > today) continue;
        if (anchorOf(it.summary) !== kind || !it.start) continue;
        const s = normKey(it.summary);
        if (ANCHOR_NEGATIVE[kind].some((w) => s.includes(normKey(w)))) continue;
        if (!ANCHOR_WINDOW[kind](hmToMin(it.start))) continue;
        const sortKey = `${it.date}#${it.start}`;
        if (!best || sortKey > best.sortKey) best = { hit: { date: it.date, start: it.start }, sortKey };
    }
    return best ? best.hit : null;
}

// ── 班表类锚保持率（对账三态：done 计保持、missed 计未保持、unknown/无对账不计——别编） ──

export interface SchedAnchorStat {
    kind: AnchorKind;
    done: number;
    missed: number;
    /** 匹配条目（微调建议用：取 start 中位=本周实际习惯位） */
    items: SchedItem[];
}

function verdictOf(sched: SchedView, it: SchedItem): "done" | "missed" | null {
    const v = sched.recon[it.date]?.results.find((r) => r.key === it.key)?.verdict;
    return v === "done" || v === "missed" ? v : null;
}

function schedAnchorStats(sched: SchedView, t: ReportTarget): SchedAnchorStat[] {
    const byKind = new Map<AnchorKind, SchedAnchorStat>();
    for (const it of Object.values(sched.items)) {
        if (it.date < t.weekStart || it.date > t.weekEnd) continue;
        const kind = anchorOf(it.summary);
        // 起床/睡=行为类锚走画像首末活跃（设计分野），班表条目里的「熄灯/晨间」不进班表锚段
        // ——否则规律度段双「睡：」行+跨引擎定序被 Map 插入序破坏（review P1-4）
        if (kind !== "exercise" && kind !== "sun" && kind !== "deep") continue;
        let st = byKind.get(kind);
        if (!st) {
            st = { kind, done: 0, missed: 0, items: [] };
            byKind.set(kind, st);
        }
        st.items.push(it);
        const v = verdictOf(sched, it);
        if (v === "done") st.done += 1;
        else if (v === "missed") st.missed += 1;
    }
    // 固定呈现序（勿依赖 Map 插入序：goja 对象键枚举=字典序≠V8 插入序——e1..w3 遍历
    // 序在 kernel 侧漂移，规律度行序/摘要取位必须跨引擎一致）
    const ORDER: AnchorKind[] = ["exercise", "sun", "deep"];
    return [...byKind.values()].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

// ── 行为类锚（起床/睡）：画像首末活跃对照口述/基线目标 ──

export interface BehaviorAnchorStat {
    kind: "wake" | "sleep";
    /** 有证据天数（画像 activeHours 非空且可判） */
    judged: number;
    /** 窗内保持天数 */
    kept: number;
    /** 目标 HH:mm（口述优先，fallback 基线起床锚；null=无目标只报分布） */
    target: string | null;
}

/** 日画像首活跃（≥5 点才算起床——凌晨活跃归前一日的晚睡证据） */
function firstWakeHour(hours: Record<string, number>): string | null {
    // O2① 读面兜底：脏小时键（15 位 updated 残值产物 92/60 等）isHourKey 滤除——
    // 「92 点起床」式假判（kept 恒假）不进周报规律度段
    const hs = Object.keys(hours).filter(isHourKey).map(Number).filter((h) => h >= 5).sort((a, b) => a - b);
    return hs.length ? String(hs[0]).padStart(2, "0") : null;
}

/** 日画像末活跃折算分钟（凌晨 <5 点=+24h 归前一日晚睡；纯凌晨活跃日也 +24h） */
function lastActiveMin(hours: Record<string, number>): number | null {
    // O2① 读面兜底：同 firstWakeHour——脏键 92 折 5559 分会把晚睡判恒假
    const hs = Object.keys(hours).filter(isHourKey).map(Number).sort((a, b) => a - b);
    if (!hs.length) return null;
    const maxH = hs[hs.length - 1];
    const hasLateNight = hs[0] < 5;
    if (maxH < 5) return (maxH + 24) * 60; // 全天只在凌晨活跃
    if (hasLateNight) return (Math.max(...hs.filter((h) => h < 5)) + 24) * 60;
    return maxH * 60 + 59; // 小时粒度：该小时内有过活跃，按该小时尾计
}

/** 目标折算（睡目标 00:00~04:59 段=次日，+24h 对照晚睡侧） */
function sleepTargetMin(target: string): number {
    const m = hmToMin(target);
    return m < 5 * 60 ? m + 24 * 60 : m;
}

const WAKE_TOLERANCE_MIN = 90;
const SLEEP_TOLERANCE_MIN = 60;

function behaviorAnchorStats(profiles: DayProfile[], onboard: OnboardStore | null): BehaviorAnchorStat[] {
    const wakeTarget = onboard?.constraints?.wake ?? null;
    const sleepTarget = onboard?.constraints?.sleep ?? null;
    const wake: BehaviorAnchorStat = { kind: "wake", judged: 0, kept: 0, target: wakeTarget };
    const sleep: BehaviorAnchorStat = { kind: "sleep", judged: 0, kept: 0, target: sleepTarget };
    for (const p of profiles) {
        const hours = p?.activeHours ?? {};
        if (!Object.keys(hours).length) continue;
        if (wakeTarget) {
            const fh = firstWakeHour(hours);
            if (fh !== null) {
                wake.judged += 1;
                if (Number(fh) * 60 <= hmToMin(wakeTarget) + WAKE_TOLERANCE_MIN) wake.kept += 1;
            }
        }
        if (sleepTarget) {
            const last = lastActiveMin(hours);
            if (last !== null) {
                sleep.judged += 1;
                if (last <= sleepTargetMin(sleepTarget) + SLEEP_TOLERANCE_MIN) sleep.kept += 1;
            }
        }
    }
    return [wake, sleep];
}

// ── 周报表（petal routine-weekly.json 形态） ──

export interface WeeklyWeekRec {
    num: number;
    /** 生成时点 ISO */
    at: string;
    /** 周报文档 id（chip 点击打开） */
    docId: string;
    /** 文档名（「照镜子·第 N 周（…）」） */
    docName: string;
    /** 班表条目落日（=周报周日） */
    day: string;
    /** 异常周判定存档（期 6 训练循环降学习率消费） */
    anomaly: { flagged: boolean; hits: string[] };
}

export interface WeeklyStore {
    version: 1;
    /** 第一份周报的 weekStart（周编号锚） */
    firstWeek: string | null;
    /** 照镜子文档所在笔记本 id（日记本优先；缺日记本=fallback 首个笔记本，首次定档沿用防目录漂移） */
    mirrorBox?: string | null;
    weeks: Record<string, WeeklyWeekRec>;
}

export function normalizeWeekly(raw: any): WeeklyStore {
    const weeks: Record<string, WeeklyWeekRec> = {};
    if (raw?.weeks && typeof raw.weeks === "object" && !Array.isArray(raw.weeks)) {
        for (const [wk, r] of Object.entries<any>(raw.weeks)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(wk) || !r || typeof r.docId !== "string" || !r.docId) continue;
            weeks[wk] = {
                num: Number.isFinite(Number(r.num)) && Number(r.num) >= 1 ? Math.floor(Number(r.num)) : 1,
                at: typeof r.at === "string" ? r.at : "",
                docId: r.docId,
                docName: typeof r.docName === "string" ? r.docName : "",
                day: typeof r.day === "string" ? r.day : "",
                anomaly: {
                    flagged: r.anomaly?.flagged === true,
                    hits: Array.isArray(r.anomaly?.hits) ? r.anomaly.hits.filter((h: any) => typeof h === "string").slice(0, 10) : [],
                },
            };
        }
    }
    return {
        version: 1,
        firstWeek: typeof raw?.firstWeek === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.firstWeek) ? raw.firstWeek : null,
        ...(typeof raw?.mirrorBox === "string" && raw.mirrorBox ? { mirrorBox: raw.mirrorBox } : {}),
        weeks,
    };
}

/** 滚动剪枝：保留最近 KEEP 周（以 today 所在周为第 0 周倒算）；无变化返原引用 */
export function pruneWeekly(store: WeeklyStore, today: string): WeeklyStore {
    const monday = shiftDay(today, -((new Date(today + "T00:00:00").getDay() + 6) % 7));
    const cut = shiftDay(monday, -7 * (WEEKLY_KEEP - 1));
    const weeks: Record<string, WeeklyWeekRec> = {};
    let changed = false;
    for (const [wk, rec] of Object.entries(store.weeks)) {
        if (wk >= cut) weeks[wk] = rec;
        else changed = true;
    }
    if (!changed) return store;
    return { ...store, weeks };
}

// ── 四段报告生成 ──

export interface WeeklyReportInput {
    lang: string;
    weekStart: string;
    weekEnd: string;
    weekNum: number;
    /** 周窗各日画像（缺日容忍——报告注明覆盖天数） */
    profiles: DayProfile[];
    sched: SchedView;
    onboard: OnboardStore | null;
}

export interface WeeklyReportOut {
    markdown: string;
    /** 班表条目 summary（「照镜子·第 N 周」+核心数字摘要，≤100 字符由班表层钳制） */
    chipSummary: string;
    /** 思源文档名 */
    docName: string;
    /** 异常周判定（存档进周报表，期 6 消费） */
    anomaly: { flagged: boolean; hits: string[] };
}

/** 异常周口述标记扫描（数据源=周窗对账 note/summary——交接会感想里 AI 落的 note） */
const ANOMALY_KEYWORDS = [
    ["生病", "感冒", "发烧", "不舒服", "病了", "住院", "sick", "ill", "fever", "hospital"],
    ["赶稿", "冲刺", "截稿", "deadline", "crunch", "加班", "overtime", "overnight"],
    ["旅游", "旅行", "度假", "出差", "在外", "trip", "travel", "vacation", "away"],
];

/** 异常周扫描（□8 起周学习消费：flagged=该周数据整周剔除不进容量参数） */
export function scanAnomaly(sched: SchedView, t: ReportTarget, zh: boolean): { flagged: boolean; hits: string[] } {
    const hits: string[] = [];
    for (const [day, rec] of Object.entries(sched.recon)) {
        if (day < t.weekStart || day > t.weekEnd) continue;
        for (const r of rec.results) {
            const text = `${r.summary} ${r.note ?? ""}`;
            if (ANOMALY_KEYWORDS.some((group) => group.some((kw) => text.toLowerCase().includes(kw)))) {
                hits.push(zh ? `${day}：${(r.note || r.summary).slice(0, 40)}` : `${day}: ${(r.note || r.summary).slice(0, 40)}`);
            }
        }
    }
    return { flagged: hits.length > 0, hits: hits.slice(0, 5) };
}

/** 中位时刻（HH:mm 列表→min 排序取低中位；空=null） */
function medianHM(starts: string[]): string | null {
    const mins = starts.filter((s) => /^\d{2}:\d{2}$/.test(s)).map(hmToMin).sort((a, b) => a - b);
    if (!mins.length) return null;
    return `${String(Math.floor(mins[Math.floor((mins.length - 1) / 2)] / 60)).padStart(2, "0")}:${String(mins[Math.floor((mins.length - 1) / 2)] % 60).padStart(2, "0")}`;
}

function fmtDelta(min: number, zh: boolean): string {
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    const body = h ? (m ? `${h}h${m}m` : `${h}h`) : `${m}m`;
    return min >= 0 ? (zh ? `推后 ${body}` : `later by ${body}`) : zh ? `提前 ${body}` : `earlier by ${body}`;
}

const ANCHOR_NAME_ZH: Record<AnchorKind, string> = { wake: "起床", sleep: "睡", exercise: "锻炼", sun: "晒太阳", deep: "深度块" };
const ANCHOR_NAME_EN: Record<AnchorKind, string> = { wake: "Wake-up", sleep: "Sleep", exercise: "Exercise", sun: "Sunlight", deep: "Deep work" };

export function buildWeeklyReport(d: WeeklyReportInput): WeeklyReportOut {
    const zh = !d.lang || d.lang.toLowerCase().startsWith("zh");
    const t = { weekStart: d.weekStart, weekEnd: d.weekEnd };
    const covered = d.profiles.length;
    const baseline = d.onboard?.state === "baselined" ? d.onboard.baseline : null;
    const schedStats = schedAnchorStats(d.sched, t);
    const behStats = behaviorAnchorStats(d.profiles, d.onboard);
    const anomaly = scanAnomaly(d.sched, t, zh);

    // ── 段① 规律度 ──
    const rateLines: string[] = [];
    const chipBits: string[] = [];
    for (const b of behStats) {
        const name = zh ? ANCHOR_NAME_ZH[b.kind] : ANCHOR_NAME_EN[b.kind];
        if (!b.target) {
            rateLines.push(zh ? `- ${name}：无目标（没口述${b.kind === "wake" ? "起床" : "入睡"}时刻）——想跟踪的话下次交接会说一声` : `- ${name}: no target (no self-reported time) — mention it in a handoff meeting to track`);
            continue;
        }
        if (!b.judged) {
            rateLines.push(zh ? `- ${name}：无数据（周内画像缺活跃时段记录）` : `- ${name}: no data (no active-hour records this week)`);
            continue;
        }
        rateLines.push(zh ? `- ${name}：${b.kept}/${b.judged} 天保持在 ${b.target} 窗口内（数据源：文档时间戳）` : `- ${name}: ${b.kept}/${b.judged} days within the ${b.target} window (source: doc timestamps)`);
        chipBits.push(`${name} ${b.kept}/${b.judged}`);
    }
    for (const s of schedStats) {
        const name = zh ? ANCHOR_NAME_ZH[s.kind] : ANCHOR_NAME_EN[s.kind];
        if (s.done + s.missed === 0) {
            rateLines.push(zh ? `- ${name}：无对账数据（周内班表${s.items.length ? "排过但没对账" : "没有此类锚"}）` : `- ${name}: no reconciliation data (${s.items.length ? "scheduled but never reconciled" : "not on the schedule this week"})`);
            continue;
        }
        rateLines.push(zh ? `- ${name}：${s.done}/${s.done + s.missed} 天达成（数据源：班表对账）` : `- ${name}: ${s.done}/${s.done + s.missed} days achieved (source: schedule reconciliation)`);
        chipBits.push(`${name} ${s.done}/${s.done + s.missed}`);
    }
    if (!rateLines.length) rateLines.push(zh ? "（本周无锚点数据）" : "(no anchor data this week)");

    // ── 段② 结构迁移（vs 冻结基线，只记变化不评分） ──
    const shiftLines: string[] = [];
    if (!baseline) {
        shiftLines.push(zh ? "尚无冻结基线（还没完成开步）——先挑身份+观察 3 天出首份报告，之后的周报开始对照。" : "No frozen baseline yet (onboarding not finished) — pick an identity and observe 3 days first; future reports will compare against it.");
    } else {
        for (const dr of baseline.draft) {
            const matches = Object.values(d.sched.items).filter(
                (it) => it.date >= t.weekStart && it.date <= t.weekEnd && it.summary === dr.summary && it.start,
            );
            const med = medianHM(matches.map((m) => m.start!));
            if (!med) {
                shiftLines.push(zh ? `- ${dr.summary}（基线 ${dr.start}${dr.end ? `–${dr.end}` : ""}）：本周班表未排${dr.lowConf ? "（初版低置信）" : ""}` : `- ${dr.summary} (baseline ${dr.start}${dr.end ? `–${dr.end}` : ""}): not scheduled this week${dr.lowConf ? " (low confidence)" : ""}`);
                continue;
            }
            // 睡锚横跨午夜：环绕差口径（23:50→00:10=推后 20 分钟而非提前 23h40m——□8 review P1-1 同修）
            const delta = anchorOf(dr.summary) === "sleep" ? circDeltaMin(hmToMin(dr.start), hmToMin(med)) : hmToMin(med) - hmToMin(dr.start);
            if (Math.abs(delta) >= 15) {
                shiftLines.push(zh ? `- ${dr.summary}：基线 ${dr.start} → 本周常见 ${med}（${fmtDelta(delta, true)}）${dr.lowConf ? "（初版低置信——见文末重校）" : ""}` : `- ${dr.summary}: baseline ${dr.start} → this week usually ${med} (${fmtDelta(delta, false)})${dr.lowConf ? " (low confidence — see re-check below)" : ""}`);
            }
        }
        if (!shiftLines.length) shiftLines.push(zh ? "初版锚组本周原样在跑，没有位移。" : "The baseline anchors ran as-is this week — no drift.");
    }

    // ── 段③ 异常周 ──
    const anomalyLines: string[] = [];
    if (anomaly.flagged) {
        anomalyLines.push(zh ? "发现疑似异常标记（来自交接会感想）：" : "Possible anomaly markers (from handoff notes):");
        for (const h of anomaly.hits) anomalyLines.push(`- ${h}`);
        anomalyLines.push(zh ? "异常周不进学习参数（生病/赶稿/旅游照常过日子就好）。" : "Anomaly weeks are excluded from learning parameters — life happens.");
    } else if (covered <= 2) {
        anomalyLines.push(zh ? `本周只有 ${covered} 天画像（思源没怎么开）——如果这是生病/赶稿/旅游周，交接会里说一声即可标记，异常周不进学习。` : `Only ${covered} days of profile data this week — if this was a sick/crunch/travel week, mention it in a handoff meeting; anomaly weeks are excluded from learning.`);
    } else {
        anomalyLines.push(zh ? "未发现异常标记。（若是生病/赶稿/旅游周，交接会里说一声即可标记——异常周不进学习。）" : "No anomaly markers found. (For sick/crunch/travel weeks, mention it in a handoff meeting — those weeks are excluded from learning.)");
    }

    // ── 段④ 下周建议（最多动一两个锚点） ──
    const adviceLines: string[] = [];
    type Cand = { label: string; rate: number; hint: string };
    const cands: Cand[] = [];
    for (const s of schedStats) {
        const total = s.done + s.missed;
        if (!total) continue;
        const rate = s.done / total;
        if (rate >= 0.5) continue;
        const med = medianHM(s.items.filter((i) => i.start).map((i) => i.start!));
        const name = zh ? ANCHOR_NAME_ZH[s.kind] : ANCHOR_NAME_EN[s.kind];
        cands.push({
            label: name,
            rate,
            hint: med
                ? zh ? `${name}这周 ${s.done}/${total}，常见时刻 ${med}——下周固定在 ${med} 试试？不试也行。` : `${name} was ${s.done}/${total} this week, usually at ${med} — try fixing it at ${med} next week? No pressure.`
                : zh ? `${name}这周 ${s.done}/${total}——下周换个时段或减一档试试？不试也行。` : `${name} was ${s.done}/${total} — try a different slot or a lighter version next week? No pressure.`,
        });
    }
    for (const b of behStats) {
        if (!b.target || !b.judged || b.kept / b.judged >= 0.5) continue;
        const name = zh ? ANCHOR_NAME_ZH[b.kind] : ANCHOR_NAME_EN[b.kind];
        cands.push({
            label: name,
            rate: b.kept / b.judged,
            hint: zh ? `${name}目标 ${b.target} 只保持 ${b.kept}/${b.judged} 天——目标要不要朝现实挪半小时？不试也行。` : `${name} target ${b.target} held only ${b.kept}/${b.judged} days — nudge the target 30 min toward reality? No pressure.`,
        });
    }
    cands.sort((a, b) => a.rate - b.rate);
    if (cands.length) {
        for (const c of cands.slice(0, 2)) adviceLines.push(`- ${c.hint}`);
        if (cands.length > 2) adviceLines.push(zh ? "-（本周待调项不止两个——结构慢变，一次最多动一两个，其余下周再说。）" : "- (More than two candidates — structure changes slowly; the rest can wait.)");
    } else {
        adviceLines.push(zh ? "本周各锚都稳（或数据不足）——下周照旧，先把最想稳的一两条排上班表。" : "Anchors held steady (or too little data) — keep it as-is next week; schedule the ones you most want to stabilize.");
    }

    // ── 段⑤ 首份重校（onboarding 闭环句：第一份周报有义务重校初版） ──
    const recheckLines: string[] = [];
    const isFirst = d.weekNum === 1;
    if (isFirst && baseline) {
        for (const dr of baseline.draft) {
            const matches = Object.values(d.sched.items).filter(
                (it) => it.date >= t.weekStart && it.date <= t.weekEnd && it.summary === dr.summary,
            );
            const doneDays = matches.filter((m) => verdictOf(d.sched, m) === "done").length;
            const tag = dr.lowConf ? (zh ? "（初版低置信）" : " (low confidence)") : "";
            const med = medianHM(matches.filter((m) => m.start).map((m) => m.start!));
            const drifted = med ? Math.abs(anchorOf(dr.summary) === "sleep" ? circDeltaMin(hmToMin(dr.start), hmToMin(med)) : hmToMin(med) - hmToMin(dr.start)) >= 30 : false;
            let verdict: string;
            if (!matches.length) {
                verdict = zh ? "一周没排过——现实里要是没有它的位置，交接会里说一声放弃也行" : "never scheduled this week — if reality has no room for it, say so in a handoff meeting and drop it";
            } else if (drifted) {
                // 时刻跟现实走（铁律 2）：不管达成率，实际习惯位离基线 ≥30min 就把锚挪过去
                verdict = zh ? `微调到 ${med}（本周实际习惯位，排 ${matches.length} 天成 ${doneDays}）` : `adjust to ${med} (actual habit spot; scheduled ${matches.length}, done ${doneDays})`;
            } else if (doneDays / matches.length >= 0.5) {
                verdict = zh ? `保持（排 ${matches.length} 天成 ${doneDays}）` : `keep (scheduled ${matches.length}, done ${doneDays})`;
            } else {
                verdict = zh ? `保持观察（排 ${matches.length} 天成 ${doneDays}，下周再看）` : `keep watching (scheduled ${matches.length}, done ${doneDays} — check again next week)`;
            }
            recheckLines.push(`- ${dr.summary} ${dr.start}${dr.end ? `–${dr.end}` : ""}${tag} → ${verdict}`);
        }
        if (!recheckLines.length) recheckLines.push(zh ? "（初版粗排为空）" : "(empty draft)");
    }

    // ── 组装（无首标题：思源文档名即标题，markdown 再放 # 会双标题——vision P1-3） ──
    const S: string[] = [];
    if (covered < 7) S.push(zh ? `> 本周 ${covered}/7 天有画像（思源没开的日子按无数据处理——收据不是考卷）。` : `> ${covered}/7 days of profile data this week (days without SiYuan open count as no data — receipts, not exams).`);
    S.push(zh ? "## 规律度（保持线）" : "## Regularity");
    S.push(...rateLines);
    S.push(zh ? "## 结构迁移（对照冻结基线，只记变化不评分）" : "## Structural drift (vs frozen baseline — changes only, no scoring)");
    S.push(...shiftLines);
    S.push(zh ? "## 异常周" : "## Anomaly");
    S.push(...anomalyLines);
    S.push(zh ? "## 下周建议（最多动一两个锚点）" : "## Next week (at most one or two anchor changes)");
    S.push(...adviceLines);
    if (recheckLines.length) {
        S.push(zh ? "## 首份重校（初版粗排逐条对照现实）" : "## First-report re-check (draft vs reality)");
        S.push(...recheckLines);
    }
    S.push("---");
    S.push(zh ? `下周日照镜子再见。想聊这份数据，把本文档丢给接了思源 MCP 的 AI 就行。` : `See you next Sunday. To talk this report over, hand this doc to any MCP-connected AI.`);

    // 文档名禁 "/"（hpath 层级分隔符）——日期段用 ~ 连接
    const md = `${d.weekStart.slice(5)}~${d.weekEnd.slice(5)}`;
    const docName = zh ? `照镜子·第 ${d.weekNum} 周（${md}）` : `Mirror · Week ${d.weekNum} (${md})`;
    const chipSummary = `${zh ? "照镜子" : "Mirror"}·${zh ? `第 ${d.weekNum} 周` : `W${d.weekNum}`}${chipBits.length ? `（${chipBits.slice(0, 3).join("·")}）` : ""}`;

    return { markdown: S.join("\n\n"), chipSummary, docName, anomaly };
}
