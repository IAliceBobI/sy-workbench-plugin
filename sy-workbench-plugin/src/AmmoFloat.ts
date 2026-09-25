// ammo □9：弹药库悬浮窗宿主（□6 面板组件的悬浮窗形态挂载点——「交付形态=悬浮窗外壳，
// Dialog 为开发期临时宿主」□6 注）。外壳=AmmoFloatPanel（BkFloatPanel 同构自包含改造）；
// 正文=mount AmmoPanelHost（□6 数据宿主——rpc 调用/pj-ammo-state 订阅全在其内，零改动）；
// 头栏工具区=回日历钮+实况同步钮（AmmoLiveSyncButton——dock 时间线/时间线页签同款组件，
// 三宿主同一引擎同一状态源，□9 契约勿做第二套）。
// 开关入口=官方 addCommand（index.ts 注册，langKey=openAmmo 沿用 □6 命令——callback 从
// Dialog 改悬浮窗 toggle；默认键 ⌥⇧⌘A（规范序——□3 翻案："⌘⌥⇧A" 是 matchHotKey 死键串，
// 物理组合不变）。物理等价查重：官方 constants.ts 三修饰段无 A、四仓 winHotkey 三修饰已占
// B/E/F/G/M/O/S/Q/6）。
// 生命周期（BkFloat 收起模式）：收起=unmount 正文+工具区组件（停 AmmoPanelHost 30s 分钟针）
// 再翻 open store；重开=重挂+首拉（rpc 单发成本≈0，不保挂）。
// 联动链（□9 验收项）：悬浮窗开始/停止→AmmoPanelHost→kernel ammo-start/stop→引擎广播
// AMMO_STATE_CHANNEL→index.ts 转 window「pj-ammo-state」→dock 时间线 refresh——内存事件链，
// 本类零额外代码（□7 已接好两端）。
import { mount, unmount } from "svelte";
import { writable } from "svelte/store";
import AmmoFloatPanel from "./AmmoFloatPanel.svelte";
import AmmoPanelHost from "./AmmoPanelHost.svelte";
import AmmoLiveSyncButton from "./AmmoLiveSyncButton.svelte";
import { debugLog } from "./libs/debugLog";

/** 开合记忆（全局一份；几何/透明度在外壳组件内自带 LS=pj-ammo-float-panel） */
const LS_OPEN = "pj-ammo-float-open";

const sleepAmmo = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface AmmoFloatDeps {
    /** i18n 文案包（ammo 族+ammoFloat 族键——zh/en 双语由宿主注入） */
    t: Record<string, string>;
    /** 插件 kernel rpc 面（Plugin 实例 this.kernel.rpc；缺=面板只读空态+同步钮隐藏） */
    rpc: { call: Record<string, (p?: any) => Promise<any>> } | null;
    /** 回日历=激活日历 dock 页签（plugin.openCalendar——openTab custom 已开聚焦复用通道） */
    onOpenCalendar: () => void;
    /** 体检条目跳转（dataview □8——plugin.openDocNoFocus：cb-get-hl 禁聚焦政策；缺=纯文本行） */
    onOpenBlock?: (blockId: string) => void;
    /** 头栏跳每日配置月文档（mainfix0923 □5——plugin.openDayConfigDoc：定位不到=toast 不懒建；缺=钮不出） */
    onOpenDayConfig?: () => void;
    /** 头栏跳当日日记（mainfix0923 □5——plugin.openTodayDiary：定位不到=toast 不懒建；缺=钮不出） */
    onOpenDiary?: () => void;
}

/** 收起钮 tooltip 键位后缀：现读 keymap（改键跟随；BkFloat panelKeyHint 同款语义）。
 *  project 无 winHotkey helper（tomato libs 不跨插件拖图）——单命令 mini 版。
 *  □3 三态：custom="⌥⇧⌘A"（或用户改的键）→ 原样返回；custom=""（用户在设置页清空=禁用）
 *  → 返回空串（调用方截断键位段——内核 matchHotKey 空串恒 false，显示默认键反而误导）；
 *  keymap 未就绪/条目缺 → 兜底默认键 */
export function ammoFloatKeycap(): string {
    try {
        const custom = (window as any).siyuan?.config?.keymap?.plugin?.["sy-workbench-plugin"]?.openAmmo?.custom;
        if (typeof custom === "string") return custom;
    } catch { /* keymap 未就绪=落默认 */ }
    return "⌥⇧⌘A";
}

export class AmmoFloatBox {
    private deps: AmmoFloatDeps;
    /** 代际闸：unload 后 in-flight async（onTools 容器就绪回调归来）一律早退 */
    private alive = false;

    private panelHost: HTMLElement | null = null;
    private panelSv: ReturnType<typeof mount> | null = null;
    private hostSv: ReturnType<typeof mount> | null = null;
    private syncSv: ReturnType<typeof mount> | null = null;
    private calBtn: HTMLButtonElement | null = null;

    private panelOpen = false;
    private panelOpenStore = writable(false);
    private titleStore = writable("");
    private panelBodyEl: HTMLElement | null = null;

    constructor(deps: AmmoFloatDeps) {
        this.deps = deps;
    }

