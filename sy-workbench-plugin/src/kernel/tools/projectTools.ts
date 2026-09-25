import { createDocWithMd, deleteBlock, getBlockAttrs, getBlockKramdown, insertBlockMarkdown, listDocsByPath, moveDocsByID, removeDocByID, setBlockAttrs, sql, storageGetJson, storagePutJson, storageRemove, updateBlockMarkdown } from "../api";
import { ACTIONS_HEADING, buildActionLine, extractActionsSection, parseActionsSection, stripIal } from "../core/actions";
import { getLogicalDay } from "../core/dates";
import { summarizeTasks, type TaskRow } from "../core/progressCalc";
import { ATTR_PROJECT_STATUS, PROJECT_STATUS } from "../core/schema";
import type { SceneSnapshot } from "../core/scene";
import { ACTIONS_UPDATED_CHANNEL, SCENE_CHANNEL, sceneKey } from "../../shared/channels";
import { HOME_MARK_ATTR, ROOT_HPATH, TRIPLET_NAMES } from "../../shared/homePaths";
import { locateRoot, ensureRoot } from "../schedboard";
import { buildTaskListSql, type TaskQueryRow } from "./taskTools";
import { errorResponse, successResponse, objectSchema, wrapHandler, type ToolDefinition } from "./common";

const PROJECT_ACTIONS = ["list", "create", "open", "get", "get_progress", "rebind", "set_status", "set_actions"] as const;

function assertBlockId(id: unknown, field: string): string {
    if (typeof id !== "string" || !/^20\d{12}-[0-9a-z]{7}$/.test(id)) {
        throw new Error(`字段 ${field} 必须是思源块 id（yyyymmddhhmmss-xxxxxxx）`);
    }
    return id;
}

/** SQL 行（GROUP_CONCAT 别名）→ TaskRow（attrs 形态） */
function sqlRowToTaskRow(r: TaskQueryRow): TaskRow {
    const attrs: Record<string, string> = {};
    if (r.due_date) attrs["custom-task-due-date"] = r.due_date;
    if (r.due_time) attrs["custom-task-due-time"] = r.due_time;
    if (r.start_date) attrs["custom-task-start-date"] = r.start_date;
    if (r.start_time) attrs["custom-task-start-time"] = r.start_time;
    if (r.tags) attrs["custom-task-tags"] = r.tags;
    return { id: r.id, content: r.content, markdown: r.markdown, updated: r.updated, root_id: r.root_id, attrs };
}

/** 子树路径查询先行步：查项目文档行（path 是子树 LIKE 前提）；type='d' 校验防段落 id 冒充项目 */
async function requireProjectPath(projectId: string): Promise<string> {
    const rows = await sql<{ id: string; path: string }>(
        `SELECT id, path FROM blocks WHERE id='${projectId}' AND type='d'`,
    );
    if (!rows[0]?.path) throw new Error(`项目不存在: ${projectId}`);
    return rows[0].path;
}

const STATS_LIMIT = 500;

/** 统计用子树任务行：走满 500 上限并回传 truncated 标记（>500 任务项目数字会偏小，标记让 AI 可察觉） */
async function subtreeTaskRows(projectId: string): Promise<{ rows: TaskQueryRow[]; truncated: boolean }> {
    const path = await requireProjectPath(projectId);
    const rows = await sql<TaskQueryRow>(buildTaskListSql(projectId, path, STATS_LIMIT));
    return { rows, truncated: rows.length >= STATS_LIMIT };
}

