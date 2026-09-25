import {
    getBlockAttrs,
    getBlockRow,
    insertBlockMarkdown,
    setBlockAttrs,
    sql,
    updateBlockMarkdown,
} from "../api";
import type { FeishuConfig, SyncTaskInput } from "../core/feishu";
import { loadConfig, loadLedger, syncTask } from "../feishu";
import { isDone } from "../core/progressCalc";
import { serializeTaskDates, parseTags } from "../core/schema";
import { HOME_DIARY_HPATH } from "../../shared/homePaths";
import { errorResponse, successResponse, objectSchema, wrapHandler, type ToolDefinition } from "./common";

const TASK_ACTIONS = ["list", "create", "complete", "schedule"] as const;

/** 思源块 id 严格式（14 位时间戳-7 位 [0-9a-z]）——SQL 拼接前的注入面收口 */
function assertBlockId(id: unknown, field: string): string {
    if (typeof id !== "string" || !/^20\d{12}-[0-9a-z]{7}$/.test(id)) {
        throw new Error(`字段 ${field} 必须是思源块 id（yyyymmddhhmmss-xxxxxxx）`);
    }
    return id;
}

export interface TaskQueryRow {
    id: string;
    content: string;
    markdown: string;
    updated: string;
    root_id: string;
    due_date: string | null;
    due_time: string | null;
    start_date: string | null;
    start_time: string | null;
    tags: string | null;
}

/** 子树任务查询：归属=文档树位置（id=主文档 或 path 前缀=子文档），非属性（红线①）。
 *  ⚠️ 子文档物理目录=父文档 id 不带 .sy——前缀须剥 .sy 加 '/'（review P0 实测：带 .sy 只匹配父自身，
 *  子文档任务/子文档列表全静默丢失）；limit 原样入 LIMIT（list 的 status 过滤补偿由调用方超取） */
export function buildTaskListSql(projectId: string, projectPath: string, limit: number): string {
    const dirPrefix = projectPath.replace(/\.sy$/, "");
    return `SELECT b.id, TRIM(b.content) AS content, b.markdown, b.updated, b.root_id,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-date' THEN a.value END) AS due_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-time' THEN a.value END) AS due_time,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-date' THEN a.value END) AS start_date,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-time' THEN a.value END) AS start_time,
        GROUP_CONCAT(CASE WHEN a.name='custom-task-tags' THEN a.value END) AS tags
    FROM blocks b
    LEFT JOIN attributes a ON a.block_id=b.id AND a.name IN (
        'custom-task-due-date','custom-task-due-time','custom-task-start-date','custom-task-start-time','custom-task-tags')
    WHERE b.type='i' AND b.subtype='t'
      AND b.root_id IN (SELECT id FROM blocks WHERE type='d' AND (id='${projectId}' OR path LIKE '${dirPrefix}/%'))
    GROUP BY b.id
    ORDER BY b.updated DESC
    LIMIT ${Math.min(Math.floor(limit), 500)}`;
}

function toTaskBrief(r: TaskQueryRow) {
    return {
        id: r.id,
        content: r.content,
        done: isDone({ id: r.id, content: r.content, markdown: r.markdown, updated: r.updated, root_id: r.root_id }),
        dueDate: r.due_date ?? undefined,
        dueTime: r.due_time ?? undefined,
        startDate: r.start_date ?? undefined,
        startTime: r.start_time ?? undefined,
        tags: r.tags ? parseTags(r.tags) : [],
        updated: r.updated,
        root_id: r.root_id,
    };
}

const TASK_MARK_RE = /^(\s*[-*+] )\[( |x|X)\]/;

/** 动作尾巴：日历同步顺手挂——任何失败都不阻塞任务写入，尾巴一句原因与出路（不做常驻徽标）。
 *  intent="date"（due 挂钩）未配置→提示出路；"delete"（完成摘钩）未配置→静默（未配置=绝无映射可摘）。 */
