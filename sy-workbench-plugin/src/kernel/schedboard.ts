// timeblock 期 1：班表块写入编排层——「一切时间皆块」的写入半边。
// 链路：定位主线目录(/Project，locateRoot 双通道) → 幂等懒建 /Project/日志/<day> →
// 在日志里 diff 重放班表列表块（update 保块 id / insert 中序锚插 / delete 消失项）。
// 副作用全走 ./api（单测 mock 边界）；纯决策在 core/schedboard。
// 错误兜底（定案）：双写互不阻塞——本层任何失败返回 {ok:false,error} 不 throw，
// petal 班表照写（调用方 routineTools 接管），班表区=AI 全权写区域，整批重写幂等自愈。
import {
    createDocWithMd,
    deleteBlock,
    getBlockAttrs,
    getChildBlocks,
    insertBlockMarkdown,
    insertListItem,
    listDocsByPath,
    lsNotebooks,
    setBlockAttrs,
    sql,
    updateBlockMarkdown,
} from "./api";
import {
    attrsToSchedEnd,
    attrsToSchedStart,
    boardItemInWindow,
    collectUnrecognizedBoardLines,
    insertAnchorAfter,
    isSchedBoardAttrs,
    normalizeBoardItems,
    parseSchedItemText,
    remapSchedItems,
    schedItemText,
    schedItemToAttrs,
    SCHED_BOARD_ROLE_VALUE,
} from "./core/schedboard";
import { getLogicalDay } from "./core/dates";
import { isValidDay } from "./core/schedule";
import type { SchedItem } from "./core/schedule";
import type { HealthLineInput } from "./core/ammoHealth";
import { buildFlashAttr, flashDueTimestamp, parseFlashAttr, type FlashWaveMeta } from "./core/flashwave";
import { applyFlashDue } from "./flashwave";

const BOARD_TITLE = "## 班表";

// folder-model：主线目录常量单源（/Project——非项目、不进项目列表、删除通道够不着）
import { ROOT_HPATH, ROOT_NAME, HOME_MARK_ATTR, DIARY_NAME, LEGACY_MAINLINE_HPATH, LEGACY_SPLIT_HPATH } from "../shared/homePaths";

export interface BoardWriteResult {
    ok: boolean;
    /** 日记文档 id（ok=true 时在） */
    docId?: string;
    updated?: number;
    inserted?: number;
    deleted?: number;
    /** 旧 petal key → 新列表项块 id（块写入成功后调用方据此迁移 petal items 的 key——key=块 id 双写主键） */
    keyRemap: Map<string, string>;
    error?: string;
}

/** 建链缓存（防同轮连写撞 SQL 索引窗重复建「日记」层/文档——kernel bundle 生命周期内有效） */
let layerIdCache: string | null = null;
const dayDocCache = new Map<string, string>();
/** B3：日记月文档缓存（月 → 月文档 id；层与每日文档共用「日记」层缓存） */
const monthDocCache = new Map<string, string>();

/** 测试专用：清建链缓存（生产勿调） */
export function __resetSchedboardCaches(): void {
    layerIdCache = null;
    dayDocCache.clear();
    monthDocCache.clear();
}

/** 建链缓存的存活探针：树真相通道（getChildBlocks=LoadTreeByBlockID 文件系统读，删=code!=0
 *  throw）。勿用 getBlockAttrs 验活——已删块走属性缓存恒吐旧值非 null（tb2 e2e 实锤：删日记后
 *  缓存验活假阳→getChildBlocks 写歪 block not found）。 */
async function blockAlive(id: string): Promise<boolean> {
    try {
        await getChildBlocks(id);
        return true;
    } catch {
        return false;
    }
}

/** 目录定位双通道（folder-model：目录=插件全部数据根）：主通道=IAL 标记
 *  custom-mainline-home（用户改名不丢）；兜底=hpath/名字（命中补打标，下轮走主通道）。
 *  兜底候选带 custom-project-status（用户项目撞名）→不误认按 null 处理（调用方报错教育）。 */
