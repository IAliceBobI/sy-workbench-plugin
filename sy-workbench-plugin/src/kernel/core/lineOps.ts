// 换线纯逻辑：路径/hpath 推导与顶层祖先块推导（块行 path=文档路径非祖先链，
// 祖先须走 parent_id 链——dev 6809 实测形态：任务 p→item(i)→list(l)→文档）。

import { isDone, type TaskRow } from "./progressCalc";

/** 线文档物理路径 → 父文档 id（"/a/b.sy"→"a"、"/p/a/b.sy"→"a"；笔记本根级 "/a.sy"→null） */
export function parentDocIdFromPath(path: string): string | null {
    const m = /\/([^/]+)\/[^/]+\.sy$/.exec(path);
    return m ? m[1] : null;
}

/** hpath → 父 hpath（"/P/线"→"/P"；"/线"→"/"） */
export function parentHpath(hpath: string): string {
    const idx = hpath.lastIndexOf("/");
    return idx <= 0 ? "/" : hpath.slice(0, idx);
}

const MAX_HOPS = 50;

export interface TopAncestorResult {
    /** 任务所在顶层祖先块 id（去重、按发现序） */
    ancestors: string[];
    /** 块表里找不到祖先链的任务（子文档里的/孤儿）——调用方须上报而非静默 */
    unresolvedTaskIds: string[];
}

/** 线文档块表（id+parent_id）→ 各任务的顶层祖先块（归档迁移的搬移单元） */
export function topAncestorIds(
    blocks: { id: string; parent_id: string | null }[],
    taskIds: string[],
    rootDocId: string,
): TopAncestorResult {
    const parentId = new Map(blocks.map((b) => [b.id, b.parent_id ?? ""]));
    const ancestors: string[] = [];
    const unresolvedTaskIds: string[] = [];
    const seen = new Set<string>();
    for (const tid of taskIds) {
        let cur = tid;
        let anc: string | null = null;
        for (let hop = 0; hop < MAX_HOPS; hop++) {
            const parent = parentId.get(cur);
            if (parent === undefined) break; // 不在本线文档块表（子文档里的）
            if (parent === rootDocId) {
                anc = cur;
                break;
            }
            if (!parent) break; // 文档行自身/断链
            cur = parent;
        }
        if (anc && !seen.has(anc)) {
            seen.add(anc);
            ancestors.push(anc);
        } else if (!anc) {
            unresolvedTaskIds.push(tid);
        }
    }
    return { ancestors, unresolvedTaskIds };
}

// ── done 任务收拢计划（sweep_done 纯层——03 收拢件） ──

/** 收拢计划输入行（单文档块表 SQL 直出：type IN ('i','l')——任务项 type='i'+subtype='t'；
 *  l 容器 subtype 也填 't'（任务列表容器标记，e2e 实锤）且 markdown=全列表文本，判据须
 *  看 type 勿只看 subtype；嵌套形态：子任务项→子 l→父任务项） */
export interface SweepBlockRow {
    id: string;
    parent_id: string | null;
    type?: string | null;
    subType?: string | null;
    markdown?: string | null;
}

export interface TaskSweepPlan {
    /** 可收顶层 done 任务项 id（子树任务全 done——moveBlock 连子树整体收进归档区，保 id） */
    sweepable: string[];
    /** done 但被拦的顶层任务项（子树含未完任务——红线：未完不进归档，须上报人工处置） */
    skipped: Array<{ id: string; reason: "open-descendant" }>;
}

/** done 任务收拢计划：收拢单元=顶层任务项（沿 parent 上爬无任务项祖先——速记/quickAdd
 *  落的默认形态；嵌套拆步跟父走不单独抽子，结构完整性优先）。顶层 done 且子树任务全
 *  done → sweepable；子树有未完 → skipped；顶层未完 → 留原地不报。 */
export function planTaskSweep(rows: SweepBlockRow[]): TaskSweepPlan {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const childrenOf = new Map<string, string[]>();
    for (const r of rows) {
        const key = r.parent_id ?? "";
        const arr = childrenOf.get(key);
        if (arr) arr.push(r.id);
        else childrenOf.set(key, [r.id]);
    }
    const isTask = (r: SweepBlockRow) => r.type === "i" && r.subType === "t";
    const done = (r: SweepBlockRow) => isDone({ markdown: r.markdown ?? "" } as TaskRow);
    const hasTaskAncestor = (id: string): boolean => {
        let cur = byId.get(id);
        for (let hop = 0; hop < MAX_HOPS && cur; hop++) {
            if (!cur.parent_id) return false;
            cur = byId.get(cur.parent_id);
            if (!cur) return false; // 父不在行集（文档行）=已到顶
            if (isTask(cur)) return true;
        }
        return false;
    };
    const hasOpenDescendant = (id: string): boolean => {
        const queue = [id];
        const visited = new Set<string>([id]); // 环防御（脏数据互为子）
        while (queue.length) {
            const cur = queue.shift()!;
            for (const cid of childrenOf.get(cur) ?? []) {
                if (visited.has(cid)) continue;
                visited.add(cid);
                const c = byId.get(cid);
                if (!c) continue;
                if (isTask(c) && !done(c)) return true;
                queue.push(cid);
            }
        }
        return false;
    };
    const sweepable: string[] = [];
    const skipped: TaskSweepPlan["skipped"] = [];
    for (const r of rows) {
        if (!isTask(r) || !done(r) || hasTaskAncestor(r.id)) continue;
        if (hasOpenDescendant(r.id)) skipped.push({ id: r.id, reason: "open-descendant" });
        else sweepable.push(r.id);
    }
    return { sweepable, skipped };
}
