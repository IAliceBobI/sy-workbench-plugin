// dataview □4：看板视图模型纯函数层（契约 §4/§5/§7——零自有存储的纯投影）。
// 列=查询分组，怎么分就怎么查（§4「看板」行）；两模式（folder-model 起）：
//  - 按池：列=AMMO_POOL_SLUGS 四列固定（§7 语义结构不增——四池各挂告警/训练/镜子语义，
//    自定义列=退化分组标签=竞品路线，不做）。卡源双合并：今日配置文档结构（真相——kernel
//    ammo-panel rpc 的当日任务行）+任务块池缓存（custom-ammo-pool 降级缓存，契约 §3/§8.5：
//    两边都有的任务配置行赢=「文档赢」，缓存只补不进配置的块）。
//  - 按项目（folder-model）：列=目录一级项目文档（一项目一列）；卡=项目子树任务
//    （项目文档+任意层子文档，root_id→所属文档→path 前缀归属）。
// 卡=任务块（点击跳块定位走 cb-get-hl 禁聚焦通道——非编辑跳转不抢焦点是仓政策）。
// 零 siyuan/网络/DOM 依赖（gui 纯逻辑层惯例——分组/过滤/卡片字段单测钉死）。

import { AMMO_POOL_SLUGS, isPoolSlug, type AmmoPoolSlug } from "@/kernel/core/ammoQuadrant";
import { isDone, type TaskRow } from "@/kernel/core/progressCalc";
import { ARCHIVE_DOC_NAME } from "@/kernel/core/schema";
import type { AmmoTaskView } from "@/kernel/core/ammoPanel";

// ── 原料行（SQL/IO 采集层直出形态——boardTasksSql 产物） ──

/** 主线工作域任务块行（两模式共用一发；attributes GROUP_CONCAT 同 forestTasksSql 惯例） */
export type BoardTaskRow = TaskRow & {
    /** custom-ammo-pool（降级缓存；空/GROUP_CONCAT null=无） */
    pool?: string | null;
    /** custom-ammo-quota 分钟串 */
    quota?: string | null;
    /** custom-task-due-date YYYY-MM-DD */
    due_date?: string | null;
    /** custom-task-done-date YYYY-MM-DD（done 分区排序键首选——勾选日比 updated 真实） */
    done_date?: string | null;
};

/** 子文档行（rootSubtreeDocsSql 直出——buildProjectBoard 归属锚） */
export interface BoardLineRow {
    id: string;
    content: string;
    hpath?: string | null;
    updated: string;
    path: string;
}

export interface BoardProjectRow {
    id: string;
    name: string;
    updated: string;
    path: string;
}

// ── 视图模型 ──

/** 看板卡（两模式统一形态） */
export interface BoardCard {
    /** keyed each——身份#列#序号保底（AmmoTaskView key 同款纪律：重复 key=整面板冻结） */
    key: string;
    /** 任务块 id（空串=无主配置行——不可点跳，照实出示） */
    taskId: string;
    name: string;
    /** 按线模式无池=null（卡上无池徽标） */
    pool: AmmoPoolSlug | null;
    /** 分钟（null=无配额） */
    quota: number | null;
    due: string | null;
    done: boolean;
    /** 池归属源：config=今日配置行（真相）/cache=块池属性（降级缓存）/tree=按线模式块直出 */
    source: "config" | "cache" | "tree";
}

export interface BoardColumn {
    key: string;
    title: string;
    /** 副标（按池=池配比文本；按线=线所属项目名） */
    subtitle?: string;
    /** 按池模式=列池（列尾「+」速记的池上下文）；按线模式=null */
    pool: AmmoPoolSlug | null;
    /** 按线模式=列文档 id（列尾「+」速记的落点章节所在文档）；按池模式=null */
    docId: string | null;
    cards: BoardCard[];
    /** 列底「✓ 已完成 N」折叠分区卡（foldview：done 分流替 showDone 过滤——翻过去日回放
     *  完整、今天的完成量列底计数可见；完成时间新→旧） */
    doneCards: BoardCard[];
}

// ── 按池模式 ──

/** 池配比副标（写面=poolRowText 的展示半边；四象限面板 quotaLabel 同信息不搬样式） */
export function poolSubtitle(pool: AmmoPoolSlug, ratio: number | null): string | null {
    if (ratio == null) return null;
    return pool === "gold" ? `保底 ${ratio}min` : pool === "hearth" ? `上限 ${ratio}min` : `${ratio}min`;
}