export async function locateRoot(): Promise<{ id: string; box: string; hpath?: string } | null> {
    const marked = await sql<{ id: string; box: string; hpath?: string }>(
        `SELECT a.block_id AS id, b.box, b.hpath FROM attributes a JOIN blocks b ON b.id=a.block_id
         WHERE a.name='${HOME_MARK_ATTR}' AND a.value='1' LIMIT 2`);
    // 旧宿主防线：标记挂在两代 LEGACY 容器上=迁移前遗留态（home-split 期标记或迁移⓪清标的
    // attributes 索引窗旧值——写后立读竞态）→不当目录，走兜底/懒建。迁移⓪会清掉旧标治本。
    const LEGACY_HOSTS = [LEGACY_MAINLINE_HPATH, LEGACY_SPLIT_HPATH];
    const markedHit = (marked ?? []).find((r) => r?.id && r.box && !LEGACY_HOSTS.includes(r.hpath ?? ""));
    if (markedHit) return { id: markedHit.id, box: markedHit.box, hpath: markedHit.hpath };
    const rows = await sql<{ id: string; box: string }>(
        `SELECT id, box FROM blocks WHERE type='d' AND hpath='${ROOT_HPATH}' LIMIT 2`);
    let hit: { id: string; box: string; hpath?: string } | null = rows?.[0]?.id && rows[0].box ? rows[0] : null;
    if (!hit) {
        try {
            const nbs = (await lsNotebooks())?.notebooks ?? [];
            for (const nb of nbs) {
                if (!nb?.id || nb.closed) continue;
                const tops = await listDocsByPath(nb.id, "/");
                const f = (tops?.files ?? []).find((x: any) => x?.name === ROOT_NAME);
                if (f?.id) { hit = { id: f.id, box: nb.id, hpath: `/${f.name}` }; break; }
            }
        } catch { /* 兜底链失败=按找不到处理 */ }
    }
    if (hit) {
        // 撞名防御：候选是注册项目（用户自己建的「Project」项目）→不征用
        const st = await sql(`SELECT value AS v FROM attributes WHERE block_id='${hit.id}' AND name='custom-project-status'`);
        if (!st?.[0]?.v) {
            await setBlockAttrs(hit.id, { [HOME_MARK_ATTR]: "1" }); // 补打标（幂等）：下轮走主通道
            return hit;
        }
    }
    return null;
}

/** 目录懒建：定位空→preferredBox（迁移=旧容器同笔记本）/首个开启笔记本建+打标。
 *  新用户只建「我的工作」项目也能用日志/班表（旧「容器不存在→报错跳过」死路消失）。 */
export async function ensureRoot(preferredBox?: string): Promise<{ id: string; box: string; hpath?: string } | { error: string }> {
    const found = await locateRoot();
    if (found) return found;
    let box = preferredBox ?? "";
    if (!box) {
        try {
            const nbs = (await lsNotebooks())?.notebooks?.filter((n: any) => n?.id && !n.closed) ?? [];
            box = nbs[0]?.id ?? "";
        } catch { box = ""; }
    }
    if (!box) return { error: "无开启的笔记本，无法建立 Project 目录" };
    const id = await createDocWithMd(box, ROOT_HPATH, "");
    await setBlockAttrs(id, { [HOME_MARK_ATTR]: "1" });
    return { id, box, hpath: ROOT_HPATH };
}

/** 幂等懒建日记文档：SQL 查 hpath（跨写入间隔远超索引窗）+ 内存缓存（同轮连写防重复建）。
 *  缓存命中须树探针验活——用户删日记/日记层后缓存指向已删 id，写必歪。
 *  mainline-home-split：容器缺失不再报错跳过——ensureRoot 懒建目录后继续（新用户即开即用）。 */
export async function ensureDayDiary(day: string): Promise<{ ok: true; docId: string } | { ok: false; error: string }> {
    const cached = dayDocCache.get(day);
    if (cached && (await blockAlive(cached))) return { ok: true, docId: cached };
    if (cached) dayDocCache.delete(day);
    const home = await ensureRoot();
    if ("error" in home) return { ok: false, error: `${home.error}——日记块写入跳过（本地班表不受影响）` };
    // 日志层实时 hpath（目录改名容忍——home.hpath 缺省回落常量：目录未改名时常量即真值）
    const diaryBase = `${home.hpath ?? ROOT_HPATH}/${DIARY_NAME}`;
    // 「日志」中间层（缓存同须树探针验活——层被删后 parentID 挂空）
    let layerId = layerIdCache;
    if (layerId && !(await blockAlive(layerId))) layerId = null;
    if (!layerId) {
        const layerRows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${diaryBase}' AND box='${home.box}' LIMIT 1`);
        layerId = layerRows?.[0]?.id ?? null;
        if (!layerId) {
            layerId = await createDocWithMd(home.box, diaryBase, "", home.id);
        }
        layerIdCache = layerId;
    }
    // 当日日志文档（SQL 命中亦须树探针复核——删除后索引窗内 SQL 可吐幽灵行）
    const docRows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${diaryBase}/${day}' AND box='${home.box}' LIMIT 1`);
    let docId = docRows?.[0]?.id ?? null;
    if (docId && !(await blockAlive(docId))) docId = null;
    if (!docId) docId = await createDocWithMd(home.box, `${diaryBase}/${day}`, "", layerId);
    dayDocCache.set(day, docId);
    return { ok: true, docId };
}

