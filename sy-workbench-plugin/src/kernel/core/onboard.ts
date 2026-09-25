// 作息训练·期 3（sloop □5）：Onboarding 状态机（纯函数层）。
// 流程（设计档 §5）：挑身份定基色 → 静默观察约 3 天（零打扰纯收据——观察收据=□3 画像零改动）
// → 首份照镜子报告=冻结基线 → 初版粗排落班表 → 进入训练循环（交接会既有链路）。
// 存储：petal routine-onboard.json；唯一写者=前端用户动作（挑身份/冻结），kernel 只读——无双写竞态。

import { isValidDay, isValidHM } from "./schedule";
import { shiftDay } from "./behavior";
import type { OnboardConstraints } from "./formlib";
import { getArchetype } from "./formlib";

/** 观察期目标天数（「约 3 天」；达线后报告按钮亮） */
export const OBSERVE_TARGET_DAYS = 3;

/** 冻结基线（首份照镜子报告存档——期 4 周报「结构迁移」对照物） */
export interface OnboardBaseline {
    at: string;
    /** 观察期日集（YYYY-MM-DD 列表） */
    observedDays: string[];
    /** 报告正文（markdown，生成语言随实例） */
    report: string;
    /** 最像形态对照（分数只排序用） */
    match: { id: string; score: number; reason: string }[];
    /** 初版粗排（置信度随条目标注） */
    draft: { summary: string; start: string; end: string | null; hard: boolean; lowConf: boolean }[];
}

export interface OnboardStore {
    version: 1;
    /** picked=观察期中 / baselined=已冻结（训练循环中） */
    state: "picked" | "baselined";
    archetypeId: string;
    pickedAt: string;
    /** 观察期起始日 YYYY-MM-DD（含当天为第 1 天） */
    observeStart: string;
    constraints: OnboardConstraints;
    baseline: OnboardBaseline | null;
}

/** 归一（宽容：坏档/脏字段静默剔；archetypeId 不在库=整档作废返回 null=未开始） */
export function normalizeOnboard(raw: any): OnboardStore | null {
    if (!raw || typeof raw !== "object") return null;
    const archetypeId = typeof raw.archetypeId === "string" ? raw.archetypeId : "";
    if (!getArchetype(archetypeId)) return null;
    if (!isValidDay(raw.observeStart)) return null;
    const c = raw.constraints ?? {};
    const constraints: OnboardConstraints = {
        ...(isValidHM(c.wake) ? { wake: c.wake } : {}),
        ...(isValidHM(c.sleep) ? { sleep: c.sleep } : {}),
        ...(Array.isArray(c.notes) ? { notes: c.notes.filter((n: any) => typeof n === "string" && n.trim()).slice(0, 20) } : {}),
    };
    let baseline: OnboardBaseline | null = null;
    const b = raw.baseline;
    if (b && typeof b === "object" && typeof b.report === "string" && b.report.trim() && Array.isArray(b.observedDays)) {
        const match = (Array.isArray(b.match) ? b.match : [])
            .filter((m: any) => m && typeof m.id === "string" && typeof m.score === "number" && getArchetype(m.id))
            .map((m: any) => ({ id: m.id, score: m.score, reason: typeof m.reason === "string" ? m.reason : "" }))
            .slice(0, 3);
        const draft = (Array.isArray(b.draft) ? b.draft : [])
            .filter((x: any) => x && typeof x.summary === "string" && x.summary.trim() && isValidHM(x.start))
            .map((x: any) => ({ summary: x.summary.slice(0, 100), start: x.start, end: isValidHM(x.end) ? x.end : null, hard: x.hard === true, lowConf: x.lowConf === true }))
            .slice(0, 10);
        baseline = {
            at: typeof b.at === "string" ? b.at : "",
            observedDays: b.observedDays.filter((d: any) => isValidDay(d)).slice(0, 14),
            report: b.report,
            match,
            draft,
        };
    }
    const state = raw.state === "baselined" && baseline ? "baselined" : "picked";
    return {
        version: 1,
        state,
        archetypeId,
        pickedAt: typeof raw.pickedAt === "string" ? raw.pickedAt : "",
        observeStart: raw.observeStart,
        constraints,
        baseline,
    };
}

/** 观察第几天（含今天；观察期开始前/坏档=0）。日历日步进走 shiftDay——
 *  毫秒除法在 DST 切换日（25h/23h 日）会错号（review P2-2） */
export function observeDayNum(store: OnboardStore | null, today: string): number {
    if (!store || !isValidDay(today)) return 0;
    let cur = today;
    for (let n = 1; n <= 400; n++) {
        if (cur === store.observeStart) return n;
        cur = shiftDay(cur, -1);
    }
    return 0; // observeStart 在 today 之后（未来）或超 400 天=坏档
}

/** 报告可生成（观察期满） */
export function observeReady(store: OnboardStore | null, today: string): boolean {
    return observeDayNum(store, today) >= OBSERVE_TARGET_DAYS;
}

/** 观察期日集（observeStart..today；封顶 14 天防脏档拉爆；shiftDay 步进防 DST 错号） */
export function observeDays(store: OnboardStore, today: string): string[] {
    const days: string[] = [];
    let cur = store.observeStart;
    for (let i = 0; i < 14 && cur <= today; i++) {
        days.push(cur);
        cur = shiftDay(cur, 1);
    }
    return days;
}

/** 开步：挑身份+口述约束+观察期起 today（幂等语义由调用方整档覆盖承担） */
export function startObserving(archetypeId: string, constraints: OnboardConstraints, today: string, now: Date = new Date()): OnboardStore | null {
    if (!getArchetype(archetypeId) || !isValidDay(today)) return null;
    return {
        version: 1,
        state: "picked",
        archetypeId,
        pickedAt: now.toISOString(),
        observeStart: today,
        constraints,
        baseline: null,
    };
}

/** 冻结基线（首份报告落档；此后交接会开场包带身份基色段） */
export function freezeBaseline(store: OnboardStore, baseline: OnboardBaseline): OnboardStore {
    return { ...store, state: "baselined", baseline };
}
