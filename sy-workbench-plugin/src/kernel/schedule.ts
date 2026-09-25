// 作息训练·期 2（sloop □4）：班表编排层。
// timeblock 期 4 起 petal SchedStore items 数据面退役——班表条目=日记块（schedboard rpc 读写），
// 本层只剩：辅助状态档（schedule.json：drags/recon/prefs/lastRollDay）读写+晨间滚动（块化：
// 昨日块读→顺延→今日落块）+对账原料（块读）。
// 副作用走 api 层（单测 mock 边界）；纯决策在 core/schedule。

import { storageGetJson, storagePutJson, post, petalGetJsonFresh, petalGetJsonFreshEx } from "./api";
import { kernelLog } from "./loki";
import { getLogicalDay } from "./core/dates";
import { SCHEDULE_FILE, SCHEDULE_UPDATED_CHANNEL } from "../shared/channels";
import { handleGetProfile } from "./behavior";
import { schedBoardReadRpc, syncDayBoardToDiary } from "./schedboard";
import {
    boardRowsToItems,
    buildRecon,
    genSchedKey,
    morningRollBoard,
    normalizeSchedule,
    pruneSchedule,
    type SchedItem,
    type SchedStore,
    type SchedView,
} from "./core/schedule";

export interface ScheduleLogger {
    info: (msg: string, ...rest: unknown[]) => unknown;
    error: (msg: string, ...rest: unknown[]) => unknown;
}

export async function loadSchedule(): Promise<SchedStore> {
    // getFile 直读绕 storage.get 读缓存（□6 坑）：辅助档是双写者档（前端 saveData 直写盘），
    // 缓存会在前端写后恒拿旧值；getFile 不可用时退缓存通道兜底
    const fresh = await petalGetJsonFresh(SCHEDULE_FILE);
    if (fresh != null) return normalizeSchedule(fresh);
    return normalizeSchedule(await storageGetJson(SCHEDULE_FILE).catch(() => null));
}

/** 写路径专用（review P2-3）：读失败/坏档→null=调用方放弃本轮写——缓存兜底会把旧档
 *  整档覆盖前端新写（用户计划丢失）；缺档=合法空档照常返回。 */
export async function loadScheduleForWrite(): Promise<SchedStore | null> {
    const r = await petalGetJsonFreshEx(SCHEDULE_FILE);
    if (!r.ok) return null;
    return normalizeSchedule(r.data);
}

/** kernel 侧写辅助档：落盘+广播（petal 写=dataChanges 前端重载一次，写频=事件级罕见可接受） */
export async function saveSchedule(store: SchedStore, hint: string): Promise<void> {
    await storagePutJson(SCHEDULE_FILE, store);
    try {
        await siyuan.rpc.broadcast(SCHEDULE_UPDATED_CHANNEL, { hint, at: new Date().toISOString() });
    } catch {
        // 广播失败无碍（前端重载后自然读新档）
    }
    kernelLog("sloop", `schedule 辅助档写盘（${hint}）`);
}

/** appearance.lang（交接会开场包语言；挂实例生命周期缓存，失败兜底 zh——用户只看中文） */
let langCache: string | undefined;
export async function appearanceLang(): Promise<string> {
    if (langCache !== undefined) return langCache;
    try {
        const json = await post("/api/system/getConf", {});
        langCache = typeof json?.conf?.appearance?.lang === "string" ? json.conf.appearance.lang : "zh_CN";
    } catch {
        return "zh_CN"; // 失败不缓存（下轮重试），本次兜底中文
    }
    return langCache;
}

/** 块读面：某日班表行（SchedItem 形态）。null=rpc 失败（写面见 null 须中止本轮——空数组
 *  只表示合法空板，两者不可合流：写面以空基底落块=当日既有块被 diff 替换清空）。 */
export async function readDayItems(day: string): Promise<SchedItem[] | null> {
    const r = await schedBoardReadRpc({ day });
    if (!r.ok || !Array.isArray(r.items)) return null;
    return boardRowsToItems(day, r.items);
}

/** 块读面：日期区间班表行（守卫/周报的跨周原料；逐日 rpc，上限护栏防病态宽区间） */
export const READ_RANGE_MAX_DAYS = 90; // ≥守卫窗 61+未来域 14（review 终裁：62 会从起点截断吞掉未来域）