/** 块文本归一：trim+剔零宽空格（内核空块 content=\u200b——trim 剔不掉；期 2 ⑤ 空 summary
 *  草稿条目的比对/读面统一走此函数，防 churn 与零宽空格外漏） */
function stripZeroWidth(s: string | null | undefined): string {
    return (s ?? "").replace(/\u200b/g, "").trim();
}

/** 容器子块枚举+时刻读（□2 文本优先：行文本时刻头赢、属性兜底）；content=块当前文本
 *  （updated 保真比对用）；flashRaw=custom-sched-flash 原文（期 3 P0-1 单调守卫：保护线由
 *  微调 rpc 尾部单向推进在块上，petal 行恒旧值——update 不得把旧线回灌覆盖块上已推进的线） */
async function listBoardItems(boardId: string): Promise<Array<{ id: string; start: string | null; content: string | null; flashRaw: string | null }>> {
    const lis = await getChildBlocks(boardId);
    const out: Array<{ id: string; start: string | null; content: string | null; flashRaw: string | null }> = [];
    for (const li of lis) {
        const attrs = await getBlockAttrs(li.id);
        const start = parseSchedItemText(li.content)?.start ?? attrsToSchedStart(attrs);
        out.push({ id: li.id, start, content: li.content ?? null, flashRaw: attrs?.["custom-sched-flash"] ?? null });
    }
    return out;
}

/** 顶层找班表容器（IAL 直读判 custom-role；顺带找既有「## 班表」标题块做查重） */
async function findBoard(docId: string): Promise<{ boardId: string | null; hasTitle: boolean }> {
    const tops = await getChildBlocks(docId);
    let boardId: string | null = null;
    let hasTitle = false;
    for (const b of tops) {
        if (isSchedBoardAttrs(await getBlockAttrs(b.id))) boardId = b.id;
        if (b.type === "h" && (b.content ?? "").trim() === "班表") hasTitle = true;
    }
    return { boardId, hasTitle };
}

/** 首建容器（首条插入建壳+挂 role）；标题缺失才补（nextID=容器，标题恒在容器前） */
async function ensureBoard(docId: string, tops: Array<{ id: string }>, hasTitle: boolean, first: SchedItem): Promise<{ boardId: string; existing: Array<{ id: string; start: string | null; content: string | null; flashRaw: string | null }> }> {
    const head = tops.length ? { nextID: tops[0].id } : {};
    const r = await insertListItem(docId, `- ${schedItemText(first)}`, head);
    await setBlockAttrs(r.containerId, { "custom-role": SCHED_BOARD_ROLE_VALUE });
    await setBlockAttrs(r.liId, schedItemToAttrs(first));
    if (!hasTitle) await insertBlockMarkdown(docId, BOARD_TITLE, r.containerId);
    return { boardId: r.containerId, existing: [{ id: r.liId, start: first.start, content: schedItemText(first), flashRaw: null }] }; // 新插块无既有 flash 线
}

/** 写班表进日记（diff 重放；key=块 id——target 的 key 即容器内 li id）。
 *  P1-4 串行队列：kernel 写者（rpc/晨滚/schedule_set/adopt）并发交错=后到的 stale 重放会把
 *  先到者刚插的块当消失项删掉（自愈全是事件驱动无对账循环）——模块级单飞链严格串行，重叠写
 *  排队执行。（期 4 起 sched: 账本键随迁链删除——sched: 前缀无新来源，adopt:/remind: 键
 *  生而用块 id 无 remap 需求。） */
let boardWriteChain: Promise<unknown> = Promise.resolve();
export function writeSchedBoardToDiary(day: string, items: SchedItem[]): Promise<BoardWriteResult> {
    const run = boardWriteChain.then(() => writeSchedBoardToDiaryInner(day, items), () => writeSchedBoardToDiaryInner(day, items));
    boardWriteChain = run.then(() => undefined, () => undefined);
    return run;
}

