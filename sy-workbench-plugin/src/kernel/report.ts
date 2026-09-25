// 作息训练·期 4（sloop □6）：照镜子周报·编排层。
// 周日晚 20:00 起的目标周首跑生成（onrunning 兜底+hourly rpc 搭车，□18 weather 同款）：
// 周窗画像 → buildWeeklyReport 四段 → 全文存思源文档（mirrorBox 定档笔记本 /照镜子/ 专目录，
// 一篇一周；缺省=首个未关闭笔记本）→ 班表「照镜子·第 N 周」条目（稳定键 wr-<weekStart> 幂等）
// → 周报表落盘+班表广播。
// 防重载纪律（mcp.md 三件套同哲学）：幂等=weeks[weekStart] 已存在零写；空周不生成不记档；
// 剪枝=滚动 8 周仅内容变化才写；坏档（parse 失败）本轮放弃不覆写（防 firstWeek 重置）。
// 已知小窗（review 接受）：文档建成后任何后续写失败（周报表/班表）=下轮重跑产孪生文档
// （用户可删，petal 写失败概率极低——b24e5f62 message 同款取舍）。
import { storagePutJson, storageGetText, createDocWithMd, post, petalGetJsonFresh } from "./api";
import { kernelLog } from "./loki";
import { getLogicalDay } from "./core/dates";
import { ROUTINE_WEEKLY_FILE, ONBOARD_FILE } from "../shared/channels";
import { handleGetProfile } from "./behavior";
import type { DayProfile } from "./core/behavior";
import { appearanceLang, assembleSchedView, readDayItems } from "./schedule";
import { syncDayBoardToDiary } from "./schedboard";
import { runWeeklyLearning } from "./training";
import { normalizeOnboard } from "./core/onboard";
import { shiftDay } from "./core/behavior";
import type { SchedItem } from "./core/schedule";
import {
    buildWeeklyReport,
    pruneWeekly,
    normalizeWeekly,
    reportDue,
    weekDays,
    weekHasEvidence,
    weekNumOf,
    type WeeklyStore,
} from "./core/report";

export interface ReportLogger {
    info: (msg: string, ...rest: unknown[]) => unknown;
    error: (msg: string, ...rest: unknown[]) => unknown;
}

export interface WeeklyResult {
    skipped: boolean;
    reason?: "exists" | "no-evidence" | "no-box" | "corrupt" | "schedule-read-failed" | "board-read-failed";
    weekStart?: string;
    docId?: string;
}

/** 照镜子文档目录名（日记本下；建目录=createDocWithMd hpath 层级自动建） */
export const MIRROR_DIR = "照镜子";

