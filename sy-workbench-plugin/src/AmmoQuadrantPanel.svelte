<script lang="ts">
    // ammo □6：四象限面板·纯内容组件（可挂载内容件——宿主=□9 悬浮窗外壳/开发期临时 Dialog）。
    // 契约=docs/ammo-concept.md A4（四池+中央圈）/A5（软配额照实显示不拦截）/A7（五视图·四象限
    // 面板行）：四池卡片（当日任务列表+池配比+消耗态）+中央不想做圈（鞭策墙=用户原话常驻+
    // 三分区——递镜子纪律：只显示用户自己写的，AI 从不产生新指责）+引擎动作行（开始/停止/
    // 感想记/悬账补结）。
    // 形态纪律：props 进数据、回调出动作，零 rpc/零挂载点/零 window 依赖——数据拉取与 rpc
    // 调用全部在宿主（AmmoPanelHost.svelte）；本组件可被任意容器 mount。
    // 渲染数据=core/ammoPanel.ts 合成产物（去重+each key 序号保底在合成层——重复 key=整面板
    // 冻结的防御不在此重复做，key 直接用合成层给的）。
    import type { AmmoPoolView, AmmoTaskView, AmmoCircleView } from "./kernel/core/ammoPanel";
    import { elapsedRunMin, fmtDuration, hearthFreqDisplay } from "./kernel/core/ammoPanel";
    import type { AmmoRunSnapshot, AmmoDanglingRef } from "./kernel/ammoEngine";
    import type { AmmoHealthReport } from "./kernel/ammoHealth";
    import type { AmmoPoolSlug } from "./kernel/core/ammoQuadrant";
    import type { AversionItem } from "./kernel/ammoQuadrant";
    import { AMMO_CARD_MIME, cardDataOf, encodeAmmoCard, hasAmmoCard, type AmmoCardData } from "./gui/ammoDrop";

    let {
        t,
        day,
        pools,
        tasks,
        circle,
        running,
        dangling,
        available,
        note,
        loading,
        nowMin,
        onRefresh,
        onStart,
        onStop,
        onReflect,
        onResolve,
        onOpenTask,
        nextAnchor,
        onDepart,
        onMoveTask,
        onSetRatio,
        onSetFreq,
        onAversionAdd,
        onAversionRename,
        onAversionRemove,
        health,
        healthLoading,
        onCheckHealth,
        onOpenBlock,
        onOpenDayConfig,
        onOpenDiary,
    }: {
        /** i18n 文案包（ammo* 键——zh/en 双语由宿主注入） */
        t: Record<string, string>;
        /** 落账日 YYYY-MM-DD（面板标题+悬账补结 day 参） */
        day: string;
        /** 四池视图（配比+消耗态——core buildPoolViews 产物） */
        pools: AmmoPoolView[];
        /** 当日任务行视图（含运行/悬账归属——core buildTaskViews 产物） */
        tasks: AmmoTaskView[];
        /** 中央不想做圈视图（鞭策墙+三分区） */
        circle: AmmoCircleView | null;
        /** 引擎运行中快照（null=无） */
        running: AmmoRunSnapshot | null;
        /** 悬账清单（补结条逐条出示） */
        dangling: AmmoDanglingRef[];
        /** 数据面可用性（false=note 空态展示） */
        available: boolean;
        note?: string;
        loading: boolean;
        /** 当日分钟针（宿主 30s 递推注入——运行时长/「已 X」显示驱动；组件不自跑 interval） */
        nowMin: number;
        /** 空刷新钮 */
        onRefresh: () => void;
        /** 开始任务（互斥：点开始=引擎自动闭前一个——软语义不弹确认） */
        onStart: (p: { task: string; pool: string; summary: string }) => void;
        /** 停止当前运行任务 */
        onStop: () => void;
        /** 感想记（blockId 缺省=运行中条目，kernel 侧解析）；resolve true=成功收起输入 */
        onReflect: (text: string) => Promise<boolean>;
        /** 悬账补结（含丢弃=end 用户自估） */
        onResolve: (p: { blockId: string; day: string; end: string }) => void;
        /** 任务名点击（可选——宿主接跳块通道；未接=纯文本） */
        onOpenTask?: (blockId: string) => void;
        /** 下一发锚点（dataview □3——宿主从当日班表算出的最早未到点行；null=无→横幅不出出发钮） */
        nextAnchor?: { key: string; summary: string; start: string } | null;
        /** 出发下一发（宿主接 ammo-depart rpc——闭当前+开锚点出发型；未接=纯显示面） */
        onDepart?: (a: { key: string; summary: string; start: string }) => void;
        /** 拖卡换池（dataview □5①——宿主接 ammo-move-pool rpc 单任务级写通道；未接=拖了不落盘） */
        onMoveTask?: (p: { task: string; name: string; pool: AmmoPoolSlug }) => void;
        /** 点池头改配比（dataview □5③——宿主接 ammo-set-ratio rpc □2 文本写通道；
         *  ratio=null=清配额。返回 false=写入失败（就地提示） */
        onSetRatio?: (p: { pool: AmmoPoolSlug; ratio: number | null }) => Promise<boolean>;
        /** 炉火最小频率就地改（第二批 R3——宿主接 ammo-set-freq rpc；freq 无自然文本形态=
         *  属性即真相〔契约 §2 例外条款〕，编辑入口在面板）；freq=null=清回缺省。
         *  未接=hearth 配置态不出频率输入（纯显示面） */
        onSetFreq?: (p: { pool: AmmoPoolSlug; freq: number | null }) => Promise<boolean>;
        /** 不想做条目手动新增（manualui——中央圈可编辑面；宿主接 aversion-write rpc）。
         *  kind 恒 vow（手动通道不暴露 avatar/capPool 高级字段——AI 对话仍可补）；
         *  返回 false=写入失败（就地提示）。未接=纯显示面（+ 钮不出） */
        onAversionAdd?: (text: string) => Promise<boolean>;
        /** 不想做条目改文（点 chip 文本=行内编辑）。kind/avatar/capPool 从读面透传——
         *  kernel 同 kind 原地更新会确定性重挂全键属性，不透传=fear 化身/swallow 物化池被清空。
         *  未接=chip 文本纯显示不可点 */
        onAversionRename?: (p: { id: string; text: string; kind: string; avatar?: string; capPool?: string }) => Promise<boolean>;
        /** 不想做条目删除（chip × 钮——直接删不弹确认，AI 面同款语义）。未接=× 钮不出 */
        onAversionRemove?: (id: string) => Promise<boolean>;
        /** 格式体检报告（dataview □8——宿主接 ammo-health rpc；未拉/未接=钮不出清单） */
        health?: AmmoHealthReport | null;
        /** 体检拉取中（展开区显示读取态） */
        healthLoading?: boolean;
        /** 体检展开/重拉（宿主接 rpc；点击钮=展开+拉新） */
        onCheckHealth?: () => void;
        /** 体检条目点击跳转（宿主接 openDocNoFocus——cb-get-hl 禁聚焦政策；未接=纯文本行） */
        onOpenBlock?: (blockId: string) => void;
        /** 头栏跳每日配置月文档（mainfix0923 □5——宿主接 openDayConfigDoc：定位不到=toast；
         *  未接=钮不出） */
        onOpenDayConfig?: () => void;
        /** 头栏跳当日日记（mainfix0923 □5——宿主接 openTodayDiary：定位不到=toast；未接=钮不出） */
        onOpenDiary?: () => void;
    } = $props();

    // ── 本地交互态 ──
    /** 正在记感想的行（each key；null=无） */
    let noteOpenKey = $state<string | null>(null);
    let noteDraft = $state("");
    let noteInputEl = $state<HTMLInputElement | null>(null);
    let noteError = $state("");
    /** 悬账补结输入（blockId → end 草稿） */
    let resolveDrafts = $state<Record<string, string>>({});
    /** 悬账条展开态（默认展开——悬账=事故现场，须上浮不折叠） */
    const pad2 = (n: number) => String(n).padStart(2, "0");

    // ── dataview □8：格式体检（fail-soft 的可见面——三类发现汇总+点击跳转） ──
    /** 体检区展开态（收起=零渲染；每次展开拉新——rpc 单发成本≈0，悬浮窗重开同哲学） */
    let healthOpen = $state(false);

    function toggleHealth(): void {
        if (!onCheckHealth) return; // 宿主未接=纯显示面（钮隐藏态不出清单）
        if (healthOpen) {
            healthOpen = false;
            return;
        }
        healthOpen = true;
        onCheckHealth();
    }

    /** 三分类呈现序（①分区结构②未认行③冲突——结构问题影响面最大排最先） */
    const HEALTH_CATS = ["sections", "unrecognized", "conflict"] as const;

    function healthItemsOf(cat: string) {
        return (health?.items ?? []).filter((x) => x.category === cat);
    }

    /** 体检行点击=跳对应文档位置（宿主 onOpenBlock=openDocNoFocus——cb-get-hl 只滚动定位
     *  禁聚焦；无目标块/宿主未接=纯文本行不挂链） */
    function openHealthItem(blockId: string | null): void {
        if (blockId && onOpenBlock) onOpenBlock(blockId);
    }

    // ── dataview □5：拖卡换池（拖源+池体落点）──
    /** 拖动中的行（each key；视觉压暗+自身池不亮落点态） */
    let dragKey = $state<string | null>(null);
    /** 拖动悬停的池 slug（落点高亮） */
    let dropPool = $state<string | null>(null);

    function rowDragStart(e: DragEvent, row: AmmoTaskView): void {
        if (!e.dataTransfer) return;
        const card: AmmoCardData = { task: row.task, name: row.name, pool: row.pool, quota: row.quota };
        e.dataTransfer.setData(AMMO_CARD_MIME, encodeAmmoCard(card));
        e.dataTransfer.setData("text/plain", encodeAmmoCard(card)); // 镜像兜底（cardDataOf 消费）
        e.dataTransfer.effectAllowed = "move";
        dragKey = row.key;
    }

    function rowDragEnd(): void {
        dragKey = null;
        dropPool = null;
    }

    /** 池体落点守门：只认本源拖卡 MIME（任意文本拖拽不抢事件不亮态） */
    function poolDragOver(e: DragEvent, pool: string): void {
        if (!hasAmmoCard(e.dataTransfer?.types)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        dropPool = pool;
    }

    function poolDragLeave(pool: string): void {
        if (dropPool === pool) dropPool = null;
    }

    function poolDrop(e: DragEvent, pool: AmmoPoolSlug): void {
        dropPool = null;
        const card = cardDataOf(e.dataTransfer);
        if (!card) return; // 非本源载荷（MIME 缺）=静默弃
        e.preventDefault();
        // 同池落回=kernel 幂等零写（moved:false），照走统一链不特判
        onMoveTask?.({ task: card.task, name: card.name, pool });
    }

    // ── dataview □5③：点池头=配比配置态（数字就地改——gold 保底/hearth 上限；deadline/crumbs
    //    无数字语义不进配置态〔B3 词表：不保底不设限〕）。第二批 R3：hearth 配置态加 freq
    //    就地编辑（最小频率天数——freq 无自然文本形态=属性即真相〔契约 §2 例外条款〕，
    //    编辑入口在面板；空=清回缺省 DEFAULT_HEARTH_FREQ） ──
    /** 配置态池 slug（null=无） */
    let ratioEditPool = $state<string | null>(null);
    let ratioDraft = $state("");
    /** hearth 频率草稿（仅 hearth 配置态在场；空=清回缺省） */
    let freqDraft = $state("");
    let ratioError = $state("");
    let ratioInputEl = $state<HTMLInputElement | null>(null);

    /** 有配比数字语义的池（点击池头进配置态） */
    function ratioEditable(p: AmmoPoolView): boolean {
        return p.pool === "gold" || p.pool === "hearth";
    }

    function openRatioEdit(p: AmmoPoolView): void {
        if (!ratioEditable(p) || !onSetRatio) return; // 无数字语义/宿主未接=纯显示面
        ratioEditPool = ratioEditPool === p.pool ? null : p.pool; // 再点同头=收
        ratioDraft = p.ratio != null ? String(p.ratio) : "";
        freqDraft = p.freq != null ? String(p.freq) : ""; // 无值=空（空输入=清回缺省）
        ratioError = "";
    }

    /** 提交配置态（表单整存语义）：hearth 的 ratio/freq 两输入一态同存，任一提交触发
     *  （回车/焦点离开编辑区）=两个字段一起落——kernel 侧幂等（未变字段零文本重写），
     *  避免双输入各自失焦的「切个焦点就半提交」歧义。空=清（ratio 删 Nmin 尾语义 /
     *  freq 清回缺省）；非正整数=就地报错不收。
     *  draft 归一：bind:value 挂 type=number 输入框——Svelte 把值 coerce 成 number|null
     *  （空/坏输入=null），此处统一回字符串再校验。 */
    async function commitPoolEdit(p: AmmoPoolView): Promise<void> {
        const raw = ratioDraft == null ? "" : String(ratioDraft).trim();
        let ratio: number | null = null;
        if (raw) {
            if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
                ratioError = t.ammoRatioInvalid ?? "";
                return;
            }
            ratio = Number(raw);
        }
        const wantsFreq = p.pool === "hearth" && Boolean(onSetFreq);
        let freq: number | null = null;
        if (wantsFreq) {
            const rawFreq = freqDraft == null ? "" : String(freqDraft).trim();
            if (rawFreq) {
                if (!/^\d+$/.test(rawFreq) || Number(rawFreq) <= 0) {
                    ratioError = t.ammoFreqInvalid ?? "";
                    return;
                }
                freq = Number(rawFreq);
            }
        }
        const okRatio = (await onSetRatio?.({ pool: p.pool, ratio })) ?? true;
        const okFreq = wantsFreq ? ((await onSetFreq?.({ pool: p.pool, freq })) ?? true) : true;
        if (okRatio && okFreq) {
            // 身份守卫：await 期间用户已点开别的池头=不抢关不劫drafts（旧版无此守卫，跨池快速
            // 连点会把关开一半的下一个配置态打回）
            if (ratioEditPool === p.pool) {
                ratioEditPool = null;
                ratioDraft = "";
                freqDraft = "";
                ratioError = "";
            }
        } else {
            ratioError = !okRatio ? (t.ammoRatioFail ?? "") : (t.ammoFreqFail ?? "");
        }
    }

    function cancelRatioEdit(): void {
        ratioEditPool = null;
        ratioDraft = "";
        freqDraft = "";
        ratioError = "";
    }

    // ── manualui：中央圈手动编辑（不想做清单增/删/改——全点击交互，零拖拽；红线=中央圈
    //    永不接 drop 不动，此处不碰任何 drag 事件） ──
    /** 新增输入展开态（再点 + =收，openNote 同款轻交互） */
    let avAddOpen = $state(false);
    let avAddDraft = $state("");
    let avAddInputEl = $state<HTMLInputElement | null>(null);
    /** 正在改文的条目 id（编辑态=该 chip 文本位换输入框） */
    let avEditId = $state<string | null>(null);
    let avEditDraft = $state("");
    let avEditInputEl = $state<HTMLInputElement | null>(null);
    /** 增/删/改共用的就地错误提示 */
    let avError = $state("");

    function toggleAvAdd(): void {
        avAddOpen = !avAddOpen;
        avAddDraft = "";
        avError = "";
    }

    /** 新增提交：Enter 落盘（kind 恒 vow——宿主侧固定）；空文本=纯收起不写 */
    async function commitAvAdd(): Promise<void> {
        const text = avAddDraft.trim();
        if (!text) {
            avAddOpen = false;
            return;
        }
        const ok = (await onAversionAdd?.(text)) ?? true;
        if (ok) {
            avAddOpen = false;
            avAddDraft = "";
            avError = "";
        } else {
            avError = t.ammoAversionFail ?? "";
        }
    }

    function openAvEdit(a: AversionItem): void {
        if (!onAversionRename) return; // 宿主未接=纯显示面
        avEditId = a.id;
        avEditDraft = a.text;
        avError = "";
    }

    /** 改文提交：Enter 落盘（kind/高级字段透传保分区不丢化身）；空文本=收起不改（删走 × 钮） */
    async function commitAvEdit(a: AversionItem): Promise<void> {
        const text = avEditDraft.trim();
        if (!text) {
            avEditId = null;
            return;
        }
        const ok = (await onAversionRename?.({
            id: a.id,
            text,
            kind: a.kind,
            // 高级字段只在守卫认可的 kind 下透传（vow 条目带杂属性会被 core 守卫整轮拒）
            ...(a.kind === "fear" && a.avatar ? { avatar: a.avatar } : {}),
            ...(a.kind === "swallow" && a.capPool ? { capPool: a.capPool } : {}),
        })) ?? true;
        if (ok) {
            avEditId = null;
            avEditDraft = "";
            avError = "";
        } else {
            avError = t.ammoAversionFail ?? "";
        }
    }

    /** 删除（直接删不弹确认——低风险、AI 面同款语义；× 钮只在宿主接删除通道时渲染） */
    async function removeAvItem(id: string): Promise<void> {
        const ok = (await onAversionRemove?.(id)) ?? true;
        if (!ok) avError = t.ammoAversionFail ?? "";
    }

    /** 运行已走分钟（elapsedRunMin 容差版：跨零点=昨日续跑 +24h 归一，容差带内负差钳 0——
     *  引擎 □3 同口径；09-23 实锤：nowMin 30s 递推滞后曾把 -1 抖动放大成 23h 59m） */
    const runningMin = $derived.by(() => (running ? elapsedRunMin(running.start, nowMin) : 0));

    const hasConfig = $derived(pools.some((p) => p.ratio != null) || tasks.length > 0);

    /** 运行归属=组件本地派生（真身=running 快照，回包即时驱动）：kernel 合成层的 row.running
     *  是拉取时点快照——点开始后 rev 相同的重拉会被跳过（防回声抖动），本地派生保证行态
     *  与横幅同帧切换。判定口径与 core buildTaskViews 一致（树块 id 精确匹配/无主行回退
     *  池+名字；锚点出发型不占池内行）。 */
    function isRunning(row: AmmoTaskView): boolean {
        if (!running || running.anchor) return false;
        return row.task ? running.task === row.task : running.pool === row.pool && running.summary === row.name;
    }

    function tasksOf(pool: string): AmmoTaskView[] {
        return tasks.filter((x) => x.pool === pool);
    }

    function openNote(key: string): void {
        noteOpenKey = noteOpenKey === key ? null : key; // 再点同钮=收（Timeline 记钮同款轻交互）
        noteDraft = "";
        noteError = "";
    }

    async function commitNote(): Promise<void> {
        const text = noteDraft.trim();
        if (!text) {
            noteOpenKey = null; // 空文本=纯收起不写
            return;
        }
        const ok = await onReflect(text);
        if (ok) {
            noteOpenKey = null;
            noteDraft = "";
            noteError = "";
        } else {
            noteError = t.ammoNoteFail;
        }
    }

    function resolveEndOf(blockId: string): string {
        return resolveDrafts[blockId] ?? `${pad2(Math.floor(nowMin / 60) % 24)}:${pad2(nowMin % 60)}`;
    }

    function setResolveDraft(blockId: string, v: string): void {
        resolveDrafts = { ...resolveDrafts, [blockId]: v };
    }

    // 记输入框自动聚焦（key 变化→DOM 挂载后时机，Timeline 先例）
    $effect(() => {
        noteOpenKey;
        noteInputEl?.focus();
    });

    // 配比输入自动聚焦+全选（就地改数字——选中态直接覆盖输入）
    $effect(() => {
        ratioEditPool;
        ratioInputEl?.focus();
        ratioInputEl?.select();
    });

    // 不想做新增输入自动聚焦（manualui——key 变化→DOM 挂载后时机，noteInputEl 同款）
    $effect(() => {
        avAddOpen;
        avAddInputEl?.focus();
    });

    // 不想做改文输入自动聚焦+全选（选中态直接覆盖输入）
    $effect(() => {
        avEditId;
        avEditInputEl?.focus();
        avEditInputEl?.select();
    });

    /** 配比标签（gold=保底 Xmin / hearth=上限 Xmin · 最小频率 N 天 / 无数字=今日未设） */
    function quotaLabel(p: AmmoPoolView): string {
        if (p.ratio == null) return t.ammoNoRatio;
        if (p.pool === "hearth") return `${t.ammoCap} ${p.ratio}min · ${t.ammoFreq} ${hearthFreqDisplay(p.freq)}d`;
        if (p.pool === "gold") return `${t.ammoFloor} ${p.ratio}min`;
        return `${p.ratio}min`;
    }

    /** 消耗态文案（已消耗/多用 X/还差 X/实吃 X——照实不评判，A5） */
    function burnLabel(p: AmmoPoolView): string {
        if (p.state === "done") return t.ammoConsumed;
        if (p.state === "over") return `${t.ammoOver} ${p.deltaMin}min`;
        if (p.state === "left") return `${t.ammoLeft} ${p.deltaMin}min`;
        if (p.state === "plain") return `${t.ammoPlain} ${p.actualMin}min`;
        return "";
    }
