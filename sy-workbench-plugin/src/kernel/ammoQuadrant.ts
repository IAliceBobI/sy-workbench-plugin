// ammo □4：每日象限配置编排层（kernel 侧）——「弹性任务退役时刻表→配弹药」的写入半边。
// 契约=docs/ammo-concept.md B1.3（容器/行格式）/B1.2（今日位双写）/B4（守卫）/B1.5（分流）：
// - 位置=/主线数据/每日配置/<YYYY-MM>/（月度子文档，bounded 尺寸；月界日晚写的「明日」落
//   目标日语所在月——ensureDayDiary 三层建链同款：SQL hpath+树探针验活+幂等懒建）；
// - 容器=列表块挂 custom-role=ammo-dayconfig+custom-ammo-day=day；「## 日期」纯装饰缺失才补；
// - 写=容器级整组重放（diff：改属性+文本变化才 update/新增尾插/消失删）——幂等；
// - 任务行 task 非空→同步树任务块「今日位」属性（B1.2 挂载属性与配置行同源，只写不清——
//   摘除归 □5 交接会动作面）；
// - 守卫=guardDayConfig（knownTasks=森林任务块集合——AI 只能把弹药配给森林真实任务块）；
// - 森林侦察（plan_context 三源③）：树文档任务块（attributes JOIN——forestTasksSql 先例，
//   侦察原料非判向决策面）+「不想做」三类原话；
// - Daily Note 摘要（三源①）：SQL hpath 尾段日期启发式（conf.dailyNote.notebookPath 3.8.3
//   缺失=死代码不碰、boxConf 模板 Go 渲染前端不可算——日期尾匹配是零配置可用的最稳通道）；
// - 存量迁移：既有班表弹性行一次性转池配置（今天..+14；幂等=无弹性行零写）。
// 复用 schedboard 目录定位 locateRoot/ensureRoot（folder-model：三件套挂 /Project
// 目录；森林侦察的树源=目录一级项目文档，与三件套无关）；
// 串行链=boardWriteChain 同款模块级单飞链（独立链——森林域与日记域无交错面）。
// 错误兜底对齐 schedboard/ammoLedger：任何失败返回 {ok:false,error} 不 throw。
import {
    createDocWithMd,
    getChildBlocks,
    getBlockAttrs,
    insertBlockMarkdown,
    insertListItem,
    listDocsByPath,
    setBlockAttrs,
    sql,
    updateBlockMarkdown,
    deleteBlock,
} from "./api";
import { locateRoot, ensureRoot } from "./schedboard";
import { ROOT_HPATH, TRIPLET_NAMES, DAYCONFIG_NAME, AVERSION_NAME, LEGACY_MAINLINE_HPATH, LEGACY_SPLIT_HPATH } from "../shared/homePaths";
import {
    AMMO_POOL_SLUGS,
    AVERSION_KINDS,
    AVERSION_SECTION_TITLES,
    DAYCONFIG_ROLE_VALUE,
    guardDayConfig,
    isPoolSlug,
    migrateLegacyElastic,
    MIN_TAIL_RE,
    parseConfigRow,
    parsePoolRowText,
    parseConfigRows,
    poolRowAttrs,
    poolRowText,
    resolveAversionAnchors,
    taskRowAttrs,
    taskRowText,
    type AmmoDayConfig,
    type AmmoPoolRow,
    type AmmoPoolSlug,
    type AmmoTaskRow,
    type AversionFlatBlock,
    type AversionKind,
} from "./core/ammoQuadrant";
import type { HealthLineInput } from "./core/ammoHealth";
import { isValidDay } from "./core/schedule";
import { readDayItems } from "./schedule";
import { writeSchedBoardToDiary } from "./schedboard";
import { shiftDay } from "./core/behavior";
import { getLogicalDay } from "./core/dates";

/** 固定子文档三名（folder-model：TRIPLET_NAMES 单源——树文档与固定子文档互斥分流） */
const FIXED_SUBDOCS = new Set(TRIPLET_NAMES);

/** 建链缓存（防同轮连写撞 SQL 索引窗重复建层/月文档——kernel bundle 生命周期内有效） */
let layerIdCache: string | null = null;
const monthDocCache = new Map<string, string>();

/** 测试专用：清建链缓存（生产勿调） */
export function __resetAmmoQuadrantCaches(): void {
    layerIdCache = null;
    monthDocCache.clear();
}

/** 树真相验活探针（schedboard blockAlive 同款：删=code!=0 throw；勿用 getBlockAttrs——缓存恒吐旧值） */
async function blockAlive(id: string): Promise<boolean> {
    try {
        await getChildBlocks(id);
        return true;
    } catch {
        return false;
    }
}

/** 幂等懒建月度配置文档（ensureDayDiary 同款三层链） */
export async function ensureDayConfigDoc(day: string): Promise<{ ok: true; docId: string } | { ok: false; error: string }> {
    const month = day.slice(0, 7);
    const cached = monthDocCache.get(month);
    if (cached && (await blockAlive(cached))) return { ok: true, docId: cached };
    if (cached) monthDocCache.delete(month);
    const home = await ensureRoot();
    if ("error" in home) return { ok: false, error: `${home.error}——每日配置写入跳过` };
    const cfgBase = `${home.hpath ?? ROOT_HPATH}/${DAYCONFIG_NAME}`;
    let layerId = layerIdCache;
    if (layerId && !(await blockAlive(layerId))) layerId = null;
    if (!layerId) {
        const layerRows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${cfgBase}' AND box='${home.box}' LIMIT 1`);
        layerId = layerRows?.[0]?.id ?? null;
        if (!layerId) {
            layerId = await createDocWithMd(home.box, cfgBase, "", home.id);
        }
        layerIdCache = layerId;
    }
    const monthHpath = `${cfgBase}/${month}`;
    const docRows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${monthHpath}' AND box='${home.box}' LIMIT 1`);
    let docId = docRows?.[0]?.id ?? null;
    if (docId && !(await blockAlive(docId))) docId = null;
    if (!docId) docId = await createDocWithMd(home.box, monthHpath, "", layerId);
    monthDocCache.set(month, docId);
    return { ok: true, docId };
}

/** 只读定位月度配置文档（ensureDayConfigDoc 的读版——零建档，读通道零副作用） */
export async function locateDayConfigDoc(day: string): Promise<string | null> {
    const month = day.slice(0, 7);
    const cached = monthDocCache.get(month);
    if (cached && (await blockAlive(cached))) return cached;
    if (cached) monthDocCache.delete(month);
    const home = await locateRoot();
    if (!home) return null;
    const rows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${(home.hpath ?? ROOT_HPATH)}/${DAYCONFIG_NAME}/${month}' AND box='${home.box}' LIMIT 1`);
    const docId = rows?.[0]?.id ?? null;
    if (docId && !(await blockAlive(docId))) return null;
    if (docId) monthDocCache.set(month, docId);
    return docId;
}

