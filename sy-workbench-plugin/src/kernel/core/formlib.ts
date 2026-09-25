// 作息训练·期 3（sloop □5）：形态库逻辑层（纯函数，零 siyuan/网络/DOM——channels 纪律）。
// 三件事：① projectDraft 初版粗排（铁律 2：从现实出发投影，11 点起→初版 10:30）
// ② matchArchetypes 最像形态对照（铁律 10 权重表；铁律 11 分数只排序不外显）
// ③ buildBaselineReport 首份照镜子报告（数据梯度三层自动选：文档时间戳>日历>口述）。

import { hmToMin, minToHM, isValidHM } from "./schedule";
import { isHourKey, type DayProfile } from "./behavior";
import { ARCHETYPES } from "./formlib-data";

// ── schema ──

export type Chrono = "morning" | "night" | "flex";

export interface ArchAnchor {
    label: { zh: string; en: string };
    /** HH:mm；anchors[0] 恒=起床锚（数据层约定，单测断言） */
    start: string;
    /** null=时刻锚（起床/熄屏类，无持续段） */
    end: string | null;
    hard: boolean;
}

export interface Archetype {
    id: string;
    name: { zh: string; en: string };
    chrono: Chrono;
    /** 锚点基色 3~5 个（设计档 §3） */
    anchors: ArchAnchor[];
    /** 一条人生阶段注记（构造依据） */
    stageNote: { zh: string; en: string };
    /** 冲突容忍：冲刺期守哪个最小锚 */
    conflictAnchor: { zh: string; en: string };
}

/** 现实约束（onboarding 口述；与观察数据解耦） */
export interface OnboardConstraints {
    /** 口述通常起床 HH:mm（投影基准） */
    wake?: string | null;
    /** 口述通常入睡 HH:mm（进报告/包，不参与平移） */
    sleep?: string | null;
    /** 固定时段/备注自由文本（进包；不解析成条目） */
    notes?: string[];
}

/** 初版粗排条目（冻结前形态；落班表走既有 schedEdit 通道） */
export interface DraftItem {
    summary: string;
    start: string;
    end: string | null;
    hard: boolean;
    /** true=数据稀疏（无口述起床），第一份周报有义务重校 */
    lowConf: boolean;
}

export function getArchetype(id: string): Archetype | null {
    return ARCHETYPES.find((a) => a.id === id) ?? null;
}

function pickText(bi: { zh: string; en: string }, zh: boolean): string {
    return zh ? bi.zh : bi.en;
}

// ── ① 初版粗排（现实约束投影） ──

/** 半步幅度（分钟）：初版起床=现实起床朝基色方向挪 30 分钟——「从你现在的地方出发」
 *  （铁律 2，设计档 §5 例：11 点起 → 初版 10:30）。锚组整体随起床锚平移保相对结构；
 *  更远的逼近交给逐日交接会棘轮（结构慢变·铁律 6）。 */
export const DRAFT_SHIFT_CAP_MIN = 30;
/** 锚组总平移封顶（分钟）：现实离基色极远时整组平移会产出跨午夜钳位/乱序粗排
 *  （review P2-1）——超过 6 小时的部分交给逐日棘轮，不在初版一次挪完 */
export const DRAFT_SHIFT_MAX_MIN = 360;

