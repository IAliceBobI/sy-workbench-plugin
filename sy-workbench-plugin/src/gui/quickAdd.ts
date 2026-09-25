// dataview □6：速记落盘通道（前端「手眼直连数据」面——fe.ts P3 拍板边界）。
// 写形=MCP task.create 同款（taskTools.ts 唯一既有建任务通道）：定位主文档任务章节
// （标题含「任务」子串即认——R4 容错，防改名后文尾另建双章节）
// → 章节尾插 `- [ ] 任务名`（列表并壳走 li 级 previousID 锚——insertListItem 同语义）→ 属性
// 三类去向（契约 §3/§8.5）：日期/时刻=custom-task-due-date/-time（参数留属性）；池/配额=
// custom-ammo-pool/quota（降级缓存——真相=每日配置文档结构，挂池进配置走引擎/看板列尾，
// 本通道不碰配置文档）。全文档确无含「任务」标题=文档尾补建（set_actions 无段先例同款）。
// 两步写（insert→attrs）非原子：属性段失败=ok:true+warnings 局部兜底（R5——块已落盘，
// 谎报失败=重试重复建块）。纯函数（锚点规划/响应解析）与 IO（feCall）分层——纯面单测钉死。

import { feCall } from "./fe";
import { debugLog } from "../libs/debugLog";
import { serializeTaskDates } from "@/kernel/core/schema";
import type { QuickParseResult } from "./quickParse";

/** 文档顶层子块（getChildBlocks 直出形态——blocktree 直读零索引窗，api.ts 同款形状） */
export interface QuickAddChildBlock {
    id: string;
    type: string;
    subType?: string;
    content?: string | null;
}

export interface TaskSectionPlan {
    /** true=全文档无含「任务」标题（确无才建——杜绝文尾另建双章节）——插 markdown 须带 `## 任务` 标题 */
    sectionCreated: boolean;
    /** 插入锚块（其后插）；null=空文档（不带 previousID） */
    anchor: QuickAddChildBlock | null;
}

/**
 * 「## 任务」章节插入锚规划（纯函数）：
 * - 章节锚=任务标题到下一顶层标题（或文档尾）之间的最后一块；空章节=标题自身（标题后插）
 * - 全文档无含「任务」标题=文档尾最后一块之后补建「## 任务」+条目
 * 标题匹配（R4 容错）=type h 且 content trim 后含「任务」子串——用户改名「今日任务/任务清单」
 * 仍认原章节（不再文尾另建双章节）；层级不限（H1~H6）；多匹配取文档序首个。
 */
export function planTaskSectionInsert(children: QuickAddChildBlock[]): TaskSectionPlan {
    const hi = children.findIndex((c) => c.type === "h" && (c.content ?? "").trim().includes("任务"));
    if (hi === -1) {
        return { sectionCreated: true, anchor: children.length ? children[children.length - 1] : null };
    }
    let end = children.length - 1;
    for (let j = hi + 1; j < children.length; j++) {
        if (children[j].type === "h") {
            end = j - 1;
            break;
        }
    }
    return { sectionCreated: false, anchor: children[end] };
}

/**
 * 插块响应 → 任务条目块 id（纯函数）。任务 markdown=- [ ] x 双层结构：op.id=外层 NodeList
 * 容器、任务本体=内层 data-task 所在 li——属性必须挂内层（kernel/api.ts insertBlockMarkdown
 * 同款判形；挂容器=属性与 SQL 任务行永不相交，09-10 实测）。多块插入（补建章节=标题+列表）
 * 扫全部事务的全部 op。找不到=返回 null（调用方报错——不回退容器 id，回退=静默 bug 复活）。
 */