async function calendarTail(task: SyncTaskInput, intent: "date" | "delete" = "date"): Promise<{ calendar?: any; calendarHint?: string }> {
    let cfg: FeishuConfig | null;
    try {
        cfg = await loadConfig();
    } catch (e: any) {
        return intent === "date"
            ? { calendarHint: `日历配置读取失败（${e?.message ?? e}）——任务已保存，修好 calendar.set_config 后喊 sync 补挂` }
            : {};
    }
    if (!cfg) {
        return intent === "date"
            ? { calendarHint: "未配置飞书日历——到期提醒没挂上；要提醒就喊 calendar.set_config（appId/appSecret/userOpenId 三件套，配好自动体检）" }
            : {};
    }
    if (!cfg.enabled) return {};
    if (!(await loadLedger()).sources.task.enabled) return {}; // 源开关闸（pause：摘钩也不做——事件留着）
    try {
        const r = await syncTask(task, cfg);
        return r.warning ? { calendar: r, calendarHint: `日历同步：${r.warning}` } : { calendar: r };
    } catch (e: any) {
        return intent === "date"
            ? { calendarHint: `飞书日历同步失败（${e?.message ?? e}）——任务已保存，修好后喊 calendar.sync {taskId:"${task.blockId}"} 补挂` }
            : { calendar: { action: "delete", warning: `摘钩失败（${e?.message ?? e}）——残留日程用 calendar.unlink 清` } };
    }
}

