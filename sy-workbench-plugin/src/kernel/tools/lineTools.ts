import {
    createDocWithMd,
    getChildBlocks,
    insertBlockMarkdown,
    listDocsByPath,
    moveBlock,
    moveDocsByID,
    removeDocByID,
    sql,
} from "../api";
import { parentDocIdFromPath, parentHpath, planTaskSweep, topAncestorIds, type SweepBlockRow } from "../core/lineOps";
import { isDone } from "../core/progressCalc";
import { ARCHIVE_DOC_NAME, ATTR_PROJECT_STATUS } from "../core/schema";
import { buildTaskListSql, type TaskQueryRow } from "./taskTools";
import { errorResponse, successResponse, objectSchema, wrapHandler, type ToolDefinition } from "./common";

const LINE_ACTIONS = ["blocks", "split", "merge", "archive", "restore", "sweep_done"] as const;

/** 归档区子文档名（森林下的死线收容所）——单源在 core/schema（boardModel 前端面共用） */
export { ARCHIVE_DOC_NAME };

/** 单线未完任务盘点上限（红线①材料；超限场景=单线千任务，截断如实上报而非静默） */
const INVENTORY_LIMIT = 1000;

function assertBlockId(id: unknown, field: string): string {
    if (typeof id !== "string" || !/^20\d{12}-[0-9a-z]{7}$/.test(id)) {
        throw new Error(`字段 ${field} 必须是思源块 id（yyyymmddhhmmss-xxxxxxx）`);
    }
    return id;
}

interface DocRow {
    id: string;
    content: string;
    box: string;
    path: string;
    hpath: string;
    type: string;
}

async function requireDocRow(id: string): Promise<DocRow> {
    const rows = await sql<DocRow>(
        `SELECT id, content, box, path, hpath, type FROM blocks WHERE id='${id}'`,
    );
    const row = rows[0];
    if (!row) throw new Error(`文档不存在: ${id}`);
    if (row.type !== "d") throw new Error(`${id} 不是文档（type=${row.type}）`);
    return row;
}

async function requireProjectAttr(projectId: string): Promise<void> {
    const rows = await sql<{ block_id: string }>(
        `SELECT block_id FROM attributes WHERE block_id='${projectId}' AND name='${ATTR_PROJECT_STATUS}'`,
    );
    if (!rows[0]) throw new Error(`父文档 ${projectId} 不是项目主文档（无 ${ATTR_PROJECT_STATUS} 属性）`);
}

/** 找/建项目下的归档区文档，返回其 id。
 *  查找走 listDocsByPath（文件系统真相——SQL 索引 3~10s 窗口看不见刚建的归档区会重复建）；
 *  建后用 createDocWithMd 返回值直连不回读。
 *  ENOENT 容错（sweep_done 首开面）：零子文档的项目其物理目录不存在（目录=子文档容器，
 *  无子文档≠空目录而是目录未建——AGENTS 坑表在案）——目录不在=归档区必不在，直落建档。 */
async function ensureArchiveDoc(projectId: string): Promise<string> {
    const proj = await requireDocRow(projectId);
    const projDir = proj.path.replace(/\.sy$/, "");
    let listing: any = null;
    try {
        listing = await listDocsByPath(proj.box, projDir);
    } catch {
        listing = null; // 目录不存在（项目零子文档）——归档区必不在
    }
    const found = (listing?.files ?? []).find((f: any) => f.name === ARCHIVE_DOC_NAME);
    if (found?.id) return found.id;
    return createDocWithMd(
        proj.box,
        `${proj.hpath}/${ARCHIVE_DOC_NAME}`,
        // 初始内容带一行任务列表=收容 l 容器天然在（任务项 move 落点；文案行兼任空归档区提示）
        "已收档的线文档沉在这里（恢复用 line restore）；已收拢的任务块收在下方列表。\n- 已收档任务\n",
        projectId,
    );
}

/** 归档文档的任务收容 l 容器（找/建）。move 落点必须是 l 容器而非文档顶层——内核事务
 *  结构校验 NodeDocument cannot contain NodeListItem（move 挂文档=事务拒+ReloadUI 整页
 *  刷新，e2e 实锤）；新建归档文档初始内容已带列表（ensureArchiveDoc），此兜底只对存量
 *  无列表的老归档文档。 */
