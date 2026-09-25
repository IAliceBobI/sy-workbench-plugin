<script lang="ts">
    // 设置双栏 □1「日历配置」页：状态行+首配向导+重授权+清除配置+AI 高级路径
    // ——自 Conf.svelte 纯搬家，交互文案零变化。骨架被将来日历视图设置复用（calnav □3 落点）。
    import { onMount } from "svelte";
    import { showMessage } from "siyuan";
    import { buildFeishuStatusLine } from "./gui/queries";
    import { OAUTH_REDIRECT_URI, FEISHU_TUTORIAL_URL, type ReminderChannels } from "./shared/channels";
    import { extractAuthCode } from "./gui/oauth";
    import { buildAuthorizeUrl } from "./kernel/core/feishu";
    import { getCoachPrompt } from "./coachSeed";
    import { resolveChecked } from "./kernel/core/calendarMirror";
    
    let {
        t,
        loadFeishuStatus,
        startReauth,
        applyReauthCode,
        startSetup,
        applySetupCode,
        clearFeishu,
        loadCredsArchive,
        loadReauthUrl,
        onMirrorsChanged,
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
        /** 按钮化 c：B 档一键重授权（临时回调服务自动收 code） */
        startReauth: () => Promise<{ ok: boolean; error?: string; manual?: boolean }>;
        /** 按钮化 c A 档：手动贴授权码换证 */
        applyReauthCode: (code: string) => Promise<{ ok: boolean; error?: string }>;
        /** 首配纯 UI（calauth □2）：B 档一键授权（runOAuthFlow 收码→calendar-setup 落盘） */
        startSetup: (appId: string, appSecret: string) => Promise<{ ok: boolean; error?: string; manual?: boolean }>;
        /** 首配 A 档：手动贴授权码（浏览器版/自动收码不可用） */
        applySetupCode: (appId: string, appSecret: string, code: string) => Promise<{ ok: boolean; error?: string }>;
        /** 清除配置（删整份 feishu-config.json+凭证留档；回执 creds 供就地预填） */
        clearFeishu: () => Promise<{ ok: boolean; error?: string; creds?: { appId: string; appSecret: string } }>;
        /** 凭证档案（清除后表单预填；无档案=null） */
        loadCredsArchive: () => Promise<{ appId: string; appSecret: string } | null>;
        /** 已配置态的授权链接（从配置 appId 拼；无配置=null）——手动贴码通道的链接来源 */
        loadReauthUrl: () => Promise<string | null>;
        /** 动作成功后通知壳 → 同步对账页重拉账本镜像（原 refreshMirrors 跨区刷新的拆分形态） */
        onMirrorsChanged: () => void;
        /** □17 回流：日历目录+现勾选（catalog=null=kernel 尚未轮询出目录） */
        loadMirrorCatalog: () => Promise<{ catalog: Array<{ id: string; summary: string; description: string; type: string }> | null; checked: Record<string, boolean> | null }>;
        /** □17 回流：勾选清单落盘（返回 false=失败回滚 UI） */
        saveMirrorConf: (checked: Record<string, boolean>) => Promise<boolean>;
        /** □17 回流：即时轮询等回执（空目录首配场景现拉一轮） */
        pollMirrorCatalog: () => Promise<unknown>;
        /** □18 自动天气：配置读写 */
        loadWeatherConf: () => Promise<{ enabled: boolean; city: { name: string; lat: number; lon: number } | null } | null>;
        saveWeatherConf: (conf: { enabled: boolean; city: { name: string; lat: number; lon: number } | null }) => Promise<boolean>;
        /** 期 4 存活开关：飞书事件自动存入班表（sched 镜像链/backend/writeback 已随双源退役） */
        loadSchedAutoAdopt: () => Promise<boolean>;
        applySchedAutoAdopt: (on: boolean) => Promise<{ ok: boolean; error?: string }>;
        /** sloop □7：提醒通道读写（与镜像数据解耦的独立勾选） */
        loadReminderChannels: () => Promise<ReminderChannels>;
        saveReminderChannels: (ch: ReminderChannels) => Promise<boolean>;
    } = $props();

    let status = $state<import("./gui/queries").FeishuStatus | null>(null);
    /** 原始配置（channel 门面用：飞书后端选项须 oauth 通道才可选——bot 共享日历不镜像班表） */
    let rawStatus = $state<{ channel: string; enabled: boolean } | null>(null);
    let copiedKey = $state<string | null>(null);

    function flashCopied(key: string): void {
        copiedKey = key;
        setTimeout(() => {
            if (copiedKey === key) copiedKey = null;
        }, 1500);
    }

    async function copy(text: string, key: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            flashCopied(key);
        } catch {
            // 剪贴板不可用（headless/权限）静默
        }
    }

    onMount(async () => {
        rawStatus = await loadFeishuStatus().catch(() => null);
        status = buildFeishuStatusLine(rawStatus);
        // 首配表单预填：清除配置留档的凭证（重配免重填一轮）
        const creds = await loadCredsArchive().catch(() => null);
        if (creds?.appId) {
            setupAppId = creds.appId;
            setupAppSecret = creds.appSecret ?? "";
        }
        reauthUrl = (await loadReauthUrl().catch(() => null)) ?? "";
        // □17 回流勾选清单+□18 天气配置（已配置态才拉；目录 kernel 轮询写——首配后立即打开可能还没目录，重开面板自愈）
        if (status?.configured) {
            await loadMirrorList();
            weatherConf = await loadWeatherConf().catch(() => null);
            if (weatherConf?.city) weatherCity = weatherConf.city.name;
        }
        // 期 4：自动存入开关+提醒通道（班表镜像后端/完全同步已随 sched 双源退役）
        autoAdopt = await loadSchedAutoAdopt().catch(() => true);
        channels = await loadReminderChannels().catch(() => null);
        schedLoaded = true;
    });

    // ── □18 自动天气：开关+城市（保存时前端 geocoding 解析坐标，kernel 按坐标查） ──
    let weatherConf = $state<{ enabled: boolean; city: { name: string; lat: number; lon: number } | null } | null>(null);
    let weatherCity = $state("");
    let weatherSaving = $state(false);

    async function onWeatherToggle(on: boolean): Promise<void> {
        if (weatherSaving) return;
        weatherSaving = true;
        const prev = weatherConf;
        weatherConf = { enabled: on, city: prev?.city ?? null };
        const ok = await saveWeatherConf(weatherConf).catch(() => false);
        if (!ok) weatherConf = prev;
        weatherSaving = false;
    }

    /** □19 作息教练：按界面语言取种子提示词整段复制（粘给任意大模型即聊）。
     *  移动端 webview Clipboard API 不可用（tomato 同坑先例）——execCommand 兜底，再败才报错 */
    async function onCoachCopy(): Promise<void> {
        const lang = (window.siyuan?.config?.appearance?.lang ?? "zh_CN") as string;
        const text = getCoachPrompt(lang);
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch { ok = false; }
        if (!ok) {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try { ok = document.execCommand("copy"); } catch { ok = false; }
            ta.remove();
        }
        showMessage(ok ? t.calCoachCopied : t.calCoachCopyFail, ok ? 2500 : 5000, ok ? "info" : "error");
    }

    async function onWeatherSaveCity(): Promise<void> {
        const q = weatherCity.trim();
        if (weatherSaving || !q) return;
        weatherSaving = true;
        try {
            // 超时兜底（review P2-3）：挂起会让 weatherSaving 恒真=区块控件锁死到关面板
            const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=zh`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
            if (!r) {
                showMessage(t.calWeatherNetErr, 5000, "error");
                return;
            }
            const j = await r.json().catch(() => null);
            const hit = j?.results?.[0];
            if (typeof hit?.latitude !== "number" || typeof hit?.longitude !== "number") {
                showMessage(t.calWeatherNotFound, 5000, "error");
                return;
            }
            const city = { name: String(hit.name ?? q), lat: hit.latitude, lon: hit.longitude };
            const next = { enabled: weatherConf?.enabled ?? false, city };
            const ok = await saveWeatherConf(next).catch(() => false);
            if (!ok) {
                showMessage(t.calWeatherSaveErr, 5000, "error");
                return;
            }
            weatherConf = next;
            showMessage(t.calWeatherSaved.replace("{c}", city.name), 3000, "info");
        } finally {
            weatherSaving = false;
        }
    }

    // ── □17 回流日历勾选清单 ──
    interface MirrorListItem { id: string; summary: string; description: string; type: string; on: boolean; fromConf: boolean }
    let mirrorList = $state<MirrorListItem[] | null>(null);
    let mirrorBusy = $state(false);

    // ── 期 4：日程同步区（autoAdopt 存活开关+提醒通道；班表事件=remind 链推，后端选择退役） ──
    let schedLoaded = $state(false);
    let autoAdopt = $state(true);
    let adoptBusy = $state(false);
    let channels = $state<ReminderChannels | null>(null);
    let channelBusy = $state(false);

    /** 自动存入开关：乐观翻转+落盘；失败回滚 */
    async function onAutoAdoptToggle(on: boolean): Promise<void> {
        if (adoptBusy || !schedLoaded) return;
        adoptBusy = true;
        const prev = autoAdopt;
        autoAdopt = on;
        const r = await applySchedAutoAdopt(on).catch((err: any) => ({ ok: false, error: String(err?.message ?? err) }));
        if (!r.ok) {
            autoAdopt = prev;
            showMessage(t.calAutoAdoptFail.replace("{msg}", r.error ?? ""), 7000, "error");
        }
        adoptBusy = false;
    }

    /** 提醒通道单条切换：UI 即时翻转+落盘；失败回滚（external 位由 kernel/macOS 镜像链读） */
    async function onChannelToggle(key: "toast" | "dialog", on: boolean): Promise<void> {
        if (!channels || channelBusy) return;
        channelBusy = true;
        const prev = channels;
        channels = { ...channels, [key]: on };
        if (!(await saveReminderChannels(channels).catch(() => false))) channels = prev;
        channelBusy = false;
    }

    /** 目录+勾选拉取：勾选态=core resolveChecked 单一事实源（节假日类默认不勾——与 kernel 同则，
     *  勿在此内联正则防两处漂移）；空目录=kernel 未轮询过（首配后最长 1 小时空窗）——call 现拉再读 */
    async function loadMirrorList(): Promise<void> {
        let r = await loadMirrorCatalog().catch(() => null);
        if (!r?.catalog?.length) {
            await pollMirrorCatalog();
            r = await loadMirrorCatalog().catch(() => null);
        }
        if (!r?.catalog?.length) { mirrorList = null; return; }
        const checked = r.checked ?? null;
        mirrorList = resolveChecked(r.catalog, checked).map((c) => ({
            ...c,
            fromConf: Boolean(checked && Object.prototype.hasOwnProperty.call(checked, c.id)),
        }));
    }

    /** 单条切换：UI 即时翻转+落盘（saveMirrorConf 落盘即触发 kernel 拉一轮）；失败回滚 */
    async function onToggleMirror(item: MirrorListItem, next: boolean): Promise<void> {
        if (!mirrorList || mirrorBusy) return;
        mirrorBusy = true;
        item.on = next; // 就地翻转（mirrorList 为 $state 深层代理触发重渲）
        const checked: Record<string, boolean> = {};
        for (const it of mirrorList) checked[it.id] = it.on;
        const ok = await saveMirrorConf(checked).catch(() => false);
        if (!ok) item.on = !next;
        mirrorBusy = false;
    }

    // ── 按钮化 c：重新授权（B 档自动收码；浏览器版/端口占退本页手动贴 code） ──
    let reauthing = $state(false);
    let showManual = $state(false);
    let manualCode = $state("");
    let codeBusy = $state(false);

    // ── 首配纯 UI（calauth □2）：表单+一键授权+手动贴码 ──
    let setupAppId = $state("");
    let setupAppSecret = $state("");
    let settingUp = $state(false);
    let setupManual = $state(false);
    let setupCode = $state("");
    let setupCodeBusy = $state(false);
    let clearing = $state(false);

    // ── 首配向导（settingsnav·bear 拍板 A 案「凭证趁热填」）：1 建 app+填凭证 → 2 开权限 → 3 登记回调 → 4 授权 ──
    let setupStep = $state(1);
    let WIZ_TITLES = $derived([t.calWizStep1Title, t.calWizStep2Title, t.calWizStep3Title, t.calWizStep4Title]);

    // ── 授权链接（bear 09-14 断档修复：UI 必须平铺链接——点开/复制到浏览器 → 飞书重定向 URL 上才有 code）──
    // state 固定 "manual"：手动流程换证只认 code 不验 state，仅保持 URL 形态完整
    let authorizeUrl = $derived(setupAppId.trim() ? buildAuthorizeUrl(setupAppId.trim(), OAUTH_REDIRECT_URI, "manual") : "");
    let reauthUrl = $state(""); // 已配置态手动通道（onMount 从配置 appId 拼）

    // ── □4 向导各步直达深链（calnav 核真：/app/<appId>/<section> 三路由实测存在——匿名访问
    //    登录重定向的 redirect_uri 保留原路径=真路由，假路径塌缩到根；App ID 未填时链到后台列表） ──
    const FEISHU_APP_BASE = "https://open.feishu.cn/app";
    let appDeepBase = $derived(setupAppId.trim() ? `${FEISHU_APP_BASE}/${setupAppId.trim()}` : FEISHU_APP_BASE);

    async function refreshStatus(): Promise<void> {
        rawStatus = await loadFeishuStatus().catch(() => null);
        status = buildFeishuStatusLine(rawStatus);
        onMirrorsChanged(); // 账本镜像在对账页——经壳的 tick 通知其重拉（原 refreshMirrors 跨区半边）
    }

    async function onReauth(): Promise<void> {
        if (reauthing) return;
        reauthing = true;
        try {
            const r = await startReauth();
            if (r.ok) {
                showMessage(t.calReauthOk, 3000, "info");
                await refreshStatus();
            } else if (r.manual) {
                showManual = true; // 自动通道不可用——就地展开贴码输入框（不出面板）
            } else {
                showMessage(t.calReauthFail.replace("{msg}", r.error ?? ""), 7000, "error");
            }
        } finally {
            reauthing = false;
        }
    }

    async function onApplyCode(): Promise<void> {
        const code = extractAuthCode(manualCode); // 容错：整条回调 URL 粘进来也自己解析
        if (codeBusy || !code) return;
        codeBusy = true;
        try {
            const r = await applyReauthCode(code);
            if (r.ok) {
                showMessage(t.calReauthOk, 3000, "info");
                manualCode = "";
                await refreshStatus();
            } else {
                showMessage(t.calReauthFail.replace("{msg}", r.error ?? ""), 7000, "error");
            }
        } finally {
            codeBusy = false;
        }
    }

    // ── 首配（calauth □2）：一键授权/手动贴码/清除配置 ──
    async function onSetup(): Promise<void> {
        if (settingUp) return;
        settingUp = true;
        try {
            const r = await startSetup(setupAppId, setupAppSecret);
            if (r.ok) {
                showMessage(t.calSetupOk, 3000, "info");
                await refreshStatus();
            } else if (r.manual) {
                setupManual = true; // 自动通道不可用——就地展开贴码输入框（授权链接已打开则地址栏有 code）
            } else {
                showMessage(t.calSetupFail.replace("{msg}", r.error ?? ""), 9000, "error");
            }
        } finally {
            settingUp = false;
        }
    }

    async function onApplySetupCode(): Promise<void> {
        const code = extractAuthCode(setupCode); // 容错：整条回调 URL 粘进来也自己解析
        if (setupCodeBusy || !code) return;
        setupCodeBusy = true;
        try {
            const r = await applySetupCode(setupAppId, setupAppSecret, code);
            if (r.ok) {
                showMessage(t.calSetupOk, 3000, "info");
                setupCode = "";
                await refreshStatus();
            } else {
                showMessage(t.calSetupFail.replace("{msg}", r.error ?? ""), 9000, "error");
            }
        } finally {
            setupCodeBusy = false;
        }
    }

    async function onClear(): Promise<void> {
        if (clearing) return;
        clearing = true;
        try {
            const r = await clearFeishu();
            if (r.ok) {
                showMessage(t.calClearOk, 3000, "info");
                if (r.creds) {
                    setupAppId = r.creds.appId; // 留档凭证就地预填（免重开面板）
                    setupAppSecret = r.creds.appSecret;
                }
                await refreshStatus();
            } else {
                showMessage(t.calClearFail.replace("{msg}", r.error ?? ""), 7000, "error");
            }
        } finally {
            clearing = false;
        }
    }
    import PjConfHelpIcon from "./PjConfHelpIcon.svelte";
</script>

<div class="pj-conf__section">
    <div class="pj-conf__title pj-conf__title--row">
        {t.confCalendarTitle}
        <PjConfHelpIcon token="OaGVdwVAyowubAxqoXycRR61nN6" label={t.help} />
    </div>
    <div class="pj-conf__lead">{t.confCalendarLead}</div>
    <div class="pj-conf__status">
        {#if status}
            <span class="pj-conf__status-main" class:pj-conf__status-main--ok={status.configured}>{status.main}</span><span class="pj-conf__status-detail">{status.detail}</span>
        {:else}
            <span class="pj-conf__status-detail">{t.dashboardLoading}</span>
        {/if}
    </div>
    {#if status?.configured}
        <!-- 已配置：重授权（按钮化 c）+清除配置（calauth □2） -->
        <div class="pj-conf__reauth fn__flex">
            <button class="b3-button b3-button--small" onclick={onReauth} disabled={reauthing} title={t.calReauthTitle} aria-label={t.calReauthTitle}>
                {reauthing ? t.calReauthing : t.calReauth}
            </button>
            <span class="pj-conf__reauth-hint">{t.confReauthHint}</span>
            <span class="fn__flex-1"></span>
            <button class="b3-button b3-button--small b3-button--text pj-conf__clear-btn" onclick={onClear} disabled={clearing}>
                {clearing ? t.calClearing : t.calClear}
            </button>
        </div>
        <span class="pj-conf__hint pj-conf__clear-hint">{t.calClearHint}</span>
        {#if showManual}
            {#if reauthUrl}
                <div class="pj-conf__hint">{t.calAuthLinkHint}</div>
                <div class="pj-conf__authurl fn__flex">
                    <a class="pj-conf__authurl-link fn__flex-1" href={reauthUrl} target="_blank" rel="noreferrer">{reauthUrl}</a>
                    <button class="b3-button b3-button--small b3-button--outline" onclick={() => copy(reauthUrl, "reauth-url")}>
                        {copiedKey === "reauth-url" ? t.copied : t.copyBtn}
                    </button>
                </div>
            {/if}
            <div class="pj-conf__manual fn__flex">
                <input
                    class="b3-text-field fn__flex-1"
                    bind:value={manualCode}
                    placeholder={t.confCodePlaceholder}
                    disabled={codeBusy}
                    onkeydown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void onApplyCode(); }
                    }}
                />
                <button class="b3-button b3-button--small" onclick={onApplyCode} disabled={codeBusy || !manualCode.trim()}>
                    {codeBusy ? t.calReauthing : t.confApplyCodeBtn}
                </button>
            </div>
        {:else}
            <button class="b3-button b3-button--small b3-button--text pj-conf__manual-toggle" onclick={() => (showManual = true)}>
                {t.confManualCodeToggle}
            </button>
        {/if}
        <!-- □17 回流日历勾选清单（目录=kernel 轮询写的 meta；null=尚未轮询出目录，重开面板自愈） -->
        <div class="pj-conf__mirror">
            <div class="pj-conf__mirror-head">{t.calMirrorListTitle}</div>
            <div class="pj-conf__hint">{t.calMirrorListHint}</div>
            {#if mirrorList === null}
                <div class="pj-conf__hint">{t.calMirrorListEmpty}</div>
            {:else}
                <div class="pj-conf__mirror-list">
                    {#each mirrorList as item (item.id)}
                        <label class="pj-conf__mrow fn__flex" class:pj-conf__mrow--off={!item.on}>
                            <input type="checkbox" class="b3-switch" checked={item.on} disabled={mirrorBusy} onchange={(e) => void onToggleMirror(item, e.currentTarget.checked)} />
                            <span class="pj-conf__mname" title={item.description || item.summary}>{item.summary || item.id}</span>
                            {#if item.type && item.type !== "primary"}
                                <span class="pj-conf__mtype">{item.type}</span>
                            {/if}
                        </label>
                    {/each}
                </div>
            {/if}
        </div>
        <!-- □18 自动天气：开关+城市（geocoding 解析坐标；保存即存+即时跑一轮） -->
        <div class="pj-conf__weather">
            <div class="pj-conf__mirror-head">{t.calWeatherTitle}</div>
            <div class="pj-conf__hint">{t.calWeatherHint}</div>
            <label class="pj-conf__mrow fn__flex" class:pj-conf__mrow--off={!weatherConf?.enabled}>
                <input type="checkbox" class="b3-switch" aria-label={t.calWeatherTitle} checked={weatherConf?.enabled ?? false} disabled={weatherSaving} onchange={(e) => void onWeatherToggle(e.currentTarget.checked)} />
                <span class="pj-conf__mname">{weatherConf?.city ? t.calWeatherCityOf.replace("{c}", weatherConf.city.name) : t.calWeatherNoCity}</span>
            </label>
            <div class="pj-conf__manual fn__flex">
                <input
                    class="b3-text-field fn__flex-1"
                    bind:value={weatherCity}
                    placeholder={t.calWeatherCityPh}
                    disabled={weatherSaving}
                    onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); void onWeatherSaveCity(); } }}
                />
                <button class="b3-button b3-button--small" onclick={() => void onWeatherSaveCity()} disabled={weatherSaving || !weatherCity.trim()}>
                    {weatherSaving ? t.calReauthing : t.calWeatherSave}
                </button>
            </div>
        </div>
        <!-- □19 作息教练：种子提示词一键复制（粘给任意大模型即聊；硬性安排落地面=MCP calendar.upsert/飞书手建） -->
        <div class="pj-conf__coach">
            <div class="pj-conf__mirror-head">{t.calCoachTitle}</div>
            <div class="pj-conf__hint">{t.calCoachHint}</div>
            <div class="pj-conf__manual fn__flex">
                <button class="b3-button b3-button--small" onclick={() => void onCoachCopy()}>{t.calCoachCopy}</button>
            </div>
        </div>
    {:else}
        <!-- 未配置：向导式首配（settingsnav·bear 拍板 A 案「凭证趁热填」——安装软件式下一步引导；
             凭证页复制完当场填，不用来回切窗口记东西） -->
        <div class="pj-conf__wizard">
            <div class="pj-conf__wiz-head fn__flex">
                <span class="pj-conf__wiz-indicator">{t.calWizIndicator.replace("{n}", String(setupStep))}</span>
                <span class="pj-conf__wiz-title">{WIZ_TITLES[setupStep - 1]}</span>
                <span class="fn__flex-1"></span>
                {#if FEISHU_TUTORIAL_URL}
                    <a class="pj-conf__wiz-tutorial" href={FEISHU_TUTORIAL_URL} target="_blank" rel="noreferrer">{t.calWizTutorial}</a>
                {/if}
            </div>
            <div class="pj-conf__wiz-dots" aria-hidden="true">
                {#each Array(4) as _, i}
                    <span class="pj-conf__wiz-dot" class:pj-conf__wiz-dot--done={i < setupStep}></span>
                {/each}
            </div>
            {#if setupStep === 1}
                <div class="pj-conf__lead">
                    {t.calSetupStep1a}<a class="pj-conf__console-link" href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">open.feishu.cn/app</a>{t.calSetupStep1b}
                </div>
                <div class="pj-conf__field fn__flex">
                    <label class="pj-conf__field-label" for="pj-cal-appid">{t.calSetupAppId}</label>
                    <input id="pj-cal-appid" class="b3-text-field fn__flex-1" bind:value={setupAppId} placeholder={t.calSetupAppIdPh} disabled={settingUp} spellcheck="false" />
                </div>
                <div class="pj-conf__field fn__flex">
                    <label class="pj-conf__field-label" for="pj-cal-secret">{t.calSetupAppSecret}</label>
                    <input id="pj-cal-secret" class="b3-text-field fn__flex-1" bind:value={setupAppSecret} placeholder={t.calSetupAppSecretPh} disabled={settingUp} spellcheck="false" />
                </div>
            {:else if setupStep === 2}
                <div class="pj-conf__lead">
                    {t.calSetupStep2}
                    <a class="pj-conf__console-link" href={appDeepBase + "/permission"} target="_blank" rel="noreferrer">{t.calDeepPermission}</a>
                </div>
            {:else if setupStep === 3}
                <div class="pj-conf__lead">
                    {t.calSetupStep3}
                    <a class="pj-conf__console-link" href={appDeepBase + "/security"} target="_blank" rel="noreferrer">{t.calDeepSecurity}</a>
                </div>
                <div class="pj-conf__sample fn__flex">
                    <code class="pj-conf__code fn__flex-1">{OAUTH_REDIRECT_URI}</code>
                    <button class="b3-button b3-button--small b3-button--outline" onclick={() => copy(OAUTH_REDIRECT_URI, "redirect-uri")}>
                        {copiedKey === "redirect-uri" ? t.copied : t.copyBtn}
                    </button>
                </div>
            {:else}
                <div class="pj-conf__hint">{t.calAuthLinkHint}</div>
                {#if authorizeUrl}
                    <div class="pj-conf__authurl fn__flex">
                        <a class="pj-conf__authurl-link fn__flex-1" href={authorizeUrl} target="_blank" rel="noreferrer">{authorizeUrl}</a>
                        <button class="b3-button b3-button--small b3-button--outline" onclick={() => copy(authorizeUrl, "authorize-url")}>
                            {copiedKey === "authorize-url" ? t.copied : t.copyBtn}
                        </button>
                    </div>
                {/if}
                <div class="pj-conf__reauth fn__flex">
                    <button
                        class="b3-button b3-button--small"
                        onclick={onSetup}
                        disabled={settingUp || !setupAppId.trim() || !setupAppSecret.trim()}
                    >{settingUp ? t.calReauthing : t.calSetupGo}</button>
                    <span class="pj-conf__reauth-hint">{t.calSetupGoHint}</span>
                </div>
                {#if setupManual}
                    <div class="pj-conf__manual fn__flex">
                        <input
                            class="b3-text-field fn__flex-1"
                            bind:value={setupCode}
                            placeholder={t.confCodePlaceholder}
                            disabled={setupCodeBusy}
                            onkeydown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); void onApplySetupCode(); }
                            }}
                        />
                        <button class="b3-button b3-button--small" onclick={onApplySetupCode} disabled={setupCodeBusy || !setupCode.trim()}>
                            {setupCodeBusy ? t.calReauthing : t.confApplyCodeBtn}
                        </button>
                    </div>
                {:else}
                    <button class="b3-button b3-button--small b3-button--text pj-conf__manual-toggle" onclick={() => (setupManual = true)}>
                        {t.confManualCodeToggle}
                    </button>
                {/if}
                <div class="pj-conf__hint">{t.confCalendarStep3}</div>
            {/if}
            <div class="pj-conf__wiz-nav fn__flex">
                {#if setupStep > 1}
                    <button class="b3-button b3-button--small b3-button--outline" onclick={() => (setupStep -= 1)}>{t.calWizPrev}</button>
                {/if}
                <span class="fn__flex-1"></span>
                {#if setupStep < 4}
                    <button
                        class="b3-button b3-button--small"
                        onclick={() => (setupStep += 1)}
                        disabled={setupStep === 1 && (!setupAppId.trim() || !setupAppSecret.trim())}
                    >{t.calWizNext}</button>
                {/if}
            </div>
        </div>
    {/if}
    <!-- 期 4 日程同步区（sched 双源退役：班表事件=remind 链推；存活开关=自动存入+到点提醒通道） -->
    <div class="pj-conf__schedmirror">
        <div class="pj-conf__mirror-head">{t.calSchedMirrorTitle}</div>
        <div class="pj-conf__hint">{t.calSchedMirrorHint}</div>
        <label class="pj-conf__mrow fn__flex" class:pj-conf__mrow--off={!autoAdopt}>
            <input type="checkbox" class="b3-switch" aria-label={t.calAutoAdoptTitle} checked={autoAdopt} disabled={adoptBusy || !schedLoaded} onchange={(e) => void onAutoAdoptToggle(e.currentTarget.checked)} />
            <span class="pj-conf__mname">{t.calAutoAdoptTitle}</span>
        </label>
        <div class="pj-conf__hint">{t.calAutoAdoptHint}</div>
        <div class="pj-conf__mirror-head pj-conf__subhead">{t.calRemindChannelsTitle}</div>
        <div class="pj-conf__hint">{t.calRemindChannelsHint}</div>
        <div class="pj-conf__mirror-list">
            <label class="pj-conf__mrow fn__flex" class:pj-conf__mrow--off={!channels?.toast}>
                <input type="checkbox" class="b3-switch" aria-label={t.calRemindToast} checked={channels?.toast ?? false} disabled={channelBusy || !channels} onchange={(e) => void onChannelToggle("toast", e.currentTarget.checked)} />
                <span class="pj-conf__mname">{t.calRemindToast}</span>
            </label>
            <label class="pj-conf__mrow fn__flex" class:pj-conf__mrow--off={!channels?.dialog}>
                <input type="checkbox" class="b3-switch" aria-label={t.calRemindDialog} checked={channels?.dialog ?? false} disabled={channelBusy || !channels} onchange={(e) => void onChannelToggle("dialog", e.currentTarget.checked)} />
                <span class="pj-conf__mname">{t.calRemindDialog}</span>
            </label>
        </div>
    </div>
    <!-- AI 高级路径（bot 通道/代配）：表单为主通道后降级为辅助 -->
    <div class="pj-conf__hint pj-conf__advanced-lead">{t.calAdvancedLead}</div>
    <div class="pj-conf__sample fn__flex">
        <code class="pj-conf__code fn__flex-1">{t.confCalendarSample}</code>
        <button class="b3-button b3-button--small b3-button--outline" onclick={() => copy(t.confCalendarSample, "calendar")}>
            {copiedKey === "calendar" ? t.copied : t.copyBtn}
        </button>
    </div>
    <div class="pj-conf__hint">{t.confCalendarOff}</div>
</div>

<style lang="scss">
    .pj-conf__section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .pj-conf__title {
        font-size: 15px;
        font-weight: 400;
        color: var(--b3-theme-on-background);
    }
    /* 标题行挂帮助图标（期1 workbench-help）：标题+图标同行基线对齐 */
    .pj-conf__title--row {
        display: flex;
        align-items: center;
    }


    .pj-conf__lead {
        font-size: 13px;
        color: var(--b3-theme-on-surface);
    }

    .pj-conf__sample {
        gap: 8px;
        align-items: center;
    }

    .pj-conf__code {
        font-size: 13px;
        padding: 4px 8px;
        border-radius: var(--b3-border-radius);
        background-color: var(--b3-theme-surface);
        border: 1px solid var(--b3-border-color);
        color: var(--b3-theme-on-background);
        overflow-wrap: anywhere;
        text-align: left;
    }

    .pj-conf__status {
        font-size: 13px;
        display: flex;
        align-items: baseline;
        gap: 2px;
    }

    .pj-conf__status-main {
        color: var(--b3-theme-on-surface); /* 基础态须 AA（--b3-theme-on-surface-light 亮色 2.89:1 不达标，calauth □2 vision P1）；绿分支见 --ok */
    }

    .pj-conf__status-main--ok {
        color: var(--b3-card-success-color); /* 引导文案承诺「绿色已配置」（vision P1-1） */
    }

    .pj-conf__status-detail {
        color: var(--b3-theme-on-surface);
    }

    /* 步骤 1 开发者后台直达：链接文字=URL 本体（信息平铺，可点可读）。主蓝 var(--b3-theme-primary)
       两主题均不足 AA（vision P1 实测 3.9/3.3:1）——按主题钉色+下划线（暗色判据=data-theme-mode 非 .dark） */
    .pj-conf__console-link {
        color: #1b66cc; /* 亮底 5.1:1 */
        word-break: break-all;
        text-decoration: underline;
        text-underline-offset: 2px;
    }

    :global(html[data-theme-mode="dark"]) .pj-conf__console-link {
        color: #7ba2f5; /* 暗底 5.5:1 */
    }

    /* 首配向导（settingsnav·A 案）：头部指示+进度点+底部导航（安装软件式） */
    .pj-conf__wizard {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .pj-conf__wiz-head {
        gap: 8px;
        align-items: baseline;
    }

    .pj-conf__wiz-indicator {
        flex-shrink: 0;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        font-variant-numeric: tabular-nums;
    }

    .pj-conf__wiz-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
    }

    .pj-conf__wiz-tutorial {
        flex-shrink: 0;
        font-size: 12px;
        color: #1b66cc; /* 与 console-link/manual-toggle 同套钉色（主蓝不达 AA） */
        text-decoration: underline;
        text-underline-offset: 2px;
    }

    :global(html[data-theme-mode="dark"]) .pj-conf__wiz-tutorial {
        color: #7ba2f5;
    }

    .pj-conf__wiz-dots {
        display: flex;
        gap: 6px;
    }

    .pj-conf__wiz-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: var(--b3-theme-on-surface-light); /* 未到点：border-color 暗色下过弱（vision P2），提一档灰阶 */
    }

    .pj-conf__wiz-dot--done {
        background-color: var(--b3-theme-primary);
    }

    .pj-conf__wiz-nav {
        gap: 8px;
    }

    /* 授权链接行（bear 09-14 断档修复）：整条 URL 平铺可点可复制——code 底+钉色可点形态 */
    .pj-conf__authurl {
        gap: 8px;
        align-items: center;
    }

    .pj-conf__authurl-link {
        font-size: 12px;
        padding: 4px 8px;
        border-radius: var(--b3-border-radius);
        background-color: var(--b3-theme-surface);
        border: 1px solid var(--b3-border-color);
        color: #1b66cc; /* 与 console-link 同套钉色（主蓝不达 AA） */
        overflow-wrap: anywhere;
        text-align: left;
        text-decoration: underline; /* 与「仅可复制」的 code 行形态区分——这是可点链接（vision P2） */
        text-underline-offset: 2px;
    }

    :global(html[data-theme-mode="dark"]) .pj-conf__authurl-link {
        color: #7ba2f5;
    }

    /* 按钮化 c：重新授权行+手动贴码行 */
    .pj-conf__reauth {
        gap: 8px;
        align-items: center;
    }

    .pj-conf__reauth-hint {
        font-size: 12px;
        color: var(--b3-theme-on-surface); /* 操作说明须达 AA 对比（vision P1），与 desc/hint 同灰阶 */
    }

    /* 清除配置（calauth □2）：行右端文本钮+独立说明行（信息平铺） */
    .pj-conf__clear-btn {
        color: var(--b3-card-error-color, #d23f31);
    }

    .pj-conf__clear-hint {
        margin-top: -4px;
    }

    /* 首配表单行（calauth □2）：label+输入框一行（设置控件紧凑惯例） */
    .pj-conf__field {
        gap: 8px;
        align-items: center;
    }

    .pj-conf__field-label {
        flex-shrink: 0;
        width: 76px;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        text-align: left;
    }

    .pj-conf__advanced-lead {
        padding-top: 4px;
    }

    .pj-conf__manual {
        gap: 8px;
        align-items: center;
    }

    .pj-conf__manual-toggle {
        align-self: flex-start;
        padding-left: 0;
        /* 文本钮默认主蓝双主题 <4.5:1（vision 复审同类遗留），与 console-link 同套钉色+下划线拉齐可点形态 */
        color: #1b66cc;
        text-decoration: underline;
        text-underline-offset: 2px;
    }

    :global(html[data-theme-mode="dark"]) .pj-conf__manual-toggle {
        color: #7ba2f5;
    }

    /* □17 回流勾选清单：标题+说明+开关行列表（erow 同形态：开关+名称一行） */
    .pj-conf__mirror {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 4px;
    }

    /* □18 天气区块（mirror 同形态） */
    .pj-conf__weather,
    .pj-conf__coach,
    .pj-conf__schedmirror {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 4px;
    }

    /* sloop □7 后端选择器（窄列——选项文案自带说明）+提醒通道小节头 */

    .pj-conf__subhead {
        margin-top: 4px;
    }

    .pj-conf__mirror-head {
        font-size: 13px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
    }

    .pj-conf__mirror-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 220px;
        overflow-y: auto;
    }

    .pj-conf__mrow {
        gap: 8px;
        align-items: center;
        min-height: 28px;
        cursor: pointer;
        border-radius: var(--b3-border-radius);
    }

    /* 整行可点（label 包 checkbox）：hover 背景反馈（回流清单/提醒通道两处同款） */
    .pj-conf__mrow:hover {
        background: var(--b3-switch-hover, rgba(31, 31, 31, 0.06));
    }

    /* off 态文字=可交互项非禁用项，须达 AA（sloop □7 vision 两轮：on-surface-light 亮色 2.8:1
       不达标+暗色语义反转——改 on-surface+0.92 弱化=亮 5.0/暗 4.7:1 双过 AA 且保留开>关醒目序） */
    .pj-conf__mrow--off .pj-conf__mname {
        color: var(--b3-theme-on-surface);
        opacity: 0.92;
    }

    .pj-conf__mname {
        min-width: 0;
        font-size: 13px;
        color: var(--b3-theme-on-surface);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pj-conf__mtype {
        flex-shrink: 0;
        margin-left: auto;
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-conf__hint {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    /* 复制→已复制两字变三字的宽度抖动（vision P2-2） */
    .pj-conf__sample .b3-button {
        min-width: 48px;
    }
</style>
