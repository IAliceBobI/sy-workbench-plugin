// 作息训练·期 6（sloop □8）→ ammo □5 v2：训练循环纯逻辑层。
// 三件（设计档 §6 期 6 / 概念档铁律 6/7/8）：
// ① 容量按日型学（铁律 7）：工作日/周末/节假日各自 EWMA 参数，周聚合更新防震荡（不日调）
//    ——v2 学习对象=**各池真实吃量**（ammo □5：弹性任务退役时刻表后，容量的真身=日账池吃量，
//    时段容量/doneItems/doneRate 退役）；
// ② 异常周降学习率（铁律 8）：期 4 周报判定的异常周标记触发——该周数据整周剔除（参数
//    不动+账本留痕）；AI 提示词同步感知（交接会/plan_context 注入「上周异常，今晚不推进度」）；
// ③ 棘轮+结构慢变守卫（铁律 6）：本周（目标日所在周）锚点族 vs 上周锚点族的差集
//    （新增/移除/中位挪动 ≥30 分钟）一周最多 2 处，超出=schedule_set/remove 拒绝——提示词
//    约束升级为代码级守卫；用户自己的拖动/手改不经过 MCP 写面不受限（守卫只拦 AI 写）。
// 零 siyuan/网络/DOM 依赖（channels 纪律：kernel bundle 与前端 bundle 共用同一份源）。
// 收据不是考卷：每笔参数更新进 log 账本（weekStart+证据摘要+before→after），滚动 12 条。

import { circDeltaMin, hmToMin, minToHM, type SchedItem } from "./schedule";
import { shiftDay } from "./behavior";
import { anchorOf, type AnchorKind, type WeeklyStore } from "./report";
import type { OnboardBaseline } from "./onboard";
import { AMMO_POOL_SLUGS, type AmmoPoolSlug } from "./ammoQuadrant";

// ── 日型（铁律 7 三分：工作日/周末/特殊日=历法节假日） ──

export type DayKind = "workday" | "weekend" | "holiday";

/** 日型判定：off（放假）>work（周末调休上班）>自然星期。alm 由调用方注入（lunarInfo 不进 core） */
export function dayKindOf(day: string, alm: { off: boolean; work: boolean }): DayKind {
    if (alm.off) return "holiday";
    if (alm.work) return "workday";
    const dow = new Date(day + "T12:00:00").getDay(); // 正午取星期（DST 日安全）
    return dow === 0 || dow === 6 ? "weekend" : "workday";
}

/** 某日所在周的周一 YYYY-MM-DD */
export function weekStartOf(day: string): string {
    return shiftDay(day, -((new Date(day + "T12:00:00").getDay() + 6) % 7));
}

// ── 容量参数模型（按日型一份；周聚合 EWMA；v2=各池吃量分钟） ──

export interface CapacityParams {
    dayKind: DayKind;
    /** 各池 EWMA 估计：日均真实吃量分钟（v2 学习对象——ammo □5；打点=唯一记账来源） */
    pools: Partial<Record<AmmoPoolSlug, number>>;
    /** 累计学习样本日数 */
    sampleDays: number;
    /** 最近一次学习周（周一 YYYY-MM-DD） */
    updatedWeek: string;
}

export interface TrainingLogEntry {
    at: string;
    weekStart: string;
    outcome: "applied" | "anomaly-skip" | "no-signal";
    /** 证据摘要（收据不是考卷）：逐日型本周样本实况（ledgerDays=0=本周该日型零打点收据日） */
    evidence: Array<{ dayKind: DayKind; days: number; ledgerDays: number; pools: Record<string, number> }>;
    /** applied 时逐日型逐池 before→after（[slug, before, after]；before=0=首学） */
    changes?: Array<{ dayKind: DayKind; pools: Array<[string, number, number]> }>;
}

/** 训练参数整档（petal routine-training.json；唯一写者=kernel 周学习，前端只读展示） */
export interface TrainingStore {
    version: 1;
    capacity: Partial<Record<DayKind, CapacityParams>>;
    log: TrainingLogEntry[];
}

export const TRAINING_LOG_KEEP = 12;
/** EWMA 步长（周聚合一步；小步=防震荡，铁律 7「反馈周聚合」的聚合侧权重） */
const LEARN_ALPHA = 0.3;

const KINDS: DayKind[] = ["workday", "weekend", "holiday"];

function round1(x: number): number {
    return Math.round(x * 10) / 10;
}