/** 顶层找当日容器（IAL 直读判 role+day；月文档多月日组共存——逐组扫属性；顺带查「## day」标题） */
async function findConfigContainer(docId: string, day: string): Promise<{ containerId: string | null; hasTitle: boolean }> {
    const tops = await getChildBlocks(docId);
    let containerId: string | null = null;
    let hasTitle = false;
    for (const b of tops) {
        const attrs = await getBlockAttrs(b.id);
        if (attrs?.["custom-role"] === DAYCONFIG_ROLE_VALUE && attrs?.["custom-ammo-day"] === day) containerId = b.id;
        if (b.type === "h" && (b.content ?? "").trim() === day) hasTitle = true;
    }
    return { containerId, hasTitle };
}

/** 行键（diff 配对）：池行=P:slug；任务行 task 非空=T:id、无主行=U:name */
function rowKey(r: AmmoPoolRow | AmmoTaskRow): string {
    return "task" in r ? (r.task ? `T:${r.task}` : `U:${r.name}`) : `P:${r.pool}`;
}

/** 行文本读面认数（R2——写面判残留的判据=读面解析器本尊，判型序同 parseConfigRow：
 *  池文本优先（`黄金产出 · 保底 120min` 的数字在 · 后限定词段——parsePoolRowText 通道）；
 *  池形不认再认 `· Nmin$` 尾（任务行/无主行通道——MIN_TAIL_RE 同款尾形态）。两通道都认不出
 *  =文本无数字态（null）。 */
function readNumFromText(c: string): number | null {
    const pool = parsePoolRowText(c);
    if (pool) return pool.ratio;
    const tail = MIN_TAIL_RE.exec(c);
    return tail && Number(tail[1]) > 0 ? Number(tail[1]) : null;
}

/** 文本已达判定（宽容比对——真实内核块引用 content=渲染文本不带 ((id))，严格等值会恒失配
 *  每轮重写）：主体名在场+数字态对齐（读面认数===目标值）。任务名自带 min 字样（如「间歇跑
 *  30min 循环」）非 `· Nmin$` 尾形态不算残留——防每轮整组重放空转重写同文本，也防写读判据
 *  分叉致读面与终态漂移（R2：旧版全文任意 Nmin 字样判残留）。 */
function textSettled(current: string, name: string, num: number | null): boolean {
    const c = (current ?? "").replace(/\u200b/g, "").trim();
    if (!c) return false;
    if (name && !c.includes(name)) return false;
    return readNumFromText(c) === num;
}

/** 展平目标行（池行在前任务行在后——B1.3 行序惯例） */
function flatRows(config: AmmoDayConfig): Array<AmmoPoolRow | AmmoTaskRow> {
    return [...config.pools, ...config.tasks];
}

export interface DayConfigWriteResult {
    ok: boolean;
    docId?: string;
    containerId?: string;
    updated?: number;
    inserted?: number;
    deleted?: number;
    /** 守卫拦截明细（ok=false 且因守卫拒时在） */
    violations?: string[];
    error?: string;
}

/** 每日配置写串行链（boardWriteChain 同款）：重叠写排队防并发交错；失败吞 reject 不堵队列。 */
let configWriteChain: Promise<unknown> = Promise.resolve();
function configWriteChainRun<T>(task: () => Promise<T>): Promise<T> {
    const run = configWriteChain.then(task, task);
    configWriteChain = run.then(() => undefined, () => undefined);
    return run;
}

export type DayConfigWriteOptions = { knownTasks?: ReadonlySet<string> };

/**
 * 写当日配置（容器级整组重放=幂等；schedule_set 的 ammo 载荷与迁移共用）。
 * knownTasks 传入=守卫开（AI 写面）；缺省=不校验指针（内部复用面）。
 * 任务行 task 非空→同步树块「今日位」（B1.2 同源双写，只写不清——摘除归 □5）。 */
export function writeDayConfig(day: string, config: AmmoDayConfig, opts: DayConfigWriteOptions = {}): Promise<DayConfigWriteResult> {
    return configWriteChainRun(() => writeDayConfigInner(day, config, opts).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) })));
}

async function writeDayConfigInner(day: string, config: AmmoDayConfig, opts: DayConfigWriteOptions): Promise<DayConfigWriteResult> {
    if (config.day !== day) return { ok: false, error: `配置 day 不一致（${config.day} ≠ ${day}）` };
    const guard = guardDayConfig({ config, knownTasks: opts.knownTasks });
    if (!guard.ok) return { ok: false, violations: guard.violations, error: `每日配置守卫：${guard.violations.join("；")}` };
    const doc = await ensureDayConfigDoc(day);
    if ("error" in doc) return { ok: false, error: doc.error }; // strict:false 判别用 in（AGENTS 坑）
    const docId = doc.docId;
    const tops = await getChildBlocks(docId);
    const { containerId, hasTitle } = await findConfigContainer(docId, day);
    const targets = flatRows(config);
    /** 首建已落行键（keep 集合须含——schedboard keepIds 先例：首建/早插的行不在 targets
     *  里，漏算即被 diff 当消失项误删） */
    let firstBuiltKey: string | null = null;

    let container = containerId;
    let existing: Array<{ id: string; content: string | null; row: AmmoPoolRow | AmmoTaskRow }>;
    let updated = 0;
    let inserted = 0;
    let deleted = 0;

    if (!container) {
        if (!targets.length) return { ok: true, docId, updated: 0, inserted: 0, deleted: 0 };
        // 首建容器（首条插入建壳+挂 role）；容器插月文档尾（多日组时间序 append 姿态）
        const head = tops.length ? { previousID: tops[tops.length - 1].id } : {};
        const first = targets[0];
        const r0 = "task" in first
            ? await insertListItem(docId, `- ${taskRowText(first)}`, head)
            : await insertListItem(docId, `- ${poolRowText(first)}`, head);
        container = r0.containerId;
        await setBlockAttrs(container, { "custom-role": DAYCONFIG_ROLE_VALUE, "custom-ammo-day": day });
        await setBlockAttrs(r0.liId, "task" in first ? taskRowAttrs(first) : poolRowAttrs(first));
        if ("task" in first && first.task) await setBlockAttrs(first.task, { "custom-ammo-pool": first.pool, "custom-ammo-quota": first.quota != null ? String(first.quota) : "" });
        if (!hasTitle) await insertBlockMarkdown(docId, `## ${day}`, container); // 标题插容器前（纯装饰）
        inserted++;
        existing = [{ id: r0.liId, content: null, row: first }];
        firstBuiltKey = rowKey(first);
        targets.shift();
    } else {
        const lis = await getChildBlocks(container);
        existing = [];
        for (const li of lis) {
            const row = parseConfigRow(li.content, await getBlockAttrs(li.id));
            if (row) existing.push({ id: li.id, content: li.content, row });
        }
        // 容器已空（行全被清）：删壳走首建（空容器插 li 不并壳——schedboard 探针同族约束）
        if (!lis.length && targets.length) {
            await deleteBlock(container);
            const first = targets[0];
            const head = tops.filter((t) => t.id !== container).length ? { previousID: tops[tops.length - 1].id } : {};
            const r0 = "task" in first
                ? await insertListItem(docId, `- ${taskRowText(first)}`, head)
                : await insertListItem(docId, `- ${poolRowText(first)}`, head);
            container = r0.containerId;
            await setBlockAttrs(container, { "custom-role": DAYCONFIG_ROLE_VALUE, "custom-ammo-day": day });
            await setBlockAttrs(r0.liId, "task" in first ? taskRowAttrs(first) : poolRowAttrs(first));
            if ("task" in first && first.task) await setBlockAttrs(first.task, { "custom-ammo-pool": first.pool, "custom-ammo-quota": first.quota != null ? String(first.quota) : "" });
            if (!hasTitle) await insertBlockMarkdown(docId, `## ${day}`, container);
            inserted++;
            existing = [{ id: r0.liId, content: null, row: first }];
        firstBuiltKey = rowKey(first);
            targets.shift();
        }
    }

    // —— diff 重放：删（键不在终态∪首建集）→ 改（键命中：属性重挂+文本变化才 update）→ 增（尾插） ——
    const byKey = new Map(existing.map((e) => [rowKey(e.row), e]));
    const targetKeys = new Set(targets.map(rowKey));
    if (firstBuiltKey) targetKeys.add(firstBuiltKey); // 首建行防误删（keepIds 先例）
    const live: string[] = existing.map((e) => e.id);
    for (const e of existing) {
        if (targetKeys.has(rowKey(e.row))) continue;
        await deleteBlock(e.id);
        deleted++;
        live.splice(live.indexOf(e.id), 1);
    }
    for (const t of targets) {
        const isTask = "task" in t;
        const targetText = isTask ? taskRowText(t) : poolRowText(t);
        const cur = byKey.get(rowKey(t));
        if (cur) {
            const attrs = isTask ? taskRowAttrs(t) : poolRowAttrs(t);
            const settled = isTask
                ? textSettled(cur.content ?? "", t.name, t.quota)
                : textSettled(cur.content ?? "", poolRowText(t), t.ratio);
            if (!settled) await updateBlockMarkdown(cur.id, `- ${targetText}`);
            await setBlockAttrs(cur.id, attrs);
            if (isTask && t.task) await setBlockAttrs(t.task, { "custom-ammo-pool": t.pool, "custom-ammo-quota": t.quota != null ? String(t.quota) : "" });
            updated++;
        } else {
            const anchor = live.length ? { previousID: live[live.length - 1] } : {};
            const r = await insertListItem(docId, `- ${targetText}`, anchor);
            await setBlockAttrs(r.liId, isTask ? taskRowAttrs(t) : poolRowAttrs(t));
            if (isTask && t.task) await setBlockAttrs(t.task, { "custom-ammo-pool": t.pool, "custom-ammo-quota": t.quota != null ? String(t.quota) : "" });
            live.push(r.liId);
            inserted++;
        }
    }
    return { ok: true, docId, containerId: container, updated, inserted, deleted };
}

