// □3 任务截止·回写扫描：账本 task: 条目 → GET 观测 → 三态裁决（与 runRemindSync 同引擎）。
// 只飞书变（用户在飞书拖了日程时间）→回写 custom-task-due-date/time；双变→思源赢+冲突计数。
// onrunning 启动跑一轮（用户「在飞书改时间」的可见延迟=到下次思源启动——单向场景 task.* 工具
// 已即时推，回写侧无事件驱动通道，飞书不推 webhook 给插件，启动扫描是 v1 的最佳通道）。
// 任务侧删除/过期语义不在此管（syncTask/stale 报告域）；块缺失/已完/无 due →跳过不摘钩。
import { setBlockAttrs, sql } from "./api";
import { buildEventPayload, isIntervalTask, type SyncTaskInput } from "./core/feishu";
import { remindersKey, decideLedgerAction, eventSig, payloadSig, timestampToDue } from "./core/ledger";
import { createLedgerEvent, deleteLedgerEvent, getEvent, loadConfig, loadLedger, mutateLedgerKeys, patchLedgerEvent } from "./feishu";

export interface WritebackLogger {
    info: (msg: string, ...rest: unknown[]) => unknown;
    error: (msg: string, ...rest: unknown[]) => unknown;
}

export interface TaskWritebackResult {
    skipped: boolean;
    scanned: number;
    /** 飞书改时间→回写思源属性条数 */
    writtenBack: number;
    /** 只思源变补推 / 双变思源赢 */
    pushed: number;
    conflicts: number;
    unchanged: number;
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 全部 task: 条目对应的任务行（属性 GROUP_CONCAT 同 calendar.sync 单查形态，一次 IN 批查）。
 *  □16 起 start_date/start_time 一并取——区间任务（start+due 齐）的期望态 payload 必须带 start，
 *  否则每轮扫描都会把「飞书区间事件」误判为漂移（期望=锚点+30min）回写推平 */
async function taskRowsFor(ids: string[]): Promise<Map<string, any>> {
    if (!ids.length) return new Map();
    const rows = await sql<any>(
        `SELECT b.id, TRIM(b.content) AS content, b.markdown, b.updated, b.root_id,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-date' THEN a.value END) AS due_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-time' THEN a.value END) AS due_time,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-date' THEN a.value END) AS start_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-time' THEN a.value END) AS start_time
        FROM blocks b
        LEFT JOIN attributes a ON a.block_id=b.id AND a.name IN ('custom-task-due-date','custom-task-due-time','custom-task-start-date','custom-task-start-time')
        WHERE b.id IN (${ids.map((id) => `'${id}'`).join(",")}) GROUP BY b.id`,
    );
    return new Map(rows.map((r) => [r.id, r]));
}

function isDoneRow(r: any): boolean {
    return /^\s*[-*+] \[[xX]\]/.test(r?.markdown ?? "");
}

export async function runTaskWriteback(logger: WritebackLogger): Promise<TaskWritebackResult> {
    const cfg = await loadConfig();
    const ledger = await loadLedger();
    if (!cfg || !cfg.enabled || !ledger.sources.task.enabled || !ledger.sources.task.allowWriteback) {
        return { skipped: true, scanned: 0, writtenBack: 0, pushed: 0, conflicts: 0, unchanged: 0 };
    }
    const taskIds = Object.keys(ledger.entries)
        .filter((k) => k.startsWith("task:"))
        .map((k) => k.slice("task:".length));
    if (!taskIds.length) return { skipped: false, scanned: 0, writtenBack: 0, pushed: 0, conflicts: 0, unchanged: 0 };

    const rows = await taskRowsFor(taskIds);
    let writtenBack = 0, pushed = 0, conflicts = 0, unchanged = 0, scanned = 0;
    for (const blockId of taskIds) {
        const row = rows.get(blockId);
        // 块没了/已完/无 due：删除语义归 syncTask/日历 sync stale 报告域，这里只跳过
        if (!row || isDoneRow(row) || !row.due_date) continue;
        const task: SyncTaskInput = {
            blockId,
            content: row.content,
            dueDate: row.due_date,
            dueTime: row.due_time ?? undefined,
            ...(row.start_date ? { startDate: row.start_date } : {}),
            ...(row.start_time ? { startTime: row.start_time } : {}),
        };
        const payload = buildEventPayload(task, { reminderMinutes: cfg.reminderMinutes });
        if (!payload) continue;
        const key = `task:${blockId}`;
        const entry = ledger.entries[key];
        scanned++;
        try {
            let ref: { gone: boolean; event?: any };
            try {
                ref = await getEvent(cfg, entry.calendarId ?? cfg.calendarId, entry.eventId);
            } catch (e) {
                logger.error(`[writeback] ${blockId} GET 事件失败跳过: ${errText(e)}`);
                continue; // 网络/权限≠不在；不动，下轮再判
            }
            const sySig = payloadSig(payload);
            const fsSig = ref.gone ? null : eventSig(ref.event);
            switch (decideLedgerAction({ sySig, fsSig, sySnap: entry.sySnap, fsSnap: entry.fsSnap, expectedReminders: remindersKey(payload.reminders), remindersAt: entry.remindersAt, allowWriteback: true })) {
                case "none":
                    unchanged++;
                    break;
                case "push":
                    await patchLedgerEvent(key, payload, cfg);
                    pushed++;
                    break;
                case "conflict":
                    await patchLedgerEvent(key, payload, cfg, { countConflict: true });
                    conflicts++;
                    pushed++;
                    break;
                case "recreate":
                    // 事件被删（删除=重建语义）：任务有 due 属思源侧事实——摘条目重建（193003 容忍内建）
                    await deleteLedgerEvent(key, cfg);
                    await createLedgerEvent(key, payload, cfg);
                    logger.info(`[writeback] ${blockId} 事件被删→重建`);
                    pushed++;
                    break;
                case "writeback": {
                    // 只回写「改时间」：timed→date+time 双写；被改成全天→date 写、time 清。
                    // □16 区间任务（isIntervalTask 与镜像同源口径）：事件 start=任务开始、end=截止——
                    // 回写四属性（拖整段/拖截止都覆盖）。⚠gate 必须与 buildEventPayload 同判：「有 start
                    // 属性但事件非区间」（全天 due/start≥due 脏值）若误入本分支，飞书任一改动都会
                    // 从未编码 start 的事件反解碾掉用户 start 属性且快照收敛无自愈（reasoning P0-1）
                    const st = ref.event?.start_time ?? {};
                    const en = ref.event?.end_time ?? {};
                    if (isIntervalTask(task)) {
                        const s2 = st.timestamp ? timestampToDue(st.timestamp) : (st.date ? { date: st.date, time: "" } : null);
                        const e2 = en.timestamp ? timestampToDue(en.timestamp) : (en.date ? { date: en.date, time: "" } : null);
                        if (!s2 || !e2 || (s2.time && !e2.time)) {
                            // 反解失败（形态漂移）：ack 快照防每轮重判
                            await refreshSnaps(key, sySig, fsSig!);
                            break;
                        }
                        if (s2.date === row.start_date && (s2.time || "") === (row.start_time ?? "")
                            && e2.date === row.due_date && (e2.time || "") === (row.due_time ?? "")) {
                            await refreshSnaps(key, sySig, fsSig!); // 时间没变（仅标题被动）：ack 收敛
                            break;
                        }
                        // 四键恒写（time 空串=删键）：全天回写残留旧时刻会振荡（下次扫描仍判区间任务）
                        await setBlockAttrs(blockId, {
                            "custom-task-start-date": s2.date,
                            "custom-task-start-time": s2.time ?? "",
                            "custom-task-due-date": e2.date,
                            "custom-task-due-time": e2.time ?? "",
                        });
                        writtenBack++;
                        logger.info(`[writeback] ${blockId} 飞书改区间→回写 ${s2.date} ${s2.time || "（全天）"} ~ ${e2.date} ${e2.time || "（全天）"}`);
                        // 无条件覆盖时刻键（"" 等价缺席）：条件展开会残留 ...task 的旧时刻→
                        // 快照=「新日期+旧时刻」缝合态，下轮判 conflict 反推用户编辑（reasoning P1-2）
                        const payload2 = buildEventPayload(
                            { ...task, startDate: s2.date, startTime: s2.time ?? "", dueDate: e2.date, dueTime: e2.time ?? "" },
                            { reminderMinutes: cfg.reminderMinutes },
                        );
                        if (payload2) await refreshSnaps(key, payloadSig(payload2), fsSig!);
                        break;
                    }
                    const due = st.timestamp ? timestampToDue(st.timestamp) : (st.date ? { date: st.date, time: "" } : null);
                    if (!due) {
                        // 反解失败（形态漂移）：ack 快照防每轮重判
                        await refreshSnaps(key, sySig, fsSig!);
                        break;
                    }
                    if (due.date === row.due_date && (due.time || "") === (row.due_time ?? "")) {
                        await refreshSnaps(key, sySig, fsSig!); // 时间没变（仅标题被动）：ack 收敛
                        break;
                    }
                    await setBlockAttrs(blockId, {
                        "custom-task-due-date": due.date,
                        "custom-task-due-time": due.time ?? "",
                    });
                    writtenBack++;
                    logger.info(`[writeback] ${blockId} 飞书改时间→回写 ${due.date} ${due.time || "（全天）"}`);
                    const payload2 = buildEventPayload(
                        { ...task, dueDate: due.date, dueTime: due.time ?? "" },
                        { reminderMinutes: cfg.reminderMinutes },
                    );
                    if (payload2) await refreshSnaps(key, payloadSig(payload2), fsSig!);
                    break;
                }
            }
        } catch (e) {
            logger.error(`[writeback] ${blockId} 处理失败跳过: ${errText(e)}`);
        }
    }
    if (writtenBack || pushed || conflicts) {
        logger.info(`[writeback] 任务扫描 ${scanned}: 回写${writtenBack} 推${pushed}${conflicts ? ` 冲突${conflicts}` : ""} 无变化${unchanged}`);
    }
    return { skipped: false, scanned, writtenBack, pushed, conflicts, unchanged };
}

async function refreshSnaps(key: string, sySnap: string, fsSnap: string): Promise<void> {
    // □6a：键级写（进账本写队列）——旧整文件 save 并发下覆盖他链键
    await mutateLedgerKeys((entries) => {
        const entry = entries[key];
        if (!entry) return;
        entries[key] = { ...entry, syncedAt: new Date().toISOString(), sySnap, fsSnap };
    });
}
