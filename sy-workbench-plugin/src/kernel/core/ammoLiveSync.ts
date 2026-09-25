// ammo □7：日账实况段→飞书事件的纯函数映射层（手动同步链的判定半边）。
// 契约=docs/ammo-concept.md 五视图「日历双类」+bear 09-20 拍板：实况回填=无提醒纯展示、
// 单向投影（思源→飞书，不做回写）、用户按钮手动触发（pull 式勿实时推——L4 频控）。
// 词表：账本键前缀 ammo-live:<打点块id>（syncedBlockIdsFromLedger 只收 remind:/sched:
// 两前缀——块面徽标不被本链污染；planAutoAdopt 防重收全部 eventId 绑定——实况事件不会被
// 自动 adopt 二次落块；月历/轴 feishu 源的 pluginEventIds 收除 weather: 外全部 eventId——
// 实况事件不双显。三处消费面经账本键自然分流，零改动）。
// 未闭合条目不进同步平面（还没发生完——闭合后下次同步自达）；跨零点段 end=+24h 归一
// （ledgerDurationMin 同口径——账随开始日，事件在飞书侧跨零点属实况本相）。
import type { AmmoLedgerEntry } from "./ammoLedger";
import type { EventPayload } from "./feishu";
import { ledgerDurationMin } from "./ammoLedger";
import { payloadSig } from "./ledger";

/** 账本键前缀（feishu.ts LedgerEntry 通道；entry 形态={eventId, calendarId, sySnap, fsSnap, syncedAt}） */
export function liveLedgerKey(entryId: string): string {
    return `ammo-live:${entryId}`;
}

/** 实况事件 summary 前缀（飞书月历里与锚点事件视觉可分；默认值拍板 □7） */
export const LIVE_SUMMARY_PREFIX = "▶ ";

/** 与 core/feishu TZ_OFFSET 同源（模块私有未导出——思源用户群时区事实，改两处同动） */
const TZ_OFFSET = "+08:00";
const SUMMARY_MAX = 100;

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD HH:mm" 段 epoch 秒（飞书 timestamp 通道与 buildEventPayload 同形） */
function dayHmToTs(day: string, hm: string): number | null {
    if (!DAY_RE.test(day) || !HM_RE.test(hm)) return null;
    const ms = Date.parse(`${day}T${hm}:00${TZ_OFFSET}`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** 闭合实况段→飞书事件载荷（无提醒=reminders 空；recurrence 恒空串=单次）。
 *  未闭合/脏 start/脏 day→null（调用方跳过该段不炸整轮）。跨零点=end 绝对时刻 +24h
 *  （durationMin 归一口径），飞书事件真实跨日。 */
export function buildLiveEventPayload(entry: AmmoLedgerEntry, day: string): EventPayload | null {
    if (!entry.closed || entry.end === null) return null;
    const startTs = dayHmToTs(day, entry.start);
    if (startTs === null) return null;
    const dur = ledgerDurationMin(entry.start, entry.end);
    if (dur === null || dur <= 0) return null;
    const bare = (entry.summary ?? "").trim();
    const text = (LIVE_SUMMARY_PREFIX + bare).slice(0, SUMMARY_MAX) + (LIVE_SUMMARY_PREFIX.length + bare.length > SUMMARY_MAX ? "…" : "");
    return {
        summary: text,
        description: `实况回填（sy-workbench-plugin）\n在思源中打开: siyuan://blocks/${entry.id}`,
        start_time: { timestamp: String(startTs), timezone: "Asia/Shanghai" },
        end_time: { timestamp: String(startTs + dur * 60), timezone: "Asia/Shanghai" },
        reminders: [],
        vchat: { vc_type: "no_meeting" },
        attendee_ability: "can_see_others",
        recurrence: "",
    };
}

/** 账本条目最小视图（feishu.ts LedgerEntry 的签名子集——纯层不 import kernel IO 面） */
export interface LiveLedgerEntryView {
    eventId?: string;
    sySnap?: string;
}

/** 同步计划（单轮推送面）：toCreate/toUpdate 逐段直推；unchanged=零写。判定只比 sySnap
 *  （我方期望态快照——单向投影不比 fsSnap 不回写；飞书侧手改会被下次同步覆盖=展示层
 *  本相，ask「无提醒纯展示」语义）。state：empty=无闭合段（灰）/dirty=有未同步段（黄）/
 *  synced=全同步（绿）。 */
export interface LiveSyncPlan<T extends AmmoLedgerEntry> {
    state: "empty" | "dirty" | "synced";
    /** 闭合段总数（empty/synced 态的 total 口径） */
    total: number;
    toCreate: Array<{ key: string; entry: T; payload: EventPayload }>;
    toUpdate: Array<{ key: string; entry: T; payload: EventPayload; eventId: string }>;
    unchanged: number;
}

export function planLiveSync<T extends AmmoLedgerEntry>(
    entries: T[],
    day: string,
    ledgerEntries: Record<string, LiveLedgerEntryView> | null | undefined,
): LiveSyncPlan<T> {
    const closed = entries.filter((e) => e.closed && e.end !== null);
    const plan: LiveSyncPlan<T> = { state: "empty", total: closed.length, toCreate: [], toUpdate: [], unchanged: 0 };
    if (!closed.length) return plan;
    for (const entry of closed) {
        const payload = buildLiveEventPayload(entry, day);
        if (!payload) continue; // 脏段（坏时刻）不进平面不炸轮——state 判定按在账面段算
        const key = liveLedgerKey(entry.id);
        const bound = ledgerEntries?.[key];
        if (!bound?.eventId) plan.toCreate.push({ key, entry, payload });
        else if (bound.sySnap !== payloadSig(payload)) plan.toUpdate.push({ key, entry, payload, eventId: bound.eventId });
        else plan.unchanged++;
    }
    plan.state = plan.toCreate.length + plan.toUpdate.length > 0 ? "dirty" : "synced";
    return plan;
}