// ── dataview □5：单任务级/单池级写通道（拖卡调档面——整组重放的定点替代） ──

export interface TaskMoveInput {
    /** 树任务块 id（空串=无主行——按 name 匹配既有行） */
    task: string;
    /** 任务名（无主行匹配键+追加行文本原料） */
    name: string;
    pool: AmmoPoolSlug;
    /** 追加路径的任务级配额（命中既有行=沿用行内现值，此参不用） */
    quota?: number | null;
}

export interface TaskMoveResult {
    ok: boolean;
    /** true=发生换池（行属性改写或新行落块）；false=已在目标池（幂等零写） */
    moved?: boolean;
    /** 动作行块 id（命中=首行；追加=新行） */
    rowId?: string;
    /** 树任务块「今日位」缓存同步已发生（task 非空才有面） */
    synced?: boolean;
    error?: string;
}

/**
 * 拖卡换池（□5①：单任务级写通道——不动整组）。
 * - 行寻址：task 非空按指针、空按名字（buildTaskViews 同一身份口径）；命中行全量改——
 *   跨池重复行（违「当天内一任务一池」的数据残影）一并收口到目标池；
 * - 池无文本形态（契约 §3：任务行池恒从属性认）→纯属性改写，行文本零触碰
 *   （updateBlock 两步纪律：内容没变不碰）；
 * - 树块缓存同步（B1.2「今日位」同源双写——writeDayConfig diff 改行的同款半边）；
 * - 行不在=容器尾插 upsert（面板数据陈旧/看板缓存源卡共用通道；quota 取入参）；
 * - 幂等：已在目标池零写；串行=configWriteChain（与整组重放互斥）。
 * ⚠️与 writeDayConfig 不同：不做 guardDayConfig 全组校验——单任务动作不该被无关行的
 *   手写残影（如重复池行）卡死（fail-soft；残影归 □8 体检出面）。 */
export function moveTaskPool(day: string, move: TaskMoveInput): Promise<TaskMoveResult> {
    return configWriteChainRun(() => moveTaskPoolInner(day, move).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) })));
}

async function moveTaskPoolInner(day: string, move: TaskMoveInput): Promise<TaskMoveResult> {
    if (!isValidDay(day)) return { ok: false, error: "day 须为合法 YYYY-MM-DD" };
    if (!isPoolSlug(move.pool)) return { ok: false, error: `非法池 slug「${String(move.pool)}」（合法=${AMMO_POOL_SLUGS.join("/")}）` };
    const name = (move.name ?? "").replace(/\u200b/g, "").trim();
    if (!move.task && !name) return { ok: false, error: "task/name 至少一项（行寻址键）" };
    const docId = await locateDayConfigDoc(day);
    if (!docId) return { ok: false, error: "月度配置文档不在——换池不发明结构（晚间交接会配弹药后可拖）" };
    const { containerId } = await findConfigContainer(docId, day);
    if (!containerId) return { ok: false, error: `当日配置容器不在（${day}）——先配弹药再拖卡` };
    const lis = await getChildBlocks(containerId);
    const hits: Array<{ id: string; row: AmmoTaskRow }> = [];
    for (const li of lis) {
        const row = parseConfigRow(li.content, await getBlockAttrs(li.id));
        if (!row || !("task" in row)) continue;
        if (move.task ? row.task === move.task : row.name === name) hits.push({ id: li.id, row });
    }
    if (!hits.length) {
        // 追加（调档=挂池 upsert）：容器尾插行+属性+树块缓存（attachTaskToDayConfig 同款锚）。
        // 空壳容器（行全被清）不插——无锚插 li 会另起平级容器落在 role 容器外（读面不可见），
        // 重建壳是整组写链（writeDayConfig 首建分支）的职责，本通道不越权。
        if (!lis.length) return { ok: false, error: `当日配置容器是空壳（${day}）——先经整组写链重建再拖卡` };
        const target: AmmoTaskRow = { pool: move.pool, task: move.task, quota: move.quota ?? null, name };
        const anchor = { previousID: lis[lis.length - 1].id };
        const r = await insertListItem(docId, `- ${taskRowText(target)}`, anchor);
        await setBlockAttrs(r.liId, taskRowAttrs(target));
        if (move.task) await setBlockAttrs(move.task, { "custom-ammo-pool": move.pool, "custom-ammo-quota": target.quota != null ? String(target.quota) : "" });
        return { ok: true, moved: true, rowId: r.liId, ...(move.task ? { synced: true } : {}) };
    }
    if (hits.every((h) => h.row.pool === move.pool)) return { ok: true, moved: false, rowId: hits[0].id };
    for (const h of hits) {
        await setBlockAttrs(h.id, taskRowAttrs({ ...h.row, pool: move.pool }));
    }
    if (move.task) {
        const quota = hits.find((h) => h.row.quota != null)?.row.quota ?? null;
        await setBlockAttrs(move.task, { "custom-ammo-pool": move.pool, "custom-ammo-quota": quota != null ? String(quota) : "" });
        return { ok: true, moved: true, rowId: hits[0].id, synced: true };
    }
    return { ok: true, moved: true, rowId: hits[0].id };
}

