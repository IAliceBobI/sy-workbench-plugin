// 任务徽标「更多…」属性 popover 工厂（panel.ts 同骨架：宿主挂 body、外点/Esc 关闭、
// 单例已开先关、Svelte 5 mount/unmount 正轨；视口居中定位——centerInViewport 钳边距，
// remind ⑥ 同拍板「贴靠系统性偏右改居中」）。onSaved 先关面板再回调（写链在注入器侧）。
import { mount, unmount } from "svelte";
import TaskPropsPanel from "./TaskPropsPanel.svelte";
import type { TaskPropsFields } from "../gui/taskBadgeMenu";
import { centerInViewport } from "./entryCore";
import { debugLog } from "../libs/debugLog";

let openState: { host: HTMLElement; instance: Record<string, any>; close: () => void } | null = null;

export interface TaskPropsPanelOpts {
    blockId: string;
    initial: TaskPropsFields;
    t: Record<string, string>;
    onSaved: (fields: TaskPropsFields) => void;
}

/** 关已开面板（幂等） */
export function closeTaskPropsPanel(): void {
    if (!openState) return;
    openState.close();
}

export function openTaskPropsPanel(opts: TaskPropsPanelOpts): void {
    closeTaskPropsPanel();
    const host = document.createElement("div");
    host.className = "pj-remind-popover"; // popover 外壳同款（fixed/z1000/surface/阴影——remind.css）
    host.style.visibility = "hidden"; // 首帧跳位防御（panel.ts 同款：定位完成前不占视）

    const instance = mount(TaskPropsPanel, {
        target: host,
        props: {
            initial: opts.initial,
            t: opts.t,
            onSaved: (fields: TaskPropsFields) => {
                closeTaskPropsPanel();
                opts.onSaved(fields);
            },
        },
    }) as Record<string, any>;

    document.body.appendChild(host);
    requestAnimationFrame(() => {
        const r = host.getBoundingClientRect();
        const pos = centerInViewport(window.innerWidth, window.innerHeight, r.width, r.height);
        host.style.left = `${pos.left}px`;
        host.style.top = `${pos.top}px`;
        host.style.visibility = "";
    });

    const onDocDown = (e: MouseEvent) => {
        if (!host.contains(e.target as Node)) closeTaskPropsPanel();
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") closeTaskPropsPanel();
    };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);

    openState = {
        host,
        instance,
        close: () => {
            document.removeEventListener("mousedown", onDocDown, true);
            document.removeEventListener("keydown", onKey, true);
            openState = null;
            unmount(instance);
            host.remove();
        },
    };
    debugLog("taskbadge", `props panel open block=${opts.blockId} initial=${JSON.stringify(opts.initial)}`);
}