/** 盘档宽容归一（缺文件/坏档→空档；脏字段静默剔）。
 *  v1 旧档（doneItems/pomoMinutes/doneRate 时代）容量条目无 pools 字段=旧学习对象退役剔条目
 *  （log 照留——收据不删；样本从零重学，不拿旧语义数字冒充池吃量）。 */
export function normalizeTraining(raw: any): TrainingStore {
    const capacity: Partial<Record<DayKind, CapacityParams>> = {};
    if (raw?.capacity && typeof raw.capacity === "object" && !Array.isArray(raw.capacity)) {
        for (const k of KINDS) {
            const c = raw.capacity[k];
            if (!c || typeof c !== "object") continue;
            if (!c.pools || typeof c.pools !== "object" || Array.isArray(c.pools)) continue; // v1 条目剔（见上）
            const pools: Partial<Record<AmmoPoolSlug, number>> = {};
            for (const slug of AMMO_POOL_SLUGS) {
                const v = Number(c.pools[slug]);
                if (Number.isFinite(v) && v >= 0) pools[slug] = round1(v);
            }
            const sd = Number(c.sampleDays);
            capacity[k] = {
                dayKind: k,
                pools,
                sampleDays: Number.isFinite(sd) && sd > 0 ? Math.floor(sd) : 1,
                updatedWeek: typeof c.updatedWeek === "string" ? c.updatedWeek : "",
            };
        }
    }
    const log: TrainingLogEntry[] = Array.isArray(raw?.log)
        ? raw.log
              .filter((e: any) => e && typeof e.weekStart === "string" && ["applied", "anomaly-skip", "no-signal"].includes(e.outcome))
              .map((e: any) => ({
                  at: typeof e.at === "string" ? e.at : "",
                  weekStart: e.weekStart,
                  outcome: e.outcome,
                  evidence: Array.isArray(e.evidence)
                      ? e.evidence
                            .filter((x: any) => x && KINDS.includes(x.dayKind))
                            .map((x: any) => ({ dayKind: x.dayKind, days: Number(x.days) || 0, ledgerDays: Number(x.ledgerDays) || 0, pools: typeof x.pools === "object" && x.pools ? x.pools : {} }))
                            .slice(0, 3)
                      : [],
                  ...(Array.isArray(e.changes) ? { changes: e.changes.slice(0, 3) } : {}),
              }))
              .slice(0, TRAINING_LOG_KEEP)
        : [];
    return { version: 1, capacity, log };
}

// ── 周学习（纯：日账池吃量 → 按日型 EWMA；异常周剔除） ──

/** 一天的学习信号（编排层从日账打点+锚点对账+日画像采集） */
export interface DayLearnSignal {
    day: string;
    kind: DayKind;
    /** 当日各池吃量分钟（日账闭合段聚合；空=当日无打点） */
    pools: Record<string, number>;
    /** 当日有日账打点条目（吃量收据日在场——稀释防护的分母闸：无打点=不知道吃了多少≠零吃） */
    hasLedger: boolean;
    /** 锚点域对账判定在场（样本信号——班表=锚点域，对账仍存） */
    hasRecon: boolean;
    pomoMin: number;
    hasActivity: boolean;
}

function appendLog(store: TrainingStore, entry: TrainingLogEntry): TrainingStore {
    return { ...store, log: [...store.log, entry].slice(-TRAINING_LOG_KEEP) };
}

/** 周学习（纯）。返回 null=该周已学过（幂等）；异常周=整周剔除（参数不动，账本留痕）。
 *  铁律照搬（v1 期 6 → v2 只换数据面）：
 *  - 样本日=有任一信号（打点/对账/番茄/活跃）之日——思源没开的日子是无数据不是零分（收据不是考卷）；
 *  - 池吃量分母=**有日账打点的收据日**（hasLedger）：活跃没打点的日子=不知道吃了多少≠零吃，
 *    混入会把吃量系统性稀释（v1「doneItems 只在对账日上取均值」的同款防护——打点=吃量收据）；
 *  - 周日恒不进样本=无论周日晚跑还是下周补跑结果一致（20:00 生成时当日未走完，
 *    收半日数据会系统性低估）；
 *  - 无旧参数且本周零收据日=不建空参数档（不编「0 吃量」——v1 零对账不建档同款）；
 *    有旧参时零收据周=吃量保持旧值不被拖向零。 */