export interface PoolRatioResult {
    ok: boolean;
    docId?: string;
    containerId?: string;
    updated?: number;
    inserted?: number;
    deleted?: number;
    /** 守卫拦截明细（ok=false 且因守卫拒时在——体检素材透传） */
    violations?: string[];
    error?: string;
}

/**
 * 点池头改配比（□5③）：读-改-写整段进串行链（读也在链内——与 moveTaskPool/整组重放
 * 互斥，无读改写竞态窗），落盘走 □2 文本写通道 writeDayConfigInner（ratio 是池行文本的
 * 一部分，`黄金产出 · 保底 120min`——改数字=改文本，属性退缓存双写保持）。
 * ratio=null=清配额（契约 §2：删了 Nmin 尾就是删了配额）。读面守卫拒（如手写重复池行）
 * =violations 带出零写，归 □8 体检出面。 */
export function setPoolRatio(day: string, pool: AmmoPoolSlug, ratio: number | null): Promise<PoolRatioResult> {
    return configWriteChainRun(() => setPoolRatioInner(day, pool, ratio).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) })));
}

async function setPoolRatioInner(day: string, pool: AmmoPoolSlug, ratio: number | null): Promise<PoolRatioResult> {
    if (!isValidDay(day)) return { ok: false, error: "day 须为合法 YYYY-MM-DD" };
    if (!isPoolSlug(pool)) return { ok: false, error: `非法池 slug「${String(pool)}」（合法=${AMMO_POOL_SLUGS.join("/")}）` };
    if (ratio != null && (!Number.isInteger(ratio) || ratio <= 0)) return { ok: false, error: "ratio 须正整数分钟（清空=不带值）" };
    const existing = await readDayConfig(day);
    if (!existing.ok) return { ok: false, error: existing.error };
    const pools = existing.config?.pools ?? [];
    const hit = pools.some((p) => p.pool === pool);
    if (!hit && ratio == null) return { ok: true, updated: 0, inserted: 0, deleted: 0 }; // 清不存在的配额=无事可做（不发明无数字池行）
    const nextPools = hit ? pools.map((p) => (p.pool === pool ? { ...p, ratio } : p)) : [...pools, { pool, ratio }];
    return writeDayConfigInner(day, { day, pools: nextPools, tasks: existing.config?.tasks ?? [] }, {});
}

export interface PoolFreqResult {
    ok: boolean;
    docId?: string;
    containerId?: string;
    updated?: number;
    inserted?: number;
    deleted?: number;
    /** 守卫拦截明细（ok=false 且因守卫拒时在——体检素材透传） */
    violations?: string[];
    error?: string;
}

/**
 * 炉火最小频率改写（第二批 R3：setPoolRatio 姊妹通道——hearth 池头 freq 就地编辑的写面）。
 * - freq 无自然文本形态（池行文本只承载 ratio 的 `· 上限 Nmin` 尾——poolRowText 不含 freq），
 *   契约 §2 例外条款「面板上可编辑的，放属性没问题」：**custom-ammo-freq 属性即真相**，读面
 *   恒从属性认（parseConfigRow 池行分支），缺省回 DEFAULT_HEARTH_FREQ；
 * - 落盘仍走 □2 文本写通道 writeDayConfigInner（整组重放）：freq 变更不动池行文本
 *   （textSettled 数字态对齐=零重写），属性半边 poolRowAttrs 重挂带新 freq——
 *   「属性+既有文本写通道双写按 □2 惯例」的 freq 形态=文本通道照走、文本本身不变；
 * - freq=null=清属性回缺省（删值语义，展示面回落 DEFAULT_HEARTH_FREQ）；hearth 行不在
 *   且带值=追加裸标签池行承载（「维持炉火」无数字尾是合法形态）；行不在且 null=零写
 *   （不发明裸行，setPoolRatio 同判）；
 * - 读-改-写整段进串行链（与 moveTaskPool/整组重放互斥）；池白名单收窄=仅 hearth
 *   （freq 语义只此一池，poolRowAttrs 非 hearth 恒写空串=写了也丢，不如入口拦明）。 */
export function setPoolFreq(day: string, pool: AmmoPoolSlug, freq: number | null): Promise<PoolFreqResult> {
    return configWriteChainRun(() => setPoolFreqInner(day, pool, freq).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) })));
}

async function setPoolFreqInner(day: string, pool: AmmoPoolSlug, freq: number | null): Promise<PoolFreqResult> {
    if (!isValidDay(day)) return { ok: false, error: "day 须为合法 YYYY-MM-DD" };
    if (pool !== "hearth") return { ok: false, error: `freq 仅炉火（hearth）有语义（收到 ${String(pool)}）` };
    if (freq != null && (!Number.isInteger(freq) || freq <= 0)) return { ok: false, error: "freq 须正整数天数（null=回缺省）" };
    const existing = await readDayConfig(day);
    if (!existing.ok) return { ok: false, error: existing.error };
    const pools = existing.config?.pools ?? [];
    const hit = pools.some((p) => p.pool === "hearth");
    if (!hit && freq == null) return { ok: true, updated: 0, inserted: 0, deleted: 0 }; // 清缺省不发明裸行
    const nextPools = hit
        ? pools.map((p) => (p.pool === "hearth" ? { ...p, freq } : p))
        : [...pools, { pool: "hearth" as const, ratio: null, freq }];
    return writeDayConfigInner(day, { day, pools: nextPools, tasks: existing.config?.tasks ?? [] }, {});
}

export interface TaskQuotaResult {
    ok: boolean;
    /** true=配置行文本/属性已改；false=行不在或值未变（块缓存半边照写——徽标数据源） */
    updated?: boolean;
    error?: string;
}

/**
 * 任务级配额改写（dataview □7：徽标菜单配额步进的 kernel 写面——moveTaskPool 姊妹通道）。
 * - 双半边：树块缓存（custom-ammo-quota，徽标数据源）恒写；配置行半边=行在才改——
 *   quota 真相=行文本 `· Nmin` 尾（契约 §3 任务行文本化），行文本重写+行属性双落
 *   （updateBlock 两步纪律：内容改了才 update，属性 setBlockAttrs 补挂）；
 * - 行不在=不追加（步进不发明挂池——挂池是换池/速记/看板列尾的职责，quickAdd 同语义：
 *   缓存先行，行由引擎/交接会收口）；
 * - 寻址/幂等/串行=configWriteChain（与 moveTaskPool/整组重放互斥，无读改写竞态窗）；
 * - quota=null=清（删 Nmin 尾+块缓存删键——空串语义）。 */
