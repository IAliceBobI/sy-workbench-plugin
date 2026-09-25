// 作息训练·期 6（sloop □8）：训练参数编排层。
// 唯一写者=kernel（周学习搭车周报周期 routine-weekly 同款；schedule_set 结构守卫只读）；
// 前端读走 HTTP getFile（readPetalJsonViaHttp）纯展示——无双写竞态。
// 防重载纪律（mcp.md 三件套同哲学）：幂等=log 已有该 weekStart 零写；坏档（文本非空但
// parse 失败）本轮放弃不覆写（weekly 同款）；学习挂了不阻周报生成（独立失败域）。

import { storagePutJson, petalGetJsonFresh, petalGetJsonFreshEx } from "./api";
import { kernelLog } from "./loki";
import { getLogicalDay } from "./core/dates";
import { isHourKey, shiftDay } from "./core/behavior";
import { ROUTINE_TRAINING_FILE, ROUTINE_WEEKLY_FILE, ONBOARD_FILE } from "../shared/channels";
import { handleGetProfile } from "./behavior";
import { assembleSchedView } from "./schedule";
import { normalizeOnboard } from "./core/onboard";
import { scanAnomaly, normalizeWeekly, weekDays, type ReportTarget, type WeeklyStore } from "./core/report";
import { readDayLedger } from "./ammoLedger";
import { poolMinutesFromLedger } from "./core/ammoQuadrant";
import { dayAlmanac } from "../lunarInfo";
import {
    buildTrainingContext,
    dayKindOf,
    learnWeeklyCapacity,
    normalizeTraining,
    type DayLearnSignal,
    type TrainingContext,
} from "./core/training";

export interface TrainingLogger {
    info: (msg: string, ...rest: unknown[]) => unknown;
    error: (msg: string, ...rest: unknown[]) => unknown;
}

export type WeeklyLearnResult =
    | "applied" // 参数已更新（或含样本周的正常学习）
    | "anomaly-skip" // 异常周剔除（账本留痕，参数不动）
    | "no-signal" // 周内零样本（思源没开——留痕止重复扫描）
    | "already" // 该周已学过（幂等零写）
    | "read-failed" // 训练档损坏（本轮放弃不覆写）
    | "schedule-read-failed"; // 班表直读失败（防旧档覆盖，下轮重试）

/** 训练档读取（三态：ok:false=读失败/坏档→调用方放弃本轮勿覆写——训练参数不可重建，
 *  review P2-4；ok:true+null=缺档合法空）。getFile 直读通道与 schedule 写路径守卫同款。 */
async function readTrainingRaw(): Promise<{ ok: boolean; raw: any }> {
    const r = await petalGetJsonFreshEx<any>(ROUTINE_TRAINING_FILE).catch(() => ({ ok: false, data: null }));
    return r.ok ? { ok: true, raw: r.data } : { ok: false, raw: null };
}

/** 周学习（周报周期搭车；target/weekly 由调用方传入——report.ts 已解析免重读）。
 *  异常周判定=周报表存档 flagged || 对账扫描（与周报同源同判——生成路径存档未落，
 *  扫描先行；两路取或：任一命中=剔除）。 */
export async function runWeeklyLearning(target: ReportTarget, weekly: WeeklyStore, logger: TrainingLogger, now: Date = new Date()): Promise<WeeklyLearnResult> {
    const r = await readTrainingRaw();
    if (!r.ok) {
        logger.error("[training] 训练档损坏（本轮放弃，删档重建可恢复）");
        return "read-failed";
    }
    const store = normalizeTraining(r.raw);
    if (store.log.some((e) => e.weekStart === target.weekStart)) return "already";

    const sched = await assembleSchedView(shiftDay(target.weekStart, -7), getLogicalDay(now));
    if (!sched) return "schedule-read-failed"; // 防旧档覆盖（schedule 同款）；幂等下轮重试

    const signals: DayLearnSignal[] = [];
    for (const d of weekDays(target)) {
        const prof = (await handleGetProfile({ day: d })).profile;
        const rec = sched.recon[d];
        // ammo □5：吃量信号=日账打点（v2 学习对象=各池真实吃量；读失败=该日无收据不进分母——
        // 收据日稀释防护的编排侧，learnWeeklyCapacity 纯层照判）
        const ledger = await readDayLedger(d).catch(() => null);
        const digest = ledger?.ok ? poolMinutesFromLedger(ledger.items) : null;
        signals.push({
            day: d,
            kind: dayKindOf(d, dayAlmanac(d)),
            pools: digest?.pools ?? {},
            hasLedger: (ledger?.items.length ?? 0) > 0,
            hasRecon: rec?.results?.some((x) => x.verdict === "done" || x.verdict === "missed") ?? false,
            pomoMin: prof?.pomodoros?.minutes ?? 0,
            // O2① 读面兜底：活动在场判据用 isHourKey 键域（脏键-only 日不进学习分母）
            hasActivity: Object.keys(prof?.activeHours ?? {}).some(isHourKey),
        });
    }

    const anomalyFlagged = weekly.weeks[target.weekStart]?.anomaly?.flagged === true || scanAnomaly(sched, target, true).flagged;
    const out = learnWeeklyCapacity(store, target.weekStart, signals, anomalyFlagged, now);
    if (!out) return "already";
    await storagePutJson(ROUTINE_TRAINING_FILE, out.store);
    kernelLog("sloop", `weekly-learning ${target.weekStart}: ${out.entry.outcome}`);
    logger.info(`[training] 周学习 ${target.weekStart}: ${out.entry.outcome}`);
    return out.entry.outcome;
}

/** 训练上下文（交接会开场包/plan_context 注入面）。schedItems 由调用方传入（两处调用点
 *  本就持有班表档，免重读）；读失败=返回 null=调用方不带该段（缺档≠失败：空档照常算——
 *  容量 null+结构守卫仍可用）。 */
export async function getTrainingContext(input: { today?: string; targetDay: string; schedItems: Record<string, import("./core/schedule").SchedItem> }): Promise<TrainingContext | null> {
    const r = await readTrainingRaw();
    if (!r.ok) return null;
    const weekly = normalizeWeekly(await petalGetJsonFresh(ROUTINE_WEEKLY_FILE).catch(() => null));
    const onboard = normalizeOnboard(await petalGetJsonFresh(ONBOARD_FILE).catch(() => null));
    return buildTrainingContext({
        today: input.today ?? getLogicalDay(new Date()),
        targetDay: input.targetDay,
        training: normalizeTraining(r.raw),
        weekly,
        schedItems: input.schedItems,
        fallbackDraft: onboard?.baseline?.draft ?? null,
        almOf: dayAlmanac,
    });
}

/** 明日（交接会第四幕排的对象） */
export function tomorrowOf(day: string): string {
    return shiftDay(day, 1);
}
