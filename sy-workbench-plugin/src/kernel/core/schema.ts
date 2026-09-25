// 属性 schema 定案（handoff □2 已拍板）：块+custom-* 属性=唯一事实源；属性名全小写连字符。
// 项目主文档 IAL 仅 custom-project-status 一条；任务块挂 custom-task-* 五属性；
// 「给 Agent 的话」与外部引用列表=主文档可见内容，不进 IAL（信息平铺）。

export const ATTR_PROJECT_STATUS = "custom-project-status";

/** 项目内归档区子文档名（lineTools 归档区/boardModel 按项目排除归档子树共用单源） */
export const ARCHIVE_DOC_NAME = "归档";

export const PROJECT_STATUS = {
    ACTIVE: "active",
    ARCHIVED: "archived",
} as const;
export type ProjectStatus = typeof PROJECT_STATUS[keyof typeof PROJECT_STATUS];

export const TASK_ATTRS = {
    dueDate: "custom-task-due-date",
    dueTime: "custom-task-due-time",
    startDate: "custom-task-start-date",
    startTime: "custom-task-start-time",
    tags: "custom-task-tags",
} as const;

export interface TaskDates {
    dueDate?: string;
    dueTime?: string;
    startDate?: string;
    startTime?: string;
    tags?: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** HH:MM 值域校验（与 dates.parseHM 同规则，零依赖内联版——99:99 不得入库，review P2-5） */
function assertTimeValue(v: string, field: string): void {
    const m = /^(\d{2}):(\d{2})$/.exec(v);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`invalid ${field}: ${v}`);
}

export function parseTags(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/** 属性集 → 结构化；只认 custom-task-* 五键，其余忽略 */
export function parseTaskAttrs(attrs: Record<string, string> | undefined | null): TaskDates {
    const out: TaskDates = {};
    if (!attrs) return out;
    if (attrs[TASK_ATTRS.dueDate]) out.dueDate = attrs[TASK_ATTRS.dueDate];
    if (attrs[TASK_ATTRS.dueTime]) out.dueTime = attrs[TASK_ATTRS.dueTime];
    if (attrs[TASK_ATTRS.startDate]) out.startDate = attrs[TASK_ATTRS.startDate];
    if (attrs[TASK_ATTRS.startTime]) out.startTime = attrs[TASK_ATTRS.startTime];
    if (attrs[TASK_ATTRS.tags]) out.tags = parseTags(attrs[TASK_ATTRS.tags]);
    return out;
}

/** 结构化 → IAL 属性集；undefined 字段省略；显式 ""=清空该属性（setBlockAttrs 空值即清） */
export function serializeTaskDates(dates: Partial<TaskDates>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, attr, re] of [
        ["dueDate", TASK_ATTRS.dueDate, DATE_RE],
        ["dueTime", TASK_ATTRS.dueTime, TIME_RE],
        ["startDate", TASK_ATTRS.startDate, DATE_RE],
        ["startTime", TASK_ATTRS.startTime, TIME_RE],
    ] as const) {
        const v = dates[key];
        if (v === undefined) continue;
        if (v !== "" && !re.test(v)) throw new Error(`invalid ${key}: ${v}`);
        if ((key === "dueTime" || key === "startTime") && v !== "") assertTimeValue(v, key);
        out[attr] = v;
    }
    if (dates.tags !== undefined) {
        out[TASK_ATTRS.tags] = dates.tags.join(",");
    }
    return out;
}
