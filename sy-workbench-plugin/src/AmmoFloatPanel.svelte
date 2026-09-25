<!-- ammo □9：弹药库悬浮窗外壳（学习番茄悬浮反链 BkFloatPanel——同构自包含改造版）。
     不跨插件 import 原件的理由：原件依赖 tomato icon/tomatoI18n（utils 大图拖入 project
     打包图+共享 CSS 跨插件互相压制的坑家族），project 自持一份（p/s/r 抄送副本先例）。
     position:fixed 单例挂 body；头栏=标题+工具区+透明度滑杆+收起钮；正文容器由宿主
     AmmoFloat.ts mount AmmoPanelHost；右下 SE 角 resize 手柄。拖拽/resize/几何/透明度
     localStorage 记忆。显隐走 hidden class 而非 {#if}：bodyEl 恒在，正文组件生命周期
     完全由宿主管（BkFloatPanel 同款——收起重开零重拉）。 -->
<script lang="ts">
    import { onMount } from "svelte";
    import type { Writable } from "svelte/store";

    interface Props {
        open: Writable<boolean>;
        /** 头栏标题（弹药库=常驻语义，宿主恒推 t.ammoTitle） */
        title: Writable<string>;
        onCollapse: () => void;
        /** 正文容器就绪回调（一次）：宿主往里 mount AmmoPanelHost */
        onBody: (el: HTMLElement) => void;
        /** 收起钮 tooltip 键位后缀（函数 prop 现求值——改键后随渲染刷新，BkFloat 同款） */
        panelKeyHint: () => string;
        /** 头栏工具区容器就绪回调（一次）：宿主塞回日历钮+同步飞书钮（graphfloat 同款） */
        onTools: (el: HTMLElement) => void;
        /** 几何落定回调（拖拽/resize/窗口 resize 后）——预留（无球让位需求，恒 no-op 也可不传） */
        onGeoChange?: () => void;
        /** 收起钮文案（t.ammoCollapse） */
        collapseLabel?: string;
        /** 透明度滑杆文案（t 系——aria-label） */
        opacityLabel?: string;
    }
    let { open, title, onCollapse, onBody, panelKeyHint, onTools, onGeoChange, collapseLabel = "收起", opacityLabel = "透明度" }: Props = $props();

    const LS_KEY = "pj-ammo-float-panel";
    /** 面板最小尺寸（BkFloatPanel MIN_W/MIN_H 同档）与默认宽高：四池两列+中央圈信息
     *  密度高于反链正文（520×420 档装不下四池 minmax(120px) 两行），取 640×560；
     *  默认落位右下角、离底 60px 让开状态栏 */
    const MIN_W = 360;
    const MIN_H = 300;
    const DEF_W = 640;
    const DEF_H = 560;
    const BOTTOM_CLEAR = 60;
    const EDGE = 24;
    /** 透明度下限即滑杆 min（0.40），上限 1.00 */
    const MIN_OPACITY = 0.4;

    let root: HTMLElement = $state();
    let opacity = $state(1);
    let x = 0;
    let y = 0;
    let w = DEF_W;
    let h = DEF_H;

    interface Geo {
        x: number;
        y: number;
        w: number;
        h: number;
        o: number;
    }

    function clampV(v: number, min: number, max: number) {
        return Math.max(min, Math.min(max, v));
    }

    function applyGeo() {
        if (!root) return;
        w = clampV(w, MIN_W, Math.max(MIN_W, window.innerWidth - 2 * EDGE));
        h = clampV(h, MIN_H, Math.max(MIN_H, window.innerHeight - BOTTOM_CLEAR - EDGE));
        // Math.max(0,..)：视口小于面板时退化为 0，避免负区间把位置锁死（DialogSvelte 同款）
        x = clampV(x, 0, Math.max(0, window.innerWidth - w));
        y = clampV(y, 0, Math.max(0, window.innerHeight - h));
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
        root.style.width = `${w}px`;
        root.style.height = `${h}px`;
        root.style.opacity = String(clampV(opacity, MIN_OPACITY, 1));
    }

    function loadGeo() {
        const fallback = () => {
            w = DEF_W;
            h = DEF_H;
            opacity = 1;
            x = Math.max(0, window.innerWidth - DEF_W - EDGE);
            y = Math.max(0, window.innerHeight - DEF_H - BOTTOM_CLEAR);
        };
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) {
                const p = JSON.parse(raw) as Partial<Geo>;
                w = Number(p?.w);
                h = Number(p?.h);
                x = Number(p?.x);
                y = Number(p?.y);
                const o = Number(p?.o);
                opacity = Number.isFinite(o) ? clampV(o, MIN_OPACITY, 1) : 1;
                if (![w, h, x, y].every(Number.isFinite)) fallback();
            } else {
                fallback();
            }
        } catch {
            fallback();
        }
        applyGeo();
    }

    function saveGeo() {
        try {
            const p: Geo = { x, y, w, h, o: opacity };
            localStorage.setItem(LS_KEY, JSON.stringify(p));
        } catch {
            /* 存储满/隐私模式：几何仅会话内生效 */
        }
    }

    // ---- 头栏拖动（DialogSvelte pointer 实现同族，BkFloatPanel 同款） ----
    let dragging = $state(false);
    let offX = 0;
    let offY = 0;

    /** 交互子元素早退：滑杆/按钮/工具区在头栏内，pointerdown 冒泡进拖拽会把 range
     *  拖动杀死+setPointerCapture 重定向后续事件（BkFloat 评审 P0 实锤同坑）。
     *  工具区整区早退——capture 会吞 span 形态钮的 click（同族坑） */
    function interactiveTarget(e: PointerEvent): boolean {
        return !!(e.target as HTMLElement)?.closest?.("input, button, select, textarea, .pj-ammo-float-panel__tools");
    }

    function dragDown(e: PointerEvent) {
        if (!root || e.button !== 0 || interactiveTarget(e)) return;
        e.stopPropagation();
        e.preventDefault();
        dragging = true;
        const rect = root.getBoundingClientRect();
        offX = e.clientX - rect.left;
        offY = e.clientY - rect.top;
        // capture 失败（指针已释放/合成事件无活动指针）不阻断拖拽监听挂载
        try {
            (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
        } catch { /* 事件流仍走 window 监听 */ }
        window.addEventListener("pointermove", dragMove);
        window.addEventListener("pointerup", dragUp);
        // 系统手势/窗口切换等打断（pointer 流被取消不保证 pointerup）：兜底收尾防 stuck-drag
        window.addEventListener("pointercancel", dragCancel);
    }

    function dragMove(e: PointerEvent) {
        if (!dragging || !root) return;
        if (e.pointerType === "touch") e.preventDefault();
        x = e.clientX - offX;
        y = e.clientY - offY;
        // 拖动只夹位置，尺寸不动
        x = clampV(x, 0, Math.max(0, window.innerWidth - w));
        y = clampV(y, 0, Math.max(0, window.innerHeight - h));
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
    }

    function dragUp(e: PointerEvent) {
        window.removeEventListener("pointermove", dragMove);
        window.removeEventListener("pointerup", dragUp);
        window.removeEventListener("pointercancel", dragCancel);
        try {
            (e.target as HTMLElement)?.releasePointerCapture?.(e.pointerId);
        } catch { /* 无捕获可释放 */ }
        if (!dragging) return;
        dragging = false;
        saveGeo();
        onGeoChange?.();
    }

    /** pointercancel 收尾：清理监听复位状态，不落盘（打断≠完成一次拖动） */
    function dragCancel() {
        window.removeEventListener("pointermove", dragMove);
        window.removeEventListener("pointerup", dragUp);
        window.removeEventListener("pointercancel", dragCancel);
        dragging = false;
        onGeoChange?.();
    }

    // ---- SE 角 resize（BkFloatPanel 同款单向） ----
    let resizing = false;
    let rsX = 0;
    let rsY = 0;
    let rsW = 0;
    let rsH = 0;

    function resizeDown(e: PointerEvent) {
        if (!root || e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        resizing = true;
        const rect = root.getBoundingClientRect();
        rsX = e.clientX;
        rsY = e.clientY;
        rsW = rect.width;
        rsH = rect.height;
        try {
            (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
        } catch { /* 事件流仍走 window 监听 */ }
        window.addEventListener("pointermove", resizeMove);
        window.addEventListener("pointerup", resizeUp);
        window.addEventListener("pointercancel", resizeCancel);
    }

    function resizeMove(e: PointerEvent) {
        if (!resizing || !root) return;
        if (e.pointerType === "touch") e.preventDefault();
        w = clampV(rsW + (e.clientX - rsX), MIN_W, Math.max(MIN_W, window.innerWidth - x));
        h = clampV(rsH + (e.clientY - rsY), MIN_H, Math.max(MIN_H, window.innerHeight - y));
        root.style.width = `${w}px`;
        root.style.height = `${h}px`;
    }

    function resizeUp(e: PointerEvent) {
        window.removeEventListener("pointermove", resizeMove);
        window.removeEventListener("pointerup", resizeUp);
        window.removeEventListener("pointercancel", resizeCancel);
        try {
            (e.target as HTMLElement)?.releasePointerCapture?.(e.pointerId);
        } catch { /* 无捕获可释放 */ }
        if (!resizing) return;
        resizing = false;
        saveGeo();
        onGeoChange?.();
    }

    /** pointercancel 收尾：清理监听复位状态，不落盘（几何可能已变，补回调） */
    function resizeCancel() {
        window.removeEventListener("pointermove", resizeMove);
        window.removeEventListener("pointerup", resizeUp);
        window.removeEventListener("pointercancel", resizeCancel);
        resizing = false;
        onGeoChange?.();
    }

    // ---- 透明度滑杆：input 跟手只改内存+style，change（松手/键盘步进提交）才落盘 ----
    function onOpacityInput(el: HTMLInputElement) {
        const v = Number(el.value) / 100;
        opacity = clampV(v, MIN_OPACITY, 1);
        if (root) root.style.opacity = String(opacity);
    }

    function onOpacityChange() {
        saveGeo();
    }

    onMount(() => {
        loadGeo();
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
            window.removeEventListener("pointermove", dragMove);
            window.removeEventListener("pointerup", dragUp);
            window.removeEventListener("pointercancel", dragCancel);
            window.removeEventListener("pointermove", resizeMove);
            window.removeEventListener("pointerup", resizeUp);
            window.removeEventListener("pointercancel", resizeCancel);
        };
    });

    function onResize() {
        applyGeo();
        onGeoChange?.();
    }

    // 正文/工具区容器就绪上报：use: action 在元素挂载时同步调用（BkFloatPanel 原版为
    // bind:this+$effect——实测同构两 effect onBody 触发而 onTools 静默不触发，时序歧义
    // 不可赌，换 action 确定性机制；语义等价=挂载即上报一次，hidden class 翻转不重跑）
    function reportBody(el: HTMLElement) {
        onBody(el);
    }
    function reportTools(el: HTMLElement) {
        onTools?.(el);
    }
</script>

<div bind:this={root} class="pj-ammo-float-panel" class:hidden={!$open}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header class="pj-ammo-float-panel__head" onpointerdown={dragDown}>
        <span class="pj-ammo-float-panel__title" title={$title}>{$title}</span>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span class="pj-ammo-float-panel__tools" use:reportTools></span>
        <input
            class="b3-slider pj-ammo-float-panel__opacity"
            type="range"
            min="40"
            max="100"
            step="5"
            value={opacity * 100}
            aria-label={opacityLabel}
            oninput={(e) => onOpacityInput(e.currentTarget)}
            onchange={onOpacityChange}
        />
        <button
            class="pj-ammo-float-panel__btn b3-tooltips b3-tooltips__n"
            aria-label={`${collapseLabel} ${panelKeyHint()}`}
            onclick={(e) => {
                e.stopPropagation();
                onCollapse();
            }}
        ><svg><use xlink:href="#iconDown"></use></svg></button>
    </header>
    <div class="pj-ammo-float-panel__body" use:reportBody></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="pj-ammo-float-panel__resizer"
        onpointerdown={resizeDown}
        aria-label="resize"
    ></div>
</div>

<style>
    .pj-ammo-float-panel {
        position: fixed;
        /* 10 = 浮层安全档：压过编辑器内容，恒低于内核弹层（菜单/对话框 z11+）（AGENTS 坑） */
        z-index: 10;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        overflow: hidden;
        background: var(--b3-theme-background);
        border: 1px solid var(--b3-border-color);
        border-radius: 8px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
        min-width: 360px;
        min-height: 300px;
        /* 半透明档（透明度 0.4~1.0）下层文字与卡面文字交叠不可读：透出内容模糊化 */
        backdrop-filter: blur(10px);
    }
    .pj-ammo-float-panel.hidden {
        display: none;
    }
    .pj-ammo-float-panel__head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px 6px 12px;
        border-bottom: 1px solid var(--b3-border-color);
        background: var(--b3-theme-background);
        cursor: move;
        user-select: none;
        touch-action: none;
        flex-shrink: 0;
    }
    .pj-ammo-float-panel__title {
        flex: 1;
        min-width: 0;
        font-size: 13px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    /* 头栏工具区（回日历+同步飞书）：flex 收缩保护+钮间距；内部钮形态由宿主自带，
       容器只管布局（BkFloatPanel 工具区同款）。拖拽 interactiveTarget 按此类名整区早退 */
    .pj-ammo-float-panel__tools {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 2px;
    }

    /* 同步胶囊（运行时 mount 进工具区，:global 出条约；button 抬特异性压组件 scoped 同分）：
       组件自带 max-width:42% 收缩帽以本容器（content-sized）为解析基准=帽值 46px 反成绞索，
       「已同步」被裁剩首字残形（09-25 主实例实锤）——悬浮窗头栏让位由 title(flex:1+省略号)
       承担，胶囊恒自然宽；收缩帽只留给 dock 宽头栏场景 */
    .pj-ammo-float-panel__tools :global(button.pj-live-sync) {
        max-width: none;
    }
    .pj-ammo-float-panel__opacity {
        flex-shrink: 0;
        width: 88px;
        height: 16px;
    }
    .pj-ammo-float-panel__btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--b3-theme-on-background);
        cursor: pointer;
        transition: background-color 0.2s;
    }
    .pj-ammo-float-panel__btn:hover {
        background-color: var(--b3-list-hover, rgba(0, 0, 0, 0.075));
    }
    .pj-ammo-float-panel__btn :global(svg) {
        width: 14px;
        height: 14px;
        pointer-events: none;
    }
    /* 回日历钮（宿主 AmmoFloat 运行时 createElement 挂进工具区——scoped CSS 剪不到运行时
       挂的类，:global 出条约；形态对齐本壳收起钮） */
    .pj-ammo-float-panel :global(.pj-ammo-float-cal) {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--b3-theme-on-background);
        cursor: pointer;
        transition: background-color 0.2s;
    }
    .pj-ammo-float-panel :global(.pj-ammo-float-cal:hover) {
        background-color: var(--b3-list-hover, rgba(0, 0, 0, 0.075));
    }
    .pj-ammo-float-panel :global(.pj-ammo-float-cal svg) {
        width: 14px;
        height: 14px;
        pointer-events: none;
    }
    /* 正文容器：去 padding（.pj-ammo 面板组件自带 8px 10px 内距——双层 padding 叠加难看，
       bare 语义）；overflow hidden+面板组件自身滚动 */
    .pj-ammo-float-panel__body {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }
    .pj-ammo-float-panel__body > :global(.pj-ammo) {
        flex: 1;
        min-height: 0;
    }
    .pj-ammo-float-panel__resizer {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        touch-action: none;
        z-index: 2;
        /* 斜纹 grip：常显低对比可发现，hover 增强（BkFloat 评审 P2-9 同款） */
        background-image: repeating-linear-gradient(
            -45deg,
            transparent 0 4px,
            var(--b3-border-color) 4px 5px
        );
        border-radius: 0 0 7px 0;
        opacity: 0.55;
        transition: opacity 0.15s;
    }
    .pj-ammo-float-panel__resizer:hover {
        opacity: 1;
        background-image: repeating-linear-gradient(
            -45deg,
            transparent 0 4px,
            var(--b3-theme-on-surface-light, var(--b3-border-color)) 4px 5px
        );
    }
</style>