async function ensureArchiveListContainer(archiveDocId: string): Promise<string> {
    const tops = await getChildBlocks(archiveDocId);
    const found = tops.find((t) => t.type === "l");
    if (found) return found.id;
    await insertBlockMarkdown(archiveDocId, "- 已收档任务\n");
    const again = await getChildBlocks(archiveDocId); // blocktree 直读零等待（insert 响应后可即读）
    const l = again.find((t) => t.type === "l");
    if (!l) throw new Error("归档区收容列表建立失败（insert 后无 NodeList）");
    return l.id;
}

// ── done 任务收拢（03 收拢件：MCP sweep_done action 与 rpc 双通道共用编排） ──

export interface SweepDoneResult {
    ok: boolean;
    archiveDocId?: string;
    /** 实收任务块数 */
    swept?: number;
    /** 逐源文档收拢计数（盘点材料） */
    fromDocs?: Array<{ docId: string; count: number }>;
    /** done 但被拦（子树含未完——红线：未完不进归档，人工处置后重跑） */
    skipped?: Array<{ id: string; name: string }>;
    error?: string;
}

/** done 任务收拢编排：扫描项目子树（归档区子树排除——已收的不重复收）任务项+l 链桥 →
 *  按文档分组 planTaskSweep（收拢单元=顶层任务项，子树全 done 才收）→ moveBlock 逐个
 *  收进归档区（move 事务保块 id——打点指针/配置行 ((id)) 引用不断链）。 */
