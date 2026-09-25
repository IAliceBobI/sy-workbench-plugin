// 作息训练·期 2（sloop □4）：本地班表·纯逻辑层。
// schema+归一+剪枝+晨间滚动+对账三态判定——零 siyuan/网络/DOM 依赖（channels 纪律：
// 只允许零依赖纯函数，kernel bundle 与前端 bundle 共用同一份源）。
// 班表=咱们自己的数据、本地为源（设计档 §1）；证据=行为画像 DayProfile（□3 产出）。

import { shiftDay, type DayProfile } from "./behavior";
import { type FlashWaveMeta } from "./flashwave";

/** 班表滚动保留窗（天）：过去班表条目/对账记录的剪枝线（对账历史偶尔回看，60 天宽裕） */
export const SCHEDULE_KEEP_DAYS = 60;
/** 未确认拖动记录保留窗（天）：交接会没开也别让拖动账无限累积 */
export const DRAG_KEEP_DAYS = 14;

// ── schema ──

/** 一条班表条目（某天的安排；时刻可空=弹性/未定时） */
export interface SchedItem {
    /** 稳定标识（genSchedKey 产物；roll 条目=新 key+rolledFrom 记来源） */
    key: string;
    summary: string;
    /** YYYY-MM-DD（班表按天组织，MVP 不做循环——锚点循环=期 3 形态库/期 5 镜像的事） */
    date: string;
    /** HH:mm | null（null=未定时/弹性条目，住「未定时」托盘） */
    start: string | null;
    /** HH:mm | null（null=无明确结束；end 须 > start 由归一层钳制） */
    end: string | null;
    /** true=硬性（排进日程）/ false=弹性（尽量做到）——coachSeed 第二步同款标注 */
    hard: boolean;
    /** report=照镜子周报条目（sloop □6；key=wr-<weekStart> 稳定幂等，chip 点击开周报文档）；
     *  adopt=飞书先建事件落地（sloop □17：纯飞书→完全同步跃迁，落地即双向） */
    origin: "ai" | "user" | "roll" | "report" | "adopt";
    /** roll 条目来源 key（其余 origin 无此字段） */
    rolledFrom?: string;
    /** 期 2 ③ 全映射 adopt：全天事件落的托盘行（start/end=null+allDay 标记——渲染层显
     *  「全天」；sig=null 天然不进镜像推平面）。 */
    allDay?: boolean;
    /** 期 3 闪卡波次：条目=某波已规整卡的锚（blocks 清单=微调联动改时刻重规整+对账完成度的
     *  依据；schedule_set 消化 flash:{quota} 输入后由编排层填入，读面随 custom-sched-flash 往返） */
    flash?: FlashWaveMeta;
    createdAt: string;
    updatedAt: string;
}

/** 拖动记录（悬案①：拖完零打扰，交接会顺口问「以后都这样排吗」） */
export interface DragRecord {
    key: string;
    summary: string;
    /** 拖动发生的日（交接会按日消耗） */
    day: string;
    from: { start: string | null; end: string | null };
    to: { start: string | null; end: string | null };
    at: string;
}

/** 对账三态（✅ done 有证据完成 / ❌ missed 有证据未完成 / ❓ unknown 无证据才问） */
export type ReconVerdict = "done" | "missed" | "unknown";

/** 一条对账结果（交接会落账形态） */
export interface ReconSettled {
    key: string;
    summary: string;
    verdict: ReconVerdict;
    note?: string;
}

/** 某日的对账记录（recon_record 幂等覆盖） */
export interface ReconRecord {
    day: string;
    at: string;
    results: ReconSettled[];
}

/** 长期偏好（拖动点头/口述沉淀；「以后都这样排」的一句话事实） */
export interface SchedPref {
    id: string;
    text: string;
    origin: "drag-confirm" | "chat" | "user";
    at: string;
}

/** 班表辅助状态档（petal schedule.json；timeblock 期 4 起 items 数据面退役——班表条目=日记
 *  块，读写全走 schedboard rpc/块扫描，本档只剩 drags/recon/prefs/lastRollDay 四样辅助态；
 *  旧档的 items 宽容读入后丢弃（块=唯一真身，petal 行不再消费）。 */
export interface SchedStore {
    version: 1;
    drags: DragRecord[];
    /** day → 对账记录 */
    recon: Record<string, ReconRecord>;
    prefs: SchedPref[];
    /** 晨间滚动已跑日（YYYY-MM-DD；每天至多真滚动一次） */
    lastRollDay: string | null;
}