export function createTaskTool(): ToolDefinition {
    return {
        name: "task",
        config: objectSchema(
            "项目内目标域任务管理（任务=原生任务列表块，归属=所在文档树位置——挂哪条线，森林图就画在哪棵树）。"
            + "Actions: list(projectId 列子树任务，可 dueOn/dueBefore/status 过滤), "
            + "create(parentId+title 建任务块，可带 dueDate/dueTime/startDate/startTime/tags), "
            + "complete(taskId 勾选/取消勾选), schedule(taskId 设/改/清日期与标签，空串=清空)。"
            + "日期 YYYY-MM-DD、时间 HH:MM；单填 dueDate 默认语义=截止。"
            + "分界判据：切的是结构就建任务（跨多天推进的目标、可分解的阶段——如文章的起承转合）；切的是时间进班表（某天某时做什么→routine.schedule_set，勿为此建任务）。"
            + `⚠️勿在日志子树（${HOME_DIARY_HPATH}/）下建任务——该域任务不进项目看板（建了隐身）；日志里冒出的目标种子先与用户确认建到项目，再谈排期。`
            + "⚠️写后 SQL 索引有 3~10s 延迟：create/schedule/complete 后别立即 list/get_progress 复核，先干别的再查。",
            {
                action: { type: "string", enum: [...TASK_ACTIONS], description: "操作类型" },
                projectId: { type: "string", description: "list: 项目主文档 id（划子树范围）" },
                parentId: { type: "string", description: "create: 容器块/文档 id（新任务插到其末尾）" },
                taskId: { type: "string", description: "complete/schedule: 任务块 id" },
                title: { type: "string", description: "create: 任务标题" },
                done: { type: "boolean", description: "complete: true=勾选（默认）false=取消" },
                status: { type: "string", enum: ["open", "done", "all"], description: "list: 过滤（默认 open）" },
                dueOn: { type: "string", description: "list: 只看 due=该日（YYYY-MM-DD）" },
                dueBefore: { type: "string", description: "list: 只看 due<该日" },
                limit: { type: "number", description: "list: 返回上限（默认 50）" },
                dueDate: { type: "string", description: "create/schedule: 截止日期 YYYY-MM-DD（schedule 传空串=清空）" },
                dueTime: { type: "string", description: "create/schedule: 截止时刻 HH:MM" },
                startDate: { type: "string", description: "create/schedule: 开始日期 YYYY-MM-DD" },
                startTime: { type: "string", description: "create/schedule: 开始时刻 HH:MM" },
                tags: { type: "array", items: { type: "string" }, description: "create/schedule: 标签列表" },
            },
            ["action"],
        ),
        handler: wrapHandler(async (input) => {
            const action = input?.action;
            if (!TASK_ACTIONS.includes(action)) return errorResponse(`未知 action: ${action}`);

            if (action === "list") {
                const projectId = assertBlockId(input.projectId, "projectId");
                const pathRows = await sql<{ id: string; path: string }>(
                    `SELECT id, path FROM blocks WHERE id='${projectId}'`,
                );
                if (!pathRows[0]?.path) return errorResponse(`项目不存在: ${projectId}`);
                const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 50;
                const rows = await sql<TaskQueryRow>(buildTaskListSql(projectId, pathRows[0].path, limit * 3));
                let tasks = rows.map(toTaskBrief);
                const status = input.status === "done" || input.status === "all" ? input.status : "open";
                if (status !== "all") tasks = tasks.filter((t) => (status === "open" ? !t.done : t.done));
                if (typeof input.dueOn === "string" && input.dueOn) tasks = tasks.filter((t) => t.dueDate === input.dueOn);
                if (typeof input.dueBefore === "string" && input.dueBefore) tasks = tasks.filter((t) => !!t.dueDate && t.dueDate < input.dueBefore);
                return successResponse({ tasks: tasks.slice(0, limit) });
            }

            if (action === "create") {
                const parentId = assertBlockId(input.parentId, "parentId");
                if (typeof input.title !== "string" || !input.title.trim()) return errorResponse("title 必填");
                const title = input.title.replace(/\s*\n+\s*/g, " ").trim();
                // 先校验序列化再插块：日期非法时不在容器里留下裸块
                const dates = serializeTaskDates({
                    ...(typeof input.dueDate === "string" ? { dueDate: input.dueDate } : {}),
                    ...(typeof input.dueTime === "string" ? { dueTime: input.dueTime } : {}),
                    ...(typeof input.startDate === "string" ? { startDate: input.startDate } : {}),
                    ...(typeof input.startTime === "string" ? { startTime: input.startTime } : {}),
                    ...(Array.isArray(input.tags) ? { tags: input.tags.map(String) } : {}),
                });
                const blockId = await insertBlockMarkdown(parentId, `- [ ] ${title}`);
                if (Object.keys(dates).length > 0) await setBlockAttrs(blockId, dates);
                const tail = dates["custom-task-due-date"]
                    ? await calendarTail({
                        blockId,
                        content: title,
                        dueDate: dates["custom-task-due-date"],
                        dueTime: dates["custom-task-due-time"] || undefined,
                        ...(dates["custom-task-start-date"] ? { startDate: dates["custom-task-start-date"] } : {}),
                        ...(dates["custom-task-start-time"] ? { startTime: dates["custom-task-start-time"] } : {}),
                    })
                    : {};
                return successResponse({ id: blockId, parentId, ...tail });
            }

            if (action === "complete") {
                const taskId = assertBlockId(input.taskId, "taskId");
                const done = input.done === undefined ? true : Boolean(input.done);
                const row = await getBlockRow(taskId);
                if (!row?.markdown) return errorResponse(`块不存在: ${taskId}`);
                const m = TASK_MARK_RE.exec(row.markdown);
                if (!m) return errorResponse(`不是任务列表块（markdown 无 [ ]/[X] 标记）: ${taskId}`);
                const next = done ? `${m[1]}[X]` : `${m[1]}[ ]`;
                await updateBlockMarkdown(taskId, row.markdown.replace(TASK_MARK_RE, next));
                // 完成=删事件；取消勾选不自动恢复（重新 schedule/sync 才重挂）
                const tail = done ? await calendarTail({ blockId: taskId, done: true }, "delete") : {};
                return successResponse({ id: taskId, done, ...tail });
            }

            // schedule
            const taskId = assertBlockId(input.taskId, "taskId");
            const dates = serializeTaskDates({
                ...(typeof input.dueDate === "string" ? { dueDate: input.dueDate } : {}),
                ...(typeof input.dueTime === "string" ? { dueTime: input.dueTime } : {}),
                ...(typeof input.startDate === "string" ? { startDate: input.startDate } : {}),
                ...(typeof input.startTime === "string" ? { startTime: input.startTime } : {}),
                ...(Array.isArray(input.tags) ? { tags: input.tags.map(String) } : {}),
            });
            if (Object.keys(dates).length === 0) return errorResponse("未提供任何日期/标签字段（无操作）");
            await setBlockAttrs(taskId, dates);
            // 日历联动只认显式 dueDate（含空串=清）；dueTime-only 改动不触发（旧 due 未知，别猜）。
            // □16 start 现值读属性（schedule 整包只写传入字段——未传 start 保持，镜像区间须感知，
            // 否则改 due 会把既有区间事件推平成锚点）
            let tail: { calendar?: any; calendarHint?: string } = {};
            if (typeof input.dueDate === "string") {
                const row = await getBlockRow(taskId).catch(() => null);
                const attrs = await getBlockAttrs(taskId).catch(() => null);
                const startDate = typeof input.startDate === "string" && input.startDate !== ""
                    ? input.startDate : attrs?.["custom-task-start-date"];
                const startTime = typeof input.startTime === "string" && input.startTime !== ""
                    ? input.startTime : attrs?.["custom-task-start-time"];
                tail = await calendarTail({
                    blockId: taskId,
                    ...(row?.content ? { content: row.content } : {}),
                    dueDate: input.dueDate === "" ? undefined : input.dueDate,
                    ...(input.dueTime !== undefined && input.dueTime !== "" ? { dueTime: input.dueTime } : {}),
                    ...(startDate ? { startDate } : {}),
                    ...(startTime ? { startTime } : {}),
                });
            }
            return successResponse({ id: taskId, attrs: dates, ...tail });
        }),
    };
}