export function projectDraft(
    a: Archetype,
    zh: boolean,
    c: OnboardConstraints,
): { items: DraftItem[]; shiftMin: number; wakeBase: string; wakeReal: string | null } {
    const wakeBase = a.anchors[0];
    const wakeReal = isValidHM(c.wake) ? (c.wake as string) : null;
    // 锚组相对基色的平移量：现实离基色 ≤30 分钟=不动；否则=现实半步后的位置（保相对结构，±6h 封顶）
    let shift = 0;
    if (wakeReal) {
        const ideal = hmToMin(wakeReal) - hmToMin(wakeBase.start);
        if (ideal > DRAFT_SHIFT_CAP_MIN) shift = Math.min(DRAFT_SHIFT_MAX_MIN, ideal - DRAFT_SHIFT_CAP_MIN);
        else if (ideal < -DRAFT_SHIFT_CAP_MIN) shift = Math.max(-DRAFT_SHIFT_MAX_MIN, ideal + DRAFT_SHIFT_CAP_MIN);
    }
    const items: DraftItem[] = a.anchors.map((an) => {
        const rawStart = hmToMin(an.start) + shift;
        const clampedS = Math.max(0, Math.min(24 * 60 - 1, Math.round(rawStart)));
        let end: string | null = null;
        let clampedE = false;
        if (an.end) {
            const rawEnd = hmToMin(an.end) + shift;
            const e = Math.max(0, Math.min(24 * 60 - 1, Math.round(rawEnd)));
            clampedE = e !== rawEnd;
            end = e > clampedS ? minToHM(e) : null;
        }
        const clamped = clampedS !== rawStart || clampedE; // 被午夜钳位=结构已变形，标低置信待周报重校
        return { summary: pickText(an.label, zh), start: minToHM(clampedS), end, hard: an.hard, lowConf: !wakeReal || clamped };
    });
    return { items, shiftMin: shift, wakeBase: wakeBase.start, wakeReal };
}

// ── ② 最像形态对照（权重表打分；分数只用于排序，报告不外显数字——收据不是考卷） ──

export interface ArchMatch {
    id: string;
    score: number;
    /** 一句人话理由（报告呈现） */
    reason: { zh: string; en: string };
}

/** 观察期画像聚合：小时活跃向量（跨日求和）+ 日均概览 */
export interface ObserveDigest {
    days: number;
    /** "08"→块数（合并） */
    hours: Record<string, number>;
    totalEdits: number;
    docsTouched: number;
    tasksDone: number;
    tasksTotal: number;
    calendarEvents: number;
}

export function digestProfiles(profiles: DayProfile[]): ObserveDigest {
    const hours: Record<string, number> = {};
    let totalEdits = 0;
    const docSet = new Set<string>();
    let tasksDone = 0;
    let tasksTotal = 0;
    let calendarEvents = 0;
    for (const p of profiles) {
        for (const [h, n] of Object.entries(p.activeHours ?? {})) {
            // O2① 读面兜底：脏小时键（15 位 updated 残值产物）不计——否则进 hourShare 分母
            // 把晨/夜型占比全压低，形态对照（matchArchetypes）失真
            if (!isHourKey(h)) continue;
            hours[h] = (hours[h] ?? 0) + n;
            totalEdits += n;
        }
        for (const d of p.docs ?? []) docSet.add(d.title);
        for (const t of p.tasks ?? []) {
            tasksTotal += 1;
            if (t.done) tasksDone += 1;
        }
        calendarEvents += (p.calendar ?? []).length;
    }
    return { days: profiles.length, hours, totalEdits, docsTouched: docSet.size, tasksDone, tasksTotal, calendarEvents };
}

function hourShare(hours: Record<string, number>, from: number, to: number): number {
    let sum = 0;
    let total = 0;
    for (const [h, n] of Object.entries(hours)) {
        const hi = Number(h);
        total += n;
        // 跨午夜段（22→2）按 22,23,00,01 计
        if (from <= to ? hi >= from && hi < to : hi >= from || hi < to) sum += n;
    }
    return total > 0 ? sum / total : 0;
}

