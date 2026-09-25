// ammo □3：单任务运行引擎（kernel 侧编排）——被 □6/□7 UI 经 rpc 调用的互斥执行层。
// 契约=docs/ammo-concept.md A6/B2.4/B2.5：
//  - 单任务互斥：开始新任务=前一个自动闭合（停止时间=新开始时刻，无缝不丢秒）；先闭后开
//    （两写之间崩溃只丢新开、不产双悬账）。锚点「出发」=同一转移的锚点出发型（显式用户动作，
//    不偷偷自动切——账本只记真实发生的事）。
//  - 运行态不另立存储：真身=未闭合条目本身（B2.4），每次动作经 □2 读链现读现判（无陈旧缓存面）；
//    会话级内存只放 owner 门牌+状态代数。崩溃恢复=读未闭合分类（running 候选/悬账），返回状态
//    不擅自闭合（悬账交上层提示补结——resolve 面收口）。
//  - 番茄解耦：只读关联=状态广播的 focus 字段（PomoTarget 形态，番茄区显示当前任务）；
//    记账唯一来源=开始/停止打点；引擎零 petal 写（petal 写=前端整重载风暴，红线）。
//  - 双窗并发：全部转移经 □2 日账串行链作为单个原子单位（runLedgerUnit）——后到的 start 把
//    先到的闭在自身开始时刻，任何交错下「至多一条未闭合」不变量保持；owner 门牌（ws app id）
//    随状态透传（他窗只读展示的数据面；无主恢复态=下一个动作接管认领——pomodoro 退役骨架
//    owner 三件套同款语义）。
// 错误兜底对齐 schedboard/ammoLedger：失败 {ok:false,error} 不 throw（调用方接管 UI 提示）。
import { shiftDay } from "./core/behavior";
import { isValidDay, isValidHM } from "./core/schedule";
import {
    AMMO_DANGLING_SCAN_DAYS,
    AMMO_RUNNING_WINDOW_DAYS,
    classifyUnclosedLedger,
    hmToMinutes,
    isValidAmmoPool,
} from "./core/ammoEngine";
import type { AmmoClassifyResult, AmmoUnclosedRow } from "./core/ammoEngine";
import {
    appendLedgerReflection,
    readDayLedger,
    runLedgerUnit,
    startLedgerEntryInner,
    stopLedgerEntryInner,
} from "./ammoLedger";
import type { LedgerWriteResult } from "./ammoLedger";
import type { PomoTarget } from "../gui/pomoBridge";
import { AMMO_STATE_CHANNEL } from "../shared/channels";

/** 运行中任务快照（状态面/广播共用） */
export interface AmmoRunSnapshot {
    /** 打点条目块 id（闭合/补结的锚） */
    blockId: string;
    /** 落账日（=开始日；跨零点条目留开始日不迁移） */
    day: string;
    summary: string;
    start: string;
    pool: string;
    task: string;
    anchor: boolean;
    /** 持有窗门牌（发起窗 app id；崩溃恢复出的无主态=null——他窗读状态做只读展示） */
    owner: string | null;
}

/** 悬账引用（补结提示面：UI 逐条出示，用户给 end 走 ammo-resolve） */
export interface AmmoDanglingRef {
    blockId: string;
    day: string;
    summary: string;
    start: string;
}

/** 引擎状态（rpc 返回+广播 payload 同一形态） */
export interface AmmoEngineStatus {
    ok: boolean;
    running: AmmoRunSnapshot | null;
    dangling: AmmoDanglingRef[];
    /** 番茄区只读关联（PomoTarget 形态；running=null→null。番茄是节奏器不是记账器） */
    focus: PomoTarget | null;
    /** 状态代数（转移单调递增；前端按 rev 去重/判新鲜） */
    rev: number;
    error?: string;
}

export interface AmmoStartParams {
    day: string;
    start: string;
    summary: string;
    pool?: string;
    task?: string;
    anchor?: boolean;
    owner?: string;
}

export interface AmmoStopParams {
    day: string;
    end: string;
}

export interface AmmoDepartParams {
    day: string;
    start: string;
    summary: string;
    /** 班表锚点条目块 id（B2.4：锚点出发型的 task 指针） */
    task: string;
    owner?: string;
}

