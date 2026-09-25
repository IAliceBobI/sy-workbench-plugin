// ammo □4：每日象限配置纯逻辑层（弹性任务退役时刻表→池归属+两级配额）。
// 契约=docs/ammo-concept.md B1.3（行格式）/B3（词表冻结）/B4（守卫边界）/B5（边界情形）：
// - 容器=列表块挂 custom-role="ammo-dayconfig"+custom-ammo-day="YYYY-MM-DD"；「## 日期」=纯装饰。
// - dataview □2（契约 §8 修订 2）：配置行文本升为真相——池行=`黄金产出 · 保底 120min`（标签
//   整行完或 · 尾，ratio 从 Nmin 尾认）、任务行=`((id)) 任务名 · 30min`（指针/名字/配额全从
//   文本认）；custom-ammo-ratio/quota/task 属性退缓存（引擎双写保持，读面文本优先属性兜底——
//   老条目零迁移）。任务行的池无文本形态→恒从属性认（custom-ammo-pool）。freq 同（无文本形态）。
// - 判型（文本优先）：池标签命中=池行；文本指针命中=任务行；两者皆无→属性兜底（有
//   custom-ammo-task 键（含空串）=任务行、有合法池 slug=池行）；双通道都不认=null（fail-soft
//   跳过+未认收集——□8 体检素材）。
// - 确定性全键输出（schedItemToAttrs 同款）：缺省=空串，setBlockAttrs 合并写删键语义。
// 零 siyuan/网络/DOM 依赖（channels 纪律：kernel bundle 与前端 bundle 共用同一份源）。

import { hmToMin, type SchedItem } from "./schedule";
import type { AmmoLedgerEntry } from "./ammoLedger";

/** 池 slug 白名单（B3 冻结：gold=黄金产出 deadline=当日死线 hearth=维持炉火 crumbs=碎片杂项） */
export const AMMO_POOL_SLUGS = ["gold", "deadline", "hearth", "crumbs"] as const;
export type AmmoPoolSlug = (typeof AMMO_POOL_SLUGS)[number];

/** 日配置容器识别属性值（挂 custom-role；sched-board/ammo-ledger 同款先例） */
export const DAYCONFIG_ROLE_VALUE = "ammo-dayconfig";

/** hearth 最小频率缺省天数（B3：缺省 3——超 N 天没看提醒「炉子凉了」的 N） */
export const DEFAULT_HEARTH_FREQ = 3;

/** 池展示名（文本形态原料；正式定名只换展示文案不换机器值——□1 定档） */
export const POOL_LABEL: Record<AmmoPoolSlug, string> = {
    gold: "黄金产出",
    deadline: "当日死线",
    hearth: "维持炉火",
    crumbs: "碎片杂项",
};

/** 池 slug 白名单判定（dataview □4 起导出——看板视图模型分组前守门共用单事实源） */
export function isPoolSlug(v: unknown): v is AmmoPoolSlug {
    return typeof v === "string" && (AMMO_POOL_SLUGS as readonly string[]).includes(v);
}

/** 非负整数宽容读（块属性数字串→number|null；坏值/负数/小数归 null）。
 *  dataview □8 起导出——core/ammoHealth 冲突比对复用同一数字口径 */
export function normCount(v: unknown): number | null {
    if (typeof v !== "string" || !/^\d+$/.test(v.trim())) return null;
    const n = Number(v.trim());
    return n > 0 ? n : null;
}

/** 块文本归一（零宽空格剔不掉须显式替换——内核空块 content=\u200b） */
function stripZeroWidth(s: string | null | undefined): string {
    return (s ?? "").replace(/\u200b/g, "").trim();
}

/** 行尾配额分钟（引擎写形=` · 30min`；容忍无空格变体；0/坏值=不认数字）。
 *  R2 起导出——写面 textSettled 数字态判定共用读面解析器（与 parsePoolRowText 同为单一事实源）。 */
export const MIN_TAIL_RE = /\s*·\s*(\d+)\s*min\s*$/;

// ── schema ──

