import { parseTaskAttrs, type TaskDates } from "./schema";

// SQL blocks 行的窄化形态（零 siyuan 依赖，kernel/前端/单测三处可用）
export interface TaskRow {
    id: string;
    content: string;
    markdown: string;
    /** 内核 14 位时间戳（YYYYMMDDhhmmss 字典序） */
    updated: string;
    root_id: string;
    attrs?: Record<string, string>;
}

export interface OpenTaskBrief {
    id: string;
    content: string;
    dueDate?: string;
    updated: string;
}

export interface ProgressSummary {
    total: number;
    done: number;
    open: number;
    /** due==逻辑天 且未完 */
    dueToday: number;
    /** due<逻辑天 且未完 */
    overdue: number;
    /** 未完且无 due */
    openNoDue: number;
    lastActiveAt?: string;
    /** 未完任务速览：due 升序、无 due 垫后，截前 20 */
    openTasks: OpenTaskBrief[];
}

/** 任务完成判定（导出共 remind □2 共用——单事实源） */
export const DONE_RE = /^\s*[-*+] \[[xX]\]/;

export function isDone(row: TaskRow): boolean {
    return DONE_RE.test(row.markdown ?? "");
}

/** 进展推导=纯函数（零存储红线：聚合查询时算）。today=getLogicalDay 产物（YYYY-MM-DD，字典序可比）。 */
export function summarizeTasks(rows: TaskRow[], today: string): ProgressSummary {
    let done = 0;
    let dueToday = 0;
    let overdue = 0;
    let openNoDue = 0;
    let lastActiveAt: string | undefined;
    const openBriefs: Array<OpenTaskBrief & { _due?: string }> = [];

    for (const r of rows) {
        const d: TaskDates = parseTaskAttrs(r.attrs);
        if (lastActiveAt === undefined || r.updated > lastActiveAt) lastActiveAt = r.updated;
        if (isDone(r)) {
            done++;
            continue;
        }
        if (d.dueDate) {
            if (d.dueDate === today) dueToday++;
            else if (d.dueDate < today) overdue++;
        } else {
            openNoDue++;
        }
        openBriefs.push({ id: r.id, content: r.content, dueDate: d.dueDate, updated: r.updated, _due: d.dueDate });
    }

    openBriefs.sort((a, b) => {
        if (a._due && b._due) return a._due < b._due ? -1 : a._due > b._due ? 1 : 0;
        if (a._due) return -1;
        if (b._due) return 1;
        return 0;
    });

    return {
        total: rows.length,
        done,
        open: rows.length - done,
        dueToday,
        overdue,
        openNoDue,
        lastActiveAt,
        openTasks: openBriefs.slice(0, 20).map(({ id, content, dueDate, updated }) => ({ id, content, dueDate, updated })),
    };
}
