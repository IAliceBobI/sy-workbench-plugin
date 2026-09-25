// 顶栏切换器（接线层）：按钮 DOM 构造+官方 Menu 弹出+菜单内搜索。纯逻辑（items 组装/过滤谓词）在 queries.ts。

import { Menu } from "siyuan";
import { escapeHtml } from "./fe";
import { buildProjectMenuItems, switcherFilter, type ProjectRow, type SwitcherItem } from "./queries";

/** 官方顶栏按钮结构上塞「图标+项目名」（项目名超长 ellipsis，switcher.css 控制） */
export function renderSwitcherLabel(button: HTMLElement, projectName: string | null): void {
    const name = projectName?.trim();
    button.innerHTML =
        `<svg><use xlink:href="#iconWorkspace"></use></svg>`
        + (name
            ? `<span class="pj-switcher__name">${escapeHtml(name)}</span>`
            : `<span class="pj-switcher__name pj-switcher__name--empty">${escapeHtml("项目")}</span>`);
}

function toMenuItem(item: SwitcherItem) {
    if (item.kind === "separator") return { type: "separator" } as const;
    if (item.kind === "search") {
        return { type: "readonly", label: `<input class="pj-switcher__search" placeholder="${escapeHtml(item.placeholder)}" />` };
    }
    if (item.kind === "emptyNote") {
        return { type: "readonly", label: `<span class="pj-switcher__empty">${escapeHtml(item.label)}</span>` };
    }
    if (item.kind === "createProject") {
        return { icon: "iconAdd", label: escapeHtml(item.label), click: item.click };
    }
    return { icon: "iconFolder", label: escapeHtml(item.label), current: item.current, click: item.click };
}

export function showSwitcherMenu(e: MouseEvent, input: {
    projects: ProjectRow[];
    activeId: string | null;
    texts?: { searchPh?: string; emptyNote?: string };
    handlers: {
        onPick: (id: string) => void;
        onCreateProject?: () => void;
    };
}): void {
    // independent 菜单阻断冒泡 → 官方全局 click 收不到 → 顶栏 tooltip 残留压住菜单首项（vision P0-1）
    // ⚠只藏不删：#tooltip 是内核启动时建一次的全局单例，remove 后无人重建——内核
    //   showTooltip/hideTooltip 全线 getElementById("tooltip") 得 null → 全窗口 null 风暴
    //   +文档渲染链炸断（09-13 主文档转圈事故根因，Loki errbridge 桥抓现行）。
    //   藏 fn__none=内核 hideTooltip 同款语义，视觉与布局等效消失。
    document.getElementById("tooltip")?.classList.add("fn__none");
    // independent 第三参（d.ts 只声明两参）：防本次 click 冒泡到 window 被全局监听 remove 单例菜单
    const menu = new (Menu as any)("pj-switcher", undefined, true) as Menu;
    const items = buildProjectMenuItems({
        projects: input.projects,
        activeId: input.activeId,
        onPick: input.handlers.onPick,
        onCreateProject: input.handlers.onCreateProject,
        texts: input.texts,
    });
    for (const item of items) {
        menu.addItem(toMenuItem(item) as any);
    }
    const anchor = e.currentTarget instanceof HTMLElement ? e.currentTarget : e.target;
    const rect = anchor instanceof HTMLElement
        ? anchor.getBoundingClientRect()
        : { right: e.clientX, bottom: e.clientY } as DOMRect;
    menu.open({ x: rect.right, y: rect.bottom, isLeft: true });
    wireSwitcherFilter(menu, items);
}

/** 菜单内搜索：DOM 层显隐过滤（官方 Menu 无受控重绘通道，重开闪——纯显隐零重开）。
 *  项目行按渲染序回填 data-pj-name（官方 addItem 不透传 data 属性）；无 data-pj-name 的行
 *  （分隔/空提示/搜索自身）在过滤非空时一并藏。input keydown stopPropagation 防菜单键盘导航抢键。 */
function wireSwitcherFilter(menu: Menu, items: SwitcherItem[]): void {
    const root = (menu as any).element as HTMLElement | undefined;
    if (!root) return;
    const input = root.querySelector<HTMLInputElement>("input.pj-switcher__search");
    if (!input) return;
    input.addEventListener("keydown", (e) => e.stopPropagation());
    const rows = [...root.querySelectorAll<HTMLElement>(".b3-menu__item")];
    rows.forEach((el, i) => {
        const item = items[i];
        if (item?.kind === "project") el.dataset.pjName = item.label;
    });
    input.addEventListener("input", () => {
        const q = input.value.trim();
        rows.forEach((el) => {
            if (el.contains(input)) return; // 搜索行恒显
            const name = el.dataset.pjName;
            el.classList.toggle("fn__none", name === undefined ? !!q : !switcherFilter(name, q));
        });
    });
}