export async function sweepProjectDone(projectId: string): Promise<SweepDoneResult> {
    try {
        const proj = await requireDocRow(projectId);
        await requireProjectAttr(projectId);
        const archiveDocId = await ensureArchiveDoc(projectId);
        const archiveListId = await ensureArchiveListContainer(archiveDocId); // move 落点=l 容器（结构校验红线）
        const projDir = proj.path.replace(/\.sy$/, "");
        const archiveDir = `${projDir}/${archiveDocId}`; // 子文档物理目录=父文档 id（folder-model 形态）
        const rows = await sql<{ id: string; parent_id: string | null; type: string; subtype: string | null; markdown: string | null; root_id: string }>(`
            SELECT b.id, b.parent_id, b.type, b.subtype, b.markdown, b.root_id
            FROM blocks b
            WHERE b.type IN ('i','l')
              AND b.root_id IN (SELECT id FROM blocks WHERE type='d' AND (id='${projectId}' OR path LIKE '${projDir}/%'))
              AND b.root_id NOT IN (SELECT id FROM blocks WHERE type='d' AND (id='${archiveDocId}' OR path LIKE '${archiveDir}/%'))
        `);
        const byRoot = new Map<string, SweepBlockRow[]>();
        const nameOf = new Map<string, string>();
        for (const r of rows ?? []) {
            const arr = byRoot.get(r.root_id) ?? [];
            arr.push({ id: r.id, parent_id: r.parent_id, type: r.type, subType: r.subtype, markdown: r.markdown });
            byRoot.set(r.root_id, arr);
            nameOf.set(r.id, (r.markdown ?? "").replace(/^\s*[-*+]\s*\[[xX ]\]\s*/, "").trim() || r.id);
        }
        const fromDocs: Array<{ docId: string; count: number }> = [];
        const skipped: Array<{ id: string; name: string }> = [];
        let swept = 0;
        for (const [docId, docRows] of byRoot) {
            const plan = planTaskSweep(docRows); // parent_id 链只在文档内有效——逐文档 plan
            let n = 0;
            for (const id of plan.sweepable) {
                await moveBlock(id, archiveListId);
                n++;
            }
            if (n) fromDocs.push({ docId, count: n });
            swept += n;
            for (const s of plan.skipped) skipped.push({ id: s.id, name: nameOf.get(s.id) ?? s.id });
        }
        return { ok: true, archiveDocId, swept, fromDocs, skipped };
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}

export function createLineTool(): ToolDefinition {
    return {
        name: "line",
        config: objectSchema(
            "项目内子文档整理（子文档=项目文档下的嵌套文档；块 id 全程保留双链不断；工具不设项目域闸——任意文档可操作，AI 勿对项目外文档使用）。"
            + "子文档=项目目标的结构分解；新方向/大主题才开子文档，勿为日常琐事开。"
            + "Actions: blocks(docId 列文档顶层块——split 出方案前先读它), "
            + "split(fromDocId+newLineName+blockIds 把顶层块搬出成新子文档，建在源文档同级), "
            + "merge(fromDocId+intoDocId+confirm:true 把 B 顶层块并进 A 尾并删 B), "
            + "archive(lineDocId 收进项目内「归档」区；有未完任务须 openTaskPolicy=migrate(migrateTargetDocId，任务所在顶层块整体迁往)|abandon), "
            + "restore(lineDocId 从归档区拖回), "
            + "sweep_done(projectId 收拢项目内已完成任务块进「归档」区——顶层 done 任务且子树全 done 才收，块 id 保留引用不断；子树含未完的跳过并上报)。"
            + "注意：这里的归档区（项目内「归档」子文档）与项目级归档（project set_status）是两层，互不干扰。"
            + "归档=移出工作台，未完任务先处置是红线（不处置→error 附盘点材料）。",
            {
                action: { type: "string", enum: [...LINE_ACTIONS], description: "操作类型" },
                docId: { type: "string", description: "blocks: 要读顶层结构的文档 id" },
                fromDocId: { type: "string", description: "split/merge: 源线文档 id" },
                newLineName: { type: "string", description: "split: 新线名" },
                blockIds: { type: "array", items: { type: "string" }, description: "split: 要搬走的顶层块 id（按新线内顺序；先 line.blocks 读取；重复 id 自动去重）" },
                intoDocId: { type: "string", description: "merge: 接收方线文档 id（A）" },
                confirm: { type: "boolean", description: "merge: 必须显式 true（B 线将被删除）" },
                lineDocId: { type: "string", description: "archive/restore: 线文档 id" },
                openTaskPolicy: { type: "string", enum: ["migrate", "abandon"], description: "archive: 未完任务处置——migrate=任务所在顶层块整体搬去 migrateTargetDocId（连同块内其余内容），abandon=确认作废随线归档" },
                migrateTargetDocId: { type: "string", description: "archive+policy=migrate: 迁往的文档 id（不得是本线/本线子树/归档区）" },
                projectId: { type: "string", description: "sweep_done: 项目主文档 id" },
            },
            ["action"],
        ),
        handler: wrapHandler(async (input) => {
            const action = input?.action;
            if (!LINE_ACTIONS.includes(action)) return errorResponse(`未知 action: ${action}`);

            if (action === "blocks") {
                const docId = assertBlockId(input.docId, "docId");
                const doc = await requireDocRow(docId);
                const children = await getChildBlocks(doc.id);
                return successResponse({
                    docId: doc.id,
                    blocks: children.map((c) => ({
                        id: c.id,
                        type: c.type,
                        ...(c.subType ? { subType: c.subType } : {}),
                        content: (c.content ?? "").trim(),
                    })),
                });
            }

            if (action === "split") {
                const fromDocId = assertBlockId(input.fromDocId, "fromDocId");
                const name = typeof input.newLineName === "string" ? input.newLineName.trim() : "";
                if (!name) return errorResponse("newLineName 必填");
                if (name.includes("/")) return errorResponse("newLineName 不能含 /");
                if (!Array.isArray(input.blockIds) || input.blockIds.length === 0) {
                    return errorResponse("blockIds 必填（先 line.blocks 读顶层结构再挑）");
                }
                const blockIds = [...new Set(input.blockIds.map((b: unknown) => assertBlockId(b, "blockIds[]")))];
                const from = await requireDocRow(fromDocId);
                const tops = await getChildBlocks(from.id);
                const topIds = new Set(tops.map((t) => t.id));
                const alien = blockIds.filter((b) => !topIds.has(b));
                if (alien.length > 0) {
                    return errorResponse(
                        `这些块不是源文档的顶层块（可能是嵌套子块或他文档的块）: ${alien.join(", ")}——blockIds 只收顶层块，先 line.blocks 读结构`,
                    );
                }
                // 新线挂源线的父下（hpath 剥尾段）；parentID 精确定位防同名孪生歧义（review P2-2）；
                // 初始内容空——内容=搬来的块
                const parentDocId = parentDocIdFromPath(from.path) ?? undefined;
                const lineId = await createDocWithMd(
                    from.box,
                    `${parentHpath(from.hpath)}/${name}`,
                    "",
                    parentDocId,
                );
                for (const b of blockIds) {
                    await moveBlock(b, lineId);
                }
                // 全部顶层块搬走后源线只剩空段落壳——提示 AI 可后续 merge/archive 收掉（review P2-4）
                const sourceLeftEmpty = blockIds.length === tops.length;
                return successResponse({
                    lineId, name, movedCount: blockIds.length,
                    ...(sourceLeftEmpty ? { note: "源线顶层块已全部搬走，剩空壳文档——可 merge 进其他线或 archive 收掉" } : {}),
                });
            }

            if (action === "merge") {
                const fromDocId = assertBlockId(input.fromDocId, "fromDocId");
                const intoDocId = assertBlockId(input.intoDocId, "intoDocId");
                if (fromDocId === intoDocId) return errorResponse("fromDocId 与 intoDocId 不能相同");
                if (input.confirm !== true) {
                    return errorResponse("merge 会删除源线文档 B（内容已并入 A），需显式 confirm:true 二次确认");
                }
                const from = await requireDocRow(fromDocId);
                const into = await requireDocRow(intoDocId);
                // removeDocByID 连子树删：B 有子文档时拒绝（块搬走救不了子文档）。
                // 守卫走 listDocsByPath（文件系统真相）——SQL 索引有 3~10s 窗口，AI 连招
                // 「建子文档→秒后 merge」会绕过 SQL 版守卫连子树删（review P1-2）
                const fromDir = from.path.replace(/\.sy$/, "");
                const listing = await listDocsByPath(from.box, fromDir);
                if ((listing?.files?.length ?? 0) > 0) {
                    const names = listing.files.slice(0, 10).map((f: any) => f.name ?? f.id).join("、");
                    return errorResponse(
                        `源线还有 ${listing.files.length} 个子文档（removeDoc 会连子树删除，块级搬移救不了）：${names}——先逐个 archive/split/merge 处理`,
                    );
                }
                const tops = await getChildBlocks(from.id);
                for (const t of tops) {
                    await moveBlock(t.id, into.id);
                }
                await removeDocByID(from.id);
                return successResponse({ movedCount: tops.length, removedDocId: from.id, intoDocId: into.id });
            }

            if (action === "archive") {
                const lineDocId = assertBlockId(input.lineDocId, "lineDocId");
                const line = await requireDocRow(lineDocId);
                if (line.content === ARCHIVE_DOC_NAME) {
                    return errorResponse("归档区本身不能归档（它已就是归档区）");
                }
                const projectId = parentDocIdFromPath(line.path);
                if (!projectId) return errorResponse("该文档在笔记本根级，不在任何项目下（整项目归档请用 project set_status）");
                await requireProjectAttr(projectId);
                // 归档区先落位（迁移目标守卫要比对它；建后用返回值直连不 SQL 回读）
                const archiveDocId = await ensureArchiveDoc(projectId);
                const lineDir = line.path.replace(/\.sy$/, "");
                // 未完任务盘点（红线④：移出容器必给落脚点）；isDone 精筛（行首标记正则），
                // 上限 1000 + 截断如实上报——不用 SQL 预滤 [X]（正文含 [X] 的未完任务会漏报=反向绕过红线）
                const taskRows = await sql<TaskQueryRow>(buildTaskListSql(line.id, line.path, INVENTORY_LIMIT));
                const openTasks = taskRows.filter((t) => !isDone(t));
                const truncated = taskRows.length >= INVENTORY_LIMIT;
                if (openTasks.length > 0) {
                    const policy = input.openTaskPolicy;
                    if (policy === "migrate") {
                        if (typeof input.migrateTargetDocId !== "string") {
                            return errorResponse("policy=migrate 需 migrateTargetDocId（未完任务迁往的文档 id）");
                        }
                        const target = await requireDocRow(assertBlockId(input.migrateTargetDocId, "migrateTargetDocId"));
                        // 目标身份守卫（review P1-3）：目标=本线/本线子树/归档区都会让「迁移」
                        // 实际变成「随线归档」，红线①被静默绕过
                        if (target.id === line.id) {
                            return errorResponse("migrateTargetDocId 不能是本线自身（任务会原样随线归档）");
                        }
                        if (target.path.startsWith(lineDir + "/")) {
                            return errorResponse("migrateTargetDocId 在本线子树内（任务搬进去仍随线归档）——目标须是容器外文档");
                        }
                        if (target.id === archiveDocId) {
                            return errorResponse("migrateTargetDocId 不能是归档区（任务搬进去等于直接归档）——目标须是活跃线/日常线");
                        }
                        // 迁移单元=顶层祖先块（任务 p→item→list→文档）；子文档里的任务块级迁不动
                        const ownBlocks = await sql<{ id: string; parent_id: string }>(
                            `SELECT id, parent_id FROM blocks WHERE root_id='${line.id}'`,
                        );
                        const { ancestors, unresolvedTaskIds } = topAncestorIds(ownBlocks, openTasks.map((t) => t.id), line.id);
                        if (unresolvedTaskIds.length > 0) {
                            return errorResponse(
                                `${unresolvedTaskIds.length} 个未完任务在本线的子文档里（块级迁移够不到）——先处理子文档（逐个 archive/merge）再归档本线`,
                            );
                        }
                        for (const a of ancestors) {
                            await moveBlock(a, target.id);
                        }
                    } else if (policy !== "abandon") {
                        const listing = openTasks
                            .slice(0, 30)
                            .map((t) => `- ${t.content.trim()}${t.due_date ? `（due ${t.due_date}）` : ""} [${t.id}]`)
                            .join("\n");
                        return errorResponse(
                            `本线还有 ${openTasks.length} 个未完任务${truncated ? `（任务超 ${INVENTORY_LIMIT} 条上限，盘点可能不全）` : ""}，归档前须处置（红线：换线不丢活）。\n${listing}\n→ openTaskPolicy="migrate"+migrateTargetDocId（迁往新线/日常线）或 "abandon"（确认作废随线归档）`,
                        );
                    }
                }
                await moveDocsByID([line.id], archiveDocId);
                return successResponse({
                    archived: true,
                    lineId: line.id,
                    projectId,
                    archiveDocId,
                    openTasks: openTasks.length,
                    ...(truncated ? { inventoryTruncated: true } : {}),
                    policy: openTasks.length > 0 ? input.openTaskPolicy : undefined,
                });
            }

            if (action === "sweep_done") {
                const projectId = assertBlockId(input.projectId, "projectId");
                const r = await sweepProjectDone(projectId);
                if (!r.ok) return errorResponse(r.error ?? "sweep_done failed");
                return successResponse({
                    swept: r.swept ?? 0,
                    archiveDocId: r.archiveDocId,
                    fromDocs: r.fromDocs ?? [],
                    skippedCount: (r.skipped ?? []).length,
                    ...((r.skipped ?? []).length
                        ? { skipped: r.skipped!.slice(0, 20), note: "skipped=已完成但子树含未完任务（红线：未完不进归档）——处置子任务后重跑即可增量收" }
                        : {}),
                });
            }

            // restore
            const lineDocId = assertBlockId(input.lineDocId, "lineDocId");
            const line = await requireDocRow(lineDocId);
            const archiveId = parentDocIdFromPath(line.path);
            if (!archiveId) return errorResponse("该文档在笔记本根级，不在归档区");
            const archiveDoc = await requireDocRow(archiveId);
            if (archiveDoc.content !== ARCHIVE_DOC_NAME) {
                return errorResponse(`父文档「${archiveDoc.content}」不是归档区（${ARCHIVE_DOC_NAME}），只有归档线能 restore`);
            }
            const projectId = parentDocIdFromPath(archiveDoc.path);
            if (!projectId) return errorResponse("归档区在笔记本根级，找不到项目主文档（数据异常）");
            await requireProjectAttr(projectId);
            await moveDocsByID([line.id], projectId);
            return successResponse({ restored: true, lineId: line.id, projectId });
        }),
    };
}