export function setTaskQuota(day: string, task: string, name: string, quota: number | null): Promise<TaskQuotaResult> {
    return configWriteChainRun(() => setTaskQuotaInner(day, task, name, quota).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) })));
}

async function setTaskQuotaInner(day: string, task: string, name: string, quota: number | null): Promise<TaskQuotaResult> {
    if (!isValidDay(day)) return { ok: false, error: "day 须为合法 YYYY-MM-DD" };
    if (quota != null && (!Number.isInteger(quota) || quota <= 0)) return { ok: false, error: "quota 须正整数分钟（null=清）" };
    const cleanName = name.replace(/\u200b/g, "").trim();
    if (!task && !cleanName) return { ok: false, error: "task/name 至少一项（行寻址键）" };
    // 半边①：树块缓存恒写（task 非空才可写；徽标菜单常带 task）
    if (task) await setBlockAttrs(task, { "custom-ammo-quota": quota != null ? String(quota) : "" });
    // 半边②：配置行（行在才改；月文档/容器缺=只写缓存，fail-soft 与 quickAdd 挂池链同语义）
    const docId = await locateDayConfigDoc(day);
    if (!docId) return { ok: true, updated: false };
    const { containerId } = await findConfigContainer(docId, day);
    if (!containerId) return { ok: true, updated: false };
    let updated = false;
    for (const li of await getChildBlocks(containerId)) {
        const row = parseConfigRow(li.content, await getBlockAttrs(li.id));
        if (!row || !("task" in row)) continue;
        if (task ? row.task !== task : row.name !== cleanName) continue;
        if (row.quota === quota) continue; // 幂等（跨池重复行残影全量收口=值不同者都改，同 moveTaskPool 口径）
        await updateBlockMarkdown(li.id, `- ${taskRowText({ ...row, quota })}`);
        await setBlockAttrs(li.id, taskRowAttrs({ ...row, quota }));
        updated = true;
    }
    return { ok: true, updated };
}

export interface DayConfigReadResult {
    ok: boolean;
    docId?: string;
    containerId?: string;
    config: AmmoDayConfig | null;
    /** 未认行原文（文本/属性双通道都不认的非空行——□8 体检素材；缺省=零未认） */
    unrecognized?: string[];
    error?: string;
}

/** 配置容器行批读（dataview □8：体检的 IO 收集半边——行块 id+文本+属性随行，判官在
 *  core/ammoHealth/parseConfigRows。零建档零副作用，readDayConfig 同一容器定位通道）。 */
export interface DayConfigLinesResult {
    ok: boolean;
    docId?: string;
    containerId?: string;
    /** 容器行（容器不在=null——当日未配弹药不算异常） */
    lines?: HealthLineInput[] | null;
    error?: string;
}

export async function readDayConfigLines(day: string): Promise<DayConfigLinesResult> {
    try {
        const docId = await locateDayConfigDoc(day);
        if (!docId) return { ok: true, lines: null };
        const { containerId } = await findConfigContainer(docId, day);
        if (!containerId) return { ok: true, docId, lines: null };
        const lines: HealthLineInput[] = [];
        for (const li of await getChildBlocks(containerId)) {
            lines.push({ id: li.id, content: li.content, attrs: await getBlockAttrs(li.id) });
        }
        return { ok: true, docId, containerId, lines };
    } catch (e: any) {
        return { ok: false, lines: null, error: String(e?.message ?? e) };
    }
}

/** 读一日配置（零建档零写——plan_context 侦察/迁移合并原料）。行判型走 core.parseConfigRows
 *  （□2 文本优先属性兜底）；未认行跳过+收集（fail-soft）。走查复用 readDayConfigLines
 *  （单容器单走查——体检与读链同源）。 */
export async function readDayConfig(day: string): Promise<DayConfigReadResult> {
    const walk = await readDayConfigLines(day);
    if (!walk.ok) return { ok: false, config: null, error: walk.error };
    if (!walk.lines) return { ok: true, ...(walk.docId ? { docId: walk.docId } : {}), config: null };
    const parsed = parseConfigRows(walk.lines);
    return {
        ok: true,
        docId: walk.docId,
        containerId: walk.containerId,
        config: { day, pools: parsed.pools, tasks: parsed.tasks },
        ...(parsed.unrecognized.length ? { unrecognized: parsed.unrecognized } : {}),
    };
}

// ── 森林侦察（plan_context 三源③：树况+不想做清单——AI 配弹药的原料面） ──

/** 树任务块（attributes JOIN 读面——forestTasksSql 先例；侦察原料非判向决策面） */
export interface ForestTask {
    id: string;
    summary: string;
    done: boolean;
    /** 当前挂载池（今日位——迁移沿用/面板渲染） */
    pool: string;
    quota: string;
    milestone: boolean;
    goal: boolean;
}

export interface ForestTree {
    id: string;
    title: string;
    tasks: ForestTask[];
    truncated?: boolean;
}

export interface AversionItem {
    id: string;
    /** 用户原话（镜子措辞唯一素材源——AI 从不产生新指责） */
    text: string;
    /** vow|fear|swallow（机器真相=块属性；分区标题兜底） */
    kind: string;
    avatar: string;
    capPool: string;
    /** 记录日 YYYY-MM-DD（引用行「你 XX 说过」的日期；空=无从考证） */
    at: string;
}

export interface ForestScout {
    trees: ForestTree[];
    aversions: AversionItem[];
    /** 三分区实际标题（readAversions 透传——顺序锚健康时在；AI 镜子引用/交接会文案跟用户改词走） */
    aversionTitles?: Record<AversionKind, string>;
    available: boolean;
    note?: string;
}

/** 树任务块查询上限（forestTasksSql LIMIT 500 同款；超限截断带标记） */
const FOREST_TASKS_LIMIT = 500;

const DONE_RE = /^\s*[-*+] \[[xX]\]/;

function stripZeroWidth(s: string | null | undefined): string {
    return (s ?? "").replace(/\u200b/g, "").trim();
}

/** 不想做清单读面产物（dataview □1：items=归属后条目；healthNote=分区结构体检提示） */
export interface AversionsRead {
    items: AversionItem[];
    /** 不想做文档 id（□8 体检跳转目标；文档不存在=缺省） */
    docId?: string;
    /** 分区结构体检提示（缺省=恰好三段 H2 顺序锚健康；在=结构不对已按条目属性兜底——□8 体检入口素材） */
    healthNote?: string;
    /** 三分区实际标题（顺序锚健康时在——显示面跟用户改词走，i18n 默认词退兜底） */
    sectionTitles?: Record<AversionKind, string>;
}

