// 班表镜像·编排层（timeblock 期 4 sched 双源退役后瘦身）。
// 退役面：sched→飞书镜像链（runSchedMirrorSync/schedSyncPlan）、飞书侧改动回写班表
// （runSchedWriteback/schedWritebackPlan）、回流信号（fetchSchedDrift）、手动 adopt
// （adoptForeignEventRpc——「存入班表」钮期 2 ③ 已退役）、删痕档、后端切换落地
// （applySchedMirrorConf）。班表块的飞书事件=remind 链推（remind: 键，kernel/remind.ts）。
// 存活面：全映射自动 adopt（autoAdoptSweepRpc——账本绑定 adopt: 键+timed 行 remind: 轨
// 预填签名防重复 create）、plan_context 外来占用（fetchForeignEvents）、删外来事件
// （deleteForeignEventRpc）、adopt 回执（recentSchedReceipts——交接会开场包）。
import { petalGetJsonFresh } from "./api";
import { kernelLog } from "./loki";
import { CALENDAR_MIRROR_FILE, SCHED_MIRROR_CONF_FILE } from "../shared/channels";
import { schedBoardReadRpc, writeSchedBoardToDiary } from "./schedboard";
import { adoptBindKey, filterDuplicateAdopts, foreignDeletePlan, foreignEventsForDay, planAutoAdopt, type ForeignEventRow, type SchedReceipt } from "./core/schedMirror";
import { remindersKey, type LedgerEntry } from "./core/ledger";
import { callFeishu, EVENT_GONE_CODES, FeishuApiError, loadConfig, loadLedger, mutateLedgerKeys } from "./feishu";
import { lastMirrorSuccessAt, runMirrorPollGuarded } from "./calendarMirror";
import { normalizeMirror } from "./core/calendarMirror";
import { remindKey } from "./core/remind";
import { dualReminders } from "./core/feishu";
import { mergeBoardDayRows } from "./core/schedule";

export interface SchedMirrorLogger {
    info: (msg: string, ...rest: unknown[]) => unknown;
    error: (msg: string, ...rest: unknown[]) => unknown;
}

/** 无 siyuan.logger 语境（MCP 工具 handler 内搭车）的打点通道 */
export function lokiSchedLogger(): SchedMirrorLogger {
    return {
        info: (m) => kernelLog("schedmirror", String(m)),
        error: (m) => kernelLog("schedmirror", `!! ${String(m)}`),
    };
}

// ── adopt 回执（交接会开场包「已自动同步」段数据源；内存档——kernel 重启即清=当日证据非账本） ──

/** 近期回执（内存档；SchedReceipt 形态在 core/schedMirror——handoffSeed 模板共用） */
export interface TimedSchedReceipt extends SchedReceipt {
    /** epoch ms */
    at: number;
}

const schedReceipts: TimedSchedReceipt[] = [];
const RECEIPT_MAX = 100;

function pushSchedReceipt(r: Omit<TimedSchedReceipt, "at">): void {
    schedReceipts.push({ ...r, at: Date.now() });
    if (schedReceipts.length > RECEIPT_MAX) schedReceipts.splice(0, schedReceipts.length - RECEIPT_MAX);
}

/** 近 24h 回执（routine.handoff/前端交接会对话框共用；重启清空=当日该段缺席不虚报） */
export function recentSchedReceipts(withinMs: number = 24 * 3600_000): TimedSchedReceipt[] {
    const cut = Date.now() - withinMs;
    return schedReceipts.filter((r) => r.at >= cut);
}

/** 自动存入开关读（真值=sched-mirror-conf.autoAdopt，缺省=开；文件名沿用旧档不迁移） */
export async function readSchedAutoAdoptEnabled(): Promise<boolean> {
    const conf = await petalGetJsonFresh<{ autoAdopt?: unknown }>(SCHED_MIRROR_CONF_FILE);
    return conf?.autoAdopt === undefined ? true : Boolean(conf.autoAdopt);
}

// ── □26 plan_context：目标日外来日历占用（镜像档读=错峰原料，零网络——镜像轮询已备好） ──

