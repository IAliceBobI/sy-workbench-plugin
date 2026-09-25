// sloop □23 执行期随手反馈（纯函数层）：时间线行上「记」钮 → 独立 feedback 档。
// 设计定案（队列 mini-spec）：不挂 SchedItem key（班表条目 KEEP_DAYS 剪枝+非 sched 源行无
// key）——反馈自含目标快照（source/summary/startMin 三元组，行键同款），条目消失仍可读；
// 不进 DayProfile（画像=聚合统计+内容防抖会把每次反馈变画像重写=重载风暴；反馈=自由文本
// 快照，分层清晰）；消费者直读档（交接会「今日随手记」段，周报异常周段将来复用）。
// 写者=前端用户动作（记/删，整档读改写）；kernel 只读——与 onboard 同款无双写竞态。
import { isValidDay, isValidHM } from "./schedule";

/** 五源词表与 gui/timeline 的 TimelineSource 同构（core 不反向依赖 gui；结构类型下 UI 传参
 *  直接兼容，联合保拼写）。ammo □7：live=日账实况段行（记钮 target 同构——三元组口径不变） */
export type FeedbackSource = "remind" | "task" | "burden" | "feishu" | "sched" | "live";

/** 反馈挂靠的行快照（记的时刻行还在不在都无所谓——快照自含可读） */
export interface FeedbackTarget {
    source: FeedbackSource;
    summary: string;
    /** 当天分钟数（行对齐用；档只存不解释） */
    startMin: number;
}

export interface FeedbackEntry {
    /** 记下的时刻 HH:mm（墙上钟） */
    at: string;
    text: string;
    target?: FeedbackTarget;
}

/** day(YYYY-MM-DD) → 条目列表（追加序=记录序） */
export type FeedbackStore = Record<string, FeedbackEntry[]>;

/** 滚动剪枝窗（周报要看一周窗，30 天富余；写路径顺带剪） */
export const FEEDBACK_KEEP_DAYS = 30;

const TEXT_MAX = 500;
const DAY_MAX_ENTRIES = 200; // 单日条目上限（脏数据防御，人手打不到）

/** 快照 summary 上限。注意 gui/timeline 的 trunc 产物=slice(0,100)+"…"（101 字符）——行侧 summary
 *  可达 101，档内归一到 100：键构造双侧（fbTargetKey）同口径截断，写读往返键恒等（review P1-1） */
export const SUMMARY_SNAP_MAX = 100;

export function sanitizeTarget(t: FeedbackTarget): FeedbackTarget {
    return { source: t.source, summary: t.summary.slice(0, SUMMARY_SNAP_MAX), startMin: Math.floor(t.startMin) };
}

/** 行匹配键（addFeedback 写入即归一 → 档读回 normalize 同限 → Timeline 行侧同式截断，三方恒等） */
export function fbTargetKey(t: Pick<FeedbackTarget, "summary" | "startMin"> & { source: string }): string {
    return `${t.source}#${t.summary.slice(0, SUMMARY_SNAP_MAX)}#${Math.floor(t.startMin)}`;
}

/** 归一（宽容：坏档=空档；day 键非法/条目脏字段静默剔——缺文件不算错红线） */
export function normalizeFeedback(raw: any): FeedbackStore {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: FeedbackStore = {};
    for (const [day, list] of Object.entries(raw)) {
        if (!isValidDay(day) || !Array.isArray(list)) continue;
        const entries: FeedbackEntry[] = [];
        for (const e of list) {
            if (!e || typeof e !== "object") continue;
            const at = typeof e.at === "string" && isValidHM(e.at) ? e.at : null;
            const text = typeof e.text === "string" ? e.text.trim().slice(0, TEXT_MAX) : "";
            if (!at || !text) continue;
            const t = e.target;
            const target =
                t && typeof t === "object" && typeof t.summary === "string" && t.summary.trim() && typeof t.startMin === "number" && Number.isFinite(t.startMin) && t.startMin >= 0 && t.startMin < 24 * 60
                    ? sanitizeTarget({ source: t.source as FeedbackSource, summary: t.summary, startMin: t.startMin })
                    : undefined;
            entries.push({ at, text, ...(target ? { target } : {}) });
            if (entries.length >= DAY_MAX_ENTRIES) break;
        }
        if (entries.length) out[day] = entries;
    }
    return out;
}

export function feedbackOf(store: FeedbackStore, day: string): FeedbackEntry[] {
    return store[day] ?? [];
}

/** 追加一条（不可变；顺带滚动剪枝）。at/text 脏值由调用面保证（normalize 同口径再防一层） */
export function addFeedback(store: FeedbackStore, day: string, at: string, text: string, target?: FeedbackTarget): FeedbackStore {
    const cleanText = text.trim().slice(0, TEXT_MAX);
    if (!isValidDay(day) || !isValidHM(at) || !cleanText) return store;
    const entry: FeedbackEntry = { at, text: cleanText, ...(target ? { target: sanitizeTarget(target) } : {}) };
    const next: FeedbackStore = { ...store, [day]: [...(store[day] ?? []), entry].slice(-DAY_MAX_ENTRIES) };
    return pruneFeedback(next, day);
}

/** 删一条（at+text 定位删首条匹配——同刻同文重复条目删谁语义等价） */
export function removeFeedback(store: FeedbackStore, day: string, at: string, text: string): FeedbackStore {
    const list = store[day];
    if (!list) return store;
    const idx = list.findIndex((e) => e.at === at && e.text === text);
    if (idx < 0) return store;
    const rest = list.slice(0, idx).concat(list.slice(idx + 1));
    const next = { ...store };
    if (rest.length) next[day] = rest;
    else delete next[day];
    return next;
}

/** 滚动剪枝：保 [today-FEEDBACK_KEEP_DAYS+1, today] 窗；无变化返原引用（schedule prune 惯例） */
export function pruneFeedback(store: FeedbackStore, today: string): FeedbackStore {
    if (!isValidDay(today)) return store;
    const t = new Date(`${today}T00:00:00`).getTime();
    if (Number.isNaN(t)) return store;
    let changed = false;
    const out: FeedbackStore = {};
    for (const [day, list] of Object.entries(store)) {
        const d = new Date(`${day}T00:00:00`).getTime();
        const keep = !Number.isNaN(d) && d >= t - (FEEDBACK_KEEP_DAYS - 1) * 86_400_000 && d <= t + 86_400_000;
        if (keep) out[day] = list;
        else changed = true;
    }
    return changed ? out : store;
}