/** 配额分钟串宽容读（normCount 同义——boardModel 自持防 core 增耦合；坏值=null） */
function quotaOf(v: string | null | undefined): number | null {
    return typeof v === "string" && /^\d+$/.test(v.trim()) && Number(v.trim()) > 0 ? Number(v.trim()) : null;
}

/** done 分区排序键：完成时间归 YYYYMMDD（done_date 优先；缺属性回退 updated 前 8 位=
 *  勾选时刻近似）。降序=新完成在前；同键稳定序保 SQL created ASC 输入序。 */
function doneSortKey(b: BoardTaskRow): string {
    const dd = (b.done_date ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dd)) return dd.replace(/-/g, "");
    return (b.updated ?? "").slice(0, 8);
}

/**
 * 按池看板合成：四列固定（AMMO_POOL_SLUGS 白名单序——goja/V8 键序漂移防御，core 同款纪律）。
 * 合并规则（契约 §2「文档赢」+§8.5 池缓存降级）：
 * - panelTasks（今日配置行）先落——同 taskId 的块池属性行让位（config 赢）；
 * - blocks 里池合法且未被 config 认领的块补进（cache 源——速记/quickAdd 写过池缓存的块）；
 * - 块信息（done/due/content 名）按 taskId 从 blocks 补全（config 行不带勾选态）；
 * - 名字=config 行名赢（配置文本=人刚改过的最新意图），空则块 content 兜底；
 * - 无主行（task 空串）照实出示（taskId 空=不可点）；done 卡按 showDone 过滤，
 *   无主行无块可查 done 恒 false（不过滤——「没认出的照实显示」fail-soft 同族）。
 */
export function buildPoolBoard(input: {
    panelTasks: AmmoTaskView[];
    /** 主线工作域任务块（池缓存+块信息源——boardTasksSql 产物） */
    blocks: BoardTaskRow[];
    /** 池配比（ammo-panel pools 直出——列头副标） */
    poolRatios: Partial<Record<AmmoPoolSlug, number | null>>;
}): BoardColumn[] {
    const byId = new Map<string, BoardTaskRow>();
    for (const b of input.blocks) if (b.id && !byId.has(b.id)) byId.set(b.id, b);
    const claimed = new Set<string>(); // config 认领的块 id（cache 补充让位）
    const cols: BoardColumn[] = AMMO_POOL_SLUGS.map((pool) => ({
        key: `pool:${pool}`,
        title: pool,
        subtitle: poolSubtitle(pool, input.poolRatios[pool] ?? null) ?? undefined,
        pool,
        docId: null,
        cards: [],
        doneCards: [],
    }));
    const colOf = (pool: AmmoPoolSlug): BoardColumn => cols.find((c) => c.pool === pool)!;
    /** done 分区收集（跨列统一降序分发——完成时间新→旧；blk 必在=done 卡必有块可查） */
    const doneSinks: Array<{ col: BoardColumn; card: BoardCard; key: string }> = [];
    let seq = 0;
    for (const t of input.panelTasks) {
        if (!isPoolSlug(t.pool)) continue; // 白名单外池 slug=数据侧异常，fail-soft 跳过
        if (!t.task && !t.name.trim()) continue; // 双空行（无 id 无名）：不可渲染不可寻址，防御丢弃（buildTaskViews 同语义）
        const col = colOf(t.pool);
        const blk = t.task ? byId.get(t.task) : undefined;
        if (t.task) claimed.add(t.task);
        const done = blk ? isDone(blk) : false;
        const card: BoardCard = {
            key: `c${seq++}`,
            taskId: t.task,
            name: t.name || (blk?.content ?? "").trim() || t.task,
            pool: t.pool,
            quota: t.quota ?? quotaOf(blk?.quota),
            due: blk?.due_date?.trim() || null,
            done,
            source: "config",
        };
        if (done && blk) doneSinks.push({ col, card, key: doneSortKey(blk) });
        else col.cards.push(card); // 无主行 done 恒 false——照常进活卡区（fail-soft 同族）
    }
    for (const b of input.blocks) {
        const pool = isPoolSlug(b.pool) ? b.pool : null;
        if (!pool) continue; // 无池缓存块不进按池板（无列可归——fail-soft）
        if (b.id && claimed.has(b.id)) continue; // config 已认领（文档赢）
        const done = isDone(b);
        const card: BoardCard = {
            key: `c${seq++}`,
            taskId: b.id,
            name: (b.content ?? "").trim() || b.id,
            pool,
            quota: quotaOf(b.quota),
            due: b.due_date?.trim() || null,
            done,
            source: "cache",
        };
        if (done) doneSinks.push({ col: colOf(pool), card, key: doneSortKey(b) });
        else colOf(pool).cards.push(card);
    }
    for (const s of doneSinks.sort((x, y) => (x.key < y.key ? 1 : x.key > y.key ? -1 : 0))) {
        s.col.doneCards.push(s.card);
    }
    return cols;
}