/** 池级行（gold.ratio=保底分钟 / hearth.ratio=上限分钟+freq=最小频率天数 / deadline·crumbs 无数字） */
export interface AmmoPoolRow {
    pool: AmmoPoolSlug;
    /** 分钟；null=无数字（gold/hearth 宽容形态、deadline/crumbs 常态） */
    ratio: number | null;
    /** 天数；仅 hearth 有语义（缺省 DEFAULT_HEARTH_FREQ） */
    freq?: number | null;
}

/** 任务级行（B1.3：机器指针在属性，文本=纯展示） */
export interface AmmoTaskRow {
    pool: AmmoPoolSlug;
    /** 树任务块 id；空串=无主任务行（迁移匹配不到树块/AI 直排预告——B5 临时宽容面） */
    task: string;
    /** 分钟；null=当日无任务级配额（只吃池配比） */
    quota: number | null;
    /** 任务名（文本原料；读面从块文本剥引用前缀而来） */
    name: string;
}

/** 一日配置（容器整组——B1.3「AI 每晚落三件套时整组写当日容器」） */
export interface AmmoDayConfig {
    day: string;
    pools: AmmoPoolRow[];
    tasks: AmmoTaskRow[];
}

// ── 文本映射（写面原料；读面不依赖文本判型） ──

export function poolRowText(row: AmmoPoolRow): string {
    if (row.pool === "gold") return row.ratio != null ? `${POOL_LABEL.gold} · 保底 ${row.ratio}min` : POOL_LABEL.gold;
    if (row.pool === "hearth") return row.ratio != null ? `${POOL_LABEL.hearth} · 上限 ${row.ratio}min` : POOL_LABEL.hearth;
    return POOL_LABEL[row.pool];
}

export function taskRowText(row: AmmoTaskRow): string {
    const name = row.name.replace(/\s+/g, " ").trim();
    const quotaTail = row.quota != null ? ` · ${row.quota}min` : "";
    return row.task ? `((${row.task})) ${name}${quotaTail}` : `${name}${quotaTail}`;
}

// ── 属性映射（确定性全键输出） ──

export function poolRowAttrs(row: AmmoPoolRow): Record<string, string> {
    return {
        "custom-ammo-pool": row.pool,
        "custom-ammo-ratio": row.ratio != null ? String(row.ratio) : "",
        "custom-ammo-freq": row.pool === "hearth" && row.freq != null ? String(row.freq) : "",
    };
}

export function taskRowAttrs(row: AmmoTaskRow): Record<string, string> {
    return {
        "custom-ammo-pool": row.pool,
        "custom-ammo-task": row.task,
        "custom-ammo-quota": row.quota != null ? String(row.quota) : "",
    };
}

// ── 读回判型（dataview □2：文本优先+属性兜底 → 行；非配置行 null） ──

/** 块文本剥展示尾得到任务名（写面 taskRowText 的逆；属性兜底通道的 name 半边）。
 *  ⚠️□6 修复（09-20 实测内核真实形态）：markdown 通道 `((id))` 被 Lute 解析成块引用且静态
 *  锚文本回填=id 本身——content 列=「<id> 任务名」（引用纯文本化），原 regex 只认 kramdown
 *  字面 `((id))` 形态剥不掉。两形态都剥：kramdown 字面前缀 + 裸 NodeID 前缀。 */
function taskNameFromContent(content: string): string {
    let t = (content ?? "").replace(/\u200b/g, "").trim();
    const kramdown = /^\(\(([^)]+)\)\)\s*(.*)$/.exec(t);
    if (kramdown) t = kramdown[2];
    const bare = /^([0-9]{14}-[a-z0-9]{7})\s*(.*)$/.exec(t);
    if (bare) t = bare[2];
    return t.replace(/\s*·\s*\d+min$/, "").trim();
}

/** 池行文本解析产物（ratio=null=无数字尾——deadline/crumbs 常态、gold/hearth 宽容形态） */
export interface PoolRowTextParse {
    pool: AmmoPoolSlug;
    ratio: number | null;
}

