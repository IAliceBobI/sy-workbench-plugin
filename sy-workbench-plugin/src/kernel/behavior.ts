// 作息训练·期 1（sloop □3）：数据源采集层·编排层。
// 六路 kernel 自采（①日记②闪念③停留[前端推]④外来日历⑤自家记录⑥历法⑦留位）
// → buildDayProfile 一次成型 → 当日稿只驻内存 → 日终冻结落盘（petal 写=天级，零重载风暴）。
// 副作用全走 api/feishu 客户端层（单测 mock 边界）；纯决策在 core/behavior。
// 触发源=kernel onrunning 启动兜底 + rpc behavior-collect（前端 hourlyTimer 搭车）。
import { petalGetJsonFresh, post, sql, storageGetJson, storagePutJson } from "./api";
import { kernelLog } from "./loki";
import { getLogicalDay } from "./core/dates";
import {
    BEHAVIOR_PROFILE_FILE,
    CALENDAR_MIRROR_FILE,
    CALENDAR_MIRROR_META_FILE,
    LEDGER_FILE,
} from "../shared/channels";
import { normalizeLedger } from "./core/ledger";
import { emptyMirror, normalizeMeta, normalizeMirror, type MirrorEvent } from "./core/calendarMirror";
import { ATTR_PROJECT_STATUS, TASK_ATTRS } from "./core/schema";
import { dayAlmanac } from "../lunarInfo";
import {
    buildDayProfile,
    daysToFreeze,
    normalizeArchive,
    pruneArchive,
    shiftDay,
    type CalEventBrief,
    type DayProfile,
    type DocRow,
    type DocStay,
    type RemindDue,
    type RootAggRow,
    type TaskDue,
} from "./core/behavior";
import { listRemindBlocksSql, parseRemindAt, parseRemindRepeat, todayIsOccurrence } from "./core/remind";
// 番茄账本层随自建钟退役迁桥（bear 09-20「去自建钟用番茄工具箱」）：log 形态/归一/日聚合
// 原样迁 src/gui/pomoBridge.ts（纯函数零依赖，kernel/前端共用同一份源——摇树翻转红线）
import { normalizePomoLog, pomoDayAgg } from "../gui/pomoBridge";
import { POMODORO_LOG_FILE } from "../shared/channels";

export interface BehaviorLogger {
    info: (msg: string, ...rest: unknown[]) => unknown;
    error: (msg: string, ...rest: unknown[]) => unknown;
}

export interface CollectResult {
    ok: boolean;
    day: string;
    docs: number;
    frozen: number;
    error?: string;
}

// ── 内存态（goja 无模块缓存顾虑：进程生命周期即数据生命周期） ──

/** 当日+近日画像（当日进行稿只驻内存——落盘留给日终冻结/onunload） */
const profiles = new Map<string, DayProfile>();
/** 前端 tracker 推的停留快照（day→entries；幂等覆盖） */
const stayStore = new Map<string, DocStay[]>();
/** 日记 box（/api/conf 抖一次，挂实例生命周期缓存） */
let diaryBoxCache: string | null | undefined;

/** 日记 box id（/api/system/getConf 抖一次挂实例缓存）。
 *  ⚠️ 已知失效（sloop □6 review P1-1 核实）：conf.dailyNote.notebookPath 在 3.8.3 内核
 *  getConf 返回中不存在（AppConf 结构体无该字段）——本函数恒 null，仅 □3 sources.diary
 *  健康度记录在用（docKind 的 diary 桶恒不命中=既有现状，修复归作息训练后续期/队列）。 */
async function fetchDiaryBox(): Promise<string | null> {
    if (diaryBoxCache !== undefined) return diaryBoxCache;
    // 真实端点=POST /api/system/getConf（GET /api/conf 404；data 内还包一层 conf——api.md 实锤）
    const json = await post("/api/system/getConf", {});
    const box = json?.conf?.dailyNote?.notebookPath;
    diaryBoxCache = typeof box === "string" ? box : null;
    // 失败=throw 不缓存（外层记 sources.diary=error，下轮重试）；成功含 null 都缓存
    return diaryBoxCache;
}

// ── 八路采集（单路失败记 sources 健康度，不炸整轮） ──

