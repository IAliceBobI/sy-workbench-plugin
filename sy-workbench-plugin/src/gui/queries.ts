// GUI 纯逻辑层（前端驾驶舱+切换器共用）：SQL 文本构造+查询结果→视图模型组装。
// 零 siyuan 运行时依赖（fetch 注入由接线层做）；done 判定复用 kernel/core 同一实现，
// 保证 GUI 看到的数字与 MCP get_progress 永远同源。

import { extractActionsSection, parseActionsSection, stripIal, type ParsedAction } from "@/kernel/core/actions";
import { isDone, type TaskRow } from "@/kernel/core/progressCalc";
import type { SceneSnapshot } from "@/kernel/core/scene";
import type { AmmoLedgerEntry } from "@/kernel/core/ammoLedger";
import { parseConfigRow } from "@/kernel/core/ammoQuadrant";
import { HOME_DIARY_HPATH, HOME_DAYCONFIG_HPATH, ROOT_HPATH, TRIPLET_NAMES, HOME_MARK_ATTR } from "@/shared/homePaths";

const ATTR_PROJECT_STATUS = "custom-project-status";

/** 日志层 hpath（shared/homePaths.ts 单源重导出——diaryJumpSqls 等日志跳转链锚；
 *  folder-model 起三件套在目录一级与项目平级，旧「线分拣」消费面已退役） */
export const DIARY_HPATH = HOME_DIARY_HPATH;

/** 项目行（folder-model：projectRowsFromListing 产物——目录一级文档=项目；path=子树归属锚） */
export interface ProjectRow {
    id: string;
    name: string;
    status: string;
    updated: string;
    path: string;
    hpath?: string | null;
}

// ---------- folder-model：目录发现链（目录一级文档=项目） ----------

/** 目录根定位主通道（IAL 标记——kernel locateRoot 同语义的 SQL 半边；带 path 供任务面前缀锚） */
export function rootLocateSql(): string {
    return `SELECT a.block_id AS id, b.box, b.path FROM attributes a JOIN blocks b ON b.id=a.block_id
    WHERE a.name='${HOME_MARK_ATTR}' AND a.value='1' LIMIT 2`;
}

/** 目录根定位兜底（hpath 命中；调用方命中后可依赖 kernel 侧补打标，前端不写属性） */
export function rootFallbackSql(): string {
    return `SELECT id, box, path FROM blocks WHERE type='d' AND hpath='${ROOT_HPATH}' LIMIT 2`;
}

/** 目录一级文档归档态+updated 批查（一发 IN；status 缺省=活跃——无属性=活跃） */
export function projectMetaSql(ids: string[]): string {
    return `SELECT b.id, b.updated, a.value AS status FROM blocks b
    LEFT JOIN attributes a ON a.block_id=b.id AND a.name='${ATTR_PROJECT_STATUS}'
    WHERE b.id IN ('${ids.join("','")}')`;
}

/** listDocsByPath files+meta → ProjectRow[]（排三件套名；updated 倒序——与 kernel list 同序） */
export function projectRowsFromListing(
    files: Array<{ id?: string; name?: string; path?: string }>,
    metaRows: Array<{ id: string; status?: string | null; updated?: string }>,
): ProjectRow[] {
    const byId = new Map(metaRows.filter((m) => m?.id).map((m) => [m.id, m]));
    return files
        .filter((f) => f?.id && f.name && !TRIPLET_NAMES.includes(f.name))
        .map((f) => ({
            id: f.id!,
            name: f.name!,
            status: byId.get(f.id!)?.status ?? "active",
            updated: byId.get(f.id!)?.updated ?? "",
            path: f.path ?? "",
        }))
        .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
}

/** 目录子树全部文档行（按项目归列/归属用——单前缀替代旧按项目拼 OR） */
export function rootSubtreeDocsSql(rootPath: string): string {
    const dir = rootPath.replace(/\.sy$/, "");
    return `SELECT id, content, hpath, updated, path FROM blocks
    WHERE type='d' AND path LIKE '${dir}/%'
    ORDER BY updated DESC`;
}

/** 看板任务块（folder-model：目录子树单前缀+三件套子树排除；
 *  排除按 id+path 双通道（目录改名后 hpath 常量失效，id/path 不受改名影响）） */
export function boardTasksByRootSql(rootPath: string, triplet: Array<{ id: string; path: string }>): string {
    const dir = rootPath.replace(/\.sy$/, "");
    const exclude = triplet.length
        ? ` AND b.root_id NOT IN (SELECT id FROM blocks WHERE type='d' AND (${triplet.map((t) => `id='${t.id}' OR path LIKE '${t.path.replace(/\.sy$/, "")}/%'`).join(" OR ")}))`
        : "";
    return `SELECT b.id, TRIM(b.content) AS content, b.markdown, b.updated, b.root_id,
        GROUP_CONCAT(CASE WHEN a.name='custom-ammo-pool' THEN a.value END) AS pool,
        GROUP_CONCAT(CASE WHEN a.name='custom-ammo-quota' THEN a.value END) AS quota,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-date' THEN a.value END) AS due_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-done-date' THEN a.value END) AS done_date
    FROM blocks b
    LEFT JOIN attributes a ON a.block_id=b.id AND a.name IN ('custom-ammo-pool','custom-ammo-quota','custom-task-due-date','custom-task-done-date')
    WHERE b.type='i' AND b.subtype='t'
      AND b.root_id IN (SELECT id FROM blocks WHERE type='d' AND path LIKE '${dir}/%')${exclude}
    GROUP BY b.id
    ORDER BY b.created ASC
    LIMIT 800`;
}

/** 增补批二任务四：文档 box+path 直查（文件树定位入参——blocks 文档行 path 带 .sy=文件树 data-path 同形） */
export function docPathSql(docId: string): string {
    return `SELECT box, path FROM blocks WHERE id='${docId}' AND type='d'`;
}

/** 索引脏行防御（09-15 主实例两实锤：blocks/attributes 偶发同 id 物理重复行——JOIN 后
 *  成笛卡尔积膨胀，如 attributes×2 × blocks×2=4 行）。所有 SQL 行→视图模型/菜单渲染的
 *  消费面统一过此函数按 id 去重保首行（□11 各点去重的共享化收编，□14 切换器 4 连重复补漏）。 */
