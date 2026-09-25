// □3 账本·纯逻辑层：四源（块提醒/任务截止/闪卡负担/班表镜像）统一映射存储的形态/签名/三态裁决/时间反解/迁移。
// 零 siyuan/网络依赖（kernel bundle 与前端 bundle 共用同一份源——channels 纪律）。
// spike 实锤（exp/spike_ledger.mjs，09-14）：GET 回显 timestamp=string、recurrence=纯串、summary 原样
// → 两端同一签名空间直接比对；last_modified_time/revision GET 恒不回 → 改时间判定=签名比对；
// 已删事件 GET 返回 code 0 + status:"cancelled" 墓碑（字段形状完整）→ gone 判据=status，先于签名。
import type { EventPayload, SyncMapping } from "./feishu";

export type LedgerSource = "remind" | "task" | "burden" | "sched";

export const LEDGER_SOURCES: LedgerSource[] = ["remind", "task", "burden", "sched"];

export interface SourceSwitch {
    /** 源总开关（false=整源跳过含剪枝，pause 语义：事件留在飞书侧不动） */
    enabled: boolean;
    /** 回写位：飞书改时间是否回写思源属性（闪卡负担=恒 false；sched=对齐 sched-mirror-conf
     *  的 writeback 位（□25 完全同步，apply 唯一写者——对账页显示面），执行器以 conf 为准） */
    allowWriteback: boolean;
}

/** 账本条目：锚键（remind:<id>/task:<id>/flashcard-burden:…）↔飞书事件 + 双方快照 + 冲突计数 */
export interface LedgerEntry extends SyncMapping {
    /** 思源侧期望态签名（lastSync 时点）＝payloadSig(本侧载荷) */
    sySnap?: string;
    /** 飞书侧观测态签名（lastSync 时点）＝eventSig(GET 回显)；推平后=所推载荷签名 */
    fsSnap?: string;
    /** 上次推送的提醒归一串（remindersKey）；缺省=legacy 条目，判漂移触发一轮推平自愈 */
    remindersAt?: string;
    /** 三态双变裁决（思源赢）累计次数，AI 可汇报 */
    conflicts?: number;
}

export interface CalendarLedger {
    version: 1;
    sources: Record<LedgerSource, SourceSwitch>;
    entries: Record<string, LedgerEntry>;
}

/** 默认开关（拍板）：块提醒/任务截止回写✅，闪卡负担=派生数据只生成不回写；
 *  班表镜像（sloop □7）=默认关（用户在设置页选了飞书后端才开）；
 *  回写位（sloop □25 bear 拍板「完全同步」）：conf 缺省=true，但账本位在 apply 对齐前
 *  保持 false（enabled 都没开时回写位无意义）——真值=sched-mirror-conf.json 的 writeback */
export const DEFAULT_SOURCES: Record<LedgerSource, SourceSwitch> = {
    remind: { enabled: true, allowWriteback: true },
    task: { enabled: true, allowWriteback: true },
    burden: { enabled: true, allowWriteback: false },
    sched: { enabled: false, allowWriteback: false },
};

/** 任务截止键（calendar-map 时代=裸 blockId，迁移时加此前缀） */
export function taskKey(blockId: string): string {
    return `task:${blockId}`;
}

/** 宽容读：缺文件/缺字段→默认；脏行（无 eventId）剔；burden 回写位强制钳 false；
 *  sched 回写位=apply 对齐写进（□25 起可真——执行器门禁以 sched-mirror-conf.writeback 为准） */
export function normalizeLedger(raw: any): CalendarLedger {
    const sources: Record<LedgerSource, SourceSwitch> = { ...DEFAULT_SOURCES };
    if (raw?.sources && typeof raw.sources === "object") {
        for (const src of LEDGER_SOURCES) {
            const s = raw.sources[src];
            if (!s || typeof s !== "object") continue;
            sources[src] = {
                enabled: s.enabled === undefined ? DEFAULT_SOURCES[src].enabled : Boolean(s.enabled),
                allowWriteback: src === "burden"
                    ? false // 派生数据恒不回写（每日重算重建，没有可回写的思源属性）
                    : s.allowWriteback === undefined ? DEFAULT_SOURCES[src].allowWriteback : Boolean(s.allowWriteback),
            };
        }
    }
    const entries: Record<string, LedgerEntry> = {};
    if (raw?.entries && typeof raw.entries === "object") {
        for (const [key, v0] of Object.entries<any>(raw.entries)) {
            if (!v0 || typeof v0.eventId !== "string" || !v0.eventId) continue;
            entries[key] = {
                eventId: v0.eventId,
                ...(typeof v0.calendarId === "string" && v0.calendarId ? { calendarId: v0.calendarId } : {}),
                ...(typeof v0.syncedAt === "string" ? { syncedAt: v0.syncedAt } : {}),
                ...(typeof v0.sySnap === "string" ? { sySnap: v0.sySnap } : {}),
                ...(typeof v0.fsSnap === "string" ? { fsSnap: v0.fsSnap } : {}),
                ...(typeof v0.remindersAt === "string" ? { remindersAt: v0.remindersAt } : {}),
                ...(typeof v0.conflicts === "number" && v0.conflicts > 0 ? { conflicts: v0.conflicts } : {}),
            };
        }
    }
    return { version: 1, sources, entries };
}

/** tb2 H2 块面同步徽标数据源：账本 remind:/sched: 两前缀键有 entry 的块 id 集合
 *  （与时间轴 synced 同口径——「同步过飞书」）；task:/burden:/weather: 不收（非时间块面管辖）。
 *  坏档/非对象→null=徽标隐藏态（勿误报「未同步」） */
