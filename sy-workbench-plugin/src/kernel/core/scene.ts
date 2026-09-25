// 现场快照纯逻辑：capture（tabs 原始数据→快照）与 replayPlan（快照→恢复步骤）。
// 执行层在前端（openTab 调用）——P0 结论：块 id 直接 openTab 会开独立页签，
// 恢复须「doc 一次+块定位复用页签」，故 replay 产物=文档级步骤+focusBlockId 标注。

export interface SceneTab {
    docId: string;
    blockId?: string;
    zoomIn?: boolean;
    title?: string;
}

export interface SceneSnapshot {
    projectId: string;
    tabs: SceneTab[];
    /** 原始活动页签 id（调试用） */
    activeTabId?: string;
    /** 活动页签所在文档 id——replay 聚焦目标（activeTabId 对应页签的 docId） */
    activeDocId?: string;
    capturedAt: number;
}

/** 前端 getAllTabs 映射后的窄输入（零 siyuan 类型依赖） */
export interface RawTabInfo {
    id: string;
    docId?: string;
    blockId?: string;
    title?: string;
}

export function captureScene(
    projectId: string,
    rawTabs: RawTabInfo[],
    active?: { tabId?: string; docId?: string },
    maxTabs = 10,
): SceneSnapshot {
    const byDoc = new Map<string, SceneTab>();
    for (const t of rawTabs) {
        if (!t.docId) continue; // dock/设置等非编辑器页签
        const existing = byDoc.get(t.docId);
        if (!existing) {
            byDoc.set(t.docId, { docId: t.docId, blockId: t.blockId, title: t.title });
        } else if (!existing.blockId && t.blockId) {
            // 同文档多页签：合并为一条，尽量带块定位
            existing.blockId = t.blockId;
        }
    }
    // 聚焦文档优先取聚焦页签头映射（UI 真相）；活动编辑器 rootId 仅兜底——
    // P1 实测 .layout-tab-item--focus 选择器恒空（真类名=item--focus 附加类），聚焦恢复退化
    const activeDocId = (active?.tabId ? rawTabs.find((t) => t.id === active.tabId)?.docId : undefined)
        ?? active?.docId;
    return {
        projectId,
        tabs: Array.from(byDoc.values()).slice(0, maxTabs),
        activeTabId: active?.tabId,
        activeDocId,
        capturedAt: Date.now(),
    };
}

export interface ReplayStep {
    docId: string;
    focusBlockId?: string;
    zoomIn?: boolean;
}

export function replayPlan(scene: SceneSnapshot | null): ReplayStep[] {
    if (!scene) return [];
    return scene.tabs.map((t) => ({ docId: t.docId, focusBlockId: t.blockId, zoomIn: t.zoomIn }));
}

/** 快照实质等价（忽略 capturedAt 时间戳）：页签集/聚焦没变=没变。
 *  unload 落盘防抖判据——petal 每次写都触发内核 dataChanges→插件重载→又 unload 写
 *  =自持重载风暴环（09-14 projbuttons e2e 实锤）；页签集不变就别写，环自断。
 *  ⚠️activeTabId 不参与比较：它是页签实例 id（li.item data-id），插件重载后页签重建
 *  换新 id——参与等价判定=每轮判「变了」必写盘，09-14 实测风暴 6h 11450 次重载；
 *  聚焦语义由 activeDocId（docId 口径，稳定）承载 */
export function sceneEquals(a: SceneSnapshot | null, b: SceneSnapshot | null): boolean {
    if (!a || !b) return false;
    return a.projectId === b.projectId
        && (a.activeDocId ?? null) === (b.activeDocId ?? null)
        && JSON.stringify(a.tabs) === JSON.stringify(b.tabs);
}
