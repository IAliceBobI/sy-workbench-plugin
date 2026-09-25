// 番茄桥（bear 09-20 拍板「直接用番茄工具箱的番茄钟，不搞这么多冗余代码」）：project 自建
// 番茄钟整体退役后，时间线与 sy-tomato-plugin 之间的只读桥——
//  - 状态读：tomato petal tomato-time.json（TomatoPersist 形态，字段语义对齐
//    sy-tomato-plugin/src/libs/TomatoTimer.ts 的 toPersist/restore：phase/startAt/elapsedMs
//    （>0=暂停中已计时长）/workMinutes/breakMinutes/focusDocID）。倒计时=本地算（startAt+时长
//    -now-elapsedMs），低频读档校准（禁 1s 轮询文件——秒针走本地钟）；
//  - 记账回流：tomato petal tomato-stats.json（Record<日,{pomo,min}>，语义对齐
//    sy-tomato-plugin/src/libs/TomatoStats.ts）低频轮询 diff 完成段数→追加写 POMODORO_LOG_FILE
//    （条目形态=原 core/pomodoro.ts 的 log 写法原样迁移；behavior 训练链 pomoDayAgg 消费面
//    口径不变）。探不通=回流暂缺（behavior 容量退化=排班参照变保守，过渡可接受）。
// 纪律：零 siyuan/网络/DOM 依赖（kernel bundle 与前端 bundle 共用同一份源——kernel/behavior.ts
// import 本文件 log 层，摇树翻转红线）；网络 IO 由组件侧注入（fetch 文本喂纯函数）；now 全注入可测。
import { shiftDay } from "../kernel/core/behavior";
import { isValidDay } from "../kernel/core/schedule";

// ── log 账本层（自原 core/pomodoro.ts 原样迁移——字段语义不变；写者=桥唯一追加，kernel 只读聚合） ──

/** 完成段绑定行快照（与 gui/timeline 行、core/feedback 的 FeedbackTarget 同构；桥回流时
 *  填 project 侧「当前任务」标记，未设=省略） */
export interface PomoTarget {
    source: string;
    summary: string;
    startMin: number;
}

export interface PomoLogEntry {
    /** 事件时刻 ISO（桥回流=轮询发现时刻——近似值；日聚合消费面只看 type/minutes） */
    at: string;
    type: "work-done" | "group-done" | "group-abandoned" | "group-expired";
    /** 相关番茄序号（1 起） */
    index?: number;
    /** 工作分钟（work-done） */
    minutes?: number;
    /** 放弃/过期时已完成数 */
    completed?: number;
    /** 组番茄总数（endless=null 省略） */
    total?: number;
    /** 绑定行快照（条目消失仍可读——feedback 同构） */
    target?: PomoTarget;
}

export type PomoLogStore = Record<string, PomoLogEntry[]>;

/** 周报要看一周窗+训练循环回看，90 天富余（写路径顺带剪） */
export const POMO_LOG_KEEP_DAYS = 90;

const LOG_TYPE_RE = /^(work-done|group-done|group-abandoned|group-expired)$/;

/** 归一（宽容：坏档=空档；脏条目静默剔——缺文件不算错红线） */
export function normalizePomoLog(raw: any): PomoLogStore {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: PomoLogStore = {};
    for (const [day, list] of Object.entries(raw)) {
        if (!isValidDay(day) || !Array.isArray(list)) continue;
        const entries = (list as any[])
            .filter((e) => e && typeof e === "object" && typeof e.at === "string" && LOG_TYPE_RE.test(String(e.type)))
            .slice(0, 200)
            .map((e: any) => ({
                at: e.at,
                type: e.type,
                ...(Number.isFinite(Number(e.index)) && Number(e.index) >= 1 ? { index: Math.floor(Number(e.index)) } : {}),
                ...(Number(e.minutes) > 0 ? { minutes: Math.floor(Number(e.minutes)) } : {}),
                ...(Number.isFinite(Number(e.completed)) && Number(e.completed) >= 0 ? { completed: Math.floor(Number(e.completed)) } : {}),
                ...(Number.isFinite(Number(e.total)) && Number(e.total) >= 1 ? { total: Math.floor(Number(e.total)) } : {}),
                ...(e.target && typeof e.target === "object" && typeof e.target.source === "string" && typeof e.target.summary === "string"
                    ? { target: { source: e.target.source, summary: String(e.target.summary).slice(0, 100), startMin: Math.floor(Number(e.target.startMin) || 0) } }
                    : {}),
            }));
        if (entries.length) out[day] = entries;
    }
    return out;
}