async function writeSchedBoardToDiaryInner(day: string, items: SchedItem[]): Promise<BoardWriteResult> {
    const keyRemap = new Map<string, string>();
    const diary = await ensureDayDiary(day);
    if ("error" in diary) return { ok: false, keyRemap, error: diary.error }; // strict:false 判别用 in（!ok 不收窄）
    const docId = diary.docId;
    const sorted = [...items].sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99"));
    const tops = await getChildBlocks(docId);
    const { boardId, hasTitle } = await findBoard(docId);

    let existing: Array<{ id: string; start: string | null; content: string | null; flashRaw: string | null }>;
    let board = boardId;
    if (!board) {
        if (!sorted.length) return { ok: true, docId, updated: 0, inserted: 0, deleted: 0, keyRemap };
        const built = await ensureBoard(docId, tops, hasTitle, sorted[0]);
        board = built.boardId;
        existing = built.existing;
        keyRemap.set(sorted[0].key, existing[0].id);
        sorted.shift();
    } else {
        existing = await listBoardItems(board);
        // 容器已空（条目全被清）：删壳走首建（空容器插 li 不并壳——探针 c1 同族结构约束）。
        // tops 剔除刚删的容器自身（陈旧 tops 的 nextID 指向已删块 → throw，review P2-1）
        if (!existing.length) {
            if (!sorted.length) return { ok: true, docId, updated: 0, inserted: 0, deleted: 0, keyRemap };
            await deleteBlock(board);
            const built = await ensureBoard(docId, tops.filter((t) => t.id !== board), hasTitle, sorted[0]);
            board = built.boardId;
            existing = built.existing;
            keyRemap.set(sorted[0].key, existing[0].id);
            sorted.shift();
        }
    }

    // —— diff 重放：删（块 id 不在终态且非本轮已插）→ 改（key 命中既有块 id）→ 增（中序锚插） ——
    // keepIds 基准=target 的块 id 全集（targetKeys ∪ 本轮已 remap 的新块 id——首建/早插的条目不在
    // sorted 里，只进 keyRemap，漏算即误删）
    const targetKeys = new Set(sorted.map((i) => i.key));
    const keepIds = new Set<string>([...targetKeys, ...keyRemap.values()]);
    const byId = new Map(existing.map((e) => [e.id, e]));
    let deleted = 0;
    let updated = 0;
    let inserted = 0;
    const live: Array<{ id: string; start: string | null }> = [];
    for (const e of existing) {
        if (keepIds.has(e.id)) live.push(e);
        else {
            await deleteBlock(e.id);
            deleted++;
        }
    }
    for (const it of sorted) {
        const attrs = schedItemToAttrs(it);
        const row = byId.get(it.key);
        if (row) {
            // 改：文本变了才 updateBlock（updateBlock 重写内容不迁移 custom-*——坑在案，纯内容+setBlockAttrs
            // 两步；块 id 不变=key 稳定）。文本未变（□2 后=时刻+摘要都未变）只重挂属性——块 updated
            // 保真，期 2 对账证据=内容事务维护的 updated，SetBlockAttrs 不触碰（语义正合）。
            // content 比对须 trim：内核 ChildBlock.content 对 li 带列表标记位前导空格（" 写作"，6808 探针实测）；
            // 空 li 的 content=零宽空格 \u200b（trim 剔不掉）——须一并归一，否则空草稿条目每轮 diff churn。
            const target = schedItemText(it);
            const current = stripZeroWidth(row.content);
            // 护栏（review P0-2 扩展）：终态摘要空（托盘草稿/纯时刻行）而块有字=用户正在草稿里写
            // （petal summary 未回流）——不抹块文本；空摘要条目一律不写行文本（时刻真相留属性——
            // 裸「09:30」行零信息量还扰动草稿；读面文本缺位自然走属性兜底）。
            // （petal-真值写者 writeback/周报/schedule_set 触达该日时走此分支）
            const summaryOnly = it.summary.replace(/\s+/g, " ").trim();
            if (current !== target && summaryOnly !== "") {
                await updateBlockMarkdown(it.key, `- ${target}`);
            }
            // 期 3 P0-1 单调守卫：波次保护线（flash.due）由微调 rpc 尾部单向推进在**块**上，petal
            // 行恒旧值（override/merge 链不回流它）——入参 meta.due 旧于块现值时保留块现值，
            // 否则一次拖动后的任何 schedule_set/再拖动都会把线回灌回旧值→下次拖动全卡误判已处理跳过。
            const inDue = it.flash?.due ?? "";
            const rowMeta = parseFlashAttr(row.flashRaw);
            if (inDue && rowMeta?.due && inDue < rowMeta.due) {
                attrs["custom-sched-flash"] = row.flashRaw ?? "";
            }
            await setBlockAttrs(it.key, attrs);
            updated++;
        } else {
            // 增：中序锚（previousID=最后一个 start≤新 start 的存活块；早于全部/无存活→nextID=首块）
            const anchorId = insertAnchorAfter(it.start, live);
            const r = anchorId
                ? await insertListItem(docId, `- ${schedItemText(it)}`, { previousID: anchorId })
                : await insertListItem(docId, `- ${schedItemText(it)}`, live.length ? { nextID: live[0].id } : {});
            await setBlockAttrs(r.liId, attrs);
            keyRemap.set(it.key, r.liId);
            const idx = anchorId ? live.findIndex((e) => e.id === anchorId) + 1 : 0;
            live.splice(idx, 0, { id: r.liId, start: it.start });
            inserted++;
        }
    }
    return { ok: true, docId, updated, inserted, deleted, keyRemap };
}