export async function runWeeklyReport(logger: ReportLogger, now: Date = new Date()): Promise<WeeklyResult> {
    const target = reportDue(now);
    const today = getLogicalDay(now);
    // 坏档防线（review P1-3）：文本非空但 parse 失败=读失败≠无档——本轮放弃不覆写
    // （空档为基底的整档覆写会清历史+重置 firstWeek=周数重编；坏档等用户删档重建）
    const weeklyText = await storageGetText(ROUTINE_WEEKLY_FILE).catch(() => null);
    let weeklyRaw: any = null;
    if (weeklyText && weeklyText.trim()) {
        try {
            weeklyRaw = JSON.parse(weeklyText);
        } catch (e: any) {
            logger.error(`[weekly] 周报表损坏（本轮放弃，删档重建可恢复）: ${String(e?.message ?? e).slice(0, 120)}`);
            return { skipped: true, reason: "corrupt", weekStart: target.weekStart };
        }
    }
    const weekly = normalizeWeekly(weeklyRaw);
    const pruned = pruneWeekly(weekly, today);

    // 幂等短路：已生成周零写（剪枝有变化才补一笔——内容变才写，petal 零重载）
    if (pruned.weeks[target.weekStart]) {
        if (pruned !== weekly) await storagePutJson(ROUTINE_WEEKLY_FILE, pruned);
        return { skipped: true, reason: "exists", weekStart: target.weekStart };
    }

    // 周窗采集（内存优先盘兜底——周日生成时当日进行稿还在 kernel 内存）
    const profiles: DayProfile[] = [];
    for (const d of weekDays(target)) {
        const r = await handleGetProfile({ day: d });
        if (r.profile) profiles.push(r.profile);
    }
    // 期 4 块化：items=块读面组装（周窗+对账窗缓冲——锚统计/证据判定的原料）
    const sched = await assembleSchedView(shiftDay(target.weekStart, -7), today);
    if (!weekHasEvidence(profiles, sched, target)) {
        return { skipped: true, reason: "no-evidence", weekStart: target.weekStart };
    }
    const onboard = normalizeOnboard(await petalGetJsonFresh(ONBOARD_FILE)); // 前端唯一写者档=fresh 读（□6 家族，review P1-4）
    const lang = await appearanceLang();

    const weekNum = weekNumOf(pruned.firstWeek, target.weekStart);
    const out = buildWeeklyReport({ lang, weekStart: target.weekStart, weekEnd: target.weekEnd, weekNum, profiles, sched, onboard });

    // 文档落点（零配置，review P1-1/P1-2）：不再探测日记本（conf.dailyNote.notebookPath 在
    // 3.8.3 内核 getConf 不存在=恒空死代码）——镜像盒 mirrorBox 优先（lsNotebooks 校验在册
    // 且未关闭：被删/被关=失效自愈降级，否则 createDocWithMd 每周重试每周失败=链路永久死亡）
    // → 首个未关闭笔记本 → 全空（空库）=跳过不记档，下轮重查。
    const notebooks = await post("/api/notebook/lsNotebooks", {}).catch(() => null);
    const openBoxes: Array<{ id: string }> = Array.isArray(notebooks?.notebooks) ? notebooks.notebooks.filter((n: any) => !n?.closed && typeof n?.id === "string") : [];
    let box: string | null = pruned.mirrorBox && openBoxes.some((b) => b.id === pruned.mirrorBox) ? pruned.mirrorBox : null;
    if (!box) box = openBoxes[0]?.id ?? null;
    if (!box) return { skipped: true, reason: "no-box", weekStart: target.weekStart };
    // □8 期 6 周学习搭车（evidence+box 闸后=零信号周/无库周零写，下轮补；生成路径专属——
    // exists 短路不补学、升级前旧周不追溯；独立失败域：学习挂了不阻周报生成；学习在文档
    // 创建前跑=学习成功+建文档失败的补跑轮学习幂等（log 已有该周）不重复学）
    try {
        await runWeeklyLearning(target, pruned, logger, now);
    } catch (e: any) {
        logger.error(`[weekly] 训练学习失败（不阻周报）: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    const docId = await createDocWithMd(box, `/${MIRROR_DIR}/${out.docName}`, out.markdown);

    // 班表条目（周报日落托盘，块=唯一真身；期 4 块化——幂等键=复用当日既有 report 行的块 id，
    // 补跑轮不产重复 chip/重复块）
    const at = now.toISOString();
    const weekEndRows = await readDayItems(target.weekEnd);
    if (weekEndRows == null) {
        // 块读失败≠空板：中止本轮防 chip 单行替换周日全天（P1-1）
        return { skipped: true, reason: "board-read-failed", weekStart: target.weekStart };
    }
    const prevChip = weekEndRows.find((i) => i.origin === "report");
    const chipKey = prevChip?.key ?? `wr-${target.weekStart}`;
    const chip: SchedItem = {
        key: chipKey,
        summary: out.chipSummary,
        date: target.weekEnd,
        start: null,
        end: null,
        hard: false,
        origin: "report",
        createdAt: prevChip?.createdAt ?? at,
        updatedAt: at,
    };
    try {
        const itemsRecord: Record<string, SchedItem> = Object.fromEntries(weekEndRows.map((i) => [i.key, i]));
        itemsRecord[chipKey] = chip;
        const r = await syncDayBoardToDiary(target.weekEnd, itemsRecord);
        if (!r.board.ok) {
            logger.error(`[weekly] 周报 chip 块侧跳过：${r.board.error ?? "unknown"}`);
        }
    } catch (e: any) {
        logger.error(`[weekly] 周报 chip 块侧异常：${String(e?.message ?? e).slice(0, 120)}`);
    }

    // 周报表落盘（firstWeek 首次置位=周编号锚；mirrorBox 定档=后续周报同目录）
    const next: WeeklyStore = {
        ...pruned,
        firstWeek: pruned.firstWeek ?? target.weekStart,
        mirrorBox: box,
        weeks: {
            ...pruned.weeks,
            [target.weekStart]: { num: weekNum, at, docId, docName: out.docName, day: target.weekEnd, anomaly: out.anomaly },
        },
    };
    await storagePutJson(ROUTINE_WEEKLY_FILE, next);
    kernelLog("sloop", `weekly-report 第 ${weekNum} 周（${target.weekStart}）生成 → doc ${out.docName}`);
    logger.info(`[weekly] 第 ${weekNum} 周报告生成: ${out.docName}`);
    return { skipped: false, weekStart: target.weekStart, docId };
}

// ── 串行守卫（weather/behavior 同款）：onrunning 与 rpc 同刻触发合并补跑 ──

let inFlight = false;
let inFlightSince = 0;
let pending = false;
const INFLIGHT_DEADLOCK_MS = 10 * 60_000;

export async function runWeeklyReportGuarded(logger: ReportLogger, now: Date = new Date()): Promise<WeeklyResult | null> {
    if (inFlight && Date.now() - inFlightSince < INFLIGHT_DEADLOCK_MS) {
        pending = true;
        return null;
    }
    inFlight = true;
    inFlightSince = Date.now();
    try {
        let last: WeeklyResult | null = null;
        do {
            pending = false;
            last = await runWeeklyReport(logger, now);
        } while (pending);
        return last;
    } finally {
        inFlight = false;
    }
}