export function dedupeById<T extends { id: string }>(rows: T[]): T[] {
    const seen = new Set<string>();
    return rows.filter((r) => {
        if (!r.id || seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
    });
}

/** 项目子树平铺任务行（与 kernel buildTaskListSql 同域：主文档+全部子文档） */
export function projectTasksSql(projectId: string, projectPath: string): string {
    const dirPrefix = projectPath.replace(/\.sy$/, "");
    return `SELECT b.id, TRIM(b.content) AS content, b.markdown, b.updated, b.root_id
    FROM blocks b
    WHERE b.type='i' AND b.subtype='t'
      AND b.root_id IN (SELECT id FROM blocks WHERE type='d' AND (id='${projectId}' OR path LIKE '${dirPrefix}/%'))
    ORDER BY b.updated DESC
    LIMIT 500`;
}

/** 项目下线（子文档）列表——path 前缀全层级平铺；□6c 起带 hpath（调用方分拣日记子树折叠成一行） */
export function projectLinesSql(projectId: string, projectPath: string): string {
    const dirPrefix = projectPath.replace(/\.sy$/, "");
    return `SELECT id, content, hpath, updated FROM blocks
    WHERE type='d' AND path LIKE '${dirPrefix}/%' AND id!='${projectId}'
    ORDER BY updated DESC`;
}

export function projectDocSql(projectId: string): string {
    return `SELECT b.id, b.content, b.box, b.hpath, b.path, b.created, b.updated, a.value AS status
    FROM blocks b LEFT JOIN attributes a ON a.block_id=b.id AND a.name='${ATTR_PROJECT_STATUS}'
    WHERE b.id='${projectId}' AND b.type='d'`;
}

/** □2 主文档全部列表项块（type='i' 含任务/外部引用/动作段条目）——rawLine↔markdown 归一化匹配块 id */
export function projectActionItemsSql(projectId: string): string {
    return `SELECT id, markdown FROM blocks WHERE type='i' AND root_id='${projectId}'`;
}

// ---------- 森林图（□12）：四锚数据 SQL ----------

/** 子文档列表（带 created——布局时间锚），创建序分道。folder-model 起平铺直出无分拣层
 *  （甘特图直消费——子文档=项目目标的结构分解全显示）。 */
export function forestLinesSql(projectId: string, projectPath: string): string {
    const dirPrefix = projectPath.replace(/\.sy$/, "");
    return `SELECT id, content, hpath, created, updated FROM blocks
    WHERE type='d' AND path LIKE '${dirPrefix}/%' AND id!='${projectId}'
    ORDER BY created ASC`;
}

/** 项目子树任务块（attrs GROUP_CONCAT 与 kernel buildTaskListSql 同款，另带 created）。
 *  folder-model：三件套物理在目录一级（与项目平级）不在项目子树，排除退役；目录改名后
 *  hpath 常量排除本就失效。 */
export function forestTasksSql(projectId: string, projectPath: string): string {
    const dirPrefix = projectPath.replace(/\.sy$/, "");
    return `SELECT b.id, TRIM(b.content) AS content, b.markdown, b.created, b.updated, b.root_id,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-date' THEN a.value END) AS due_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-time' THEN a.value END) AS due_time,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-date' THEN a.value END) AS start_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-time' THEN a.value END) AS start_time,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-done-date' THEN a.value END) AS done_date
    FROM blocks b
    LEFT JOIN attributes a ON a.block_id=b.id AND a.name IN (
        'custom-task-due-date','custom-task-due-time','custom-task-start-date','custom-task-start-time','custom-task-done-date')
    WHERE b.type='i' AND b.subtype='t'
      AND b.root_id IN (SELECT id FROM blocks WHERE type='d' AND (id='${projectId}' OR path LIKE '${dirPrefix}/%'))
    GROUP BY b.id
    ORDER BY b.created ASC
    LIMIT 500`;
}

/** 项目子树块引用（绿果锚：def=引用目标文档，挂引用所在文档的树）。
 *  folder-model：三件套排除退役（同 forestTasksSql——结构上已不可达）。 */
export function forestRefsSql(projectId: string, projectPath: string): string {
    const dirPrefix = projectPath.replace(/\.sy$/, "");
    return `SELECT r.def_block_root_id AS def_root_id, r.root_id AS ref_root_id,
        MAX(b.content) AS def_name, MAX(b.created) AS def_created
    FROM refs r JOIN blocks b ON b.id=r.def_block_root_id
    WHERE r.root_id IN (SELECT id FROM blocks WHERE type='d' AND (id='${projectId}' OR path LIKE '${dirPrefix}/%'))
    GROUP BY r.def_block_root_id, r.root_id`;
}

/** 每日配置月文档定位（kernel locateDayConfigDoc 的读半边 SQL——gui 层 feQuery 版；
 *  只定位不建档：无月文档=挂池 fail-soft 通道面，不自动建）。 */
export function dayConfigDocSql(day: string): string {
    const month = day.slice(0, 7);
    return `SELECT id FROM blocks WHERE type='d' AND hpath='${HOME_DAYCONFIG_HPATH}/${month}' LIMIT 1`;
}

/** 文档内带徽标属性的任务块（dataview □7 徽标注入器初扫——reminder docRemindSql 同款
 *  root_id 限定形态；JOIN（非 LEFT）天然只取挂了三属性任一的任务块=「挂属性才显示」的
 *  SQL 半边，值域白名单（合法 slug/日期形态）在纯层 badgeViewFromAttrs 再过一道）。
 *  扩面（外观三件）：每日配置行（kernel taskRowAttrs 挂 custom-ammo-task 判型键的普通
 *  li，subtype 非 't' 不走任务半边）经 custom-ammo-task 子查询进扫描面——打开每日配置
 *  月文档时行内出只读池色点；池行（poolRowAttrs 无 task 键）不入=行文本即池名不叠徽标。
 *  ⚠判型必须走子查询：块选型条件若写成 `OR a.name='custom-ammo-task'`（作用于 JOIN 后的
 *  行），配置行的 pool/quota 属性行会被 WHERE 整行滤掉→GROUP_CONCAT 恒 null=徽标零注入
 *  （mainfix0923 e2e ④ 实锤）；子查询只决定「哪些块入选」，四属性行全部存活到聚合。 */
export function taskBadgeSql(rootId: string): string {
    return `SELECT b.id, TRIM(b.content) AS content,
        GROUP_CONCAT(CASE WHEN a.name='custom-ammo-pool' THEN a.value END) AS pool,
        GROUP_CONCAT(CASE WHEN a.name='custom-ammo-quota' THEN a.value END) AS quota,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-date' THEN a.value END) AS due_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-ammo-task' THEN a.value END) AS pool_task
    FROM blocks b
    JOIN attributes a ON a.block_id=b.id AND a.name IN ('custom-ammo-pool','custom-ammo-quota','custom-task-due-date','custom-ammo-task')
    WHERE b.root_id='${rootId}' AND b.type='i'
      AND (b.subtype='t' OR b.id IN (SELECT block_id FROM attributes WHERE name='custom-ammo-task'))
    GROUP BY b.id
    LIMIT 500`;
}

/** 文件地图「当日日记」跳转定位 SQL（B3 日账月账化口径）：月文档 `/主线数据/日记/YYYY-MM`
 *  优先，老每日文档 `…/YYYY-MM-DD` 兜底（readDayLedgerLines 双形态探测同款次序）。
 *  只定位不建档；两条都空=跳 toast 懒建提示分支。 */
export function diaryJumpSqls(day: string): string[] {
    return [
        `SELECT id FROM blocks WHERE type='d' AND hpath='${DIARY_HPATH}/${day.slice(0, 7)}' LIMIT 1`,
        `SELECT id FROM blocks WHERE type='d' AND hpath='${DIARY_HPATH}/${day}' LIMIT 1`,
    ];
}

// ---------- 视图模型组装（纯函数） ----------

export function relTime(ts: number, now: number): string {
    const diff = now - ts;
    if (diff < 60_000) return "刚刚";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function groupTaskCounts(rows: TaskRow[]): Map<string, { done: number; total: number }> {
    const out = new Map<string, { done: number; total: number }>();
    for (const r of rows) {
        const c = out.get(r.root_id) ?? { done: 0, total: 0 };
        c.total++;
        if (isDone(r)) c.done++;
        out.set(r.root_id, c);
    }
    return out;
}

/** 驾驶舱线行数字（口径统一）：已完成 done/total——与头部 totalDone 同向同格式（无空格斜杠），
 *  剩余口径（total-done）已废弃（09-14 主线答疑拍板，勿回潮） */
export function countsText(counts: { done: number; total: number }): string {
    return `${counts.done}/${counts.total}`;
}

export interface LineViewModel {
    id: string;
    name: string;
    isMain: boolean;
    counts: { done: number; total: number };
    updated: string;
    /** □6c 日记折叠行专属：天数（有值=行尾数字位显示「N 天」替代 done/total） */
    dayCount?: number;
}

export interface SceneViewModel {
    titles: string[];
    activeIndex: number;
    capturedAgo: string;
}

/** □2 动作区条目（ParsedAction+块 id——记进度 updateBlock 定位用） */
export type DashboardAction = ParsedAction & { blockId?: string };

export interface DashboardModel {
    project: { id: string; name: string; status: string };
    lines: LineViewModel[];
    scene: SceneViewModel | null;
    totals: { done: number; total: number };
    /** 「## 动作」段是否存在（false=自定义动作区不显示，内置按钮照常） */
    hasActionsSection: boolean;
    actions: DashboardAction[];
}

/** 动作区视图装配（纯函数）：段解析+块 id 归一化匹配（文档行与块表 markdown 都可能带 IAL 尾巴） */
export function buildDashboardActions(
    actionsMarkdown: string | undefined,
    actionItems: Array<{ id: string; markdown: string }>,
): { hasActionsSection: boolean; actions: DashboardAction[] } {
    const md = actionsMarkdown ?? "";
    const idByLine = new Map(actionItems.map((r) => [stripIal(r.markdown).trim(), r.id]));
    const actions = parseActionsSection(md).map((a) => ({
        ...a,
        blockId: idByLine.get(stripIal(a.rawLine).trim()),
    }));
    return { hasActionsSection: extractActionsSection(md) !== null, actions };
}

export function buildDashboardModel(input: {
    project: { id: string; name: string; status: string };
    lines: Array<{ id: string; content: string; updated: string; dayCount?: number }>;
    taskRows: TaskRow[];
    snapshot: SceneSnapshot | null;
    now: number;
    actionsMarkdown?: string;
    actionItems?: Array<{ id: string; markdown: string }>;
}): DashboardModel {
    const counts = groupTaskCounts(dedupeById(input.taskRows));
    // 索引脏行防御：blocks 表偶发同 id 物理重复行（09-15 主实例实锤——重复文档行
    // 喂毒 keyed each=整面板冻结），消费侧按 id 去重保首行
    const seenLine = new Set<string>();
    const lines: LineViewModel[] = [
        {
            id: input.project.id,
            name: input.project.name,
            isMain: true,
            counts: counts.get(input.project.id) ?? { done: 0, total: 0 },
            updated: "",
        },
        ...input.lines
            .filter((l) => {
                if (seenLine.has(l.id)) return false;
                seenLine.add(l.id);
                return true;
            })
            .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
            .map((l) => ({
            id: l.id,
            name: l.content || "（无标题）",
            isMain: false,
            counts: counts.get(l.id) ?? { done: 0, total: 0 },
            updated: l.updated,
            dayCount: l.dayCount,
        })),
    ];
    let done = 0;
    let total = 0;
    for (const c of counts.values()) {
        done += c.done;
        total += c.total;
    }
    let scene: SceneViewModel | null = null;
    if (input.snapshot && Array.isArray(input.snapshot.tabs) && input.snapshot.tabs.length > 0) {
        const titles = input.snapshot.tabs.map((t) => t.title ?? t.docId);
        scene = {
            titles,
            activeIndex: input.snapshot.activeDocId
                ? input.snapshot.tabs.findIndex((t) => t.docId === input.snapshot.activeDocId)
                : -1,
            capturedAgo: relTime(input.snapshot.capturedAt, input.now),
        };
    }
    const { hasActionsSection, actions } = buildDashboardActions(input.actionsMarkdown, input.actionItems ?? []);
    return { project: input.project, lines, scene, totals: { done, total }, hasActionsSection, actions };
}

// ---------- 切换器菜单项组装（纯函数） ----------

/** 冷启动引导样本（与设置面板/驾驶舱引导区同源）——带上插件名，AI 工具里能直连对应 MCP 工具 */
export const ONBOARD_SAMPLE = "用工作台插件建个项目：XXX（说说它是干嘛的）";

export type SwitcherItem =
    | { kind: "search"; placeholder: string }
    /** 零项目空提示（空态引导三件退役——目录常在，新建即用） */
    | { kind: "emptyNote"; label: string }
    | { kind: "project"; id: string; label: string; current: boolean; archived: boolean; click: () => void }
    | { kind: "separator" }
    /** 手动建项目入口：项目列表尾部分隔线后 */
    | { kind: "createProject"; label: string; click: () => void };

export type ProjectSwitcherItem = Extract<SwitcherItem, { kind: "project" }>;

export function isProjectItem(i: SwitcherItem): i is ProjectSwitcherItem {
    return i.kind === "project";
}

/** 菜单内搜索过滤（大小写不敏感子串；switcher.ts DOM 显隐同语义） */
export function switcherFilter(name: string, q: string): boolean {
    const qq = q.trim().toLowerCase();
    return !qq || name.toLowerCase().includes(qq);
}

export function buildProjectMenuItems(input: {
    projects: ProjectRow[];
    activeId: string | null;
    onPick: (id: string) => void;
    onCreateProject?: () => void;
    /** 拼装文案（i18n 注入；缺省中文——「（已归档）」硬编码同域先例） */
    texts?: { searchPh?: string; emptyNote?: string };
}): SwitcherItem[] {
    const actives = input.projects.filter((p) => p.status !== "archived");
    const archived = input.projects.filter((p) => p.status === "archived");
    const items: SwitcherItem[] = [
        { kind: "search", placeholder: input.texts?.searchPh ?? "搜索项目…" },
    ];
    if (!input.projects.length) {
        items.push({ kind: "emptyNote", label: input.texts?.emptyNote ?? "目录里还没有项目——点下方「新建项目」开一个" });
    }
    for (const p of actives) {
        items.push({ kind: "project", id: p.id, label: p.name, current: p.id === input.activeId, archived: false, click: () => input.onPick(p.id) });
    }
    if (archived.length) {
        items.push({ kind: "separator" });
        for (const p of archived) {
            items.push({ kind: "project", id: p.id, label: `${p.name}（已归档）`, current: p.id === input.activeId, archived: true, click: () => input.onPick(p.id) });
        }
    }
    if (input.onCreateProject) {
        items.push({ kind: "separator" });
        items.push({ kind: "createProject", label: "新建项目…", click: () => input.onCreateProject?.() });
    }
    return items;
}

/** 日历配置只读镜像（设置面板状态行；config=petal feishu-config.json 摘要）。
 *  结构化两段：main=「✓ 已配置/未配置」（绿/灰主态），detail=通道括注（次级灰）——vision P1-1 拆段 */
export interface FeishuStatus {
    configured: boolean;
    main: string;
    detail: string;
}

export function buildFeishuStatusLine(config: { channel: string; calendarId?: string; enabled: boolean } | null): FeishuStatus {
    if (!config) return { configured: false, main: "未配置", detail: "——带截止的任务不进飞书，其他功能不受影响" };
    const channelPart = config.channel === "oauth"
        ? `B 通道 · 写${config.calendarId === "primary" ? "你的主日历" : "授权日历"}`
        : "A′ 通道 · 机器人共享日历";
    return {
        configured: config.enabled,
        main: config.enabled ? "✓ 已配置" : "✓ 已配置（同步已停用）",
        detail: `（${channelPart}）`,
    };
}

// ---------- 日历同步面板（□3 只读版）：账本→行装配（纯函数，Conf 新区消费） ----------
// 数据=petal calendar-ledger.json（kernel 同步链写的 lastSync 基线）——面板零网络：
// 只呈现「上次同步时点」的两端快照，实时对账要跑一次同步（跟 AI 说）。

import { normalizeLedger, timestampToWallTime, type CalendarLedger, type LedgerSource } from "@/kernel/core/ledger";

export interface LedgerRow {
    source: LedgerSource;
    summary: string;
    /** null=签名无时间字段（兜底显示） */
    syTime: string | null;
    fsTime: string | null;
    /** ok=基线一致；drift=上次同步时两端不一致；conflict=双变冲突史（思源赢） */
    state: "ok" | "drift" | "conflict";
    conflicts: number;
    syncedAt: string | null;
    eventId: string;
}

export interface LedgerPanelModel {
    sources: Record<LedgerSource, { enabled: boolean; allowWriteback: boolean; count: number }>;
    rows: LedgerRow[];
}

function sourceOf(key: string): LedgerSource {
    if (key.startsWith("task:")) return "task";
    if (key.startsWith("flashcard-burden:")) return "burden";
    if (key.startsWith("sched:")) return "sched";
    return "remind";
}

/** 签名时间段（timestamp 秒串或 date 串）→显示串；timed 戳反解换空格，date 原样 */
function sigTimeToDisplay(v: string | undefined): string | null {
    if (!v) return null;
    const wall = timestampToWallTime(v);
    return wall ? wall.replace("T", " ") : v;
}

export function ledgerToRows(raw: CalendarLedger | null | undefined): LedgerPanelModel {
    const ledger = normalizeLedger(raw ?? null);
    const sources = {
        remind: { ...ledger.sources.remind, count: 0 },
        task: { ...ledger.sources.task, count: 0 },
        burden: { ...ledger.sources.burden, count: 0 },
        sched: { ...ledger.sources.sched, count: 0 },
    };
    const rows: LedgerRow[] = [];
    for (const [key, e] of Object.entries(ledger.entries)) {
        const source = sourceOf(key);
        const summary = (e.sySnap?.split("¦")[0] || e.fsSnap?.split("¦")[0] || "").trim();
        const syTime = sigTimeToDisplay(e.sySnap?.split("¦")[1]);
        const fsTime = sigTimeToDisplay(e.fsSnap?.split("¦")[1]);
        const conflicts = e.conflicts ?? 0;
        // 无基线（任一快照缺失）=还没对账过，不虚报 drift
        const state = conflicts > 0
            ? "conflict"
            : e.sySnap && e.fsSnap && e.sySnap !== e.fsSnap ? "drift" : "ok";
        rows.push({ source, summary, syTime, fsTime, state, conflicts, syncedAt: e.syncedAt ?? null, eventId: e.eventId });
        sources[source].count++;
    }
    return { sources, rows };
}

// ---------- 日历区（按钮化 b/d）：同步状态+配置+计数 → 驾驶舱面板视图模型 ----------

import type { CalendarSkipReason, CalendarStatus, CalendarSyncSummary } from "@/kernel/core/calendarStatus";

export interface CalendarPanelModel {
    /** 整区态：not_configured/disabled/never=引导态；error/auth_broken=故障态；ok=常态 */
    state: "not_configured" | "disabled" | "never" | "error" | "auth_broken" | "ok";
    channel?: "bot" | "oauth";
    /** 上次同步时点（ISO；有轮次记录时） */
    at?: string;
    summary?: CalendarSyncSummary;
    /** 本轮跳过原因（ok 态下提示「本轮未同步：原因」） */
    skippedReason?: CalendarSkipReason;
    authErrorCode?: number;
    lastAuthFailDay?: string;
    /** 顶层异常原文（error 态 tooltip） */
    errorText?: string;
    /** 本地提醒条数（SQL count） */
    remindCount: number;
    /** 账本累计冲突次数 */
    conflicts: number;
}

export function buildCalendarPanelModel(input: {
    status: CalendarStatus | null;
    config: { channel: string; enabled: boolean } | null;
    remindCount: number;
    conflictsTotal: number;
}): CalendarPanelModel {
    // strict:false 下三元收窄产物退化 string——字面量 as const 显式钉型
    const raw = input.config?.channel;
    const channel = raw === "oauth" ? "oauth" as const : raw === "bot" ? "bot" as const : undefined;
    if (!input.config) return { state: "not_configured", remindCount: input.remindCount, conflicts: input.conflictsTotal };
    if (!input.config.enabled) return { state: "disabled", channel, remindCount: input.remindCount, conflicts: input.conflictsTotal };
    const s = input.status;
    if (!s) return { state: "never", channel, remindCount: input.remindCount, conflicts: input.conflictsTotal };
    const base = {
        channel,
        at: s.at,
        remindCount: input.remindCount,
        conflicts: input.conflictsTotal,
        ...(s.skipped ? { skippedReason: s.skipped } : {}),
        ...(s.lastAuthFailDay ? { lastAuthFailDay: s.lastAuthFailDay } : {}),
    };
    if (s.error) return { state: "error", ...base, errorText: s.error };
    if (s.authErrorCode !== undefined) return { state: "auth_broken", ...base, authErrorCode: s.authErrorCode };
    return { state: "ok", ...base, ...(s.summary ? { summary: s.summary } : {}) };
}

/** 账本冲突计数汇总（驾驶舱「累计冲突 N 次」口径=三源 entries 的 conflicts 总和） */
export function ledgerConflictsTotal(raw: CalendarLedger | null | undefined): number {
    const ledger = normalizeLedger(raw ?? null);
    let n = 0;
    for (const e of Object.values(ledger.entries)) n += e.conflicts ?? 0;
    return n;
}

/** 全库本地提醒条数 SQL（kernel listRemindBlocksSql 同域 count 版） */
export function countRemindSql(): string {
    return `SELECT COUNT(*) AS n FROM attributes a JOIN blocks b ON b.id=a.block_id WHERE a.name='custom-remind-at'`;
}

// ---------- 日历月历模型（calnav □2）：三源 → 42 格（纯函数，Calendar.svelte 消费） ----------
// remind=全库提醒扫描行（循环对 42 格逐日展开）；task=全库 due 任务（done 不显示——与同步链
// shouldHave=dueDate&&!done 同口径）；burden=账本 flashcard-burden: 条目（日期 sySnap 反解，
// 只显示账本已有日，未来日预测不做）。红态：remind=isDueRemind 同源、task=due<=今日、burden 恒 false。

import {
    isDueRemind,
    parseRemindAt,
    parseRemindRepeat,
    stripTaskMark,
    todayIsOccurrence,
} from "@/kernel/core/remind";
import { parseBurdenKey } from "@/kernel/core/burden";
import { normalizeMirror, type InstanceRow, type MirrorEvent } from "@/kernel/core/calendarMirror";
import { boardItemInWindow, parseSchedItemText } from "@/kernel/core/schedboard";
import type { SchedItem } from "@/kernel/core/schedule";

/** remind 扫描行（kernel listRemindBlocksSql 产物列子集；□21 时间线消费 end） */
export interface RemindScanRow {
    id: string;
    at: string;
    repeat: string | null;
    end?: string | null;
    content: string;
    /** 期② 班表块旗标（挂 custom-sched-origin 的块=班表条目，sched 源渲染——消费面据此去重） */
    sched_origin?: string | null;
}

/** 全库任务 due 行（allDueTasksSql 产物列；□21 时间线消费 start 两列） */
export interface TaskDueRow {
    id: string;
    content: string;
    markdown: string;
    due_date: string | null;
    due_time: string | null;
    start_date?: string | null;
    start_time?: string | null;
}

export interface MonthEvent {
    date: string;
    /** null=全天形态（无 due_time/burden 全天事件） */
    time: string | null;
    summary: string;
    /** ammo □7：live=日账实况回填（日历双类第二类——无提醒纯展示回望形态） */
    source: LedgerSource | "feishu" | "sched" | "live";
    /** 点条目跳源块（burden=项目主文档；feishu 回流事件无源块不可点） */
    blockId?: string;
    /** 红态：今日已到/已过（burden/feishu 恒 false——信息性事件不做截止红态） */
    isDue: boolean;
    /** feishu 镜像源：飞书侧 event_id（sloop □17 落地钮通道；其余源无） */
    eventId?: string;
    /** feishu 源可落地成班表条目（□17：非全天/非循环/班表可表达）；undefined=非 feishu 源不显钮 */
    adoptable?: boolean;
    /** 不可落地原因（adoptable=false 时钮 title 提示） */
    adoptBlock?: "allDay" | "recurring" | "unrepresentable" | "too_old" | "already";
    /** remind 循环实例旗标（caltab：月历右键删除特判——动基础块波及全部实例不可删；
     *  单次 remind/task/sched 恒缺省=false 形态） */
    repeat?: boolean;
}

export interface MonthCell {
    date: string;
    inMonth: boolean;
    events: MonthEvent[];
    /** B1 日历双层：格内计划/实况汇总行（plan/live 各自 null=零内容不显行） */
    duo: MonthDuo;
}

// ── B1 日历双层：计划层（班表锚点+每日配置）vs 实况层（日账）格内汇总（纯投影零存储） ──

/** 计划层摘要（当日班表锚点数+硬锚数+每日配置任务行数） */
export interface MonthDuoPlan {
    anchors: number;
    hardAnchors: number;
    ammoTasks: number;
}

/** 实况层摘要（当日打点条数+闭合段合计分钟+未闭合条数） */
export interface MonthDuoLive {
    count: number;
    totalMin: number;
    unclosed: number;
}

/** 月历格双层摘要（plan/live 各自 null=零内容不显行；blockId=行点击跳源锚——禁聚焦链） */
export interface MonthDuo {
    plan: MonthDuoPlan | null;
    live: MonthDuoLive | null;
    /** 计划行点击锚：每日配置容器块 id 优先，纯锚点日=首个班表块 id；null=无可跳目标 */
    planBlockId?: string;
    /** 实况行点击锚：当日首条打点块 id（live 非 null 时恒在） */
    liveBlockId?: string;
}

/** 双层汇总纯函数（B1）：三源按日聚合 → day→MonthDuo。零输入日不产条目（消费面
 *  duo.get(date) ?? {plan:null,live:null} 兜底）。锚点计数=SchedItem 日窗闸后条目（与
 *  事件条同源同窗）；实况合计=闭合段 ΣdurationMin（跨零点 +24h 归一已在读面做），
 *  未闭合不计时长只计 unclosed（月历=静态快照，进行中段时长动态折算不稳）。 */
/** buildMonthDuo 聚合中间态 */
interface DuoSlot {
    plan: MonthDuoPlan;
    cfg?: DayConfigCount;
    /** 纯锚点日的计划行跳源锚（首班表块 id——配置容器缺席时兜底） */
    anchorBlockId?: string;
    live?: MonthDuoLive;
    liveBlockId?: string;
}

export function buildMonthDuo(input: {
    sched?: SchedItem[];
    configCounts?: Map<string, DayConfigCount>;
    ledgerDays?: Array<{ day: string; items: AmmoLedgerEntry[] }>;
}): Map<string, MonthDuo> {
    const byDay = new Map<string, DuoSlot>();
    const slot = (day: string): DuoSlot => {
        let s = byDay.get(day);
        if (!s) {
            s = { plan: { anchors: 0, hardAnchors: 0, ammoTasks: 0 } };
            byDay.set(day, s);
        }
        return s;
    };
    // 计划层·班表锚点（软硬都计——「当日班表锚点」=班表容器里的行）
    for (const it of input.sched ?? []) {
        if (!DATE_RE.test(it.date)) continue;
        const s = slot(it.date);
        s.plan.anchors++;
        if (it.hard) s.plan.hardAnchors++;
        s.anchorBlockId ??= it.key; // 纯锚点日的计划行跳源锚（班表块 id）
    }
    // 计划层·每日配置任务行（dayConfigCounts 判官同源 parseConfigRow——宁少认不错认）
    for (const [day, c] of input.configCounts ?? []) {
        if (!DATE_RE.test(day) || c.tasks <= 0) continue;
        const s = slot(day);
        s.plan.ammoTasks = c.tasks;
        s.cfg = c;
    }
    // 实况层·日账（B3 月文档通道读面产物）
    for (const dayRow of input.ledgerDays ?? []) {
        if (!DATE_RE.test(dayRow.day)) continue;
        for (const entry of dayRow.items) {
            if (!TIME_RE.test(entry.start)) continue;
            const s = slot(dayRow.day);
            s.live ??= { count: 0, totalMin: 0, unclosed: 0 };
            s.live.count++;
            if (entry.closed && entry.durationMin != null && entry.durationMin > 0) s.live.totalMin += entry.durationMin;
            if (!entry.closed) s.live.unclosed++;
            s.liveBlockId ??= entry.id; // 首条打点块（跳源锚）
        }
    }
    const out = new Map<string, MonthDuo>();
    for (const [day, s] of byDay) {
        const plan = s.plan.anchors > 0 || s.plan.ammoTasks > 0 ? s.plan : null;
        out.set(day, {
            plan,
            live: s.live && s.live.count > 0 ? s.live : null,
            ...(plan ? { planBlockId: s.cfg?.containerId ?? s.cfg?.docId ?? s.anchorBlockId } : {}),
            ...(s.live && s.live.count > 0 ? { liveBlockId: s.liveBlockId } : {}),
        });
    }
    return out;
}

const MONTH_SUMMARY_MAX = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function truncSummary(s: string): string {
    return s.length > MONTH_SUMMARY_MAX ? s.slice(0, MONTH_SUMMARY_MAX) + "…" : s;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 全库 due 任务 SQL（GROUP_CONCAT 两列模式照 kernel buildTaskListSql；无项目域=全库，
 *  子查询限窄只扫有 due 属性的任务）。□21：加 start 两列（区间任务源，月历消费面不读无感） */
export function allDueTasksSql(): string {
    return `SELECT b.id, TRIM(b.content) AS content, b.markdown,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-date' THEN a.value END) AS due_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-time' THEN a.value END) AS due_time,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-date' THEN a.value END) AS start_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-time' THEN a.value END) AS start_time
    FROM blocks b
    LEFT JOIN attributes a ON a.block_id=b.id AND a.name IN ('custom-task-due-date','custom-task-due-time','custom-task-start-date','custom-task-start-time')
    WHERE b.type='i' AND b.subtype='t'
      AND b.id IN (SELECT block_id FROM attributes WHERE name='custom-task-due-date')
    GROUP BY b.id
    ORDER BY b.id
    LIMIT 500`;
}

/** □17 落地可行性（kernel 纯层 adoptForeignEvent 门禁的显示侧同则；账本防重由 pluginEventIds
 *  分流先行——已绑事件根本不产 feishu 行）。镜像一次性事件进此函数时恒非 recurring。
 *  too_old 与纯层同则：超班表保留窗（today-59 前）拒绝——门禁刀二。 */
export function adoptability(ev: MirrorEvent, today: string): { adoptable: boolean; adoptBlock?: "allDay" | "recurring" | "unrepresentable" | "too_old" | "already" } {
    if (ev.allDay) return { adoptable: false, adoptBlock: "allDay" };
    const sHM = ev.start.slice(11, 16), eHM = (ev.end ?? "").slice(11, 16);
    const sameDay = !!ev.end && ev.end.slice(0, 10) === ev.start.slice(0, 10);
    const sum = ev.summary.trim();
    if (!sameDay || !sum || sum === "(无标题)" || !eHM || eHM <= sHM) {
        return { adoptable: false, adoptBlock: "unrepresentable" };
    }
    // 与 core/schedule SCHEDULE_KEEP_DAYS=60 同则（不 import 纯层常量=gui 层零依赖先例）
    const day = ev.start.slice(0, 10);
    const cut = new Date(today + "T00:00:00");
    cut.setDate(cut.getDate() - 59);
    const p = (n: number) => String(n).padStart(2, "0");
    const cutStr = `${cut.getFullYear()}-${p(cut.getMonth() + 1)}-${p(cut.getDate())}`;
    if (day < cutStr) return { adoptable: false, adoptBlock: "too_old" };
    return { adoptable: true };
}

/** 三源+□17 回流镜像 → 42 格月历模型（周一起；首格=1 号所在周的周一，含上月尾/下月头——月外格
 *  inMonth=false 事件照进）。同日按 time 升序、无时间垫底。B1：configCounts 入参加入
 *  buildMonthDuo 聚合（格 duo 双层摘要——缺省三源里有什么算什么）。 */
export function buildMonthModel(
    input: { now: Date; remindRows: RemindScanRow[]; taskRows: TaskDueRow[]; ledger: unknown; mirror?: unknown; instances?: InstanceRow[]; sched?: SchedItem[]; ledgerDays?: Array<{ day: string; items: AmmoLedgerEntry[] }>; configCounts?: Map<string, DayConfigCount> },
    year: number,
    month: number,
): MonthCell[] {
    // 索引脏行防御：重复任务/提醒行会一天多事件（dedupeById 保首行，□14）
    const taskRows = dedupeById(input.taskRows);
    const remindRows = dedupeById(input.remindRows);
    const first = new Date(year, month - 1, 1);
    const lead = (first.getDay() + 6) % 7; // 周一=0
    const gridStart = new Date(year, month - 1, 1 - lead);
    const gridDays: Date[] = [];
    for (let i = 0; i < 42; i++) {
        gridDays.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
    }
    const byDate = new Map<string, MonthEvent[]>();
    const push = (e: MonthEvent) => {
        const list = byDate.get(e.date) ?? [];
        list.push(e);
        byDate.set(e.date, list);
    };
    const today = isoDate(input.now);

    // remind：单次=at 日期一格；循环=42 格逐日 todayIsOccurrence（脏 repeat→单次，与 isDueRemind 同则）。
    // 期② 去重：班表块（sched_origin 旗标）走 sched 源（input.sched=块扫描产物）——双路不重复
    for (const r of remindRows) {
        if (r.sched_origin) continue;
        const at = parseRemindAt(r.at);
        if (!at) continue; // 脏值静默跳过
        const rp = r.repeat ? parseRemindRepeat(r.repeat) : null;
        const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
        const summary = truncSummary(stripTaskMark(r.content ?? ""));
        const isDue = isDueRemind(r.at, input.now, r.repeat);
        if (!rp) {
            push({ date: isoDate(at), time, summary, source: "remind", blockId: r.id, isDue });
        } else {
            for (const day of gridDays) {
                if (todayIsOccurrence(r.at, rp, day)) {
                    // 红态按格算（条目级 isDue 只对今日格成立）：过去实例=已过红、今日=时刻判定、未来不红
                    const cellDate = isoDate(day);
                    const cellDue = cellDate < today ? true : cellDate === today ? isDue : false;
                    push({ date: cellDate, time, summary, source: "remind", blockId: r.id, isDue: cellDue, repeat: true });
                }
            }
        }
    }

    // task：done 不显示（isDone 同源）；红=due<=今日（字典序可比）
    for (const t of taskRows) {
        if (!t.due_date || !DATE_RE.test(t.due_date)) continue;
        const y = Number(t.due_date.slice(0, 4));
        const m = Number(t.due_date.slice(5, 7));
        const dd = Number(t.due_date.slice(8, 10));
        const dt = new Date(y, m - 1, dd);
        if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== dd) continue; // 2026-09-31 形态=脏
        if (isDone({ id: t.id, content: t.content, markdown: t.markdown, updated: "", root_id: "" })) continue;
        const time = t.due_time && TIME_RE.test(t.due_time) ? t.due_time : null;
        push({ date: t.due_date, time, summary: truncSummary(t.content ?? ""), source: "task", blockId: t.id, isDue: t.due_date <= today });
    }

    // burden：账本 flashcard-burden: 条目——日期=sySnap 第二段（date 串原样/timestamp 秒串反解），
    // summary=第一段；blockId=键内项目 id；无 sySnap 的脏行静默跳过
    const ledger = normalizeLedger((input.ledger as any) ?? null);
    for (const [key, e] of Object.entries(ledger.entries)) {
        if (!key.startsWith("flashcard-burden:")) continue;
        const snap = (e.sySnap ?? "").split("¦");
        const summary = (snap[0] ?? "").trim();
        const rawStart = snap[1];
        if (!summary || !rawStart) continue;
        const date = DATE_RE.test(rawStart)
            ? rawStart
            : (() => { const w = timestampToWallTime(rawStart); return w ? w.slice(0, 10) : null; })();
        if (!date) continue;
        push({ date, time: null, summary, source: "burden", blockId: parseBurdenKey(key)?.projectId, isDue: false });
    }

    // □17 feishu 回流：插件建事件（账本有映射）已在 remind/task/burden 源显示——镜像按
    // event_id 对账本分流去重，只显示飞书原创（手建）；循环主事件不直接显示（实例走 instances）
    // □18 例外：天气事件（weather: 键）是插件建但三源都不显示——不进分流集，从镜像源显示
    const pluginEventIds = new Set<string>();
    for (const [key, e] of Object.entries(ledger.entries)) if (e.eventId && !key.startsWith("weather:")) pluginEventIds.add(e.eventId);
    // 全源绑定集（含 weather，review P2-2）：天气事件从镜像源显示但已是插件镜像——落地钮须禁用
    const allBoundIds = new Set<string>();
    for (const [, e] of Object.entries(ledger.entries)) if (e.eventId) allBoundIds.add(e.eventId);
    const mirror = normalizeMirror(input.mirror ?? null);
    const mirrorOneOffIds = new Set<string>();
    if (mirror) {
        for (const ev of Object.values(mirror.events)) {
            if (ev.recurring || pluginEventIds.has(ev.id)) continue;
            mirrorOneOffIds.add(ev.id);
            push({
                date: ev.start.slice(0, 10),
                time: ev.allDay ? null : ev.start.slice(11, 16),
                summary: truncSummary(ev.summary),
                source: "feishu",
                isDue: false,
                eventId: ev.id,
                ...(allBoundIds.has(ev.id) ? { adoptable: false, adoptBlock: "already" as const } : adoptability(ev, today)),
            });
        }
    }
    // 循环系列实例（instance_view 按需拉取）：cancelled 例外跳过；账本/镜像一次性已显示的按
    // eventId 去重；同实例跨缓存块重复按 id 去重。落地=循环系恒不可（镜像只有系列定义）
    const seenInstanceIds = new Set<string>();
    for (const row of input.instances ?? []) {
        if (row.cancelled || seenInstanceIds.has(row.id)) continue;
        if (pluginEventIds.has(row.eventId) || mirrorOneOffIds.has(row.eventId)) continue;
        seenInstanceIds.add(row.id);
        push({ date: row.date, time: row.time, summary: truncSummary(row.summary), source: "feishu", isDue: false, eventId: row.eventId, adoptable: false, adoptBlock: "recurring" });
    }

    // sloop □4 本地班表：条目直进格（time=start 无时刻垫底同日末；无红态——班表不做截止压迫）。
    // caltab：blockId=it.key（SchedItem.key=班表块 id——月历右键删除〔schedEdit remove〕/跳源块的锚）
    for (const it of input.sched ?? []) {
        push({ date: it.date, time: it.start, summary: truncSummary(it.summary), source: "sched", blockId: it.key, isDue: false });
    }

    // ammo □7 实况回填（日历双类第二类）：日账打点=回望形态事件条（无提醒纯展示——锚点前瞻
    // 走 remind/sched 现有链零改动，实况段新 live 源）。闭合+未闭合都显（未闭合=进行中段）；
    // 点条目跳打点条目块；右键动作=entryMenuActions live→[]（append-only 不动历史）。
    for (const dayRow of input.ledgerDays ?? []) {
        if (!DATE_RE.test(dayRow.day)) continue;
        for (const entry of dayRow.items) {
            if (!TIME_RE.test(entry.start)) continue;
            push({
                date: dayRow.day,
                time: entry.start,
                summary: truncSummary(entry.summary),
                source: "live",
                blockId: entry.id,
                isDue: false,
            });
        }
    }

    // B1 双层摘要（格属日聚合——月外格照算：事件条同口径全收）
    const duo = buildMonthDuo(input);

    return gridDays.map((d) => {
        const date = isoDate(d);
        return {
            date,
            inMonth: d.getMonth() === month - 1,
            events: (byDate.get(date) ?? []).sort((a, b) => {
                if (!a.time) return 1;
                if (!b.time) return -1;
                return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
            }),
            duo: duo.get(date) ?? { plan: null, live: null },
        };
    });
}

// ── B1 日历双层·计划层配置源：每日配置容器行 SQL 扫描（listBoardBlocksSql 同族——月历
// 既有 SQL 面通道，翻月重拉同 remind/task/board 三源节奏；判型复用 core/ammoQuadrant
// parseConfigRow 单一判官=四象限/体检同口径：文本优先属性兜底，手写行池缺失=未认跳过） ──

/** 每日配置容器行扫描行（dayConfigRowsSql 产物列；day=容器 custom-ammo-day） */
export interface DayConfigScanRow {
    id: string;
    content: string | null;
    /** custom-ammo-pool（GROUP_CONCAT 首段——脏行物理重复拼接防御） */
    pool: string | null;
    /** custom-ammo-task（任务行判型的属性半边） */
    task: string | null;
    /** 容器 custom-ammo-day（YYYY-MM-DD；null=容器缺日键的脏形态） */
    day: string | null;
    /** 容器块 id（行 parent——计划行点击跳源锚） */
    parent_id: string;
    /** 宿主月文档 id（容器锚缺席时的跳源兜底） */
    root_id: string;
    /** custom-ammo-ratio（B2 配额对账：老池行属性兜底通道的配比半边；文本行不用） */
    ratio?: string | null;
    /** custom-ammo-quota（B2 配额对账：老任务行属性兜底通道的配额半边；文本行不用） */
    quota?: string | null;
}

/** 月文档集合 → 配置容器行扫描 SQL（行=容器子块〔parent_id=容器〕+容器 day 属性 join；
 *  手写行无 custom-ammo-* 属性仍出列——LEFT JOIN 保行，判型在纯函数文本优先）。
 *  B2 起 a.name 透视集扩 ratio/quota 两列（□2 前老行属性兜底——文本即真相但老数据零迁移，
 *  引擎双写保持后两通道一致，扫上只为老行） */
export function dayConfigRowsSql(months: string[]): string {
    const ok = months.filter((m) => /^\d{4}-\d{2}$/.test(m));
    const inList = (ok.length ? ok : ["1970-01"]).map((m) => `'${HOME_DAYCONFIG_HPATH}/${m}'`).join(",");
    return `SELECT b.id, TRIM(b.content) AS content,
        GROUP_CONCAT(CASE WHEN a.name='custom-ammo-pool' THEN a.value END) AS pool,
        GROUP_CONCAT(CASE WHEN a.name='custom-ammo-task' THEN a.value END) AS task,
        GROUP_CONCAT(CASE WHEN ca.name='custom-ammo-day' THEN ca.value END) AS day,
        GROUP_CONCAT(CASE WHEN a.name='custom-ammo-ratio' THEN a.value END) AS ratio,
        GROUP_CONCAT(CASE WHEN a.name='custom-ammo-quota' THEN a.value END) AS quota,
        b.parent_id, b.root_id
    FROM blocks b
    LEFT JOIN attributes a ON a.block_id=b.id AND a.name IN ('custom-ammo-pool','custom-ammo-task','custom-ammo-ratio','custom-ammo-quota')
    JOIN blocks c ON c.id=b.parent_id
    LEFT JOIN attributes ca ON ca.block_id=c.id AND ca.name='custom-ammo-day'
    WHERE b.parent_id IN (SELECT block_id FROM attributes WHERE name='custom-role' AND value='ammo-dayconfig')
      AND b.root_id IN (SELECT id FROM blocks WHERE type='d' AND hpath IN (${inList}))
    GROUP BY b.id
    ORDER BY b.id
    LIMIT 2000`;
}

/** 一日配置计数（B1 计划层摘要——月历格「N弹」的数据源；跳源锚随行） */
export interface DayConfigCount {
    day: string;
    /** 任务行数（弹药数——池行不计） */
    tasks: number;
    /** 配置容器块 id（计划行点击锚；理论恒在——行从容器 join 来） */
    containerId: string | null;
    /** 宿主月文档 id（兜底锚） */
    docId: string | null;
}

/** 扫描行 → 逐日任务行计数（GROUP_CONCAT 首段归一+parseConfigRow 判型——四象限/体检
 *  同一判官；池行/未认行/坏 day 静默跳过 fail-soft） */
export function dayConfigCounts(rows: DayConfigScanRow[]): Map<string, DayConfigCount> {
    const out = new Map<string, DayConfigCount>();
    for (const r of rows) {
        if (!r?.id) continue;
        const day = (r.day ?? "").split(",")[0].trim();
        if (!DATE_RE.test(day)) continue; // 容器缺日键/坏值=脏行
        const pool = (r.pool ?? "").split(",")[0] || null;
        const task = (r.task ?? "").split(",")[0] || null;
        // 属性合成按 getBlockAttrs 真实形态：未设键=缺席（非空串——空串 task 会让
        // parseConfigRow 属性兜底分支误判成任务行）
        const attrs: Record<string, string> = {};
        if (pool) attrs["custom-ammo-pool"] = pool;
        if (task) attrs["custom-ammo-task"] = task;
        const row = parseConfigRow(r.content, attrs);
        if (!row || !("task" in row)) continue; // 池行不计/未认跳过（与 □8 体检同口径）
        const c = out.get(day) ?? { day, tasks: 0, containerId: r.parent_id || null, docId: r.root_id || null };
        c.tasks++;
        c.containerId ??= r.parent_id || null;
        c.docId ??= r.root_id || null;
        out.set(day, c);
    }
    return out;
}

// ── timeblock 期 2 ②：班表块全库扫描（月历 sched 源切块——petal SchedStore 读面退役） ──
// 源真相=日记班表块（custom-sched-origin 旗标）；date 双通道：定时行取 remind_at 前半（权威），
// 托盘行取日记文档标题（日记=一天的格子——doc content=日期串）。日窗闸在此过（P2-3）。

/** 班表块扫描行（listBoardBlocksSql 产物列） */
export interface BoardScanRow {
    id: string;
    content: string;
    markdown: string;
    /** custom-remind-at 值（YYYY-MM-DDTHH:mm；托盘行=null） */
    remind_at: string | null;
    remind_end: string | null;
    hard: string | null;
    origin: string | null;
    /** 宿主日记文档标题（YYYY-MM-DD；托盘行 date 唯一来源） */
    doc_date: string | null;
}

/** 全库班表块扫描 SQL（子查询锚 custom-sched-origin；GROUP_CONCAT 透视四属性+doc 标题日期） */
export function listBoardBlocksSql(): string {
    return `SELECT b.id, TRIM(b.content) AS content, b.markdown,
        GROUP_CONCAT(CASE WHEN a.name='custom-remind-at' THEN a.value END) AS remind_at,
        GROUP_CONCAT(CASE WHEN a.name='custom-remind-end' THEN a.value END) AS remind_end,
        GROUP_CONCAT(CASE WHEN a.name='custom-sched-hard' THEN a.value END) AS hard,
        GROUP_CONCAT(CASE WHEN a.name='custom-sched-origin' THEN a.value END) AS origin,
        d.content AS doc_date
    FROM blocks b
    LEFT JOIN attributes a ON a.block_id=b.id AND a.name IN ('custom-remind-at','custom-remind-end','custom-sched-hard','custom-sched-origin')
    JOIN blocks d ON d.id=b.root_id AND d.type='d'
    WHERE b.id IN (SELECT block_id FROM attributes WHERE name='custom-sched-origin')
    GROUP BY b.id
    ORDER BY b.id
    LIMIT 2000`;
}

const HM_OF = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 扫描行 → SchedItem（月历/消费面同形；key=块 id）。日窗闸=boardItemInWindow 同则；
 *  脏行宽容（无 date 可判/坏时间→托盘化或跳过），created/updated 视图不用置空串。
 *  □2 时刻读=行文本优先（`09:30 摘要` 头，summary 剥时刻头）、remind-at/end 属性兜底
 *  （老条目零迁移——引擎双写保持两源一致）。 */
export function boardRowsToSchedItems(rows: BoardScanRow[], today: string): SchedItem[] {
    const out: SchedItem[] = [];
    for (const r of rows) {
        if (!r?.id) continue;
        // GROUP_CONCAT 首 fragment（脏行物理重复拼接取首段）
        const atVal = (r.remind_at ?? "").split(",")[0] ?? "";
        const endVal = (r.remind_end ?? "").split(",")[0] ?? "";
        const docDate = (r.doc_date ?? "").split(",")[0].trim();
        const date = DATE_RE.test(atVal.slice(0, 10)) ? atVal.slice(0, 10) : DATE_RE.test(docDate) ? docDate : "";
        if (!date) continue; // 双通道都判不出日=脏行
        const origin = r.origin === "ai" || r.origin === "roll" || r.origin === "report" || r.origin === "adopt" ? r.origin : "user";
        if (!boardItemInWindow(date, origin, today)) continue; // 日窗闸（P2-3）
        const parsed = parseSchedItemText(r.content);
        const start = parsed ? parsed.start : atVal.length >= 16 && HM_OF.test(atVal.slice(11, 16)) ? atVal.slice(11, 16) : null;
        let end: string | null = null;
        if (parsed && parsed.end) end = parsed.end;
        else if (endVal.length >= 16 && HM_OF.test(endVal.slice(11, 16))) end = endVal.slice(11, 16);
        out.push({
            key: r.id,
            // ​ 归一（空草稿 li 的 SQL content=零宽空格，SQLite TRIM 剔不掉）+去哨兵
            // （与 schedBoardReadRpc 同策：读通道零哨兵，视图层兜底「（空条目）」）
            summary: parsed ? parsed.summary : (r.content ?? "").replace(/\u200b/g, "").trim().slice(0, 100),
            date,
            start,
            end: start && end && end > start ? end : null,
            hard: r.hard === "1",
            origin,
            createdAt: "",
            updatedAt: "",
        });
    }
    return out;
}

// ── timeblock 期 2 ⑧：驾驶舱 KPI 三卡纯层 ──

/** 进度走势柱（近 N 天每日新完成任务数——默认口径，可调）：完成日=块 updated 所在日
 *  （内容事务时间戳；完成后又改文案会挪桶=已知口径偏差，展示面足够）。 */
export interface TrendBar {
    /** YYYY-MM-DD */
    date: string;
    count: number;
}

export function buildTrendBars(taskRows: TaskRow[], now: number, days: number = 14): { bars: TrendBar[]; max: number } {
    const n = Math.max(1, Math.floor(days));
    const counts = new Map<string, number>();
    for (const r of dedupeById(taskRows)) {
        if (!isDone(r)) continue;
        const u = r.updated ?? "";
        if (u.length < 8) continue; // 脏行防御
        const key = u.slice(0, 8); // YYYYMMDD（本地时刻字典序）
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const anchor = new Date(now);
    const bars: TrendBar[] = [];
    for (let i = n - 1; i >= 0; i--) {
        const iso = isoDate(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - i));
        bars.push({ date: iso, count: counts.get(iso.replace(/-/g, "")) ?? 0 });
    }
    const max = Math.max(1, ...bars.map((b) => b.count));
    return { bars, max };
}

/** 「今天」卡数据：班表 N 条+今日到期待办 M+下一项（board+remind 并集里最早未过时刻；
 *  remind 行的 sched_origin 旗标去重——班表块双通道与月历同则）。 */
export interface DashboardTodayModel {
    boardCount: number;
    todoCount: number;
    next: { start: string; summary: string } | null;
}

export function buildDashboardToday(input: {
    boardItems: Array<{ summary?: string | null; start?: string | null }>;
    remindRows: RemindScanRow[];
    taskRows: TaskDueRow[];
    today: string;
    nowHM: string;
}): DashboardTodayModel {
    // done 不计待办（isDone 同源——与月历 task 源同口径）
    const todoCount = dedupeById(input.taskRows).filter(
        (t) => t.due_date === input.today && !isDone({ id: t.id, content: t.content, markdown: t.markdown, updated: "", root_id: "" }),
    ).length;
    let best: { start: string; summary: string } | null = null;
    const consider = (start: string | null | undefined, summary: string) => {
        if (!start || !TIME_RE.test(start) || start < input.nowHM) return; // 已过时刻不算「下一项」
        const s = truncSummary(summary.trim());
        if (best === null || start < best.start) best = { start, summary: s };
    };
    for (const it of input.boardItems) consider(it.start, it.summary ?? "");
    for (const r of dedupeById(input.remindRows)) {
        if (r.sched_origin) continue;
        const at = parseRemindAt(r.at);
        if (!at || isoDate(at) !== input.today) continue;
        consider(`${pad2(at.getHours())}:${pad2(at.getMinutes())}`, stripTaskMark(r.content ?? ""));
    }
    return { boardCount: input.boardItems.length, todoCount, next: best };
}