/** 完整班表视图（辅助档+items 注入——周报/对账锚等纯层消费的旧形态；items 由编排层从
 *  块读面组装，非持久数据）。结构兼容 SchedStore（assignable）。 */
export interface SchedView extends SchedStore {
    items: Record<string, SchedItem>;
}

/** 前端班表编辑操作（Calendar 班表区 → index.schedEdit 消费；data 契约双端共用）。
 *  期 4 起 petal items 退役：move 的行恒从当日块读面取（heal 载荷随双写过渡退役）。 */
export type SchedEditOp =
    | {
        type: "move";
        key: string;
        to: { start: string | null };
    }
    | { type: "add"; day: string; item: { summary: string; start: string | null; end: string | null; hard: boolean } }
    | { type: "remove"; key: string };

/** heal 补行已随 petal items 退役（期 4）：拖动行恒从块读面组装，块真身即行 */

/** 稳定键版 add（sloop □5 冻结链：同 key 已存在=幂等覆盖——重试/重复冻结不产重复 chip） */
export type SchedAddKeyOp = { type: "add"; day: string; key: string; item: { summary: string; start: string | null; end: string | null; hard: boolean } };

// ── 时间小工具 ──

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 形态+真实存在双重校验（2026-13-99 形态对但非真日）；工具入参校验共用 */
export function isValidDay(d: unknown): boolean {
    if (typeof d !== "string" || !DAY_RE.test(d)) return false;
    const y = Number(d.slice(0, 4));
    const m = Number(d.slice(5, 7));
    const day = Number(d.slice(8, 10));
    const t = new Date(y, m - 1, day);
    return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === day;
}

export function isValidHM(hm: unknown): boolean {
    return typeof hm === "string" && HM_RE.test(hm);
}

export function hmToMin(hm: string): number {
    return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
}

export function minToHM(m: number): string {
    const c = Math.max(0, Math.min(24 * 60 - 1, Math.round(m)));
    return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
}

/** 有符号圆周分钟差（折进 [-720,720)）：睡锚横跨午夜——23:50→00:10 实际漂 20 分钟而非
 *  提前 23h40m（sloop □8 review P1-1；呈现与阈值都用它） */
export function circDeltaMin(from: number, to: number): number {
    const raw = to - from;
    return (((raw + 720) % 1440) + 1440) % 1440 - 720;
}

