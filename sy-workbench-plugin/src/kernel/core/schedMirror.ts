// 班表镜像·纯逻辑层（timeblock 期 4 sched 双源退役后瘦身）：
// ① 目标日外来日历占用（□26 plan_context 错峰原料——镜像档读，ours 集参数化）
// ② 期 2 ③ 全映射自动 adopt（bear 拍板「全映射零特例」——账本绑定 adopt: 键（纯防重标记）
//    +timed 条目 remind: 轨条目（班表块进 remind 链，预填签名防对既有事件 create 重复））
// ③ 删外来事件计划（期 2 ⑤ 右键三动作）
// 退役面（sched 镜像链+sched: 账本前缀）：schedSyncPlan/schedWritebackPlan/schedDriftSignals/
// adoptForeignEvent/schedItemToPayload/schedItemSig——班表块的飞书事件由 remind 链推
// （remind: 键），旧 sched: 条目与事件零迁移留作历史。
// 零 siyuan/网络依赖（channels 纪律：kernel bundle 与前端 bundle 共用同一份源）。

import { type CalendarLedger, payloadSig, type LedgerEntry } from "./ledger";
import { isValidDay, isValidHM, hmToMin, genSchedKey, SCHEDULE_KEEP_DAYS, type SchedItem } from "./schedule";
import { buildRemindEventPayload, remindKey } from "./remind";
import { type CalendarMirror } from "./calendarMirror";
import { getLogicalDay } from "./dates";
import { shiftDay } from "./behavior";

/** adopt 绑定键（adopt:<块id>——纯「该飞书事件已落地」防重标记；不参与任何源的事件同步
 *  与剪枝（remind 剪枝只动 remind: 键），镜像范围变化也无须摘除） */
export function adoptBindKey(blockId: string): string {
    return `adopt:${blockId}`;
}

/** 同步回执（交接会开场包「已自动同步」段形态；内存档——kernel 重启即清=当日证据非账本） */
export interface SchedReceipt {
    summary: string;
    kind: "edited" | "deleted";
    detail: string;
}

// ── ① 目标日外来日历占用（□26 plan_context：错峰原料——镜像档读） ──

export interface ForeignEventRow {
    /** HH:mm；null=全天事件或跨天中段日（整日被占） */
    time: string | null;
    /** HH:mm；null=无终刻或跨天 */
    end: string | null;
    summary: string;
    allDay: boolean;
}

/** 某日「外来」日历占用：镜像档非循环事件、覆盖该日（start 日或跨天中段——排程避让输入，
 *  跨天中段隐形=AI 把出差中段当空日排深度块，review P1-3；全天多日 end 含尾覆盖=错峰
 *  场景假占用落在安全侧）、剔除我方事件（oursEventIds=编排侧组装：班表块 remind: 键的
 *  eventId（期 4 起班表走 remind 轨）∪ 旧 sched: 化石条目 eventId）。task/remind 提醒轨
 *  保留=真实占用（原语义）。循环系列主事件（recurring）不展开——镜像档无实例面，与月历
 *  v1 同限。 */
export function foreignEventsForDay(mirror: CalendarMirror, oursEventIds: ReadonlySet<string>, day: string): ForeignEventRow[] {
    const rows: ForeignEventRow[] = [];
    for (const ev of Object.values(mirror.events)) {
        if (ev.recurring || oursEventIds.has(ev.id)) continue;
        const startDay = ev.allDay ? ev.start : ev.start.slice(0, 10);
        const endDay = (ev.allDay ? ev.end : ev.end.slice(0, 10)) || startDay;
        const isStart = startDay === day;
        if (!isStart && !(startDay < day && endDay >= day)) continue; // 跨天中段覆盖命中
        rows.push({
            time: isStart && !ev.allDay ? ev.start.slice(11, 16) : null,
            end: isStart && !ev.allDay && endDay === day ? ev.end.slice(11, 16) : null,
            summary: ev.summary,
            allDay: ev.allDay,
        });
    }
    rows.sort((a, b) => (a.time ?? "00:00").localeCompare(b.time ?? "00:00"));
    return rows;
}

// ── ② 期 2 ③ 全映射自动 adopt（bear 拍板「全映射零特例」：飞书出现的事件全部映射成块——
//    含订阅日历/全天，「只要写了就自动存入」，「存入班表」按钮整体退役） ──

/** 自动 adopt 计划产物：单条=班表行+双键账本绑定 */
export interface AutoAdoptSkip {
    eventId: string;
    summary: string;
    reason: string;
}

export interface AutoAdoptPlan {
    adopts: AdoptOk[];
    skips: AutoAdoptSkip[];
}

