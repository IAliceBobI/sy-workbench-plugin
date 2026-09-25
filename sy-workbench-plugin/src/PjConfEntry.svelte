<script lang="ts">
    // 设置双栏 pjux □2「命令与入口」页：project 全部命令/菜单入口集中管理——每项开关
    // （petal entry-toggles.json）+命令项键帽（tomato HotkeyCap 跨插件复用，点击监听改键
    // 免 reload 写回内核 keymap）。行形态=开关+名称+键帽一行（设置控件紧凑惯例，bear 偏好）。
    // 生效语义：右键/slash 开关即时；命令开关=存盘+收面板+重载插件（lead 文案说明）。
    // 无页标题（导航短标签即语义，聚合态也不与界标重复）。
    // ammoentry □3：全部带键命令键帽可改（openAmmo 命令行+时间线 dock 行新增；HotkeyCap
    // 写回协议=深拷贝 keymap→POST setKeymap→内存替换→command.customHotkey 同步，免 reload
    // 即时生效——keydown 分发实时读 customHotkey）。
    import HotkeyCap from "../../sy-tomato-plugin/src/HotkeyCap.svelte";
    import { tomatoI18n } from "../../sy-tomato-plugin/src/tomatoI18n";

    let {
        t,
        getToggles,
        setToggle,
    }: {
        t: Record<string, string>;
        getToggles: () => Record<string, boolean>;
        setToggle: (key: string, on: boolean) => Promise<boolean>;
    } = $props();

    // 面板本地镜像（父不活推；命令开关落盘即收面板重载，无跨组件同步需求）
    // svelte-ignore state_referenced_locally
    let toggles = $state<Record<string, boolean>>(getToggles());

    async function flip(key: string, on: boolean): Promise<void> {
        toggles = { ...toggles, [key]: on }; // 先反馈后落盘（命令开关落盘即收面板重载，无回读窗口）
        const ok = await setToggle(key, on);
        if (!ok) toggles = getToggles(); // 落盘失败回滚镜像（开关视觉回弹，review P1）
    }

    // hk 对象本地构造：tomato winHotkey 工厂 m="" 会 throw、且其 w() 兜底链只扫 t/p/s/r
    // 四家命名空间（project 不在列）。HotkeyCap 契约={m, w(), langKey}；HotkeyCap readDisplay
    // 在 keymap 条目缺（currentCustom===undefined）时回落 w()，custom 存在时自行 capDisplay
    // （空串=用户清空=「未设置」占位，与内核 matchHotKey 空串恒 false 的禁用语义一致）。
    // w() 只承担「无条目」兜底：有默认键命令显示默认串，无默认键显示未设置。
    const PLUGIN = "sy-workbench-plugin";
    const hkOf = (langKey: string, def?: string) => ({
        m: "",
        langKey,
        w: () => def ?? tomatoI18n.未设置快捷键,
    });
    const hkSaveScene = hkOf("saveScene");
    const hkSetRemind = hkOf("setRemind");
    const hkOpenTimeline = hkOf("openTimeline");
    const hkOpenAmmo = hkOf("openAmmo", "⌥⇧⌘A"); // □3 默认键=规范序（"⌘⌥⇧A" 是 matchHotKey 死键串，index.ts 注册处同源翻案）
    // dock 键帽：思源 addDock 把热键条目写进 keymap.plugin[插件名][插件名+dockType]
    // （app/src/plugin/index.ts addDock→updatePluginKeymap(this.name, this.name+type, …)），
    // 消费=getDockHotkey 读 custom（layout/dock/hotkey.ts）+keydown matchHotKey toggle。
    // TIMELINE_DOCK="dock_pj_timeline"（index.ts:79），此处=name+type 全串。
    const hkDockTimeline = hkOf("sy-workbench-plugindock_pj_timeline");</script>