/** 追加（新 store；day 越界日键无效=原引用返回）。写者=桥唯一（kernel 只读聚合） */
export function appendPomoLog(store: PomoLogStore, day: string, entry: PomoLogEntry, today: string): PomoLogStore {
    if (!isValidDay(day)) return store;
    const cut = shiftDay(today, -(POMO_LOG_KEEP_DAYS - 1));
    if (day < cut) return store; // 越窗追加（异常输入）整体放弃，防剪枝后又加回
    const next: PomoLogStore = {};
    for (const [d, list] of Object.entries(store)) {
        if (d < cut) continue;
        next[d] = d === day ? [...list, entry] : list;
    }
    if (!next[day]) next[day] = [entry];
    return next;
}

/** 事件归日=本地日（toISOString().slice(0,10)=UTC 日——本地 0~8 点事件系统性落前一日，
 *  与 model.date/getLogicalDay 全仓本地日语义冲突） */
export function pomoLocalDay(ms: number): string {
    const d = new Date(ms);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日聚合（DayProfile 第八路消费：count=完成番茄数、minutes=Σ工作分钟） */
export function pomoDayAgg(store: PomoLogStore, day: string): { count: number; minutes: number } {
    let count = 0;
    let minutes = 0;
    for (const e of store[day] ?? []) {
        if (e.type !== "work-done") continue;
        count++;
        minutes += e.minutes ?? 0;
    }
    return { count, minutes };
}

// ── tomato 计时档解读（tomato-time.json；调用方先判 getFile 成功=裸档本体才有「在场」） ──

/** 计时档视图（原料形态——remaining 每秒本地重算，不靠重读档） */
export interface TomatoView {
    state: "running" | "paused";
    phase: "work" | "break";
    /** 段起点墙钟 ms */
    startAt: number;
    /** 暂停中已计时长 ms（0=计时中——tomato 语义） */
    elapsedMs: number;
    /** 本段总长 ms */
    durationMs: number;
    /** tomato 侧绑定文档 id（信息展示用；可缺） */
    focusDocID?: string;
}

const MINUTE_MS = 60_000;

/** 计时档解析：null=idle/坏档/过期段（对齐 tomato restore 语义——段到期 tomato 前端在场
 *  1s 内自清，不在场=过期即 idle；宽判在跑会卡 00:00 假冻结）。非对象/{code} 错误壳=null。 */
export function parseTomatoTime(raw: any): TomatoView | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.phase !== "work" && raw.phase !== "break") return null; // {} = idle（toPersist 无段形态）
    const startAt = Number(raw.startAt);
    const workMinutes = Number(raw.workMinutes);
    const breakMinutes = Number(raw.breakMinutes);
    const elapsedMs = Number(raw.elapsedMs ?? 0);
    if (!Number.isFinite(startAt) || !(workMinutes > 0) || !(breakMinutes >= 0) || !(elapsedMs >= 0)) return null;
    const durationMs = (raw.phase === "work" ? workMinutes : breakMinutes) * MINUTE_MS;
    if (!(durationMs > 0)) return null; // break 段 0 分钟配置=形态非法
    return {
        state: elapsedMs > 0 ? "paused" : "running",
        phase: raw.phase,
        startAt,
        elapsedMs,
        durationMs,
        ...(typeof raw.focusDocID === "string" && raw.focusDocID ? { focusDocID: raw.focusDocID } : {}),
    };
}

/** 过期段判定（poll 侧用：running 态剩余恒 0 且过期→回 idle 展示，等 tomato 自清/下轮对齐） */
export function tomatoExpired(v: TomatoView, now: number): boolean {
    return v.state === "running" && now >= v.startAt + v.durationMs;
}

/** 剩余 ms（本地钟重算：暂停=冻结；running=时长-(now-startAt) 钳 0） */
export function tomatoRemaining(v: TomatoView, now: number): number {
    if (v.state === "paused") return Math.max(0, v.durationMs - v.elapsedMs);
    return Math.max(0, v.durationMs - Math.max(0, now - v.startAt));
}