async function collectOneDay(day: string, now: Date): Promise<DayProfile> {
    const sources: Record<string, string> = {};
    const d14 = day.replace(/-/g, "") + "000000";

    // ①②⑤ 今日动过的文档 + root 聚合（小时直方图+近似编辑量）+ created 聚合
    let docs: DocRow[] = [];
    let rootAggs: RootAggRow[] = [];
    let createdCounts = new Map<string, number>();
    try {
        docs = (await sql<DocRow>(
            `SELECT id, box, path, hpath, content, created, updated FROM blocks WHERE type='d' AND (created >= '${d14}' OR updated >= '${d14}')`,
        )).map((r) => ({ ...r, path: r.path ?? "", box: r.box ?? "", hpath: r.hpath ?? "", content: r.content ?? "" }));
        rootAggs = await sql<RootAggRow>(
            `SELECT root_id, substr(updated, 9, 2) AS h, count(*) AS n FROM blocks WHERE updated >= '${d14}' GROUP BY root_id, substr(updated, 9, 2)`,
        );
        const createdRows = await sql<{ root_id: string; n: number }>(
            `SELECT root_id, count(*) AS n FROM blocks WHERE created >= '${d14}' GROUP BY root_id`,
        );
        createdCounts = new Map(createdRows.map((r) => [r.root_id, Number(r.n)]));
        sources.docs = docs.length ? "ok" : "empty";
    } catch (e: any) {
        sources.docs = `error:${String(e?.message ?? e).slice(0, 80)}`;
    }
    const createdDocIds = new Set(docs.filter((d) => (d.created ?? "") >= d14).map((d) => d.id));

    // ② 闪念速记 + ⑤ 项目主文档（attributes 属性集识别）
    let fastnoteIds = new Set<string>();
    let projectIds = new Set<string>();
    let projectTitles = new Map<string, string>();
    try {
        const fnRows = await sql<{ block_id: string }>(`SELECT block_id FROM attributes WHERE name='custom-fastnote'`);
        fastnoteIds = new Set(fnRows.map((r) => r.block_id));
        const pjRows = await sql<{ id: string; title: string }>(
            `SELECT a.block_id AS id, b.content AS title FROM attributes a JOIN blocks b ON b.id=a.block_id WHERE a.name='${ATTR_PROJECT_STATUS}'`,
        );
        projectIds = new Set(pjRows.map((r) => r.id));
        projectTitles = new Map(pjRows.map((r) => [r.id, r.title ?? ""]));
        sources.attrs = "ok";
    } catch (e: any) {
        sources.attrs = `error:${String(e?.message ?? e).slice(0, 80)}`;
    }

    // ⑤ 今日到期任务（due-date=day；done=markdown 头部勾选态；dueTime 伴生属性 LEFT JOIN）
    let tasks: TaskDue[] = [];
    try {
        tasks = (await sql<{ id: string; rootId: string; title: string; markdown: string; dueTime: string | null }>(
            `SELECT a.block_id AS id, b.root_id AS rootId, b.content AS title, b.markdown AS markdown, t.value AS dueTime
            FROM attributes a
            LEFT JOIN attributes t ON t.block_id = a.block_id AND t.name='${TASK_ATTRS.dueTime}'
            JOIN blocks b ON b.id = a.block_id
            WHERE a.name='${TASK_ATTRS.dueDate}' AND a.value='${day}'`,
        )).map((r) => ({
            blockId: r.id,
            // content 列任务块带「- [ ] 」标记尾巴（remind payload 同款清理正则）
            title: String(r.title ?? "").replace(/^\s*[-*+]\s*\[[ xX]\]\s*/, "").trim(),
            done: /^\s*[-*+]\s*\[[xX]\]/.test(r.markdown ?? ""),
            dueTime: /^\d{2}:\d{2}$/.test(r.dueTime ?? "") ? r.dueTime : null,
            rootId: r.rootId ?? "",
        }));
        sources.tasks = tasks.length ? "ok" : "empty";
    } catch (e: any) {
        sources.tasks = `error:${String(e?.message ?? e).slice(0, 80)}`;
    }

    // ⑤ 画像日应触发提醒（全量拉回 kernel 过滤；「今日」按画像日判——昨日重建语义同构）
    let reminders: RemindDue[] = [];
    try {
        const dayDate = new Date(day + "T12:00:00"); // 正午防 DST 日界边缘
        const sameYMD = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
        const rows = await sql<{ id: string; at: string; repeat: string | null; content: string }>(listRemindBlocksSql());
        reminders = rows
            .filter((r) => {
                const at = parseRemindAt(r.at ?? "");
                if (!at) return false;
                const rp = r.repeat ? parseRemindRepeat(r.repeat) : null;
                if (r.repeat && !rp) return false; // 脏 repeat 值跳过
                if (!rp) return sameYMD(at, dayDate); // 单次=at 落在画像日
                return todayIsOccurrence(r.at, rp, dayDate); // 循环=画像日是触发日
            })
            .map((r) => {
                const at = parseRemindAt(r.at ?? "")!;
                const p = (n: number) => String(n).padStart(2, "0");
                return { blockId: r.id, title: r.content ?? "", at: `${p(at.getHours())}:${p(at.getMinutes())}`, repeat: r.repeat ?? null };
            });
        sources.reminders = reminders.length ? "ok" : "empty";
    } catch (e: any) {
        sources.reminders = `error:${String(e?.message ?? e).slice(0, 80)}`;
    }

    // ④⑤ 日历事件：镜像∩今日窗 - 账本 eventId 集=外来；∩=自己（remind/task/burden/weather 全进账本）
    let calendar: CalEventBrief[] = [];
    try {
        // goja 保守：串行读（本地 petal 读，延迟无感；storageGetJson 自带 catch→null）
        const mirrorRaw = await storageGetJson(CALENDAR_MIRROR_FILE);
        const metaRaw = await storageGetJson(CALENDAR_MIRROR_META_FILE);
        const ledgerRaw = await storageGetJson(LEDGER_FILE);
        // normalizeMirror 缺档可返 null（calendarMirror.ts 主流程 prevMirror?.events 可选链同防）→empty 兜底
        const mirror = normalizeMirror(mirrorRaw) ?? emptyMirror();
        const meta = normalizeMeta(metaRaw);
        const ledger = normalizeLedger(ledgerRaw);
        const ownEventIds = new Set(Object.values(ledger.entries).map((e) => e.eventId).filter(Boolean));
        const calName = (id: string) => meta.catalog.find((c) => c.id === id)?.summary || id.slice(0, 8);
        // 循环主事件不展开（实例走 instance 通道，期 4 对账再接）；跨天事件按 start 日（月历 v1 同语义）
        calendar = Object.values(mirror.events)
            .filter((e: MirrorEvent) => !e.recurring && e.start.slice(0, 10) === day)
            .map((e: MirrorEvent) => ({
                summary: e.summary,
                start: e.start,
                end: e.end,
                allDay: e.allDay,
                cal: calName(e.cal),
                own: ownEventIds.has(e.id),
            }));
        sources.calendar = calendar.length ? "ok" : "empty";
    } catch (e: any) {
        sources.calendar = `error:${String(e?.message ?? e).slice(0, 80)}`;
    }

    // ① 日记 box + ⑥ 历法
    let diaryBox: string | null = null;
    try {
        diaryBox = await fetchDiaryBox();
        sources.diary = diaryBox ? "ok" : "empty";
    } catch (e: any) {
        sources.diary = `error:${String(e?.message ?? e).slice(0, 80)}`;
    }
    const alm = dayAlmanac(day);
    sources.almanac = alm.lunarText ? "ok" : "empty";

    // ③ 停留=前端快照（behavior-stay 推送；kernel 侧零补采能力——switch-protyle 是纯前端事件）
    const stays = stayStore.get(day) ?? [];
    sources.stays = stays.length ? "ok" : "empty";
    sources.goal = "reserved"; // ⑦ 期 7 落地

    // ⑧ 番茄=前端 log 档直读聚合（getFile 绕 kernel storage 缓存恒新鲜；深度块锚点证据=完成数）
    let pomodoros = { count: 0, minutes: 0 };
    try {
        pomodoros = pomoDayAgg(normalizePomoLog(await petalGetJsonFresh(POMODORO_LOG_FILE)), day);
        sources.pomodoros = pomodoros.count ? "ok" : "empty";
    } catch (e: any) {
        sources.pomodoros = `error:${String(e?.message ?? e).slice(0, 80)}`;
    }

    return buildDayProfile({
        day,
        collectedAt: now.toISOString(),
        docs,
        createdDocIds,
        rootAggs,
        createdCounts,
        fastnoteIds,
        projectIds,
        projectTitles,
        diaryBox,
        stays,
        calendar,
        reminders,
        tasks,
        almanac: { lunarText: alm.lunarText, off: alm.off, work: alm.work },
        pomodoros,
        sources,
    });
}

