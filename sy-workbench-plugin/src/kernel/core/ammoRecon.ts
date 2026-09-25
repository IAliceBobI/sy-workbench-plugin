// ammo □5：交接会对账纯逻辑层——配额消耗对账（各池配额 vs 实吃，多用照实显示不评判）+
// 两类告警（黄金产出保底被挤 / 维持炉火超上限或「炉子凉了」）+ 不想做镜子数据流。
// 契约=docs/ammo-concept.md A4（池配额性格）/A8（交接会对账面）/B1.4（原话=镜子措辞唯一素材源）：
// - 收据不是考卷铁律的代码化：镜子=清单原话+今日数据→拼接，不做评分；超限/告警措辞只引用
//   用户原话（「你 XX 说过「……」，今天 XX」），AI 从不产生新指责——无原话可引就落裸数据行；
// - 凉了 ≠ 防沉迷（语义相反：一个是没照顾、一个是被吸走太多）——炉凉告警不与 swallow 原话互贴；
// - 黄金保底被挤 × fear 的正面化身恰挂 gold 池 → 引用原话（「怕来不及」的镜子形态）。
// 零 siyuan/网络/DOM 依赖（channels 纪律）；语言双轨 zh/en（report.ts 同款 TS 单一制惯例）。

import { AMMO_POOL_SLUGS, AVERSION_SECTION_TITLES, DEFAULT_HEARTH_FREQ, POOL_LABEL, type AmmoDayConfig, type AmmoPoolSlug, type AversionKind, type LedgerPoolDigest } from "./ammoQuadrant";

// ── 配额消耗对账 + 两类告警 ──

export interface QuotaPoolRow {
    pool: AmmoPoolSlug;
    /** 配额分钟（gold=保底 / hearth=上限 / null=今日未设数字——未承诺不评判） */
    ratio: number | null;
    /** 实吃分钟（日账闭合段聚合） */
    actualMin: number;
}

export type AmmoAlert =
    | { kind: "gold-squeezed"; actualMin: number; floorMin: number; shortMin: number }
    | { kind: "hearth-over"; actualMin: number; capMin: number; overMin: number }
    | { kind: "hearth-cold"; freqDays: number; lastSeen: string | null; gapDays: number };

export interface QuotaRecon {
    /** 呈现序=池白名单序（goja 键序≠V8 插入序——跨引擎一致靠显式序） */
    rows: QuotaPoolRow[];
    alerts: AmmoAlert[];
}

/** 炉凉扫描窗天数（封顶）：recentHearthDays 零记录时 gap 按窗口天数计——freq>窗口不冤判（宁漏勿冤） */
export const HEARTH_SCAN_WINDOW = 15;

/** 日期差（天）：正午解析防 DST（shiftDay 同哲学） */
function diffDays(a: string, b: string): number {
    return Math.round((new Date(b + "T12:00:00").getTime() - new Date(a + "T12:00:00").getTime()) / 86400000);
}

/**
 * 配额消耗对账（纯）：各池 配额 vs 实吃（照实，不评判）+ 两类告警。
 * - gold：ratio=保底分钟，实吃 < 保底 → gold-squeezed（「保底被挤」）；
 * - hearth：ratio=上限分钟，实吃 > 上限 → hearth-over（「多用 X 分钟」照实）；
 *   freq=最小频率天数（缺省 3），今日零吃量且距上次吃量 ≥freq 天 → hearth-cold（「炉子凉了」）；
 * - 今日没配 hearth 池=无最小频率承诺，凉了不判（未承诺不评判）；
 * - recentHearthDays=近窗内有 hearth 吃量的日（含今日若今日实吃>0）；lastSeen 缺席时 gap=窗口天数
 *   （调用方须扫 ≥freq+1 天或封顶窗——窗口不足宁漏勿冤）。
 * 配置缺席（config=null）=没承诺过配额：零告警，实吃照实入行。 */
export function buildQuotaRecon(input: { config: AmmoDayConfig | null; digest: LedgerPoolDigest; today: string; recentHearthDays: string[] }): QuotaRecon {
    const rows: QuotaPoolRow[] = AMMO_POOL_SLUGS.map((pool) => ({
        pool,
        ratio: input.config?.pools.find((p) => p.pool === pool)?.ratio ?? null,
        actualMin: input.digest.pools[pool] ?? 0,
    }));
    const alerts: AmmoAlert[] = [];
    const goldRow = input.config?.pools.find((p) => p.pool === "gold");
    const hearthRow = input.config?.pools.find((p) => p.pool === "hearth");
    const goldActual = input.digest.pools.gold ?? 0;
    const hearthActual = input.digest.pools.hearth ?? 0;
    if (goldRow?.ratio != null && goldActual < goldRow.ratio) {
        alerts.push({ kind: "gold-squeezed", actualMin: goldActual, floorMin: goldRow.ratio, shortMin: goldRow.ratio - goldActual });
    }
    if (hearthRow?.ratio != null && hearthActual > hearthRow.ratio) {
        alerts.push({ kind: "hearth-over", actualMin: hearthActual, capMin: hearthRow.ratio, overMin: hearthActual - hearthRow.ratio });
    }
    if (hearthRow && hearthActual <= 0) {
        const freq = hearthRow.freq ?? DEFAULT_HEARTH_FREQ;
        const seen = input.recentHearthDays.filter((d) => d < input.today).sort();
        const lastSeen = seen.length ? seen[seen.length - 1] : null;
        const gapDays = lastSeen ? diffDays(lastSeen, input.today) : HEARTH_SCAN_WINDOW;
        if (gapDays >= freq) alerts.push({ kind: "hearth-cold", freqDays: freq, lastSeen, gapDays });
    }
    return { rows, alerts };
}