// ── 期 2 ① 统一写链：日终态编排 + sched-board-sync rpc 面 ──

/** 统一写链编排（routineTools/晨滚/adopt 共用）：日终态（items 全量，含他日键）→
 *  当日 target diff 重放。块链路失败=items 原引用返回（双写互不阻塞语义保留——调用方
 *  各自兜底）。 */
export async function syncDayBoardToDiary(day: string, items: Record<string, SchedItem>): Promise<{ items: Record<string, SchedItem>; board: BoardWriteResult }> {
    const dayTarget = Object.values(items)
        .filter((i) => i.date === day)
        .sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99"));
    const board = await writeSchedBoardToDiary(day, dayTarget);
    return { items: board.ok && board.keyRemap.size ? remapSchedItems(items, board.keyRemap) : items, board };
}

export interface BoardSyncRpcResult {
    ok: boolean;
    docId?: string;
    updated?: number;
    inserted?: number;
    deleted?: number;
    /** 旧 key→块 id 二元组数组（rpc JSON 通道可序列化；前端 new Map(r.keyRemap) 重建） */
    keyRemap: Array<[string, string]>;
    /** 期 3 微调联动：波次条目 due 重规整结果（信息性——「闪卡·第1波 20张→10:30（20张）」） */
    flashMoves?: string[];
    error?: string;
}

/** sched-board-sync rpc 面（前端 schedEdit 的块写委托）：入参归一（脏数据防线）→当日过滤→
 *  diff 重放→波次微调联动→可序列化结果。任何失败=ok:false 带原因（前端 petal 照写不断供，
 *  debugLog 留痕）。
 *  ⚠空集=合法终态（UI 删掉当日最后一条——review P0-1）：放行给 writeSchedBoardToDiary 清块，
 *  勿在此拦截，否则日记块带 remind-at 永生、到点照样弹提醒。 */