/** 池行文本→池+配额（写面 poolRowText 的逆）：`黄金产出 · 保底 120min`/`维持炉火 · 上限
 *  40min`/裸标签 `当日死线`。标签须整行完或后接 `·` 尾（防「黄金产出率下降」类前缀撞名
 *  误认）；`保底/上限` 限定词纯展示不校验（gold 也可写 上限——数字才是数据）；无 Nmin 尾
 *  =ratio null（文本即真相：删了尾就是删了配额）。 */
export function parsePoolRowText(content: string | null | undefined): PoolRowTextParse | null {
    const t = stripZeroWidth(content);
    for (const slug of AMMO_POOL_SLUGS) {
        const label = POOL_LABEL[slug];
        if (t === label) return { pool: slug, ratio: null };
        if (!t.startsWith(label)) continue;
        const rest = t.slice(label.length).trim();
        if (!rest.startsWith("·")) continue;
        const m = /(\d+)\s*min\b/i.exec(rest);
        return { pool: slug, ratio: m && Number(m[1]) > 0 ? Number(m[1]) : null };
    }
    return null;
}

/** 任务行文本解析产物（task 空串=有指针形态但指针空——不会出现；quota null=无配额尾） */
export interface TaskRowTextParse {
    task: string;
    name: string;
    quota: number | null;
}

/** 任务行文本→指针+名字+配额（写面 taskRowText 的逆）：`((id)) 任务名 · 30min`/裸 NodeID
 *  前缀（内核块引用 content 真实形态）/无尾宽容形。无指针（纯名字行）=null——文本层面认
 *  不出任务行（无主行判型走属性兜底：custom-ammo-task 键在即任务行）。 */
export function parseTaskRowText(content: string | null | undefined): TaskRowTextParse | null {
    const t = stripZeroWidth(content);
    let rest = t;
    let task = "";
    const kramdown = /^\(\(([^)\s]+)\)\)\s*(.*)$/.exec(rest);
    if (kramdown) {
        task = kramdown[1];
        rest = kramdown[2];
    } else {
        const bare = /^([0-9]{14}-[a-z0-9]{7})\s*(.*)$/.exec(rest);
        if (!bare) return null; // 无指针=文本认不出任务行
        task = bare[1];
        rest = bare[2];
    }
    const m = MIN_TAIL_RE.exec(rest);
    const quota = m && Number(m[1]) > 0 ? Number(m[1]) : null;
    const name = (m ? rest.slice(0, m.index) : rest).trim();
    return { task, name, quota };
}

/** 读回判型（□2 文本优先）：文本认出池行/任务行→文本赢（人刚改过=最新意图，属性=机器缓存）；
 *  任务行的池/freq 无文本形态→从属性认（属性池缺失/坏=未认——池是必填位，无答案不能编）。
 *  文本两形皆无→属性兜底（老条目零迁移：旧引擎写的行属性齐全）；双通道都不认=null
 *  （fail-soft 跳过+未认收集）。 */
export function parseConfigRow(
    content: string | null | undefined,
    attrs: Record<string, string> | null | undefined,
): AmmoPoolRow | AmmoTaskRow | null {
    const t = stripZeroWidth(content);
    const poolText = parsePoolRowText(t);
    const taskText = parseTaskRowText(t);
    const attrsPoolRaw = attrs?.["custom-ammo-pool"];
    const attrsPool = isPoolSlug(attrsPoolRaw) ? (attrsPoolRaw as AmmoPoolSlug) : null;
    if (taskText && !poolText) {
        if (!attrsPool) return null; // 文本认出任务行但池无答案——未认（□8 体检可见）
        return { pool: attrsPool, task: taskText.task, quota: taskText.quota, name: taskText.name };
    }
    if (poolText) {
        return { pool: poolText.pool, ratio: poolText.ratio, freq: normCount(attrs?.["custom-ammo-freq"]) };
    }
    if (!attrsPool) return null; // 无池属性/坏 slug=用户手写行，读面跳过
    if (typeof attrs?.["custom-ammo-task"] === "string") {
        return { pool: attrsPool, task: attrs["custom-ammo-task"].trim(), quota: normCount(attrs["custom-ammo-quota"]), name: taskNameFromContent(t) };
    }
    return { pool: attrsPool, ratio: normCount(attrs["custom-ammo-ratio"]), freq: normCount(attrs["custom-ammo-freq"]) };
}