/** 权重表（铁律 10）：chrono 吻合 40 + 锚点时段活跃重合 40 + 外部约束信号 20 */
export function matchArchetypes(digest: ObserveDigest): ArchMatch[] {
    const morning = hourShare(digest.hours, 6, 11);
    const night = hourShare(digest.hours, 22, 3);
    const noonish = hourShare(digest.hours, 11, 18);
    const sparse = digest.days === 0 || Object.keys(digest.hours).length === 0;
    const extEvents = digest.calendarEvents / Math.max(1, digest.days);

    const scored = ARCHETYPES.map((a) => {
        let score = 0;
        // ① chrono 吻合（40）
        if (a.chrono === "morning") score += 40 * morning;
        else if (a.chrono === "night") score += 40 * night;
        else score += 40 * Math.min(1, noonish + 0.5 * (morning + night));
        // ② 锚点时段活跃重合（40）：身份锚覆盖的小时段里活跃占比（跨日间锚不算）
        const span = new Set<number>();
        for (const an of a.anchors) {
            const s = Number(an.start.slice(0, 2));
            const e = an.end ? Number(an.end.slice(0, 2)) : s + 1;
            for (let h = s; h < e && h < 24; h++) span.add(h);
        }
        let anchorHits = 0;
        let hourTotal = 0;
        for (const [h, n] of Object.entries(digest.hours)) {
            hourTotal += n;
            if (span.has(Number(h))) anchorHits += n;
        }
        score += hourTotal > 0 ? 40 * (anchorHits / hourTotal) : 0;
        // ③ 外部约束信号（20）：日历事件密→班表约束型身份加分；稀+夜活跃→自由型加分
        if (["dev-commute", "academic", "shiftwork", "student"].includes(a.id)) {
            score += 20 * Math.min(1, extEvents / 2);
        } else {
            score += 20 * Math.max(0, 1 - Math.min(1, extEvents / 2)) * (a.chrono === "night" ? Math.max(0.4, night) : 1);
        }
        if (sparse) score = 20; // 数据全稀：全员低分并列，报告走「数据不足」分支
        return { id: a.id, score, morning, night };
    });

    const zhReason = (id: string): string => {
        const a = getArchetype(id)!;
        if (sparse) return "观察期数据不足，仅供参考";
        const bits: string[] = [];
        const m = scored.find((x) => x.id === id)!;
        if (a.chrono === "morning" && m.morning >= 0.3) bits.push("上午活跃占比高");
        if (a.chrono === "night" && m.night >= 0.3) bits.push("深夜活跃占比高");
        if (extEvents >= 2) bits.push("日历上有稳定外部日程");
        else if (a.chrono === "night") bits.push("没有外部日程约束");
        if (!bits.length) bits.push("活跃分布与之相近");
        return bits.join("、");
    };
    const enReason = (id: string): string => {
        const a = getArchetype(id)!;
        if (sparse) return "not enough observation data — directional only";
        const bits: string[] = [];
        const m = scored.find((x) => x.id === id)!;
        if (a.chrono === "morning" && m.morning >= 0.3) bits.push("mornings are active");
        if (a.chrono === "night" && m.night >= 0.3) bits.push("late nights are active");
        if (extEvents >= 2) bits.push("steady external events on the calendar");
        else if (a.chrono === "night") bits.push("no external schedule constraints");
        if (!bits.length) bits.push("activity pattern is similar");
        return bits.join(", ");
    };

    return scored
        .map((s) => ({ id: s.id, score: Math.round(s.score), reason: { zh: zhReason(s.id), en: enReason(s.id) } }))
        .sort((x, y) => y.score - x.score);
}

// ── ③ 首份照镜子报告（「你现在是谁」数据侧+最像形态；冻结基线正文） ──

export interface BaselineReportInput {
    /** 观察期各日画像（缺日容忍——报告注明） */
    profiles: DayProfile[];
    /** 观察期起止日（含） */
    from: string;
    to: string;
    archetypeId: string;
    constraints: OnboardConstraints;
}

function fmtHM(hm: string | null | undefined): string {
    return isValidHM(hm) ? (hm as string) : "";
}