export async function schedBoardSyncRpc(params: any): Promise<BoardSyncRpcResult> {
    const day = typeof params?.day === "string" ? params.day : "";
    if (!isValidDay(day)) return { ok: false, keyRemap: [], error: "day 须为合法 YYYY-MM-DD" };
    const items = normalizeBoardItems(params?.items).filter((i) => i.date === day);
    try {
        const board = await writeSchedBoardToDiary(day, items);
        if (!board.ok) return { ok: false, keyRemap: [], error: board.error };
        // 期 3 微调联动（拍板「微调双通道」）：波次条目 start 变化→清单重规整 due 到新时刻。
        // 保护线=meta.due（旧规整时刻）：due 已被推过它的卡=已刷卡/被番茄推迟——跳过不覆盖
        // FSRS 调度（用户先斩后奏的处理优先）。幂等（同 start=同值重写）；due 失败不 fail
        // 整个 rpc（块写已成功，信息性回参留给 debugLog/前端留痕）。
        const flashMoves: string[] = [];
        for (const it of items) {
            if (!it.flash?.blocks?.length || !it.start) continue;
            const due14 = flashDueTimestamp(day, it.start);
            if (!due14) continue;
            // 保护线取块现值与入参的 max（P0-1：入参 flash 恒来自 petal 旧值——块上才是被
            // rpc 尾部推进过的真线；取 max 免受陈旧入参拖低保护线）
            let protect: { due?: string; at?: string } = { due: it.flash.due, at: it.flash.at };
            try {
                const blockMeta = parseFlashAttr((await getBlockAttrs(it.key))?.["custom-sched-flash"]);
                if (blockMeta) {
                    protect = {
                        due: [protect.due, blockMeta.due].filter(Boolean).sort().pop(),
                        at: [protect.at, blockMeta.at].filter(Boolean).sort().pop(),
                    };
                }
            } catch {
                // 块属性读失败=用入参线（偏保守面宽，不炸主链）
            }
            const r = await applyFlashDue(it.flash.blocks, due14, protect);
            if (r.ok) {
                flashMoves.push(`${it.summary}→${it.start}（${r.cards}张${r.skippedPostponed ? `，番茄推迟跳过${r.skippedPostponed}块` : ""}）`);
                try {
                    await setBlockAttrs(it.key, { "custom-sched-flash": buildFlashAttr({ ...it.flash, due: due14 }) });
                } catch {
                    // 保护线更新失败=下次仍用旧线（宽一档不炸主链）
                }
            } else {
                flashMoves.push(`${it.summary} due 规整失败：${r.error}`);
            }
        }
        return {
            ok: true,
            docId: board.docId,
            updated: board.updated,
            inserted: board.inserted,
            deleted: board.deleted,
            keyRemap: [...board.keyRemap.entries()],
            ...(flashMoves.length ? { flashMoves } : {}),
        };
    } catch (e: any) {
        return { ok: false, keyRemap: [], error: String(e?.message ?? e) };
    }
}

// ── 期 2 ② 读面切块：只读日班表 rpc（sched-board-read） ──

/** 日班表只读条目（key=块 id；视图消费面形态——created/updated 等机器态不带） */
export interface BoardReadItem {
    key: string;
    summary: string;
    start: string | null;
    end: string | null;
    hard: boolean;
    origin: SchedItem["origin"];
    /** 期 2 ③ 全映射 adopt：全天事件托盘行标记 */
    allDay?: boolean;
    /** 期 3 闪卡波次（块真身透传：前端 merge 链带回 rpc=微调联动的清单来源） */
    flash?: FlashWaveMeta;
}

export interface BoardReadResult {
    ok: boolean;
    /** 日记文档 id（找到班表时在） */
    docId?: string;
    /** 班表容器块 id */
    boardId?: string;
    items: BoardReadItem[];
    /** 未认行原文（形似时刻头但文本/属性双通道都不认——□8 体检素材；缺省=零未认） */
    unrecognized?: string[];
    error?: string;
}

/** 只读定位当日日记文档（ensureDayDiary 的读版）：SQL hpath+树探针复核，绝不建档——
 *  读通道零副作用（用户翻旧日/未排班日≠写意图）。命中进 dayDocCache 供后续写复用。 */
export async function locateDayDoc(day: string): Promise<string | null> {
    const cached = dayDocCache.get(day);
    if (cached && (await blockAlive(cached))) return cached;
    if (cached) dayDocCache.delete(day);
    const home = await locateRoot();
    if (!home) return null;
    const diaryBase = `${home.hpath ?? ROOT_HPATH}/${DIARY_NAME}`;
    const rows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${diaryBase}/${day}' AND box='${home.box}' LIMIT 1`);
    let docId = rows?.[0]?.id ?? null;
    if (docId && !(await blockAlive(docId))) docId = null; // 删除后索引窗内 SQL 幽灵行复核
    if (docId) dayDocCache.set(day, docId);
    return docId;
}

// ── B3 日账月账化：日记月文档定位（ensureDayConfigDoc/locateDayConfigDoc 同款三层链惯例——
// 每日配置月文档先例；月文档=/Project/日志/YYYY-MM 一篇，月内分日组容器在 ammoLedger 侧）。
// 班表写链（writeSchedBoardToDiary/ensureDayDiary）不迁——B3 范围=日账域。 ──

/** 幂等懒建日记月文档（日账 B3 起的写落点）：day 取月（YYYY-MM-DD → YYYY-MM），
 *  层复用「日记」层（layerIdCache 同层共享）；缓存命中须树探针验活（ensureDayDiary 同款纪律）。 */
