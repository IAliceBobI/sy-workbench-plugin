import { openTab, type TProtyleAction } from "siyuan";
import type { ReplayStep } from "@/kernel/core/scene";

// 恢复执行器：replayPlan 步骤 → openTab 调用（本文件是场景链唯一 siyuan API 触碰层，可整替 mock）。
// P0 结论：keepCursor:true=后台开不抢焦点；恢复收尾须让目标页签成为焦点——
// 非聚焦步骤全部 keepCursor，聚焦步骤默认开（切到该页签）；focusBlockId 再走
// cb-get-hl（只滚动定位不落光标——bear 09-15 拍板全插件禁聚焦：聚焦光标让用户
// 觉得进错文档，且曾疑触发末行点击大刷新；pjux □12 实证该刷新根因是脏索引
// 事务失败，聚焦仍按政策禁用）。

/** 禁聚焦导航组合（openDocNoFocus/actionsRunner 共用，单一事实源防漂移）：
 *  cb-get-context 必带——缺它 Editor.getDoc mode 0「仅当前 ID」只加载目标块=
 *  聚焦形态（09-16 □13 实锤）；cb-get-hl 滚动定位不落光标 */
export const OPEN_NO_FOCUS_ACTION: TProtyleAction[] = ["cb-get-context", "cb-get-hl"];
export async function replaySteps(
    app: any,
    steps: ReplayStep[],
    focusStepIndex?: number,
): Promise<{ opened: number; focusDocId?: string; focusBlockId?: string }> {
    const focusIdx = focusStepIndex !== undefined ? focusStepIndex : steps.length - 1;
    let opened = 0;
    let focusDocId: string | undefined;
    let focusBlockId: string | undefined;
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const isFocus = i === focusIdx;
        await openTab({
            app,
            doc: {
                id: s.docId,
                // zoomIn 存档分支现不可达（captureScene 从不写 zoomIn），保留语义位：
                // 将来接上时须重审两雷——getUnInitTab 会把 action 强换 [cb-get-all,
                // cb-get-focus]（cb-get-focus 违禁聚焦政策）+ 下方 locate 的 mode 3
                // 重取会把刚还原的聚焦视角顶回全文
                ...(s.zoomIn ? { zoomIn: true } : {}),
            },
            keepCursor: !isFocus,
        });
        opened++;
        if (isFocus) {
            focusDocId = s.docId;
            if (s.focusBlockId) {
                focusBlockId = s.focusBlockId;
                await openTab({
                    app,
                    // OPEN_NO_FOCUS_ACTION：块不在懒加载窗口时 switchEditor 复用路径同走
                    // getDoc mode 0，缺 context 必中招（□13 根因）
                    doc: { id: s.focusBlockId, action: OPEN_NO_FOCUS_ACTION },
                });
            }
        }
    }
    return { opened, focusDocId, focusBlockId };
}