export function learnWeeklyCapacity(
    prev: TrainingStore,
    weekStart: string,
    signals: DayLearnSignal[],
    anomalyFlagged: boolean,
    now: Date = new Date(),
): { store: TrainingStore; entry: TrainingLogEntry } | null {
    if (prev.log.some((e) => e.weekStart === weekStart)) return null;
    const at = now.toISOString();
    const sunday = shiftDay(weekStart, 6);
    const samples = signals.filter((s) => s.day !== sunday).filter((s) => s.hasLedger || s.hasRecon || s.pomoMin > 0 || s.hasActivity);

    type Agg = { days: number; ledgerDays: number; poolSum: Record<string, number> };
    const byKind = new Map<DayKind, Agg>();
    for (const s of samples) {
        let a = byKind.get(s.kind);
        if (!a) {
            a = { days: 0, ledgerDays: 0, poolSum: {} };
            byKind.set(s.kind, a);
        }
        a.days += 1;
        if (s.hasLedger) {
            a.ledgerDays += 1;
            for (const [slug, min] of Object.entries(s.pools)) {
                if (!Number.isFinite(min) || min <= 0) continue;
                a.poolSum[slug] = (a.poolSum[slug] ?? 0) + min;
            }
        }
    }

    const evidence: TrainingLogEntry["evidence"] = [];
    for (const kind of KINDS) {
        const a = byKind.get(kind);
        if (!a) continue;
        const pools: Record<string, number> = {};
        if (a.ledgerDays > 0) for (const [slug, sum] of Object.entries(a.poolSum)) pools[slug] = round1(sum / a.ledgerDays);
        evidence.push({ dayKind: kind, days: a.days, ledgerDays: a.ledgerDays, pools });
    }

    // 铁律 8：异常周别学——数据整周剔除（不是降权后照学：生病周的「容量低」不是真实容量）
    if (anomalyFlagged) {
        const entry: TrainingLogEntry = { at, weekStart, outcome: "anomaly-skip", evidence };
        return { store: appendLog(prev, entry), entry };
    }
    if (!byKind.size) {
        const entry: TrainingLogEntry = { at, weekStart, outcome: "no-signal", evidence: [] };
        return { store: appendLog(prev, entry), entry };
    }

    const capacity = { ...prev.capacity };
    const changes: NonNullable<TrainingLogEntry["changes"]> = [];
    for (const kind of KINDS) {
        const a = byKind.get(kind);
        if (!a) continue;
        const old = capacity[kind];
        // 无旧参数且本周零收据日=不建档（吃量无收据不编数——活跃/对账证据不足以定「日均吃多少」）
        if (!old && a.ledgerDays === 0) continue;
        const weekAvg: Record<string, number> = {};
        if (a.ledgerDays > 0) for (const [slug, sum] of Object.entries(a.poolSum)) weekAvg[slug] = sum / a.ledgerDays;
        // 池序=白名单序（goja 对象键枚举=字典序≠V8 插入序——changes 呈现序跨引擎固定）
        const slugSet = new Set<string>([...Object.keys(old?.pools ?? {}), ...Object.keys(weekAvg)]);
        const slugs = AMMO_POOL_SLUGS.filter((x) => slugSet.has(x));
        const nextPools: Partial<Record<AmmoPoolSlug, number>> = {};
        const poolChanges: Array<[string, number, number]> = [];
        for (const slug of slugs) {
            const before = old?.pools[slug as AmmoPoolSlug];
            const w = weekAvg[slug];
            // 本周无该池收据（ledgerDays=0 或池没打点）=保持旧值（「不知道」不学成 0——稀释防护）
            const after = w == null ? (before ?? null) : round1(before != null ? LEARN_ALPHA * w + (1 - LEARN_ALPHA) * before : w);
            if (after == null) continue;
            nextPools[slug as AmmoPoolSlug] = after;
            poolChanges.push([slug, before ?? 0, after]);
        }
        capacity[kind] = { dayKind: kind, pools: nextPools, sampleDays: (old?.sampleDays ?? 0) + a.days, updatedWeek: weekStart };
        changes.push({ dayKind: kind, pools: poolChanges });
    }
    if (!changes.length) {
        // 全部日型=纯活跃样本（零打点零旧参）——按无有效学习留痕（不建空参数档）
        const entry: TrainingLogEntry = { at, weekStart, outcome: "no-signal", evidence };
        return { store: appendLog(prev, entry), entry };
    }
    const entry: TrainingLogEntry = { at, weekStart, outcome: "applied", evidence, changes };
    return { store: appendLog({ ...prev, capacity }, entry), entry };
}

// ── 棘轮+结构慢变守卫（铁律 6 代码级） ──

