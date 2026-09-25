<script lang="ts">
    // 驾驶舱（P3 □4）：打开项目默认画面——骨架树+现场状态+动作区（只读为主，写动作归 Agent）。
    // 数据=前端直 fetch（fe.ts），视图模型组装复用 gui/queries 纯逻辑（与 kernel 同源）；
    // 切项目=window 事件 pj-project-switched（index.ts dispatch）驱动原地刷新。
    import { onMount, mount, unmount } from "svelte";
    import { Dialog, showMessage } from "siyuan";
    import { feCall, feQuery } from "./gui/fe";
    import {
        buildActionLine,
        formatStartValue,
        parseActionLine,
        rewriteStart,
        tokenizeCommand,
        type ParsedAction,
    } from "./kernel/core/actions";
    import {
        allDueTasksSql,
        buildCalendarPanelModel,
        buildDashboardActions,
        buildDashboardModel,
        buildDashboardToday,
        buildTrendBars,
        countRemindSql,
        countsText,
        ledgerConflictsTotal,
        projectActionItemsSql,
        projectDocSql,
        projectLinesSql,
        projectTasksSql,
        type CalendarPanelModel,
        type DashboardAction,
        type DashboardModel,
        type DashboardTodayModel,
        type RemindScanRow,
        type TaskDueRow,
        type TrendBar,
    } from "./gui/queries";
    import { listRemindBlocksSql } from "./kernel/core/remind";
    import {
        captureVideoProgressSeconds,
        confirmAction,
        desktopAvailable,
        runPlayAction,
        runSpawnAction,
    } from "./gui/actionsRunner";
    import { debugLog } from "./libs/debugLog";
    import type { SceneSnapshot } from "./kernel/core/scene";
    import type { ActionsUpdatedPayload } from "./shared/channels";
    import DeleteProjectDialog from "./DeleteProjectDialog.svelte";

    let {
        projectId,
        t,
        app,
        loadScene,
        saveScene,
        openDoc,
        onProjectRenamed,
        restoreScene,
        loadCalendarStatus,
        loadFeishuStatus,
        loadLedger,
        syncNow,
        startReauth,
        onOpenSettings,
        onOpenCalendar,
        onOpenTimeline,
        onOpenGantt,
        onOpenDiary,
        readDayBoard,
        feishuTestSend,
        feishuTestEvent,
        feishuBotInfo,
        deleteProject,
        sweepDone,
    }: {
        projectId: string;
        t: Record<string, string>;
        /** openTab 用（play 动作思源内打开文档/资产） */
        app: any;
        loadScene: (id: string) => Promise<SceneSnapshot | null>;
        saveScene: () => Promise<void>;
        openDoc: (docId: string) => void;
        /** 改名成功后通知壳层（顶栏标签直传新名防 SQL 索引窗闪旧；文件树/页签标题原生广播自动跟） */
        onProjectRenamed?: (name: string) => void;
        /** 按钮化 a：恢复现场（关本项目域页签+开快照页签） */
        restoreScene: () => Promise<void>;
        /** 按钮化 b：日历同步状态只读（petal calendar-status.json） */
        loadCalendarStatus: () => Promise<import("./kernel/core/calendarStatus").CalendarStatus | null>;
        loadFeishuStatus: () => Promise<{ channel: string; calendarId?: string; enabled: boolean } | null>;
        loadLedger: () => Promise<import("./kernel/core/ledger").CalendarLedger | null>;
        /** 立即同步（rpc notify remind-sync；完成由状态广播驱动刷新） */
        syncNow: () => void;
        /** 按钮化 c/d：一键重授权 B 档 */
        startReauth: () => Promise<{ ok: boolean; error?: string; manual?: boolean }>;
        /** 打开插件设置（用法提示词/飞书日历配置都在设置页——驾驶舱常驻入口） */
        onOpenSettings: () => void;
        /** calnav □3：打开独立日历页签（月历三源只读） */
        onOpenCalendar: () => void;
        /** caltab：打开独立时间线页签（「打开日历」旁第二入口；缺通道=钮不渲染） */
        onOpenTimeline?: () => void;
        /** gantt-lanes：打开甘特图独立整页页签（原森林图入口换代，bear 二轮拍板②） */
        onOpenGantt: () => void;
        /** folder-model：全局日志入口（打开当月日志文档；缺通道=入口行不渲染） */
        onOpenDiary?: () => void;
        /** tb2 ⑧：「今天」卡数据源——当日班表块只读（kernel rpc；缺通道=班表 0 条降级） */
        readDayBoard?: (day: string) => Promise<BoardReadItemsShape | null>;
        /** tb2 H4：飞书测试消息直发（urgent=none/app/sms/phone/reply；错误透传给 toast） */
        feishuTestSend?: (urgent: string, text?: string) => Promise<{ ok: boolean; error?: string; urgentApplied?: string }>;
        /** tb2 H4：马上到期测试事件（oauth 身份；到点看手机） */
        feishuTestEvent?: (seconds: number) => Promise<{ ok: boolean; error?: string; startAt?: string; swept?: number }>;
        /** tb6 □6d：机器人身份自检（bot 名+appId 尾 4 位——H4 测试行身份卡） */
        feishuBotInfo?: () => Promise<{ ok: boolean; error?: string; botName?: string; appIdTail?: string }>;
        /** 删除项目（kernel rpc project-delete 经 index.ts 壳层——壳层负责清活跃项目指针+顶栏标签）。
         *  缺通道（老内核/内核侧未运行）=删除钮不渲染 */
        deleteProject?: (projectId: string) => Promise<{ ok: boolean; totalDocs?: number; error?: string }>;
        /** 收拢已完成（03 收拢件：kernel rpc line-sweep，MCP line sweep_done 双通道同编排）——
         *  顶层 done 任务（子树全 done）moveBlock 保 id 收进项目内「归档」区。缺通道=按钮不渲染 */
        sweepDone?: (projectId: string) => Promise<{ ok: boolean; swept?: number; skipped?: Array<{ id: string; name: string }>; error?: string }>;
    } = $props();

    /** readDayBoard rpc 返回形态（Calendar BoardReadShape 的最小视图——今天卡只吃 items） */
    interface BoardReadItemsShape {
        ok: boolean;
        items?: Array<{ key: string; summary: string; start: string | null; end: string | null; hard: boolean; origin: string; allDay?: boolean }>;
        error?: string;
    }

    let model = $state<DashboardModel | null>(null);
    let error = $state<string | null>(null);
    let saving = $state(false);
    let savedAt = $state<string | null>(null);
    let copiedKey = $state<string | null>(null);

    /** load 代际令牌：新一轮 load 立刻作废旧代际——旧代的延迟重试/异步回写不得
     *  覆写新代际结果（onload 恢复的过期项目重试链 5.5s 后把 error 盖上刚渲染好的
     *  新项目，09-14 e2e 实锤的覆写竞态） */
    let loadGen = 0;

    async function load(id: string, emptyRetries = 2): Promise<void> {
        const gen = ++loadGen;
        error = null;
        model = null;
        savedAt = null;
        try {
            const docs = await feQuery<{ id: string; content: string; box: string; hpath: string; path: string; markdown: string; status: string | null }>(
                projectDocSql(id),
            );
            if (gen !== loadGen) return;
            if (!docs[0]) {
                // 索引窗兜底：MCP open 紧跟建文档（e2e/刚 create 的项目）SQL type='d' 行
                // 0.5~2s 才可见，首查空≠项目不存在——有界重试后再宣判（09-14 e2e 实锤）
                if (emptyRetries > 0) {
                    setTimeout(() => {
                        if (gen === loadGen) void load(id, emptyRetries - 1);
                    }, emptyRetries === 2 ? 1_500 : 4_000);
                    return;
                }
                error = t.dashboardNotFound;
                return;
            }
            mainDoc = { box: docs[0].box, hpath: docs[0].hpath, path: docs[0].path };
            const [linesRaw, tasks, snapshot, actionItems, kramdown] = await Promise.all([
                feQuery<{ id: string; content: string; hpath?: string | null; updated: string }>(projectLinesSql(id, docs[0].path)),
                feQuery<import("./kernel/core/progressCalc").TaskRow>(projectTasksSql(id, docs[0].path)),
                loadScene(id).catch(() => null),
                feQuery<{ id: string; markdown: string }>(projectActionItemsSql(id)),
                // blocks.markdown 列对文档行恒空（正文在子块）——全文走 kramdown 直读
                fetchDocKramdown(id),
            ]);
            if (gen !== loadGen) return;
            // folder-model：项目内子文档全平铺（日记子树/注册过滤分拣退役——结构即唯一真源）
            model = buildDashboardModel({
                project: { id, name: docs[0].content || t.untitled, status: docs[0].status ?? "active" },
                lines: linesRaw,
                taskRows: tasks,
                snapshot,
                now: Date.now(),
                actionsMarkdown: kramdown,
                actionItems,
            });
            // tb2 ⑧ 进度走势：同一把任务行的「近 14 天每日新完成数」（块 updated 日桶+完成态）
            trend = buildTrendBars(tasks, Date.now());
            // 索引窗兜底：只剩主行（无线）时延迟重查——刚迁移（rebind）/刚建线后 SQL
            // path 索引 3~10s 窗内首查必空，且无事件会再触发 load（写后立读坑族）
            if (emptyRetries > 0 && model.lines.length === 1) {
                setTimeout(() => {
                    if (gen === loadGen) void load(id, emptyRetries - 1);
                }, emptyRetries === 2 ? 3_000 : 8_000);
            }
        } catch (e: any) {
            if (gen === loadGen) error = String(e?.message ?? e);
        }
    }

    function onSwitched(e: Event): void {
        const id = (e as CustomEvent).detail?.projectId;
        if (typeof id === "string" && id) {
            liveProjectId = id;
            void load(id);
        }
    }

    // □9：projectId 是驾驶舱页签 mount 快照（index.ts init 时 activeProjectId），切项目
    // 只走 pj-project-switched——$state 活跃副本驱动 load 就地刷新，防旧项目数据钉死
    // svelte-ignore state_referenced_locally
    let liveProjectId = $state(projectId);

    // ── tb2 ⑧ KPI 三卡：进度走势（项目域）+「今天」卡（全局口径与日历同源） ──
    let trend = $state<{ bars: TrendBar[]; max: number } | null>(null);
    let today = $state<DashboardTodayModel | null>(null);
    // 挂载锚（与 Calendar nowAnchor 同款——CTA 跳日用；跨午夜会话不回滚=可接受）
    const todayAnchor = new Date();
    const todayIso = `${todayAnchor.getFullYear()}-${String(todayAnchor.getMonth() + 1).padStart(2, "0")}-${String(todayAnchor.getDate()).padStart(2, "0")}`;
    const todayWdKey = `calWd${((todayAnchor.getDay() + 6) % 7) + 1}`; // 周一=calWd1..周日=calWd7

    async function loadToday(): Promise<void> {
        const d = new Date();
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const nowHM = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        const [board, remindRows, taskRows] = await Promise.all([
            readDayBoard ? readDayBoard(iso).catch(() => null) : Promise.resolve(null),
            feQuery<RemindScanRow>(listRemindBlocksSql()).catch(() => [] as RemindScanRow[]),
            feQuery<TaskDueRow>(allDueTasksSql()).catch(() => [] as TaskDueRow[]),
        ]);
        today = buildDashboardToday({
            boardItems: board?.ok && Array.isArray(board.items) ? board.items : [],
            remindRows,
            taskRows,
            today: iso,
            nowHM,
        });
    }

    /** 班表/同步事件驱动的今日卡重拉（600ms 尾沿合并——连发改几条只重查一次） */
    let todayTimer: ReturnType<typeof setTimeout> | undefined;
    function scheduleTodayRefresh(): void {
        clearTimeout(todayTimer);
        todayTimer = setTimeout(() => {
            todayTimer = undefined;
            void loadToday();
        }, 600);
    }

    /** 主 CTA：开日历页签+选今天（bear 点名落法——Calendar 挂 pj-cal-goto-day 监听；
     *  首开页签时组件默认即今天，事件错过也无害） */
    function openTodayTimeline(): void {
        onOpenCalendar();
        window.dispatchEvent(new CustomEvent("pj-cal-goto-day", { detail: { date: todayIso } }));
    }

    /** 走势柱高（%）：零日=矮桩保节奏；有值=下限 14% 起步 */
    function barPct(count: number, max: number): number {
        if (count <= 0) return 5;
        return Math.max(14, Math.round((count / max) * 100));
    }

    function mdLabel(iso: string): string {
        return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
    }

    // ── □2 动作区：主文档「## 动作」段渲染为按钮 + 执行 + 视频记进度 ──
    let busyAct = $state<string | null>(null);
    let markingAct = $state<string | null>(null);
    const desktopOk = desktopAvailable();

    /** 文档全文 kramdown（IAL 直读族——blocks.markdown 列对文档行恒空） */
    async function fetchDocKramdown(id: string): Promise<string> {
        try {
            const d = await feCall<{ id: string; kramdown?: string }>("/api/block/getBlockKramdown", { id });
            return d?.kramdown ?? "";
        } catch {
            return "";
        }
    }

    /** MCP set_actions 后延迟重查（广播即时重渲后补块 id——记进度定位用） */
    async function loadActionsOnly(): Promise<void> {
        if (!model) return;
        try {
            const [kramdown, items] = await Promise.all([
                fetchDocKramdown(liveProjectId),
                feQuery<{ id: string; markdown: string }>(projectActionItemsSql(liveProjectId)),
            ]);
            const built = buildDashboardActions(kramdown, items);
            model.actions = built.actions;
            model.hasActionsSection = built.hasActionsSection;
        } catch (e: any) {
            debugLog("act", `!! reload actions failed: ${String(e?.message ?? e)}`);
        }
    }

    function onActionsUpdated(e: Event): void {
        const detail = (e as CustomEvent).detail as ActionsUpdatedPayload | undefined;
        if (!detail || detail.projectId !== liveProjectId) return;
        // 广播自带写后清单：即时重渲免 SQL 写后立读窗；块 id（记进度定位）由延迟重查补
        if (Array.isArray(detail.actions) && model) {
            model.hasActionsSection = true;
            model.actions = detail.actions
                .map((a) => parseActionLine(buildActionLine(a.label, a.command)))
                .filter((a): a is ParsedAction => a !== null);
        }
        setTimeout(() => void loadActionsOnly(), 5_000);
    }

    async function onRunAction(a: DashboardAction): Promise<void> {
        if (busyAct) return;
        if (a.desktopOnly && !desktopOk) return; // 按钮已置灰，防御性兜底
        if (!a.whitelisted) {
            const go = await confirmAction(t.actConfirmTitle, t.actConfirmText.replace("{cmd}", a.command));
            if (!go) return;
        }
        busyAct = a.rawLine;
        try {
            const r = a.program === "play" ? await runPlayAction(app, a) : await runSpawnAction(a);
            if (!r.ok) {
                showMessage(t.actRunFail.replace("{msg}", r.error ?? ""), 6000, "error");
            } else {
                debugLog("act", `ran: ${a.command}`);
            }
        } finally {
            busyAct = null;
        }
    }

    /** 视频动作记进度：读当前播放位置→回写 --start 到动作行块（纯手动触发，反 lifelog） */
    async function onMarkProgress(a: DashboardAction): Promise<void> {
        if (markingAct) return;
        markingAct = a.rawLine;
        try {
            const sec = captureVideoProgressSeconds();
            if (sec === null) {
                showMessage(t.actProgressNone, 4000);
                return;
            }
            if (!a.blockId) {
                showMessage(t.actRunFail.replace("{msg}", "动作行块未定位（稍等自动重查后再试）"), 6000, "error");
                return;
            }
            const newCmd = rewriteStart(a.tokens, sec);
            await feCall("/api/block/updateBlock", {
                id: a.blockId,
                dataType: "markdown",
                data: buildActionLine(a.label, newCmd),
            });
            // 乐观上屏（SQL 写后立读窗）——就地改 tokens/startSeconds 供下次点击按新进度执行
            a.command = newCmd;
            a.tokens = tokenizeCommand(newCmd);
            a.startSeconds = sec;
            showMessage(t.actProgressSaved.replace("{pos}", formatStartValue(sec)), 2500, "info");
            debugLog("act", `progress ${formatStartValue(sec)}s → block ${a.blockId}`);
        } catch (e: any) {
            showMessage(t.actRunFail.replace("{msg}", String(e?.message ?? e)), 6000, "error");
        } finally {
            markingAct = null;
        }
    }

    // ── □2a 加线：骨架区 inline 输入 → 建子文档 → 文件树钉尾 → 乐观上屏 ──
    // 主文档定位（建线 parentID/hpath/钉序目录都靠它；SQL 索引窗外查询，load 时刷新）
    let mainDoc = $state<{ box: string; hpath: string; path: string } | null>(null);
    let addingLine = $state(false);
    let newLineName = $state("");
    let addingBusy = $state(false);
    let addLineError = $state<string | null>(null);
    let addLineInput: HTMLInputElement | undefined = $state();

    function startAddLine(): void {
        addingLine = true;
        newLineName = "";
        addLineError = null;
        // 输入行在列表首而按钮在尾（vision P2）——出现即滚进视口，防长列表点击后输入无感
        requestAnimationFrame(() => {
            addLineInput?.scrollIntoView({ block: "center" });
            addLineInput?.focus();
        });
    }

    function cancelAddLine(): void {
        if (!addingBusy) addingLine = false;
    }

    async function submitNewLine(): Promise<void> {
        if (addingBusy || !model || !mainDoc) return;
        const name = newLineName.trim();
        if (!name) return; // 空名=留在编辑态（blur/Esc 才收起）
        if (name.includes("/")) {
            addLineError = t.addLineSlash;
            return;
        }
        addingBusy = true;
        addLineError = null;
        try {
            // parentID 精确定位防同名歧义（kernel createDocWithMd 同款坑）
            const lineId = await feCall<string>("/api/filetree/createDocWithMd", {
                notebook: mainDoc.box,
                path: `${mainDoc.hpath}/${name}`,
                markdown: "",
                parentID: model.project.id,
            });
            if (!lineId) throw new Error("createDocWithMd: no doc id");
            // 文件树钉序：新建默认插顶部会把既有线顶乱——按现序追加到尾部
            const dir = mainDoc.path.replace(/\.sy$/, "");
            const listing = await feCall<{ files: Array<{ id: string; path: string }> } | null>(
                "/api/filetree/listDocsByPath",
                { notebook: mainDoc.box, path: dir },
            );
            const files = listing?.files ?? [];
            const newPath = files.find((f) => f.id === lineId)?.path;
            if (newPath) {
                await feCall("/api/filetree/changeSort", {
                    notebook: mainDoc.box,
                    paths: [...files.filter((f) => f.id !== lineId).map((f) => f.path), newPath],
                });
            }
            // 乐观上屏：SQL 索引 3~10s 窗内重查会漏新线（写后立读坑族）；头部插入=updated 最新语义
            model.lines = [
                { id: lineId, name, isMain: false, counts: { done: 0, total: 0 }, updated: fmtUpdatedNow() },
                ...model.lines,
            ];
            addingLine = false;
            newLineName = "";
        } catch (e: any) {
            addLineError = String(e?.message ?? e);
        } finally {
            addingBusy = false;
        }
    }

    function fmtUpdatedNow(): string {
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    // ── 删除项目（手动维护 UI 批次）：头部危险态钮 → 自建 Dialog 确认（两击式二次确认）→
    // kernel rpc project-delete → toast+驾驶舱空态。kernel 侧另有同判据守卫终判（双守卫）。
    /** 整树文档篇数（确认弹窗范围行 N 篇）：每行 1 篇 + 日记折叠行内 dayCount 篇日期文档 */
    function projectDocCount(): number {
        if (!model) return 0;
        return model.lines.reduce((sum, l) => sum + 1 + (l.dayCount ?? 0), 0);
    }

    let delDialog: Dialog | null = null;

    function openDeleteDialog(): void {
        if (!model) return;
        delDialog?.destroy();
        const hostId = `pj-deldialog-${Date.now().toString(36)}`;
        // 本代组件走闭包局部引用：destroyCallback 迟到也必拆（CreateProjectDialog 同款防迟到回调误拆新树）
        let comp: any = null;
        const dialog: Dialog = new Dialog({
            title: t.deleteProjectTitle,
            content: `<div id="${hostId}"></div>`,
            width: "min(460px, 92vw)",
            destroyCallback: () => {
                if (comp) {
                    unmount(comp);
                    comp = null;
                }
                if (delDialog !== dialog) return; // 迟到回调守卫（Dialog destroy 异步）
                delDialog = null;
            },
        });
        delDialog = dialog;
        const host = dialog.element.querySelector(`#${hostId}`);
        if (!host) return;
        comp = mount(DeleteProjectDialog, {
            target: host,
            props: {
                t,
                name: model.project.name,
                docCount: projectDocCount(),
                submit: () => runDeleteProject(),
                close: () => dialog.destroy(),
            },
        });
    }

    async function runDeleteProject(): Promise<{ ok: boolean; totalDocs?: number; error?: string }> {
        if (!deleteProject) return { ok: false, error: t.deleteProjectNoKernel };
        const id = liveProjectId;
        try {
            const r = await deleteProject(id);
            if (r.ok) {
                showMessage(t.deleteProjectOk.replace("{n}", String(r.totalDocs ?? 1)), 6000, "info");
                // 删的是当前驾驶舱项目（恒真——删除钮只对当前项目渲染）：就地置空态，
                // 不自动跳别的项目（无「下一个项目」语义；切走走切换器显式路径）
                if (id === liveProjectId) {
                    model = null;
                    error = t.projectDeleted;
                }
            }
            return r;
        } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    // ── 收拢已完成（03 收拢件）：头部钮 → kernel rpc line-sweep → toast 盘点+就地刷新。
    // 非破坏动作（块 move 进归档区、id 保留可拖回）——不做确认弹窗，收据在 toast+归档区可见。
    let sweepBusy = $state(false);

    async function runSweepDone(): Promise<void> {
        if (!sweepDone || sweepBusy || !model) return;
        sweepBusy = true;
        try {
            const r = await sweepDone(liveProjectId);
            if (r.ok) {
                const skippedNote = (r.skipped?.length ?? 0) > 0
                    ? t.sweepDoneSkippedNote.replace("{n}", String(r.skipped!.length))
                    : "";
                showMessage(t.sweepDoneOk.replace("{n}", String(r.swept ?? 0)) + skippedNote, 6000, "info");
                void load(liveProjectId); // done 计数/totals 已变——就地重拉
            } else {
                showMessage(t.sweepDoneFail + (r.error ? `：${r.error}` : ""), 6000, "error");
            }
        } catch (e: any) {
            showMessage(t.sweepDoneFail + `：${String(e?.message ?? e)}`, 6000, "error");
        } finally {
            sweepBusy = false;
        }
    }

    // ── □4 重命名：头部小钮 → inline 编辑 → renameDoc（块 id 锚不受影响，引用零破坏） ──
    let renaming = $state(false);
    let renameValue = $state("");
    let renameBusy = $state(false);
    let renameError = $state<string | null>(null);
    let renameInput: HTMLInputElement | undefined = $state();

    function startRename(): void {
        if (!model) return;
        renameValue = model.project.name;
        renameError = null;
        renaming = true;
        requestAnimationFrame(() => renameInput?.focus());
    }

    function cancelRename(): void {
        if (!renameBusy) renaming = false;
    }

    async function commitRename(): Promise<void> {
        if (renameBusy || !model) return;
        const name = renameValue.trim();
        if (!name) {
            renameError = t.renameEmpty;
            return;
        }
        if (name === model.project.name) {
            renaming = false;
            return;
        }
        renameBusy = true;
        renameError = null;
        try {
            // renameDoc 走 notebook+path（实时查防陈旧——path 随结构变更会动）
            const rows = await feQuery<{ box: string; path: string }>(
                `SELECT box, path FROM blocks WHERE id='${model.project.id}' AND type='d'`,
            );
            const row = rows[0];
            if (!row?.box || !row?.path) throw new Error("main doc not found");
            await feCall("/api/filetree/renameDoc", { notebook: row.box, path: row.path, title: name });
            model.project.name = name;
            renaming = false;
            onProjectRenamed?.(name);
            // 思源允许同名文档不硬拦——同库有同名兄弟时轻提示
            const sibs = await feQuery<{ id: string }>(
                `SELECT id FROM blocks WHERE type='d' AND content='${name.replace(/'/g, "''")}' AND id!='${model.project.id}' LIMIT 1`,
            );
            if (sibs.length > 0) showMessage(t.renameDup, 2000);
        } catch (e: any) {
            renameError = String(e?.message ?? e);
        } finally {
            renameBusy = false;
        }
    }

    function flashCopied(key: string): void {
        copiedKey = key;
        setTimeout(() => {
            if (copiedKey === key) copiedKey = null;
        }, 1500);
    }

    async function copyText(text: string, key: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            flashCopied(key);
        } catch {
            // 剪贴板不可用（headless/权限）静默——按钮态不闪
        }
    }

    async function onSaveScene(): Promise<void> {
        if (saving) return;
        saving = true;
        try {
            await saveScene();
            await load(liveProjectId, 0); // 存完就地刷新——否则现场区还挂着「尚无现场快照」旧态自相矛盾（emptyRetries=0：闪标别被兜底重查清掉）
            savedAt = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); // ⚠load 开头清 savedAt——闪标必须排在刷新后
        } finally {
            saving = false;
        }
    }

    // ── 按钮化 a：恢复现场（语义 B=关现有页签开快照页签，丢弃当前未存现场） ──
    let restoring = $state(false);

    async function onRestoreScene(): Promise<void> {
        if (restoring) return;
        restoring = true;
        try {
            await restoreScene();
        } finally {
            restoring = false;
        }
    }

    // ── 按钮化 b/d：日历区（状态可见+立即同步+授权坏红态重授权） ──
    let cal = $state<CalendarPanelModel | null>(null);
    /** 同步卡常态族（never/error/ok/disabled——非 not_configured/auth_broken 才有「立即同步」与测试行） */
    const calOperable = $derived(cal !== null && cal.state !== "not_configured" && cal.state !== "auth_broken");
    let syncing = $state(false);
    let reauthing = $state(false);
    let syncStartedAt = 0;
    /** 最新同步状态：广播直存（kernel 内容未变不落盘——文件只是冷启动兜底，at 靠广播承载） */
    let calStatus: import("./kernel/core/calendarStatus").CalendarStatus | null = null;

    async function loadCalendar(): Promise<void> {
        const [status, config, cnt, ledger] = await Promise.all([
            calStatus ? Promise.resolve(calStatus) : loadCalendarStatus().catch(() => null),
            loadFeishuStatus().catch(() => null),
            feQuery<{ n: number }>(countRemindSql()).then((r) => Number(r[0]?.n ?? 0)).catch(() => 0),
            loadLedger().catch(() => null),
        ]);
        calStatus = status;
        cal = buildCalendarPanelModel({ status, config, remindCount: cnt, conflictsTotal: ledgerConflictsTotal(ledger) });
        // tb6 □6d：配置可用即拉机器人身份（异步不阻塞日历区；失败=身份卡降级显错误行）
        if (cal && cal.state !== "not_configured" && cal.state !== "disabled" && !botInfoPulled) {
            botInfoPulled = true;
            void pullBotInfo();
        }
    }

    // ── tb6 □6d：机器人身份卡（H4 测试行旁——「当前用的是哪个 bot」一眼可辨，防配错）──
    let botInfo = $state<{ ok: boolean; botName?: string; appIdTail?: string; error?: string } | null>(null);
    let botInfoPulled = false; // 每次面板生命周期拉一次即够（换凭证=重载插件后重拉）
    async function pullBotInfo(): Promise<void> {
        if (!feishuBotInfo) return;
        botInfo = await feishuBotInfo();
    }

    function onSyncNow(): void {
        if (syncing) return;
        syncing = true;
        syncStartedAt = Date.now();
        syncNow();
        // 广播到达（onCalendarStatus → window 事件）解除 busy 并刷新；90s 兜底（goja 外网慢轮防久卡）
        setTimeout(() => {
            if (syncing) {
                syncing = false;
                void loadCalendar();
            }
        }, 90_000);
    }

    async function onReauth(): Promise<void> {
        if (reauthing) return;
        reauthing = true;
        try {
            const r = await startReauth();
            if (r.ok) {
                showMessage(t.calReauthOk, 3000, "info");
                await loadCalendar();
            } else if (r.manual) {
                // 自动通道不可用（浏览器版/端口占/弹窗拦）——引导去设置面板手动贴 code
                showMessage(t.calReauthManualHint, 7000, "error");
            } else {
                showMessage(t.calReauthFail.replace("{msg}", r.error ?? ""), 7000, "error");
            }
        } finally {
            reauthing = false;
        }
    }

    // ── tb2 H4：飞书推送链路直测（bear 09-19 拍板——排查手机端推送配置）──
    // 消息/加急=bot 身份（加急只能加急自己发的消息）；到期事件=oauth 用户身份（到点提醒按用户生效）。
    // 权限未开通时飞书报错原样透传 toast（应用须开机器人能力+消息/加急权限——hint 说明）。
    let testUrgent = $state("none");
    let testMsgBusy = $state(false);
    let testEvtBusy = $state<number | null>(null);
    // t 是响应式 prop——勿在模块级 const 里捕获初值（svelte-check 警）；函数/derived 惰性取值
    function urgentLabel(kind: string): string {
        switch (kind) {
            case "app": return t.testUrgentApp;
            case "sms": return t.testUrgentSms;
            case "phone": return t.testUrgentPhone;
            case "reply": return t.testUrgentReply;
            default: return t.testUrgentNone;
        }
    }
    const TEST_EVENT_LEVELS = $derived([
        [30, t.testEvent30s],
        [60, t.testEvent1m],
        [300, t.testEvent5m],
    ] as Array<[number, string]>);

    async function onTestMsg(): Promise<void> {
        if (!feishuTestSend || testMsgBusy) return;
        testMsgBusy = true;
        try {
            const r = await feishuTestSend(testUrgent);
            if (r.ok) {
                showMessage(testUrgent === "none" ? t.testMsgSent : `${t.testMsgSent}（${urgentLabel(testUrgent)}）`, 5000, "info");
            } else {
                showMessage(t.testFail.replace("{msg}", r.error ?? ""), 8000, "error");
            }
        } finally {
            testMsgBusy = false;
        }
    }

    async function onTestEvent(sec: number): Promise<void> {
        if (!feishuTestEvent || testEvtBusy !== null) return;
        testEvtBusy = sec;
        try {
            const r = await feishuTestEvent(sec);
            if (r.ok) showMessage(t.testEventDone.replace("{time}", r.startAt ?? ""), 5000, "info");
            else showMessage(t.testFail.replace("{msg}", r.error ?? ""), 8000, "error");
        } finally {
            testEvtBusy = null;
        }
    }

    /** kernel 状态广播（pj-calendar-status）：直存最新状态+刷新；点击「立即同步」后的完成信号 */
    function onCalendarEvent(e: Event): void {
        const detail = (e as CustomEvent).detail;
        if (detail && typeof detail.at === "string") {
            calStatus = detail;
            if (syncing && Date.parse(detail.at) >= syncStartedAt) syncing = false;
        }
        void loadCalendar();
    }

    /** 摘要行文案（建/改/删/回写/冲突——非零才显，零噪音字段不上屏） */
    function calSummaryText(): string {
        const s = cal?.summary;
        if (!s) return "";
        const parts: string[] = [];
        if (s.created) parts.push(t.calSumCreated.replace("{n}", String(s.created)));
        if (s.updated) parts.push(t.calSumUpdated.replace("{n}", String(s.updated)));
        if (s.deleted) parts.push(t.calSumDeleted.replace("{n}", String(s.deleted)));
        if (s.writtenBack) parts.push(t.calSumWrittenBack.replace("{n}", String(s.writtenBack)));
        if (s.conflicts) parts.push(t.calSumConflicts.replace("{n}", String(s.conflicts)));
        return parts.join(" · ");
    }

    function calAgoText(): string {
        const at = cal?.at ? Date.parse(cal.at) : NaN;
        if (Number.isNaN(at)) return "";
        const diff = Date.now() - at;
        if (diff < 60_000) return t.calAgoJustNow;
        if (diff < 3600_000) return t.calAgoMinutes.replace("{n}", String(Math.floor(diff / 60_000)));
        if (diff < 86400_000) return t.calAgoHours.replace("{n}", String(Math.floor(diff / 3600_000)));
        return t.calAgoDays.replace("{n}", String(Math.floor(diff / 86400_000)));
    }

    /** skip 原因 → 文案（kernel 存 reason code，i18n 归前端） */
    function skipText(reason: string): string {
        return reason === "disabled" ? t.calSkipDisabled : reason === "source_disabled" ? t.calSkipSourceOff : t.calSkipNotConfigured;
    }

    // ── tb2 ⑧ 动作卡横排：注释/坏行仍是整行提示，可执行动作进 flex 网格（原序 index 进 key 保稳定） ──
    const actExtraRows = $derived.by(() => (model?.actions ?? []).map((a, i) => ({ a, i })).filter(({ a }) => a.kind !== "action"));
    const actBtnRows = $derived.by(() => (model?.actions ?? []).map((a, i) => ({ a, i })).filter(({ a }) => a.kind === "action"));

    onMount(() => {
        void load(projectId);
        void loadCalendar();
        void loadToday();
        window.addEventListener("pj-project-switched", onSwitched as EventListener);
        window.addEventListener("pj-calendar-status", onCalendarEvent as EventListener);
        window.addEventListener("pj-actions-updated", onActionsUpdated as EventListener);
        // tb2 ⑧ 今日卡跟手：班表写面（每条一发）与同步完成（每轮一发）都刷「今天」数据（尾沿合并）
        window.addEventListener("pj-schedule-updated", scheduleTodayRefresh);
        window.addEventListener("pj-calendar-status", scheduleTodayRefresh);
        return () => {
            window.removeEventListener("pj-project-switched", onSwitched as EventListener);
            window.removeEventListener("pj-calendar-status", onCalendarEvent as EventListener);
            window.removeEventListener("pj-actions-updated", onActionsUpdated as EventListener);
            window.removeEventListener("pj-schedule-updated", scheduleTodayRefresh);
            window.removeEventListener("pj-calendar-status", scheduleTodayRefresh);
            clearTimeout(todayTimer); // 卸载后不再触发（防已卸载组件写 $state）
            delDialog?.destroy(); // Dialog 挂 body 不随插件容器拆——卸载面与挂载面一一对应（ammodepot □9）
        };
    });
