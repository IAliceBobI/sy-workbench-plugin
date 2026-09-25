<script lang="ts">
    // ammo □6：四象限面板·数据宿主（□9 悬浮窗外壳/开发期 Dialog 都 mount 本件进正文容器）。
    // 职责=纯内容组件（AmmoQuadrantPanel）外的全部数据链路：
    //  - 面板数据=kernel rpc ammo-panel（聚合读面——挂载首读+广播/动作后重拉，勿 SQL 轮询）；
    //  - 引擎动作=kernel rpc ammo-start/stop/resolve/reflect（owner 门牌=本窗 app id——
    //    window.siyuan.ws.ws.url 的 app 参数；Run1 接线增补①口径）；
    //  - 状态刷新=window「pj-ammo-state」事件（index.ts 从 AMMO_STATE_CHANNEL 广播转发——
    //    内存事件链，非 SQL 轮询：索引竞态族+「写后立读」九连的规避通道）。
    // 任何动作后双重刷新：动作自身回包=AmmoEngineStatus（本地即时应用），广播回声=全量重拉
    // （他窗动作/内核恢复扫描也进同一通道——rev 相同的重拉跳过，防抖）。
    import { onMount } from "svelte";
    import { showMessage } from "siyuan";
    import AmmoQuadrantPanel from "./AmmoQuadrantPanel.svelte";
    import { debugLog } from "./libs/debugLog";
    import { AMMO_PANEL_METHOD, AMMO_START_METHOD, AMMO_STOP_METHOD, AMMO_RESOLVE_METHOD, AMMO_REFLECT_METHOD, AMMO_DEPART_METHOD, AMMO_MOVE_POOL_METHOD, AMMO_SET_RATIO_METHOD, AMMO_SET_FREQ_METHOD, AMMO_HEALTH_METHOD, SCHED_BOARD_READ_METHOD, AVERSION_WRITE_METHOD } from "./shared/channels";
    import type { AmmoPanelData } from "./kernel/ammoPanel";
    import type { AmmoHealthReport } from "./kernel/ammoHealth";
    import type { AmmoEngineStatus } from "./kernel/ammoEngine";
    import { buildDepartParams, pickNextAnchor, type DepartBoardRow } from "./ammoDepartWire";
    import { getLogicalDay } from "./kernel/core/dates";
    import type { AmmoPoolSlug } from "./kernel/core/ammoQuadrant";

    let {
        t,
        /** 插件 kernel rpc 面（Plugin 实例的 this.kernel.rpc——宿主传入；缺=只读空态） */
        rpc,
        /** 体检条目跳转（dataview □8——外层接 openDocNoFocus：cb-get-hl 禁聚焦政策；缺=纯文本行） */
        openBlock,
        /** 头栏跳每日配置月文档（mainfix0923 □5——外层接 openDayConfigDoc；缺=钮不出） */
        onOpenDayConfig,
        /** 头栏跳当日日记（mainfix0923 □5——外层接 openTodayDiary；缺=钮不出） */
        onOpenDiary,
    }: {
        t: Record<string, string>;
        rpc: { call: Record<string, (p?: any) => Promise<any>> } | null;
        openBlock?: (blockId: string) => void;
        /** 头栏跳每日配置月文档（mainfix0923 □5——外层接 openDayConfigDoc：定位不到=toast
         *  不懒建；缺=钮不出） */
        onOpenDayConfig?: () => void;
        /** 头栏跳当日日记（mainfix0923 □5——外层接 openTodayDiary：定位不到=toast 不懒建；
         *  缺=钮不出） */
        onOpenDiary?: () => void;
    } = $props();

    let data = $state<AmmoPanelData | null>(null);
    let loading = $state(true);
    let nowMin = $state(0);
    /** 当日班表锚点行（dataview □3——sched-board-read 只读拉取；「出发下一发」数据源） */
    let board = $state<DepartBoardRow[]>([]);
    /** 格式体检报告（dataview □8——按需拉取：展开钮触发，勿随面板重拉） */
    let health = $state<AmmoHealthReport | null>(null);
    let healthLoading = $state(false);

    /** 本窗 app id（owner 门牌——引擎快照透传，他窗只读展示用；取不到=空串容忍） */
    function ownerAppId(): string {
        try {
            return new URL((window as any).siyuan?.ws?.ws?.url ?? "").searchParams.get("app") ?? "";
        } catch {
            return "";
        }
    }

    function localNowMin(): number {
        const d = new Date();
        return d.getHours() * 60 + d.getMinutes();
    }

    function debugLogSafe(msg: string): void {
        // 禁裸 console（项目纪律）；debugLog 门控=isMe/dev 端口段（libs/debugLog）
        debugLog("ammo", msg);
    }

    /** 全量重拉（面板唯一数据通道——rpc ammo-panel；rev 相同跳过应用防广播回声抖动。
     *  force=true 绕过 rev 闸：配置写（换池/改配比）不动引擎态 rev 不变，用户显式动作
     *  后必须应用新读面（rev 闸只服务广播回声，不拦动作回执）。 */
    async function reload(force = false): Promise<void> {
        if (!rpc?.call) return;
        try {
            const next = (await rpc.call[AMMO_PANEL_METHOD]({})) as AmmoPanelData;
            if (next) {
                // rev 相同且已有数据=广播回声/重复事件，跳过（首拉恒应用）
                if (!force && data && next.rev === data.rev) {
                    loading = false;
                    return;
                }
                data = next;
            }
        } catch (e) {
            debugLogSafe(`reload failed: ${String(e)}`);
        } finally {
            loading = false;
        }
    }

    // ── 引擎动作（动作回包=AmmoEngineStatus 即时应用；消耗态数字变更走广播重拉） ──

    function applyStatus(st: AmmoEngineStatus | null | undefined): void {
        if (!st) return;
        if (data && typeof st.rev === "number") {
            data = { ...data, running: st.running ?? null, dangling: st.dangling ?? [], rev: st.rev };
        }
        void reload();
    }

    async function start(p: { task: string; pool: string; summary: string }): Promise<void> {
        if (!rpc?.call) return;
        const d = new Date();
        const pad = (x: number) => String(x).padStart(2, "0");
        try {
            const st = await rpc.call[AMMO_START_METHOD]({
                day: data?.day,
                start: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
                summary: p.summary,
                pool: p.pool,
                task: p.task,
                owner: ownerAppId(),
            });
            applyStatus(st);
        } catch (e) {
            debugLogSafe(`ammo-start failed: ${String(e)}`);
        }
    }

    async function stop(): Promise<void> {
        if (!rpc?.call) return;
        const d = new Date();
        const pad = (x: number) => String(x).padStart(2, "0");
        try {
            const st = await rpc.call[AMMO_STOP_METHOD]({ day: data?.day, end: `${pad(d.getHours())}:${pad(d.getMinutes())}` });
            applyStatus(st);
        } catch (e) {
            debugLogSafe(`ammo-stop failed: ${String(e)}`);
        }
    }

    async function resolve(p: { blockId: string; day: string; end: string }): Promise<void> {
        if (!rpc?.call) return;
        try {
            const st = await rpc.call[AMMO_RESOLVE_METHOD](p);
            applyStatus(st);
        } catch (e) {
            debugLogSafe(`ammo-resolve failed: ${String(e)}`);
        }
    }

    async function reflect(text: string): Promise<boolean> {
        if (!rpc?.call) return false;
        try {
            const r = await rpc.call[AMMO_REFLECT_METHOD]({ text, day: data?.day });
            return Boolean(r?.ok);
        } catch {
            return false;
        }
    }

    // ── dataview □5：拖卡换池（单任务级写通道）+点池头改配比（□2 文本写通道） ──

    /** 拖卡换池：kernel moveTaskPool（幂等；行属性+树块「今日位」缓存同步）→强制重拉
     *  （配置写不动引擎 rev——force 绕 rev 闸，动作回执必上屏）。
     *  失败可见面（外观三件）：拒（ok:false）=toast 透传 kernel error 文案（语义完整，
     *  如「月度配置文档不在——换池不发明结构（晚间交接会配弹药后可拖）」）；rpc 面不在=
     *  toast i18n 兜底（拖没拖成零提示=「看得见」缺口）；拖完不 toast（卡换位置已是反馈）。 */
    async function moveTask(p: { task: string; name: string; pool: AmmoPoolSlug }): Promise<void> {
        if (!rpc?.call) {
            showMessage(String(t.ammoMoveOffline ?? "弹药库面板未就绪——换池暂不可用"), 3000, "error");
            return;
        }
        try {
            const r = await rpc.call[AMMO_MOVE_POOL_METHOD]({ day: data?.day, task: p.task, name: p.name, pool: p.pool });
            if (r && r.ok === false) {
                debugLogSafe(`ammo-move-pool rejected: ${String(r.error ?? "")}`);
                showMessage(String(r.error ?? t.ammoMoveOffline ?? "换池未生效"), 3000, "error");
                return;
            }
        } catch (e) {
            debugLogSafe(`ammo-move-pool failed: ${String(e)}`);
        }
        void reload(true);
    }

    /** 点池头改配比：kernel setPoolRatio（ratio 落池行文本）→强制重拉；回包 ok=就地收输入 */
    async function setRatio(p: { pool: AmmoPoolSlug; ratio: number | null }): Promise<boolean> {
        if (!rpc?.call) return false;
        try {
            const r = await rpc.call[AMMO_SET_RATIO_METHOD]({ day: data?.day, pool: p.pool, ratio: p.ratio });
            void reload(true);
            return Boolean(r?.ok);
        } catch (e) {
            debugLogSafe(`ammo-set-ratio failed: ${String(e)}`);
            return false;
        }
    }

    /** 炉火最小频率（第二批 R3）：kernel setPoolFreq（freq 无文本形态——属性即真相）→
     *  强制重拉；回包 ok=就地收输入。setRatio 同款形态。 */
    async function setFreq(p: { pool: AmmoPoolSlug; freq: number | null }): Promise<boolean> {
        if (!rpc?.call) return false;
        try {
            const r = await rpc.call[AMMO_SET_FREQ_METHOD]({ day: data?.day, pool: p.pool, freq: p.freq });
            void reload(true);
            return Boolean(r?.ok);
        } catch (e) {
            debugLogSafe(`ammo-set-freq failed: ${String(e)}`);
            return false;
        }
    }

    // ── manualui：不想做清单手动编辑（aversion-write rpc——写面=kernel syncAversions 单一
    //    事实源，AI aversion_set 同一实现；写不动引擎 rev → force 重拉上屏新圈面） ──

    /** 手动新增（kind 恒 vow——手动通道不暴露 avatar/capPool，AI 对话仍可补） */
    async function aversionAdd(text: string): Promise<boolean> {
        if (!rpc?.call) return false;
        try {
            const r = await rpc.call[AVERSION_WRITE_METHOD]({ upserts: [{ text, kind: "vow" }] });
            void reload(true);
            return Boolean(r?.ok);
        } catch (e) {
            debugLogSafe(`aversion-write add failed: ${String(e)}`);
            return false;
        }
    }

    /** 手动改文（kind/avatar/capPool 由组件从读面透传——kernel 同 kind 原地更新确定性重挂
     *  全键属性，不透传=fear 化身/swallow 物化池被清空） */
    async function aversionRename(p: { id: string; text: string; kind: string; avatar?: string; capPool?: string }): Promise<boolean> {
        if (!rpc?.call) return false;
        try {
            const r = await rpc.call[AVERSION_WRITE_METHOD]({ upserts: [p] });
            void reload(true);
            return Boolean(r?.ok);
        } catch (e) {
            debugLogSafe(`aversion-write rename failed: ${String(e)}`);
            return false;
        }
    }

    /** 手动删除（直接删不弹确认——AI 面同款语义；守卫=非不想做块拒删） */
    async function aversionRemove(id: string): Promise<boolean> {
        if (!rpc?.call) return false;
        try {
            const r = await rpc.call[AVERSION_WRITE_METHOD]({ remove: [id] });
            void reload(true);
            return Boolean(r?.ok);
        } catch (e) {
            debugLogSafe(`aversion-write remove failed: ${String(e)}`);
            return false;
        }
    }

    // ── 出发下一发（dataview □3） ──

    /** 下一发锚点（分钟针 30s 递推自动滚动——已过点/进行中锚点不作下一发；无=null 横幅不出钮） */
    const nextAnchor = $derived.by(() => (pickNextAnchor(board, nowMin)));

    // ── 格式体检（dataview □8——fail-soft 可见面；按需拉取不随面板重拉） ──

    /** 体检展开钮触发：ammo-health rpc 拉三类发现（分区结构/未认行/文本属性冲突） */
    async function checkHealth(): Promise<void> {
        if (!rpc?.call) return;
        healthLoading = true;
        try {
            const r = await rpc.call[AMMO_HEALTH_METHOD]({ day: data?.day });
            if (r) health = r as AmmoHealthReport;
        } catch (e) {
            debugLogSafe(`ammo-health failed: ${String(e)}`);
        } finally {
            healthLoading = false;
        }
    }

    /** 当日班表只读拉取（sched-board-read 零副作用零建档；失败留旧值——下一发是增强面非数据主链） */
    async function reloadBoard(): Promise<void> {
        if (!rpc?.call) return;
        try {
            const r = await rpc.call[SCHED_BOARD_READ_METHOD]({ day: data?.day ?? getLogicalDay(new Date()) });
            if (r?.ok && Array.isArray(r.items)) {
                board = r.items.map((it: any) => ({ key: String(it?.key ?? ""), summary: String(it?.summary ?? ""), start: it?.start ?? null }));
            }
        } catch (e) {
            debugLogSafe(`reloadBoard failed: ${String(e)}`);
        }
    }

    /** 出发下一发：闭当前+开锚点出发型（引擎面现成；start=点击当下；day=面板口径） */
    async function depart(a: { key: string; summary: string; start: string }): Promise<void> {
        if (!rpc?.call || !a.key) return;
        const p = buildDepartParams({ summary: a.summary, task: a.key, now: new Date(), day: data?.day, owner: ownerAppId() });
        try {
            const st = await rpc.call[AMMO_DEPART_METHOD](p);
            applyStatus(st);
        } catch (e) {
            debugLogSafe(`ammo-depart failed: ${String(e)}`);
        }
    }

    // ── 生命周期：首拉+广播事件订阅+分钟针（30s——纯显示驱动，不触发读档） ──

    let minuteTimer: ReturnType<typeof setInterval> | null = null;

    function onAmmoStateEvent(): void {
        void reload();
    }

    /** 班表被改（前端编辑/kernel 晨滚广播）→下一发面重拉（schedNotify bust 同款事件链） */
    function onSchedUpdatedEvent(): void {
        void reloadBoard();
    }

    onMount(() => {
        nowMin = localNowMin();
        void reload().then(() => void reloadBoard());
        window.addEventListener("pj-ammo-state", onAmmoStateEvent);
        window.addEventListener("pj-schedule-updated", onSchedUpdatedEvent);
        minuteTimer = setInterval(() => {
            nowMin = localNowMin();
        }, 30_000);
        return () => {
            window.removeEventListener("pj-ammo-state", onAmmoStateEvent);
            window.removeEventListener("pj-schedule-updated", onSchedUpdatedEvent);
            if (minuteTimer) clearInterval(minuteTimer);
            minuteTimer = null;
        };
    });
</script>

<AmmoQuadrantPanel
    {t}
    day={data?.day ?? ""}
    pools={data?.pools ?? []}
    tasks={data?.tasks ?? []}
    circle={data?.circle ?? null}
    running={data?.running ?? null}
    dangling={data?.dangling ?? []}
    available={data?.available ?? false}
    note={data?.note}
    {loading}
    {nowMin}
    onRefresh={() => void reload()}
    onStart={(p) => void start(p)}
    onStop={() => void stop()}
    onReflect={(text) => reflect(text)}
    onResolve={(p) => void resolve(p)}
    nextAnchor={nextAnchor}
    onDepart={(a) => void depart(a)}
    onMoveTask={(p) => void moveTask(p)}
    onSetRatio={(p) => setRatio(p)}
    onSetFreq={(p) => setFreq(p)}
    onAversionAdd={(text) => aversionAdd(text)}
    onAversionRename={(p) => aversionRename(p)}
    onAversionRemove={(id) => aversionRemove(id)}
    health={health}
    healthLoading={healthLoading}
    onCheckHealth={() => void checkHealth()}
    onOpenBlock={openBlock}
    onOpenDayConfig={onOpenDayConfig}
    onOpenDiary={onOpenDiary}
/>