// ── 按项目模式 ──

/**
 * 按项目看板合成（folder-model）：列=项目（目录一级文档，一项目一列；列 key=docId——
 * 列尾「+」速记落点=该项目文档「## 任务」章节）；卡=项目子树任务（项目文档+任意层子文档），
 * 按任务块 root_id→所属文档→path 前缀归属项目；归不进任何列的块跳过（fail-soft）。
 */
export function buildProjectBoard(input: {
    projects: BoardProjectRow[];
    subdocs: Array<{ id: string; content?: string; hpath?: string | null; updated?: string; path?: string }>;
    blocks: BoardTaskRow[];
}): BoardColumn[] {
    const projDirs = input.projects.map((p) => ({ id: p.id, dir: p.path.replace(/\.sy$/, "") }));
    const subdocById = new Map(input.subdocs.filter((s) => s?.id).map((s) => [s.id, s]));
    // 归档区子树（03 收拢件联动：收拢=盘点退场——归档区及其子文档的任务不进按项目列；
    // 按池模式不排除=配置行点名块 id 的收据回放语义）
    const archiveDirs = input.subdocs
        .filter((s) => (s.content ?? "").trim() === ARCHIVE_DOC_NAME && s.path)
        .map((s) => s.path!.replace(/\.sy$/, ""));
    const inArchive = (docId: string): boolean => {
        const row = subdocById.get(docId);
        const path = row?.path ?? "";
        if (!path) return false;
        return archiveDirs.some((d) => path === `${d}.sy` || path.startsWith(d + "/"));
    };
    const ownerOf = (docId: string): string | null => {
        if (projDirs.some((p) => p.id === docId)) return docId; // 项目文档自身
        if (inArchive(docId)) return null;
        const row = subdocById.get(docId);
        const path = row?.path ?? "";
        if (!path) return null;
        const hit = projDirs.find((p) => path.startsWith(p.dir + "/"));
        return hit?.id ?? null;
    };
    const cols: BoardColumn[] = input.projects.map((p) => ({
        key: `doc:${p.id}`, title: p.name, subtitle: undefined, pool: null, docId: p.id, cards: [], doneCards: [],
    }));
    const byCol = new Map(cols.map((c) => [c.docId!, c]));
    /** done 分区收集（跨列统一降序分发——完成时间新→旧） */
    const doneSinks: Array<{ col: BoardColumn; card: BoardCard; key: string }> = [];
    let seq = 0;
    for (const b of input.blocks) {
        if (!b.root_id) continue;
        const col = byCol.get(ownerOf(b.root_id) ?? "");
        if (!col) continue;
        const done = isDone(b);
        const card: BoardCard = {
            key: `l${seq++}`,
            taskId: b.id,
            name: (b.content ?? "").trim() || b.id,
            pool: isPoolSlug(b.pool) ? b.pool : null,
            quota: quotaOf(b.quota),
            due: b.due_date?.trim() || null,
            done,
            source: "tree",
        };
        if (done) doneSinks.push({ col, card, key: doneSortKey(b) });
        else col.cards.push(card);
    }
    for (const s of doneSinks.sort((x, y) => (x.key < y.key ? 1 : x.key > y.key ? -1 : 0))) {
        s.col.doneCards.push(s.card);
    }
    return cols;
}

// ── 列尾速记决策 ──

/**
 * 翻日可写判定（看板翻日 manualui）：过去日只读（B1.3「过去组=冻结——对账与 EWMA 的
 * 既成事实，不回改」），今天与未来日可写（当日组=活文档；明日组=AI 每晚预写、用户可增改）。
 * YYYY-MM-DD 字典序=日期序（同形态比较，无时区面）。纯函数（BoardView 列尾入口+单测共用）。
 */
export function isDayWritable(day: string, today: string): boolean {
    return day >= today;
}

/**
 * 列尾「+」速记的池决策：速记显式池词赢（用户打了字=显式意图——「文本即真相」精神），
 * 否则列池兜底（按池列上下文）；按线列无池上下文且速记无池词=null（quickAddTask 只写
 * 有值的属性——无池=纯任务块）。纯函数（BoardView submit 通道+单测共用）。
 */
export function resolveEntryPool(parsedPool: AmmoPoolSlug | null, columnPool: AmmoPoolSlug | null): AmmoPoolSlug | null {
    return parsedPool ?? columnPool;
}