/** 条目键生成（now 注入可测） */
export function genSchedKey(now: Date = new Date()): string {
    return `s${now.getTime().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

/** 归一已随 items 退役（期 4）：块读面的行归一见 core/schedboard normalizeBoardItems */

/** 辅助档宽容归一（drags/recon/prefs/lastRollDay；旧档 items 读入后丢弃） */
export function normalizeSchedule(raw: any): SchedStore {
    // 旧档 items（期 4 前的班表行）宽容读入后丢弃——块=唯一真身，petal 行不再消费
    const drags: DragRecord[] = Array.isArray(raw?.drags)
        ? raw.drags.filter(
              (d: any) =>
                  d &&
                  typeof d.key === "string" &&
                  typeof d.summary === "string" &&
                  isValidDay(d.day) &&
                  d.from && d.to && typeof d.at === "string",
          )
        : [];
    const recon: Record<string, ReconRecord> = {};
    if (raw?.recon && typeof raw.recon === "object" && !Array.isArray(raw.recon)) {
        for (const [day, rec] of Object.entries<any>(raw.recon)) {
            if (!isValidDay(day) || !rec || !Array.isArray(rec.results)) continue;
            recon[day] = {
                day,
                at: typeof rec.at === "string" ? rec.at : "",
                results: rec.results
                    .filter((r: any) => r && typeof r.key === "string" && ["done", "missed", "unknown"].includes(r.verdict))
                    .map((r: any) => ({
                        key: r.key,
                        summary: typeof r.summary === "string" ? r.summary : "",
                        verdict: r.verdict as ReconVerdict,
                        ...(typeof r.note === "string" && r.note ? { note: r.note } : {}),
                    })),
            };
        }
    }
    const prefs: SchedPref[] = Array.isArray(raw?.prefs)
        ? raw.prefs.filter((p: any) => p && typeof p.id === "string" && typeof p.text === "string" && p.text.trim())
        : [];
    return {
        version: 1,
        drags,
        recon,
        prefs,
        lastRollDay: isValidDay(raw?.lastRollDay) ? raw.lastRollDay : null,
    };
}

/** 日班表块真身行（rpc 读回形态：BoardReadItem 的核心字段） */
export interface BoardDayRow {
    key: string;
    summary: string;
    start: string | null;
    end: string | null;
    hard: boolean;
    origin: SchedItem["origin"];
    allDay?: boolean;
    /** 期 3 闪卡波次（块真身读面透传——微调联动须把 blocks 清单带回 rpc） */
    flash?: FlashWaveMeta;
}

/** 块读行 → SchedItem（期 4 消费面桥：晨滚/对账/守卫等吃行数组的纯层，块读面喂参用）。
 *  createdAt/updated 等机器态缺省（块面无此概念——updated 由内核内容事务另行维护）。 */
export function boardRowsToItems(day: string, rows: BoardDayRow[], now: Date = new Date()): SchedItem[] {
    const at = now.toISOString();
    return rows.map((b) => ({
        key: b.key, date: day, summary: b.summary, start: b.start, end: b.end, hard: b.hard, origin: b.origin,
        ...(b.allDay ? { allDay: true } : {}), ...(b.flash ? { flash: b.flash } : {}),
        createdAt: at, updatedAt: at,
    }));
}

/** 以块真身为基底的日终态组装（tb2c 破案起块即基底；期 4 起 petal 行退役——机器字段
 *  （rolledFrom/createdAt）随块往返由 attrs 承载或取缺省）。
 *  boardRows=rpc 块真身（时刻/文案真值）；overrides=本轮编辑后的目标行（终态，优先）；
 *  excludes=本轮删除的 key。产出：target=落块终态（块真身+overrides−excludes）。 */
export function mergeBoardDayRows(
    day: string,
    boardRows: BoardDayRow[],
    overrides: SchedItem[] = [],
    excludes: ReadonlySet<string> = new Set(),
    now: Date = new Date(),
): { target: SchedItem[] } {
    const seen = new Set<string>();
    const target: SchedItem[] = [];
    const emit = (row: SchedItem) => {
        if (excludes.has(row.key) || seen.has(row.key)) return;
        seen.add(row.key);
        target.push(row);
    };
    // 本轮编辑终态先占位（override 优先于块真身——同 key 去重保留编辑结果）
    for (const o of overrides) emit(o);
    // 块真身为基底
    const at = now.toISOString();
    for (const b of boardRows) {
        emit({ key: b.key, date: day, summary: b.summary, start: b.start, end: b.end, hard: b.hard, origin: b.origin,
            ...(b.allDay ? { allDay: true } : {}), ...(b.flash ? { flash: b.flash } : {}), createdAt: at, updatedAt: at });
    }
    target.sort((a, b2) => (a.start ?? "99").localeCompare(b2.start ?? "99"));
    return { target };
}

/** 辅助档滚动剪枝（期 4：items 数据面已退役，只剪 recon/drags）；无变化返原引用 */
export function pruneSchedule(store: SchedStore, today: string): SchedStore {
    const reconCut = shiftDay(today, -(SCHEDULE_KEEP_DAYS - 1));
    const dragCut = shiftDay(today, -(DRAG_KEEP_DAYS - 1));
    const recon: Record<string, ReconRecord> = {};
    let reconChanged = false;
    for (const [d, rec] of Object.entries(store.recon)) {
        if (d >= reconCut) recon[d] = rec;
        else reconChanged = true;
    }
    const drags = store.drags.filter((d) => d.day >= dragCut);
    if (!reconChanged && drags.length === store.drags.length) return store;
    return { ...store, recon, drags };
}

/** □26 崩盘重排细粒度清场（纯；期 4 块化签名——吃当日行数组）：清 start≥fromHM 的行再写
 *  ——「从 now 起不重排全天」。已过条目保留=对账证据；未定时条目（start=null 托盘）不动
 *  （replace 才清全天）；adopt 条目跳过（外部承诺=固定锚点，AI 重排无权清）。
 *  无一命中返原数组引用。cleared=被清行本体。 */
export function clearDayRows(
    rows: SchedItem[],
    fromHM: string,
): { rows: SchedItem[]; cleared: SchedItem[] } {
    const cleared = rows.filter((it) => it.start != null && it.start >= fromHM && it.origin !== "adopt");
    if (!cleared.length) return { rows, cleared };
    const cut = new Set(cleared.map((c) => c.key));
    return { rows: rows.filter((it) => !cut.has(it.key)), cleared };
}

// ── 晨间断签自愈（设计档 §2 红线：不追责、不做 streak） ──

/** 晨间滚动裁决（纯；期 4 块化签名——输入=块读面行数组，产物=今日新行清单由编排层落块）：
 *  昨晚交接会没开（断签）→昨日计划自动顺延到今天。
 *  - lastRollDay=今天 → 已跑过，null
 *  - 今天已有班表 → 用户/ AI 已安排，null（不重复滚动）
 *  - 昨日无条目 → 没东西可滚，null（且不记 rollDay——保持零写，下轮再查无害）
 *  - 昨日有条目 → 滚动：跳过昨日对账已判 done 的条目（达成的不必重排）与 adopt（外部承诺
 *    不滚动），其余逐条生成今日新行（origin=roll、rolledFrom 记血缘、时刻原样；key=临时键，
 *    落块后由 keyRemap 迁成块 id） */
export interface MorningRollInput {
    today: string;
    lastRollDay: string | null;
    todayRows: SchedItem[];
    yesterdayRows: SchedItem[];
    /** 昨日对账已判 done 的条目键集 */
    yesterdayDoneKeys: ReadonlySet<string>;
}

export function morningRollBoard(
    input: MorningRollInput,
    now: Date = new Date(),
): { rolled: SchedItem[]; rollDay: string } | null {
    const { today, lastRollDay, todayRows, yesterdayRows, yesterdayDoneKeys } = input;
    if (lastRollDay === today) return null;
    if (todayRows.length > 0) return null;
    const yesterday = shiftDay(today, -1);
    const yItems = yesterdayRows
        .filter((i) => i.date === yesterday)
        .sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99"));
    if (!yItems.length) return null;
    const rolled: SchedItem[] = [];
    const at = now.toISOString();
    for (const y of yItems) {
        if (yesterdayDoneKeys.has(y.key)) continue;
        if (y.origin === "adopt") continue; // 外部承诺不滚动（滚=新条目建新事件，原事件留昨日=日历两份）
        const key = genSchedKey(now);
        rolled.push({ ...y, key, date: today, origin: "roll", rolledFrom: y.key, createdAt: at, updatedAt: at });
    }
    return { rolled, rollDay: today };
}

// ── 对账三态（幕一：AI 预填对账单——行为证据兜底，不逼汇报） ──

/** 标题匹配（启发式）：归一（小写+去空白标点）后双向包含，或存在 ≥2 字公共子串。
 *  标题都很短，朴素滑窗够用；匹配≠定论——对账单带证据原文，AI/用户可纠正 */
function normText(s: string): string {
    return (s ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function titlesMatch(a: string, b: string): boolean {
    const x = normText(a);
    const y = normText(b);
    if (!x || !y) return false;
    if (x.includes(y) || y.includes(x)) return true;
    const minLen = 2;
    for (let i = 0; i + minLen <= x.length; i++) {
        if (y.includes(x.slice(i, i + minLen))) return true;
    }
    return false;
}

/** 对账条目（预填形态：交接会提示词/AI routine.recon 消费） */
export interface ReconItem {
    key: string;
    summary: string;
    start: string | null;
    end: string | null;
    hard: boolean;
    origin: SchedItem["origin"];
    verdict: ReconVerdict;
    /** 证据原文（给人看的短句；unknown 通常为空） */
    evidence: string[];
}

/** 三态判定。规则序（先命中先赢）：
 *  ① 勾选完成的到期任务与标题匹配 → done
 *  ② 今日编辑/停留的文档标题匹配 → done（分钟数进证据）
 *  ③ 到期未勾任务匹配 → missed
 *  ④ 时段已过（过去日全过；当日按 end??start 与 now 比）且无正面证据 → missed
 *  ⑤ 其余 → unknown（AI 问） */
export function buildRecon(items: SchedItem[], profile: DayProfile | null, today: string, nowHM: string): ReconItem[] {
    const sorted = [...items].sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99"));
    return sorted.map((it) => {
        const evidence: string[] = [];
        const dayOver = it.date < today;
        const slotPassed = dayOver || (it.date === today && hmToMin(it.end ?? it.start ?? "23:59") <= hmToMin(nowHM));

        // ① 勾选完成的任务（先找 done——同名一勾一未勾，完成的算数）
        const doneTask = profile?.tasks.find((t) => t.done && titlesMatch(t.title, it.summary));
        if (doneTask) {
            evidence.push(`任务勾选完成：${doneTask.title}`);
            return { key: it.key, summary: it.summary, start: it.start, end: it.end, hard: it.hard, origin: it.origin, verdict: "done", evidence };
        }
        // ② 文档触达（编辑量>0 或停留≥1 分钟）
        const doc = profile?.docs.find((d) => d.edits > 0 && titlesMatch(d.title, it.summary));
        if (doc) {
            evidence.push(`今日编辑《${doc.title}》（约 ${doc.edits} 次改动）`);
            return { key: it.key, summary: it.summary, start: it.start, end: it.end, hard: it.hard, origin: it.origin, verdict: "done", evidence };
        }
        const stay = profile?.stays.find((s) => s.seconds >= 60 && titlesMatch(s.title, it.summary));
        if (stay) {
            evidence.push(`在《${stay.title}》停留 ${Math.round(stay.seconds / 60)} 分钟`);
            return { key: it.key, summary: it.summary, start: it.start, end: it.end, hard: it.hard, origin: it.origin, verdict: "done", evidence };
        }
        // ③ 到期未勾任务
        const undone = profile?.tasks.find((t) => !t.done && titlesMatch(t.title, it.summary));
        if (undone) {
            evidence.push(`任务到期未勾选：${undone.title}`);
            return { key: it.key, summary: it.summary, start: it.start, end: it.end, hard: it.hard, origin: it.origin, verdict: "missed", evidence };
        }
        // ④ 时段已过且零相关记录
        if (slotPassed && it.start) {
            evidence.push("时段已过，没看到相关记录");
            return { key: it.key, summary: it.summary, start: it.start, end: it.end, hard: it.hard, origin: it.origin, verdict: "missed", evidence };
        }
        // ⑤ 无证据才问
        return { key: it.key, summary: it.summary, start: it.start, end: it.end, hard: it.hard, origin: it.origin, verdict: "unknown", evidence };
    });
}

// ── 拖动落账 ──

/** 拖动改时刻（纯；期 4 行版——行来自当日块读面）：保时长平移（无 end=只挪 start；
 *  托盘=清 start/end）；落 DragRecord（辅助档，交接会待确认的数据源）。
 *  to.start=null → 入托盘；to.start=HH:mm → 挪到该时刻（end 随时长平移，越界钳 23:59） */
export function applyDragRow(
    it: SchedItem,
    to: { start: string | null; end?: string | null },
    now: Date = new Date(),
): { row: SchedItem; drag: DragRecord } | null {
    const dur = it.start && it.end ? hmToMin(it.end) - hmToMin(it.start) : null;
    const start = isValidHM(to.start) ? (to.start as string) : null;
    let end: string | null = null;
    if (start) {
        // 保时长平移（minToHM 钳 23:59；无时长=显式 end 或落空）
        end = dur != null ? minToHM(hmToMin(start) + dur) : isValidHM(to.end) ? (to.end as string) : null;
        if (end && hmToMin(end) <= hmToMin(start)) end = null;
    }
    const row = { ...it, start, end, updatedAt: now.toISOString() };
    const drag: DragRecord = {
        key: it.key,
        summary: it.summary,
        day: it.date,
        from: { start: it.start, end: it.end },
        to: { start, end },
        at: now.toISOString(),
    };
    return { row, drag };
}

/** 拖动位移的人类可读描述（交接会提示词/待确认区共用） */
export function describeDrag(d: DragRecord): string {
    const f = d.from.start ?? "未定时";
    const t = d.to.start ?? "未定时";
    return `${d.summary}：${f} → ${t}`;
}

// ── 对账落账（幕五收尾：recon_record 消费当日拖动=待确认清单清空） ──

export function recordRecon(
    store: SchedStore,
    day: string,
    results: ReconSettled[],
    now: Date = new Date(),
): SchedStore {
    const rec: ReconRecord = { day, at: now.toISOString(), results };
    const drags = store.drags.filter((d) => d.day !== day);
    return { ...store, recon: { ...store.recon, [day]: rec }, drags };
}

/** 长期偏好追加（拖动点头/口述沉淀；幂等：同文已存在=原档） */
export function addPref(store: SchedStore, text: string, origin: SchedPref["origin"], now: Date = new Date()): SchedStore {
    const t = text.trim();
    if (!t) return store;
    if (store.prefs.some((p) => p.text === t)) return store;
    return { ...store, prefs: [...store.prefs, { id: genSchedKey(now), text: t.slice(0, 200), origin, at: now.toISOString() }] };
}

/** 交接会待开判定（角标；期 4 签名：对账态取辅助档、当日班表取块读行）：
 *  当日无对账记录且（已入夜 或 当日班表时段已全过） */
export function handoffDue(store: SchedStore, todayRows: SchedItem[], today: string, nowHM: string): boolean {
    if (store.recon[today]) return false;
    if (!todayRows.length) return false;
    return hmToMin(nowHM) >= 18 * 60 || todayRows.every((i) => i.start && hmToMin(i.end ?? i.start) <= hmToMin(nowHM));
}
