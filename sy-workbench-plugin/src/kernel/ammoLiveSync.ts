// ammo □7：日账实况手动同步编排层（kernel 侧）——「实况回填」推飞书的推送半边。
// 契约=docs/ammo-concept.md「日历双类」：锚点前瞻走 remind 链零改动；实况回填=无提醒纯展示
// 单向投影、用户按钮手动触发（pull 式勿实时推——飞书 L4 频控，手动批量天然低频）。
// 判定半边在 core/ammoLiveSync 纯层（plan/payload）；本文件只做 IO 编排：
//  - 推送=createLedgerEvent/patchLedgerEvent（feishu.ts 账本写队列 enqueueLedgerWrite 全程
//    串行——TOCTOU 收口先例，本链不另造队列）；
//  - 触发面串行单飞链（liveSyncChain——ammoWriteChain 同款模块级单飞；连点按钮=排队合并，
//    plan 幂等下第二跑全 unchanged 零写零网络）；
//  - 同步态读面（ammo-live-state）纯读零写零网络——同步钮颜色标态数据源。
// 完成广播 AMMO_LIVE_SYNCED_CHANNEL（前端转 window「pj-ammo-live-synced」直刷钮态与段徽标）。
// ⚠️全静态导入（CJS 打包图纪律：动态 import 重排打包图=svelte internal 循环崩）。
import { loadConfig, loadLedger, createLedgerEvent, patchLedgerEvent } from "./feishu";
import { readDayLedger, readLedgerDays } from "./ammoLedger";
import { planLiveSync, type LiveSyncPlan } from "./core/ammoLiveSync";
import type { AmmoLedgerEntry } from "./core/ammoLedger";
import { AMMO_LIVE_SYNCED_CHANNEL } from "../shared/channels";
import { kernelLog } from "./loki";
import { isValidDay } from "./core/schedule";