<div class="pj-conf__section">
    <div class="pj-conf__lead">{t.confEntryLead}</div>
    <div class="pj-conf__erow fn__flex" class:pj-conf__erow--off={!toggles.saveScene}>
        <input type="checkbox" class="b3-switch" checked={toggles.saveScene} onchange={(e) => void flip("saveScene", e.currentTarget.checked)} />
        <span class="pj-conf__ename">{t.saveScene}</span>
        <span class="fn__flex-1"></span>
        <HotkeyCap hk={hkSaveScene} pluginName={PLUGIN}></HotkeyCap>
    </div>
    <div class="pj-conf__erow fn__flex" class:pj-conf__erow--off={!toggles.setRemind}>
        <input type="checkbox" class="b3-switch" checked={toggles.setRemind} onchange={(e) => void flip("setRemind", e.currentTarget.checked)} />
        <span class="pj-conf__ename">{t.setRemind}</span>
        <span class="fn__flex-1"></span>
        <HotkeyCap hk={hkSetRemind} pluginName={PLUGIN}></HotkeyCap>
    </div>
    <div class="pj-conf__erow fn__flex" class:pj-conf__erow--off={!toggles.openTimeline}>
        <input type="checkbox" class="b3-switch" checked={toggles.openTimeline} onchange={(e) => void flip("openTimeline", e.currentTarget.checked)} />
        <span class="pj-conf__ename">{t.openTimeline}</span>
        <span class="fn__flex-1"></span>
        <HotkeyCap hk={hkOpenTimeline} pluginName={PLUGIN}></HotkeyCap>
    </div>
    <div class="pj-conf__erow fn__flex">
        <span class="pj-conf__ename">{t.openAmmo}</span>
        <span class="fn__flex-1"></span>
        <HotkeyCap hk={hkOpenAmmo} pluginName={PLUGIN}></HotkeyCap>
    </div>
    <div class="pj-conf__erow fn__flex">
        <span class="pj-conf__ename">{t.confEntryDockTl}</span>
        <span class="fn__flex-1"></span>
        <HotkeyCap hk={hkDockTimeline} pluginName={PLUGIN}></HotkeyCap>
    </div>
    <div class="pj-conf__erow fn__flex">
        <input type="checkbox" class="b3-switch" checked={toggles.openAmmoTopbar} onchange={(e) => void flip("openAmmoTopbar", e.currentTarget.checked)} />
        <span class="pj-conf__ename">{t.confEntryTopbar}</span>
    </div>
    <div class="pj-conf__erow fn__flex">
        <input type="checkbox" class="b3-switch" checked={toggles.contextMenu} onchange={(e) => void flip("contextMenu", e.currentTarget.checked)} />
        <span class="pj-conf__ename">{t.confEntryCtx}</span>
    </div>
    <div class="pj-conf__erow fn__flex">
        <input type="checkbox" class="b3-switch" checked={toggles.slash} onchange={(e) => void flip("slash", e.currentTarget.checked)} />
        <span class="pj-conf__ename">{t.confEntrySlash}</span>
    </div>
    <div class="pj-conf__hint">{t.confEntryHint}</div>
</div>

<style lang="scss">
    .pj-conf__section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .pj-conf__lead {
        font-size: 13px;
        color: var(--b3-theme-on-surface);
    }

    .pj-conf__hint {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    /* 开关行：开关+名称+（命令行）键帽一行；行间细分隔线用兄弟选择器 top-border——
       行后还有 hint 兄弟节点，:last-of-type/:last-child 都不命中行（vision P1 实锤：
       死规则多出第四行-hint 间通栏线，hint 被圈成第五行） */
    .pj-conf__erow {
        gap: 10px;
        align-items: center;
        padding: 6px 0;
    }

    .pj-conf__erow + .pj-conf__erow {
        border-top: 1px solid var(--b3-border-color);
    }

    /* 命令关闭期键帽禁用态（review P2：热键分发只扫已注册命令——off 期改键 inert，
       官方快捷键面板仍残留可设死键；禁点+弱化防误导，重开后 custom 保留自动生效） */
    .pj-conf__erow--off :global(.hotkey-wrap) {
        opacity: 0.5;
        pointer-events: none;
    }

    .pj-conf__ename {
        font-size: 13px;
        color: var(--b3-theme-on-background);
        text-align: left;
    }
</style>