export async function ensureMonthDiaryDoc(day: string): Promise<{ ok: true; docId: string } | { ok: false; error: string }> {
    const month = day.slice(0, 7);
    const cached = monthDocCache.get(month);
    if (cached && (await blockAlive(cached))) return { ok: true, docId: cached };
    if (cached) monthDocCache.delete(month);
    const home = await ensureRoot();
    if ("error" in home) return { ok: false, error: `${home.error}——日记月文档写入跳过` };
    const diaryBase = `${home.hpath ?? ROOT_HPATH}/${DIARY_NAME}`;
    let layerId = layerIdCache;
    if (layerId && !(await blockAlive(layerId))) layerId = null;
    if (!layerId) {
        const layerRows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${diaryBase}' AND box='${home.box}' LIMIT 1`);
        layerId = layerRows?.[0]?.id ?? null;
        if (!layerId) {
            layerId = await createDocWithMd(home.box, diaryBase, "", home.id);
        }
        layerIdCache = layerId;
    }
    const monthHpath = `${diaryBase}/${month}`;
    const docRows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${monthHpath}' AND box='${home.box}' LIMIT 1`);
    let docId = docRows?.[0]?.id ?? null;
    if (docId && !(await blockAlive(docId))) docId = null;
    if (!docId) docId = await createDocWithMd(home.box, monthHpath, "", layerId);
    monthDocCache.set(month, docId);
    return { ok: true, docId };
}

/** 只读定位日记月文档（ensureMonthDiaryDoc 的读版——零建档，读通道零副作用；
 *  日账兼容读的月形态探测半边，月文档不在≠无账——老每日文档兜底在 ammoLedger 侧）。 */
export async function locateMonthDiaryDoc(day: string): Promise<string | null> {
    const month = day.slice(0, 7);
    const cached = monthDocCache.get(month);
    if (cached && (await blockAlive(cached))) return cached;
    if (cached) monthDocCache.delete(month);
    const home = await locateRoot();
    if (!home) return null;
    const rows = await sql(`SELECT id FROM blocks WHERE type='d' AND hpath='${(home.hpath ?? ROOT_HPATH)}/${DIARY_NAME}/${month}' AND box='${home.box}' LIMIT 1`);
    let docId = rows?.[0]?.id ?? null;
    if (docId && !(await blockAlive(docId))) docId = null;
    if (docId) monthDocCache.set(month, docId);
    return docId;
}

/** 班表容器行批读（dataview □8：体检的 IO 收集半边——行块 id+文本+属性随行；判官在
 *  core/ammoHealth。零建档零副作用，schedBoardReadRpc 同一容器定位通道）。 */
export interface BoardLinesResult {
    ok: boolean;
    /** 日记文档 id（找到班表时在） */
    docId?: string;
    /** 班表容器块 id */
    boardId?: string;
    /** 容器行（容器不在=null——无班表=空日，不算异常） */
    lines?: HealthLineInput[] | null;
    error?: string;
}

export async function readBoardLines(day: string): Promise<BoardLinesResult> {
    if (!isValidDay(day)) return { ok: false, lines: null, error: "day 须为合法 YYYY-MM-DD" };
    try {
        const docId = await locateDayDoc(day);
        if (!docId) return { ok: true, lines: null };
        const { boardId } = await findBoard(docId);
        if (!boardId) return { ok: true, docId, lines: null };
        const lines: HealthLineInput[] = [];
        for (const li of await getChildBlocks(boardId)) {
            lines.push({ id: li.id, content: li.content, attrs: await getBlockAttrs(li.id) });
        }
        return { ok: true, docId, boardId, lines };
    } catch (e: any) {
        return { ok: false, lines: null, error: String(e?.message ?? e) };
    }
}

/** sched-board-read rpc 面：当日班表块全量（getChildBlocks 真序——写后立读安全通道，
 *  日历页签日面板的数据源）。□2 时刻读=行文本优先（`09:30 摘要` 头）、custom-remind-at/end
 *  属性兜底（老条目零迁移；手编行无属性也认）。日窗闸同 boardRowsToSchedItems（P2-3：旧日块
 *  不复活已剪条目，adopt 豁免）。任何失败=ok:false 带原因（前端空态降级，debugLog 留痕）。 */
