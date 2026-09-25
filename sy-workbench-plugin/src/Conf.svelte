<script lang="ts">
    // 设置双栏壳（calnav □1·bear 拍板 B 自建 Dialog）：左导航四页+右内容区，四页常驻 DOM
    // 仅切显隐（fn__none）——与原纵堆同为全渲染，切页零卸载零状态丢失（向导半填/贴码
    // 半贴不蒸发）。壳样式复用 tomato IndexConf.css 的 .tomato-settings-nav 体系
    // （根节点挂 .tomato-settings-dialog 启用，公共类零改动——渐进/recite 同款先例）。
    // pjux □1 搜索栏（复刻 tomato 三件套，四页常驻 DOM 的本地变体）：输入关键词=聚合视图
    // （去全部 fn__none 四页全显+域标题界标）→逐行过滤→左导航命中域高亮（点=清搜索跳域）。
    // 内容四页=PjConf* 子组件纯搬家（交互文案零变化）：AI 接入/用法示例/日历配置/同步对账。
    import { onDestroy, onMount, tick, untrack } from "svelte";
    import "../../sy-tomato-plugin/src/IndexConf.css";
    import { debugLog } from "./libs/debugLog";
    import PjConfMcp from "./PjConfMcp.svelte";
    import PjConfPrompts from "./PjConfPrompts.svelte";
    import PjConfCalendar from "./PjConfCalendar.svelte";
    import PjConfSync from "./PjConfSync.svelte";
    import PjConfEntry from "./PjConfEntry.svelte";

    let {
        t,
        loadFeishuStatus,
        loadLedger,
        startReauth,
        applyReauthCode,
        startSetup,
        applySetupCode,
        clearFeishu,
        loadCredsArchive,
        loadReauthUrl,
        getEntryToggles,
        setEntryToggle,
        loadMirrorCatalog,
        saveMirrorConf,
        pollMirrorCatalog,
        loadWeatherConf,
        saveWeatherConf,
        loadSchedAutoAdopt,
        applySchedAutoAdopt,
        loadReminderChannels,
        saveReminderChannels,
    }: {
        t: Record<string, string>;
        loadFeishuStatus: () => Promise<{ channel: string; calendarId?: string; enabled: boolean } | null>;
        loadLedger: () => Promise<import("./kernel/core/ledger").CalendarLedger | null>;
        startReauth: () => Promise<{ ok: boolean; error?: string; manual?: boolean }>;
        applyReauthCode: (code: string) => Promise<{ ok: boolean; error?: string }>;
        startSetup: (appId: string, appSecret: string) => Promise<{ ok: boolean; error?: string; manual?: boolean }>;
        applySetupCode: (appId: string, appSecret: string, code: string) => Promise<{ ok: boolean; error?: string }>;
        clearFeishu: () => Promise<{ ok: boolean; error?: string; creds?: { appId: string; appSecret: string } }>;
        loadCredsArchive: () => Promise<{ appId: string; appSecret: string } | null>;
        loadReauthUrl: () => Promise<string | null>;
        /** pjux □2：命令与入口管理页数据通道（setEntryToggle 返回 false=落盘失败已回滚） */
        getEntryToggles: () => Record<string, boolean>;
        setEntryToggle: (key: string, on: boolean) => Promise<boolean>;
        /** □17 回流：日历勾选清单数据通道 */
        loadMirrorCatalog: () => Promise<{ catalog: Array<{ id: string; summary: string; description: string; type: string }> | null; checked: Record<string, boolean> | null }>;
        saveMirrorConf: (checked: Record<string, boolean>) => Promise<boolean>;
        /** □17 回流：即时轮询等回执（空目录首配场景） */
        pollMirrorCatalog: () => Promise<unknown>;
        /** □18 自动天气：配置读写（city 含坐标=设置页 geocoding 解析后传入） */
        loadWeatherConf: () => Promise<{ enabled: boolean; city: { name: string; lat: number; lon: number } | null } | null>;
        saveWeatherConf: (conf: { enabled: boolean; city: { name: string; lat: number; lon: number } | null }) => Promise<boolean>;
        /** sloop □7：班表镜像后端+提醒通道（日历页消费） */
        loadSchedAutoAdopt: () => Promise<boolean>;
        applySchedAutoAdopt: (on: boolean) => Promise<{ ok: boolean; error?: string }>;
        /** sloop □25：完全同步开关（日历页消费） */
        loadReminderChannels: () => Promise<import("./shared/channels").ReminderChannels>;
        saveReminderChannels: (ch: import("./shared/channels").ReminderChannels) => Promise<boolean>;
    } = $props();

    // 左导航五页（顺序=AI 接入先接线、用法示例随后、日历配置+同步对账收尾、命令与入口垫底——番茄钟页随自建钟退役）；
    // label 惰性取值（tomato/渐进同款——模板每次渲染现取，勿在模块顶层快照 t 初值）
    const NAV_PAGES: Array<{ id: string; label: () => string }> = [
        { id: "mcp", label: () => t.confNavMcp },
        { id: "prompts", label: () => t.confNavPrompts },
        { id: "calendar", label: () => t.confNavCalendar },
        { id: "sync", label: () => t.confNavSync },
        { id: "entry", label: () => t.confNavEntry },
    ];
    let navActive = $state(NAV_PAGES[0].id);
    const NavKeyItemKey = "pj_settings_NavKeyItemKey_7vRkQwTzN4bJhXm2LdYpA8s";

    // ── pjux □1 搜索栏状态（tomato/渐进同款语义） ──
    let settingsDiv = $state<HTMLElement>();
    let searchInput = $state<HTMLElement>();
    let searchKey = $state("");
    // navHits=各域是否有命中行（过滤后从 DOM 回读），驱动导航项 --hit 高亮
    let navHits: Record<string, boolean> = $state({});
    // 输入沿聚合视图进出跳变跟踪（非响应式：只用于进/出沿触发滚顶，逐键过滤不触发）
    let searching = false;
    const SearchKeyItemKey = "pj_settings_SearchKeyItemKey_Kr7Vn2Wq9ZtXhB4MdPfSgY";

    // 日历页动作成功 → 同步对账页重拉账本（原 refreshMirrors 跨区刷新的拆分形态，经壳转发）
    let mirrorTick = $state(0);

    // 域内可搜单元 = 页根的直接子行（最小信息行）；域标题界标行不参与；McpPromo 单根
    // 即 .settingBox 卡（单元=卡自身）。tomato searchSettings 按行过滤但选择器钉死
    // .settingBox（改公共函数违反公共类勿动红线）——四页行形态是 .pj-conf__row 族，
    // 故本地变体：按「页根子行」枚举，四页组件零改动。
    // 隐式契约：页根非 .settingBox 时其直接子行才是单元——未来某页根下先包一层装饰
    // wrapper，过滤粒度会静默退化成 wrapper 级；新页遵守「信息行直挂页根」
    function pageUnits(sec: HTMLElement): HTMLElement[] {
        const roots = [...sec.children].filter(
            (c) => !(c as HTMLElement).classList.contains("tomato-agg-title"),
        ) as HTMLElement[];
        return roots.flatMap((r) =>
            r.classList.contains("settingBox") ? [r] : ([...r.children] as HTMLElement[]));
    }

    function searchSettingsPj(): void {
        if (!settingsDiv) return;
        const sk = searchKey.toLocaleLowerCase();
        const sections = [...settingsDiv.querySelectorAll<HTMLElement>("section.conf-group[data-domain]")];
        sections.forEach((sec) => {
            sec.style.display = "";
            pageUnits(sec).forEach((u) => (u.style.display = ""));
        });
        if (!sk) return;
        sections.forEach((sec) => {
            // 导航标签词命中=整域放行（review P1-1）：pj 页标题与导航标签系统性错位
            // （「日历配置」vs「到点提醒（飞书日历）」），照着导航词打字是最自然的首查、
            // 不能整屏空白；走 NAV_PAGES.label() 现取值，不做 agg-title DOM 时序假设
            const labelHit = (NAV_PAGES.find((p) => p.id === sec.dataset.domain)?.label() ?? "")
                .toLocaleLowerCase().includes(sk);
            // 含当前焦点的域冻结（review P1-2）：搜索态下用户正在交互的区域不因异步
            // 重滤原地蒸发（点向导「下一步」换块/展开手动贴码区都触发 childList 重滤）；
            // 输入主路径焦点在搜索框（sections 之外）零影响
            const frozen = sec.contains(document.activeElement);
            let any = false;
            pageUnits(sec).forEach((u) => {
                const hit = labelHit || frozen || (u.textContent ?? "").toLocaleLowerCase().includes(sk);
                u.style.display = hit ? "" : "none";
                any = any || hit;
            });
            if (!any) sec.style.display = "none"; // 整域无命中连界标一起收（导航对应项不亮）
        });
    }

    // 过滤完成后从 DOM 回读各域命中态（与 tomato 同款「DOM 即真相」——枚举与过滤共用 pageUnits）
    function updateNavHits(): void {
        const hits: Record<string, boolean> = {};
        settingsDiv?.querySelectorAll<HTMLElement>("section.conf-group[data-domain]").forEach((sec) => {
            const id = sec.dataset.domain;
            if (!id) return;
            hits[id] = pageUnits(sec).some((u) => u.style.display !== "none");
        });
        navHits = hits;
    }

    // 进/出聚合视图时面板滚回顶部（真滚动容器 .b3-dialog__body；逐键输入不触发——
    // 用户在聚合结果里翻看时续输字符不能拽回顶部）
    function scrollPanelTop(): void {
        (settingsDiv?.closest(".b3-dialog__body") as HTMLElement | null)?.scrollTo({ top: 0 });
    }

    // □15 ① IME 合成期门控（番茄同款）：受控 value 替代 bind:value——合成期 input（拼音
    // 中间态）不进 searchKey，聚合视图不误开、全列不闪「无命中」。compositionend 兜底：
    // Chrome 末笔 input 先于 compositionend 且 isComposing=true 被上面跳过，上屏值在此
    // 同步；Safari 末笔 input isComposing=false 走主路，此处重放同值幂等
    async function applySearch(v: string): Promise<void> {
        searchKey = v;
        const entering = !!searchKey && !searching;
        const leaving = !searchKey && searching;
        searching = !!searchKey;
        try {
            localStorage.setItem(SearchKeyItemKey, searchKey);
        } catch { /* 隐私模式等场景静默 */ }
        // 进聚合视图须等 fn__none 摘除/界标挂载的冲刷完成再过滤（同分支跳变 tick 只是空冲刷）
        await tick();
        searchSettingsPj();
        if (searchKey) updateNavHits();
        else navHits = {};
        if (entering || leaving) {
            scrollPanelTop();
            debugLog("fe", `conf search ${entering ? "enter" : "leave"} aggregate view`);
        }
    }

    function navGo(id: string): void {
        // 搜索态点导航=清搜索退聚合视图跳该域（「搜索全库找、浏览按域翻」的跳转出口）
        if (searchKey) {
            searchKey = "";
            navHits = {};
            searching = false;
            try {
                localStorage.setItem(SearchKeyItemKey, "");
            } catch { /* 隐私模式等场景静默 */ }
            scrollPanelTop();
            // 复位过滤留下的行内 display（常驻 DOM 壳特有：oninput 的清空路径不复走，
            // tomato 条件挂载无此残留；searchKey 已同步清零=走全复位分支）
            searchSettingsPj();
        }
        navActive = id;
        try {
            localStorage.setItem(NavKeyItemKey, id);
        } catch { /* 同上 */ }
    }

    // 搜索态下异步挂载/重建的行（对账页账本 rpc 后到、日历页状态行、mirrorTick 重拉）
    // 会绕过当轮过滤——挂载批后补一轮重滤保持视图一致。MutationObserver 只看 childList
    // （行挂卸），过滤自身只写 style 属性不触发回调，无环；untrack searchKey=纯读不建依赖
    let searchMO: MutationObserver | null = null;
    let moTimer = 0;
    function refilterOnRowChange(): void {
        untrack(() => {
            if (!searchKey) return;
            if (moTimer) return;
            moTimer = window.setTimeout(() => {
                moTimer = 0;
                if (!searchKey) return; // 清词窗口内迟到的回调不空跑（卫生项）
                searchSettingsPj();
                updateNavHits();
            }, 80);
        });
    }

    onMount(async () => {
        searchMO = new MutationObserver(refilterOnRowChange);
        searchMO.observe(
            settingsDiv?.querySelector(".tomato-nav-content") ?? settingsDiv ?? document.body,
            { childList: true, subtree: true },
        );
        // 冻存搜索词非空=直接进聚合视图（onDestroy 冻存的搜索态原样恢复，tomato 同款）；
        // 行级异步内容后到由 observer 补滤（恢复态下账本行常晚于首滤）
        let savedSearch = "";
        try {
            savedSearch = localStorage.getItem(SearchKeyItemKey) ?? "";
        } catch { /* 同上 */ }
        if (savedSearch) {
            searchKey = savedSearch;
            searching = true;
            await tick();
            searchSettingsPj();
            updateNavHits();
            debugLog("fe", `conf search restored key=${savedSearch} hits=${Object.keys(navHits).filter((k) => navHits[k]).join(",") || "none"}`);
        }
        searchInput?.focus();
    });

    // 导航位置记忆：恢复上次停留页（首开无存储落第一页）；onDestroy 冻存（含搜索词）
    try {
        const saved = localStorage.getItem(NavKeyItemKey);
        if (saved && NAV_PAGES.some((p) => p.id === saved)) navActive = saved;
    } catch { /* 同上 */ }
    onDestroy(() => {
        searchMO?.disconnect();
        if (moTimer) window.clearTimeout(moTimer);
        try {
            localStorage.setItem(NavKeyItemKey, navActive);
            localStorage.setItem(SearchKeyItemKey, searchKey);
        } catch { /* 同上 */ }
    });