/** 多日全天事件的逐日展开上限（请假长假一类；超限=截断只落前 31 天，防镜像脏数据撑爆班表） */
export const AUTO_ADOPT_ALLDAY_SPAN_LIMIT = 31;

/** 一条自动 adopt 产物：班表行（key=临时键，落块后 remap 成块 id）+账本绑定。
 *  bindEntry=adopt: 键条目（纯防重）；remindEntry=timed 行的 remind: 轨条目——预填
 *  sySnap=fsSnap=按块形态算的 remind 载荷签名（payloadSig 不含 reminders/description，
 *  与主扫将来算的载荷同源），首拍三态即「无变化」零写——既有事件（用户在飞书建的）
 *  原样保留不 PATCH；全天托盘行无 remind-at 属性不进 remind 链=null。 */
export interface AdoptOk {
    /** 新班表条目（hard=true、origin="adopt"；date/start/end 按镜像事件） */
    item: SchedItem;
    bindKey: string;
    bindEntry: LedgerEntry;
    remindKey: string | null;
    remindEntry: LedgerEntry | null;
}

/** adopt 行的 remind 轨签名（块形态→载荷→签名；reminderMinutes 不进签名，取 0 占位） */
function adoptRemindSig(item: SchedItem): string | null {
    if (!item.start) return null;
    const p = buildRemindEventPayload(
        {
            blockId: "adopt", // 不进签名（payloadSig 只盖 summary/起止/循环）
            content: item.summary,
            remindAt: `${item.date}T${item.start}`,
            repeat: null,
            remindEnd: item.end ? `${item.date}T${item.end}` : null,
        },
        { reminderMinutes: 0 },
    );
    return p ? payloadSig(p) : null;
}

/** 全镜像扫描 → 自动 adopt 计划（纯）。
 *  防重=账本任何源同 eventId 绑定（含自家推的——adopt:/remind:/task:/burden:/旧 sched:）；
 *  skip 因：循环系列（重复语义单块丢不起）/ 跨天 timed（落哪天都歪，待 bear 定形态）/
 *  不可表达（无 end/无标题/倒挂）/ 超班表保留窗（too_old）。
 *  全天=托盘行（start/end=null+allDay 标记）；多日全天=逐日展开（每日一行）。 */
export function planAutoAdopt(mirror: CalendarMirror, ledger: CalendarLedger, now: Date): AutoAdoptPlan {
    const bound = new Set<string>();
    for (const e of Object.values(ledger.entries)) {
        if (e.eventId) bound.add(e.eventId);
    }
    const itemCut = shiftDay(getLogicalDay(now), -(SCHEDULE_KEEP_DAYS - 1));
    const adopts: AdoptOk[] = [];
    const skips: AutoAdoptSkip[] = [];
    const at = now.toISOString();
    for (const ev of Object.values(mirror.events)) {
        const summary = ev.summary.trim();
        if (ev.recurring) { skips.push({ eventId: ev.id, summary, reason: "recurring" }); continue; }
        if (bound.has(ev.id)) continue; // 已绑定（任何源）——非 skip 静默跳过（常态）
        const bindFor = (key: string): { bindKey: string; bindEntry: LedgerEntry } => ({
            bindKey: adoptBindKey(key),
            bindEntry: { eventId: ev.id, calendarId: ev.cal, syncedAt: at },
        });
        if (ev.allDay) {
            const sDay = ev.start.slice(0, 10);
            const eDay = (ev.end || sDay).slice(0, 10);
            if (!isValidDay(sDay) || sDay > eDay) { skips.push({ eventId: ev.id, summary, reason: "unrepresentable" }); continue; }
            if (sDay < itemCut) { skips.push({ eventId: ev.id, summary, reason: "too_old" }); continue; }
            // 逐日展开（多日全天=每日一行；上限截断）
            for (let d = sDay; d <= eDay && adopts.length < 500; d = shiftDay(d, 1)) {
                if (countDays(sDay, d) >= AUTO_ADOPT_ALLDAY_SPAN_LIMIT) break;
                const key = genSchedKey(now);
                const item: SchedItem = {
                    key, summary: summary.slice(0, 100) || "(无标题)", date: d, start: null, end: null,
                    hard: false, origin: "adopt", allDay: true,
                    createdAt: at, updatedAt: at,
                };
                adopts.push({ item, ...bindFor(key), remindKey: null, remindEntry: null });
            }
            continue;
        }
        const sDay = ev.start.slice(0, 10), sHM = ev.start.slice(11, 16);
        const eDay = (ev.end ?? "").slice(0, 10), eHM = (ev.end ?? "").slice(11, 16);
        // 跨天先判：跨午夜 timed（22:00→01:00）end 恒小于 start，倒挂检查会先吃掉它
        if (ev.end && eDay !== sDay) { skips.push({ eventId: ev.id, summary, reason: "cross_day" }); continue; }
        if (!summary || summary === "(无标题)" || !ev.end || !isValidHM(sHM) || !isValidHM(eHM) || hmToMin(eHM) <= hmToMin(sHM)) {
            skips.push({ eventId: ev.id, summary, reason: "unrepresentable" });
            continue;
        }
        if (sDay < itemCut) { skips.push({ eventId: ev.id, summary, reason: "too_old" }); continue; }
        const key = genSchedKey(now);
        const item: SchedItem = {
            key, summary: summary.slice(0, 100), date: sDay, start: sHM, end: eHM,
            hard: true, origin: "adopt",
            createdAt: at, updatedAt: at,
        };
        const sig = adoptRemindSig(item)!; // 上方校验保证 timed 可表达，载荷恒非空
        adopts.push({
            item,
            ...bindFor(key),
            remindKey: remindKey(key),
            remindEntry: { eventId: ev.id, calendarId: ev.cal, syncedAt: at, sySnap: sig, fsSnap: sig },
        });
    }
    return { adopts, skips };
}