export async function readRangeItems(fromDay: string, toDay: string): Promise<SchedItem[]> {
    const out: SchedItem[] = [];
    const from = new Date(`${fromDay}T00:00:00`);
    const to = new Date(`${toDay}T00:00:00`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return out;
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    const capped = Math.min(days, READ_RANGE_MAX_DAYS);
    for (let i = 0; i < capped; i++) {
        const d = new Date(from.getTime() + i * 86_400_000);
        const day = getLogicalDay(d);
        out.push(...(await readDayItems(day)) ?? []);
    }
    return out;
}

/** 组装完整班表视图（旧 SchedStore 形态——周报/训练/结构守卫等纯层继续吃本形态零改动）：
 *  items=块读面注入（期 4 起 petal items 退役，真身只在日记块），recon/prefs 等辅助态照档 */
export async function assembleSchedView(fromDay: string, toDay: string): Promise<SchedView> {
    const [store, items] = await Promise.all([loadSchedule(), readRangeItems(fromDay, toDay)]);
    return { ...store, items: Object.fromEntries(items.map((i) => [i.key, i])) };
}

/** 晨间断签自愈（onrunning+hourly schedule-sync 搭车；期 4 块化）：昨晚没开交接会→昨日计划
 *  自动顺延到今天，不追责。lastRollDay 守卫=至多每日一次真写盘，零滚动=零写零重载。 */
export async function runMorningRollGuarded(logger: ScheduleLogger): Promise<{ day: string; rolled: number }> {
    const today = getLogicalDay(new Date());
    try {
        const store = await loadScheduleForWrite();
        if (!store) {
            await logger.error("[schedule] morning roll skipped: schedule.json 直读失败（防旧档覆盖，下轮重试）");
            return { day: today, rolled: 0 };
        }
        const yesterday = getLogicalDay(new Date(Date.now() - 86_400_000));
        const [todayRows, yesterdayRows] = await Promise.all([readDayItems(today), readDayItems(yesterday)]);
        if (todayRows == null || yesterdayRows == null) {
            // 块读失败≠空板：中止本轮防「今日无班表」误判→滚动产物整日替换既有班表（P1-1）
            await logger.error("[schedule] morning roll skipped: 当日/昨日班表块读失败（下轮重试）");
            return { day: today, rolled: 0 };
        }
        const doneKeys = new Set((store.recon[yesterday]?.results ?? []).filter((r) => r.verdict === "done").map((r) => r.key));
        const r = morningRollBoard({ today, lastRollDay: store.lastRollDay, todayRows, yesterdayRows, yesterdayDoneKeys: doneKeys });
        if (!r) {
            // 无滚动也顺手剪枝落盘（辅助档内容有变才写——prune 无变化返原引用）
            const next = pruneSchedule(store, today);
            if (next !== store) await saveSchedule(next, "prune");
            return { day: today, rolled: 0 };
        }
        // 顺延产物落今日日记块（块=唯一真身；rolled 的 key=临时键，keyRemap 迁成块 id——迁移
        // 后 rolledFrom 血缘保留在块 custom-sched-rolled-from）。块失败=辅助档照记 rollDay
        // （滚动意图已达成，断签日日记缺班表由下轮 schedule_set/手动排班自愈——不重滚）。
        try {
            const items: Record<string, SchedItem> = {};
            for (const it of r.rolled) items[it.key] = it;
            const board = await syncDayBoardToDiary(today, items);
            if (!board.board.ok) {
                await logger.error(`[schedule] morning roll 块侧跳过：${board.board.error ?? "unknown"}`);
            }
        } catch (e: any) {
            await logger.error(`[schedule] morning roll 块侧异常（rollDay 照记）：${String(e?.message ?? e).slice(0, 120)}`);
        }
        await saveSchedule(pruneSchedule({ ...store, lastRollDay: r.rollDay }, today), `morning-roll ${today}`);
        await logger.info(`[schedule] 晨间顺延 ${r.rolled.length} 条 → ${today}（断签不追责）`);
        return { day: today, rolled: r.rolled.length };
    } catch (e: any) {
        await logger.error(`[schedule] morning roll failed: ${String(e?.message ?? e).slice(0, 160)}`);
        return { day: today, rolled: 0 };
    }
}

/** 某日对账单（routine.recon/routine.handoff 共用；profile=□3 behavior-get 同源；期 4 块读面） */
export async function buildReconForDay(day: string): Promise<{
    recon: ReturnType<typeof buildRecon>;
    store: SchedStore;
    profile: import("./core/behavior").DayProfile | null;
    today: string;
    nowHM: string;
}> {
    const today = getLogicalDay(new Date());
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const nowHM = `${p(now.getHours())}:${p(now.getMinutes())}`;
    const [store, items] = await Promise.all([loadSchedule(), readDayItems(day)]);
    const dayItems = items ?? []; // 块读失败=空对账单（对账只读面容忍——写面另有中止守卫）
    const profile = (await handleGetProfile({ day })).profile;
    return { recon: buildRecon(dayItems, profile, today, nowHM), store, profile, today, nowHM };
}

/** 新条目键（prefs id/临时键共用；kernel 侧统一生成防撞） */
export function newSchedKey(): string {
    return genSchedKey(new Date());
}