export function buildBaselineReport(lang: string, d: BaselineReportInput): { report: string; match: ArchMatch[]; digest: ObserveDigest } {
    const zh = !lang || lang.toLowerCase().startsWith("zh");
    const a = getArchetype(d.archetypeId);
    const digest = digestProfiles(d.profiles);
    const match = matchArchetypes(digest);
    const top = match[0];
    const topName = top ? getArchetype(top.id) : null;
    const hours = Object.keys(digest.hours).sort();
    const peak = hours.length ? hours.reduce((x, y) => (digest.hours[x] >= digest.hours[y] ? x : y)) : null;
    const sparse = !digest.days || !hours.length;
    const expected = Math.max(1, Math.round((new Date(d.to + "T00:00:00").getTime() - new Date(d.from + "T00:00:00").getTime()) / 86400000) + 1);

    const S: string[] = [];
    S.push(zh ? `# 首份照镜子报告（冻结基线）· 观察期 ${d.from} ~ ${d.to}` : `# First Mirror Report (frozen baseline) · ${d.from} ~ ${d.to}`);

    // 你现在是谁（数据侧；数据梯度三层自动选：文档时间戳>日历>口述）
    S.push(zh ? "## 你现在是谁（数据侧）" : "## Who you are now (data side)");
    if (sparse) {
        S.push(
            zh
                ? "观察期数据稀疏（思源里几乎没有编辑/日历/任务记录）。初版粗排主要依据你挑选的身份基色+口述约束，置信度低——第一份周报有义务重校。"
                : "Sparse observation data (few edits/events/tasks in SiYuan). The first draft leans on your picked archetype plus what you told us — low confidence; the first weekly report must re-check it.",
        );
    } else {
        const lines: string[] = [];
        if (digest.days < expected) {
            lines.push(zh ? `- 观察期 ${expected} 天中 ${digest.days} 天有画像（缺日按无数据处理）` : `- Profiles cover ${digest.days} of ${expected} observation days`);
        }
        if (hours.length) {
            lines.push(zh ? `- 活跃时段 ${hours[0]}:00–${hours[hours.length - 1]}:00，峰值 ${peak}:00（数据源：文档时间戳）` : `- Active ${hours[0]}:00–${hours[hours.length - 1]}:00, peak ${peak}:00 (source: doc timestamps)`);
        }
        if (digest.docsTouched) lines.push(zh ? `- 动过 ${digest.docsTouched} 篇文档、约 ${digest.totalEdits} 次改动` : `- ${digest.docsTouched} docs touched, ~${digest.totalEdits} edits`);
        if (digest.tasksTotal) lines.push(zh ? `- 任务勾选 ${digest.tasksDone}/${digest.tasksTotal}` : `- Tasks checked ${digest.tasksDone}/${digest.tasksTotal}`);
        if (digest.calendarEvents) lines.push(zh ? `- 日历事件 ${digest.calendarEvents} 条（数据源：日历）` : `- ${digest.calendarEvents} calendar events (source: calendar)`);
        S.push(...lines);
    }
    if (fmtHM(d.constraints.wake)) {
        S.push(zh ? `- 口述：通常 ${fmtHM(d.constraints.wake)} 起床${fmtHM(d.constraints.sleep) ? `、${fmtHM(d.constraints.sleep)} 入睡` : ""}（数据源：口述）` : `- Stated: usually up at ${fmtHM(d.constraints.wake)}${fmtHM(d.constraints.sleep) ? `, asleep by ${fmtHM(d.constraints.sleep)}` : ""} (source: self-report)`);
    }

    // 最像的形态（对照非考卷：只呈现前三+一句理由，不外显分数）
    S.push(zh ? "## 最像的形态（观察对照）" : "## Closest shapes (observation)");
    if (sparse) {
        S.push(zh ? "数据不足，暂不对比——第一份周报再谈（参照是配料不是考卷）。" : "Not enough data to compare — revisit in the first weekly report.");
    } else {
        for (const m of match.slice(0, 3)) {
            const ma = getArchetype(m.id)!;
            S.push(zh ? `- ${ma.name.zh}——${m.reason.zh}` : `- ${ma.name.en} — ${m.reason.en}`);
        }
    }

    // 与你挑选的身份（sparse=不做方向性结论，铁律 11 不装懂）
    S.push(zh ? "## 与你挑选的身份" : "## vs your pick");
    if (!a) {
        S.push(zh ? "（身份档缺失）" : "(archetype missing)");
    } else if (sparse) {
        S.push(zh ? `你挑的是「${a.name.zh}」。观察数据不足，先把它的基色当参照起点，之后交接会里慢慢校。` : `You picked "${a.name.en}". Not enough data to compare — treat its anchors as the starting reference and calibrate in later handoff meetings.`);
    } else if (top && top.id === a.id) {
        S.push(zh ? `你挑的「${a.name.zh}」与观察数据最吻合——基色可以直接当粗排参照。` : `Your pick "${a.name.en}" matches the data best — the base anchors can serve as the draft directly.`);
    } else if (top && topName) {
        S.push(
            zh
                ? `你挑的是「${a.name.zh}」（${chronoLabel(a.chrono, true)}）。观察数据更接近「${topName.name.zh}」——初版粗排按你挑的身份投影（从现实出发），不硬切；后续交接会里慢慢谈。`
                : `You picked "${a.name.en}" (${chronoLabel(a.chrono, false)}). The data looks closer to "${topName.name.en}" — the draft still projects from your pick and reality; talk it over in later handoff meetings.`,
        );
    }
    return { report: S.join("\n\n"), match, digest };
}