/** 本地日 YYYY-MM-DD（ammoEngine.localDay 同款——rpc 缺省日参用） */
function localDay(now: number): string {
    const d = new Date(now);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 同步钮态读面（纯读零写零网络）：state 四态（off=飞书未配置/停用——灰但 title 区分原因）。
 *  读失败=ok:false+error（前端钮 title 呈现，不误报绿）。 */
export interface AmmoLiveState {
    ok: boolean;
    day: string;
    state: "empty" | "dirty" | "synced" | "off";
    /** 闭合实况段总数 */
    total: number;
    /** 未同步段数（toCreate+toUpdate；dirty 态>0） */
    pending: number;
    /** false=飞书未配置或停用（state=off 的原因面） */
    feishuReady: boolean;
    error?: string;
}

export async function ammoLiveStateRpc(day?: string): Promise<AmmoLiveState> {
    const today = isValidDay(day ?? "") ? day! : localDay(Date.now());
    try {
        const [ledgerRead, ledger, cfg] = await Promise.all([
            readDayLedger(today),
            loadLedger(),
            loadConfig().catch(() => null),
        ]);
        const feishuReady = Boolean(cfg && cfg.enabled);
        if (!ledgerRead.ok) {
            return { ok: false, day: today, state: "empty", total: 0, pending: 0, feishuReady, error: ledgerRead.error };
        }
        const plan = planLiveSync<AmmoLedgerEntry>(ledgerRead.items, today, ledger.entries);
        // 态优先级：dirty 黄 > off 灰——「有未同步实况」是用户关键信息（未配飞书也可见；
        // off 灰只在无待推内容时接管，title 带原因。同步动作本身仍被 kernel 侧配置守卫拒）
        const state = plan.state === "dirty" ? "dirty" : feishuReady ? plan.state : "off";
        return {
            ok: true,
            day: today,
            state,
            total: plan.total,
            pending: plan.toCreate.length + plan.toUpdate.length,
            feishuReady,
        };
    } catch (e: any) {
        return { ok: false, day: today, state: "empty", total: 0, pending: 0, feishuReady: false, error: String(e?.message ?? e) };
    }
}

/** 同步结果面（rpc 返回+广播 payload 同形） */
export interface AmmoLiveSyncResult {
    ok: boolean;
    day: string;
    created: number;
    updated: number;
    /** 本次零写段数（已同步段+脏段跳过） */
    unchanged: number;
    /** 未闭合段跳过数（闭合后下次同步自达——未闭合不进同步平面） */
    skippedUnclosed: number;
    state: "empty" | "dirty" | "synced" | "off";
    error?: string;
}

/** 触发面串行单飞链（ammoWriteChain 同款）：连点按钮排队不并发双跑；失败吞 reject 不堵队列 */
let liveSyncChain: Promise<unknown> = Promise.resolve();
function liveSyncChainRun<T>(task: () => Promise<T>): Promise<T> {
    const run = liveSyncChain.then(task, task);
    liveSyncChain = run.then(() => undefined, () => undefined);
    return run;
}

function broadcastLiveSynced(r: AmmoLiveSyncResult): void {
    try {
        siyuan.rpc.broadcast(AMMO_LIVE_SYNCED_CHANNEL, r);
    } catch {
        // 广播断连无害：前端下次读态面自愈
    }
}

async function ammoLiveSyncInner(day: string): Promise<AmmoLiveSyncResult> {
    const base = { day, created: 0, updated: 0, unchanged: 0, skippedUnclosed: 0, state: "empty" as const };
    let cfg;
    try {
        cfg = await loadConfig();
    } catch (e: any) {
        return { ...base, ok: false, state: "off", error: `飞书配置损坏（${String(e?.message ?? e).slice(0, 80)}）` };
    }
    if (!cfg || !cfg.enabled) return { ...base, ok: false, state: "off", error: !cfg ? "飞书未配置" : "飞书同步已停用" };
    const [ledgerRead, ledger] = await Promise.all([readDayLedger(day), loadLedger()]);
    if (!ledgerRead.ok) return { ...base, ok: false, state: "off", error: `日账读取失败：${ledgerRead.error ?? "?"}` };
    const plan: LiveSyncPlan<AmmoLedgerEntry> = planLiveSync(ledgerRead.items, day, ledger.entries);
    const skippedUnclosed = ledgerRead.items.length - plan.total;
    let created = 0;
    let updated = 0;
    const stateOf = (): AmmoLiveSyncResult["state"] =>
        plan.state === "empty" ? "empty" : plan.toCreate.length + plan.toUpdate.length - (created + updated) > 0 ? "dirty" : "synced";
    const done = (ok: boolean, error?: string): AmmoLiveSyncResult => ({
        ok,
        day,
        created,
        updated,
        unchanged: plan.unchanged,
        skippedUnclosed: Math.max(0, skippedUnclosed),
        state: plan.state === "empty" ? "empty" : stateOf(),
        ...(error ? { error } : {}),
    });
    if (!plan.toCreate.length && !plan.toUpdate.length) {
        const r = done(true);
        broadcastLiveSynced(r);
        return r;
    }
    let firstError: string | undefined;
    // 逐段直推（feishu.ts 账本写队列内建串行；单段失败不炸整轮——下轮同步自愈，
    // state 保持 dirty=黄钮引导再点）
    for (const item of plan.toCreate) {
        try {
            await createLedgerEvent(item.key, item.payload, cfg);
            created++;
        } catch (e: any) {
            firstError ??= String(e?.message ?? e).slice(0, 120);
            kernelLog("ammosync", `!! live create ${item.key}: ${String(e?.message ?? e).slice(0, 120)}`);
        }
    }
    for (const item of plan.toUpdate) {
        try {
            await patchLedgerEvent(item.key, item.payload, cfg);
            updated++;
        } catch (e: any) {
            firstError ??= String(e?.message ?? e).slice(0, 120);
            kernelLog("ammosync", `!! live patch ${item.key}: ${String(e?.message ?? e).slice(0, 120)}`);
        }
    }
    const pushed = created + updated > 0;
    // 有任一段推进=ok（state 反映剩余）；全数失败=ok:false+首错透传（黄钮保留引导再点）
    const r: AmmoLiveSyncResult = { ...done(pushed, pushed ? undefined : firstError) };
    if (pushed) kernelLog("ammosync", `实况同步 ${day}: 建${created} 改${updated} 已同步${plan.unchanged} 未闭合跳过${r.skippedUnclosed}`);
    broadcastLiveSynced(r);
    return r;
}

/** 手动同步入口（用户按钮触发——勿挂自动定时器，L4 频控红线） */
export function ammoLiveSyncRpc(day?: string): Promise<AmmoLiveSyncResult> {
    const today = isValidDay(day ?? "") ? day! : localDay(Date.now());
    return liveSyncChainRun(() => ammoLiveSyncInner(today).catch((e: any) => ({
        ok: false,
        day: today,
        created: 0,
        updated: 0,
        unchanged: 0,
        skippedUnclosed: 0,
        state: "off" as const,
        error: String(e?.message ?? e),
    })));
}

// ── 日账读面 rpc（ammo-ledger-read：单日/日窗两形态——时间线单日、月历 42 格窗） ──

export interface AmmoLedgerReadResult {
    ok: boolean;
    /** 单日形态=该日读面；日窗形态=逐日数组 */
    day?: string;
    days?: Array<{ day: string; ok: boolean; items: AmmoLedgerEntry[]; error?: string }>;
    items: AmmoLedgerEntry[];
    error?: string;
}

export async function ammoLedgerReadRpc(params: { day?: string; days?: string[] } | undefined): Promise<AmmoLedgerReadResult> {
    if (Array.isArray(params?.days) && params.days.length) {
        const days = params.days.filter((d) => isValidDay(d)).slice(0, 62); // 42 格窗+冗余封顶
        if (!days.length) return { ok: false, items: [], error: "days 无合法 YYYY-MM-DD" };
        return { ok: true, days: await readLedgerDays(days), items: [] };
    }
    const today = isValidDay(params?.day ?? "") ? params!.day! : localDay(Date.now());
    const r = await readDayLedger(today);
    return r.ok ? { ok: true, day: today, items: r.items } : { ok: false, items: [], error: r.error };
}
