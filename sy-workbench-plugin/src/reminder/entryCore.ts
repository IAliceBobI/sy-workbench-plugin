// timeblock 期 2 ⑥ 入口增强纯函数层（零 svelte/DOM 依赖——单测直测）：
// ①centerInViewport=加时间面板视口居中定位（bear 二轮拍板「从贴右改视口居中」）；
// ②pickBlockIconEntry=块柄菜单入口守卫（块柄 gutter 菜单的官方插件挂点是 click-blockicon
//   事件——open-menu-blockbtn 在 3.8.4 与 master 均不存在〔运行时 bundle grep=0+GitHub 代码
//   搜索 0 命中〕，块柄单击/右键同走 renderMenu 尾部 emit，detail.blockElements 选中块集）。

/** 视口居中（⑥c）：返回 fixed 定位 left/top；面板超视口时钳到边距不越界 */
export function centerInViewport(vw: number, vh: number, w: number, h: number, margin = 12): { left: number; top: number } {
    const left = Math.max(margin, Math.floor((vw - w) / 2));
    const top = Math.max(margin, Math.floor((vh - h) / 2));
    return { left, top };
}

/** click-blockicon detail 守卫：恰一块且有块 id 才给「设提醒」项（多选块面板无从落锚；无 id 形态防御） */
export function pickBlockIconEntry(detail: unknown): { blockId: string } | null {
    const d = detail as { blockElements?: unknown } | null;
    if (!d || !Array.isArray(d.blockElements) || d.blockElements.length !== 1) return null;
    const el = d.blockElements[0] as HTMLElement | null;
    const blockId = el?.getAttribute?.("data-node-id");
    if (!blockId) return null;
    return { blockId };
}

/** ⌥⇧⌘T 的平台显示形态（darwin=符号形态；其余=Ctrl+Alt+Shift+T——官方菜单 accelerator 同款语义。
 *  node 测试环境无 window，防御性回落 win 形态） */
export function setRemindHotkeyLabel(): string {
    const os = typeof window === "undefined" ? "" : String((window as any).siyuan?.config?.system?.os ?? "");
    return os.toLowerCase().includes("darwin") ? "⌥⇧⌘T" : "Ctrl+Alt+Shift+T";
}