/** 配置行批读入参（编排层 IO 收集——读链/□8 体检共用同一判官） */
export interface ConfigRowLineInput {
    content: string | null;
    attrs?: Record<string, string> | null;
}

export interface ConfigRowsRead {
    pools: AmmoPoolRow[];
    tasks: AmmoTaskRow[];
    /** 未认行原文（文本/属性双通道都不认的非空行——□8 体检素材；空行静默跳过） */
    unrecognized: string[];
}

/** 容器行批解析（readDayConfig 与 □8 体检的同一判官） */
export function parseConfigRows(lines: ConfigRowLineInput[]): ConfigRowsRead {
    const pools: AmmoPoolRow[] = [];
    const tasks: AmmoTaskRow[] = [];
    const unrecognized: string[] = [];
    for (const l of lines) {
        const row = parseConfigRow(l.content, l.attrs);
        if (!row) {
            const t = stripZeroWidth(l.content);
            if (t) unrecognized.push(t);
            continue;
        }
        if ("task" in row) tasks.push(row);
        else pools.push(row);
    }
    return { pools, tasks, unrecognized };
}

// ── 守卫（B4：AI 写森林只动约定区域——结构手术不在 API 面，工具面只拦写值的合法性） ──

export interface DayConfigGuard {
    ok: boolean;
    violations: string[];
}

/**
 * 每日配置守卫（纯；guardStructure 周级守卫的配置域同族）：
 * - 池 slug 白名单；一池一行；
 * - 任务行 task 非空必须在 knownTasks（森林任务块集合）——AI 只能把弹药配到森林里真实存在的
 *   任务块，防乱指块=变相挪枝（拆树/挪枝不在 API 面，B4）；
 * - 同一任务当天只挂一池（B5「当天内一任务一池」）；
 * - quota/ratio/freq 正整数（分钟/天数）。
 * knownTasks 缺省=不校验指针（读面组装复用本函数只查其余规则时用）。 */
export function guardDayConfig(input: { config: AmmoDayConfig; knownTasks?: ReadonlySet<string> }): DayConfigGuard {
    const violations: string[] = [];
    const seenPools = new Set<string>();
    const seenTasks = new Map<string, string>();
    for (const p of input.config.pools) {
        if (!isPoolSlug(p.pool)) {
            violations.push(`非法池 slug「${String(p.pool)}」（合法=${AMMO_POOL_SLUGS.join("/")})`);
            continue;
        }
        if (seenPools.has(p.pool)) violations.push(`池「${p.pool}」配置了多行（一池一行）`);
        seenPools.add(p.pool);
        if (p.ratio != null && (!Number.isInteger(p.ratio) || p.ratio <= 0)) violations.push(`池「${p.pool}」ratio 须正整数分钟`);
        if (p.freq != null && (!Number.isInteger(p.freq) || p.freq <= 0)) violations.push(`池「${p.pool}」freq 须正整数天数`);
    }
    for (const t of input.config.tasks) {
        if (!isPoolSlug(t.pool)) {
            violations.push(`任务「${t.name}」挂非法池「${String(t.pool)}」`);
            continue;
        }
        if (t.quota != null && (!Number.isInteger(t.quota) || t.quota <= 0)) violations.push(`任务「${t.name}」quota 须正整数分钟`);
        if (t.task) {
            if (input.knownTasks && !input.knownTasks.has(t.task)) {
                violations.push(`任务行指向的块 ${t.task} 不是森林任务块（${t.name}）——弹药只能配给森林里的真实任务`);
            }
            const prevPool = seenTasks.get(t.task);
            if (prevPool != null) violations.push(`任务 ${t.task}（${t.name}）当天挂了两个池（${prevPool}/${t.pool}）——当天内一任务一池`);
            seenTasks.set(t.task, t.pool);
        }
    }
    return { ok: violations.length === 0, violations };
}

// ── 存量迁移（既有 SchedItem 时刻条目退役策略：锚点保留/弹性转池配置） ──