/** 弹药对账单行（多用/差额照实显示不评判；零信号行沉默——deadline 无吃量无数字不出行） */
export function renderQuotaLines(recon: QuotaRecon, zh: boolean): string[] {
    const lines: string[] = [];
    for (const r of recon.rows) {
        const name = POOL_LABEL[r.pool];
        const nameEn: Record<AmmoPoolSlug, string> = { gold: "Gold output", deadline: "Today's deadline", hearth: "Hearth", crumbs: "Crumbs" };
        if (r.ratio == null) {
            if (r.actualMin > 0) lines.push(zh ? `- ${name}：实吃 ${r.actualMin}min（今日未设数字）` : `- ${nameEn[r.pool]}: took ${r.actualMin}min (no number set today)`);
            continue;
        }
        const quotaTag = r.pool === "gold" ? (zh ? `保底 ${r.ratio}min` : `floor ${r.ratio}min`) : zh ? `上限 ${r.ratio}min` : `cap ${r.ratio}min`;
        // 差额括号按池性格（A4/P1-B）：超出=多用照实（任何设数字池）；恰达=刚好；
        // 未满仅 gold 保底=「还差」（hearth 上限/deadline·crumbs 不保底——未满无欠缺语义，无括号评判）
        let delta: string;
        if (r.actualMin > r.ratio) {
            delta = zh ? `多用 ${r.actualMin - r.ratio}min` : `${r.actualMin - r.ratio}min over`;
        } else if (r.actualMin === r.ratio) {
            delta = zh ? "刚好达成" : "exactly met";
        } else if (r.pool === "gold") {
            delta = zh ? `还差 ${r.ratio - r.actualMin}min` : `${r.ratio - r.actualMin}min short`;
        } else {
            delta = "";
        }
        lines.push(zh ? `- ${name} · ${quotaTag}：实吃 ${r.actualMin}min${delta ? `（${delta}）` : ""}` : `- ${nameEn[r.pool]} · ${quotaTag}: took ${r.actualMin}min${delta ? ` (${delta})` : ""}`);
    }
    return lines;
}

// ── 不想做镜子（清单原话+今日数据→拼接，不做评分） ──

/** 镜子素材条目（scanForest 的 AversionItem 同形+可选记录日） */
export interface MirrorAversion {
    id: string;
    /** 用户原话（镜子措辞唯一素材源——原样引用） */
    text: string;
    /** vow|fear|swallow */
    kind: string;
    avatar: string;
    capPool: string;
    /** 记录日 YYYY-MM-DD（引用行的「你 XX 说过」；空=无从考证不带日期） */
    at?: string;
}

export interface MirrorSectionLines {
    /** 戒条一问（原话+固定问句——答了记账不追问） */
    vows: string[];
    /** 怕来不及（原话+化身指针——AI 翻译成正面任务进池的讨论入口） */
    fears: string[];
    /** 防沉迷（原话+物化池——池上限的民意出处） */
    swallows: string[];
    /** 告警引用行：用户原话+今日数据拼接（「你 XX 说过「……」——今天……」） */
    citations: string[];
    /** 无原话可引的告警=裸数据行（照实念，不编引用不评判） */
    bareAlerts: string[];
}

/** 引用行日期段：zh=` 09-18 `（首尾空格）/en=` on 09-18`；缺席=空串（无日期形态不带多余空格） */
function atSeg(at: string | undefined, zh: boolean): string {
    if (!at) return "";
    return zh ? ` ${at.slice(5)} ` : ` on ${at.slice(5)}`;
}

/** 分区显示名（中文行前缀词——文档实际标题优先〔用户改词后镜子跟着叫〕、缺省默认词；
 *  英文行不跟标题：前缀是 kind 的英文语义描述非分区名直译，中文标题塞英文行破坏行文） */
function kindNameZh(sectionTitles: Record<AversionKind, string> | null | undefined, kind: AversionKind): string {
    return sectionTitles?.[kind] || AVERSION_SECTION_TITLES[kind];
}