// ── 冻结与落盘 ──

/** 日终冻结：≤前天的内存过去日写盘（昨日跳过本轮给前端 stay 推送留窗）；整档比对防抖 */
async function freezePastDays(today: string, logger: BehaviorLogger): Promise<number> {
    const freeze = daysToFreeze([...profiles.keys()], today);
    if (!freeze.length) return 0;
    const prev = normalizeArchive(await storageGetJson(BEHAVIOR_PROFILE_FILE).catch(() => null));
    const days = { ...prev.days };
    for (const d of freeze) days[d] = profiles.get(d)!;
    const next = pruneArchive({ version: 1, days }, today);
    if (JSON.stringify(next) === JSON.stringify(prev)) {
        for (const d of freeze) profiles.delete(d);
        return 0;
    }
    await storagePutJson(BEHAVIOR_PROFILE_FILE, next);
    for (const d of freeze) profiles.delete(d);
    kernelLog("sloop", `behavior 冻结 ${freeze.join(",")} 落盘`);
    logger.info(`[behavior] 冻结 ${freeze.length} 日落盘`);
    return freeze.length;
}

export async function runBehaviorCollect(logger: BehaviorLogger, now: Date = new Date()): Promise<CollectResult> {
    const day = getLogicalDay(now);
    try {
        // 启动兜底：盘上缺昨日（昨晚思源没开）→ SQL 重建（stay 由前端 onload flushAll 补推）
        const archive = normalizeArchive(await storageGetJson(BEHAVIOR_PROFILE_FILE).catch(() => null));
        const yesterday = shiftDay(day, -1);
        if (!archive.days[yesterday] && !profiles.has(yesterday)) {
            try {
                profiles.set(yesterday, await collectOneDay(yesterday, now));
                kernelLog("sloop", `behavior 启动重建昨日画像 ${yesterday}`);
            } catch (e: any) {
                logger.error(`[behavior] 昨日重建失败（无碍正事）: ${String(e?.message ?? e).slice(0, 120)}`);
            }
        }
        const profile = await collectOneDay(day, now);
        profiles.set(day, profile);
        const frozen = await freezePastDays(day, logger);
        logger.info(`[behavior] ${day} 采集完成: 文档 ${profile.docs.length}，停留 ${profile.stays.length}，日历 ${profile.calendar.length}，冻结 ${frozen}`);
        return { ok: true, day, docs: profile.docs.length, frozen };
    } catch (e: any) {
        const msg = String(e?.message ?? e);
        logger.error(`[behavior] ${day} 采集失败: ${msg.slice(0, 160)}`);
        return { ok: false, day, docs: 0, frozen: 0, error: msg.slice(0, 200) };
    }
}