export interface MigrationKnownTask {
    id: string;
    summary: string;
    /** 任务块当前挂载池（custom-ammo-pool「今日位」——迁移沿用既有挂载，未挂=空串） */
    pool: string;
}

export interface MigrationOutcome {
    /** 保留的锚点行（hard=true 与闪卡波次——班表锚点域终态） */
    anchors: SchedItem[];
    /** 被转走的弹性行（班表侧退役清单） */
    migrated: SchedItem[];
    /** 转出的任务级行（写每日配置容器） */
    tasks: AmmoTaskRow[];
    /** 转出的池级行（恒空——池配比=当晚 AI 配弹药再写，迁移不发明） */
    pools: AmmoPoolRow[];
}

/** 标题启发式（buildRecon titlesMatch 简版）：归一（小写+去空白标点）后双向包含 */
function normText(s: string): string {
    return (s ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
function titlesMatch(a: string, b: string): boolean {
    const x = normText(a);
    const y = normText(b);
    return Boolean(x && y && (x.includes(y) || y.includes(x)));
}

/**
 * 存量迁移（纯；幂等可重跑——anchors 产物再喂=零转出）：
 * - 锚点类=hard=true（含 adopt 外部承诺/roll/report）与闪卡波次行 → 原样保留；
 * - 弹性类=hard!==true 且非波次 → 池配置任务行：
 *   · 匹配森林同名任务块（首个命中）→ task=块 id、pool=块当前挂载池（未挂=crumbs 兜底）、
 *     quota=start+end 都在的时长分钟（跨零点 +24h 归一；无时刻=null）；
 *   · 匹配不到 → 无主任务行（task 空串，crumbs 收编——保守归碎片，当晚交接会再挪池）；
 * - 池配比不产（迁移只搬任务位，配额比例=当晚 AI 配弹药语义）。 */
export function migrateLegacyElastic(rows: SchedItem[], knownTasks: MigrationKnownTask[]): MigrationOutcome {
    const anchors: SchedItem[] = [];
    const migrated: SchedItem[] = [];
    const tasks: AmmoTaskRow[] = [];
    for (const row of rows) {
        if (row.hard || row.flash) {
            anchors.push(row);
            continue;
        }
        migrated.push(row);
        const rawQuota = row.start && row.end ? hmToMin(row.end) - hmToMin(row.start) : null;
        const quota = rawQuota == null ? null : rawQuota < 0 ? rawQuota + 24 * 60 : rawQuota; // 跨零点 +24h 归一
        const normQuota = quota != null && quota > 0 ? quota : null;
        const hit = knownTasks.find((t) => titlesMatch(t.summary, row.summary));
        tasks.push(
            hit
                ? { pool: isPoolSlug(hit.pool) && hit.pool ? hit.pool : "crumbs", task: hit.id, quota: normQuota, name: row.summary }
                : { pool: "crumbs", task: "", quota: normQuota, name: row.summary },
        );
    }
    return { anchors, migrated, tasks, pools: [] };
}

// ── 日账池聚合（plan_context 三源②的消耗摘要——对账原料，□5 消费） ──

export interface LedgerPoolDigest {
    /** pool slug → 闭合段累计分钟 */
    pools: Record<string, number>;
    /** 未闭合（运行中/悬账）段：任务名+池+开始时刻 */
    unclosed: Array<{ summary: string; pool: string; start: string }>;
    /** 闭合条数 */
    totalClosed: number;
    /** 锚点出发型条数（pool 空，不进池聚合——B2.4） */
    anchorCount: number;
}

export function poolMinutesFromLedger(entries: AmmoLedgerEntry[]): LedgerPoolDigest {
    const pools: Record<string, number> = {};
    const unclosed: LedgerPoolDigest["unclosed"] = [];
    let totalClosed = 0;
    let anchorCount = 0;
    for (const e of entries) {
        if (e.anchor) anchorCount++;
        if (!e.closed) {
            unclosed.push({ summary: e.summary, pool: e.pool, start: e.start ?? "" });
            continue;
        }
        totalClosed++;
        if (!e.pool || e.durationMin == null) continue;
        pools[e.pool] = (pools[e.pool] ?? 0) + e.durationMin;
    }
    return { pools, unclosed, totalClosed, anchorCount };
}

// ── 不想做分区顺序锚（dataview 契约 §4：三分区锚=顺序非文字——标题随便改，段序即身份） ──

/** 不想做条目三分类词表（B1.4 冻结：vow=戒条 fear=怕来不及 swallow=防沉迷） */
export const AVERSION_KINDS = ["vow", "fear", "swallow"] as const;
export type AversionKind = (typeof AVERSION_KINDS)[number];

/** 分区默认标题（建文档模板/写面缺段补建的原料——仅展示用新用户开箱即懂；
 *  顺序锚识别只认段序不认文字，用户改名零影响） */
export const AVERSION_SECTION_TITLES: Record<AversionKind, string> = { vow: "戒条", fear: "怕来不及", swallow: "防沉迷" };

/** 展平块（不想做文档顶层序——l 容器下钻一层；h+subType=h2=分区锚，i=条目） */
export interface AversionFlatBlock {
    id: string;
    type: string;
    /** 仅 h 有意义：h2 才是分区锚（其他级别不认——契约「恰好三段 H2」） */
    subType?: string;
    content: string;
    /** 块属性（kind 属性兜底/avatar/cap-pool 原料；缺省=无/未读） */
    attrs?: Record<string, string> | null;
}

/** 顺序锚归属产物条目（attrs 随行——kernel 侧组 avatar/capPool 用） */
export interface AversionAnchoredItem {
    id: string;
    text: string;
    kind: AversionKind;
    attrs?: Record<string, string> | null;
}

export interface AversionAnchorRead {
    items: AversionAnchoredItem[];
    /** 分区结构体检提示（null=恰好三段 H2 顺序锚健康；非 null=结构不对已转属性兜底——□8 体检入口素材） */
    healthNote: string | null;
    /** 三分区实际标题（顺序锚健康时=文档三段 H2 文字，空标题→默认词补位——显示面跟用户改词走：
     *  「分区叫什么名文档说了算」；非 anchored=null——段序不可信时分区标题同样不可信，显示面退默认词） */
    sectionTitles: Record<AversionKind, string> | null;
}

/** 条目属性兜底读 kind（custom-ammo-aversion；非三值=null 不认） */
function aversionKindFromAttrs(attrs?: Record<string, string> | null): AversionKind | null {
    const v = attrs?.["custom-ammo-aversion"];
    return (AVERSION_KINDS as readonly string[]).includes(v) ? (v as AversionKind) : null;
}

/**
 * 分区顺序锚归属（纯；契约 §4——宁可少认不错认）：
 * - 恰好三段 H2：条目 kind=就近段序（第 1/2/3 段=vow/fear/swallow——位置赢：手写条目写在哪段
 *   就是哪类、拖动换区即换类；AI 写的 kind 属性退缓存不参与判向）。首段之前的条目位置无答案
 *   =属性兜底，无属性跳过；
 * - 非三段（删段/插段/换标题级别）：位置不可信（删段后段序静默上移=错认比少认糟）→ 全部条目
 *   按 custom-ammo-aversion 属性兜底、无属性跳过 + healthNote 体检提示（fail-soft：不报错不拦人）。 */
export function resolveAversionAnchors(flat: AversionFlatBlock[]): AversionAnchorRead {
    const h2s = flat.filter((b) => b.type === "h" && b.subType === "h2");
    const anchored = h2s.length === AVERSION_KINDS.length;
    const sectionTitles = anchored
        ? Object.fromEntries(AVERSION_KINDS.map((k, i) => [k, stripZeroWidth(h2s[i]?.content) || AVERSION_SECTION_TITLES[k]])) as Record<AversionKind, string>
        : null;
    const items: AversionAnchoredItem[] = [];
    let sectionIdx = -1;
    for (const b of flat) {
        if (b.type === "h" && b.subType === "h2") {
            sectionIdx++;
            continue;
        }
        if (b.type !== "i" || !b.content) continue;
        const kind = anchored && sectionIdx >= 0 ? AVERSION_KINDS[sectionIdx] : aversionKindFromAttrs(b.attrs);
        if (!kind) continue; // 位置无答案+属性无类型=不认（fail-soft 跳过，□8 体检可见）
        items.push({ id: b.id, text: b.content, kind, attrs: b.attrs });
    }
    return {
        items,
        healthNote: anchored
            ? null
            : `「不想做」文档现有 ${h2s.length} 段 H2 分区（顺序锚要求恰好三段：第 1/2/3 段=戒条/怕来不及/防沉迷——标题文字可自由改）——分区结构不对，已按条目 custom-ammo-aversion 属性兜底，未带属性的条目暂不识别；恢复三段 H2 后自动回到位置归属`,
        sectionTitles,
    };
}

// ── ammo 载荷归一（schedule_set 入参 → AmmoDayConfig；工具面薄壳的纯逻辑下沉） ──

/** 字符串/数字宽容 → 正整数；非法（负数/小数/非数字串/0）→ null */
function toCount(v: unknown): number | null {
    const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
    return n != null && n > 0 ? n : null;
}

/**
 * schedule_set 的 ammo 载荷归一（弹性任务配弹药面）：
 * - pools:[{pool, ratio?, freq?}]（gold.ratio=保底分钟/hearth.ratio=上限分钟+freq 最小频率天数）；
 * - tasks:[{task?, pool, quota?, summary}]（task=森林树任务块 id 从 plan_context 森林段拿；
 *   缺省/空串=无主预告行——summary 即任务名必填）；
 * - 空载荷拒（防 AI 误清空当日组——清空语义由明确的整组重放表达，不靠空载荷兜）。
 * 池 slug 与数字合法性在此归一；指针合法性（task 是否森林真实任务块）归 guardDayConfig。 */
export function normAmmoPayload(input: any, day: string): { ok: true; config: AmmoDayConfig } | { ok: false; error: string } {
    const poolsRaw = Array.isArray(input?.pools) ? input.pools : [];
    const tasksRaw = Array.isArray(input?.tasks) ? input.tasks : [];
    if (!poolsRaw.length && !tasksRaw.length) return { ok: false, error: "ammo 载荷空——弹性任务配弹药至少一项：pools:[{pool,ratio?,freq?}]（池配比）与 tasks:[{task,pool,quota?,summary}]（任务挂载）" };
    const pools: AmmoPoolRow[] = [];
    for (const p of poolsRaw) {
        if (!isPoolSlug(p?.pool)) return { ok: false, error: `非法池 slug「${String(p?.pool)}」（合法=${AMMO_POOL_SLUGS.join("/")}：gold=黄金产出 deadline=当日死线 hearth=维持炉火 crumbs=碎片杂项）` };
        const ratio = p.ratio != null ? toCount(p.ratio) : null;
        if (p.ratio != null && ratio == null) return { ok: false, error: `池「${p.pool}」ratio 须正整数分钟（保底/上限）` };
        let freq: number | null | undefined;
        if (p.freq != null) {
            freq = toCount(p.freq);
            if (freq == null) return { ok: false, error: `池「${p.pool}」freq 须正整数天数（最小频率）` };
        }
        pools.push({ pool: p.pool, ratio, ...(freq !== undefined ? { freq } : {}) });
    }
    const tasks: AmmoTaskRow[] = [];
    for (const t of tasksRaw) {
        const summary = typeof t?.summary === "string" ? t.summary.trim().slice(0, 100) : "";
        if (!summary) return { ok: false, error: "任务行缺 summary（任务名——写进配置行文本；树任务名从 plan_context 的 forest 段拿）" };
        if (!isPoolSlug(t?.pool)) return { ok: false, error: `任务「${summary}」挂非法池「${String(t?.pool)}」（合法=${AMMO_POOL_SLUGS.join("/")}）` };
        const quota = t.quota != null ? toCount(t.quota) : null;
        if (t.quota != null && quota == null) return { ok: false, error: `任务「${summary}」quota 须正整数分钟` };
        tasks.push({ pool: t.pool, task: typeof t?.task === "string" ? t.task.trim() : "", quota, name: summary });
    }
    return { ok: true, config: { day, pools, tasks } };
}