export interface ForeignEventsView {
    /** false=镜像不可用（从未轮询）——payload 呈现缺席说明即可 */
    ok: boolean;
    rows: ForeignEventRow[];
    /** 最近一次成功镜像轮询时刻 ISO（新鲜度；null=本会话未轮询过） */
    mirrorAt: string | null;
}

/** 我方事件 id 集（foreignEventsForDay 剔除用）：班表块 remind: 键（期 4 起班表走 remind 轨——
 *  当日班表块 id 反查 remind:<id> 命中即我方）∪ 旧 sched: 化石条目（退役前推过的，仍需剔）
 *  ∪ ammo-live: 实况回填事件（□7——自家推的实况段是己方投影，plan_context 不算外来占用）。
 *  task:/burden:/普通 remind: 提醒轨保留=真实占用（原语义不变）。 */
async function oursEventIds(ledger: { entries: Record<string, LedgerEntry> }, day: string): Promise<Set<string>> {
    const ours = new Set<string>();
    for (const [k, e] of Object.entries(ledger.entries)) {
        if ((k.startsWith("sched:") || k.startsWith("ammo-live:")) && e.eventId) ours.add(e.eventId);
    }
    try {
        const r = await schedBoardReadRpc({ day });
        if (r.ok && Array.isArray(r.items)) {
            for (const it of r.items) {
                const e = ledger.entries[remindKey(it.key)];
                if (e?.eventId) ours.add(e.eventId);
            }
        }
    } catch {
        // 块读失败=当日班表事件不剔（保守多显示一行，plan_context 错峰安全侧）
    }
    return ours;
}

export async function fetchForeignEvents(day: string): Promise<ForeignEventsView> {
    const ledger = await loadLedger();
    const mirror = normalizeMirror(await petalGetJsonFresh<any>(CALENDAR_MIRROR_FILE).catch(() => null));
    const at = lastMirrorSuccessAt();
    return {
        ok: mirror != null && at != null,
        rows: mirror ? foreignEventsForDay(mirror, await oursEventIds(ledger, day), day) : [],
        mirrorAt: at != null ? new Date(at).toISOString() : null,
    };
}

// ── 期 2 ⑤ 删外来事件（右键三动作·删除） ──

export interface ForeignDeleteResult {
    ok: boolean;
    error?: string;
}

/** 删飞书事件（无块虚显条目的删除通道；bear 二轮拍板）：镜像定位真实历 id → DELETE 事件 →
 *  清账本孤儿绑定 → 立即跑一轮镜像轮询（镜像档更新→广播回前端刷新，虚显行消失无延迟）。
 *  订阅日历/无写权限=飞书 API 报错原样透传（bear 反馈④「订阅删不动」的可见出口）。
 *  事件已不在（EVENT_GONE 五码族）=目标态达成照走清账本。 */