/**
 * 不想做镜子（纯，双语）：对账段固定过一遍清单（戒条一问/怕来不及/防沉迷）+
 * 告警措辞配对——只引用用户原话：
 * - hearth-over × swallow(capPool=hearth) → 引用（「防沉迷」物化的正是这个上限）；
 * - gold-squeezed × fear（化身任务今日恰挂 gold 配置）→ 引用（「怕来不及」的镜子形态）；
 * - hearth-cold 恒裸行（凉了≠防沉迷——语义相反不互贴原话）；
 * - 配不上对的告警=裸数据行（无原话可引就不引用——从不产生新指责）。
 * sectionTitles=文档三分区实际标题（顺序锚健康时在）：中文行分区前缀跟用户改词走（默认标题下
 * 输出与历史逐字一致——零回归）；缺省=默认词。 */
export function buildMirrorSection(input: { today: string; aversions: MirrorAversion[]; recon: QuotaRecon; config: AmmoDayConfig | null; zh: boolean; sectionTitles?: Record<AversionKind, string> | null }): MirrorSectionLines {
    const vows: string[] = [];
    const fears: string[] = [];
    const swallows: string[] = [];
    for (const a of input.aversions) {
        if (a.kind === "vow") {
            vows.push(input.zh ? `${kindNameZh(input.sectionTitles, "vow")}一问：「${a.text}」——今天这条守住了吗？（答了就记下，不追问）` : `Vow check: "${a.text}" — did this one hold today? (record the answer, no follow-up)`);
        } else if (a.kind === "fear") {
            fears.push(
                input.zh
                    ? `${kindNameZh(input.sectionTitles, "fear")}：「${a.text}」${a.avatar ? `（正面化身→树任务 ${a.avatar.slice(0, 8)}）` : "（还没接正面化身任务——第四幕配弹药时讨论翻译）"}`
                    : `Fear of falling behind: "${a.text}"${a.avatar ? ` (positive avatar → tree task ${a.avatar.slice(0, 8)})` : " (no avatar task yet — discuss the translation when loading ammo)"}`,
            );
        } else if (a.kind === "swallow") {
            const capName = (POOL_LABEL[a.capPool as AmmoPoolSlug] ?? a.capPool) || "?";
            swallows.push(
                input.zh
                    ? `${kindNameZh(input.sectionTitles, "swallow")}：「${a.text}」（物化=${capName}上限）`
                    : `Don't be swallowed: "${a.text}" (materialized as the ${capName} cap)`,
            );
        }
    }
    const citations: string[] = [];
    const bareAlerts: string[] = [];
    for (const alert of input.recon.alerts) {
        if (alert.kind === "hearth-over") {
            const src = input.aversions.find((a) => a.kind === "swallow" && a.capPool === "hearth");
            if (src) {
                citations.push(
                    input.zh
                        ? `你${atSeg(src.at, true)}说过「${src.text}」——今天${POOL_LABEL.hearth}实吃 ${alert.actualMin}min（上限 ${alert.capMin}min，多用 ${alert.overMin}min）`
                        : `You said${atSeg(src.at, false)}: "${src.text}" — hearth took ${alert.actualMin}min today (cap ${alert.capMin}min, ${alert.overMin}min over)`,
                );
                continue;
            }
            bareAlerts.push(input.zh ? `${POOL_LABEL.hearth}今天实吃 ${alert.actualMin}min，上限 ${alert.capMin}min，多用 ${alert.overMin}min` : `Hearth took ${alert.actualMin}min today, cap ${alert.capMin}min, ${alert.overMin}min over`);
        } else if (alert.kind === "gold-squeezed") {
            const goldTaskIds = new Set((input.config?.tasks ?? []).filter((t) => t.pool === "gold" && t.task).map((t) => t.task));
            const src = input.aversions.find((a) => a.kind === "fear" && a.avatar && goldTaskIds.has(a.avatar));
            if (src) {
                citations.push(
                    input.zh
                        ? `你${atSeg(src.at, true)}说过「${src.text}」——今天${POOL_LABEL.gold}实吃 ${alert.actualMin}min（保底 ${alert.floorMin}min，还差 ${alert.shortMin}min）`
                        : `You said${atSeg(src.at, false)}: "${src.text}" — gold output took ${alert.actualMin}min today (floor ${alert.floorMin}min, ${alert.shortMin}min short)`,
                );
                continue;
            }
            bareAlerts.push(input.zh ? `${POOL_LABEL.gold}今天实吃 ${alert.actualMin}min，保底 ${alert.floorMin}min，还差 ${alert.shortMin}min` : `Gold output took ${alert.actualMin}min today, floor ${alert.floorMin}min, ${alert.shortMin}min short`);
        } else {
            // hearth-cold：凉了≠防沉迷（语义相反）——恒裸行
            const last = alert.lastSeen ? (input.zh ? `，上次 ${alert.lastSeen}` : `, last on ${alert.lastSeen}`) : "";
            bareAlerts.push(input.zh ? `${POOL_LABEL.hearth} ${alert.gapDays} 天没动了（最小频率 ${alert.freqDays} 天${last}）` : `Hearth untouched for ${alert.gapDays} days (min frequency ${alert.freqDays} days${last})`);
        }
    }
    return { vows, fears, swallows, citations, bareAlerts };
}