export interface AmmoResolveParams {
    blockId: string;
    /** 动作日（=补结发生日；跨零点合法性判据用） */
    day: string;
    end: string;
}

// ── 会话级缓存（B2.4：内存只放 owner 门牌+代数；运行态真身=未闭合条目本身） ──

let sessionRunBlock: string | null = null;
let sessionOwner: string | null = null;
let stateRev = 0;

/** 测试钩子（__resetSchedboardCaches 同款惯例） */
export function __resetAmmoEngine(): void {
    sessionRunBlock = null;
    sessionOwner = null;
    stateRev = 0;
}

/** 本地日 YYYY-MM-DD（goja/V8 均有 Date；pomoLocalDay 同款本地日语义） */
function localDay(now: number): string {
    const d = new Date(now);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 读链聚合：按日扫未闭合条目（读通道零副作用零建档）。
 *  动作日读失败→actionDayOk=false（转移面据此中止——当日读不到=互斥判据缺失，宁可不开新）； 他日读失败容忍跳过（至多漏闭他日悬账，不产新悬账）。 */
async function gatherUnclosed(days: string[], actionDay: string): Promise<{ rows: AmmoUnclosedRow[]; actionDayOk: boolean }> {
    const rows: AmmoUnclosedRow[] = [];
    let actionDayOk = true;
    for (const d of days) {
        const r = await readDayLedger(d);
        if (!r.ok) {
            if (d === actionDay) actionDayOk = false;
            continue;
        }
        for (const e of r.items) if (!e.closed) rows.push({ day: d, entry: e });
    }
    return { rows, actionDayOk };
}

function buildStatus(cls: AmmoClassifyResult): AmmoEngineStatus {
    const running: AmmoRunSnapshot | null = cls.running
        ? {
            blockId: cls.running.entry.id,
            day: cls.running.day,
            summary: cls.running.entry.summary,
            start: cls.running.entry.start,
            pool: cls.running.entry.pool,
            task: cls.running.entry.task,
            anchor: cls.running.entry.anchor,
            owner: cls.running.entry.id === sessionRunBlock ? sessionOwner : null,
        }
        : null;
    return {
        ok: true,
        running,
        dangling: cls.dangling.map((d) => ({
            blockId: d.entry.id, day: d.day, summary: d.entry.summary, start: d.entry.start,
        })),
        focus: running ? { source: "ammo", summary: running.summary, startMin: hmToMinutes(running.start) } : null,
        rev: stateRev,
    };
}

function errStatus(error: string): AmmoEngineStatus {
    return { ok: false, running: null, dangling: [], focus: null, rev: stateRev, error };
}

/** 状态广播（失败无害：前端下次挂载/动作经 state 面自愈——remind 同款纪律） */
function broadcastStatus(st: AmmoEngineStatus): void {
    try {
        siyuan.rpc.broadcast(AMMO_STATE_CHANNEL, st);
    } catch {
        // 单测环境 siyuan 未定义/广播断连：状态面兜底
    }
}

/** start 面参数校验（零 IO 拦截——脏数据防线）；返回 null=通过 */
function validateStart(p: AmmoStartParams): string | null {
    if (!isValidDay(p?.day)) return "day 须为合法 YYYY-MM-DD";
    if (!isValidHM(p?.start)) return "start 须为合法 HH:mm";
    if (!(p?.summary ?? "").replace(/\u200b/g, "").trim()) return "summary 不能为空";
    if (p.pool != null && !isValidAmmoPool(String(p.pool))) return `未知池 slug：${p.pool}（词表冻结：gold|deadline|hearth|crumbs|空）`;
    if (p.anchor) {
        if (!p.task) return "锚点出发型必须指定班表锚点条目（task）";
        if (p.pool) return "锚点出发型池恒空（pool 不接受非空值）";
    }
    return null;
}

/** 同日倒挂守卫：闭合同日条目的 end<start=乱序钟/手滑（跨零点=他日条目合法，end<start 读面
 *  +24h 归一——□2 契约）。防把负时长写成次日 23h 级假账。 */
function closeGuard(running: AmmoUnclosedRow, actionDay: string, end: string): string | null {
    if (running.day === actionDay && end < running.entry.start) {
        return `end（${end}）早于任务开始（${running.entry.start}）——同日条目不支持倒挂`;
    }
    return null;
}

/** 互斥转移（start/depart 共用核心）：先闭后开，链内单原子单位。
 *  闭失败=中止不开新（不变量优先：宁可不转移也不产双悬账）；开失败=旧条已闭落账
 *  （用户在 start 时刻的切换动作真实发生），新开可重试。 */
async function transition(p: AmmoStartParams): Promise<AmmoEngineStatus> {
    const invalid = validateStart(p);
    if (invalid) return errStatus(invalid);
    return runLedgerUnit(async () => {
        const { rows, actionDayOk } = await gatherUnclosed([shiftDay(p.day, -(AMMO_RUNNING_WINDOW_DAYS - 1)), p.day], p.day);
        if (!actionDayOk) return errStatus(`读 ${p.day} 日账失败——互斥判据缺失，转移中止`);
        const cls = classifyUnclosedLedger(rows, p.day);
        if (cls.running) {
            const guard = closeGuard(cls.running, p.day, p.start);
            if (guard) return errStatus(guard);
            const closed = await stopLedgerEntryInner({ blockId: cls.running.entry.id, end: p.start, day: p.day });
            if (!closed.ok) return errStatus(`闭合前一个任务失败：${closed.error}（未开新任务）`);
        }
        const started = await startLedgerEntryInner({
            day: p.day, start: p.start, summary: p.summary,
            pool: p.anchor ? "" : (p.pool ?? ""),
            task: p.task ?? "",
            anchor: Boolean(p.anchor),
        });
        if (!started.ok || !started.blockId) return errStatus(`开新条目失败：${started.error}（前一个已闭合落账，可重试）`);
        sessionRunBlock = started.blockId;
        sessionOwner = p.owner ?? null;
        stateRev++;
        const st = buildStatus(cls); // 闭旧开新后重读分类成本高；直接从转移结果重建状态：
        st.running = {
            blockId: started.blockId, day: p.day, summary: (p.summary ?? "").replace(/\s+/g, " ").trim(),
            start: p.start, pool: p.anchor ? "" : (p.pool ?? ""), task: p.task ?? "",
            anchor: Boolean(p.anchor), owner: p.owner ?? null,
        };
        st.focus = { source: "ammo", summary: st.running.summary, startMin: hmToMinutes(p.start) };
        broadcastStatus(st);
        return st;
    });
}

/** 开始任务（互斥：闭前一个于新开始时刻+开新未闭合条目） */
export function ammoStartRpc(p: AmmoStartParams): Promise<AmmoEngineStatus> {
    return transition(p).catch((e: any) => errStatus(String(e?.message ?? e)));
}

/** 锚点一键「出发」：闭当前+开锚点出发型条目（anchor=1/task=班表块/pool 空）——显式用户动作 */
export function ammoDepartRpc(p: AmmoDepartParams): Promise<AmmoEngineStatus> {
    return transition({ ...p, anchor: true, pool: "", task: p.task }).catch((e: any) => errStatus(String(e?.message ?? e)));
}

/** 停止当前运行任务：补 end 闭合（任意窗的停止都是真实用户动作——owner 不设限） */
export async function ammoStopRpc(p: AmmoStopParams): Promise<AmmoEngineStatus> {
    if (!isValidDay(p?.day)) return errStatus("day 须为合法 YYYY-MM-DD");
    if (!isValidHM(p?.end)) return errStatus("end 须为合法 HH:mm");
    return runLedgerUnit(async () => {
        const { rows, actionDayOk } = await gatherUnclosed([shiftDay(p.day, -(AMMO_RUNNING_WINDOW_DAYS - 1)), p.day], p.day);
        if (!actionDayOk) return errStatus(`读 ${p.day} 日账失败——互斥判据缺失，停止中止`);
        const cls = classifyUnclosedLedger(rows, p.day);
        if (!cls.running) return errStatus("没有运行中的任务");
        const guard = closeGuard(cls.running, p.day, p.end);
        if (guard) return errStatus(guard);
        const closed = await stopLedgerEntryInner({ blockId: cls.running.entry.id, end: p.end, day: p.day });
        if (!closed.ok) return errStatus(`停止失败：${closed.error}`);
        if (sessionRunBlock === cls.running.entry.id) {
            sessionRunBlock = null;
            sessionOwner = null;
        }
        stateRev++;
        const st = buildStatus({ running: null, dangling: cls.dangling });
        broadcastStatus(st);
        return st;
    }).catch((e: any) => errStatus(String(e?.message ?? e)));
}

/** 悬账补结（UI 提示后用户给 end 时刻收口；含「丢弃」=end 用户自估）。append-only 纪律
 *  继承 □2 复核读：已闭合异值拒改。 */
export async function ammoResolveRpc(p: AmmoResolveParams): Promise<AmmoEngineStatus> {
    if (!isValidDay(p?.day)) return errStatus("day 须为合法 YYYY-MM-DD");
    if (!isValidHM(p?.end)) return errStatus("end 须为合法 HH:mm");
    if (!p?.blockId) return errStatus("blockId 不能为空");
    return runLedgerUnit(async () => {
        const days = Array.from({ length: AMMO_DANGLING_SCAN_DAYS }, (_, i) => shiftDay(p.day, -(AMMO_DANGLING_SCAN_DAYS - 1 - i)));
        const { rows } = await gatherUnclosed(days, p.day);
        const target = rows.find((r) => r.entry.id === p.blockId);
        if (target) {
            const guard = closeGuard(target, p.day, p.end);
            if (guard) return errStatus(guard);
        } // 窗外老悬账（>7 日）无 day 判据——stopLedgerEntryInner 复核读兜底
        const closed = await stopLedgerEntryInner({ blockId: p.blockId, end: p.end, day: p.day });
        if (!closed.ok) return errStatus(`补结失败：${closed.error}`);
        if (sessionRunBlock === p.blockId) {
            sessionRunBlock = null;
            sessionOwner = null;
        }
        stateRev++;
        const { rows: after } = await gatherUnclosed([shiftDay(p.day, -(AMMO_RUNNING_WINDOW_DAYS - 1)), p.day], p.day);
        const st = buildStatus(classifyUnclosedLedger(after, p.day));
        broadcastStatus(st);
        return st;
    }).catch((e: any) => errStatus(String(e?.message ?? e)));
}

/** 引擎状态只读面（启动恢复/挂载首读）：全悬账扫描窗分类，零写零建档 */
export async function ammoStatusRpc(day?: string): Promise<AmmoEngineStatus> {
    const today = isValidDay(day ?? "") ? day! : localDay(Date.now());
    const days = Array.from({ length: AMMO_DANGLING_SCAN_DAYS }, (_, i) => shiftDay(today, -(AMMO_DANGLING_SCAN_DAYS - 1 - i)));
    try {
        const { rows } = await gatherUnclosed(days, today);
        return buildStatus(classifyUnclosedLedger(rows, today));
    } catch (e: any) {
        return errStatus(String(e?.message ?? e));
    }
}

/** 感想 append 的 rpc 面（□6 UI「记」钮——□2 appendLedgerReflection 写链已在，这里补
 *  常量绑定+blockId 缺省解析）：blockId 缺省=当前运行中条目（感想跟着正在做的事走）；
 *  无运行中且未指条目=拒（感想必须挂打点条目下——不发明第二感想档，□23 随手反馈档
 *  是班表行通道，日账感想只有这一条链）。任意失败 {ok:false,error} 不 throw。 */
export async function ammoReflectRpc(p: { text: string; blockId?: string; day?: string }): Promise<LedgerWriteResult> {
    const text = (p?.text ?? "").replace(/\u200b/g, "").trim();
    if (!text) return { ok: false, error: "text 不能为空" };
    let blockId = (p?.blockId ?? "").trim();
    if (!blockId) {
        const st = await ammoStatusRpc(p?.day);
        if (!st.ok || !st.running) return { ok: false, error: "没有运行中的任务——感想挂在打点条目下，先开始任务再记" };
        blockId = st.running.blockId;
    }
    return appendLedgerReflection({ blockId, text }).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) }));
}

/** 启动恢复扫描（kernel onrunning 兜底）：广播状态唤醒悬账提示面——零写
 *  （不偷偷自动切/不擅自闭合，日账信用底线）；任何失败吞掉不炸生命周期。 */
export async function runAmmoRecoveryScan(day?: string): Promise<void> {
    try {
        const st = await ammoStatusRpc(day);
        broadcastStatus(st);
    } catch {
        // 恢复扫描失败无害：前端下次挂载走 state 面
    }
}