export async function deleteForeignEventRpc(eventId: string, logger: SchedMirrorLogger): Promise<ForeignDeleteResult> {
    let cfg;
    try {
        cfg = await loadConfig();
    } catch (e: any) {
        return { ok: false, error: `飞书配置损坏（${String(e?.message ?? e).slice(0, 80)}）` };
    }
    if (!cfg || !cfg.enabled) return { ok: false, error: !cfg ? "飞书未配置" : "飞书同步已停用" };
    if (cfg.channel !== "oauth") return { ok: false, error: "仅 oauth 主日历通道可删（bot 共享日历不动他人事件）" };
    const mirror = normalizeMirror(await petalGetJsonFresh<any>(CALENDAR_MIRROR_FILE));
    if (!mirror) return { ok: false, error: "镜像档缺失/从未轮询（稍后再试）" };
    const plan = foreignDeletePlan(mirror, await loadLedger(), eventId);
    if (!plan) return { ok: false, error: "镜像中无此事件（可能已被删除，点刷新重拉）" };
    try {
        await callFeishu(cfg, "DELETE", `/calendar/v4/calendars/${plan.calendarId}/events/${eventId}`);
    } catch (e: any) {
        if (e instanceof FeishuApiError && EVENT_GONE_CODES.has(e.code)) {
            // 事件已不在=目标态已达成——照走清账本
        } else {
            return { ok: false, error: String(e?.message ?? e) };
        }
    }
    if (plan.boundKeys.length) {
        try {
            // □6a：键级写（进账本写队列）——旧整文件 save 并发下覆盖他链键
            await mutateLedgerKeys((entries) => {
                for (const k of plan.boundKeys) delete entries[k];
            });
        } catch (e: any) {
            logger.error(`[schedmirror] 删事件后清账本失败（下轮自愈）: ${String(e?.message ?? e).slice(0, 120)}`);
        }
    }
    logger.info(`[schedmirror] 删外来事件 ${eventId}（cal=${plan.calendarId}，清账本绑定 ${plan.boundKeys.length} 键）`);
    // 立即镜像轮询：镜像档更新→广播回前端（虚显行消失）
    try {
        await runMirrorPollGuarded(logger as any);
    } catch (e: any) {
        logger.error(`[schedmirror] 删事件后镜像轮询失败（下轮 poll 自愈）: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    return { ok: true };
}

// ── 期 2 ③ 全映射自动 adopt：镜像扫描→批量落块（bear 拍板「全映射零特例」） ──

export interface AutoAdoptSweepResult {
    ok: boolean;
    /** 本次落地条数（含全天逐日展开行） */
    adopted: number;
    /** 跳过数（recurring/cross_day/unrepresentable/too_old——回执留痕） */
    skipped: number;
    error?: string;
}

/** 全镜像自动 adopt 一轮（poll 后触发；幂等=账本 adopt:/remind: 任何键 eventId 绑定防重）。
 *  写链（期 4 块化）：逐日落块（块=唯一真身）→账本双键绑定（adopt: 防重+timed 行 remind: 轨
 *  预填签名——remind 主扫首拍三源合一对既有事件零写，不建重复事件）。
 *  零 adopts=零写（poll 未变空转零成本）。账本写失败=日志+回执留痕、行滞留（下轮再 adopt
 *  已被 adopt: 键防重？——绑定没落=防重失败，会重复插块。已知限制保留：手动版深回滚不复制）。 */
export async function autoAdoptSweepRpc(logger: SchedMirrorLogger): Promise<AutoAdoptSweepResult> {
    let cfg;
    try {
        cfg = await loadConfig();
    } catch (e: any) {
        return { ok: false, adopted: 0, skipped: 0, error: `飞书配置损坏（${String(e?.message ?? e).slice(0, 80)}）` };
    }
    if (!cfg || !cfg.enabled) return { ok: false, adopted: 0, skipped: 0, error: !cfg ? "飞书未配置" : "飞书同步已停用" };
    if (cfg.channel !== "oauth") return { ok: true, adopted: 0, skipped: 0 };
    if (!(await readSchedAutoAdoptEnabled())) return { ok: true, adopted: 0, skipped: 0 };
    const mirror = normalizeMirror(await petalGetJsonFresh<any>(CALENDAR_MIRROR_FILE));
    if (!mirror) return { ok: true, adopted: 0, skipped: 0 };
    const ledger = await loadLedger();

    const now = new Date();
    const plan = planAutoAdopt(mirror, ledger, now);
    if (plan.skips.length) {
        await logger.info(`[schedadopt] 自动存入跳过 ${plan.skips.length} 条：${plan.skips.slice(0, 8).map((s) => `${s.summary || "?"}(${s.reason})`).join("、")}${plan.skips.length > 8 ? "…" : ""}`);
    }
    if (!plan.adopts.length) return { ok: true, adopted: 0, skipped: plan.skips.length };

    // 按日分组落块（块=唯一真身；item.key=临时键，keyRemap 迁成块 id 后组绑定）
    const byDay = new Map<string, typeof plan.adopts>();
    for (const a of plan.adopts) {
        const arr = byDay.get(a.item.date) ?? [];
        arr.push(a);
        byDay.set(a.item.date, arr);
    }
    const bindings: Array<{ key: string; entry: LedgerEntry }> = [];
    let adopted = 0;
    let dupSkipped = 0;
    for (const [day, dayAdopts] of byDay) {
        try {
            // P0-1 基底纪律：先读当日块行再 merge 组终态——writeSchedBoardToDiary 是当日全量
            // diff 替换，只喂 adopt 行会把该日既有班表块（AI 排的计划/用户手加行）整日清空。
            // 读失败=该日跳过（勿以空基底落块），下轮 poll 重试。
            const readR = await schedBoardReadRpc({ day });
            if (!readR.ok || !Array.isArray(readR.items)) {
                await logger.error(`[schedadopt] ${day} 当日块读失败（该日 ${dayAdopts.length} 条不落地，下轮重试）`);
                continue;
            }
            // □6a 内容级防重（兜底）：当日已有同 summary+同形态行→该事件不追加块（bear 原话
            // 「每次只改同一个的，而不是每次追加一个」）。账本串行化后绑定不再丢，本闸=绑定
            // 丢失期的重复堆积兜底（旧存量形态：09-19 日记 22 条同文案天气块）
            const { kept: freshAdopts, dups } = filterDuplicateAdopts(readR.items, dayAdopts);
            if (dups.length) {
                dupSkipped += dups.length;
                await logger.info(`[schedadopt] ${day} 跳过 ${dups.length} 条内容重复（当日已有同摘要行，不追加）`);
            }
            if (!freshAdopts.length) continue;
            const target = mergeBoardDayRows(day, readR.items, freshAdopts.map((a) => a.item)).target;
            const res = await writeSchedBoardToDiary(day, target);
            if (!res.ok) {
                await logger.error(`[schedadopt] ${day} 块侧跳过（该日 ${freshAdopts.length} 条不落地，下轮重试）：${res.error ?? "unknown"}`);
                continue;
            }
            for (const a of freshAdopts) {
                const blockId = res.keyRemap.get(a.item.key) ?? a.item.key;
                bindings.push({ key: adoptBindKey(blockId), entry: a.bindEntry });
                if (a.remindKey && a.remindEntry) {
                    // P1-2：remindersAt 预填（decideLedgerAction 对缺省判漂移→首拍 PATCH 覆写
                    // 外来事件的提醒/描述；预填=首拍「无变化」零写，用户在飞书建的形态原样保留）
                    bindings.push({ key: remindKey(blockId), entry: { ...a.remindEntry, remindersAt: remindersKey(dualReminders(cfg.reminderMinutes)) } });
                }
                adopted++;
            }
        } catch (e: any) {
            await logger.error(`[schedadopt] ${day} 落块异常（该日跳过）：${String(e?.message ?? e).slice(0, 120)}`);
        }
    }
    if (!adopted) return { ok: true, adopted: 0, skipped: plan.skips.length + dupSkipped };
    try {
        // □6a：键级写（进账本写队列）——旧「load→写 bindings→save 整文件」并发下被 remind/
        // weather 链旧快照覆盖=adopt:/remind: 绑定反复丢失→每轮 sweep 重落块（09-19 实锤）
        await mutateLedgerKeys((entries) => {
            for (const b of bindings) entries[b.key] = b.entry;
        });
    } catch (e: any) {
        // 账本失败=行滞留块上无绑定：下轮再 adopt 会重复插块（可见可删）。不深回滚（批量自动路径）。
        await logger.error(`[schedadopt] 账本批量绑定失败（${bindings.length} 条已落块未绑定，下轮可能重复落块）: ${String(e?.message ?? e).slice(0, 120)}`);
        pushSchedReceipt({ summary: "飞书自动存入", kind: "edited", detail: `账本写入失败（${bindings.length} 条已进班表但未绑定，若出现重复条目请手动删除）` });
        return { ok: true, adopted, skipped: plan.skips.length + dupSkipped };
    }
    kernelLog("schedadopt", `自动存入 ${adopted} 条（skip ${plan.skips.length + dupSkipped}）`);
    pushSchedReceipt({ summary: "飞书自动存入", kind: "edited", detail: `新事件落地 ${adopted} 条` });
    return { ok: true, adopted, skipped: plan.skips.length + dupSkipped };
}