</script>

<div class="pj-conf-shell tomato-settings-dialog" bind:this={settingsDiv}>
    <!-- search（pjux □1）：样式/交互复刻 tomato（.settingBox.search-bar sticky 体系在
         IndexConf.css）；data-search 标记=容器文案不参与行过滤的语义保留（本地变体
         只枚举 section 内页根子行，搜索框不在其列，纯防将来改回公共 searchSettings） -->
    <div class="settingBox search-bar" data-search>
        <input
            class="b3-text-field"
            bind:this={searchInput}
            placeholder={t.confSearchPlaceholder}
            value={searchKey}
            oninput={(e) => {
                if (e instanceof InputEvent && e.isComposing) return;
                void applySearch(e.currentTarget.value);
            }}
            oncompositionend={(e) => void applySearch(e.currentTarget.value)}
        />
    </div>
    <div class="tomato-settings-nav">
        <nav class="tomato-nav-list">
            {#each NAV_PAGES as p (p.id)}
                <button
                    class="tomato-nav-item"
                    class:tomato-nav-item--active={navActive === p.id && !searchKey}
                    class:tomato-nav-item--hit={!!searchKey && navHits[p.id]}
                    onclick={() => navGo(p.id)}
                >{p.label()}</button>
            {/each}
        </nav>
        <div class="tomato-nav-content">
            {#each NAV_PAGES as p (p.id)}
                <section class="conf-group" data-domain={p.id} class:fn__none={!searchKey && navActive !== p.id}>
                    {#if searchKey}
                        <!-- 聚合视图域界标（tomato 同款：sticky 主色标题行，data-domain 供命中回读） -->
                        <div class="tomato-agg-title">{p.label()}</div>
                    {/if}
                    {#if p.id === "mcp"}
                        <PjConfMcp></PjConfMcp>
                    {:else if p.id === "prompts"}
                        <PjConfPrompts {t}></PjConfPrompts>
                    {:else if p.id === "calendar"}
                        <PjConfCalendar
                            {t}
                            {loadFeishuStatus}
                            {startReauth}
                            {applyReauthCode}
                            {startSetup}
                            {applySetupCode}
                            {clearFeishu}
                            {loadCredsArchive}
                            {loadReauthUrl}
                            {loadMirrorCatalog}
                            {saveMirrorConf}
                            {pollMirrorCatalog}
                            {loadWeatherConf}
                            {saveWeatherConf}
                            {loadSchedAutoAdopt}
                            {applySchedAutoAdopt}
                            {loadReminderChannels}
                            {saveReminderChannels}
                            onMirrorsChanged={() => (mirrorTick += 1)}
                        ></PjConfCalendar>
                    {:else if p.id === "sync"}
                        <PjConfSync {t} {loadLedger} refreshTick={mirrorTick}></PjConfSync>
                    {:else}
                        <PjConfEntry {t} getToggles={getEntryToggles} setToggle={setEntryToggle}></PjConfEntry>
                    {/if}
                </section>
            {/each}
        </div>
    </div>
</div>

<style lang="scss">
    /* 壳布局：Dialog body 高度链经根传导（flex column + flex:auto），对齐渐进 .container 先例 */
    .pj-conf-shell {
        flex: auto;
        display: flex;
        flex-direction: column;
        margin: 0 2px 2px;
    }

    /* 四页常驻 DOM 的最后一页底缘呼吸（conf-group 只出 margin-top） */
    .pj-conf-shell .tomato-nav-content > section:last-child {
        margin-bottom: 12px;
    }
</style>