</script>

<div class="pj-dashboard fn__flex-column">
    {#if error}
        <div class="pj-dashboard__empty">{error}</div>
    {:else if !model}
        <div class="pj-dashboard__empty">{t.dashboardLoading}</div>
    {:else}
        <header class="pj-dashboard__head fn__flex">
            {#if renaming}
                <input
                    class="pj-dashboard__rename-input"
                    bind:this={renameInput}
                    bind:value={renameValue}
                    placeholder={t.renamePlaceholder}
                    disabled={renameBusy}
                    title={t.renameTitle}
                    onkeydown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                        else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                    }}
                    onblur={cancelRename}
                />
                {#if renameError}<span class="pj-dashboard__inline-error">{renameError}</span>{/if}
            {:else}
                <span class="pj-dashboard__name">{model.project.name}</span>
                <button
                    class="pj-dashboard__iconbtn"
                    title={t.renameTitle}
                    aria-label={t.renameTitle}
                    onclick={startRename}
                ><svg><use xlink:href="#iconEdit"></use></svg></button>
            {/if}
            <button
                class="pj-dashboard__iconbtn"
                title={t.openSettingsTitle}
                aria-label={t.openSettingsTitle}
                onclick={onOpenSettings}
            ><svg><use xlink:href="#iconSettings"></use></svg></button>
            {#if model.project.status === "archived"}
                <span class="pj-dashboard__badge">{t.archived}</span>
            {/if}
            <span class="fn__flex-1"></span>
            <span class="pj-dashboard__totals">{t.totalDone.replace("{done}", String(model.totals.done)).replace("{total}", String(model.totals.total))}</span>
            <!-- gantt-lanes：甘特图独立页签入口（原森林图按钮换代） -->
            <button
                class="pj-dashboard__openforest"
                title={t.openForestTitle}
                aria-label={t.openForestTitle}
                onclick={onOpenGantt}
            >{t.viewForest}</button>
            <!-- 03 收拢件：done 任务收进归档区（非破坏——move 保 id；toast 盘点） -->
            {#if sweepDone}
                <button
                    class="pj-dashboard__openforest"
                    title={t.sweepDoneTitle}
                    aria-label={t.sweepDoneTitle}
                    disabled={sweepBusy}
                    onclick={() => void runSweepDone()}
                >{sweepBusy ? (t.sweepDoneBusy ?? "…") : t.sweepDoneBtn}</button>
            {/if}
            <!-- 删除项目（危险态）：对所有项目渲染（mainline-home-split 起项目全普通化）；
                 屋檐防线在 kernel（子树含屋檐拒删），前端无特判 -->
            {#if deleteProject}
                <button
                    class="pj-dashboard__deleteproject"
                    title={t.deleteProjectTitle}
                    aria-label={t.deleteProjectTitle}
                    onclick={openDeleteDialog}
                >{t.deleteProjectBtn}</button>
            {/if}
        </header>

        <!-- tb2 ⑧ 卡片化（bear 过目草图 tb8_dash_mock）：KPI 三卡（今天/进度走势/飞书同步）
             +两列内容卡（骨架|上次现场）+动作卡横排；H4 测试行随日历区迁入同步卡 -->
        <section class="pj-dashboard__kpis">
            <div class="pj-dashboard__card pj-dashboard__card--today">
                <div class="pj-dashboard__card-title">{t.calToday}</div>
                <div class="pj-dashboard__kpi-main">{todayIso.slice(5)} <small>{t[todayWdKey]}</small></div>
                <div class="pj-dashboard__kpi-sub" title={today?.next ? `${today.next.start} ${today.next.summary}` : undefined}>
                    {t.dashBoardCount.replace("{n}", String(today?.boardCount ?? 0))}
                    · {t.dashTodoCount.replace("{n}", String(today?.todoCount ?? 0))}
                    · {#if today?.next}{t.dashNextUp.replace("{time}", today.next.start).replace("{summary}", today.next.summary)}{:else}{t.dashNextNone}{/if}
                </div>
                <button
                    class="pj-dashboard__cta"
                    onclick={openTodayTimeline}
                    title={t.dashOpenTimelineTitle}
                    aria-label={t.dashOpenTimelineTitle}
                >{t.dashOpenTimeline}</button>
            </div>

            <div class="pj-dashboard__card pj-dashboard__card--trend">
                <div class="pj-dashboard__card-title">{t.dashTrend}</div>
                <div class="pj-dashboard__kpi-main">{model.totals.done}<small> / {model.totals.total} {t.dashTrendDone}</small></div>
                {#if trend}
                    <div class="pj-dashboard__spark" role="img" aria-label={t.dashTrendTip} title={t.dashTrendTip}>
                        {#each trend.bars as b, i (b.date)}
                            <i
                                class="pj-dashboard__sparkbar"
                                class:pj-dashboard__sparkbar--today={i === trend.bars.length - 1}
                                style="height:{barPct(b.count, trend.max)}%"
                                title="{mdLabel(b.date)} · {b.count}"
                            ></i>
                        {/each}
                    </div>
                    <div class="pj-dashboard__spark-axis">
                        <span>{mdLabel(trend.bars[0].date)}</span>
                        <span>{mdLabel(trend.bars[Math.floor(trend.bars.length / 2)].date)}</span>
                        <span>{t.calToday}</span>
                    </div>
                {/if}
            </div>

            <div class="pj-dashboard__card pj-dashboard__card--sync">
                <div class="pj-dashboard__card-title">{t.dashSyncTitle}</div>
                {#if cal}
                    {#if cal.state === "not_configured"}
                        <div class="pj-dashboard__hint pj-dashboard__hint--status">{t.calNotConfigured}</div>
                    {:else if cal.state === "auth_broken"}
                        <div class="pj-dashboard__cal-broken">
                            {t.calAuthBroken}<span class="pj-dashboard__cal-code">{t.calAuthBrokenCode.replace("{code}", String(cal.authErrorCode ?? ""))}</span>
                        </div>
                    {:else}
                        {#if cal.state === "error"}
                            <div class="pj-dashboard__cal-line pj-dashboard__cal-line--main">{t.calSyncFailed}</div>
                            {#if cal.errorText}<div class="pj-dashboard__cal-errdetail">{cal.errorText}</div>{/if}
                        {:else}
                            <div class="pj-dashboard__cal-line pj-dashboard__cal-line--main">
                                <span class="pj-dashboard__dot" class:pj-dashboard__dot--idle={cal.state === "never" || !!cal.skippedReason}></span>
                                {cal.state === "never" ? t.calNever : `${t.calSyncedAt} ${calAgoText()}`}
                            </div>
                        {/if}
                        {#if cal.skippedReason}
                            <div class="pj-dashboard__cal-line">{skipText(cal.skippedReason)}</div>
                        {:else if calSummaryText()}
                            <div class="pj-dashboard__cal-line">{calSummaryText()}</div>
                        {/if}
                        <div class="pj-dashboard__cal-line">
                            {cal.channel === "oauth" ? t.calAuthOkB : t.calAuthOkBot}
                            · {t.calCounts.replace("{n}", String(cal.remindCount)).replace("{m}", String(cal.conflicts))}
                        </div>
                    {/if}
                    <div class="pj-dashboard__btnrow">
                        {#if calOperable}
                            <button class="pj-dashboard__ghost" onclick={onSyncNow} disabled={syncing} title={t.calSyncNowTitle} aria-label={t.calSyncNowTitle}>
                                {syncing ? t.calSyncing : t.calSyncNow}
                            </button>
                        {:else if cal.state === "auth_broken"}
                            <button class="pj-dashboard__ghost" onclick={onReauth} disabled={reauthing} title={t.calReauthTitle} aria-label={t.calReauthTitle}>
                                {reauthing ? t.calReauthing : t.calReauth}
                            </button>
                        {/if}
                        <button class="pj-dashboard__ghost" onclick={onOpenCalendar} title={t.calOpenCalendarTitle} aria-label={t.calOpenCalendarTitle}>{t.calOpenCalendar}</button>
                        {#if onOpenTimeline}
                            <button class="pj-dashboard__ghost" onclick={onOpenTimeline} title={t.calOpenTimelineTitle} aria-label={t.calOpenTimelineTitle}>{t.calOpenTimeline}</button>
                        {/if}
                    </div>
                    {#if calOperable}
                        <!-- tb2 H4：推送链路直测——消息+可选加急（应用内/短信/电话/需回复·签到）/ 马上到期事件（到点看手机） -->
                        <div class="pj-dashboard__testrow fn__flex">
                            <span class="pj-dashboard__testlabel">{t.testLabel}</span>
                            <select class="b3-select pj-dashboard__testsel" bind:value={testUrgent} aria-label={t.testUrgentTitle} title={t.testUrgentTitle}>
                                <option value="none">{t.testUrgentNone}</option>
                                <option value="app">{t.testUrgentApp}</option>
                                <option value="sms">{t.testUrgentSms}</option>
                                <option value="phone">{t.testUrgentPhone}</option>
                                <option value="reply">{t.testUrgentReply}</option>
                            </select>
                            <button class="b3-button b3-button--small b3-button--text pj-dashboard__testbtn" onclick={() => void onTestMsg()} disabled={testMsgBusy} title={t.testSendBtn} aria-label={t.testSendBtn}>
                                {testMsgBusy ? "…" : t.testSendBtn}
                            </button>
                            <span class="pj-dashboard__testsep">·</span>
                            {#each TEST_EVENT_LEVELS as [sec, label] (sec)}
                                <button class="b3-button b3-button--small b3-button--text pj-dashboard__testbtn" onclick={() => void onTestEvent(sec)} disabled={testEvtBusy !== null} title={t.testEventTitle} aria-label={label}>
                                    {testEvtBusy === sec ? "…" : label}
                                </button>
                            {/each}
                        </div>
                        <div class="pj-dashboard__hint pj-dashboard__hint--note">{t.testNote}</div>
                        <!-- tb6 □6d 机器人身份卡：换 app 凭证=换机器人——bot 名+appId 尾 4 位防配错 -->
                        {#if botInfo}
                            <div class="pj-dashboard__hint pj-dashboard__hint--note">
                                {botInfo.ok
                                    ? t.botIdentity.replace("{name}", botInfo.botName ?? "").replace("{id}", botInfo.appIdTail ?? "")
                                    : `${t.botIdentityFail}：${botInfo.error ?? ""}`}
                            </div>
                        {/if}
                    {/if}
                {:else}
                    <div class="pj-dashboard__hint pj-dashboard__hint--status">{t.dashboardLoading}</div>
                {/if}
            </div>
        </section>

        <section class="pj-dashboard__cols">
            <div class="pj-dashboard__card pj-dashboard__card--lines">
                <div class="pj-dashboard__card-title">
                    {t.skeleton}
                    <span class="pj-dashboard__card-headnote">{t.skeletonHead}</span>
                </div>
                <ul class="pj-dashboard__lines">
                    {#if addingLine}
                        <!-- 输入行置首：新线落点=updated 倒序顶部（vision P1 修——输入与落点就近连续） -->
                        <li class="pj-dashboard__line fn__flex">
                            <input
                                class="pj-dashboard__addline-input"
                                bind:this={addLineInput}
                                bind:value={newLineName}
                                placeholder={t.addLinePlaceholder}
                                disabled={addingBusy}
                                onkeydown={(e) => {
                                    if (e.key === "Enter") { e.preventDefault(); void submitNewLine(); }
                                    else if (e.key === "Escape") { e.preventDefault(); cancelAddLine(); }
                                }}
                                onblur={cancelAddLine}
                            />
                            {#if addingBusy}<span class="pj-dashboard__hint">{t.dashboardLoading}</span>{/if}
                        </li>
                        {#if addLineError}<li class="pj-dashboard__hint pj-dashboard__inline-error">{addLineError}</li>{/if}
                    {/if}
                    {#each model.lines as line (line.id)}
                        <li class="pj-dashboard__line fn__flex" class:pj-dashboard__line--main={line.isMain}>
                            <button class="pj-dashboard__line-name" title={line.name} onclick={() => openDoc(line.id)}>
                                {line.name}
                            </button>
                            <span class="fn__flex-1"></span>
                            {#if line.isMain}
                                <span class="pj-dashboard__tag">{t.mainDoc}</span>
                            {/if}
                            <span class="pj-dashboard__counts">{countsText(line.counts)}</span>
                        </li>
                    {/each}
                    {#if model.lines.length === 1}
                        <li class="pj-dashboard__hint pj-dashboard__hint--status">{t.skeletonEmpty}</li>
                    {/if}
                    {#if !addingLine}
                        <li>
                            <button
                                class="b3-button b3-button--text pj-dashboard__addline"
                                title={t.addLineTitle}
                                aria-label={t.addLineTitle}
                                onclick={startAddLine}
                            >{t.addLineBtn}</button>
                        </li>
                    {/if}
                    {#if onOpenDiary}
                        <li class="pj-dashboard__line pj-dashboard__line--diary fn__flex">
                            <button class="pj-dashboard__line-name" onclick={onOpenDiary}>{t.dashboardLogEntry}</button>
                            <span class="fn__flex-1"></span>
                            <span class="pj-dashboard__counts">{t.dashboardLogMonth.replace("{m}", todayIso.slice(0, 7))}</span>
                        </li>
                    {/if}
                    <li class="pj-dashboard__hint pj-dashboard__hint--note">{t.subdocNote}</li>
                </ul>
            </div>

            <div class="pj-dashboard__card pj-dashboard__card--scene">
                <div class="pj-dashboard__card-title">
                    {t.scene}
                    {#if model.scene}
                        <span class="pj-dashboard__card-headnote">· {model.scene.capturedAgo}</span>
                    {/if}
                </div>
                {#if model.scene}
                    <div class="pj-dashboard__tabs">
                        {#each model.scene.titles as title, i}
                            <span class="pj-dashboard__tab" class:pj-dashboard__tab--active={i === model.scene!.activeIndex}>{title}</span>
                        {/each}
                    </div>
                {:else}
                    <div class="pj-dashboard__hint pj-dashboard__hint--status">{t.sceneNone}</div>
                {/if}
                <!-- 保存/恢复现场从动作区移入本卡（草图拍板——操作贴近数据） -->
                <div class="pj-dashboard__btnrow">
                    <button class="pj-dashboard__ghost" onclick={onSaveScene} disabled={saving} title={t.saveScene} aria-label={t.saveScene}>
                        {savedAt ? `${t.saved} ${savedAt}` : t.saveSceneBtn}
                    </button>
                    <button
                        class="pj-dashboard__ghost"
                        onclick={onRestoreScene}
                        disabled={restoring || !model.scene}
                        title={model.scene ? t.restoreSceneNote : t.restoreSceneNone}
                        aria-label={model.scene ? t.restoreSceneNote : t.restoreSceneNone}
                    >{restoring ? t.restoring : t.restoreSceneBtn}</button>
                </div>
                <div class="pj-dashboard__hint pj-dashboard__hint--note">{t.sceneRestoreNote}</div>
            </div>
        </section>

        <section class="pj-dashboard__card pj-dashboard__card--actions">
            <div class="pj-dashboard__card-title">{t.actions}</div>
            {#if model.hasActionsSection}
                {#each actExtraRows as x (x.a.rawLine + "#" + x.i)}
                    {#if x.a.kind === "comment"}
                        <div class="pj-dashboard__hint pj-dashboard__hint--status pj-dashboard__act-comment">{x.a.label}</div>
                    {:else}
                        <div class="pj-dashboard__hint pj-dashboard__inline-error pj-dashboard__act-bad">{t.actBadLine.replace("{line}", x.a.label)}</div>
                    {/if}
                {/each}
            {/if}
            <!-- 动作横排（草图拍板）：自定义动作药丸+命令内联；尾随=问进展+打开主文档（ghost，
                 草图 P2：全页唯一主色实心留给「打开当天时间线」CTA） -->
            <div class="pj-dashboard__actgrid fn__flex">
                {#each actBtnRows as x (x.a.rawLine + "#" + x.i)}
                    {@const a = x.a}
                    <div class="pj-dashboard__actcell fn__flex" class:pj-dashboard__actcell--disabled={a.desktopOnly && !desktopOk}>
                        <button
                            class="pj-dashboard__actpill"
                            class:pj-dashboard__actpill--busy={busyAct === a.rawLine}
                            disabled={busyAct !== null || (a.desktopOnly && !desktopOk)}
                            title={a.desktopOnly && !desktopOk ? t.actDesktopOnlyTitle : a.command}
                            aria-label={a.desktopOnly && !desktopOk ? t.actDesktopOnlyTitle : a.command}
                            onclick={() => void onRunAction(a)}
                        ><span class="pj-dashboard__actpill-label">{a.label}</span><span class="pj-dashboard__actpill-cmd">{a.command}</span></button>
                        {#if a.program === "play" || a.program === "mpv"}
                            <button
                                class="pj-dashboard__actmark"
                                disabled={markingAct !== null}
                                title={t.actProgressTitle}
                                aria-label={t.actProgressTitle}
                                onclick={() => void onMarkProgress(a)}
                            >{markingAct === a.rawLine ? "…" : t.actProgressBtn}</button>
                        {/if}
                    </div>
                {/each}
                {#if actBtnRows.length > 0}
                    <span class="fn__flex-1"></span>
                {/if}
                <button class="pj-dashboard__actpill pj-dashboard__actpill--ghost" onclick={() => copyText(`用工作台插件看看「${model.project.name}」项目的进展如何？`, "ask")} title={t.askProgressTitle} aria-label={t.askProgressTitle}>
                    {copiedKey === "ask" ? t.copied : t.askProgress}
                </button>
                <button class="pj-dashboard__actpill pj-dashboard__actpill--ghost" onclick={() => openDoc(model.project.id)} title={t.openMainTitle} aria-label={t.openMainTitle}>{t.openMain}</button>
            </div>
            {#if model.hasActionsSection}
                {#if !desktopOk && model.actions.some((a) => a.kind === "action" && a.desktopOnly)}
                    <div class="pj-dashboard__hint pj-dashboard__hint--note">{t.actDesktopOnlyNote}</div>
                {/if}
                <div class="pj-dashboard__hint pj-dashboard__hint--note">{t.actFormatNote}</div>
            {/if}
        </section>
    {/if}
</div>

<style lang="scss">
    .pj-dashboard {
        padding: 16px 24px 20px;
        gap: 14px;
        overflow: auto;
        height: 100%;
        box-sizing: border-box;
        width: 100%;
        max-width: 1080px; /* tb2 ⑧ 卡片化：宽屏不摊大饼（草图 .wrap 同款） */
        margin: 0 auto;
    }

    .pj-dashboard__empty {
        color: var(--b3-theme-on-surface-light);
        padding: 32px 0;
        text-align: center;
    }

    .pj-dashboard__head {
        align-items: baseline;
        gap: 8px;
    }

    .pj-dashboard__name {
        font-size: 1.4em;
        font-weight: 600;
        color: var(--b3-theme-on-background);
    }

    .pj-dashboard__badge {
        font-size: 12px;
        color: var(--b3-theme-on-surface-light);
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        padding: 0 6px;
    }

    .pj-dashboard__totals {
        color: var(--b3-theme-on-surface-light);
        font-size: 13px;
    }

    /* ── tb2 ⑧ 卡片体系（草图 tb8_dash_mock 定稿） ── */
    .pj-dashboard__kpis {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 14px;
        align-items: stretch;
    }

    .pj-dashboard__cols {
        display: grid;
        grid-template-columns: 11fr 9fr; /* 骨架宽过现场（草图比例） */
        gap: 14px;
        align-items: start;
    }

    .pj-dashboard__card {
        background: var(--b3-theme-surface);
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius-b, 6px);
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
    }

    .pj-dashboard__card-title {
        font-size: 12px;
        color: var(--b3-theme-on-surface-light);
        letter-spacing: 0.05em;
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
    }

    .pj-dashboard__card-headnote {
        font-size: 11px;
        letter-spacing: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pj-dashboard__kpi-main {
        font-size: 22px;
        font-weight: 600;
        color: var(--b3-theme-on-background);
        font-variant-numeric: tabular-nums;

        small {
            font-size: 13px;
            font-weight: 400;
            color: var(--b3-theme-on-surface);
        }
    }

    .pj-dashboard__kpi-sub {
        color: var(--b3-theme-on-surface);
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* 主 CTA（全页唯一主色实心——草图 P2：打开主文档等降 ghost 让位） */
    .pj-dashboard__cta {
        margin-top: auto; /* 三卡等高时贴底对齐 */
        width: 100%;
        padding: 6px 0;
        border: none;
        border-radius: var(--b3-border-radius, 4px);
        background: var(--b3-theme-primary);
        color: #fff;
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;

        &:hover {
            background: color-mix(in srgb, var(--b3-theme-primary) 85%, #000);
        }
    }

    .pj-dashboard__btnrow {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
    }

    /* ghost 钮：透明底+主色描边（同步卡/现场卡共用）。
     * 视觉终审 P1：原 min-width:0 允许缩到内容宽以下=ellipsis 过早触发（四钮并排期
     * 「打开日历/打开时间线」截成「打…」动作不可辨）——保内容宽（nowrap 下 fit-content=
     * 全文案），放不下走 btnrow flex-wrap 换行不截断 */
    .pj-dashboard__ghost {
        flex: 1;
        min-width: fit-content;
        padding: 5px 10px;
        border: 1px solid var(--b3-theme-primary-light);
        border-radius: var(--b3-border-radius, 4px);
        background: transparent;
        color: var(--b3-theme-primary);
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;

        &:hover:not(:disabled) {
            background: color-mix(in srgb, var(--b3-theme-primary) 8%, transparent);
        }

        &:disabled {
            cursor: default;
            opacity: 0.55;
        }
    }

    /* 走势柱（近 14 天每日新完成任务数；末柱=今天实心） */
    .pj-dashboard__spark {
        display: flex;
        align-items: flex-end;
        gap: 3px;
        height: 44px;
        margin-top: 2px;
    }

    .pj-dashboard__sparkbar {
        flex: 1;
        min-width: 0;
        min-height: 2px; /* 5% 矮桩在 44px 轴≈2px，防零日整柱消失 */
        background: var(--b3-theme-primary-light);
        border-radius: 2px 2px 0 0;
    }

    .pj-dashboard__sparkbar--today {
        background: var(--b3-theme-primary);
    }

    .pj-dashboard__spark-axis {
        display: flex;
        justify-content: space-between;
        color: var(--b3-theme-on-surface); /* vision ⑧：11px 小字 AA 线 4.5:1（on-surface-light 差半档） */
        font-size: 11px;
        font-variant-numeric: tabular-nums;
    }

    /* 同步卡状态点（绿=常态；灰=never/本轮跳过；坏态走 cal-broken 红文案无点） */
    .pj-dashboard__dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--b3-card-success-color, #1d7a33);
        margin-right: 6px;
    }

    .pj-dashboard__dot--idle {
        background: var(--b3-theme-on-surface-light);
    }

    /* ── 动作卡横排（草图 actgrid） ── */
    .pj-dashboard__actgrid {
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
    }

    .pj-dashboard__actcell {
        align-items: center;
        gap: 4px;
        flex-shrink: 1;
        min-width: 0;
    }

    .pj-dashboard__actcell--disabled {
        opacity: 0.55;
    }

    .pj-dashboard__actpill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        max-width: 100%;
        padding: 5px 12px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius, 4px);
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-background);
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;

        &:hover:not(:disabled) {
            background: var(--b3-list-hover);
        }

        &:disabled {
            cursor: default;
        }
    }

    .pj-dashboard__actpill--busy {
        opacity: 0.5;
    }

    .pj-dashboard__actpill--ghost {
        background: transparent;
        border-color: var(--b3-theme-primary-light);
        color: var(--b3-theme-primary);

        &:hover:not(:disabled) {
            background: color-mix(in srgb, var(--b3-theme-primary) 8%, transparent);
        }
    }

    .pj-dashboard__actpill-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pj-dashboard__actpill-cmd {
        color: var(--b3-theme-on-surface-light);
        font-size: 11px;
        font-family: var(--b3-font-family-code, monospace);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* 暗色下描边钮边框提亮一档（⑦ vision P2：--b3-border-color 暗色过沉）；
     *  ghost 系保留蓝相（vision ⑧：灰系混合让「蓝字灰边」跨主题色相漂移） */
    :global(html[data-theme-mode="dark"]) .pj-dashboard__openforest,
    :global(html[data-theme-mode="dark"]) .pj-dashboard__actpill {
        border-color: color-mix(in srgb, var(--b3-border-color) 55%, var(--b3-theme-on-surface-light));
    }

    :global(html[data-theme-mode="dark"]) .pj-dashboard__ghost,
    :global(html[data-theme-mode="dark"]) .pj-dashboard__actpill--ghost {
        border-color: color-mix(in srgb, var(--b3-theme-primary-light) 55%, var(--b3-theme-on-surface-light));
    }

    /* 暗色走势矮桩提亮（vision ⑧：primary-light 在暗底辨识度低） */
    :global(html[data-theme-mode="dark"]) .pj-dashboard__sparkbar {
        background: color-mix(in srgb, var(--b3-theme-primary) 45%, transparent);
    }

    :global(html[data-theme-mode="dark"]) .pj-dashboard__sparkbar--today {
        background: var(--b3-theme-primary);
    }

    /* 窄面板（未来 dock 化兜底）：三卡/两列退单列 */
    @media (max-width: 720px) {
        .pj-dashboard__kpis,
        .pj-dashboard__cols {
            grid-template-columns: 1fr;
        }
    }

    /* timeblock ⑦：开森林图页签的头部按钮（原 skeleton/forest 切换的继任者——
       同款描边药丸形态，动作语义=开新页签） */
    .pj-dashboard__openforest {
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: transparent;
        color: var(--b3-theme-on-surface-light);
        font-size: 12px;
        padding: 3px 10px;
        cursor: pointer;
        line-height: 1.5;
        flex-shrink: 0;

        &:hover {
            background: var(--b3-list-hover);
            color: var(--b3-theme-primary);
        }

        /* 收拢钮 busy 态（复用本类的 sweep 钮禁用弱化） */
        &:disabled {
            opacity: 0.55;
            cursor: default;
        }
    }

    /* 删除项目头部钮：同 openforest 描边药丸形态、危险色字（破坏性动作显性化）。
     * 危险色必须带 fallback——var() 落在不存在变量上=整条声明静默失效（AGENTS 坑） */
    .pj-dashboard__deleteproject {
        border: 1px solid color-mix(in srgb, var(--b3-card-error-color, #d23f31) 55%, transparent);
        border-radius: var(--b3-border-radius);
        background: transparent;
        color: var(--b3-card-error-color, #d23f31);
        font-size: 12px;
        padding: 3px 10px;
        cursor: pointer;
        line-height: 1.5;
        flex-shrink: 0;

        &:hover {
            background: color-mix(in srgb, var(--b3-card-error-color, #d23f31) 10%, transparent);
        }
    }

    .pj-dashboard__lines {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
    }

    .pj-dashboard__line {
        align-items: center;
        gap: 8px;
        padding: 2px 0;
        border-bottom: 1px solid var(--b3-border-color);
        min-width: 0;

        &:last-child {
            border-bottom: none;
        }
    }

    .pj-dashboard__line-name {
        padding: 2px 6px;
        min-width: 0;
        max-width: 60%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
        border: 0;
        background: transparent;
        color: var(--b3-theme-on-background);
        cursor: pointer;
        border-radius: var(--b3-border-radius);

        &:hover {
            background: var(--b3-list-hover);
        }
    }

    .pj-dashboard__line--main .pj-dashboard__line-name {
        font-weight: 600;
    }

    .pj-dashboard__tag {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        padding: 0 5px;
    }

    .pj-dashboard__counts {
        flex-shrink: 0;
        color: var(--b3-theme-on-surface-light);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
    }

    .pj-dashboard__tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .pj-dashboard__tab {
        font-size: 12px;
        padding: 2px 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background-color: var(--b3-theme-surface);
        color: var(--b3-theme-on-surface);
        max-width: 16em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pj-dashboard__tab--active {
        border: 1px solid var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }

    .pj-dashboard__hint {
        color: var(--b3-theme-on-surface-light);
        font-size: 13px;
        padding: 4px 0;
    }

    /* 日历区状态行（按钮化 b）：正文色正文级，信息平铺不藏 hover */
    .pj-dashboard__cal-line {
        color: var(--b3-theme-on-surface);
        font-size: 13px;
    }

    /* 同步卡主状态行（时点/故障标题行）：加重一档与摘要行分主次 */
    .pj-dashboard__cal-line--main {
        font-weight: 500;
    }

    /* 授权坏红态行（按钮化 d）：错误色+加重，重授权按钮就地下场 */
    .pj-dashboard__cal-broken {
        color: var(--b3-card-error-color, #d23f31);
        font-size: 13px;
        font-weight: 500;
    }

    /* 状态行（无快照/无线）正文色——与常驻帮助行（sceneNote）拉开主次 */
    .pj-dashboard__hint--status {
        color: var(--b3-theme-on-surface);
    }

    /* 常驻操作说明行正文色：13px 浅灰 3:1 不达 AA（vision P1），与 Conf 的 desc 同标准 */
    .pj-dashboard__hint--note {
        color: var(--b3-theme-on-surface);
    }

    /* tb2 H4：推送测试行——紧凑单行（标签+加急档选择+发消息+到期三档），与按钮化 b 视觉同族 */
    .pj-dashboard__testrow {
        align-items: center;
        gap: 8px;
        margin-top: 6px;
        flex-wrap: wrap;
    }

    .pj-dashboard__testlabel {
        color: var(--b3-theme-on-surface-light);
    }

    .pj-dashboard__testsel {
        height: 24px;
        padding: 0 4px;
        font-size: 12px;
        border-radius: var(--b3-border-radius, 4px);
        background-color: var(--b3-theme-background);
    }

    .pj-dashboard__testbtn {
        padding: 0 8px;
    }

    .pj-dashboard__testsep {
        color: var(--b3-theme-on-surface-light);
    }

    /* 日历红态错误码平铺（□2 顺手 P2：不藏 hover，同「信息平铺」偏好） */
    .pj-dashboard__cal-code {
        font-weight: 400;
        font-size: 12px;
    }

    /* 同步失败原因平铺次行（原先藏 hover title） */
    .pj-dashboard__cal-errdetail {
        color: var(--b3-card-error-color, #d23f31);
        font-size: 12px;
        word-break: break-all;
    }

    /* 注释行弱化走斜体而非浅色（on-surface-light 3.1:1 不达 AA——既往 P1 教训） */
    .pj-dashboard__act-comment {
        font-style: italic;
    }

    .pj-dashboard__actmark {
        border: 0;
        background: transparent;
        color: var(--b3-theme-on-surface);
        font-size: 12px;
        padding: 2px 6px;
        flex-shrink: 0;
        cursor: pointer;
        border-radius: var(--b3-border-radius);

        &:hover:not(:disabled) {
            color: var(--b3-theme-on-background);
            background: var(--b3-list-hover);
        }

        &:disabled {
            cursor: default;
            opacity: 0.5;
        }
    }

    /* □4 重命名：项目名旁小图标钮（透明底，hover 微亮） */
    .pj-dashboard__iconbtn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--b3-theme-on-surface-light);
        cursor: pointer;
        border-radius: var(--b3-border-radius);
        align-self: center;

        &:hover {
            color: var(--b3-theme-on-background);
            background: var(--b3-list-hover);
        }

        svg {
            width: 14px;
            height: 14px;
        }
    }

    /* inline 编辑输入（重命名/加线共用视觉：无框底线，聚焦亮起） */
    .pj-dashboard__rename-input,
    .pj-dashboard__addline-input {
        font-size: 14px;
        padding: 2px 6px;
        min-width: 0;
        border: 0;
        border-bottom: 1px solid var(--b3-border-color);
        background: transparent;
        color: var(--b3-theme-on-background);
        outline: none;

        &:focus {
            border-bottom-color: var(--b3-theme-primary);
        }
    }

    .pj-dashboard__rename-input {
        font-size: 1.4em; /* 与 .pj-dashboard__name 同级——编辑态字号不跳 */
        font-weight: 600;
        max-width: 50%;
    }

    .pj-dashboard__addline-input {
        flex: 1;
    }

    .pj-dashboard__inline-error {
        color: var(--b3-card-error-color, #d23f31);
        font-size: 12px;
    }

    .pj-dashboard__addline {
        padding-left: 0; /* 与线名左缘对齐（b3-button 默认 padding 会凸出） */
    }
</style>
