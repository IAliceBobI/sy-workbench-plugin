// remind □1：popover 面板工厂（宿主挂 body、外点/Esc 关闭）+前端→kernel 同步触发。
// timeblock ⑥：定位从锚点贴靠改视口居中（bear 二轮拍板——图标在块 attr 行右缘，贴靠形态
// 系统性偏右；居中走 entryCore.centerInViewport 纯函数，钳边距防小视口越界）。
// Svelte 5 mount/unmount 正轨（销毁必 unmount）；单例（已开先关——右键菜单路径 close 后 click 也走这里）。
import { mount, unmount } from "svelte";
import RemindPanel from "./RemindPanel.svelte";
import { REMIND_SYNC_METHOD } from "../shared/channels";
import { debugLog } from "../libs/debugLog";
import { centerInViewport } from "./entryCore";

let openState: { host: HTMLElement; instance: Record<string, any>; close: () => void } | null = null;

export interface RemindPanelOpts {
    blockId: string;
    /** 既有提醒（YYYY-MM-DDTHH:mm）；空=新设 */
    initial?: string;
    /** 既有循环规则（daily / weekly:1,3 / monthly:15 / every:3d）；空=不重复 */
    initialRepeat?: string;
    /** 既有结束时间（□16 YYYY-MM-DDTHH:mm）；空=开放时长 */
    initialEnd?: string;
    t: Record<string, string>;
    onSaved: (at: string, repeat: string | null, end: string | null) => void;
    onDeleted: () => void;
}

/** 关已开面板（幂等） */
export function closeRemindPanel(): void {
    if (!openState) return;
    openState.close();
}

export function openRemindPanel(opts: RemindPanelOpts): void {
    closeRemindPanel();
    const host = document.createElement("div");
    host.className = "pj-remind-popover";
    host.style.visibility = "hidden"; // 首帧跳位防御（vision P2-1）：定位完成前不占视（fixed 无坐标会闪现文档流位置）

    const instance = mount(RemindPanel, {
        target: host,
        props: {
            initial: opts.initial ?? "",
            initialRepeat: opts.initialRepeat ?? "",
            initialEnd: opts.initialEnd ?? "",
            t: opts.t,
            onSaved: (at: string, repeat: string | null, end: string | null) => {
                closeRemindPanel();
                opts.onSaved(at, repeat, end);
            },
            onDeleted: () => {
                closeRemindPanel();
                opts.onDeleted();
            },
        },
    }) as Record<string, any>;

    document.body.appendChild(host);
    // 定位（⑥）：视口居中（首帧 hidden 跳位防御保留——测量后落位再显形）
    requestAnimationFrame(() => {
        const r = host.getBoundingClientRect();
        const pos = centerInViewport(window.innerWidth, window.innerHeight, r.width, r.height);
        host.style.left = `${pos.left}px`;
        host.style.top = `${pos.top}px`;
        host.style.visibility = "";
    });

    const onDocDown = (e: MouseEvent) => {
        if (!host.contains(e.target as Node)) closeRemindPanel();
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") closeRemindPanel();
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
    debugLog("remind", `panel open block=${opts.blockId} initial=${opts.initial ?? "-"}`);
}

/** 前端→kernel：触发块提醒飞书同步（notify=通知不等回执；kernel 侧 guarded 合并抖动） */
export function triggerRemindSync(plugin: { kernel?: unknown }): void {
    const rpc = (plugin.kernel as Record<string, any> | undefined)?.rpc;
    if (!rpc?.notify) {
        debugLog("remind", "!! kernel.rpc.notify unavailable, sync deferred to next onrunning");
        return;
    }
    try {
        rpc.notify[REMIND_SYNC_METHOD]();
        debugLog("remind", "remind-sync notified");
    } catch (e) {
        debugLog("remind", `!! remind-sync notify failed: ${String(e)}`);
    }
}