// ── □6a 内容级防重（兜底）：当日已有同 summary+同 allDay 行→不再追加块 ──

export interface AdoptDupOutcome {
    kept: AdoptOk[];
    /** 内容重复（当日已有同 summary+同 allDay 行）——不落块不绑（bear □6a 原话「不追加」） */
    dups: AdoptOk[];
}

/** adopt 落块前的「不追加」闸（□6a 天气风暴形态）：账本 eventId 绑定是防重正身，但绑定
 *  丢失（写竞态/手删）时每轮 sweep 会把同批事件重落块（09-19 主实例每小时 +3~4 块实锤）。
 *  本闸按当日既有行做内容配对：同 summary+同 allDay 的行数已够的事件不再落——宁可少落
 *  （用户可见可手动补），不可重复追加。已知边界：两个不同事件同 summary 会误判 dup=少落，
 *  与天气风暴形态正好互抵，接受。空班表=全放行（首落不受影响）。 */
export interface AdoptExistingRow {
    summary: string;
    start?: string | null;
    allDay?: boolean;
}

export function filterDuplicateAdopts(
    existing: ReadonlyArray<AdoptExistingRow>,
    adopts: AdoptOk[],
): AdoptDupOutcome {
    const kept: AdoptOk[] = [];
    const dups: AdoptOk[] = [];
    /** 形态键：同 summary+同形态（timed=有起时刻；托盘=无起时刻，含全天行）才互斥 */
    const shape = (o: AdoptExistingRow) => `${o.summary}|${o.start ? "timed" : "allday"}`;
    /** key=形态键 → 该形态剩余可落额度（=既有行数；每放行一条减一） */
    const quota = new Map<string, number>();
    for (const row of existing) {
        if (!row.summary) continue; // 空草稿行不占额度（草稿闸另有守卫）
        const k = shape(row);
        quota.set(k, (quota.get(k) ?? 0) + 1);
    }
    for (const a of adopts) {
        const k = shape({ summary: a.item.summary, start: a.item.start, allDay: a.item.allDay });
        const left = quota.get(k) ?? 0;
        if (left > 0) {
            quota.set(k, left - 1);
            dups.push(a);
        } else {
            kept.push(a);
        }
    }
    return { kept, dups };
}

/** a→b 的天数差（b≥a；逐日展开的截断计数） */
function countDays(a: string, b: string): number {
    return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

// ── 期 2 ⑤ 删外来事件（右键三动作·删除：无块虚显条目→删飞书事件；订阅日历无写权限→API 报错透传） ──

export interface ForeignDeletePlan {
    /** 事件所在日历 id（镜像行带真实历 id） */
    calendarId: string;
    /** 账本中绑定该事件的所有键——事件删除后全摘（留绑=孤儿 entry 指向不存在事件） */
    boundKeys: string[];
}

/** 删外来事件计划：镜像定位事件（真实历 id）+账本绑定键清单。镜像无此事件=null（未轮询到/已被删）。 */
export function foreignDeletePlan(mirror: CalendarMirror, ledger: CalendarLedger, eventId: string): ForeignDeletePlan | null {
    const ev = Object.values(mirror.events).find((e) => e.id === eventId);
    if (!ev) return null;
    const boundKeys: string[] = [];
    for (const [k, e] of Object.entries(ledger.entries)) if (e.eventId === eventId) boundKeys.push(k);
    return { calendarId: ev.cal, boundKeys };
}
