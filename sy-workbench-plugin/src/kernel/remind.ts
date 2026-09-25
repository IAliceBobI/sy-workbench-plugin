// 块提醒·编排层：扫全库 custom-remind-at（+custom-remind-repeat）→账本三态裁决→飞书事件写。
// □3 起每条走「GET 观测→签名比对」：两侧一致=零写跳过；只思源变=推；只飞书变=回写属性（改时间才写，
// 广播 REMIND_WRITTEN 前端直刷）；双变=思源赢+冲突计数++。触发源=onrunning 与 rpc remind-sync。
// 删除=重建（不墓碑）：飞书侧删除→GET 见 cancelled 墓碑→摘条目重建；任务勾选=当期静默。
// 副作用全走 api/feishu 客户端层（单测 mock 边界）；纯决策在 core/remind + core/ledger。
import { getBlockAttrs, setBlockAttrs, sql, storageGetJson, storagePutJson } from "./api";
import { getLogicalDay } from "./core/dates";
import { ATTR_SCHED_ORIGIN } from "./core/schedboard";
import { DONE_RE } from "./core/progressCalc";
import { isAuthErrorCode } from "./core/feishu";
import { ATTR_REMIND_AT, ATTR_REMIND_END, ATTR_REMIND_REPEAT, REMIND_EVENT_DURATION_MIN, buildRemindEventPayload, listRemindBlocksSql, parseRemindAt, parseRemindRepeat, pastBoardSkip, remindEndValid, pruneRemindEntries, remindKey, stripTaskMark } from "./core/remind";
import { remindersKey, decideLedgerAction, eventSig, payloadSig, timestampToWallTime } from "./core/ledger";
import { buildCalendarStatus, summaryFromResult, type CalendarSkipReason, type CalendarStatus } from "./core/calendarStatus";
import { createLedgerEvent, deleteLedgerEvent, FeishuApiError, getEvent, loadConfig, loadLedger, mutateLedgerKeys, patchLedgerEvent, upsertEventByKey } from "./feishu";
import { CALENDAR_STATUS_CHANNEL, CALENDAR_STATUS_FILE, REMIND_WRITTEN_CHANNEL } from "../shared/channels";

export interface RemindLogger {
    info: (msg: string, ...rest: unknown[]) => unknown;
    error: (msg: string, ...rest: unknown[]) => unknown;
}