/** 不想做清单读面（□6 从 scanForest 抽出复用——中央圈渲染与 AI 侦察同源同判：
 *  分区顺序锚归属（契约 §4——三分区锚=段序非文字：恰好三段 H2 时位置赢/AI 写的 kind 属性
 *  退缓存，结构不对=属性兜底+healthNote 体检提示）；at=块 created 前 10 位——镜子引用行
 *  「你 XX 说过」的日期素材。文档不存在=空 items（available 域不判）。
 *  ⚠️□6 修复（09-20 e2e 实锤）：getChildBlocks(文档) 顶层=【h 标题, l 列表容器】两层——
 *  li 在 l 容器内一层，原实现按顶层 type='i' 判条目=恒 0 条（交接会 aversion 段恒空）。
 *  正解=l 容器下钻一层展平 li（readDayLedger 容器内取 li 同构）。 */
export async function readAversions(): Promise<AversionsRead> {
    const avHome = await locateRoot();
    const avHpath = `${avHome?.hpath ?? ROOT_HPATH}/${AVERSION_NAME}`;
    const avRows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${avHpath}' LIMIT 1`);
    const avDocId = avRows?.[0]?.id ?? null;
    if (!avDocId) return { items: [] };
    const createdRows = await sql(`SELECT id, created FROM blocks WHERE root_id='${avDocId}' AND type='i'`);
    // 内核 created=14 位钟面（YYYYMMDDhhmmss）→ YYYY-MM-DD（镜子引用行日期素材）
    const createdAt = new Map<string, string>((createdRows ?? []).map((r: any) => {
        const c = String(r.created ?? "");
        return [r.id, /^\d{14}$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}` : ""];
    }));
    const tops = await getChildBlocks(avDocId);
    // 顶层 l 容器下钻一层展平 li（getChildBlocks(文档) 顶层无 i——两层结构 09-20 实锤）
    const flat: AversionFlatBlock[] = [];
    for (const b of tops) {
        if (b.type === "l") {
            for (const li of await getChildBlocks(b.id)) {
                flat.push({ id: li.id, type: li.type, subType: li.subType, content: stripZeroWidth(li.content) });
            }
            continue;
        }
        flat.push({ id: b.id, type: b.type, subType: b.subType, content: stripZeroWidth(b.content) });
    }
    // 属性随行（IO 收集层——归属判定纯逻辑在 core.resolveAversionAnchors）
    for (const b of flat) {
        if (b.type === "i" && b.content) b.attrs = await getBlockAttrs(b.id);
    }
    const resolved = resolveAversionAnchors(flat);
    const items: AversionItem[] = resolved.items.map((x) => ({
        id: x.id,
        text: x.text,
        kind: x.kind,
        avatar: x.attrs?.["custom-ammo-avatar"] ?? "",
        capPool: x.attrs?.["custom-ammo-cap-pool"] ?? "",
        at: createdAt.get(x.id) ?? "",
    }));
    return { items, ...(avDocId ? { docId: avDocId } : {}), ...(resolved.healthNote ? { healthNote: resolved.healthNote } : {}), ...(resolved.sectionTitles ? { sectionTitles: resolved.sectionTitles } : {}) };
}

/** 森林侦察（folder-model）：树=目录一级项目文档；任务=项目子树全量（项目文档内+任意层子文档）；
 *  三件套名排除（日志/每日配置/不想做不进树）。与 gui 看板任务面（boardTasksByRootSql）同源语义。 */
export async function scanForest(): Promise<ForestScout> {
    try {
        const root = await locateRoot();
        if (!root) return { trees: [], aversions: [], available: false, note: "目录未建（Project）——建项目后交接会配弹药时建立工作线" };
        const tops = await listDocsByPath(root.box, root.id);
        const projects = (tops?.files ?? []).filter((f: any) => f?.id && !FIXED_SUBDOCS.has(f.name));
        const trees: ForestTree[] = [];
        for (const p of projects) {
            const pDir = String(p.path ?? "").replace(/\.sy$/, "");
            const rows = await sql(`
                SELECT b.id, TRIM(b.content) AS content, b.markdown,
                    GROUP_CONCAT(CASE WHEN a.name='custom-ammo-pool' THEN a.value END) AS pool,
                    GROUP_CONCAT(CASE WHEN a.name='custom-ammo-quota' THEN a.value END) AS quota,
                    GROUP_CONCAT(CASE WHEN a.name='custom-task-milestone' THEN a.value END) AS milestone,
                    GROUP_CONCAT(CASE WHEN a.name='custom-task-goal' THEN a.value END) AS goal
                FROM blocks b
                LEFT JOIN attributes a ON a.block_id=b.id AND a.name IN ('custom-ammo-pool','custom-ammo-quota','custom-task-milestone','custom-task-goal')
                WHERE b.type='i' AND b.subtype='t'
                  AND b.root_id IN (SELECT id FROM blocks WHERE type='d' AND (id='${p.id}' OR path LIKE '${pDir}/%'))
                GROUP BY b.id
                ORDER BY b.created ASC
                LIMIT ${FOREST_TASKS_LIMIT + 1}`);
            const truncated = (rows?.length ?? 0) > FOREST_TASKS_LIMIT;
            const tasks: ForestTask[] = (rows ?? []).slice(0, FOREST_TASKS_LIMIT).map((r: any) => ({
                id: r.id,
                summary: stripZeroWidth(r.content),
                done: DONE_RE.test(r.markdown ?? ""),
                pool: typeof r.pool === "string" ? r.pool : "",
                quota: typeof r.quota === "string" ? r.quota : "",
                milestone: r.milestone === "1",
                goal: r.goal === "1",
            }));
            trees.push({ id: p.id, title: p.name, tasks, ...(truncated ? { truncated: true } as const : {}) });
        }
        const aversions = await readAversions();
        return { trees, aversions: aversions.items, ...(aversions.sectionTitles ? { aversionTitles: aversions.sectionTitles } : {}), available: true };
    } catch (e: any) {
        return { trees: [], aversions: [], available: false, note: `森林侦察失败：${String(e?.message ?? e)}` };
    }
}

// ── Daily Note 摘要（plan_context 三源①：官方 Daily Note 手写源） ──

export interface DailyNoteDigest {
    found: boolean;
    docs: Array<{ id: string; title: string; paragraphs: string[] }>;
    note: string;
}

/** Daily Note 段数/字数上限（侦察包 bounded 面） */
const DAILY_NOTE_MAX_BLOCKS = 40;
const DAILY_NOTE_MAX_PARAS = 20;
const DAILY_NOTE_MAX_CHARS = 200;

/**
 * 官方 Daily Note 手写摘要（SQL hpath 尾段日期启发式——多笔记本多命中全收；
 * 排除生活域屋檐与旧主线容器子树（日账/配置不是 Daily Note；旧前缀并列排除=迁移窗内
 * 旧处三件套不冒充 Daily Note，旧项目工作线与拆前同待遇）。查不到=found:false 缺席不阻塞（侦察失败面）。 */
export async function buildDailyNoteDigest(day: string): Promise<DailyNoteDigest> {
    try {
        const rows = await sql(`SELECT id, hpath FROM blocks WHERE type='d' AND hpath LIKE '%${day}' AND hpath NOT LIKE '${ROOT_HPATH}/%' AND hpath NOT LIKE '${LEGACY_MAINLINE_HPATH}/%' AND hpath NOT LIKE '${LEGACY_SPLIT_HPATH}/%' LIMIT 5`);
        const docs: DailyNoteDigest["docs"] = [];
        for (const d of rows ?? []) {
            if (!d?.id) continue;
            const paras: string[] = [];
            const blocks = await sql(`SELECT content FROM blocks WHERE root_id='${d.id}' AND type IN ('p','h','i','l') ORDER BY row LIMIT ${DAILY_NOTE_MAX_BLOCKS}`);
            for (const b of blocks ?? []) {
                const t = stripZeroWidth(b?.content).slice(0, DAILY_NOTE_MAX_CHARS);
                if (t) paras.push(t);
                if (paras.length >= DAILY_NOTE_MAX_PARAS) break;
            }
            if (!paras.length) continue; // 空文档=没手写，不占侦察包
            docs.push({ id: d.id, title: (d.hpath ?? "").split("/").pop() || day, paragraphs: paras });
        }
        if (!docs.length) return { found: false, docs: [], note: "今日官方 Daily Note 无手写内容（或未建）——手写感想源缺席，不阻塞其余侦察" };
        return { found: true, docs, note: "今日 Daily Note 手写原文（感想源——对账/配弹药的人话原料）" };
    } catch {
        return { found: false, docs: [], note: "Daily Note 侦察失败（SQL 异常）——手写感想源缺席，不阻塞其余侦察" };
    }
}

// ── 存量迁移（既有班表弹性行→池配置；一次性+幂等可重跑） ──

export interface AmmoMigrationResult {
    ok: boolean;
    /** 扫描天数（今天..+14） */
    scannedDays: number;
    /** 发生迁移的日 */
    migratedDays: string[];
    /** 迁移条数（班表弹性行退役计数） */
    migrated: number;
    /** 保留锚点计数 */
    anchorsKept: number;
    /** 逐日错误（不中断全局——失败日下轮重扫自愈） */
    errors: string[];
}

/** 迁移前瞻域（天）：与班表未来域对齐（schedule_remove 命中窗同款 14 天） */
const MIGRATION_SPAN_DAYS = 14;

/**
 * 存量迁移编排（onrunning 搭车一次性；幂等=班表无弹性行零写——无完成标记，重跑即重扫）：
 * 逐日（今天..+14）读班表→纯层迁移→有转出才写（配置容器合并既有+班表锚点终态重放）。
 * 读失败日跳过（防空基底整日替换——readDayItems null≠空板）。 */
export async function runAmmoMigration(now: Date = new Date()): Promise<AmmoMigrationResult> {
    const out: AmmoMigrationResult = { ok: true, scannedDays: 0, migratedDays: [], migrated: 0, anchorsKept: 0, errors: [] };
    const scout = await scanForest();
    const knownTasks = scout.trees.flatMap((t) => t.tasks.map((x) => ({ id: x.id, summary: x.summary, pool: x.pool })));
    const today = getLogicalDay(now);
    for (let i = 0; i <= MIGRATION_SPAN_DAYS; i++) {
        const day = shiftDay(today, i);
        out.scannedDays++;
        try {
            const rows = await readDayItems(day);
            if (rows == null || !rows.length) continue; // 读失败/空板：跳过
            const outcome = migrateLegacyElastic(rows, knownTasks);
            if (!outcome.migrated.length) continue; // 幂等零写判据
            // 配置容器合并：同 task 已在当日组=保既有（AI 白天增改优先）；无主行（task 空）追加
            const existing = await readDayConfig(day);
            const existingKeys = new Set((existing.config?.tasks ?? []).filter((t) => t.task).map((t) => t.task));
            const mergedTasks = [...(existing.config?.tasks ?? []), ...outcome.tasks.filter((t) => !t.task || !existingKeys.has(t.task))];
            const write = await writeDayConfig(day, { day, pools: existing.config?.pools ?? [], tasks: mergedTasks });
            if (!write.ok) {
                out.errors.push(`${day}: ${write.error ?? "配置写入失败"}`);
                continue; // 配置没落=班表不动（防弹药丢失，该日下轮重扫）
            }
            // 班表锚点终态重放（弹性行被 diff 删——块=唯一真身）
            const board = await writeSchedBoardToDiary(day, outcome.anchors);
            if (!board.ok) {
                out.errors.push(`${day}: 班表重写失败（${board.error ?? "unknown"}）——配置已落，弹性行残留下轮重扫`);
                continue;
            }
            out.migratedDays.push(day);
            out.migrated += outcome.migrated.length;
            out.anchorsKept += outcome.anchors.length;
        } catch (e: any) {
            out.errors.push(`${day}: ${String(e?.message ?? e).slice(0, 120)}`);
        }
    }
    return out;
}

// ── 不想做清单写面（ammo □5：交接会三件套第一件「森林增量」——讨论点头后 aversion_set 落盘） ──

export interface AversionUpsert {
    /** 块 id；缺省=新增（插到 kind 对应段序分区下）；带 id=更新（kind 变=删旧插新分区） */
    id?: string;
    /** 用户原话（镜子措辞唯一素材——原样落块文本） */
    text: string;
    kind: AversionKind;
    /** fear：正面化身=树任务块 id（其他 kind 带此字段=守卫拒） */
    avatar?: string;
    /** swallow：物化池 slug（其他 kind 带此字段=守卫拒） */
    capPool?: string;
}

export interface AversionSyncResult {
    ok: boolean;
    docId?: string;
    inserted?: number;
    updated?: number;
    removed?: number;
    /** 守卫拦截明细（ok=false 因守卫拒时在） */
    violations?: string[];
    error?: string;
}

/** 建文档三分区模板（dataview □1 顺序锚：默认标题只服务新用户开箱即懂——识别/落位全按段序） */
const AVERSION_DOC_TEMPLATE = AVERSION_KINDS.map((k) => `## ${AVERSION_SECTION_TITLES[k]}`).join("\n\n");

function aversionAttrs(u: AversionUpsert): Record<string, string> {
    // 确定性全键输出（缺省=空串——setBlockAttrs 合并写删键语义）
    return {
        "custom-ammo-aversion": u.kind,
        "custom-ammo-avatar": u.kind === "fear" ? (u.avatar ?? "") : "",
        "custom-ammo-cap-pool": u.kind === "swallow" ? (u.capPool ?? "") : "",
    };
}

/** upsert 纯校验（守卫：kind 三值/fear 才有化身/swallow 才有物化池+slug 白名单/原话必填） */
function guardAversions(upserts: AversionUpsert[]): string[] {
    const violations: string[] = [];
    upserts.forEach((u, i) => {
        const label = u.id ? `条目 ${u.id}` : `第 ${i + 1} 条（${u.text.slice(0, 20)}）`;
        if (!(AVERSION_KINDS as readonly string[]).includes(u.kind)) violations.push(`${label}：kind 须 vow|fear|swallow`);
        if (!u.text.replace(/\u200b/g, "").trim()) violations.push(`${label}：原话不能为空`);
        if (u.kind !== "fear" && u.avatar) violations.push(`${label}：avatar 仅 fear（怕来不及→正面化身）有语义`);
        if (u.kind !== "swallow" && u.capPool) violations.push(`${label}：capPool 仅 swallow（防沉迷→物化池上限）有语义`);
        if (u.kind === "swallow" && u.capPool && !(AMMO_POOL_SLUGS as readonly string[]).includes(u.capPool)) violations.push(`${label}：capPool 须池 slug（${AMMO_POOL_SLUGS.join("/")}）`);
    });
    return violations;
}

/** 幂等懒建不想做文档（三分区标题模板——空行分块防合成单段落） */
async function ensureAversionDoc(): Promise<{ ok: true; docId: string } | { ok: false; error: string }> {
    const home = await ensureRoot();
    if ("error" in home) return { ok: false, error: `${home.error}——不想做清单写入跳过` };
    const avHpath = `${home.hpath ?? ROOT_HPATH}/${AVERSION_NAME}`;
    const rows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${avHpath}' LIMIT 1`);
    let docId = rows?.[0]?.id ?? null;
    if (docId && (await blockAlive(docId))) return { ok: true, docId };
    if (docId) {
        // 索引残影（块已删）——走重建
    }
    docId = await createDocWithMd(home.box, avHpath, AVERSION_DOC_TEMPLATE, home.id);
    return { ok: true, docId };
}

/** 顺序锚分区定位（契约 §4：kind=第 1/2/3 段 H2 段序，不认标题文字——用户改名零影响）。
 *  目标段缺失=文末按序补建默认标题段（从现有段数补到目标段为止——修复朝规范三段形态走，
 *  不越位重建后续段；文末追加保段序：既有段全在追加段之前）。 */
async function ensureSectionHeading(docId: string, kind: AversionUpsert["kind"]): Promise<string> {
    const targetIdx = AVERSION_KINDS.indexOf(kind);
    const tops = await getChildBlocks(docId);
    const h2Ids = tops.filter((b) => b.type === "h" && b.subType === "h2").map((b) => b.id);
    if (h2Ids[targetIdx]) return h2Ids[targetIdx];
    let anchor = tops[tops.length - 1]?.id;
    let created = "";
    for (let i = h2Ids.length; i <= targetIdx; i++) {
        created = await insertBlockMarkdown(docId, `## ${AVERSION_SECTION_TITLES[AVERSION_KINDS[i]]}`, undefined, anchor);
        anchor = created;
    }
    return created;
}

/**
 * 不想做清单同步（upsert+显式删；B1.4 写入者=AI 交接会点头后）。
 * - 新增：插 kind 对应段序分区下（顺序锚：第 1/2/3 段 H2=vow/fear/swallow——段缺失按序补建）
 *   +确定性属性（kind 落 custom-ammo-aversion=读面兜底缓存，契约 §4「AI 写属性留缓存」）；
 * - 更新：id 命中且带 custom-ammo-aversion（守卫：不是不想做条目的块拒改——防乱指块）；
 *   kind 变化=删旧插新分区（块 id 换新——aversions 无被引用面，安全）；
 * - 删除：显式 id 且带 custom-ammo-aversion 才删（用户手写内容永不被 AI 删）。
 * 串行=configWriteChain（森林域同链——与每日配置写互斥）。 */
export function syncAversions(upserts: AversionUpsert[], removeIds: string[]): Promise<AversionSyncResult> {
    return configWriteChainRun(() => syncAversionsInner(upserts, removeIds).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) })));
}