export async function schedBoardReadRpc(params: any, now: Date = new Date()): Promise<BoardReadResult> {
    const day = typeof params?.day === "string" ? params.day : "";
    const walk = await readBoardLines(day);
    if (!walk.ok) return { ok: false, items: [], error: walk.error };
    if (!walk.lines) return { ok: true, ...(walk.docId ? { docId: walk.docId } : {}), items: [] };
    const today = getLogicalDay(now);
    const items: BoardReadItem[] = [];
    for (const li of walk.lines) {
        const attrs = li.attrs ?? {};
        const at = attrs["custom-remind-at"] ?? "";
        const originRaw = attrs["custom-sched-origin"] ?? "";
        const origin = originRaw === "ai" || originRaw === "roll" || originRaw === "report" || originRaw === "adopt" ? originRaw : "user";
        // 日窗闸（条目日期=remind-at 前半权威，无=日记日兜底）
        const date = /^\d{4}-\d{2}-\d{2}$/.test(at.slice(0, 10)) ? at.slice(0, 10) : day;
        if (!boardItemInWindow(date, origin, today)) continue;
        // 时刻读：行文本优先（□2 文本即真相——summary 同步剥时刻头），属性兜底（老条目）
        const parsed = parseSchedItemText(li.content);
        const start = parsed ? parsed.start : attrsToSchedStart(attrs);
        let end: string | null = null;
        if (parsed && parsed.end) end = parsed.end;
        else end = attrsToSchedEnd(attrs);
        items.push({
            key: li.id,
            // 空 summary=草稿真值（视图层兜底「（空条目）」）——读通道零哨兵：本读面喂
            // schedEditInner/autoAdoptSweep 的 merge 写面，哨兵回流会把草稿块写成字面文本
            summary: parsed ? parsed.summary : stripZeroWidth(li.content),
            start,
            end: start && end && end > start ? end : null,
            hard: attrs["custom-sched-hard"] === "1",
            origin,
            ...(attrs["custom-sched-allday"] === "1" ? { allDay: true } : {}),
            ...(parseFlashAttr(attrs["custom-sched-flash"]) ? { flash: parseFlashAttr(attrs["custom-sched-flash"])! } : {}),
        });
    }
    const unrecognized = collectUnrecognizedBoardLines(walk.lines);
    return {
        ok: true,
        ...(walk.docId ? { docId: walk.docId } : {}),
        boardId: walk.boardId,
        items,
        ...(unrecognized.length ? { unrecognized } : {}),
    };
}

export interface RemindEntryCreateResult {
    ok: boolean;
    blockId?: string;
    docId?: string;
    error?: string;
}

/** remind-entry-create rpc 面（tb2 H1，bear 拍板「先简单只支持段落块」）：日历轴右键创建=
 *  当天日记插一个挂 custom-remind-at 的**段落块**（无 custom-sched-origin、无 petal 行）——
 *  走 remind 链全家桶（事件同步/块面时间渲染/日轴 remind 源/拖动改时），绕开班表草稿闸+
 *  petal 回流缺口（H1 复现实锤：sched 路草稿打字后 petal summary 恒空=两链都不推永不同步）。
 *  落点=班表容器后（视觉在班表区内；多笔倒序堆叠可接受——日轴按时刻排序）；容器不在=
 *  文档**顶**（内核对文档根容器走 PrependChild——与 ensureBoard 班表置顶同约定，AI 后建
 *  班表仍插其前，终态序一致）；日记缺失由 ensureDayDiary 兜底建档（不建班表壳——首条 AI
 *  班表写入时再建）。
 *  空段落=草稿：remind 链草稿闸（remind.ts）不推空内容，写上内容下轮同步推——对齐 ⑤ 班表草稿语义 */
export async function createRemindEntryRpc(params: any): Promise<RemindEntryCreateResult> {
    const day = typeof params?.day === "string" ? params.day : "";
    const start = typeof params?.start === "string" ? params.start : "";
    if (!isValidDay(day)) return { ok: false, error: "day 须为合法 YYYY-MM-DD" };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) return { ok: false, error: "start 须为合法 HH:mm" };
    try {
        const diary = await ensureDayDiary(day);
        if ("error" in diary) return { ok: false, error: diary.error }; // strict:false 判别联合用 in（AGENTS 坑）
        const { boardId } = await findBoard(diary.docId);
        const blockId = await insertBlockMarkdown(diary.docId, "", undefined, boardId ?? undefined);
        await setBlockAttrs(blockId, { "custom-remind-at": `${day}T${start}` });
        return { ok: true, blockId, docId: diary.docId };
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}