/** 一周最多动的锚点数（「一周最多动一两个锚点」红线） */
export const STRUCTURE_WEEKLY_LIMIT = 2;
/** 锚点中位挪动判变阈值（分钟）——与周报首份重校的 drift 阈同值 */
export const STRUCTURE_MOVE_TOL_MIN = 30;

export interface AnchorProfileEntry {
    /** 该锚点族本周出现次数（含托盘无时刻条目） */
    count: number;
    /** 出现条目 start 的低中位（分钟）；全在托盘=null */
    medianMin: number | null;
}

export type AnchorProfile = Partial<Record<AnchorKind, AnchorProfileEntry>>;

/** 一周锚点族画像：summary 按 anchorOf 分桶（与周报规律度段同一分类器——单一事实源），
 *  时刻取周内低中位=单日 outlier 拖不动结构（挪一天不算结构变动，挪一周才算） */
export function weekAnchorProfile(items: Record<string, SchedItem>, weekStart: string, weekEnd: string): AnchorProfile {
    const starts = new Map<AnchorKind, number[]>();
    const counts = new Map<AnchorKind, number>();
    for (const it of Object.values(items)) {
        if (it.date < weekStart || it.date > weekEnd) continue;
        if (it.origin === "report") continue; // 周报 chip（「照镜子·第 N 周（锻炼 2/5…）」）非用户锚——关键词会误吸（review P2-3）
        const kind = anchorOf(it.summary);
        if (!kind) continue;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        if (it.start) {
            const arr = starts.get(kind) ?? [];
            arr.push(hmToMin(it.start));
            starts.set(kind, arr);
        }
    }
    const out: AnchorProfile = {};
    for (const [kind, count] of counts) {
        const arr = (starts.get(kind) ?? []).sort((a, b) => a - b);
        out[kind] = { count, medianMin: arr.length ? arr[Math.floor((arr.length - 1) / 2)] : null };
    }
    return out;
}

/** 初版粗排→锚点族（首周基线回退用：上班表前的结构参照） */
export function onboardDraftProfile(draft: OnboardBaseline["draft"]): AnchorProfile {
    const starts = new Map<AnchorKind, number[]>();
    for (const d of draft) {
        const kind = anchorOf(d.summary);
        if (!kind) continue;
        const arr = starts.get(kind) ?? [];
        arr.push(hmToMin(d.start));
        starts.set(kind, arr);
    }
    const out: AnchorProfile = {};
    for (const [kind, arr] of starts) {
        const s = [...arr].sort((a, b) => a - b);
        out[kind] = { count: s.length, medianMin: s[Math.floor((s.length - 1) / 2)] };
    }
    return out;
}

const ANCHOR_ORDER: AnchorKind[] = ["wake", "sleep", "exercise", "sun", "deep"]; // 呈现序固定（勿依赖对象键序——goja 字典序≠V8 插入序）
const ANCHOR_LABEL: Record<AnchorKind, string> = { wake: "起床", sleep: "睡", exercise: "锻炼", sun: "晒太阳", deep: "深度块" };

export interface StructureGuard {
    ok: boolean;
    /** 本周（目标日所在周）锚点变动数 */
    used: number;
    limit: number;
    deviations: string[];
    /** 基线来源：prev-week=上周班表锚族（正轨）/ onboard-draft=初版粗排（首周回退）/ none=无可比结构（放行） */
    baseline: "prev-week" | "onboard-draft" | "none";
}

/** 结构守卫（纯）：基线=上周锚族（回退 onboard 粗排，皆无=放行）。逐类判变（防误拒三条）：
 *  ① 新增=写后本周出现、基线周（上周/粗排）从未有过的锚族；
 *  ② 挪动=两侧都在、周内中位时刻差 ≥ 容差（本周中位含已排日——明晚方案即未来结构）；
 *  ③ 移除=基线周有、**写前本周已立**、写后被抹掉（本周没排过≠删——逐日排班流下周初
 *     锚点天然缺席，对上周全周 diff 必误拒；缺席自由=用户可用「不排」自然淡化一个锚）。
 *  周内累计=对写后整周状态逐次重判（同内容重写不重复计数、回退自然消账）。
 *  ⚠只拦 AI 写面（schedule_set/remove）：用户拖动/手改是用户自己的结构决定（铁律：用户是老板）。 */
