// dataview □4：看板列尾速记落盘通道（挂池半边——quickAdd 的配置文档续链）。
// quickAddTask（□6）只落任务块+属性缓存（「挂池进配置走引擎/看板列尾，本通道不碰配置文档」
// ——quickAdd.ts 头注释的欠账在此还）：按池列尾「+」速记 = 落块（quickAddTask 同款「## 任务」
// 章节锚）+往今日配置容器尾插 `((id)) 任务名 · 配额` 行（契约 §4：层级即挂载、引用即指针——
// 行文本/属性全走 core taskRowText/taskRowAttrs 单事实源，与 kernel writeDayConfig 落同形）。
// fail-soft：月文档/当日容器缺/容器空壳（writeDayConfig「空配置写空容器=当日组清空」的
// 合法终态）=不建档不报错（{attached:false,reason}——块已建+池缓存属性在，看板缓存源照常
// 可见；建档/重建壳是 kernel 引擎/交接会的职责，前端读面不越权建结构）。
// IO 面（feCall/feQuery）+纯面（resolveEntryPool 在 boardModel——单测钉死）分层。

import { feCall, feQuery } from "./fe";
import { dayConfigDocSql } from "./queries";
import { taskRowAttrs, taskRowText, type AmmoPoolSlug } from "@/kernel/core/ammoQuadrant";
import { parseListItemId } from "@/kernel/core/schedboard";
import { isValidDay } from "@/kernel/core/schedule";

/** 每日配置容器识别（kernel/ammoQuadrant.ts DAYCONFIG_ROLE_VALUE 同值——gui 自持常量） */
const DAYCONFIG_ROLE = "ammo-dayconfig";

/** 挂载跳过原因 code（模块层零 i18n——UI 面按 code 映射文案，index.ts quickAdd「no-task-name」同款先例） */
export type PoolAttachSkipReason = "no-doc" | "no-container" | "empty-container";

export interface PoolAttachOutcome {
    ok: boolean;
    /** true=行已落配置容器；false=挂载跳过（fail-soft 非错误——reason 带 code） */
    attached: boolean;
    /** attached=false 的原因：no-doc=月文档缺/no-container=当日容器缺/empty-container=容器空壳 */
    reason?: PoolAttachSkipReason;
    error?: string;
}

/** 顶层块 attrs 批读入参形态（getChildBlocks 直出——逐块 IAL 直读收集） */
interface TopBlock {
    id: string;
    type: string;
    content?: string | null;
}

/** 月文档顶层找当日容器（kernel findConfigContainer 的读半边——custom-role+custom-ammo-day
 *  双键判定；月文档多月日组共存逐组扫）。纯读不写。 */
async function findDayContainer(docId: string, day: string): Promise<string | null> {
    const tops = (await feCall<TopBlock[]>("/api/block/getChildBlocks", { id: docId })) ?? [];
    for (const b of tops) {
        const attrs = await feCall<Record<string, string> | null>("/api/attr/getBlockAttrs", { id: b.id });
        if (attrs?.["custom-role"] === DAYCONFIG_ROLE && attrs?.["custom-ammo-day"] === day) return b.id;
    }
    return null;
}

/**
 * 挂池：今日配置容器尾插 `((taskId)) 任务名 · 配额`+行属性（容器级尾插=kernel writeDayConfig
 * 新增行同款锚——行与池的归属由文本/属性承载，行位不承载语义）。
 * 任何失败返回 {ok:false,error} 不 throw（UI 面就地提示）；月文档/容器缺/容器空壳
 * ={ok:true,attached:false,reason}（fail-soft——块已建，勿引导重试录入）。
 */
export async function attachTaskToDayConfig(day: string, task: {
    id: string;
    name: string;
    quota: number | null;
    pool: AmmoPoolSlug;
}): Promise<PoolAttachOutcome> {
    try {
        if (!isValidDay(day)) return { ok: false, attached: false, error: `非法日期：${day}` };
        if (!task.id) return { ok: false, attached: false, error: "任务块 id 空" };
        const docs = await feQuery<{ id: string }>(dayConfigDocSql(day));
        const docId = docs[0]?.id;
        if (!docId) return { ok: true, attached: false, reason: "no-doc" };
        const containerId = await findDayContainer(docId, day);
        if (!containerId) return { ok: true, attached: false, reason: "no-container" };
        const rows = (await feCall<TopBlock[]>("/api/block/getChildBlocks", { id: containerId })) ?? [];
        // 空容器不插、fail-soft 收编（R1）：无锚裸插 parentID=容器被内核拒（invalid block
        // structure: NodeList cannot contain NodeList——api.ts insertListItem 探针）；改
        // parentID=文档无锚=另起平级容器落在 role 容器外、读面不可见（moveTaskPoolInner
        // 空壳先例同判）；重建壳=整组写链（writeDayConfig 首建分支）的职责，本通道不越权。
        // 此刻任务块已由 quickAddTask 建成——按非错误呈现，防「见失败重试=重复建块」。
        if (!rows.length) return { ok: true, attached: false, reason: "empty-container" };
        const row = { pool: task.pool, task: task.id, quota: task.quota, name: task.name };
        // 响应形态：op.id=外层 NodeList 容器、li 本体在 data HTML——parseListItemId 剥
        // （kernel insertListItem 同判形；quickAdd.parseInsertedTaskId 是任务 li 特化不适用）
        const txs = await feCall<unknown>("/api/block/insertBlock", {
            dataType: "markdown",
            data: `- ${taskRowText(row)}`,
            parentID: containerId,
            previousID: rows[rows.length - 1].id,
        });
        const ops = Array.isArray(txs) ? txs : [];
        const liId = parseListItemId(String((ops[0] as any)?.doOperations?.[0]?.data ?? ""));
        if (!liId) return { ok: false, attached: false, error: "insert 响应无列表项 id（内核 HTML 形态漂移？）" };
        await feCall("/api/attr/setBlockAttrs", { id: liId, attrs: taskRowAttrs(row) });
        return { ok: true, attached: true };
    } catch (e: any) {
        return { ok: false, attached: false, error: String(e?.message ?? e) };
    }
}