export function syncedBlockIdsFromLedger(raw: any): Set<string> | null {
    if (!raw || typeof raw !== "object") return null;
    const entries = normalizeLedger(raw).entries;
    const ids = new Set<string>();
    for (const key of Object.keys(entries)) {
        if (key.startsWith("remind:")) ids.add(key.slice("remind:".length));
        else if (key.startsWith("sched:")) ids.add(key.slice("sched:".length));
    }
    return ids;
}

// ── 签名（两端同一空间；¦ 分隔防内容撞分隔符）──

/** 提醒归一串：[{minutes:N}]→"N,N"；无/null→""。reminders 不进签名（条目/事件签名只盖
 *  summary/起止/循环——提醒是全局配置不是条目属性，进签名会让回写判定把配置变化误判成
 *  「本地条目变了」）；提醒漂移走账本 remindersAt 专用字段对比（改 reminderMinutes 后
 *  存量事件靠它触发重推，否则提醒值冻结在创建时刻） */
export function remindersKey(rs: unknown): string {
    return Array.isArray(rs) ? rs.map((r: any) => r?.minutes ?? "?").join(",") : "";
}

/** 思源侧期望态签名：插件推给飞书的载荷四要素（时间戳或日期二选一形态都归一） */
export function payloadSig(p: EventPayload): string {
    return [
        p.summary ?? "",
        p.start_time?.timestamp ?? p.start_time?.date ?? "",
        p.end_time?.timestamp ?? p.end_time?.date ?? "",
        p.recurrence ?? "",
    ].join("¦");
}

/** 飞书侧观测签名（GET data.event）。⚠只对「活」事件调用——cancelled 墓碑字段形状完整，
 *  须先过 gone 判据（status!=="cancelled"）再进签名，否则把死事件判成「活着且一致」 */
export function eventSig(ev: any): string {
    const rec = Array.isArray(ev?.recurrence) ? ev.recurrence.join("") : ev?.recurrence ?? "";
    return [
        String(ev?.summary ?? ""),
        String(ev?.start_time?.timestamp ?? ev?.start_time?.date ?? ""),
        String(ev?.end_time?.timestamp ?? ev?.end_time?.date ?? ""),
        String(rec),
    ].join("¦");
}

/** getEvent 契约的纯侧：飞书 GET 的 event → gone（cancelled 墓碑，spike 09-14 实锤 code 0 也回） */
export function isEventGone(ev: any): boolean {
    return ev?.status === "cancelled";
}

// ── 三态裁决 ──

export type LedgerAction = "none" | "push" | "writeback" | "conflict" | "recreate";

export interface LedgerDecisionInput {
    /** 思源侧当前期望态签名 */
    sySig: string;
    /** 飞书侧当前观测签名；null=事件不可得（gone） */
    fsSig: string | null;
    sySnap?: string;
    fsSnap?: string;
    allowWriteback: boolean;
}

/** 三态比较（拍板）：只思源变→push；只飞书变→writeback（无回写位=none 但调用方仍须 ack fsSnap 收敛）；
 *  双变→conflict（思源赢，调用方 push+conflicts++）；无基线（迁移/legacy）→push 先推平建基线；
 *  fsSig=null→recreate（事件被删，删除=重建不墓碑）。
 *  expectedReminders/remindersAt 可选=提醒漂移旁路：两侧签名一致但提醒配置变了也算「思源侧变」→push */
export function decideLedgerAction(o: LedgerDecisionInput & { expectedReminders?: string; remindersAt?: string }): LedgerAction {
    if (o.fsSig === null) return "recreate";
    if (o.fsSnap === undefined || o.sySnap === undefined) return "push";
    if (o.fsSig === o.fsSnap) {
        const remindersOk = (o.expectedReminders ?? "") === (o.remindersAt ?? "");
        return o.sySig === o.sySnap && remindersOk ? "none" : "push";
    }
    if (o.sySig === o.sySnap) return o.allowWriteback ? "writeback" : "none";
    return "conflict";
}

// ── 时间反解（dueToTimeRange 的镜像；Asia/Shanghai 显式锚死禁宿主时区）──

/** epoch 秒→墙上时间 YYYY-MM-DDTHH:mm（+08:00）；非法→null */
export function timestampToWallTime(tsSec: string | number): string | null {
    const n = Number(tsSec);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date((n + 8 * 3600) * 1000).toISOString().slice(0, 16);
}

/** timed 事件→任务 due 双字段（秒粒度截断到分钟——任务属性只有分钟粒度） */
export function timestampToDue(tsSec: string | number): { date: string; time: string } | null {
    const wall = timestampToWallTime(tsSec);
    if (!wall) return null;
    const [date, time] = wall.split("T");
    return { date, time };
}

// ── 旧双 map 一次性迁移 ──

/** calendar-upserts.json 键原样（remind:/flashcard-burden: 前缀已带源）；
 *  calendar-map.json 键=裸 blockId → 加 task: 前缀；无 eventId 脏行剔 */
export function migrateLedgerEntries(
    upsertEntries: Record<string, SyncMapping> | null | undefined,
    taskEntries: Record<string, SyncMapping> | null | undefined,
): Record<string, LedgerEntry> {
    const out: Record<string, LedgerEntry> = {};
    for (const [k, v] of Object.entries(upsertEntries ?? {})) {
        if (v?.eventId) out[k] = { ...v };
    }
    for (const [blockId, v] of Object.entries(taskEntries ?? {})) {
        if (v?.eventId) out[taskKey(blockId)] = { ...v };
    }
    return out;
}