export function chronoLabel(c: Chrono, zh: boolean): string {
    return zh ? (c === "morning" ? "晨型" : c === "night" ? "夜型" : "弹性") : c === "morning" ? "morning type" : c === "night" ? "night type" : "flexible";
}

/** 照镜子 AI 对话种子包（可选增强：用户想跟 AI 聊透「你现在是谁」时复制） */
export function buildMirrorPacket(lang: string, report: string, d: BaselineReportInput): string {
    const zh = !lang || lang.toLowerCase().startsWith("zh");
    const a = getArchetype(d.archetypeId);
    const head = zh
        ? `# 照镜子对话（作息训练·首份报告）\n\n你是我的作息搭档，口吻=同事：短句、不评价人、指出结构变化。下面是我的首份照镜子报告（数据侧）。请帮我：\n1. 用两三句人话讲讲「我现在是谁」（只描述结构，不打分不说自律）\n2. 对比我最像的形态和我挑的身份，给我一句判断（冲突就说冲突，都行就说都行）\n3. 问我最多两个问题补齐盲区（低信息量回答没关系）\n红线：不评价人、不情绪施压、禁作文式追问。`
        : `# Mirror Chat (Routine Training · first report)\n\nYou are my routine partner, tone = coworker: short sentences, no judging, point out structure. Below is my first mirror report (data side). Please:\n1. Describe "who I am right now" in 2–3 plain sentences (structure only, no scoring)\n2. Compare my closest shapes with my picked archetype — one honest verdict\n3. Ask me at most two questions to fill blind spots (low-info answers fine)\nHard lines: no judging, no motivational pressure, no essay-style probing.`;
    const pick = a ? (zh ? `\n\n我挑的身份：${a.name.zh}（${chronoLabel(a.chrono, true)}）；锚点基色：${a.anchors.map((an) => `${an.label.zh} ${an.start}${an.end ? "–" + an.end : ""}`).join(" / ")}` : `\n\nMy pick: ${a.name.en} (${chronoLabel(a.chrono, false)}); base anchors: ${a.anchors.map((an) => `${an.label.en} ${an.start}${an.end ? "–" + an.end : ""}`).join(" / ")}`) : "";
    return `${head}${pick}\n\n---\n\n${report}`;
}