export function guardStructure(input: {
    /** 写前整档（移除判据的「本周已立」；展示态调用传与 items 同引用=移除恒不触发） */
    prevItems: Record<string, SchedItem>;
    /** 写后整档 */
    items: Record<string, SchedItem>;
    day: string;
    fallbackDraft?: OnboardBaseline["draft"] | null;
}): StructureGuard {
    const ws = weekStartOf(input.day);
    const we = shiftDay(ws, 6);
    const cur = weekAnchorProfile(input.items, ws, we);
    const pre = weekAnchorProfile(input.prevItems, ws, we);
    let base = weekAnchorProfile(input.prevItems, shiftDay(ws, -7), shiftDay(ws, -1));
    let baseline: StructureGuard["baseline"] = "prev-week";
    if (!Object.keys(base).length) {
        if (input.fallbackDraft?.length) {
            base = onboardDraftProfile(input.fallbackDraft);
            baseline = "onboard-draft";
        } else {
            return { ok: true, used: 0, limit: STRUCTURE_WEEKLY_LIMIT, deviations: [], baseline: "none" };
        }
    }
    const deviations: string[] = [];
    for (const kind of ANCHOR_ORDER) {
        const b = base[kind];
        const c = cur[kind];
        const p = pre[kind];
        const name = ANCHOR_LABEL[kind];
        if (!c) {
            if (b && p) deviations.push(`移除锚点「${name}」`);
            continue;
        }
        if (!b) {
            deviations.push(`新增锚点「${name}」`);
            continue;
        }
        if (b.medianMin == null && c.medianMin == null) continue;
        if (b.medianMin == null || c.medianMin == null) {
            deviations.push(`「${name}」${c.medianMin == null ? "失去固定时刻" : "新获固定时刻"}`);
        } else {
            // 圆周距离（review P1-1）：睡锚自然横跨午夜——23:50→00:10 实际漂 20 分钟；
            // 非睡锚 >12h 的挪动会折短显示（是否判变不受影响：两侧都远超容差）
            const d = Math.abs(circDeltaMin(b.medianMin, c.medianMin));
            if (d >= STRUCTURE_MOVE_TOL_MIN) deviations.push(`「${name}」挪动 ${d} 分钟（${minToHM(b.medianMin)} → ${minToHM(c.medianMin)}）`);
        }
    }
    return { ok: deviations.length <= STRUCTURE_WEEKLY_LIMIT, used: deviations.length, limit: STRUCTURE_WEEKLY_LIMIT, deviations, baseline };
}

// ── 训练上下文（交接会开场包/plan_context 注入面；前端组包同源复用） ──

export interface TrainingContext {
    /** 目标日（交接会=明天；plan_context=target_day）日型 */
    dayKind: DayKind;
    /** 该日型容量参数（null=样本不足未学） */
    capacity: CapacityParams | null;
    structure: { used: number; limit: number; deviations: string[]; baseline: StructureGuard["baseline"] };
    /** 最近异常周（近两周内已判定；null=无——AI 感知「今晚不推进度」） */
    anomaly: { weekStart: string; hits: string[] } | null;
}

export function buildTrainingContext(input: {
    today: string;
    /** 容量/日型/结构守卫的目标日 */
    targetDay: string;
    training: TrainingStore;
    weekly: WeeklyStore;
    schedItems: Record<string, SchedItem>;
    fallbackDraft?: OnboardBaseline["draft"] | null;
    /** 历法注入（lunarInfo 不进 core；kernel/前端各传 dayAlmanac） */
    almOf: (day: string) => { off: boolean; work: boolean };
}): TrainingContext {
    const dayKind = dayKindOf(input.targetDay, input.almOf(input.targetDay));
    // 展示态：prev=next 同档（守卫的「移除」判据=写前 vs 写后，展示恒不触发——余量数字=新增/挪动口径）
    const g = guardStructure({ prevItems: input.schedItems, items: input.schedItems, day: input.targetDay, fallbackDraft: input.fallbackDraft });
    // 最近异常周：本周或上周已判定的 flagged（周报周日 20:00 后才记档——本周命中=刚过的这周）
    let anomaly: TrainingContext["anomaly"] = null;
    const thisWs = weekStartOf(input.today);
    for (let i = 0; i < 2 && !anomaly; i++) {
        const ws = shiftDay(thisWs, -7 * i);
        const rec = input.weekly.weeks[ws];
        if (rec?.anomaly?.flagged) anomaly = { weekStart: ws, hits: (rec.anomaly.hits ?? []).slice(0, 3) };
    }
    return {
        dayKind,
        capacity: input.training.capacity[dayKind] ?? null,
        structure: { used: g.used, limit: g.limit, deviations: g.deviations, baseline: g.baseline },
        anomaly,
    };
}