</script>

<div class="pj-ammo" data-day={day}>
    {#if loading}
        <div class="pj-ammo__empty">{t.ammoLoading}</div>
    {:else}
        <div class="pj-ammo__head">
            <!-- P2①：内容头只留日期——标题由宿主壳层自带（悬浮窗头栏/dock 面板栏恒显「弹药库」，
                 内容头重复同题曾致 vision 终审 P2） -->
            <span class="pj-ammo__date">{day}</span>
            {#if running}
                <span class="pj-ammo__runchip" class:pj-ammo__runchip--anchor={running.anchor}>
                    ● {running.anchor ? t.ammoAnchorTag : ""}{running.summary} · {fmtDuration(runningMin) || "0m"}
                </span>
            {/if}
            <!-- mainfix0923 □5：文件地图跳转钮（每日配置月文档/当日日记——宿主接
                 openDayConfigDoc/openTodayDiary：定位不到=toast 不懒建；未接=钮不出。
                 iconList/iconFile=litheness 真表核过〔docs/材料/可以用的图标.md 有 symbol 体〕） -->
            {#if onOpenDayConfig}
                <button
                    class="pj-ammo__icon-btn pj-ammo__jump-btn"
                    onclick={onOpenDayConfig}
                    title={t.ammoOpenDayConfig}
                    aria-label={t.ammoOpenDayConfig}
                >
                    <svg><use xlink:href="#iconList"></use></svg>
                </button>
            {/if}
            {#if onOpenDiary}
                <button
                    class="pj-ammo__icon-btn pj-ammo__jump-btn"
                    onclick={onOpenDiary}
                    title={t.ammoOpenDiary}
                    aria-label={t.ammoOpenDiary}
                >
                    <svg><use xlink:href="#iconFile"></use></svg>
                </button>
            {/if}
            <!-- dataview □8：格式体检入口（fail-soft 的可见面——发现数徽标常驻提示，
                 展开=拉新汇总清单） -->
            {#if onCheckHealth}
                <button
                    class="pj-ammo__icon-btn pj-ammo__health-btn"
                    class:pj-ammo__icon-btn--active={healthOpen}
                    onclick={() => toggleHealth()}
                    title={t.ammoHealthBtn}
                    aria-label={t.ammoHealthBtn}
                >
                    <svg><use xlink:href="#iconShieldCheck"></use></svg>
                    {#if health && health.items.length}<span class="pj-ammo__health-badge">{health.items.length}</span>{/if}
                </button>
            {/if}
            <button class="pj-ammo__icon-btn pj-ammo__refresh" onclick={() => onRefresh()} title={t.ammoRefresh} aria-label={t.ammoRefresh}>
                <svg><use xlink:href="#iconRefresh"></use></svg>
            </button>
        </div>

        {#if healthOpen}
            <div class="pj-ammo__health">
                {#if healthLoading}
                    <div class="pj-ammo__health-empty">{t.ammoHealthLoading}</div>
                {:else if !health}
                    <div class="pj-ammo__health-empty">{t.ammoHealthFail}</div>
                {:else}
                    {#if health.errors?.length}
                        <div class="pj-ammo__health-err">
                            {#each health.errors as e, i (`err#${i}`)}<div class="pj-ammo__health-err-line">{e}</div>{/each}
                        </div>
                    {/if}
                    {#if !health.items.length && !(health.errors?.length)}
                        <div class="pj-ammo__health-empty">{t.ammoHealthEmpty}</div>
                    {/if}
                    {#each HEALTH_CATS as cat (cat)}
                        {#if healthItemsOf(cat).length}
                            <div class="pj-ammo__health-cat">{t[`ammoHealthCat_${cat}`] ?? cat}</div>
                            {#each healthItemsOf(cat) as h, i (`${cat}#${i}`)}
                                {#if h.blockId && onOpenBlock}
                                    <button class="pj-ammo__health-row pj-ammo__health-row--link" onclick={() => openHealthItem(h.blockId)} title={t.ammoHealthOpen}>
                                        <span class="pj-ammo__health-dom">{t[`ammoHealthDom_${h.domain}`] ?? h.domain}</span>
                                        <span class="pj-ammo__health-main">
                                            <span class="pj-ammo__health-text">{h.text}</span>
                                            {#if h.detail}<span class="pj-ammo__health-detail">{h.detail}</span>{/if}
                                        </span>
                                    </button>
                                {:else}
                                    <div class="pj-ammo__health-row">
                                        <span class="pj-ammo__health-dom">{t[`ammoHealthDom_${h.domain}`] ?? h.domain}</span>
                                        <span class="pj-ammo__health-main">
                                            <span class="pj-ammo__health-text">{h.text}</span>
                                            {#if h.detail}<span class="pj-ammo__health-detail">{h.detail}</span>{/if}
                                        </span>
                                    </div>
                                {/if}
                            {/each}
                        {/if}
                    {/each}
                {/if}
            </div>
        {/if}

        {#if running}
            <div class="pj-ammo__runbar">
                <span class="pj-ammo__runbar-dot" aria-hidden="true"></span>
                <span class="pj-ammo__runbar-main">
                    {running.summary}
                    <span class="pj-ammo__runbar-time">{running.start} → {fmtDuration(runningMin) || "0m"}</span>
                    {#if running.anchor}<span class="pj-ammo__tag pj-ammo__tag--anchor">{t.ammoAnchorTag}</span>{/if}
                </span>
                {#if nextAnchor && onDepart}
                    <button
                        class="pj-ammo__depart-btn"
                        onclick={() => onDepart(nextAnchor)}
                        title={`${nextAnchor.start} ${nextAnchor.summary}`}
                        aria-label={`${t.ammoDepartNext} ${nextAnchor.start} ${nextAnchor.summary}`}
                    >
                        <svg><use xlink:href="#iconPlay"></use></svg>{t.ammoDepartNext}
                    </button>
                {/if}
                <button class="pj-ammo__stop-btn" onclick={() => onStop()} title={t.ammoStop} aria-label={t.ammoStop}>
                    <svg><use xlink:href="#iconPause"></use></svg>{t.ammoStop}
                </button>
            </div>
        {/if}

        {#if dangling.length}
            <div class="pj-ammo__dangling">
                <div class="pj-ammo__dangling-title">⚠ {t.ammoDanglingTitle}</div>
                {#each dangling as d (d.blockId)}
                    <div class="pj-ammo__dangling-row">
                        <span class="pj-ammo__dangling-main" title={`${d.day} ${d.start}`}>
                            {d.day} {d.start} · {d.summary}
                        </span>
                        <input
                            class="b3-text-field pj-ammo__dangling-time"
                            type="time"
                            value={resolveEndOf(d.blockId)}
                            onchange={(e: Event) => setResolveDraft(d.blockId, (e.target as HTMLInputElement).value)}
                        />
                        <button class="pj-ammo__mini-btn" onclick={() => onResolve({ blockId: d.blockId, day, end: resolveEndOf(d.blockId) })}>
                            {t.ammoResolve}
                        </button>
                    </div>
                {/each}
            </div>
        {/if}

        {#if !available}
            <div class="pj-ammo__empty">{note || t.ammoUnavailable}</div>
        {:else if !hasConfig}
            <div class="pj-ammo__empty">{t.ammoNoConfig}</div>
        {/if}

        <!-- manualui：不想做条目 chip（三分区共用——点文本=行内改文、× =直接删；
             宿主未接写通道=纯文本老形态） -->
        {#snippet avChip(a: AversionItem, tip: string)}
            {#if avEditId === a.id}
                <!-- 编辑态=chip 文本位换输入框（Enter 落盘/Esc 收起/空文本收起不改——删走 × 钮） -->
                <input
                    bind:this={avEditInputEl}
                    class="b3-text-field pj-ammo__av-edit"
                    type="text"
                    maxlength="100"
                    bind:value={avEditDraft}
                    onkeydown={(e: KeyboardEvent) => {
                        if (e.isComposing) return; // IME 组字确认键不误触发
                        if (e.key === "Enter") {
                            e.preventDefault();
                            void commitAvEdit(a);
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            avEditId = null;
                        }
                    }}
                />
                {#if avError}<span class="pj-ammo__note-error">{avError}</span>{/if}
            {:else}
                <span class="pj-ammo__sec-chip">
                    {#if onAversionRename}
                        <button class="pj-ammo__sec-item pj-ammo__sec-item--edit" onclick={() => openAvEdit(a)} title={tip}>{a.text}</button>
                    {:else}
                        <span class="pj-ammo__sec-item" title={tip}>{a.text}</span>
                    {/if}
                    {#if onAversionRemove}
                        <button class="pj-ammo__sec-x" onclick={() => void removeAvItem(a.id)} title={t.ammoAversionRemove} aria-label={t.ammoAversionRemove}>×</button>
                    {/if}
                </span>
            {/if}
        {/snippet}
        {#if circle && (circle.whip.length || circle.vows.length || circle.fears.length || circle.swallows.length || onAversionAdd)}
            <!-- dataview □5 红线：中央圈永不接 drop——「拖进中央圈=转不想做」不做（不想做是承诺
                 不是垃圾桶，转不想做走 AI 见证 syncAversions 面）。此处零拖拽事件接线。 -->
            <div class="pj-ammo__circle" aria-label={t.ammoCircleTitle}>
                <div class="pj-ammo__circle-badge">
                    <span class="pj-ammo__circle-badge-ring" aria-hidden="true"></span>
                    <span class="pj-ammo__circle-badge-text">{t.ammoCircleTitle}</span>
                    {#if onAversionAdd}
                        <!-- manualui：+ 钮（行内输入新增——Enter 提交/Esc 收起/空文本收起；kind 恒 vow） -->
                        <button class="pj-ammo__av-add-btn" onclick={() => toggleAvAdd()} title={t.ammoAversionAdd} aria-label={t.ammoAversionAdd}>+</button>
                    {/if}
                </div>
                {#if avAddOpen}
                    <div class="pj-ammo__av-add">
                        <input
                            bind:this={avAddInputEl}
                            class="b3-text-field"
                            type="text"
                            maxlength="100"
                            placeholder={t.ammoAversionPlaceholder}
                            bind:value={avAddDraft}
                            onkeydown={(e: KeyboardEvent) => {
                                if (e.isComposing) return; // IME 组字确认键不误触发
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    void commitAvAdd();
                                } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    avAddOpen = false;
                                    avAddDraft = "";
                                }
                            }}
                        />
                        {#if avError}<span class="pj-ammo__note-error">{avError}</span>{/if}
                    </div>
                {/if}
                {#if circle.whip.length}
                    <div class="pj-ammo__whip">
                        {#each circle.whip as w, i (`${w}#${i}`)}
                            <span class="pj-ammo__whip-line">「{w}」</span>
                        {/each}
                    </div>
                {/if}
                <div class="pj-ammo__sections">
                    {#if circle.vows.length}
                        <div class="pj-ammo__section">
                            <span class="pj-ammo__kind pj-ammo__kind--vow">{circle.titles?.vow || t.ammoKindVow}</span>
                            {#each circle.vows as a (a.id)}{@render avChip(a, a.at)}{/each}
                        </div>
                    {/if}
                    {#if circle.fears.length}
                        <div class="pj-ammo__section">
                            <span class="pj-ammo__kind pj-ammo__kind--fear">{circle.titles?.fear || t.ammoKindFear}</span>
                            {#each circle.fears as a (a.id)}{@render avChip(a, a.avatar ? `${t.ammoAvatarOf} ${a.avatar.slice(0, 8)}` : a.at)}{/each}
                        </div>
                    {/if}
                    {#if circle.swallows.length}
                        <div class="pj-ammo__section">
                            <span class="pj-ammo__kind pj-ammo__kind--swallow">{circle.titles?.swallow || t.ammoKindSwallow}</span>
                            {#each circle.swallows as a (a.id)}{@render avChip(a, a.capPool || a.at)}{/each}
                        </div>
                    {/if}
                </div>
            </div>
        {/if}

        <div class="pj-ammo__grid">
            {#each pools as p (p.pool)}
                <section
                    class="pj-ammo__pool"
                    data-pool={p.pool}
                    class:pj-ammo__pool--over={p.state === "over"}
                    class:pj-ammo__pool--drop={dropPool === p.pool && dragKey !== null}
                >
                    <!-- 点池头=配比配置态（□5③：数字就地改——gold/hearth 有数字语义；其余纯显示）。
                         键盘/手编通道=文档行文本直改（契约 §6 双通道：参数编辑就地、内容编辑跳文档），
                         header 点击=鼠标增强面故 a11y 双豁免 -->
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <header
                        class="pj-ammo__pool-head"
                        class:pj-ammo__pool-head--edit={ratioEditable(p) && Boolean(onSetRatio)}
                        onclick={() => openRatioEdit(p)}
                    >
                        <span class="pj-ammo__pool-dot" data-pool={p.pool} aria-hidden="true"></span>
                        <span class="pj-ammo__pool-name">{t[`ammoPool_${p.pool}`] ?? p.pool}</span>
                        {#if ratioEditPool === p.pool}
                            <!-- 配置态=微型表单：回车=整存（ratio/freq 两字段一起落——kernel 幂等，
                                 未变字段零文本重写）；焦点离开编辑区（focusout 冒泡到本 span 且
                                 relatedTarget 不在区内）=同款整存，两输入间切换不触发半提交；
                                 Escape=整收零提交 -->
                            <span
                                class="pj-ammo__ratio-edit"
                                onfocusout={(e: FocusEvent) => {
                                    if (ratioEditPool !== p.pool || ratioError) return;
                                    const to = e.relatedTarget as HTMLElement | null;
                                    if (to && typeof to.closest === "function" && to.closest(".pj-ammo__ratio-edit")) return;
                                    void commitPoolEdit(p);
                                }}
                            >
                                <input
                                    bind:this={ratioInputEl}
                                    class="b3-text-field pj-ammo__ratio-input"
                                    type="number"
                                    min="1"
                                    step="5"
                                    inputmode="numeric"
                                    placeholder={t.ammoRatioPlaceholder ?? ""}
                                    bind:value={ratioDraft}
                                    onkeydown={(e: KeyboardEvent) => {
                                        if (e.isComposing) return; // IME 组字确认键不误触发
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            void commitPoolEdit(p);
                                        } else if (e.key === "Escape") {
                                            e.preventDefault();
                                            cancelRatioEdit();
                                        }
                                    }}
                                    onclick={(e: MouseEvent) => e.stopPropagation()}
                                />
                                <span class="pj-ammo__ratio-unit">min</span>
                                {#if p.pool === "hearth" && onSetFreq}
                                    <span class="pj-ammo__ratio-sep">·</span>
                                    <span class="pj-ammo__freq-label">{t.ammoFreq}</span>
                                    <input
                                        class="b3-text-field pj-ammo__ratio-input pj-ammo__freq-input"
                                        type="number"
                                        min="1"
                                        step="1"
                                        inputmode="numeric"
                                        placeholder={t.ammoFreqPlaceholder ?? ""}
                                        bind:value={freqDraft}
                                        onkeydown={(e: KeyboardEvent) => {
                                            if (e.isComposing) return; // IME 组字确认键不误触发
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                void commitPoolEdit(p);
                                            } else if (e.key === "Escape") {
                                                e.preventDefault();
                                                cancelRatioEdit();
                                            }
                                        }}
                                        onclick={(e: MouseEvent) => e.stopPropagation()}
                                    />
                                    <span class="pj-ammo__ratio-unit">d</span>
                                {/if}
                                {#if ratioError}<span class="pj-ammo__note-error">{ratioError}</span>{/if}
                            </span>
                        {:else if p.ratio != null}
                            <span class="pj-ammo__pool-quota">{quotaLabel(p)}</span>
                        {/if}
                        {#if p.state === "over"}
                            <span class="pj-ammo__burn pj-ammo__burn--over">{burnLabel(p)}</span>
                        {:else if p.state === "done"}
                            <span class="pj-ammo__burn pj-ammo__burn--done">{burnLabel(p)}</span>
                        {:else if p.state === "left"}
                            <span class="pj-ammo__burn pj-ammo__burn--left">{burnLabel(p)}</span>
                        {:else if p.state === "plain"}
                            <span class="pj-ammo__burn">{burnLabel(p)}</span>
                        {/if}
                    </header>
                    <!-- 池体=拖卡落点（□5① 换池调档——onMoveTask 单任务级写通道）。拖拽=鼠标增强面
                         （键盘等效=文档行直改+□7 徽标编辑面），a11y 豁免同 header -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                        class="pj-ammo__pool-body"
                        ondragover={(e: DragEvent) => poolDragOver(e, p.pool)}
                        ondragleave={() => poolDragLeave(p.pool)}
                        ondrop={(e: DragEvent) => poolDrop(e, p.pool)}
                    >
                        {#if tasksOf(p.pool).length === 0}
                            <div class="pj-ammo__pool-empty">{t.ammoPoolEmpty}</div>
                        {:else}
                            {#each tasksOf(p.pool) as row (row.key)}
                                <!-- svelte-ignore a11y_no_static_element_interactions -->
                                <div
                                    class="pj-ammo__row"
                                    class:pj-ammo__row--running={isRunning(row)}
                                    class:pj-ammo__row--dangling={row.dangling}
                                    class:pj-ammo__row--dragging={dragKey === row.key}
                                    draggable="true"
                                    ondragstart={(e: DragEvent) => rowDragStart(e, row)}
                                    ondragend={rowDragEnd}
                                >
                                    <div class="pj-ammo__row-line">
                                        <span class="pj-ammo__mount" title={t.ammoMountOf}>×</span>
                                        {#if row.task && onOpenTask}
                                            <button class="pj-ammo__row-name pj-ammo__row-name--link" onclick={() => onOpenTask?.(row.task)} title={t.ammoOpenTask}>{row.name}</button>
                                        {:else}
                                            <span class="pj-ammo__row-name" title={row.name}>{row.name}</span>
                                        {/if}
                                        {#if row.quota != null}<span class="pj-ammo__row-quota">{row.quota}m</span>{/if}
                                        {#if isRunning(row)}
                                            <span class="pj-ammo__row-run">● {fmtDuration(runningMin) || "0m"}</span>
                                        {/if}
                                        {#if row.dangling}
                                            <span class="pj-ammo__tag pj-ammo__tag--dangling">{t.ammoDanglingTag}</span>
                                        {/if}
                                        <span class="pj-ammo__row-actions">
                                            {#if isRunning(row)}
                                                <button class="pj-ammo__stop-btn pj-ammo__stop-btn--row" onclick={() => onStop()} title={t.ammoStop} aria-label={t.ammoStop}>
                                                    <svg><use xlink:href="#iconPause"></use></svg>
                                                </button>
                                            {:else}
                                                <button
                                                    class="pj-ammo__start-btn"
                                                    onclick={() => onStart({ task: row.task, pool: row.pool, summary: row.name })}
                                                    title={running ? t.ammoStartSwitch : t.ammoStart}
                                                    aria-label={t.ammoStart}
                                                >
                                                    <svg><use xlink:href="#iconPlay"></use></svg>
                                                </button>
                                            {/if}
                                            <button class="pj-ammo__icon-btn" class:pj-ammo__icon-btn--active={noteOpenKey === row.key} onclick={() => openNote(row.key)} title={t.ammoNoteBtn} aria-label={t.ammoNoteBtn}>
                                                <svg><use xlink:href="#iconEdit"></use></svg>
                                            </button>
                                        </span>
                                    </div>
                                    {#if noteOpenKey === row.key}
                                        <div class="pj-ammo__note">
                                            <input
                                                bind:this={noteInputEl}
                                                class="b3-text-field"
                                                type="text"
                                                maxlength="500"
                                                placeholder={t.ammoNotePlaceholder}
                                                bind:value={noteDraft}
                                                onkeydown={(e: KeyboardEvent) => {
                                                    if (e.isComposing) return; // IME 组字确认键不误触发
                                                    if (e.key === "Enter") {
                                                        e.preventDefault();
                                                        void commitNote();
                                                    } else if (e.key === "Escape") {
                                                        e.preventDefault();
                                                        openNote(row.key);
                                                    }
                                                }}
                                            />
                                            {#if noteError}<span class="pj-ammo__note-error">{noteError}</span>{/if}
                                        </div>
                                    {/if}
                                </div>
                            {/each}
                        {/if}
                    </div>
                </section>
            {/each}
        </div>
    {/if}
</div>

<style lang="scss">
    .pj-ammo {
        height: 100%;
        min-width: 0;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px 10px;
        font-size: 12px;
        color: var(--b3-theme-on-background);
        overflow-y: auto;
    }

    .pj-ammo__empty {
        padding: 14px 8px;
        text-align: center;
        color: var(--b3-theme-on-surface);
        font-size: 12px;
    }

    .pj-ammo__head {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 2px 6px;
        border-bottom: 1px solid var(--b3-border-color);
    }

    .pj-ammo__date {
        font-variant-numeric: tabular-nums;
        color: var(--b3-theme-on-surface);
    }

    .pj-ammo__runchip {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--b3-theme-primary);
        font-variant-numeric: tabular-nums;
    }

    .pj-ammo__icon-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--b3-theme-on-surface);
        cursor: pointer;

        svg {
            width: 12px;
            height: 12px;
        }

        &:hover {
            background: var(--b3-theme-surface);
            color: var(--b3-theme-on-background);
        }
    }

    .pj-ammo__icon-btn--active {
        background: var(--b3-theme-primary-lightest);
        color: var(--b3-theme-primary);
    }

    // ── 格式体检（dataview □8——fail-soft 的可见面：三类发现汇总+点击跳转） ──
    .pj-ammo__health-btn {
        position: relative;
    }

    /* 发现数徽标（有发现常驻提示——fail-soft 不拦人但可见） */
    .pj-ammo__health-badge {
        position: absolute;
        top: -4px;
        right: -6px;
        min-width: 13px;
        padding: 0 3px;
        border-radius: 7px;
        background: var(--b3-card-warning-color, #d97706);
        color: var(--b3-theme-on-primary, #fff);
        font-size: 9px;
        line-height: 13px;
        font-variant-numeric: tabular-nums;
        pointer-events: none;
    }

    .pj-ammo__health {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-surface);
        max-height: 40vh;
        overflow-y: auto;
    }

    .pj-ammo__health-empty {
        padding: 4px 2px;
        text-align: center;
        color: var(--b3-theme-on-surface);
    }

    .pj-ammo__health-err {
        display: flex;
        flex-direction: column;
        gap: 2px;
        color: var(--b3-card-error-color, var(--b3-theme-error));
    }

    .pj-ammo__health-cat {
        margin-top: 2px;
        font-weight: 500;
        color: var(--b3-card-warning-color, var(--b3-theme-on-surface));
    }

    .pj-ammo__health-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        min-width: 0;
        padding: 1px 2px;
        border: 0;
        background: transparent;
        font: inherit;
        color: inherit;
        text-align: left;

        & + & {
            margin-top: 1px;
        }
    }

    .pj-ammo__health-row--link {
        cursor: pointer;
        border-radius: 4px;

        &:hover {
            background: var(--b3-theme-background);

            .pj-ammo__health-text {
                color: var(--b3-theme-primary);
            }
        }
    }

    .pj-ammo__health-dom {
        flex-shrink: 0;
        padding: 0 5px;
        border-radius: 7px;
        background: var(--b3-theme-primary-lightest);
        color: var(--b3-theme-primary);
        font-size: 10px;
        line-height: 16px;
        white-space: nowrap;
    }

    .pj-ammo__health-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
    }

    .pj-ammo__health-text {
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        line-clamp: 3;
        -webkit-box-orient: vertical;
        color: var(--b3-theme-on-background);
    }

    .pj-ammo__health-detail {
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        font-variant-numeric: tabular-nums;
    }

    // ── 运行横幅 ──
    .pj-ammo__runbar {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 8px;
        border-radius: 6px;
        background: var(--b3-theme-primary-lightest);
    }

    .pj-ammo__runbar-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--b3-theme-primary);
        animation: pj-ammo-pulse 2s ease-in-out infinite;
    }

    @keyframes pj-ammo-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
    }

    .pj-ammo__runbar-main {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .pj-ammo__runbar-time {
        color: var(--b3-theme-on-surface);
        font-variant-numeric: tabular-nums;
    }

    .pj-ammo__stop-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 8px;
        border: 0;
        border-radius: 4px;
        background: var(--b3-theme-surface);
        color: var(--b3-theme-on-background);
        font-size: 12px;
        cursor: pointer;

        svg {
            width: 10px;
            height: 10px;
        }

        &:hover {
            background: var(--b3-theme-error-lightest, var(--b3-theme-surface));
            color: var(--b3-theme-error);
        }
    }

    // ── 出发下一发（dataview □3——与停止钮对称：surface 底+primary 字，hover 主色浅底加深；
    //    横幅底=primary-lightest，钮面走 surface 拉开层次，避开蓝on蓝同色隐形坑） ──
    .pj-ammo__depart-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 8px;
        border: 0;
        border-radius: 4px;
        background: var(--b3-theme-surface);
        color: var(--b3-theme-primary);
        font-size: 12px;
        white-space: nowrap;
        cursor: pointer;

        svg {
            width: 10px;
            height: 10px;
        }

        &:hover {
            background: var(--b3-theme-primary-lightest);
        }
    }

    // ── 悬账条 ──
    .pj-ammo__dangling {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px 8px;
        border-radius: 6px;
        background: var(--b3-card-error-background, rgba(255, 0, 0, 0.06));
    }

    .pj-ammo__dangling-title {
        font-weight: 500;
        color: var(--b3-card-error-color, var(--b3-theme-error));
    }

    .pj-ammo__dangling-row {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
    }

    .pj-ammo__dangling-main {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
    }

    .pj-ammo__dangling-time {
        flex-shrink: 0;
        width: 92px;
        padding: 1px 4px;
        font-size: 12px;
    }

    .pj-ammo__mini-btn {
        flex-shrink: 0;
        padding: 2px 8px;
        border: 0;
        border-radius: 4px;
        background: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
        font-size: 12px;
        cursor: pointer;

        &:hover {
            opacity: 0.9;
        }
    }

    // ── 中央不想做圈（鞭策墙常驻+三分区——递镜子：只显示用户原话） ──
    .pj-ammo__circle {
        flex-shrink: 0;
        display: flex;
        flex-wrap: wrap; /* 鞭策墙 0 宽修复（09-21 验真实锤）：无 wrap 时 sections 的 flex-basis:100% 不换行、whip flex:1+min-width:0 被 sections 抢宽压扁=6 行原话全不可见且占高撑出圈下半大空白 */
        align-items: flex-start;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-surface);
    }

    .pj-ammo__circle-badge {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        width: 56px;
    }

    .pj-ammo__circle-badge-ring {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        border: 3px solid var(--b3-theme-primary);
        border-top-color: transparent;
    }

    .pj-ammo__circle-badge-text {
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        white-space: nowrap;
    }

    .pj-ammo__whip {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .pj-ammo__whip-line {
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        font-weight: 500;
        color: var(--b3-theme-on-background);
    }

    .pj-ammo__sections {
        flex-basis: 100%;
        display: flex;
        flex-direction: column;
        gap: 3px;
    }

    .pj-ammo__section {
        display: flex;
        align-items: baseline;
        gap: 6px;
        flex-wrap: wrap;
        min-width: 0;
    }

    .pj-ammo__kind {
        flex-shrink: 0;
        padding: 0 6px;
        border-radius: 8px;
        font-size: 11px;
        line-height: 18px;
    }

    .pj-ammo__kind--vow {
        background: var(--b3-theme-primary-lightest);
        color: var(--b3-theme-primary);
    }

    .pj-ammo__kind--fear {
        background: var(--b3-card-warning-background, rgba(255, 165, 0, 0.12));
        color: var(--b3-card-warning-color, var(--b3-theme-on-surface));
    }

    .pj-ammo__kind--swallow {
        background: var(--b3-card-error-background, rgba(255, 0, 0, 0.08));
        color: var(--b3-card-error-color, var(--b3-theme-error));
    }

    .pj-ammo__sec-item {
        min-width: 0;
        color: var(--b3-theme-on-surface);

        &::before {
            content: "·";
            margin-right: 4px;
        }
    }

    // ── manualui：中央圈手动编辑（+ 钮/行内输入/chip × 删——全点击交互） ──
    /* 条目 chip（文本 + × 删除钮；未接删除通道=纯 span 老形态不挂此类） */
    .pj-ammo__sec-chip {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        min-width: 0;
        max-width: 100%;
    }

    /* 可点进编辑的条目文本（button 语义——pj-ammo__row-name 同款 reset） */
    .pj-ammo__sec-item--edit {
        font: inherit;
        color: inherit;
        background: transparent;
        border: 0;
        padding: 0;
        text-align: left;
        cursor: pointer;

        &:hover {
            color: var(--b3-theme-primary);
        }
    }

    /* × 删除钮（直接删不弹确认——AI 面同款语义；圆形小钮 × 字形沿用 pj-ammo__mount 先例） */
    .pj-ammo__sec-x {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--b3-theme-on-surface);
        font-size: 11px;
        line-height: 1;
        cursor: pointer;

        &:hover {
            background: var(--b3-card-error-background, rgba(255, 0, 0, 0.08));
            color: var(--b3-card-error-color, var(--b3-theme-error));
        }
    }

    /* + 钮（中央圈旁——badge 列下方；行内输入的入口） */
    .pj-ammo__av-add-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 1px solid var(--b3-border-color);
        border-radius: 50%;
        background: transparent;
        color: var(--b3-theme-on-surface);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;

        &:hover {
            background: var(--b3-theme-primary-lightest);
            border-color: var(--b3-theme-primary);
            color: var(--b3-theme-primary);
        }
    }

    /* 新增行内输入（badge 右侧占满余宽——pj-ammo__note 同族形态） */
    .pj-ammo__av-add {
        flex: 1 1 160px;
        min-width: 140px;
        display: flex;
        align-items: center;
        gap: 6px;

        input {
            flex: 1;
            min-width: 0;
            padding: 2px 6px;
            font-size: 12px;
        }
    }

    /* 改文行内输入（chip 文本位替换——sections 行内 flex-basis 撑开防压扁） */
    .pj-ammo__av-edit {
        flex: 1 1 160px;
        min-width: 120px;
        max-width: 100%;
        padding: 2px 6px;
        font-size: 12px;
    }

    // ── 四池 grid ──
    .pj-ammo__grid {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-auto-rows: minmax(120px, auto);
        gap: 6px;
    }

    .pj-ammo__pool {
        min-width: 0;
        display: flex;
        flex-direction: column;
        border-radius: 8px;
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-background);
        overflow: hidden;
    }

    .pj-ammo__pool--over {
        border-color: var(--b3-card-warning-color, var(--b3-theme-warning, #d97706));
    }

    /* 拖卡悬停落点池（□5①——拖动中才亮，drop/dragleave 熄） */
    .pj-ammo__pool--drop {
        border-color: var(--b3-theme-primary);
        box-shadow: 0 0 0 1px var(--b3-theme-primary) inset;
    }

    .pj-ammo__pool-head {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 5px 8px;
        border-bottom: 1px solid var(--b3-border-color);
        background: var(--b3-theme-surface);
        flex-wrap: wrap;
    }

    /* 可配置池头（gold/hearth 且宿主接写通道）：给手型示意可点；纯显示池不挂 */
    .pj-ammo__pool-head--edit {
        cursor: pointer;
    }

    .pj-ammo__pool-dot {
        width: 8px;
        height: 8px;
        border-radius: 2px;
        flex-shrink: 0;

        &[data-pool="gold"] { background: #d4a017; }
        &[data-pool="deadline"] { background: #e05252; }
        &[data-pool="hearth"] { background: #e07b39; }
        &[data-pool="crumbs"] { background: #7a9e7e; }
    }

    .pj-ammo__pool-name {
        font-weight: 500;
        white-space: nowrap;
    }

    .pj-ammo__pool-quota {
        color: var(--b3-theme-on-surface);
        font-size: 11px;
        white-space: nowrap;
    }

    /* 配比就地输入（□5③ 配置态——数字直接改，min 单位跟尾；R3：hearth 追加 freq 输入，d 跟尾） */
    .pj-ammo__ratio-edit {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        min-width: 0;
    }

    .pj-ammo__ratio-input {
        width: 64px;
        padding: 1px 4px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
    }

    .pj-ammo__ratio-unit {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
    }

    /* freq 半边（R3）：分隔点+标签与 quotaLabel 展示形同构（`上限 40min · 最小频率 3d`） */
    .pj-ammo__ratio-sep {
        flex-shrink: 0;
        color: var(--b3-theme-on-surface);
        font-size: 11px;
    }

    .pj-ammo__freq-label {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        white-space: nowrap;
    }

    .pj-ammo__freq-input {
        width: 44px;
    }

    .pj-ammo__burn {
        margin-left: auto;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--b3-theme-on-surface);
        white-space: nowrap;
    }

    // 多用/已消耗：橙标照实显示不拦截（A5）；还差=弱提示
    .pj-ammo__burn--over {
        color: #d97706;
        font-weight: 500;
    }

    .pj-ammo__burn--done {
        color: var(--b3-theme-primary);
    }

    .pj-ammo__burn--left {
        opacity: 0.75;
    }

    .pj-ammo__pool-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px 6px;
    }

    .pj-ammo__pool-empty {
        padding: 10px 4px;
        text-align: center;
        color: var(--b3-theme-on-surface);
        font-size: 11px;
    }

    // ── 任务行 ──
    .pj-ammo__row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 3px 4px;
        border-radius: 4px;
        border-left: 2px solid transparent;
        cursor: grab; /* □5：可拖（拖池间=换池/拖时间线=建锚点出发） */

        &:hover {
            background: var(--b3-theme-surface);
        }
    }

    /* 拖动中的行（半透明拖影跟随——HTML5 DnD 自带影，此态压暗原位） */
    .pj-ammo__row--dragging {
        opacity: 0.45;
    }

    .pj-ammo__row--running {
        border-left-color: var(--b3-theme-primary);
        background: var(--b3-theme-primary-lightest);

        &:hover {
            background: var(--b3-theme-primary-lightest);
        }
    }

    .pj-ammo__row--dangling {
        border-left-color: var(--b3-card-error-color, var(--b3-theme-error));
    }

    .pj-ammo__row-line {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
    }

    // 当日挂载池徽标（×字形连接点——任务↔池挂载关系的视觉锚；当天内一任务一池）
    .pj-ammo__mount {
        flex-shrink: 0;
        color: var(--b3-theme-on-surface);
        font-size: 10px;
        line-height: 1;
    }

    .pj-ammo__row-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
        font: inherit;
        color: inherit;
        background: transparent;
        border: 0;
        padding: 0;
    }

    .pj-ammo__row-name--link {
        cursor: pointer;

        &:hover {
            color: var(--b3-theme-primary);
        }
    }

    .pj-ammo__row-quota {
        flex-shrink: 0;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--b3-theme-on-surface);
    }

    .pj-ammo__row-run {
        flex-shrink: 0;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--b3-theme-primary);
        white-space: nowrap;
    }

    .pj-ammo__row-actions {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 2px;
    }

    .pj-ammo__start-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--b3-theme-primary);
        cursor: pointer;

        svg {
            width: 11px;
            height: 11px;
        }

        &:hover {
            background: var(--b3-theme-primary-lightest);
        }
    }

    .pj-ammo__stop-btn--row {
        width: 20px;
        height: 20px;
        padding: 0;
    }

    .pj-ammo__tag {
        flex-shrink: 0;
        padding: 0 5px;
        border-radius: 7px;
        font-size: 10px;
        line-height: 15px;
        white-space: nowrap;
    }

    .pj-ammo__tag--anchor {
        background: var(--b3-theme-surface);
        color: var(--b3-theme-on-surface);
    }

    .pj-ammo__tag--dangling {
        background: var(--b3-card-error-background, rgba(255, 0, 0, 0.08));
        color: var(--b3-card-error-color, var(--b3-theme-error));
    }

    // ── 感想输入（行内展开——Timeline 记钮同款交互） ──
    .pj-ammo__note {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 0 2px 16px;
    }

    .pj-ammo__note input {
        flex: 1;
        min-width: 0;
        padding: 2px 6px;
        font-size: 12px;
    }

    .pj-ammo__note-error {
        flex-shrink: 0;
        color: var(--b3-theme-error);
        font-size: 11px;
    }

    // ── 暗色（3.8.3 判据=html[data-theme-mode=dark]，scoped 分支 :global） ──
    :global(html[data-theme-mode="dark"]) .pj-ammo__pool-dot[data-pool="gold"] { background: #e3b341; }
    :global(html[data-theme-mode="dark"]) .pj-ammo__pool-dot[data-pool="deadline"] { background: #f87171; }
    :global(html[data-theme-mode="dark"]) .pj-ammo__pool-dot[data-pool="hearth"] { background: #fb923c; }
    :global(html[data-theme-mode="dark"]) .pj-ammo__pool-dot[data-pool="crumbs"] { background: #86efac; }
    :global(html[data-theme-mode="dark"]) .pj-ammo__burn--over { color: #fbbf24; }
    :global(html[data-theme-mode="dark"]) .pj-ammo__circle { background: var(--b3-theme-background); }
</style>