/** mm:ss（chip 显示） */
export function fmtRemaining(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── 记账回流（tomato-stats.json diff → log 追加） ──

/** tomato 日统计快照（Record<YYYY-MM-DD, {pomo,min}> 的值形态） */
export interface TomatoStatsSnap {
    pomo: number;
    min: number;
}

/** 回流锚（桥状态档持久化——重载/重挂不丢窗；日→已见统计） */
export type TomatoStatsSeen = Record<string, TomatoStatsSnap>;

/** stats 档防御读（Record<日,{pomo,min}>；垃圾值按零值——对齐 tomato statsFor） */
export function parseTomatoStats(raw: any): Record<string, TomatoStatsSnap> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, TomatoStatsSnap> = {};
    for (const [day, v] of Object.entries(raw)) {
        if (!isValidDay(day)) continue;
        const pomo = Number((v as any)?.pomo);
        const min = Number((v as any)?.min);
        out[day] = {
            pomo: Number.isFinite(pomo) && pomo > 0 ? Math.floor(pomo) : 0,
            min: Number.isFinite(min) && min > 0 ? Math.floor(min) : 0,
        };
    }
    return out;
}

export interface StatsDiffResult {
    /** 追加后的新 store（无增量=原引用返回——调用方据此免写盘） */
    store: PomoLogStore;
    /** 新锚（调用方持久化；stats 读失败轮次勿调用本函数=锚原地不动） */
    seen: TomatoStatsSeen;
    /** 本轮追加条数（诊断/打点用） */
    added: number;
}

/** stats diff+入账一体化：增量段数 N>0 → N 条 work-done 追加进 store（落 stats 的日 key
 *  非发现日——夜跨日窗口归真值日）；增量分钟均摊（前 N-1 条 base、末条收余数——总和保真）；
 *  负增量=外部清档重置只挪锚不回补；锚缺失（首读/新日）=只记锚（桥上线前的历史不灌账本）。 */
export function applyTomatoStatsDiff(store: PomoLogStore, stats: Record<string, TomatoStatsSnap>, seen: TomatoStatsSeen, now: number, today: string, target?: PomoTarget): StatsDiffResult {
    const nextSeen: TomatoStatsSeen = { ...seen };
    let next = store;
    let added = 0;
    const at = new Date(now).toISOString();
    for (const [day, cur] of Object.entries(stats)) {
        const prev = seen[day];
        nextSeen[day] = cur;
        if (!prev) continue; // 首见=记锚不回补
        const dPomo = cur.pomo - prev.pomo;
        const dMin = cur.min - prev.min;
        if (dPomo <= 0) continue; // 无增量/外部重置
        const base = Math.max(1, Math.floor(dMin / dPomo));
        for (let i = 1; i <= dPomo; i++) {
            const minutes = i === dPomo ? Math.max(1, dMin - base * (dPomo - 1)) : base;
            next = appendPomoLog(next, day, { at, type: "work-done", index: prev.pomo + i, minutes, ...(target ? { target } : {}) }, today);
            added++;
        }
    }
    return { store: next, seen: nextSeen, added };
}

// ── 「当前任务」轻状态（纯 project 侧，petal 桥状态档；不涉计时） ──

/** 桥状态档形态（一档两键：当前任务标记 + 回流锚——重载不丢窗） */
export interface PomoBridgeState {
    /** 当前任务行快照（null/缺=未设） */
    focus?: PomoTarget | null;
    /** tomato stats 回流锚 */
    seen?: TomatoStatsSeen;
}

/** 桥状态档归一（坏档=空态；seen 脏日键剔） */
export function normalizePomoBridgeState(raw: any): PomoBridgeState {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: PomoBridgeState = {};
    const f = raw.focus;
    if (f && typeof f === "object" && typeof f.source === "string" && typeof f.summary === "string") {
        out.focus = { source: f.source, summary: String(f.summary).slice(0, 100), startMin: Math.floor(Number(f.startMin) || 0) };
    }
    if (raw.seen && typeof raw.seen === "object" && !Array.isArray(raw.seen)) {
        const seen = parseTomatoStats(raw.seen);
        if (Object.keys(seen).length) out.seen = seen;
    }
    return out;
}