export function parseInsertedTaskId(txs: unknown): string | null {
    if (!Array.isArray(txs)) return null;
    for (const tx of txs) {
        const ops = (tx as any)?.doOperations;
        if (!Array.isArray(ops)) continue;
        for (const op of ops) {
            const m = /data-task="[^"]*" data-node-id="([^"]+)"/.exec(String((op as any)?.data ?? ""));
            if (m) return m[1];
        }
    }
    return null;
}

/** 锚=列表容器时下潜取末孙 li（新任务并进既有列表壳；深度封顶防病态嵌套） */
async function descendLastLi(block: QuickAddChildBlock, depth: number): Promise<string> {
    if (block.type === "l" && depth < 3) {
        let kids: QuickAddChildBlock[] = [];
        try {
            kids = (await feCall<QuickAddChildBlock[]>("/api/block/getChildBlocks", { id: block.id })) ?? [];
        } catch {
            kids = [];
        }
        if (kids.length) return descendLastLi(kids[kids.length - 1], depth + 1);
    }
    return block.id;
}

export type QuickAddOutcome =
    | { ok: true; taskId: string; sectionCreated: boolean; warnings: string[] }
    | { ok: false; error: string };

/**
 * 速记落盘：活跃项目主文档任务章节尾插 `- [ ] 任务名` + 属性挂靠。
 * 失败形态（fail-soft 通道面）：无任务名/响应形态漂移——返回 {ok:false,error}，不 throw
 * （UI 面就地提示）。属性段两步写补偿（R5）：insert 事务已提交后 setBlockAttrs 失败
 * ≠整单失败——任务块已落盘无回滚，谎报失败=用户重试重复建块；降级 ok:true+
 * warnings:["attrs-failed"]（参数可稍后经徽标/文档补设——块在，参数丢了可补）。
 */
export async function quickAddTask(projectId: string, parsed: QuickParseResult): Promise<QuickAddOutcome> {
    const title = parsed.name.replace(/\s*\n+\s*/g, " ").trim();
    if (!title) return { ok: false, error: "no-task-name" };
    let children: QuickAddChildBlock[] = [];
    try {
        children = (await feCall<QuickAddChildBlock[]>("/api/block/getChildBlocks", { id: projectId })) ?? [];
    } catch {
        children = [];
    }
    const plan = planTaskSectionInsert(children);
    const markdown = plan.sectionCreated ? `## 任务\n\n- [ ] ${title}` : `- [ ] ${title}`;
    let previousID: string | undefined;
    if (plan.anchor) {
        previousID = plan.sectionCreated ? plan.anchor.id : await descendLastLi(plan.anchor, 0);
    }
    const txs = await feCall<unknown>("/api/block/insertBlock", {
        dataType: "markdown",
        data: markdown,
        parentID: projectId,
        ...(previousID ? { previousID } : {}),
    });
    const taskId = parseInsertedTaskId(txs);
    if (!taskId) return { ok: false, error: "insert 响应无任务条目 id（内核 HTML 形态漂移？）" };
    const attrs: Record<string, string> = {};
    // 日期/时刻走 serializeTaskDates（键名+值域校验单一事实源——quickParse 已保证合法，
    // 此处 throw 不可能；dueTime 单独出现也照挂——任务可只设时刻不设日）
    if (parsed.date || parsed.dueTime) {
        Object.assign(attrs, serializeTaskDates({
            ...(parsed.date ? { dueDate: parsed.date } : {}),
            ...(parsed.dueTime ? { dueTime: parsed.dueTime } : {}),
        }));
    }
    if (parsed.pool) attrs["custom-ammo-pool"] = parsed.pool;
    if (parsed.quota != null) attrs["custom-ammo-quota"] = String(parsed.quota);
    if (Object.keys(attrs).length > 0) {
        try {
            await feCall("/api/attr/setBlockAttrs", { id: taskId, attrs });
        } catch (e: any) {
            // R5：此刻 insert 事务已提交——块已建成，属性挂靠失败只降级不谎报失败
            //（细节进 debugLog 供 Loki 排障；调用方按 warnings 呈现「任务已建，参数未完全挂上」）
            debugLog("fe", `!! quickAdd attrs failed (task ${taskId} 已建成，参数未挂): ${String(e?.message ?? e)}`);
            return { ok: true, taskId, sectionCreated: plan.sectionCreated, warnings: ["attrs-failed"] };
        }
    }
    return { ok: true, taskId, sectionCreated: plan.sectionCreated, warnings: [] };
}