export function createProjectTool(): ToolDefinition {
    return {
        name: "project",
        config: objectSchema(
            "工作台·项目管理（项目=Project 目录下的一级文档=一个大目标；目录唯一，插件全部数据都在里面："
            + "三件套 /Project/日志（班表/日账/时间线）、/Project/每日配置、/Project/不想做；"
            + "归档=文档属性 custom-project-status=\"archived\"，无属性=活跃；"
            + "任务写在项目文档的任务列表里，项目内子文档随意嵌套（子文档里的任务也算这个项目的）；"
            + "「给 Agent 的话」/外部引用/「## 动作」=项目文档可见章节）。"
            + "Actions: list(列项目，status 过滤), create(name 建项目文档，自动落 /Project 下), "
            + "open(projectId 广播前端恢复现场), get(projectId 详情聚合，含动作清单), "
            + "get_progress(projectId 任务统计), "
            + "rebind(projectId+newMainDocId 真迁移换主文档——子文档全挂新主、属性挪、块 id 全保留进度不丢，完成后自动广播 open 切到新主), "
            + "set_status(active/archived), "
            + "set_actions(projectId+actions 整表替换「## 动作」段——动作=驾驶舱一键按钮，"
            + "命令白名单 code/open/mpv/play（play=思源内打开，视频可带 --start=HH:MM:SS 从哪开始看）。"
            + "⚠️破坏性写块：执行前必须把将写入的动作清单逐条念给用户确认)。"
            + "打开项目工作前先 get 读「给 Agent 的话」。"
            + "⚠️写后 SQL 索引有 3~10s 延迟：create 建项目后别立即 list/get 复核，先干别的再查。",
            {
                action: { type: "string", enum: [...PROJECT_ACTIONS], description: "操作类型" },
                projectId: { type: "string", description: "项目主文档 id（open/get/get_progress/rebind/set_status 用）" },
                newMainDocId: { type: "string", description: "rebind: 新主文档 id（须是文档块；不得与当前主文档同棵直系）" },
                name: { type: "string", description: "create: 项目名（=主文档名）" },
                agentNote: { type: "string", description: "create: 「给 Agent 的话」段初始内容" },
                status: { type: "string", description: "list: 过滤 active(默认)/archived/all；set_status: 目标值" },
                actions: {
                    type: "array",
                    description: "set_actions: 动作清单（整表替换段内动作行，注释行保留）",
                    items: {
                        type: "object",
                        properties: {
                            label: { type: "string", description: "按钮名（勿以（开头——那是注释行约定）" },
                            command: { type: "string", description: "命令全文，如 code /path、open /dir、mpv --start=00:12:34 /v.mp4、play <文档id|assets/路径>" },
                        },
                        required: ["label", "command"],
                    },
                },
            },
            ["action"],
        ),
        handler: wrapHandler(async (input) => {
            const action = input?.action;
            if (!PROJECT_ACTIONS.includes(action)) return errorResponse(`未知 action: ${action}`);

            if (action === "list") {
                const want = input.status === "archived" || input.status === "all" ? input.status : "active";
                const root = await locateRoot();
                if (!root) return successResponse({ projects: [] }); // 目录未建（kernel 未跑/新装首刻）
                const tops = await listDocsByPath(root.box, root.id);
                const files = (tops?.files ?? []).filter((f: any) => f?.id && !TRIPLET_NAMES.includes(f.name));
                const ids = files.map((f: any) => f.id as string);
                const statusById = new Map<string, { status: string; updated: string }>();
                if (ids.length) {
                    const metaRows = await sql<{ id: string; updated: string; status: string | null }>(
                        `SELECT b.id, b.updated, a.value AS status FROM blocks b
                        LEFT JOIN attributes a ON a.block_id=b.id AND a.name='${ATTR_PROJECT_STATUS}'
                        WHERE b.id IN ('${ids.join("','")}')`);
                    for (const m of metaRows ?? []) statusById.set(m.id, { status: m.status ?? "active", updated: m.updated ?? "" });
                }
                // 文件树真相=枚举源（无 SQL 脏行）；归档态=属性批查（无属性=活跃）
                const projects = files.map((f: any) => ({
                    id: f.id,
                    name: f.name,
                    status: statusById.get(f.id)?.status ?? "active",
                    box: root.box,
                    hpath: `${ROOT_HPATH}/${f.name}`,
                    updated: statusById.get(f.id)?.updated ?? "",
                })).sort((a: any, b: any) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
                return successResponse({ projects: want === "all" ? projects : projects.filter((p: any) => p.status === want) });
            }

            if (action === "create") {
                if (typeof input.name !== "string" || !input.name.trim()) return errorResponse("name 必填");
                if (input.name.includes("/")) return errorResponse("name 不能含 /（会按嵌套路径建文档）");
                const name = input.name.trim();
                if (TRIPLET_NAMES.includes(name)) return errorResponse(`name 不能是三件套保留名（${TRIPLET_NAMES.join("/")}）`);
                // notebook 参数已退役（folder-model：项目=目录一级文档，落点=ensureRoot）；兼容旧调用静默忽略
                const agentNote = typeof input.agentNote === "string" && input.agentNote.trim()
                    ? input.agentNote.trim()
                    : "（项目约定、注意事项、工作流说明写这里——Agent 进场先读）";
                if ((agentNote.match(/```/g) ?? []).length % 2 !== 0) {
                    return errorResponse("agentNote 含未闭合的 ``` 围栏（会吞掉骨架后段），请配平");
                }
                const md = `## 给 Agent 的话\n\n${agentNote}\n\n## 外部引用\n\n- （容器外相关文档的块引用放这里）\n\n## 任务\n\n- [ ] 第一个任务\n\n${ACTIONS_HEADING}\n\n- （格式：- 名称 | 命令，如：- 打开编辑器 | code /path/to/项目）\n`;
                const root = await ensureRoot();
                if (!root || "error" in root) return errorResponse((root as any)?.error ?? "目录不可用");
                // 落点=目录实时 hpath（目录改名容忍——home.hpath 缺省回落常量：未改名时常量即真值）
                const id = await createDocWithMd(root.box, `${root.hpath ?? ROOT_HPATH}/${name}`, md, root.id);
                return successResponse({ id, name, notebook: root.box, status: PROJECT_STATUS.ACTIVE });
            }

            if (action === "open") {
                const projectId = assertBlockId(input.projectId, "projectId");
                const scene = await storageGetJson<SceneSnapshot>(sceneKey(projectId));
                await siyuan.rpc.broadcast(SCENE_CHANNEL, { projectId, scene, fallbackDocId: projectId });
                return successResponse({ projectId, sceneFound: !!scene, broadcastSent: true });
            }

            if (action === "get") {
                const projectId = assertBlockId(input.projectId, "projectId");
                const docRows = await sql<{ id: string; content: string; box: string; hpath: string; path: string; markdown: string; updated: string }>(
                    `SELECT id, content, box, hpath, path, markdown, updated FROM blocks WHERE id='${projectId}' AND type='d'`,
                );
                const doc = docRows[0];
                if (!doc) return errorResponse(`项目不存在: ${projectId}`);
                const statusRows = await sql<{ value: string }>(
                    `SELECT value FROM attributes WHERE block_id='${projectId}' AND name='${ATTR_PROJECT_STATUS}'`,
                );
                const dirPrefix = doc.path.replace(/\.sy$/, "");
                const subDocs = await sql<{ id: string; content: string; updated: string }>(
                    `SELECT id, content, updated FROM blocks WHERE type='d' AND path LIKE '${dirPrefix}/%' AND id!='${projectId}' ORDER BY updated DESC`,
                );
                const taskRows = await sql<TaskQueryRow>(buildTaskListSql(projectId, doc.path, STATS_LIMIT));
                // blocks.markdown 列对文档行恒空（正文在子块）——全文走 kramdown 直读
                const kramdown = await getBlockKramdown(projectId);
                const sectionEntries = parseActionsSection(kramdown);
                return successResponse({
                    id: projectId,
                    name: doc.content,
                    box: doc.box,
                    hpath: doc.hpath,
                    status: statusRows[0]?.value ?? "none",
                    markdown: kramdown,
                    subDocs: subDocs.map((s) => ({ id: s.id, name: s.content, updated: s.updated })),
                    progress: summarizeTasks(taskRows.map(sqlRowToTaskRow), getLogicalDay(new Date())),
                    truncated: taskRows.length >= STATS_LIMIT,
                    updated: doc.updated,
                    actions: sectionEntries
                        .filter((e) => e.kind === "action")
                        .map((e) => ({ label: e.label, command: e.command })),
                    badActionLines: sectionEntries.filter((e) => e.kind === "bad").length,
                });
            }

            if (action === "get_progress") {
                const projectId = assertBlockId(input.projectId, "projectId");
                const { rows, truncated } = await subtreeTaskRows(projectId);
                return successResponse({
                    projectId,
                    progress: summarizeTasks(rows.map(sqlRowToTaskRow), getLogicalDay(new Date())),
                    truncated,
                });
            }

            if (action === "rebind") {
                const projectId = assertBlockId(input.projectId, "projectId");
                const newMainDocId = assertBlockId(input.newMainDocId, "newMainDocId");
                if (projectId === newMainDocId) return errorResponse("newMainDocId 与当前主文档相同");
                // 双方文档行+属性一次 IN 查询（拆两次查会撞索引窗：两次结果不一致时守卫误判）
                const rows = await sql<{
                    id: string; content: string; box: string; path: string; hpath: string; type: string; status: string | null;
                }>(
                    `SELECT b.id, b.content, b.box, b.path, b.hpath, b.type, a.value AS status
                    FROM blocks b LEFT JOIN attributes a ON a.block_id=b.id AND a.name='${ATTR_PROJECT_STATUS}'
                    WHERE b.id IN ('${projectId}','${newMainDocId}') AND b.type='d'`,
                );
                const oldDoc = rows.find((r) => r.id === projectId);
                const newDoc = rows.find((r) => r.id === newMainDocId);
                if (!oldDoc) return errorResponse(`项目主文档不存在: ${projectId}`);
                if (!newDoc) return errorResponse(`新主文档不存在: ${newMainDocId}（须是文档块）`);
                if (!oldDoc.status) return errorResponse(`${projectId} 不是项目主文档（无 ${ATTR_PROJECT_STATUS} 属性）`);
                if (newDoc.status) {
                    return errorResponse(`新主文档已是「${newDoc.content}」项目的主文档——一个文档只能当一个项目的主文档`);
                }
                // 屋檐防线（mainline-home-split）：屋檐是插件数据仓库非项目容器，不得被 rebind 成主文档
                const newAttrs = await getBlockAttrs(newMainDocId);
                if (newAttrs?.[HOME_MARK_ATTR]) return errorResponse("新主文档是主线目录（Project）本身，不能当项目主文档");
                // 环守卫：直系血亲禁（子孙当新主=线挂过去成环；祖先当新主=把祖先挂成子孙）
                const oldDir = oldDoc.path.replace(/\.sy$/, "");
                const newDir = newDoc.path.replace(/\.sy$/, "");
                if (newDoc.path.startsWith(oldDir + "/")) {
                    return errorResponse(`新主文档在当前项目子树内（${newDoc.content} 是主文档的直系后代）——先把那棵树移出项目再换绑`);
                }
                if (oldDoc.path.startsWith(newDir + "/")) {
                    return errorResponse(`新主文档是当前主文档的祖先（${newDoc.content}）——直系祖先不能当新主`);
                }
                // ①线迁移：直接子文档全量（含归档区）挂新主——走文件系统真相，SQL 索引窗内刚建的线不会漏
                const listing = await listDocsByPath(oldDoc.box, oldDir);
                const files = listing?.files ?? [];
                if (files.length > 0) {
                    await moveDocsByID(files.map((f: any) => f.id), newMainDocId);
                }
                // ②属性挪：旧清新挂；项目名=主文档标题，换绑后自动=新主标题（属性 value 只是状态）
                await setBlockAttrs(projectId, { [ATTR_PROJECT_STATUS]: "" });
                await setBlockAttrs(newMainDocId, { [ATTR_PROJECT_STATUS]: oldDoc.status });
                // ③快照迁移：键换新主 id；tabs 里指向旧主的行改指新主（blockId 清——旧主的块不在新主文档里）
                let snapshotMoved = false;
                let newSnap: SceneSnapshot | null = null;
                const snap = await storageGetJson<SceneSnapshot>(sceneKey(projectId));
                if (snap) {
                    newSnap = {
                        ...snap,
                        projectId: newMainDocId,
                        tabs: (snap.tabs ?? []).map((tab) =>
                            tab.docId === projectId ? { ...tab, docId: newMainDocId, blockId: undefined } : tab,
                        ),
                        activeDocId: snap.activeDocId === projectId ? newMainDocId : snap.activeDocId,
                    };
                    await storagePutJson(sceneKey(newMainDocId), newSnap);
                    await storageRemove(sceneKey(projectId));
                    snapshotMoved = true;
                }
                // ④前端接管：广播 open（切活跃项目+驾驶舱刷新+页签恢复，与 project.open 同一条路）
                await siyuan.rpc.broadcast(SCENE_CHANNEL, {
                    projectId: newMainDocId,
                    scene: newSnap,
                    fallbackDocId: newMainDocId,
                });
                return successResponse({
                    newProjectId: newMainDocId,
                    movedLineCount: files.length,
                    snapshotMoved,
                    previousMainDocId: projectId,
                });
            }

            if (action === "set_actions") {
                const projectId = assertBlockId(input.projectId, "projectId");
                // 净化+校验（竖线=行分隔符、换行拆块——剥成空格；（开头=注释行约定会被藏掉）
                if (!Array.isArray(input.actions) || input.actions.length === 0) {
                    return errorResponse("actions 必填（[{label, command}] 非空数组）");
                }
                const clean: Array<{ label: string; command: string }> = [];
                for (const a of input.actions) {
                    const label = typeof a?.label === "string" ? a.label.replace(/[|\r\n]/g, " ").trim() : "";
                    const command = typeof a?.command === "string" ? a.command.replace(/[\r\n]/g, " ").trim() : "";
                    if (!label) return errorResponse("每条动作的 label 必填（非空）");
                    if (label.startsWith("（")) return errorResponse(`label 不能以（开头（注释行约定，会被藏掉）: ${label}`);
                    if (!command) return errorResponse(`动作「${label}」的 command 必填`);
                    clean.push({ label, command });
                }
                const docRows = await sql<{ id: string }>(
                    `SELECT id FROM blocks WHERE id='${projectId}' AND type='d'`,
                );
                if (!docRows[0]) return errorResponse(`项目不存在: ${projectId}`);
                const markdown = await getBlockKramdown(projectId);
                if (!markdown) return errorResponse(`读取主文档内容失败: ${projectId}`);
                const lines = clean.map((a) => buildActionLine(a.label, a.command));

                // 无段：整段追加文档尾（parentID=主文档=容器尾语义）
                if (extractActionsSection(markdown) === null) {
                    await insertBlockMarkdown(projectId, `${ACTIONS_HEADING}\n\n${lines.join("\n")}`);
                    await siyuan.rpc.broadcast(ACTIONS_UPDATED_CHANNEL, { projectId, actions: clean });
                    return successResponse({ projectId, sectionCreated: true, written: clean.length, deleted: 0 });
                }

                // 有段：动作行按序替换，多余删，不足在段内最后条目块后追加；注释行原位保留
                const entries = parseActionsSection(markdown);
                const actionEntries = entries.filter((e) => e.kind === "action");
                const itemRows = await sql<{ id: string; markdown: string }>(
                    `SELECT id, markdown FROM blocks WHERE type='i' AND root_id='${projectId}'`,
                );
                const idByLine = new Map(itemRows.map((r) => [stripIal(r.markdown).trim(), r.id]));
                // 护栏：文档行与块表对不上（索引窗/漂移）即中止——宁可不写不可写错块
                const mustId = (rawLine: string): string => {
                    const id = idByLine.get(stripIal(rawLine).trim());
                    if (!id) throw new Error(`动作行在块表无匹配（索引窗或文档行漂移），中止写入: ${rawLine}`);
                    return id;
                };
                const n = Math.min(actionEntries.length, clean.length);
                for (let i = 0; i < n; i++) {
                    await updateBlockMarkdown(mustId(actionEntries[i].rawLine), lines[i]);
                }
                let deleted = 0;
                for (let i = n; i < actionEntries.length; i++) {
                    await deleteBlock(mustId(actionEntries[i].rawLine));
                    deleted++;
                }
                if (clean.length > n) {
                    // 锚点=段内最后一个能定位到块 id 的条目（含注释行）；全空退 heading 块
                    let anchorId: string | undefined;
                    for (let i = entries.length - 1; i >= 0 && !anchorId; i--) {
                        anchorId = idByLine.get(stripIal(entries[i].rawLine).trim());
                    }
                    if (!anchorId) {
                        const h = await sql<{ id: string }>(
                            `SELECT id FROM blocks WHERE root_id='${projectId}' AND type='h' AND content='动作' LIMIT 1`,
                        );
                        anchorId = h[0]?.id;
                    }
                    if (!anchorId) return errorResponse("动作段锚点定位失败（heading 块未找到），未追加");
                    await insertBlockMarkdown(projectId, lines.slice(n).join("\n"), undefined, anchorId);
                }
                await siyuan.rpc.broadcast(ACTIONS_UPDATED_CHANNEL, { projectId, actions: clean });
                return successResponse({ projectId, sectionCreated: false, written: clean.length, deleted });
            }

            // set_status
            const projectId = assertBlockId(input.projectId, "projectId");
            const status = input.status;
            if (status !== PROJECT_STATUS.ACTIVE && status !== PROJECT_STATUS.ARCHIVED) {
                return errorResponse(`status 必须是 ${PROJECT_STATUS.ACTIVE} 或 ${PROJECT_STATUS.ARCHIVED}`);
            }
            const rows = await sql<{ id: string; content: string }>(
                `SELECT id, content FROM blocks WHERE id='${projectId}' AND type='d'`,
            );
            if (!rows[0]) return errorResponse(`项目不存在: ${projectId}`);
            if (rows[0].content && TRIPLET_NAMES.includes(rows[0].content)) {
                return errorResponse(`${rows[0].content} 是三件套保留文档，不是项目`);
            }
            // 无属性=活跃（folder-model 唯一属性态=archived）：active=清属性，archived=打属性
            await setBlockAttrs(projectId, { [ATTR_PROJECT_STATUS]: status === PROJECT_STATUS.ARCHIVED ? status : "" });
            return successResponse({ id: projectId, status });
        }),
    };
}

/** 前端→kernel project-delete 的独立 handler（刻意不走 PROJECT_ACTIONS 枚举——
 *  不进 MCP project 工具 description，删除动作不对 AI 暴露；kernel.ts bind 专用）。
 *  流程=查主文档行（type='d' 校验）→删前统计子树文档数（物理目录前缀 LIKE，
 *  删后索引窗查不到）→屋檐防线（子树含 /主线数据 拒删）→removeDocByID 一发即删（入 history
 *  目录可恢复）。mainline-home-split 起项目全普通化：「我的主线」照常可删（旧 isMainlineContainer
 *  守卫退役——三件套已迁屋檐，项目删除通道够不着数据仓库）。
 *  活动项目指针（active-project.json）由前端确认回调清（前端 saveData 带 app 排除本窗，
 *  kernel 侧写 petal 会触发 dataChanges→前端插件整重载，不做）。 */
export async function deleteProjectRpc(input: { projectId?: unknown }): Promise<
    ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>
> {
    const projectId = assertBlockId(input?.projectId, "projectId");
    const rows = await sql<{ id: string; content: string; box: string; path: string; hpath: string }>(
        `SELECT id, content, box, path, hpath FROM blocks WHERE id='${projectId}' AND type='d'`,
    );
    const doc = rows[0];
    if (!doc) return errorResponse(`项目不存在: ${projectId}`);
    // 子树统计：blocks.path 前缀=父文档 id（剥 .sy 加 /）；含各层后代（线/线的子文档/归档区整树），不含主文档自身
    const dirPrefix = doc.path.replace(/\.sy$/, "");
    const statRows = await sql<{ n: number }>(
        `SELECT COUNT(*) AS n FROM blocks WHERE type='d' AND path LIKE '${dirPrefix}/%'`,
    );
    const deletedSubDocs = Number(statRows[0]?.n ?? 0);
    // 删目录防线（folder-model 防呆级）：目录是插件数据仓库非项目；项目删除=删目录一级文档，
    // 天然够不着目录与三件套——防线只防两类：目录 id 直传 + 用户手拖目录进项目子树连坐
    const root = await locateRoot();
    if (root) {
        if (root.id === projectId) {
            return errorResponse("这是主线目录（Project）本身——项目删除通道只删目录下的项目文档");
        }
        const homeRows = await sql<{ path: string }>(`SELECT path FROM blocks WHERE id='${root.id}' AND type='d'`);
        const homeDir = homeRows[0]?.path?.replace(/\.sy$/, "");
        if (homeDir && homeDir.startsWith(dirPrefix + "/")) {
            return errorResponse("项目子树内含主线目录（Project）——先把目录移出项目再删除");
        }
    }
    await removeDocByID(projectId);
    return successResponse({
        id: projectId,
        name: doc.content,
        deletedSubDocs,
        totalDocs: deletedSubDocs + 1,
    });
}