export interface RemindSyncResult {
    skipped: boolean;
    day: string;
    created: number;
    updated: number;
    deleted: number;
    /** 两侧一致零写跳过（□3：无变化不再盲 PATCH——省 API 配额+可观测） */
    unchanged: number;
    /** 飞书改时间回写思源属性条数 */
    writtenBack: number;
    /** 三态双变裁决（思源赢）次数 */
    conflicts: number;
    /** 脏值行（非法 remind-at/remind-repeat/remind-end 手改产物）——记录在案不炸整轮 */
    invalid: { id: string; at: string; repeat?: string; end?: string }[];
    /** 本轮撞到的授权类错误码（20064/token 失效族）——前端红态+重授权提醒判据（按钮化 d） */
    authErrorCode?: number;
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 授权错认领：FeishuApiError 且 code 属 token 失效族 → 返回 code（首个认领者生效，本轮继续跳过其余行） */
function authCodeOf(e: unknown): number | undefined {
    return e instanceof FeishuApiError && isAuthErrorCode(e.code) ? e.code : undefined;
}

/** 状态落盘+广播（按钮化 b/d）：写失败/广播失败均无害——前端下次开面板读文件自愈 */
async function persistCalendarStatus(status: CalendarStatus, skipFile: boolean): Promise<void> {
    if (!skipFile) {
        try {
            await storagePutJson(CALENDAR_STATUS_FILE, status);
        } catch {
            // 状态写失败无害
        }
    }
    try {
        await siyuan.rpc.broadcast(CALENDAR_STATUS_CHANNEL, status);
    } catch {
        // 广播失败无害（单测环境 siyuan 未定义同走此路）
    }
}

/** 内容等价（除 at 外全等）——at 是每轮必新的时间戳，不参与变化判定 */
function statusContentEquals(a: CalendarStatus, b: CalendarStatus): boolean {
    return JSON.stringify({ ...a, at: "" }) === JSON.stringify({ ...b, at: "" });
}

/** 本轮状态收尾：读 prev（保留授权失败史）→构建→落盘+广播。
 *  ⚠️内容未变不落盘：petal 写入触发内核 dataChanges→前端插件重载→onrunning 又同步一轮——
 *  每轮必写=无限重载风暴（09-14 e2e 实锤，与账本「无变化零写」同款纪律）。at 的新鲜度由广播承载 */
async function settleCalendarStatus(input: {
    now: Date;
    summary?: ReturnType<typeof summaryFromResult>;
    skipped?: CalendarSkipReason;
    authErrorCode?: number;
    error?: string;
}): Promise<void> {
    const prev = await storageGetJson<CalendarStatus>(CALENDAR_STATUS_FILE).catch(() => null);
    const next = buildCalendarStatus({ ...input, prev });
    await persistCalendarStatus(next, Boolean(prev && statusContentEquals(prev, next)));
}

/** 外部写入属性后广播前端直刷（setBlockAttrs 不广播——open 编辑器图标会停在旧值） */
async function broadcastRemindWritten(blockId: string, at: string | null, repeat: string | null, end: string | null = null): Promise<void> {
    try {
        await siyuan.rpc.broadcast(REMIND_WRITTEN_CHANNEL, { blockId, at, repeat, end });
    } catch {
        // 广播失败无害：前端下次开文档扫描自愈
    }
}

/** 账本快照就地刷新（writeback/ack 路径，不走三原语） */
async function refreshLedgerSnaps(key: string, sySnap: string, fsSnap: string): Promise<void> {
    // □6a：键级写（进账本写队列）——旧整文件 save 并发下覆盖他链键
    await mutateLedgerKeys((entries) => {
        const entry = entries[key];
        if (!entry) return;
        entries[key] = { ...entry, syncedAt: new Date().toISOString(), sySnap, fsSnap };
    });
}

export interface RemindRow {
    id: string;
    at: string;
    repeat: string | null;
    end: string | null;
    content: string;
    type: string;
    markdown: string;
    /** 期② 班表块旗标（SQL LEFT JOIN 列；值通道以 IAL 直读为准——旗标漏行不漏判） */
    sched_origin?: string | null;
}

/** schedule_set 等写入方的直喂行：块刚落盘，attributes 表索引窗（3~10s）内 SQL 发现面查不到
 *  新块——行直喂绕窗（值通道下游仍有 IAL 直读复核，这里只补「行发现面」的漏行）。
 *  无 start 的托盘条目/非块 id 键不映射（无 remind-at 天然不进提醒链）。 */
export function schedItemsToRemindHintRows(items: { key: string; summary: string; date: string; start: string | null; end: string | null; origin?: string }[]): RemindRow[] {
    return items
        .filter((i) => i.start && /^\d{14}-[a-z0-9]+$/.test(i.key))
        .map((i) => ({
            id: i.key,
            at: `${i.date}T${i.start}`,
            repeat: null,
            end: i.end ? `${i.date}T${i.end}` : null,
            content: i.summary,
            type: "i",
            markdown: i.summary,
            sched_origin: i.origin ?? null,
        }));
}

/** 行合并：hint 行按 id 覆盖 SQL 行（写入方的新鲜行优先；值通道下游 IAL 直读再核真值） */
export function mergeRemindRows(sqlRows: RemindRow[], hintRows: RemindRow[]): RemindRow[] {
    const byId = new Map(sqlRows.map((r) => [r.id, r]));
    for (const h of hintRows) byId.set(h.id, h);
    return [...byId.values()];
}

/** writeback 单键（□16 扩 end）：反解事件起止为墙上时间，任一侧变化才写属性+广播；否则只 ack
 *  飞书现状快照收敛。end 回写语义=「有效时长」对齐——飞书侧 end 拖回默认（at+30min）时清空
 *  end 属性（默认态不落值），拖成真实结束则写值。at/end=IAL 直读的思源现值（非 SQL 陈旧值） */
async function writebackRemindTime(
    row: { id: string; content: string; at: string; repeat: string | null; end: string | null },
    ev: any, fsSig: string, sySig: string, cfg: { reminderMinutes: number }, logger: RemindLogger,
): Promise<boolean> {
    const key = remindKey(row.id);
    const at2 = timestampToWallTime(ev?.start_time?.timestamp);
    const end2 = timestampToWallTime(ev?.end_time?.timestamp);
    // 现值的有效 end（无属性=默认 at+30min）与新观测对齐比较：都默认=零变化 ack
    const atD = at2 ? new Date(at2) : null;
    const defaultEnd = atD ? new Date(atD.getTime() + REMIND_EVENT_DURATION_MIN * 60_000) : null;
    const end2IsDefault = Boolean(end2 && defaultEnd && Math.abs(new Date(end2).getTime() - defaultEnd.getTime()) < 60_000);
    const effEndNow = row.end || (defaultEnd ? wallFormat(defaultEnd) : null);
    const endChanged = end2 && effEndNow && end2 !== effEndNow && !end2IsDefault;
    const endCleared = end2IsDefault && Boolean(row.end);
    if ((!at2 || at2 === row.at) && !endChanged && !endCleared) {
        // 时间没变（用户只改了标题/循环/或 end 拖动幅度 <1min）或反解失败：不动思源，ack 快照防每轮重判
        await refreshLedgerSnaps(key, sySig, fsSig);
        return false;
    }
    const nextEnd = endCleared ? "" : (endChanged ? end2 : row.end ?? "");
    await setBlockAttrs(row.id, {
        ...(at2 && at2 !== row.at ? { [ATTR_REMIND_AT]: at2 } : {}),
        [ATTR_REMIND_END]: nextEnd,
    });
    await broadcastRemindWritten(row.id, at2 && at2 !== row.at ? at2 : row.at, row.repeat, nextEnd || null);
    // 思源侧新期望态=以新 at/end 重建的载荷；过期单次 payload=null=交给剪枝删事件（单次过期语义不因回写破例）
    const payload2 = buildRemindEventPayload(
        { blockId: row.id, content: row.content, remindAt: at2 && at2 !== row.at ? at2 : row.at, repeat: row.repeat, remindEnd: nextEnd || null },
        { reminderMinutes: cfg.reminderMinutes },
    );
    if (payload2) await refreshLedgerSnaps(key, payloadSig(payload2), fsSig);
    logger.info(`[remind] ${row.id} 飞书改时间→回写 at=${at2 ?? row.at} end=${nextEnd || "（默认）"}`);
    return true;
}

/** Date → YYYY-MM-DDTHH:mm 墙上时间串（与 timestampToWallTime 同形态，本地时区） */
function wallFormat(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function runRemindSync(logger: RemindLogger, now: Date = new Date(), hintRows: RemindRow[] = []): Promise<RemindSyncResult> {
    const day = getLogicalDay(now);
    logger.info(`[remind] ${day} 开始`);
    const cfg = await loadConfig();
    const ledger = await loadLedger();
    if (!cfg || !cfg.enabled || !ledger.sources.remind.enabled) {
        const skipReason: CalendarSkipReason = !cfg ? "not_configured" : !cfg.enabled ? "disabled" : "source_disabled";
        const why = !cfg ? "日历未配置" : !cfg.enabled ? "日历已停用" : "提醒源已停用（pause：事件留飞书侧不动）";
        logger.info(`[remind] ${day} 跳过（${why}）`);
        await settleCalendarStatus({ now, skipped: skipReason });
        return { skipped: true, day, created: 0, updated: 0, deleted: 0, unchanged: 0, writtenBack: 0, conflicts: 0, invalid: [] };
    }
    const allowWriteback = ledger.sources.remind.allowWriteback;

    const sqlRows = await sql<RemindRow>(listRemindBlocksSql());
    const rows = mergeRemindRows(sqlRows, hintRows);
    logger.info(`[remind] ${day} 扫描到 ${rows.length} 条${hintRows.length ? `（含写入方直喂 ${hintRows.length} 行——attributes 索引窗绕行）` : ""}`);
    const liveKeys = new Set<string>();
    let created = 0, updated = 0, unchanged = 0, writtenBack = 0, conflicts = 0;
    let authErrorCode: number | undefined;
    const invalid: { id: string; at: string; repeat?: string; end?: string }[] = [];
    for (const row of rows) {
        // 值通道走 IAL 直读（SQL 陈旧窗家族⑦）：三态比较的「思源侧现值」禁用 SQL 值——否则
        // 写后紧接的同步轮（面板保存/回写广播触发）读到旧值→把刚写入的时间当「思源变」推回旧值
        // （09-14 e2e 实锤：回写 11:30→广播→补发轮读旧 09:00→PATCH 回 09:00 一拍振荡）
        let at = row.at;
        let repeat = row.repeat;
        let end = row.end;
        let fresh: Record<string, string> | null = null;
        try {
            fresh = await getBlockAttrs(row.id);
            at = fresh?.[ATTR_REMIND_AT] ?? "";
            repeat = fresh?.[ATTR_REMIND_REPEAT] ?? "";
            end = fresh?.[ATTR_REMIND_END] ?? "";
        } catch {
            // IAL 直读失败退 SQL 值（保守：下轮自愈）
        }
        if (!at) continue; // 属性已清（SQL 行陈旧）——不进 live，剪枝侧 IAL 复核兜
        // 班表块（custom-sched-origin）期 4 起归本链管辖（sched 镜像链退役）——原过渡闸已回收，
        // 值仅喂防倒灌闸：过去的班表块不新建事件（对齐原 sched 镜像「过去不补建」，防退役切换
        // 时历史日记班表块倒灌日历）。判据以 IAL 直读为准（SQL 旗标列有索引窗闪回，漏行不漏判）
        const schedOrigin = fresh ? fresh[ATTR_SCHED_ORIGIN] : row.sched_origin;
        if (pastBoardSkip(schedOrigin, at, day)) {
            // 过去班表块整行冻结（新建/更新都不走——日历历史语义）；liveKeys 照进防剪枝
            // 误删既有事件。思源侧再改过去块时刻/标题不会推（要改历史请重建条目）。
            liveKeys.add(remindKey(row.id));
            continue;
        }
        if (!parseRemindAt(at) || (repeat && !parseRemindRepeat(repeat)) || !remindEndValid(end, at)) {
            invalid.push({ id: row.id, at, ...(repeat ? { repeat } : {}), ...(end ? { end } : {}) });
            continue;
        }
        // 任务完成即静默：不进 liveKeys → 旧事件被剪枝删（取消勾选下次同步自动重建）
        if (DONE_RE.test(row.markdown ?? "")) continue;
        // tb2 H1 草稿闸：空内容块（日历轴右键建的空段落）不推——写上内容下轮 create；
        // 已有事件的内容被清空=不进 liveKeys → 剪枝删（对齐 schedSyncPlan「草稿化同消亡」
        // 语义；NO_CONTENT 兜底标题只服务存量孤儿块，新草稿不入场）
        if (!stripTaskMark(row.content ?? "").replace(/\u200b/g, "").trim()) continue;
        const payload = buildRemindEventPayload(
            { blockId: row.id, content: row.content, remindAt: at, repeat, remindEnd: end || null },
            { reminderMinutes: cfg.reminderMinutes },
        );
        if (!payload) continue; // 脏值兜底（过期单次□3 起照建=日历历史，不再走删）
        const key = remindKey(row.id);
        liveKeys.add(key);
        const entry = ledger.entries[key];
        try {
            if (!entry) {
                // 退役切换防御（review P2-2 记档）：若该块在退役前已被 sched: 镜像推过事件（化石键），
                // 此处 create 会与化石并存一条——存量≈0（bear 未真实使用）+防倒灌闸兜历史块，
                // 不做 eventId 反查去重；真出现重复=手动删一条即净。
                await createLedgerEvent(key, payload, cfg);
                created++;
                continue;
            }
            let ref: { gone: boolean; event?: any };
            try {
                ref = await getEvent(cfg, entry.calendarId ?? cfg.calendarId, entry.eventId);
            } catch (e) {
                // 授权类错（token 坏）直推必败还多打一次 API——认领后跳过该行等重授权
                const ac = authCodeOf(e);
                if (ac !== undefined) {
                    authErrorCode ??= ac;
                    continue;
                }
                // GET 失败（网络/权限漂移）≠事件不在——退回 □1 无脑直推（PATCH 自愈路径）
                logger.error(`[remind] ${row.id} GET 事件失败退回直推: ${errText(e)}`);
                const r = await upsertEventByKey(key, payload, cfg);
                if (r.action === "create") created++;
                else if (r.action === "update") updated++;
                continue;
            }
            const sySig = payloadSig(payload);
            const fsSig = ref.gone ? null : eventSig(ref.event);
            switch (decideLedgerAction({ sySig, fsSig, sySnap: entry.sySnap, fsSnap: entry.fsSnap, expectedReminders: remindersKey(payload.reminders), remindersAt: entry.remindersAt, allowWriteback })) {
                case "none":
                    unchanged++;
                    break;
                case "push":
                    await patchLedgerEvent(key, payload, cfg);
                    updated++;
                    break;
                case "conflict":
                    await patchLedgerEvent(key, payload, cfg, { countConflict: true });
                    conflicts++;
                    updated++;
                    logger.info(`[remind] ${row.id} 双变冲突→思源赢（累计 ${((entry.conflicts ?? 0) + 1)} 次）`);
                    break;
                case "writeback":
                    if (await writebackRemindTime({ id: row.id, content: row.content, at, repeat, end: end || null }, ref.event, fsSig!, sySig, cfg, logger)) writtenBack++;
                    break;
                case "recreate":
                    await deleteLedgerEvent(key, cfg);
                    await createLedgerEvent(key, payload, cfg);
                    created++;
                    break;
            }
        } catch (e) {
            const ac = authCodeOf(e);
            if (ac !== undefined) authErrorCode ??= ac;
            logger.error(`[remind] ${row.id} 同步失败跳过: ${errText(e)}`);
        }
    }

    // 剪枝（账本条目版；deleteLedgerEvent 严格语义=失败条目保留下轮重试，防「事件还在+条目没了→下轮复制」）。
    // ⚠剪枝复核：attributes SQL 立读窗口会闪回旧值/瞬时漏行（09-14 e2e 实锤）——删是破坏性动作，
    // 逐键 getBlockAttrs 直读（IAL 恒新鲜）复核存活性，假死键救回等下轮；真死键（属性清/过期/任务勾选）照删
    const fresh = await loadLedger();
    const { dropEvent } = pruneRemindEntries(fresh.entries, liveKeys);
    logger.info(`[remind] ${day} 剪枝候选 ${dropEvent.length}`);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    let rescued = 0;
    const verifiedDrop: string[] = [];
    for (const key of dropEvent) {
        const blockId = key.slice("remind:".length);
        let attrs: Record<string, string> | null = null;
        try {
            attrs = await getBlockAttrs(blockId);
        } catch {
            attrs = null; // 直读失败按死处理（保守剪，下轮若活着自愈重建）
        }
        const at = attrs?.[ATTR_REMIND_AT] ?? "";
        const repeat = attrs?.[ATTR_REMIND_REPEAT] ?? "";
        const end = attrs?.[ATTR_REMIND_END] ?? "";
        const row = rowById.get(blockId);
        const alive = parseRemindAt(at) !== null
            && (!repeat || parseRemindRepeat(repeat) !== null)
            && remindEndValid(end, at)
            && !DONE_RE.test(row?.markdown ?? "")
            // tb2 H1 草稿闸同构：row 在场且内容空=草稿化（事件该撤）；row 缺席=SQL 闪回
            // 漏行——复核本意是不误杀，保持救回等下轮
            && (row === undefined || Boolean(stripTaskMark(row.content ?? "").replace(/\u200b/g, "").trim()))
            && buildRemindEventPayload(
                { blockId, content: row?.content ?? "", remindAt: at, repeat, remindEnd: end || null },
                { reminderMinutes: cfg.reminderMinutes },
            ) !== null;
        if (alive) rescued++;
        else verifiedDrop.push(key);
    }
    if (rescued) logger.info(`[remind] ${day} 剪枝复核救回 ${rescued} 键（SQL 闪回旧值/漏行）`);
    let deleted = 0;
    for (const key of verifiedDrop) {
        try {
            await deleteLedgerEvent(key, cfg);
            deleted++;
        } catch (e) {
            const ac = authCodeOf(e);
            if (ac !== undefined) authErrorCode ??= ac;
            logger.error(`[remind] 清失效事件失败 ${key}: ${errText(e)}`);
        }
    }
    logger.info(`[remind] ${day} 完成: 建${created} 改${updated} 删${deleted} 无变化${unchanged} 回写${writtenBack}`
        + (conflicts ? ` 冲突${conflicts}` : "")
        + (invalid.length ? `，脏值${invalid.length}` : "")
        + (authErrorCode ? `，授权失效(${authErrorCode})` : ""));
    await settleCalendarStatus({ now, summary: summaryFromResult({ created, updated, deleted, unchanged, writtenBack, conflicts, invalid }), authErrorCode });
    return { skipped: false, day, created, updated, deleted, unchanged, writtenBack, conflicts, invalid, ...(authErrorCode !== undefined ? { authErrorCode } : {}) };
}

// ── 串行守卫：rpc remind-sync 与 onrunning 同刻触发 / 用户连续保存面板 → 合并补跑，不并发双跑 ──

let inFlight = false;
let inFlightSince = 0;
let pending = false;
/** goja 无 setTimeout、client.fetch 无超时——飞书/proxy 层 hang 会永久挂起 in-flight 轮
 *  （09-13 e2e 实锤：rpc 恒 null 无完成行）。超阈值判死锁强制放行：旧轮若最终返回，
 *  幂等 upsert 语义下与新轮并发无数据风险 */
const INFLIGHT_DEADLOCK_MS = 10 * 60_000;

/** in-flight 期再触发→并入「结束后补跑一轮」，调用方立即收到 null（无需等待） */
export async function runRemindSyncGuarded(logger: RemindLogger, now: Date = new Date(), hintRows: RemindRow[] = []): Promise<RemindSyncResult | null> {
    if (inFlight && Date.now() - inFlightSince < INFLIGHT_DEADLOCK_MS) {
        pending = true;
        return null;
    }
    inFlight = true;
    inFlightSince = Date.now();
    try {
        let last: RemindSyncResult | null = null;
        do {
            pending = false;
            last = await runRemindSync(logger, now, hintRows);
        } while (pending);
        return last;
    } catch (e) {
        // 顶层异常（配置损坏/存储炸）也留状态——面板显示「同步失败」而非停在旧态装健康
        await settleCalendarStatus({ now, error: errText(e) });
        throw e;
    } finally {
        inFlight = false;
    }
}