// ── 串行守卫（remind 同款）：goja 无 setTimeout、SQL/IO 慢轮不叠 ──

let inFlight = false;
let inFlightSince = 0;
let pending = false;
const INFLIGHT_DEADLOCK_MS = 10 * 60_000;

export async function runBehaviorCollectGuarded(logger: BehaviorLogger, now: Date = new Date()): Promise<CollectResult | null> {
    if (inFlight && Date.now() - inFlightSince < INFLIGHT_DEADLOCK_MS) {
        pending = true;
        return null;
    }
    inFlight = true;
    inFlightSince = Date.now();
    try {
        let last: CollectResult | null = null;
        do {
            pending = false;
            last = await runBehaviorCollect(logger, now);
        } while (pending);
        return last;
    } finally {
        inFlight = false;
    }
}

/** onunload 尽力冻结：内存全部日（含当日进行稿）写盘——退出/重载路径 dataChanges 广播无害 */
export async function persistBehaviorOnUnload(): Promise<void> {
    if (!profiles.size) return;
    try {
        const today = getLogicalDay(new Date());
        const prev = normalizeArchive(await storageGetJson(BEHAVIOR_PROFILE_FILE).catch(() => null));
        const days = { ...prev.days };
        for (const [d, p] of profiles) days[d] = p;
        const next = pruneArchive({ version: 1, days }, today);
        if (JSON.stringify(next) !== JSON.stringify(prev)) {
            await storagePutJson(BEHAVIOR_PROFILE_FILE, next);
        }
    } catch {
        // 尽力而为：写失败丢当日进行稿（六路可重建），无碍
    }
}

// ── rpc handlers（kernel.ts 绑定） ──

/** 前端 tracker 停留快照（幂等覆盖；只收当日+昨日——更旧=已冻结日拒收） */
export async function handleStayReport(params: any): Promise<{ ok: boolean; frozen?: boolean }> {
    const day = String(params?.day ?? "");
    const today = getLogicalDay(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < shiftDay(today, -1)) return { ok: false };
    const entries = Array.isArray(params?.entries) ? params.entries : [];
    const stays: DocStay[] = entries
        .filter((e: any) => typeof e?.id === "string" && Number.isFinite(Number(e?.seconds)))
        .map((e: any) => ({
            id: e.id,
            title: String(e.title ?? ""),
            seconds: Math.max(0, Math.floor(Number(e.seconds))),
            sessions: Math.max(0, Math.floor(Number(e.sessions ?? 0))),
        }));
    stayStore.set(day, stays);
    const p = profiles.get(day);
    if (p) {
        p.stays = [...stays].sort((a, b) => b.seconds - a.seconds);
        p.collectedAt = new Date().toISOString();
        p.sources.stays = stays.length ? "ok" : "empty";
    }
    return { ok: true };
}

/** 读画像（内存优先盘兜底；缺省=当日） */
export async function handleGetProfile(params: any): Promise<{ ok: boolean; profile: DayProfile | null }> {
    const today = getLogicalDay(new Date());
    const day = typeof params?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : today;
    const mem = profiles.get(day);
    if (mem) return { ok: true, profile: mem };
    const archive = normalizeArchive(await storageGetJson(BEHAVIOR_PROFILE_FILE).catch(() => null));
    return { ok: true, profile: archive.days[day] ?? null };
}