async function syncAversionsInner(upserts: AversionUpsert[], removeIds: string[]): Promise<AversionSyncResult> {
    // 两段式（normAmmoPayload「载荷错=整轮拒零写」同族）：先验后写——id 侧守卫（非不想做块
    // 拒改拒删）在写前全量预读校验，violation 任一命中=整轮拒零写。
    const violations = guardAversions(upserts);
    const readAttrs = async (id: string): Promise<Record<string, string> | null> => {
        try {
            return await getBlockAttrs(id);
        } catch {
            return null; // 块已不在=幂等吞（删侧）；改侧=按新增落
        }
    };
    /** id → 既有 kind（null=块不在/非不想做块——后者已进 violations） */
    const existingKind = new Map<string, string | null>();
    for (const u of upserts) {
        if (!u.id || existingKind.has(u.id)) continue;
        const attrs = await readAttrs(u.id);
        if (!attrs) {
            existingKind.set(u.id, null); // 块已被用户删=按新增落（原话不丢）
            continue;
        }
        if (!attrs["custom-ammo-aversion"]) {
            violations.push(`条目 ${u.id} 不是不想做条目（无 custom-ammo-aversion）——不能改`);
            existingKind.set(u.id, null);
            continue;
        }
        existingKind.set(u.id, attrs["custom-ammo-aversion"]);
    }
    const removable = new Set<string>();
    for (const id of removeIds) {
        if (!id) continue;
        const attrs = await readAttrs(id);
        if (!attrs) continue; // 块已不在=目标态已达成（幂等吞，不算违规）
        if (!attrs["custom-ammo-aversion"]) {
            violations.push(`条目 ${id} 不是不想做条目（无 custom-ammo-aversion）——用户手写内容不删`);
            continue;
        }
        removable.add(id);
    }
    if (violations.length) return { ok: false, violations, error: `不想做清单守卫：${violations.join("；")}` };
    const doc = await ensureAversionDoc();
    if ("error" in doc) return { ok: false, error: doc.error };
    const docId = doc.docId;
    let inserted = 0;
    let updated = 0;
    let removed = 0;
    for (const id of removable) {
        await deleteBlock(id);
        removed++;
    }
    for (const u of upserts) {
        const text = u.text.replace(/\u200b/g, "").trim().slice(0, 100);
        const prevKind = u.id ? existingKind.get(u.id) : undefined;
        if (u.id && prevKind) {
            if (prevKind === u.kind) {
                // 同 kind 原地更新：文本变化才写（updateBlock 纯内容+setBlockAttrs 两步纪律）
                const cur = await getChildBlocks(docId);
                const self = cur.find((b) => b.id === u.id);
                if (!self || stripZeroWidth(self.content) !== text) await updateBlockMarkdown(u.id, `- ${text}`);
                await setBlockAttrs(u.id, aversionAttrs({ ...u, text }));
                updated++;
                continue;
            }
            // kind 变化=删旧插新分区（aversions 无被引用面，块 id 换新安全）
            await deleteBlock(u.id);
        }
        // attrs 缺失（块已被用户删）=按新增落（原话不丢）
        const headingId = await ensureSectionHeading(docId, u.kind);
        const r = await insertListItem(docId, `- ${text}`, { previousID: headingId });
        await setBlockAttrs(r.liId, aversionAttrs({ ...u, text }));
        inserted++;
    }
    return { ok: true, docId, inserted, updated, removed };
}