    onload(): void {
        this.alive = true;
        this.titleStore.set(this.deps.t.ammoTitle ?? "弹药库");
        this.panelHost = document.body.appendChild(document.createElement("div"));
        this.panelSv = mount(AmmoFloatPanel, {
            target: this.panelHost,
            props: {
                open: this.panelOpenStore,
                title: this.titleStore,
                collapseLabel: this.deps.t.ammoFloatCollapse ?? "收起",
                opacityLabel: this.deps.t.ammoFloatOpacity ?? "透明度",
                onCollapse: () => this.closePanel(),
                panelKeyHint: () => ammoFloatKeycap(),
                onBody: (el: HTMLElement) => {
                    this.panelBodyEl = el;
                },
                onTools: (el: HTMLElement) => {
                    this.mountTools(el);
                },
            },
        });
        // reload 恢复 Wish：开合记忆 onload 读档（BkFloat/graphfloat 同款）——首拉由正文
        // mount 自带；无 protyle 依赖（全局面非文档面），可直接开不必等事件
        if (localStorage.getItem(LS_OPEN) === "1") this.openPanel();
        debugLog("ammo", `float onload open=${this.panelOpen}`);
    }

    togglePanel(): void {
        if (this.panelOpen) this.closePanel();
        else this.openPanel();
    }

    openPanel(): void {
        if (!this.alive || this.panelOpen) return;
        this.panelOpen = true;
        this.panelOpenStore.set(true);
        try {
            localStorage.setItem(LS_OPEN, "1");
        } catch { /* 会话内生效 */ }
        void this.mountContent();
    }

    /** persist=false：插件 unload/reload 的收尾不落盘（重载不该重置用户开合记忆） */
    closePanel(persist = true): void {
        if (!this.panelOpen) return;
        // 先卸正文与工具区组件（停其 interval/订阅），再收壳——顺序不可倒（BkFloat 同款）
        this.unmountContent();
        this.panelOpen = false;
        this.panelOpenStore.set(false);
        if (persist) {
            try {
                localStorage.setItem(LS_OPEN, "0");
            } catch { /* 会话内生效 */ }
        }
        debugLog("ammo", "float close");
    }

    /** 正文挂载（展开/重开）：AmmoPanelHost 自带首拉+pj-ammo-state 订阅+30s 分钟针；
     *  重挂=全新生命周期（收起期间无后台开销）。⚠️工具区不在此卸——外壳 use: action
     *  在外壳 mount 时已挂一次且不会重挂，收起若拆则重开无入口（首版在此拆工具区=
     *  MutationObserver 实锤的「toggle 后钮消失」根因）。
     *  ⚠️panelBodyEl 就绪等待（graphfloat mountGraph 同款轮询）：use: action 晚于外壳
     *  mount() 返回执行（effect 批次 flush）——onload 读档自动开路径 mountContent 同步
     *  跑时 bodyEl 尚未上报，须等（首版早退=恢复 Wish 正文空根因） */
    private async mountContent(): Promise<void> {
        this.unmountContent();
        for (let i = 0; i < 40 && !this.panelBodyEl; i++) await sleepAmmo(25);
        if (!this.alive || !this.panelOpen || !this.panelBodyEl) return;
        this.hostSv = mount(AmmoPanelHost, {
            target: this.panelBodyEl,
            props: {
                t: this.deps.t,
                rpc: this.deps.rpc,
                openBlock: this.deps.onOpenBlock,
                onOpenDayConfig: this.deps.onOpenDayConfig,
                onOpenDiary: this.deps.onOpenDiary,
            },
        });
    }

    /** 头栏工具区：回日历钮（思源 symbol 图标——project 零 lucide 依赖）+实况同步钮
     *  （AmmoLiveSyncButton mount，与 dock 时间线头部同款同引擎）；工具区在头栏拖拽
     *  interactiveTarget 早退面内（外壳按 .pj-ammo-float-panel__tools 类名），内部
     *  点击不触发拖拽/不被 capture 吞 click */
    private mountTools(toolsEl: HTMLElement): void {
        if (!this.alive) return;
        try {
            const btn = document.createElement("button");
            btn.className = "pj-ammo-float-cal";
            btn.title = this.deps.t.ammoFloatGoCalendar ?? "回日历";
            btn.setAttribute("aria-label", this.deps.t.ammoFloatGoCalendar ?? "回日历");
            btn.innerHTML = '<svg><use xlink:href="#iconCalendar"></use></svg>';
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.deps.onOpenCalendar();
            });
            toolsEl.appendChild(btn);
            this.calBtn = btn;
            this.syncSv = mount(AmmoLiveSyncButton, {
                target: toolsEl,
                props: {
                    t: this.deps.t,
                    rpc: this.deps.rpc,
                },
            }) as any;
            debugLog("ammo", "float tools mounted");
        } catch (e) {
            debugLog("ammo", `!! mountTools failed: ${String(e)}`);
        }
    }

    /** 只卸正文（收起/重挂共用）——工具区生命周期=外壳共存，拆御走 unmountTools */
    private unmountContent(): void {
        if (this.hostSv) {
            unmount(this.hostSv);
            this.hostSv = null;
        }
    }

    /** 工具区拆卸（仅插件 unload）：同步钮组件+回日历钮 */
    private unmountTools(): void {
        if (this.syncSv) {
            unmount(this.syncSv);
            this.syncSv = null;
        }
        if (this.calBtn) {
            this.calBtn.remove();
            this.calBtn = null;
        }
    }

    unload(): void {
        this.alive = false;
        this.closePanel(false); // 插件 reload 非用户动作：不落盘开合记忆
        this.unmountContent();
        this.unmountTools();
        if (this.panelSv) {
            unmount(this.panelSv);
            this.panelSv = null;
        }
        this.panelHost?.remove();
        this.panelHost = null;
        this.panelBodyEl = null;
    }
}
