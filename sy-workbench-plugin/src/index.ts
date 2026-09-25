// Plugin/openTab 等必须是命名导入：default 导入在 rolldown CJS interop 下包成整对象，
// 前端 requireFunc 拿不到构造函数 → "Class extends value is not a constructor"（四插件基类同款写法）
import { Plugin, getAllTabs, getActiveEditor, getAllEditor, openTab, showMessage, Dialog } from "siyuan";
import { mount, unmount } from "svelte";
import { debugLog } from "./libs/debugLog";
import { captureScene, replayPlan, sceneEquals, type SceneSnapshot } from "./kernel/core/scene";
import type { CalendarStatus } from "./kernel/core/calendarStatus";
import { getLogicalDay } from "./kernel/core/dates";
import type { OpenScenePayload, RemindWrittenPayload } from "./shared/channels";
import { AMMO_STATE_CHANNEL, AMMO_LIVE_SYNCED_CHANNEL } from "./shared/channels";
import { ACTIVE_PROJECT_KEY, ACTIONS_UPDATED_CHANNEL, BEHAVIOR_COLLECT_METHOD, BEHAVIOR_GET_METHOD, BEHAVIOR_PROFILE_FILE, CALENDAR_AUTH_METHOD, CALENDAR_CLEAR_METHOD, CALENDAR_INSTANCES_METHOD, CALENDAR_MIRROR_CONF_FILE, CALENDAR_MIRROR_FILE, CALENDAR_MIRROR_META_FILE, CALENDAR_MIRROR_POLL_METHOD, CALENDAR_SETUP_METHOD, CALENDAR_STATUS_CHANNEL, CALENDAR_STATUS_FILE, CAPTURE_CHANNEL, DEFAULT_REMINDER_CHANNELS, FEEDBACK_FILE, LEDGER_FILE, POMO_BRIDGE_STATE_FILE, POMODORO_LOG_FILE, ONBOARD_FILE, PROJECT_CREATE_METHOD, PROJECT_DELETE_METHOD, REMIND_WRITTEN_CHANNEL, REMINDER_CHANNELS_FILE, ROUTINE_TRAINING_FILE, ROUTINE_WEEKLY_FILE, SCENE_CHANNEL, SCHEDULE_FILE, SCHEDULE_SYNC_METHOD, SCHEDULE_UPDATED_CHANNEL, SCHED_BOARD_SYNC_METHOD, SCHED_BOARD_READ_METHOD, AMMO_LEDGER_READ_METHOD, AMMO_DEPART_METHOD, LINE_SWEEP_METHOD,
    FEISHU_TEST_SEND_METHOD, FEISHU_TEST_EVENT_METHOD, FEISHU_BOT_INFO_METHOD, SCHED_FOREIGN_DELETE_METHOD, REMIND_ENTRY_CREATE_METHOD, SCHED_MIRROR_CONF_FILE, WEATHER_CONFIG_FILE, WEATHER_SYNC_METHOD, WEEKLY_REPORT_SYNC_METHOD, sceneKey, type ReminderChannels } from "./shared/channels";
import { stayTracker } from "./behavior/tracker";
import { SchedNotifier } from "./schedNotify";
import type { ActionsUpdatedPayload } from "./shared/channels";
import { replaySteps, OPEN_NO_FOCUS_ACTION } from "./scene/executor";
import { feQuery } from "./gui/fe";
import { runOAuthFlow } from "./gui/oauth";
import { buildAuthorizeUrl } from "./kernel/core/feishu";
import { OAUTH_REDIRECT_URI } from "./shared/channels";
import { projectDocSql, allDueTasksSql, listBoardBlocksSql, boardRowsToSchedItems, docPathSql, dayConfigDocSql, diaryJumpSqls, type BoardScanRow, type ProjectRow } from "./gui/queries";
import { fetchProjectSnapshot } from "./gui/projectSource";
import { listRemindBlocksSql } from "./kernel/core/remind";
import { renderSwitcherLabel, showSwitcherMenu } from "./gui/switcher";
import { triggerRemindSync } from "./reminder/panel";
import Dashboard from "./Dashboard.svelte";
import GanttView from "./GanttView.svelte";
import CreateProjectDialog from "./CreateProjectDialog.svelte";
import Calendar from "./Calendar.svelte";
import Timeline from "./Timeline.svelte";
// ammo □9：悬浮窗弹药库（外壳 AmmoFloatPanel+宿主 AmmoFloatBox——正文复用 □6 数据宿主
// AmmoPanelHost（其内），dock 时间线/页签联动走同一 window 事件链）
import { AmmoFloatBox, ammoFloatKeycap } from "./AmmoFloat";
// caltab：独立「时间线」页签组件（TimelineTab——Timeline.svelte 已被 sloop □21 dock 常驻面板占用）
import TimelineTab from "./TimelineTab.svelte";
import Conf from "./Conf.svelte";
import HandoffDialog from "./HandoffDialog.svelte";
// 跨插件共享件同 p/s/r 相对导入先例（构建期打进本插件 bundle）：McpPromo 引导卡的
// 文案单例 tomatoI18n 需在本插件 onload 调 init()（各插件 bundle 内是独立实例，
// conf 不 init 则 lang 恒 en_US）
import { tomatoI18n } from "../../sy-tomato-plugin/src/tomatoI18n";
// □3 改键防撞/存量迁移共用层（HotkeyCap 纯逻辑件——HotkeyCap.svelte 大图不可跨插件，本文件只
// import 纯函数库，CJS 打包图安全）
import { setPluginHotkey } from "../../sy-tomato-plugin/src/libs/hotkeyCap";
import "./gui/switcher.css";
import "./reminder/remind.css";
import { RemindInjector } from "./reminder/render";
import { TaskBadgeInjector } from "./reminder/taskBadge";
import { pickBlockIconEntry, setRemindHotkeyLabel } from "./reminder/entryCore";
import { escapeHtml } from "./gui/fe";
import { reloadSelfPlugin } from "../../sy-tomato-plugin/src/libs/pluginReload";
import { DEFAULT_ENTRY_TOGGLES, ENTRY_TOGGLES_FILE, normalizeEntryToggles, type EntryToggles } from "./entryToggles";
import { GANTT_PREFS_FILE } from "./ganttPrefs";
import { applyDragRow, boardRowsToItems, buildRecon, genSchedKey, mergeBoardDayRows, normalizeSchedule, type DragRecord, type SchedAddKeyOp, type SchedEditOp, type SchedItem, type SchedStore } from "./kernel/core/schedule";
import { buildHandoffPacket } from "./handoffSeed";
import OnboardDialog from "./OnboardDialog.svelte";
// dataview □6：全局速记小窗（输入件 QuickInlineInput 复用件+写通道 quickAdd——落活跃项目任务章节）
import QuickEntryDialog from "./QuickEntryDialog.svelte";
import { quickAddTask } from "./gui/quickAdd";
import type { QuickParseResult } from "./gui/quickParse";
// dataview □4：看板页签组件（零自有存储纯投影——列=按池/按线查询分组，契约 §4/§7）
import BoardView from "./BoardView.svelte";
// dataview B2：月度对账页签组件（零存储纯投影——配额达成+时段热力+计划偏差，收据不是考卷）
import ReconView from "./ReconView.svelte";
import { getArchetype, projectDraft, buildBaselineReport, buildMirrorPacket, type ArchMatch, type DraftItem, type OnboardConstraints } from "./kernel/core/formlib";
import { normalizeOnboard, startObserving as startObservingCore, freezeBaseline, observeDays, type OnboardBaseline, type OnboardStore } from "./kernel/core/onboard";
import { feedbackOf, normalizeFeedback, type FeedbackStore } from "./kernel/core/feedback";
import { normalizeWeekly, type WeeklyStore } from "./kernel/core/report";
import { buildTrainingContext, normalizeTraining } from "./kernel/core/training";
import { dayAlmanac } from "./lunarInfo";
import { shiftDay } from "./kernel/core/behavior";

// 前端薄壳（P1 定案：无 UI）：kernel broadcast 收恢复指令 → 执行 openTab 页签集恢复；
// 现场捕获=「打开其他项目时自动存当前现场」，快照与 kernel siyuan.storage 同文件
// （saveData 字面路径=/data/storage/petal/<插件名>/，P0/官方源码双确认）。
// P3 □4 增 GUI（bear 09-11 拍板方案一）：顶栏切换器（iconWorkspace+当前项目名→Menu 切换）
// +驾驶舱页签（骨架树+现场状态+只读动作区；打开项目自动弹，用户关过=本 session 不再弹）。

interface ActiveProjectRecord {
    projectId: string;
    at: number;
}

const DASHBOARD_TAB = "-dashboard";
/** calnav □3：独立日历页签（openTab custom；标题「日历」只读月历三源） */
const CALENDAR_TAB = "-calendar";
/** caltab 期：独立「时间线」页签（openTab custom；单例——已开聚焦+切内容，openTimeline） */
const TIMELINE_TAB = "-timeline";
/** gantt-lanes：甘特图独立整页页签（原森林图页签换代——去重聚焦复用 openBoard 同款） */
const GANTT_TAB = "-gantt";
/** dataview □4：看板独立页签（零存储纯投影——列=按池/按线查询分组；单例聚焦复用同 openGantt） */
const BOARD_TAB = "-board";
/** dataview B2：月度对账独立页签（零存储纯投影——配额达成+时段热力+计划偏差；「收据不是考卷」） */
const RECON_TAB = "-recon";
/** sloop □21：当天时间线 dock（dock_ 前缀=进 keymap 的硬约束；右下常驻，点击 dock 图标开合） */
const TIMELINE_DOCK = "dock_pj_timeline";
/** 切项目后通知驾驶舱原地刷新的事件名（detail.projectId） */
const PROJECT_SWITCHED_EVENT = "pj-project-switched";
/** kernel 日历状态广播→驾驶舱/Conf 直刷的 window 事件名（detail=CalendarStatus） */
const CALENDAR_STATUS_EVENT = "pj-calendar-status";
/** kernel 动作段改写广播→驾驶舱动作区直刷的 window 事件名（detail=ActionsUpdatedPayload） */
const ACTIONS_UPDATED_EVENT = "pj-actions-updated";
/** 授权坏提醒去重（同因当天一次）：localStorage 记 {code,day} */
const AUTH_NOTIFY_KEY = "pj-auth-notify";

/** setBlockAttrs 直写（data 恒 null 非 failure；与 reminder/render.ts 同通道——属性写不走 kernel rpc） */
async function writeBlockAttrsDirect(blockId: string, attrs: Record<string, string>): Promise<void> {
    const token = (window as any).siyuan?.config?.api?.token ?? "";
    const r = await fetch("/api/attr/setBlockAttrs", {
        method: "POST",
        headers: { Authorization: `Token ${token}` },
        body: JSON.stringify({ id: blockId, attrs }),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(d.msg ?? `setBlockAttrs failed: ${r.status}`);
}

export default class ProjectPlugin extends Plugin {
    private unbindFns: Array<() => void> = [];
    private activeProjectId: string | null = null;
    /** 本项目页签域（恢复时记账）——捕获只收域内页签，防多项目页签互串污染快照（review P1-2）；null=首次未恢复=全收 */
    private projectDocIds: Set<string> | null = null;
    /** 恢复进行中标志：串行化 open 广播，防半恢复状态被捕获（review P2-7） */
    private restoring = false;
    /** 顶栏切换器按钮（addTopBar 产物；项目名随切换重渲染） */
    private switcherButton: HTMLElement | null = null;
    /** 用户关过驾驶舱页签=本 session 不再自动弹（bear 拍板②；reload 重置） */
    private dashboardDismissed = false;
    /** remind □1：块提醒图标注入器（文档切换/加载事件驱动；tb2 H2 传账本只读通道=同步徽标） */
    private remindInjector = new RemindInjector(this as any, () => this.readPetalJsonViaHttp(LEDGER_FILE));
    /** dataview □7：任务块池/日期徽标注入器（点击弹快捷菜单——参数编辑就地通道） */
    private taskBadgeInjector = new TaskBadgeInjector(this as any);
    /** sloop □7：班表到点提醒引擎（toast/弹窗——与外部日历提醒解耦勾选） */
    private schedNotifier = new SchedNotifier();
    /** 按钮化 e：每小时自动同步定时器（前端 setInterval——goja 无定时器故不走 kernel） */
    private hourlyTimer: ReturnType<typeof setInterval> | null = null;
    /** pjux □2：命令与入口开关（petal entry-toggles.json；onload 载入，右键/slash 消费点活读） */
    private entryToggles: EntryToggles = { ...DEFAULT_ENTRY_TOGGLES };
    /** □3 setRemind 存量空条目待迁移标志（setupRemind 判形置位，onload 末尾统一串行清账） */
    private needSetRemindMigrate = false;
    /** 重载竞态窗守卫：onunload 后 openSetting 早退（review P2-3） */
    private unloaded = false;

    async onload(): Promise<void> {
        debugLog("fe", "frontend onload");
        tomatoI18n.init();
        this.installErrorBridge();
        const kernelAny = (this as any).kernel;
        if (kernelAny?.rpc) {
            kernelAny.rpc.bind(SCENE_CHANNEL, (params: OpenScenePayload) => {
                void this.onOpenScene(params);
            });
            kernelAny.rpc.bind(CAPTURE_CHANNEL, () => {
                void this.captureAndSave();
            });
            kernelAny.rpc.bind(REMIND_WRITTEN_CHANNEL, (params: RemindWrittenPayload) => {
                // □3 外部写入（飞书回写/MCP set·delete）直刷已开编辑器的图标文案
                try {
                    this.remindInjector.refreshBlock(params.blockId, params.at, params.repeat, params.end);
                } catch (e) {
                    debugLog("remind", `!! remind-written refresh failed: ${String(e)}`);
                }
            });
            // 按钮化 b/d：kernel 每轮同步完广播状态→驾驶舱/Conf 直刷+授权坏通知（同因当天一次）
            kernelAny.rpc.bind(CALENDAR_STATUS_CHANNEL, (status: CalendarStatus) => {
                this.onCalendarStatus(status);
            });
            // □2：MCP set_actions 改写主文档动作段→驾驶舱动作区直刷（window 事件承载）
            kernelAny.rpc.bind(ACTIONS_UPDATED_CHANNEL, (payload: ActionsUpdatedPayload) => {
                window.dispatchEvent(new CustomEvent(ACTIONS_UPDATED_EVENT, { detail: payload }));
            });
            // sloop □4：kernel 侧写班表（晨间滚动/MCP routine）→月历班表区直刷（window 事件承载）
            kernelAny.rpc.bind(SCHEDULE_UPDATED_CHANNEL, () => {
                window.dispatchEvent(new CustomEvent("pj-schedule-updated"));
                // □7：macOS 镜像后端下 kernel 写不了日历——渲染进程在此搭车（debounce 内部判后端）
            });
            // ammo □6：引擎状态广播（start/stop/depart/resolve 落账+恢复扫描）→window 事件
            // （AmmoPanelHost 订阅重拉；□7 时间线消费同一事件——内存事件链，非 SQL 轮询）
            kernelAny.rpc.bind(AMMO_STATE_CHANNEL, () => {
                window.dispatchEvent(new CustomEvent("pj-ammo-state"));
            });
            // ammo □7：实况手动同步完成广播→window 事件（同步钮/实况段同步徽标直刷；payload=AmmoLiveSyncResult）
            kernelAny.rpc.bind(AMMO_LIVE_SYNCED_CHANNEL, (payload: unknown) => {
                window.dispatchEvent(new CustomEvent("pj-ammo-live-synced", { detail: payload }));
            });
            this.unbindFns.push(() => {
                try {
                    kernelAny.rpc.unbind(SCENE_CHANNEL);
                } catch { /* 卸载时 rpc 已回收 */ }
                try {
                    kernelAny.rpc.unbind(CAPTURE_CHANNEL);
                } catch { /* 同上 */ }
                try {
                    kernelAny.rpc.unbind(REMIND_WRITTEN_CHANNEL);
                } catch { /* 同上 */ }
                try {
                    kernelAny.rpc.unbind(CALENDAR_STATUS_CHANNEL);
                } catch { /* 同上 */ }
                try {
                    kernelAny.rpc.unbind(ACTIONS_UPDATED_CHANNEL);
                } catch { /* 同上 */ }
                try {
                    kernelAny.rpc.unbind(SCHEDULE_UPDATED_CHANNEL);
                } catch { /* 同上 */ }
                try {
                    kernelAny.rpc.unbind(AMMO_STATE_CHANNEL);
                } catch { /* 同上 */ }
                try {
                    kernelAny.rpc.unbind(AMMO_LIVE_SYNCED_CHANNEL);
                } catch { /* 同上 */ }
            });
        } else {
            debugLog("fe", "!! kernel.rpc unavailable at onload");
        }

        // 恢复上次活跃项目记录（懒初始化：文件不存在=首次，activeProjectId 保持 null）
        try {
            const raw = await this.loadData(ACTIVE_PROJECT_KEY);
            const rec = typeof raw === "string" ? JSON.parse(raw || "null") : raw;
            if (rec?.projectId) {
                this.activeProjectId = rec.projectId;
                // 恢复出的驾驶舱页签可能先于本 await 挂载（init 拿到空 projectId）——
                // 补发切换事件让空驾驶舱回填加载（09-14 e2e 实锤的挂载竞速）
                window.dispatchEvent(new CustomEvent(PROJECT_SWITCHED_EVENT, { detail: { projectId: rec.projectId } }));
            }
        } catch { /* 无存档 */ }

        this.setupGui();
        void this.updateSwitcherLabel(); // 启动时顶栏显示上次活跃项目名（无项目=占位符）

        // pjux □2：入口开关载入（早于命令注册——off 的命令不进命令面板/keymap）
        try {
            this.entryToggles = normalizeEntryToggles(await this.loadData(ENTRY_TOGGLES_FILE));
        } catch { /* 无档=全开默认 */ }

        if (this.entryToggles.saveScene) {
            // addCommand 官方 API（非裸 commands.push）：才会建 keymap.plugin 条目（HotkeyCap
            // 改键写回的前提——裸 push 在 keymap 里整插件缺席，pjux □2 e2e 实锤）+注册命令面板
            this.addCommand({
                langKey: "saveScene",
                hotkey: "",
                callback: () => {
                    void this.captureAndSave();
                },
            });
        }

        // caltab：命令面板「打开时间线」（入口开关=entryToggles.openTimeline，照 saveScene 模式）。
        // languages 就绪守卫（tomato QuickNote 09-17 实锤同因）：思源 boot 顺序 loadPlugins 先于
        // window.siyuan.languages 挂载，addCommand 链上带全局副作用时竞态输掉会 TypeError 断
        // onload——languages 未挂=轮询等就绪再注册（通常 <1s）；15s 仍无（#18970 形态）=直接
        // 注册并吞错（命令面板注册在思源炸点之前完成，仅丢系统级全局快捷键）。
        if (this.entryToggles.openTimeline) {
            const registerOpenTimelineCmd = () => {
                try {
                    this.addCommand({
                        langKey: "openTimeline",
                        hotkey: "",
                        callback: () => {
                            this.openTimeline();
                        },
                    });
                } catch (e) {
                    debugLog("fe", `openTimeline 命令注册失败（languages 异常环境，重载可重试）：${String(e)}`);
                }
            };
            if ((window as any).siyuan?.languages) {
                registerOpenTimelineCmd();
            } else {
                let waited = 0;
                const watcher = setInterval(() => {
                    waited += 200;
                    if ((window as any).siyuan?.languages || waited >= 15_000) {
                        clearInterval(watcher);
                        registerOpenTimelineCmd();
                    }
                }, 200);
                this.unbindFns.push(() => clearInterval(watcher));
            }
        }

        // ammo □9：命令面板「打开/收起弹药库悬浮窗」（□6 Dialog 临时宿主退役——callback 换
        // 悬浮窗 toggle，langKey=openAmmo 沿用=旧 keymap 条目/改键记录无缝迁移）。
        // 默认键 ⌥⇧⌘A（A=Ammo 助记）。□3 翻案：原定 "⌘⌥⇧A" 是非规范序死键——内核 matchHotKey
        // （app/src/protyle/util/hotKey.ts）分支写死符号序，⌘ 开头含 ⌥ 的串落 isOnlyMeta&&!altKey
        // 恒 false；规范序=官方 getKeymapString 口径 ⌃⌥⇧⌘+主键（⌥⇧⌘A 才能匹配物理
        // Command+Option+Shift+A，物理组合不变仅串序改写）。查重（物理等价）：官方 constants.ts
        // 三修饰段无 A；四仓 winHotkey 三修饰已占 B/E/F/G/M/O/S/Q/6；⌥⇧⌘A 存量唯一=
        // seller 快捷菜单 default 字段（custom 已迁 ⌘⌥⇧H 不参与分发，无运行期撞）。
        // languages 就绪守卫=openTimeline 同款（addCommand 全局副作用竞态）。
        this.ammoFloat = new AmmoFloatBox({
            t: this.i18n as unknown as Record<string, string>,
            rpc: (this as any).kernel?.rpc ?? null,
            onOpenCalendar: () => this.openCalendar(),
            // dataview □8：体检条目跳转（openDocNoFocus=cb-get-hl 只滚动定位禁聚焦）
            onOpenBlock: (id: string) => this.openDocNoFocus(id),
            // mainfix0923 □5：文件地图跳转（定位不到=toast 不懒建；恒走 openDocNoFocus）
            onOpenDayConfig: () => void this.openDayConfigDoc(),
            onOpenDiary: () => void this.openTodayDiary(),
        });
        this.ammoFloat.onload();
        {
            const registerOpenAmmoCmd = () => {
                try {
                    this.addCommand({
                        langKey: "openAmmo",
                        hotkey: "⌥⇧⌘A",
                        callback: () => {
                            this.ammoFloat?.togglePanel();
                        },
                    });
                } catch (e) {
                    debugLog("fe", `openAmmo 命令注册失败（languages 异常环境，重载可重试）：${String(e)}`);
                }
            };
            if ((window as any).siyuan?.languages) {
                registerOpenAmmoCmd();
            } else {
                let waited = 0;
                const watcher = setInterval(() => {
                    waited += 200;
                    if ((window as any).siyuan?.languages || waited >= 15_000) {
                        clearInterval(watcher);
                        registerOpenAmmoCmd();
                    }
                }, 200);
                this.unbindFns.push(() => clearInterval(watcher));
            }
        }

        // ammoentry □2：顶栏「弹药库」按钮（bear 点名要可见入口；switcherButton 同构 addTopBar
        // 形态）。开关=entryToggles.openAmmoTopbar——off 不注册（入口开关 onload 注册读死，
        // 切换走 setEntryToggle 命令族同款「收面板+reloadSelfPlugin」生效）。title=文案+键帽
        // （tomato settings gear 同构：langText+w()；键帽活读 keymap=ammoFloatKeycap 改键
        // 跟随，重载刷新）；iconInbox=库/箱托盘语义（真相源 appearance/icons/litheness/icon.js
        // 全清单核过，无弹药/火箭类符号；stroke 线稿与 iconWorkspace 同族）；callback=悬浮窗
        // 同一 toggle（勿做第二通道）。
        if (this.entryToggles.openAmmoTopbar) {
            const kc = ammoFloatKeycap(); // □3：键禁用（custom=""）返回空串——title 截断键位段
            this.addTopBar({
                icon: "iconInbox",
                title: (this.i18n.ammoTitle ?? "弹药库") + (kc ? " " + kc : ""),
                position: "left",
                callback: () => this.ammoFloat?.togglePanel(),
            });
        }

        this.setupRemind();
        this.setupTaskBadge(); // dataview □7：任务块池/日期徽标（点击弹快捷菜单=参数编辑就地）
        stayTracker.setup(this); // sloop □3：文档停留采集（switch-protyle/visibilitychange+localStorage 按天）
        this.schedNotifier.setup(this); // sloop □7：班表到点提醒（toast/弹窗通道，30s 轻拍）

        // dataview □6：全局速记命令（契约 §6 手动入口三件之一——弹小窗，回车=解析→落当前
        // 活跃项目「## 任务」章节）。默认键 ⌥⇧⌘N（N=Note/速记助记；规范序=⌃⌥⇧⌘ 官方口径，
        // ⌘ 开头含 ⌥ 的串是死键——openAmmo □3 同族）。定键查重（物理等价=修饰键集合比对，
        // matchAuxiliaryHotKey 的 else 分支要求集合精确相等）：
        // - 官方 constants.ts keymap 段 N 族仅 ⌘N(newFile)/⌥N(lockScreen)/⇧⌘N(jumpToParentNext)
        //   三条两修饰，与 ⌥⇧⌘N 集合不等价不撞；官方无三修饰条目。
        // - 四仓 winHotkey 三修饰族在用=⌘⌥⇧M/F/E/Q(tomato)+⌥⇧⌘A/T(本插件)；⇧⌥N(tomato
        //   FastNoteBox)是两修饰不等价；ctrl+alt+shift+N 全仓零命中。
        // - Chrome 浏览器版保留键族均为双修饰（graphfloat 定键备注同考），三修饰不在保留族。
        // languages 就绪守卫=openTimeline 同款（addCommand 全局副作用竞态，09-17 实锤）。
        {
            const registerQuickAddCmd = () => {
                try {
                    this.addCommand({
                        langKey: "quickAdd",
                        hotkey: "⌥⇧⌘N",
                        callback: () => {
                            this.openQuickEntry();
                        },
                    });
                } catch (e) {
                    debugLog("fe", `quickAdd 命令注册失败（languages 异常环境，重载可重试）：${String(e)}`);
                }
            };
            if ((window as any).siyuan?.languages) {
                registerQuickAddCmd();
            } else {
                let waited = 0;
                const watcher = setInterval(() => {
                    waited += 200;
                    if ((window as any).siyuan?.languages || waited >= 15_000) {
                        clearInterval(watcher);
                        registerQuickAddCmd();
                    }
                }, 200);
                this.unbindFns.push(() => clearInterval(watcher));
            }
        }

        // dataview □4：命令面板「打开看板」（无默认键=零定键查重面；languages 就绪守卫同款）。
        {
            const registerOpenBoardCmd = () => {
                try {
                    this.addCommand({
                        langKey: "openBoard",
                        hotkey: "",
                        callback: () => {
                            this.openBoard();
                        },
                    });
                } catch (e) {
                    debugLog("fe", `openBoard 命令注册失败（languages 异常环境，重载可重试）：${String(e)}`);
                }
            };
            if ((window as any).siyuan?.languages) {
                registerOpenBoardCmd();
            } else {
                let waited = 0;
                const watcher = setInterval(() => {
                    waited += 200;
                    if ((window as any).siyuan?.languages || waited >= 15_000) {
                        clearInterval(watcher);
                        registerOpenBoardCmd();
                    }
                }, 200);
                this.unbindFns.push(() => clearInterval(watcher));
            }
        }

        // dataview B2：命令面板「打开月度对账」（无默认键=零定键查重面；languages 就绪守卫同款）。
        {
            const registerOpenReconCmd = () => {
                try {
                    this.addCommand({
                        langKey: "openRecon",
                        hotkey: "",
                        callback: () => {
                            this.openRecon();
                        },
                    });
                } catch (e) {
                    debugLog("fe", `openRecon 命令注册失败（languages 异常环境，重载可重试）：${String(e)}`);
                }
            };
            if ((window as any).siyuan?.languages) {
                registerOpenReconCmd();
            } else {
                let waited = 0;
                const watcher = setInterval(() => {
                    waited += 200;
                    if ((window as any).siyuan?.languages || waited >= 15_000) {
                        clearInterval(watcher);
                        registerOpenReconCmd();
                    }
                }, 200);
                this.unbindFns.push(() => clearInterval(watcher));
            }
        }

        // □3 存量键位迁移单点串行（fire-and-forget；两命令均已注册完，条目齐）
        void this.migratePersistedHotkeys();

        // 按钮化 e：思源开着每小时自动同步一轮（与手动「立即同步」共用 kernel runRemindSyncGuarded 串行守卫）
        this.hourlyTimer = setInterval(() => {
            debugLog("cal", "hourly remind-sync tick");
            triggerRemindSync(this);
            // □17 回流镜像+□18 自动天气同刻搭车（kernel 侧各自串行守卫，互不阻塞）
            this.notifyMirrorPoll();
            this.notifyWeatherSync();
            // sloop □3 行为画像：停留快照保险推+触发一轮采集（kernel 串行守卫兜底）
            stayTracker.hourlyFlush();
            this.notifyBehaviorCollect();
            // sloop □4 晨间滚动检查（lastRollDay 守卫：每日至多一次真写盘）
            this.notifyScheduleSync();
            // sloop □6 照镜子周报检查（幂等守卫：已生成周零写；周日晚 20:00 后首跑生成）
            this.notifyWeeklyReportSync();

        }, 60 * 60_000);
    }

    /** remind □1：图标注入（文档生命周期事件）+三入口（右键/命令/slash） */
    private setupRemind(): void {
        // 图标注入器挂文档生命周期（switch 复访幂等=补位扫描；destroy 清观察器）
        this.eventBus.on("switch-protyle", ({ detail }) => {
            this.remindInjector.attach((detail as any).protyle);
        });
        this.eventBus.on("loaded-protyle-static", ({ detail }) => {
            this.remindInjector.attach((detail as any).protyle);
        });
        this.eventBus.on("loaded-protyle-dynamic", ({ detail }) => {
            this.remindInjector.attach((detail as any).protyle);
        });
        this.eventBus.on("destroy-protyle", ({ detail }) => {
            const rootId = (detail as any).protyle?.block?.rootID;
            if (rootId) this.remindInjector.detach(rootId);
        });

        // 入口①：右键块菜单（open-menu-content 的 element=块本体；gutter 菜单不 emit 此事件）
        this.eventBus.on("open-menu-content", ({ detail }) => {
            if (!this.entryToggles.contextMenu) return; // pjux □2：开关活读即时生效
            const d = detail as any;
            const blockId: string | null = d.element?.getAttribute?.("data-node-id") ?? null;
            if (!blockId || !d.menu) return;
            d.menu.addItem({
                label: this.i18n.setRemind,
                icon: "iconClock",
                accelerator: setRemindHotkeyLabel(),
                click: () => this.remindInjector.openPanelForBlock(blockId),
            });
        });

        // 入口①b（⑥）：块柄菜单——gutter 单击/右键同走 renderMenu，插件挂点=click-blockicon
        // （emitOpenMenu 收项进「插件」子菜单，官方同构形态）。⚠bear 拍板原文写的是
        // open-menu-blockbtn——该事件 3.8.4 运行时与 master 均不存在（bundle grep=0+GitHub
        // 代码搜索 0 命中），click-blockicon 是块柄菜单唯一官方通道，等价达成「块柄右键加时间」
        this.eventBus.on("click-blockicon", ({ detail }) => {
            if (!this.entryToggles.contextMenu) return;
            const hit = pickBlockIconEntry(detail); // 恰一块才加项（多选块面板无从落锚）
            if (!hit) return;
            (detail as any).menu?.addItem?.({
                label: this.i18n.setRemind,
                icon: "iconClock",
                accelerator: setRemindHotkeyLabel(),
                click: () => this.remindInjector.openPanelForBlock(hit.blockId),
            });
        });

        // 入口②：命令面板+快捷键（⑥ 定键 ⌥⇧⌘T：09-18 现扫全仓 winHotkey+官方 keymap+实例
        // plugin 命名空间三面查重——两修饰字母空间全满〔⌥⌘/⌘⇧ 26 字母并集全占〕，三修饰族
        // 仅 8 键在用，T=Time 语义；macOS/Windows/Chrome 浏览器版均无保留冲突）
        if (this.entryToggles.setRemind) {
            // ⑥ 存量空条目迁移：keydown 只匹配 command.customHotkey（matchHotKey 空串恒
            // false，插件命令无 default 回退）——旧版本写下的 setRemind keymap 条目
            // {default:"",custom:""} 会吃掉新默认键。addCommand 前读原值判形（其后
            // updatePluginKeymap 就地把 default 覆写为 ⌥⇧⌘T，原值不可再得）
            const persisted = (window as any).siyuan?.config?.keymap?.plugin?.["sy-workbench-plugin"]?.["setRemind"] as { default?: string; custom?: string } | undefined;
            const migrateHotkey = Boolean(persisted) && persisted!.default === "" && persisted!.custom === "";
            this.addCommand({
                langKey: "setRemind",
                hotkey: "⌥⇧⌘T",
                editorCallback: (protyle) => {
                    const focus = protyle.wysiwyg.element.querySelector(".focus");
                    const blockId = focus?.getAttribute("data-node-id") ?? protyle.block.rootID;
                    this.remindInjector.openPanelForBlock(blockId);
                },
            });
            if (migrateHotkey) this.needSetRemindMigrate = true; // 迁移统一由 onload 末尾 migratePersistedHotkeys 串行跑
        }

        // 入口③：slash（html 照官方 b3-list-item__first 形态；callback 直拿当前块）
        if (this.entryToggles.slash) this.pushRemindSlash();

        // 插件加载晚于文档打开时 loaded-protyle-* 已发过收不到——主动补挂已开编辑器
        // （e2e 实锤：attach 晚于面板保存=图标闪回 SQL 旧值）
        try {
            for (const editor of getAllEditor() as any[]) {
                this.remindInjector.attach(editor?.protyle);
            }
        } catch { /* getAllEditor 在 onload 早期可空——事件路径兜底 */ }
    }

    /** dataview □7：任务块池/日期徽标注入（文档生命周期事件——setupRemind 同款四挂点；
     *  徽标=只读属性的可视化，点击弹快捷菜单（换池四选一/配额步进/日期快捷），写链走
     *  kernel □5 moveTaskPool/新 setTaskQuota rpc+日期直写属性，参数编辑就地不跳文档） */
    private setupTaskBadge(): void {
        this.eventBus.on("switch-protyle", ({ detail }) => {
            this.taskBadgeInjector.attach((detail as any).protyle);
        });
        this.eventBus.on("loaded-protyle-static", ({ detail }) => {
            this.taskBadgeInjector.attach((detail as any).protyle);
        });
        this.eventBus.on("loaded-protyle-dynamic", ({ detail }) => {
            this.taskBadgeInjector.attach((detail as any).protyle);
        });
        this.eventBus.on("destroy-protyle", ({ detail }) => {
            const rootId = (detail as any).protyle?.block?.rootID;
            if (rootId) this.taskBadgeInjector.detach(rootId);
        });
        try {
            for (const editor of getAllEditor() as any[]) {
                this.taskBadgeInjector.attach(editor?.protyle);
            }
        } catch { /* getAllEditor 在 onload 早期可空——事件路径兜底 */ }
    }

    /** pjux □2：slash 入口条目（构建抽出供开关活插拔——slash 菜单构建时活读 protyleSlash 数组） */
    private pushRemindSlash(): void {
        this.protyleSlash.push({
            filter: ["remind", "tixing", "tx", "提醒"],
            html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#iconClock"></use></svg><span class="b3-list-item__text">${escapeHtml(this.i18n.setRemind)}</span></div>`,
            id: "pj-set-remind 2026-09-13",
            callback: (_protyle, nodeElement) => {
                const blockId = nodeElement?.getAttribute?.("data-node-id");
                if (blockId) this.remindInjector.openPanelForBlock(blockId);
            },
        });
    }

    getEntryToggles(): EntryToggles {
        return { ...this.entryToggles };
    }

    /** □3 存量键位迁移单点串行入口：setPluginHotkey 是「深拷贝 keymap→整体 POST→整体替换
     *  内存」协议，并发多调时后完成者用旧快照覆盖先完成者的写入（hotkeyCap.ts 头注释，
     *  09-06 dev 实锤三条并发只活最后一条）——故全部迁移收敛到本方法 await 串行，onload 一处
     *  fire-and-forget。单条失败（无条目/网络错）setPluginHotkey 返回 false，下轮重载重判重试，
     *  幂等 */
    private async migratePersistedHotkeys(): Promise<void> {
        // □3 openAmmo 默认键翻案：①"⌘⌥⇧A" 非规范序死键（内核 matchHotKey 分支写死符号序）
        // →"⌥⇧⌘A"，物理组合不变；②bindings 多键通道残留清账——□6 Dialog 时代定过 ⌥5 写进了
        // bindings.keys，3.8.4 build 的 updatePluginKeymap 对 version===1 条目会把 bindings.keys
        // 灌回 custom 顶掉默认键（main 分支源码已删此逻辑=「bindings 零消费」考古版本错位，
        // 6808 实测 addCommand 后 custom="⌥5"）。本插件未发版，⌥5/⌘⌥⇧A 均战役残留非用户主观
        // 键位，无条件清到新默认；迁后 bindings 已删+custom=⌥⇧⌘A → 条件不再命中，幂等。
        // 删 bindings=回归单键通道（t/p/r 各家条目同形态；官方 keymapUi 改键通道照常）
        try {
            const entry = (window as any).siyuan?.config?.keymap?.plugin?.["sy-workbench-plugin"]?.openAmmo;
            if (entry && (entry.bindings?.version === 1 || entry.custom === "⌘⌥⇧A" || entry.custom === "⌥5")) {
                delete entry.bindings;
                entry.custom = "⌥⇧⌘A";
                await setPluginHotkey("sy-workbench-plugin", "openAmmo", "⌥⇧⌘A"); // 深拷贝→POST→内存替换→command 同步
                debugLog("fe", "openAmmo hotkey migrated → ⌥⇧⌘A (bindings legacy cleared)");
            }
        } catch (e) {
            debugLog("fe", `!! openAmmo hotkey migrate failed: ${String(e)}`);
        }
        // ⑥ setRemind 旧版空条目迁移（判形=default===""&&custom===""，在 setupRemind——
        // 刻意不用 migrateLegacyHotkeys：其条件只看 custom，会把「用户主动清键=禁用」
        // 误迁回默认。openAmmo 清账无此顾虑=两个旧值都是战役残留）
        if (this.needSetRemindMigrate) {
            this.needSetRemindMigrate = false;
            await this.migrateSetRemindHotkey();
        }
    }

    /** ⑥ setRemind 键迁移收尾：custom 回填 ⌥⇧⌘T+落盘（kernel setKeymap 全量替换=keymap UI
     *  同通道；plugin 命名空间条目各插件 addCommand 自愈重建、他键用户 custom 已含在本活快
     *  照内；并发覆盖风险由 migratePersistedHotkeys 单点串行收敛）。
     *  内存侧改 command.customHotkey=本会话即生效；落盘失败只留内存态（下次重载重判
     *  重试，幂等）。用户事后在 keymap UI 清键=custom 空而 default=⌥⇧⌘T，不再匹配迁移条件 */
    private async migrateSetRemindHotkey(): Promise<void> {
        const HK = "⌥⇧⌘T";
        const cmd = this.commands.find((c) => c.langKey === "setRemind");
        if (cmd) (cmd as any).customHotkey = HK;
        const entry = (window as any).siyuan?.config?.keymap?.plugin?.["sy-workbench-plugin"]?.["setRemind"];
        if (entry) entry.custom = HK;
        try {
            const token = (window as any).siyuan?.config?.api?.token ?? "";
            const r = await fetch("/api/setting/setKeymap", {
                method: "POST",
                headers: { Authorization: `Token ${token}` },
                body: JSON.stringify({ data: (window as any).siyuan?.config?.keymap }),
            });
            const d = await r.json();
            if (d.code !== 0) debugLog("fe", `!! setRemind hotkey migrate persist failed: ${d.msg ?? r.status}`);
            else debugLog("fe", "setRemind hotkey migrated → ⌥⇧⌘T");
        } catch (e) {
            debugLog("fe", `!! setRemind hotkey migrate fetch failed: ${String(e)}`);
        }
    }

    /** pjux □2：入口开关落盘+生效分发。contextMenu=handler 活读即时；slash=protyleSlash
     *  活插拔即时；命令/顶栏族（saveScene/setRemind/openTimeline/openAmmoTopbar）=存盘+收面板+reloadSelfPlugin（注册在
     *  onload；收面板防 setPetalEnabled 把挂着的 Conf 打成僵尸——tomato footer 保存流同形）。
     *  落盘失败（readonly 恒 403/dispose 窗/磁盘错）=回滚内存+toast+镜像回弹（review P1：
     *  静默分叉+白重载是最差失败形态——内存/盘不一致会在下次重载时无声回滚，用户无法归因） */
    async setEntryToggle(key: keyof EntryToggles, on: boolean): Promise<boolean> {
        this.entryToggles[key] = on;
        let saved = true;
        try {
            await this.saveData(ENTRY_TOGGLES_FILE, this.entryToggles);
        } catch (e: any) {
            saved = false;
            this.entryToggles[key] = !on; // 回滚内存，活态与盘对齐
            showMessage(this.i18n.confEntrySaveFail, 3000, "error");
            debugLog("fe", `!! entry toggle save failed key=${key}: ${String(e?.msg ?? e)}`);
        }
        if (saved) debugLog("fe", `entry toggle ${key}=${on}`);
        if (key === "slash" && saved) {
            // saved 门控：落盘失败已回滚内存态，活插拔须与回滚后的活态一致（不动）
            const idx = this.protyleSlash.findIndex((s) => s.id === "pj-set-remind 2026-09-13");
            if (on && idx < 0) this.pushRemindSlash();
            if (!on && idx >= 0) this.protyleSlash.splice(idx, 1);
            return saved;
        }
        if (key === "slash") return saved;
        if (saved && (key === "saveScene" || key === "setRemind" || key === "openTimeline" || key === "openAmmoTopbar")) {
            this.confDialog?.destroy(); // 收面板（同代守卫内 unmount，重载前的干净退场）
            await reloadSelfPlugin("sy-workbench-plugin");
        }
        return saved;
    }

    /** P3 □4：顶栏切换器+驾驶舱页签注册（onload 尾部调用，需 switcherButton 先建好） */
    private setupGui(): void {
        this.switcherButton = this.addTopBar({
            icon: "iconWorkspace",
            title: "工作台",
            position: "left",
            callback: (e) => void this.onSwitcherClick(e),
        });
        renderSwitcherLabel(this.switcherButton, null);

        const plugin = this;
        this.addTab({
            type: CALENDAR_TAB,
            init() {
                const host = document.createElement("div");
                host.className = "fn__flex-1";
                host.style.height = "100%";
                this.element.appendChild(host);
                const inst = mount(Calendar, {
                    target: host,
                    props: {
                        t: plugin.i18n as unknown as Record<string, string>,
                        // 三源数据通道（calnav □2 产出）：进页签拉一次，翻月纯函数重算；
                        // SQL 通道错误透传（Calendar 侧 loadError=空态+重试），账本缺文件=内部 null 空态
                        openBlock: (blockId: string) => plugin.openDocNoFocus(blockId),
                        loadRemindRows: () => feQuery(listRemindBlocksSql()),
                        loadTaskRows: () => feQuery(allDueTasksSql()),
                        loadLedger: () => plugin.readPetalJsonViaHttp(LEDGER_FILE),
                        // □17 回流：镜像只读（readPetalJsonViaHttp 绕缓存恒新鲜）+循环实例 kernel rpc
                        loadMirror: () => plugin.readPetalJsonViaHttp(CALENDAR_MIRROR_FILE),
                        fetchInstances: (s: number, e: number) => plugin.fetchCalendarInstances(s, e),
                        // sloop □4 班表：sched 档读（交接会角标源）
                        loadSchedule: () => plugin.loadScheduleStore(),
                        // timeblock 期 2 ② 读面切块：月历 sched 源=班表块扫描
                        loadBoardItems: () => plugin.loadBoardItems(),
                        // caltab：月历交互动作通道（双击/右键日期格+事件条三动作）
                        openTimeline: (day?: string, focusKey?: string) => plugin.openTimeline(day, focusKey),
                        // 期 2 ⑤+月历右键「跳到源块」（聚焦落块）
                        openBlockFocused: (blockId: string) => plugin.openDocFocused(blockId),
                        // 月历右键删除三源通道
                        deleteForeignEvent: (eventId: string) => plugin.deleteForeignEvent(eventId),
                        deleteBlockEntry: (blockId: string) => plugin.deleteBlockEntry(blockId),
                        schedEdit: (op: SchedEditOp) => plugin.schedEdit(op),
                        // 期 2 ④ 手动刷新：组件先拉本地全量，这里踢 kernel 真同步一轮（广播回来防抖自刷）
                        onManualSync: () => plugin.manualCalendarSync(),
                        onOpenHandoff: () => plugin.openHandoffDialog(),
                        // sloop □5 onboarding：档只读（唯一写者=OnboardDialog 用户动作）+入口
                        loadOnboard: () => plugin.loadOnboardStore(),
                        onOpenOnboard: () => plugin.openOnboardDialog(),
                        // ammo □7：月历实况回填（日账日窗读——日历双类第二类）
                        loadLedgerEntries: (days: string[]) => plugin.ammoLedgerReadDays(days),
                    },
                }) as any;
                this.data.unmountCalendar = () => unmount(inst);
            },
            destroy() {
                this.data.unmountCalendar?.();
            },
        });
        // caltab 期：独立「时间线」页签（Calendar 日面板能力平移+翻日顶栏+轴恒展开）。
        // props 桥=Calendar 挂载参数子集（月历专属源 loadBoardItems/onboard/handoff/手动同步
        // 钮不随迁）；day/focusKey=openTimeline 落参（timelinePending 中转，本阶段挂载后即清）。
        this.addTab({
            type: TIMELINE_TAB,
            init() {
                const host = document.createElement("div");
                host.className = "fn__flex-1";
                host.style.height = "100%";
                this.element.appendChild(host);
                const pending = plugin.timelinePending;
                plugin.timelinePending = null; // 消费即清（关重开=今天，不携上次落参）
                const inst = mount(TimelineTab, {
                    target: host,
                    props: {
                        t: plugin.i18n as unknown as Record<string, string>,
                        day: pending?.day,
                        focusKey: pending?.focusKey,
                        // 数据/动作通道（Calendar 页签同款——日面板消费的那一子集）
                        openBlock: (blockId: string) => plugin.openDocNoFocus(blockId),
                        loadRemindRows: () => feQuery(listRemindBlocksSql()),
                        loadTaskRows: () => feQuery(allDueTasksSql()),
                        loadLedger: () => plugin.readPetalJsonViaHttp(LEDGER_FILE),
                        loadMirror: () => plugin.readPetalJsonViaHttp(CALENDAR_MIRROR_FILE),
                        fetchInstances: (s: number, e: number) => plugin.fetchCalendarInstances(s, e),
                        schedEdit: (op: SchedEditOp) => plugin.schedEdit(op),
                        // adoptForeign 不接=与 Calendar 页签现状一致（该链 期2③ 全映射后退役，
                        // 组件侧 {#if false} 钮+菜单 rebuild 项靠 !adoptForeign 守卫静默 no-op）
                        loadWeekly: () => plugin.loadWeeklyStore(),
                        readDayBoard: (day: string) => plugin.readDayBoard(day),
                        createRemindEntry: (day: string, start: string) => plugin.createRemindEntry(day, start),
                        moveRemindBlock: (id: string, day: string, start: string, end: string | null) => plugin.moveRemindBlock(id, day, start, end),
                        moveTaskDueTime: (id: string, time: string) => plugin.moveTaskDueTime(id, time),
                        openBlockFocused: (blockId: string) => plugin.openDocFocused(blockId),
                        deleteForeignEvent: (eventId: string) => plugin.deleteForeignEvent(eventId),
                        deleteBlockEntry: (blockId: string) => plugin.deleteBlockEntry(blockId),
                        untimeRemindBlock: (blockId: string) => plugin.untimeRemindBlock(blockId),
                        untimeTaskDueTime: (blockId: string) => plugin.untimeTaskDueTime(blockId),
                        // ammo □7：时间线页签实况段+同步钮（同一引擎同一状态源）
                        loadLedgerEntries: (day: string) => plugin.ammoLedgerReadDay(day),
                        ammoRpc: (plugin as any).kernel?.rpc ?? null,
                    },
                }) as any;
                this.data.unmountTimelineTab = () => unmount(inst);
            },
            destroy() {
                this.data.unmountTimelineTab?.();
            },
        });
        this.addTab({
            type: DASHBOARD_TAB,
            init() {
                const host = document.createElement("div");
                host.className = "fn__flex-1";
                host.style.height = "100%"; // 面板容器高度传导（footer 贴底依赖，vision P2-3）
                this.element.appendChild(host);
                const inst = mount(Dashboard, {
                    target: host,
                    props: {
                        projectId: plugin.activeProjectId ?? "",
                        t: plugin.i18n as unknown as Record<string, string>,
                        app: plugin.app,
                        loadScene: (id: string) => plugin.loadSceneSnapshot(id),
                        saveScene: () => plugin.captureAndSave(),
                        // 增补批二任务四：驾驶舱 openDoc 升级——打开文档同时定位左栏文件树（openDocAndReveal）
                        openDoc: (docId: string) => plugin.openDocAndReveal(docId),
                        // □4 改名成功→顶栏标签刷新（文件树/页签标题原生广播自动跟）
                        onProjectRenamed: (name: string) => void plugin.updateSwitcherLabel(name),
                        // 按钮化 a：恢复现场（读快照复用 onOpenScene 链+关域内页签）
                        restoreScene: () => plugin.restoreCurrentScene(),
                        // 按钮化 b：日历区数据与动作
                        loadCalendarStatus: () => plugin.loadCalendarStatusData(),
                        loadFeishuStatus: () => plugin.loadFeishuStatus(),
                        loadLedger: () => plugin.loadLedgerData(),
                        syncNow: () => triggerRemindSync(plugin),
                        // 按钮化 c/d：一键重授权（驾驶舱红态入口与设置面板共用同一流程）
                        startReauth: () => plugin.startReauth(),
                        // 驾驶舱开设置（齿轮入口；用法提示词/飞书日历配置都在设置页）
                        onOpenSettings: () => plugin.openSetting(),
                        // calnav □3：驾驶舱日历区「打开日历」
                        onOpenCalendar: () => plugin.openCalendar(),
                        // caltab：驾驶舱「打开时间线」（独立时间线页签——「打开日历」旁第二入口）
                        onOpenTimeline: () => plugin.openTimeline(),
                        // gantt-lanes：驾驶舱「甘特图」开独立整页页签（原森林图入口换代）
                        onOpenGantt: () => plugin.openGantt(),
                        // folder-model：骨架卡全局日志入口（打开当月日志文档）
                        onOpenDiary: () => void plugin.openDiaryMonth(),
                        // tb2 ⑧：「今天」卡班表数据（当日班表块只读 rpc；与日历日面板同源）
                        readDayBoard: (day: string) => plugin.readDayBoard(day),
                        // tb2 H4：飞书推送链路直测（消息+加急 / 马上到期事件）
                        feishuTestSend: (urgent: string, text?: string) => plugin.feishuTestSend(urgent, text),
                        feishuTestEvent: (seconds: number) => plugin.feishuTestEvent(seconds),
                        // tb6 □6d：机器人身份自检（H4 测试行旁身份卡数据源）
                        feishuBotInfo: () => plugin.feishuBotInfo(),
                        // 删除项目（危险态钮；壳层清活跃指针+顶栏标签，驾驶舱管空态与确认弹窗）
                        deleteProject: (projectId: string) => plugin.deleteProjectViaKernel(projectId),
                        // 03 收拢件：done 任务收进归档区（非破坏；kernel line-sweep rpc——MCP line sweep_done 同编排）
                        sweepDone: (projectId: string) => plugin.sweepDoneViaKernel(projectId),
                    },
                }) as any;
                this.data.unmountDashboard = () => unmount(inst);
            },
            destroy() {
                this.data.unmountDashboard?.();
                plugin.dashboardDismissed = true;
            },
        });
        // gantt-lanes：甘特图页签（森林图整包换代）。projectId=打开时活跃项目快照；
        // 后续切项目由组件内 pj-project-switched 监听跟手刷新。host 须 flex 列容器：
        // GanttView 根是 flex:1（旧森林图同款，普通 block div 下塌成条带）。
        this.addTab({
            type: GANTT_TAB,
            init() {
                const host = document.createElement("div");
                host.className = "fn__flex-1";
                host.style.height = "100%";
                host.style.display = "flex";
                host.style.flexDirection = "column";
                this.element.appendChild(host);
                const inst = mount(GanttView, {
                    target: host,
                    props: {
                        projectId: plugin.activeProjectId ?? "",
                        t: plugin.i18n as unknown as Record<string, string>,
                        openBlock: (blockId: string) => plugin.openDocNoFocus(blockId),
                        onOpenBoard: () => plugin.openBoard(),
                        // 01 跳转件：时间线互切+日账月文档（驾驶舱同款现成通道——甘特纯计划，实况靠跳转）
                        onOpenTimeline: () => plugin.openTimeline(),
                        onOpenDiary: () => void plugin.openDiaryMonth(),
                        loadGanttPrefs: async () => (await plugin.readPetalJsonViaHttp(GANTT_PREFS_FILE)).data,
                        saveGanttPrefs: (compress: boolean) => plugin.saveGanttPrefs(compress),
                    },
                } as any);
                this.data.unmountGantt = () => unmount(inst);
            },
            destroy() {
                this.data.unmountGantt?.();
            },
        });
        // dataview □4：看板页签（零存储纯投影——分组/过滤在 boardModel 纯层，组件内 feQuery
        // 拉任务块/项目树+rpc 拉今日配置行；卡点击=openDocNoFocus 禁聚焦政策；列尾「+」=
        // QuickInlineInput 速记（quickAddTask 落块+按池列 attachTaskToDayConfig 挂池））
        this.addTab({
            type: BOARD_TAB,
            init() {
                const host = document.createElement("div");
                host.className = "fn__flex-1";
                host.style.height = "100%";
                host.style.display = "flex";
                host.style.flexDirection = "column";
                this.element.appendChild(host);
                const inst = mount(BoardView, {
                    target: host,
                    props: {
                        t: plugin.i18n as unknown as Record<string, string>,
                        openBlock: (blockId: string) => plugin.openDocNoFocus(blockId),
                        rpc: (plugin as any).kernel?.rpc ?? null,
                        getActiveProjectId: () => plugin.activeProjectId ?? "",
                    },
                } as any);
                this.data.unmountBoard = () => unmount(inst);
            },
            destroy() {
                this.data.unmountBoard?.();
            },
        });
        // dataview B2：月度对账页签（零存储纯投影——聚合在 gui/reconModel 纯层；配置行组件内
        // feQuery 直连〔Calendar B1 同款〕、日账=ammo-ledger-read days 窗 rpc、班表=loadBoardItems；
        // 条目点击=openDocNoFocus 禁聚焦政策）
        this.addTab({
            type: RECON_TAB,
            init() {
                const host = document.createElement("div");
                host.className = "fn__flex-1";
                host.style.height = "100%";
                this.element.appendChild(host);
                const inst = mount(ReconView, {
                    target: host,
                    props: {
                        t: plugin.i18n as unknown as Record<string, string>,
                        openBlock: (blockId: string) => plugin.openDocNoFocus(blockId),
                        loadLedgerEntries: (days: string[]) => plugin.ammoLedgerReadDays(days),
                        loadBoardItems: () => plugin.loadBoardItems(),
                    },
                } as any);
                this.data.unmountRecon = () => unmount(inst);
            },
            destroy() {
                this.data.unmountRecon?.();
            },
        });

        // sloop □21：当天时间线 dock（右下常驻，点 dock 图标开合）：五源压平一条线+分钟级
        // 走动指针（组件内自带 30s 走针/5min 数据轮询/班表写广播刷新）；懒挂载=init 首开才调
        this.addDock({
            type: TIMELINE_DOCK,
            config: {
                position: "RightBottom",
                size: { width: 360, height: 0 },
                icon: "iconClock",
                title: this.i18n.tlDockTitle,
            },
            data: {},
            // fn__flex 中间层=高度链（dock.element 是 block，fleet □7 同款；min-height:0 传导滚动区）
            init: (dock: any) => {
                if (plugin.data.unmountTimeline) plugin.data.unmountTimeline(); // 二次 init 防御：旧树先净卸防孤儿 effect/interval（reasoning P2）
                plugin.data.unmountTimeline = undefined;
                dock.element.innerHTML = `<div class="fn__flex fn__flex-column fn__flex-1" style="min-height:0"><div id="pj-timeline-host" class="fn__flex-1" style="min-height:0"></div></div>`;
                const inst = mount(Timeline, {
                    target: dock.element.querySelector("#pj-timeline-host"),
                    props: {
                        t: plugin.i18n as unknown as Record<string, string>,
                        // 三源+镜像/班表通道与 Calendar 页签同一套（时间线=跨项目全局压平=同款全库 SQL）
                        openBlock: (blockId: string) => plugin.openDocNoFocus(blockId),
                        onOpenCalendar: () => plugin.openCalendar(),
                        // caltab：dock 头/空态「打开时间线」（独立时间线页签——「打开日历」旁第二入口）
                        onOpenTimeline: () => plugin.openTimeline(),
                        loadRemindRows: () => feQuery(listRemindBlocksSql()),
                        loadTaskRows: () => feQuery(allDueTasksSql()),
                        loadLedger: () => plugin.readPetalJsonViaHttp(LEDGER_FILE),
                        loadMirror: () => plugin.readPetalJsonViaHttp(CALENDAR_MIRROR_FILE),
                        fetchInstances: (s: number, e: number) => plugin.fetchCalendarInstances(s, e),
                        loadBoardItems: () => plugin.loadBoardItems(),
                        // □23 随手反馈档：读=Ex 版（读失败≠缺档，写路径守卫防旧档覆盖丢历史）；写=saveData 恒带 app（零自重载）
                        loadFeedback: () => plugin.readPetalJsonViaHttpEx(FEEDBACK_FILE),
                        saveFeedback: (store: FeedbackStore) => plugin.saveFeedbackStore(store),
                        // 番茄桥（bear 09-20「去自建钟用番茄工具箱」）：账本续写+tomato petal
                        // 只读+桥状态档（当前任务+回流锚）——引擎退役，插件只供通道
                        loadPomoLog: () => plugin.loadPomoLog(),
                        savePomoLog: (store: import("./gui/pomoBridge").PomoLogStore) => plugin.savePomoLog(store),
                        fetchTomatoText: (file: string) => plugin.fetchTomatoText(file),
                        loadPomoBridgeState: () => plugin.loadPomoBridgeState(),
                        savePomoBridgeState: (st) => plugin.savePomoBridgeState(st),
                        // ammo □7：dock 时间线实况段+头部同步钮（与页签/□9 悬浮窗同一引擎同一状态源）
                        loadLedgerEntries: () => plugin.ammoLedgerReadDay(),
                        ammoRpc: (plugin as any).kernel?.rpc ?? null,
                        // mainfix0923 □5：头栏「当日日记」跳转钮（定位不到=toast 不懒建）
                        onOpenDiary: () => void plugin.openTodayDiary(),
                    },
                }) as any;
                plugin.data.unmountTimeline = () => unmount(inst);
            },
            destroy() {
                plugin.data.unmountTimeline?.();
                plugin.data.unmountTimeline = undefined; // 清引用：重开=init 干净重挂
            },
        } as any);
    }

    /** calnav □3：打开独立日历页签（openTab custom 不按 id 去重——先查已开聚焦复用，与 openDashboard 同款） */
    openCalendar(): void {
        const opened = (this.getOpenedTab?.() ?? {})[CALENDAR_TAB] ?? [];
        const liveTab = (opened.find((c) => (c as any).parent?.headElement?.isConnected) as any)?.parent;
        if (liveTab) {
            try {
                liveTab.parent?.switchTab?.(liveTab.headElement);
            } catch {
                // 聚焦失败=保持现状
            }
            return;
        }
        void openTab({
            app: this.app,
            custom: {
                icon: "iconClock",
                title: this.i18n.calendarTabTitle,
                data: {},
                id: `${this.name}${CALENDAR_TAB}`,
            },
        });
    }

    /** caltab 期：打开独立时间线页签（去重聚焦复用与 openCalendar 同款——openTab custom
     *  不按 id 去重，getOpenedTab 陈额须验活）。day/focusKey 落参两路：已开页签走
     *  pj-tl-goto-day 事件切日；新建页签经 timelinePending 中转（init 挂载时消费——
     *  openTab 异步建页签，直接派事件会早于组件监听挂上而丢）。 */
    private timelinePending: { day?: string; focusKey?: string } | null = null;

    openTimeline(day?: string, focusKey?: string): void {
        const opened = (this.getOpenedTab?.() ?? {})[TIMELINE_TAB] ?? [];
        const liveTab = (opened.find((c) => (c as any).parent?.headElement?.isConnected) as any)?.parent;
        if (liveTab) {
            try {
                liveTab.parent?.switchTab?.(liveTab.headElement);
            } catch {
                // 聚焦失败=保持现状（内容已由 goto 事件切换）
            }
            // date 缺省/非法=组件侧守卫忽略（仅聚焦不切日——「打开默认今天」只管首开）
            window.dispatchEvent(new CustomEvent("pj-tl-goto-day", { detail: { date: day, focusKey } }));
            return;
        }
        this.timelinePending = { day, focusKey };
        void openTab({
            app: this.app,
            custom: {
                icon: "iconClock",
                title: this.i18n.tlTabTitle ?? "时间线",
                data: {},
                id: `${this.name}${TIMELINE_TAB}`,
            },
        });
    }

    /** gantt-lanes：打开甘特图独立页签（去重聚焦与 openCalendar/openDashboard 同款——
     *  openTab custom 不按 id 去重，getOpenedTab 陈额须验活） */
    openGantt(): void {
        const opened = (this.getOpenedTab?.() ?? {})[GANTT_TAB] ?? [];
        const liveTab = (opened.find((c) => (c as any).parent?.headElement?.isConnected) as any)?.parent;
        if (liveTab) {
            try {
                liveTab.parent?.switchTab?.(liveTab.headElement);
            } catch {
                // 聚焦失败=保持现状
            }
            return;
        }
        void openTab({
            app: this.app,
            custom: {
                icon: "iconListTree",
                title: this.i18n.forestTabTitle,
                data: {},
                id: `${this.name}${GANTT_TAB}`,
            },
        });
    }

    /** dataview □4：打开看板独立页签（去重聚焦复用与 openGantt 同款——openTab custom
     *  不按 id 去重，getOpenedTab 陈额须验活）。图标 iconBoard（官方图标清单核实=litheness
     *  icon.js 在册、四仓未用——思源自用于多维表格看板视图，语义同源）。 */
    openBoard(): void {
        const opened = (this.getOpenedTab?.() ?? {})[BOARD_TAB] ?? [];
        const liveTab = (opened.find((c) => (c as any).parent?.headElement?.isConnected) as any)?.parent;
        if (liveTab) {
            try {
                liveTab.parent?.switchTab?.(liveTab.headElement);
            } catch {
                // 聚焦失败=保持现状
            }
            return;
        }
        void openTab({
            app: this.app,
            custom: {
                icon: "iconBoard",
                title: this.i18n.boardTabTitle,
                data: {},
                id: `${this.name}${BOARD_TAB}`,
            },
        });
    }

    /** dataview B2：打开月度对账独立页签（去重聚焦复用与 openBoard 同款——openTab custom
     *  不按 id 去重，getOpenedTab 陈额须验活）。图标 iconHistory（官方图标清单核实=litheness
     *  icon.js 在册——对账=回望账本语义；四仓未用）。 */
    openRecon(): void {
        const opened = (this.getOpenedTab?.() ?? {})[RECON_TAB] ?? [];
        const liveTab = (opened.find((c) => (c as any).parent?.headElement?.isConnected) as any)?.parent;
        if (liveTab) {
            try {
                liveTab.parent?.switchTab?.(liveTab.headElement);
            } catch {
                // 聚焦失败=保持现状
            }
            return;
        }
        void openTab({
            app: this.app,
            custom: {
                icon: "iconHistory",
                title: this.i18n.reconTabTitle,
                data: {},
                id: `${this.name}${RECON_TAB}`,
            },
        });
    }

    /** 🔴临时诊断埋点（09-13 主文档转圈事故）：全局未捕获异常/Promise 拒绝 → Loki。
     *  桥走专用直推（绕过 debugLog 的 dev 端口门——主实例 attach 端口不在 6807~6999，旧门会把桥静音）；
     *  首 20 条全量、其后 1/50 采样（防 null 风暴刷爆）；globalThis 防重注册（window.eval 无模块缓存）。
     *  定位后整节连同两个监听一起移除。 */
    private errorBridgeCount = 0;
    private installErrorBridge(): void {
        if ((globalThis as any).__pjErrBridge) return;
        (globalThis as any).__pjErrBridge = true;
        const pushErr = (msg: string) => {
            const ts = `${Date.now()}000000`;
            const body = JSON.stringify({
                streams: [{
                    stream: { job: "project-plugin", app: "errbridge", port: (globalThis.location as Location | undefined)?.port || "na" },
                    values: [[ts, msg]],
                }],
            });
            try {
                fetch("http://localhost:3100/loki/api/v1/push", {
                    method: "POST", headers: { "Content-Type": "application/json" }, body,
                }).catch(() => { });
            } catch { /* 静默 */ }
        };
        const report = (kind: string, msg: string, stack: string) => {
            this.errorBridgeCount++;
            if (this.errorBridgeCount <= 20 || this.errorBridgeCount % 50 === 0) {
                pushErr(`${kind}#${this.errorBridgeCount} ${msg} :: ${stack}`);
            }
        };
        window.addEventListener("error", (e: ErrorEvent) => {
            const file = (e.filename || "").split("/").pop() || "?";
            report("window.error", `${e.message} @${file}:${e.lineno}:${e.colno}`,
                (e.error?.stack || "").split("\n").slice(0, 3).join(" | ").slice(0, 240));
        });
        window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
            const r: any = e.reason;
            report("unhandledrejection", String(r?.message ?? r).slice(0, 160),
                String(r?.stack || "").split("\n").slice(0, 3).join(" | ").slice(0, 240));
        });
    }

    private async onSwitcherClick(e: MouseEvent): Promise<void> {
        let projects: ProjectRow[] = [];
        try {
            projects = (await fetchProjectSnapshot()).projects;
        } catch (err) {
            debugLog("fe", `!! switcher snapshot failed: ${String(err)}`);
        }
        showSwitcherMenu(e, {
            projects,
            activeId: this.activeProjectId,
            texts: { searchPh: this.i18n.switcherSearchPh, emptyNote: this.i18n.switcherEmpty },
            handlers: {
                // 显式点击压过「关过本 session 不再自动弹」旗（forceDashboard 只走菜单点击路径）
                onPick: (id) => void this.switchToProject(id, { forceDashboard: true }),
                onCreateProject: () => this.openCreateProjectDialog(),
            },
        });
    }

    /** GUI 切项目：读快照→复用 onOpenScene 恢复链（与 MCP project.open 同一条路）。
     *  opts.forceDashboard（任务一）：显式菜单点击路径——切换完成后总弹/聚焦驾驶舱，
     *  压过 dashboardDismissed 旗（MCP open 等既有调用不带 opts=旗照拦不变） */
    private async switchToProject(projectId: string, opts?: { forceDashboard?: boolean }): Promise<void> {
        if (projectId === this.activeProjectId) {
            this.openDashboard(); // 当前活跃项目=仅聚焦驾驶舱，零切换动静
            return;
        }
        const scene = await this.loadSceneSnapshot(projectId);
        await this.onOpenScene({ projectId, scene: scene ?? undefined, fallbackDocId: projectId }, opts);
    }

    private async loadSceneSnapshot(id: string): Promise<SceneSnapshot | null> {
        try {
            const raw = await this.loadData(sceneKey(id));
            const snap = typeof raw === "string" ? JSON.parse(raw || "null") : raw;
            return snap ?? null;
        } catch {
            return null;
        }
    }

    private openDashboard(): void {
        if (!this.activeProjectId) return;
        // openTab custom 不按 id 去重（实测同 id 连开=两个页签）——先查已开，聚焦复用；
        // getOpenedTab 可能含已关闭页签的陈旧记录（headElement 已 detach）→须验活，死了落新建
        const opened = (this.getOpenedTab?.() ?? {})[DASHBOARD_TAB] ?? [];
        const liveTab = (opened.find((c) => (c as any).parent?.headElement?.isConnected) as any)?.parent;
        if (liveTab) {
            try {
                liveTab.parent?.switchTab?.(liveTab.headElement);
            } catch {
                // 聚焦失败=保持现状（内容已由 pj-project-switched 事件刷新）
            }
            return;
        }
        void openTab({
            app: this.app,
            custom: {
                icon: "iconWorkspace",
                title: this.i18n.dashboardTitle,
                data: {},
                id: `${this.name}${DASHBOARD_TAB}`,
            },
        });
    }

    /** 全局日志入口：打开当月日志文档（/Project/日志/<YYYY-MM>；diaryJumpSqls 首条定位，
     *  只定位不建档——无月文档=toast 懒建提示，首次班表写入时 kernel 建）。
     *  不依赖 index.ts 既有的「当日日记跳转」链——那是文件地图当日跳转，语义不同，各自独立。 */
    private async openDiaryMonth(): Promise<void> {
        const now = new Date();
        const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        try {
            for (const stmt of diaryJumpSqls(iso)) {
                const rows = await feQuery<{ id: string }>(stmt);
                if (rows[0]?.id) {
                    this.openDocNoFocus(rows[0].id);
                    return;
                }
            }
            showMessage(this.i18n.diaryJumpHint, 2500, "info");
        } catch (e: any) {
            debugLog("fe", `!! openDiaryMonth failed: ${String(e?.message ?? e)}`);
        }
    }

    /** 禁聚焦政策（bear 09-15 拍板+09-16 补齐，OpenSyFile2 同款组合钉死不留参数）：
     *  ① zoomIn:false 显式钉死防回归；② action 必带 cb-get-context——缺它 Editor.getDoc 走
     *  mode 0「仅当前 ID」=只加载目标块+面包屑变祖先链，形态等同聚焦（09-16 森林图任务块
     *  实锤：zoomIn 参数无关，缺 context 才是根因）；带它 mode 3 上下文窗口+cb-get-hl 滚动定位。
     *  ③ 打开后归还键盘焦点+清选区（双拍兜底覆盖慢加载窗口，model 收域防误伤）。
     *  调用面统一收口此一处（日历/驾驶舱/森林图），不暴露 action 参数。 */
    private openDocNoFocus(id: string): void {
        void openTab({
            app: this.app,
            doc: { id, zoomIn: false, action: OPEN_NO_FOCUS_ACTION },
            afterOpen: (model?: any) => {
                // model 收域（□11 b3b580a4 同款语义）：善后只对本次打开的 protyle 容器内
                // 的焦点/选区出手，防 400/1100ms 窗口内误伤用户自己正编辑的其他文档；
                // model 空（pdf/跨窗/custom 页签）=无收域目标，跳过两拍
                const root: HTMLElement | undefined = model?.editor?.protyle?.element;
                for (const delay of [400, 1100]) {
                    setTimeout(() => {
                        const ae = document.activeElement;
                        if (root && ae instanceof HTMLElement && root.contains(ae)) ae.blur();
                        const sel = window.getSelection();
                        if (root && sel?.rangeCount && sel.anchorNode && root.contains(sel.anchorNode)) sel.removeAllRanges();
                    }, delay);
                }
            },
        });
    }

    /** 期 2 ⑤ 右键创建后跳日记聚焦该块（bear 拍板：用户主动要写=聚焦正当，禁聚焦政策只拦
     *  被动抢焦）。action 必带 cb-get-context（缺它 getDoc mode 0=伪聚焦，□13 实锤）+cb-get-focus
     *  光标落块——openTab 通道可用（new Protyle() 不消费 action 的坑不涉此路）。 */
    private openDocFocused(id: string): void {
        void openTab({
            app: this.app,
            doc: { id, zoomIn: false, action: ["cb-get-context", "cb-get-focus"] },
        });
    }

    /** 增补批二任务四：驾驶舱 openDoc 升级——打开文档（openDocNoFocus 全套禁聚焦语义）
     *  +把左栏文件树定位到该文档（异步搭车，失败静默不挡打开主链） */
    private openDocAndReveal(docId: string): void {
        this.openDocNoFocus(docId);
        void (async () => {
            try {
                const rows = await feQuery<{ box: string; path: string }>(docPathSql(docId));
                if (rows[0]?.box && rows[0]?.path) this.revealInFileTree(rows[0].box, rows[0].path);
            } catch (e) {
                debugLog("fe", `!! reveal-in-filetree lookup failed: ${String(e)}`);
            }
        })();
    }

    /** 文件树定位（官方通道）：Files.selectItem(notebookId, path)——与官方「定位当前页签」
     *  selectOpenTab（app/src/layout/dock/util.ts:275，官方命令 selectOpen1）同一函数：
     *  逐级 listDocsByPath 展开祖先 → setCurrent（清旧 focus+挂目标 focus+滚动到容器中部）
     *  +toggleModel("file", true) 确保文件面板可见。Files 实例经 window.siyuan.layout 官方
     *  公开结构获取（官方 getDockByType 即读 leftDock/rightDock.data——非 import 内部模块）。
     *  定位到位后叠加 ~0.9s 短暂高亮（switcher.css .pj-tree-flash——官方 focus 态之上的
     *  显式提示）；结构缺失/异常=静默跳过（定位是增强，不挡任何主链）。 */
    private revealInFileTree(box: string, path: string): void {
        try {
            const layout = (window as any).siyuan?.layout;
            const dock = [layout?.leftDock, layout?.rightDock].find((d: any) => d?.data?.file);
            const files = dock?.data?.file;
            if (typeof files?.selectItem !== "function") return;
            void Promise.resolve(files.selectItem(box, path)).then(
                (li: unknown) => {
                    try {
                        dock?.toggleModel?.("file", true);
                    } catch { /* 面板打开失败不影响已完成的定位 */ }
                    if (li instanceof HTMLElement) {
                        li.classList.add("pj-tree-flash");
                        setTimeout(() => li.classList.remove("pj-tree-flash"), 900);
                    }
                },
                (e: unknown) => debugLog("fe", `!! reveal-in-filetree selectItem rejected: ${String(e)}`),
            );
        } catch (e) {
            debugLog("fe", `!! reveal-in-filetree failed: ${String(e)}`);
        }
    }

    /** 设置面板（calnav □1·bear 拍板 B 自建 Dialog）：双栏壳四页（AI 接入/用法示例/日历配置/
     *  同步对账）。override 基类 openSetting——官方「设置→插件→主线」入口与驾驶舱齿轮/
     *  切换器菜单同走此路（官方 Setting/addItem 链 setupSettings 整体退役） */
    private confDialog: Dialog | null = null;
    private confComp: any = null;

    openSetting(): void {
        // 重载竞态窗守卫（review P2-3）：onunload 后 dispose 前的入口触发=建在死实例上的
        // 僵尸 Conf——早退（窗口亚秒级，入口 UI 届时也正在拆除）
        if (this.unloaded) return;
        // 重开去重（渐进先例）：面板开着再点=先销毁旧 Dialog（destroyCallback 同步 unmount 旧树）
        this.confDialog?.destroy();
        const hostId = `pj-conf-${Date.now().toString(36)}`;
        const dialog: Dialog = new Dialog({
            title: this.i18n.confDialogTitle,
            content: `<div id="${hostId}"></div>`,
            width: "min(760px, 92vw)",
            height: "min(700px, 92vh)",
            destroyCallback: () => {
                // 内核 destroy 回调走 setTimeout 异步（TIMEOUT_DBLCLICK）：重开场景下这里
                // 可能是旧 Dialog 迟到的回调而新树已挂——按实例身份守卫，只拆自己那代
                if (this.confDialog !== dialog) return;
                if (this.confComp) unmount(this.confComp); // Svelte 5 正轨：unmount 才真卸载
                this.confComp = null;
                this.confDialog = null;
            },
        });
        this.confDialog = dialog;
        this.confComp = mount(Conf, {
            target: dialog.element.querySelector(`#${hostId}`),
            props: {
                t: this.i18n as unknown as Record<string, string>,
                loadFeishuStatus: () => this.loadFeishuStatus(),
                loadLedger: () => this.loadLedgerData(),
                // 按钮化 c：B 档一键重授权+A 档手动贴 code（两路共用 rpc calendar-auth）
                startReauth: () => this.startReauth(),
                applyReauthCode: (code: string) => this.applyReauthCode(code),
                // 首配纯 UI（calauth □2）：表单一键授权/手动贴码/清除配置/凭证预填
                startSetup: (appId: string, appSecret: string) => this.startSetup(appId, appSecret),
                applySetupCode: (appId: string, appSecret: string, code: string) => this.applySetupCode(appId, appSecret, code),
                clearFeishu: () => this.clearFeishu(),
                loadCredsArchive: () => this.loadFeishuCreds(),
                // 已配置态手动通道的授权链接来源（bear 09-14 断档修复——UI 平铺可点可复制）
                loadReauthUrl: async () => {
                    const appId = await this.loadFeishuAppId();
                    return appId ? buildAuthorizeUrl(appId, OAUTH_REDIRECT_URI, "manual") : null;
                },
                // pjux □2：命令与入口管理页数据通道
                getEntryToggles: () => this.getEntryToggles(),
                setEntryToggle: (key: string, on: boolean) => this.setEntryToggle(key as keyof EntryToggles, on).catch(() => false),
                // □17 回流：日历勾选清单数据通道（目录=kernel 轮询写的 meta；勾选=前端落盘+即时拉一轮；
                // 空目录首配=pollMirrorNow 等 kernel 拉完再读，免最长 1 小时空窗）
                loadMirrorCatalog: () => this.loadMirrorCatalog(),
                saveMirrorConf: (checked: Record<string, boolean>) => this.saveMirrorConf(checked),
                pollMirrorCatalog: () => this.pollMirrorNow(),
                // □18 自动天气：配置读写通道（城市坐标=设置页 geocoding 解析好再存）
                loadWeatherConf: () => this.loadWeatherConf(),
                saveWeatherConf: (conf) => this.saveWeatherConf(conf),
                // 期 4：自动存入开关（sched 镜像链退役后设置面唯一存活项）
                loadSchedAutoAdopt: () => this.loadSchedAutoAdopt(),
                applySchedAutoAdopt: (on: boolean) => this.applySchedAutoAdopt(on),

                loadReminderChannels: () => this.loadReminderChannels(),
                saveReminderChannels: (ch: ReminderChannels) => this.saveReminderChannels(ch),
            },
        });
    }

    /** 日历配置只读镜像（Conf 状态行用；读 petal 同文件，失败=null 显示未配置）。
     *  ⚠️不走 loadData——它有内存缓存，清除/重授权后同窗内回 stale（calauth □2 e2e 实锤：
     *  kernel 已删盘上文件、状态行仍「已配置」）；getFile HTTP 直读恒新鲜 */
    private async loadFeishuStatus(): Promise<{ channel: string; calendarId?: string; enabled: boolean } | null> {
        const cfg = await this.readPetalJsonViaHttp("feishu-config.json");
        if (!cfg?.channel) return null;
        return { channel: cfg.channel, calendarId: cfg.calendarId, enabled: cfg.enabled !== false };
    }

    /** petal JSON 直读（绕 loadData 缓存；缺文件/损坏=null） */
    private async readPetalJsonViaHttp(file: string): Promise<any | null> {
        try {
            const r = await fetch("/api/file/getFile", {
                method: "POST",
                headers: { Authorization: `Token ${window.siyuan.config.api.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ path: `/data/storage/petal/${this.name}/${file}` }),
            });
            if (!r.ok) return null;
            const text = await r.text();
            return text ? JSON.parse(text) : null;
        } catch {
            return null;
        }
    }

    /** 写路径守卫版（review P1-2，仿 kernel petalGetJsonFreshEx 语义）：ok:false=读失败（网络/HTTP 错/
     *  getFile 错误壳/坏 JSON—— getFile 成功=body 即文件本体，失败才有 code 包装，kernel/api 契约）——
     *  读改写整档的消费者必须放弃本轮覆盖，否则旧档/错误对象回灌内存后下一笔写=30 天历史丢失。
     *  ok:true+data:null=缺档（合法空态）。目前只接 feedback（写路径独一档）；其余读面后续统一迁 */
    private async readPetalJsonViaHttpEx(file: string): Promise<{ ok: boolean; data: any | null }> {
        try {
            const r = await fetch("/api/file/getFile", {
                method: "POST",
                headers: { Authorization: `Token ${window.siyuan.config.api.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ path: `/data/storage/petal/${this.name}/${file}` }),
            });
            if (!r.ok) return { ok: false, data: null };
            const text = await r.text();
            if (!text) return { ok: true, data: null };
            try {
                const j = JSON.parse(text);
                if (typeof j?.code === "number" && j.code !== 0) {
                    return j.code === 404 ? { ok: true, data: null } : { ok: false, data: null };
                }
                return { ok: true, data: j };
            } catch {
                return { ok: false, data: null }; // 坏档按读失败（写路径放弃，勿静默重建覆盖）
            }
        } catch {
            return { ok: false, data: null };
        }
    }

    /** gantt-lanes：断轴压缩偏好存档（saveData 恒带 app=本窗，不触发自身重载） */
    private async saveGanttPrefs(compress: boolean): Promise<void> {
        await this.saveData(GANTT_PREFS_FILE, JSON.stringify({ compress }));
    }

    /** □3 日历账本只读镜像（Conf 日历区）：读 petal calendar-ledger.json（kernel 同步链写；失败/缺文件=null 空态） */
    private async loadLedgerData(): Promise<import("./kernel/core/ledger").CalendarLedger | null> {
        try {
            const raw = await this.loadData(LEDGER_FILE);
            return typeof raw === "string" ? JSON.parse(raw || "null") : raw;
        } catch {
            return null;
        }
    }

    /** 按钮化 b：日历同步状态只读（驾驶舱日历区）——petal calendar-status.json（kernel 每轮写；null=never 态） */
    async loadCalendarStatusData(): Promise<CalendarStatus | null> {
        try {
            const raw = await this.loadData(CALENDAR_STATUS_FILE);
            const s = typeof raw === "string" ? JSON.parse(raw || "null") : raw;
            return s ?? null;
        } catch {
            return null;
        }
    }

    // ── □17 飞书日历回流读链：镜像/目录/勾选/实例的前端通道 ──

    /** 循环系列实例（kernel rpc；不可用/失败=null=前端跳过循环显示，不阻塞月历） */
    async fetchCalendarInstances(startTs: number, endTs: number): Promise<{ ok: boolean; rows?: import("./kernel/core/calendarMirror").InstanceRow[] } | null> {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.call?.[CALENDAR_INSTANCES_METHOD]) return null;
        try {
            return await rpc.call[CALENDAR_INSTANCES_METHOD]({ startTs, endTs });
        } catch (e) {
            debugLog("cal", `!! instances rpc failed: ${String(e)}`);
            return null;
        }
    }

    /** 即时轮询并等回执（rpc call——设置页空目录首配场景等 kernel 拉完再读 meta；失败 null 静默） */
    async pollMirrorNow(): Promise<{ changed?: boolean; events?: number; error?: string } | null> {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.call?.[CALENDAR_MIRROR_POLL_METHOD]) return null;
        try {
            return await rpc.call[CALENDAR_MIRROR_POLL_METHOD]({});
        } catch (e) {
            debugLog("cal", `!! mirror poll rpc failed: ${String(e)}`);
            return null;
        }
    }

    /** □18 天气配置只读（设置页；readPetalJsonViaHttp 绕缓存恒新鲜） */
    async loadWeatherConf(): Promise<{ enabled: boolean; city: { name: string; lat: number; lon: number } | null } | null> {
        const c = await this.readPetalJsonViaHttp(WEATHER_CONFIG_FILE).catch(() => null);
        if (!c || typeof c !== "object") return null;
        return {
            enabled: c.enabled === true,
            city: typeof c.city?.lat === "number" && typeof c.city?.lon === "number"
                ? { name: String(c.city.name ?? ""), lat: c.city.lat, lon: c.city.lon }
                : null,
        };
    }

    /** □18 天气配置落盘（城市→坐标已由设置页 geocoding 解析好；存后即时跑一轮） */
    async saveWeatherConf(conf: { enabled: boolean; city: { name: string; lat: number; lon: number } | null }): Promise<boolean> {
        try {
            await this.saveData(WEATHER_CONFIG_FILE, JSON.stringify(conf));
            this.notifyWeatherSync();
            return true;
        } catch (e) {
            debugLog("cal", `!! weather-conf save failed: ${String(e)}`);
            return false;
        }
    }

    /** □18 天气任务触发（notify 语义不等回执） */
    notifyWeatherSync(): void {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.notify) return;
        try {
            rpc.notify[WEATHER_SYNC_METHOD]();
            debugLog("cal", "weather-sync notified");
        } catch (e) {
            debugLog("cal", `!! weather-sync notify failed: ${String(e)}`);
        }
    }

    /** 轮询触发（hourlyTimer/勾选保存即时拉一轮；notify 语义不等回执） */
    notifyMirrorPoll(): void {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.notify) return;
        try {
            rpc.notify[CALENDAR_MIRROR_POLL_METHOD]();
            debugLog("cal", "mirror-poll notified");
        } catch (e) {
            debugLog("cal", `!! mirror-poll notify failed: ${String(e)}`);
        }
    }

    /** 期 2 ④ 日历手动刷新：踢 kernel 真同步一轮（镜像轮询→writeback/adopt 落块+remind 同步；
     *  notify 不等回执——落块/写盘广播回来 Calendar 防抖自刷=飞书最新数据到位） */
    manualCalendarSync(): void {
        this.notifyMirrorPoll();
        triggerRemindSync(this);
    }

    /** sloop □3 行为画像采集触发（hourlyTimer 搭车；notify 语义不等回执） */
    notifyBehaviorCollect(): void {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.notify) return;
        try {
            rpc.notify[BEHAVIOR_COLLECT_METHOD]();
            debugLog("sloop", "behavior-collect notified");
        } catch (e) {
            debugLog("sloop", `!! behavior-collect notify failed: ${String(e)}`);
        }
    }

    // ── sloop □4 交接会 MVP：班表读改+晨间检查+交接会对话框 ──

    /** 班表整档只读（readPetalJsonViaHttp 绕缓存恒新鲜；缺档/坏档=空班表） */
    async loadScheduleStore(): Promise<SchedStore> {
        return normalizeSchedule(await this.readPetalJsonViaHttp(SCHEDULE_FILE).catch(() => null));
    }

    /** □23 随手反馈档写盘（时间线「记」/chip 删——saveData 恒带 app=排除本窗重载；失败 debugLog
     *  留痕，内存 chip 不回滚〔随手记非关键数据，重载自愈回档态〕） */
    async saveFeedbackStore(store: FeedbackStore): Promise<boolean> {
        try {
            await this.saveData(FEEDBACK_FILE, JSON.stringify(store));
            return true;
        } catch (e: any) {
            debugLog("sloop", `!! feedback save failed: ${String(e?.message ?? e)}`);
            return false;
        }
    }

    // ── 番茄桥（bear 09-20 拍板「直接用番茄工具箱的番茄钟」）：运行态/参数档随自建钟退役，
    //    留账本续写+tomato petal 只读+桥状态档三通道（时间线消费） ──

    /** 历史档读（Ex 版写路径守卫：读失败≠空档，防旧档回灌丢事件流） */
    async loadPomoLog(): Promise<{ ok: boolean; data: any | null }> {
        return this.readPetalJsonViaHttpEx(POMODORO_LOG_FILE);
    }

    async savePomoLog(store: import("./gui/pomoBridge").PomoLogStore): Promise<boolean> {
        try {
            await this.saveData(POMODORO_LOG_FILE, JSON.stringify(store));
            return true;
        } catch (e: any) {
            debugLog("sloop", `!! pomodoro log save failed: ${String(e?.message ?? e)}`);
            return false;
        }
    }

    /** tomato petal 档读（桥在场探测/状态读/回流共通道——原 checkTomatoRunning 读法泛化）：
     *  返回裸文本；null=未装/HTTP 失败/{code} 错误壳（getFile 成功=body 即文件本体，失败才有
     *  code 包装，kernel/api 契约——桥侧自行 parse，{}=idle） */
    async fetchTomatoText(file: string): Promise<string | null> {
        try {
            const r = await fetch("/api/file/getFile", {
                method: "POST",
                headers: { Authorization: `Token ${window.siyuan.config.api.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ path: `/data/storage/petal/sy-tomato-plugin/${file}` }),
            });
            if (!r.ok) return null;
            const text = await r.text();
            if (!text) return null;
            try {
                const j = JSON.parse(text);
                if (typeof j?.code === "number") return null; // 错误壳
            } catch {
                return null; // 非 JSON=垃圾
            }
            return text;
        } catch {
            return null;
        }
    }

    /** 桥状态档读（当前任务标记+回流锚；读失败=null 空态自愈） */
    async loadPomoBridgeState(): Promise<unknown> {
        return this.readPetalJsonViaHttp(POMO_BRIDGE_STATE_FILE);
    }

    async savePomoBridgeState(state: { focus?: import("./gui/pomoBridge").PomoTarget | null; seen?: import("./gui/pomoBridge").TomatoStatsSeen }): Promise<boolean> {
        try {
            await this.saveData(POMO_BRIDGE_STATE_FILE, JSON.stringify(state));
            return true;
        } catch (e: any) {
            debugLog("sloop", `!! pomo bridge state save failed: ${String(e?.message ?? e)}`);
            return false;
        }
    }

    /** 晨间滚动检查触发（hourlyTimer 搭车；notify 语义不等回执） */
    notifyScheduleSync(): void {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.notify) return;
        try {
            rpc.notify[SCHEDULE_SYNC_METHOD]();
            debugLog("sloop", "schedule-sync notified");
        } catch (e) {
            debugLog("sloop", `!! schedule-sync notify failed: ${String(e)}`);
        }
    }

    // ── 外部日历镜像配置（timeblock 期 4 瘦身：sched 镜像链/backend/writeback/macOS 镜像
    //    已随 sched 双源退役——班表块的飞书事件由 remind 链推；本档只剩 autoAdopt 开关） ──

    /** 自动存入开关读（sched-mirror-conf.autoAdopt，缺省=开；文件名沿用旧档不迁移） */
    async loadSchedAutoAdopt(): Promise<boolean> {
        const raw = await this.readPetalJsonViaHttp(SCHED_MIRROR_CONF_FILE).catch(() => null);
        return raw?.autoAdopt === undefined ? true : Boolean(raw.autoAdopt);
    }

    /** 自动存入开关落地：直接写 conf（kernel poll 后逐轮读，无 apply rpc 链）；rpc/写失败回滚盘面 */
    async applySchedAutoAdopt(on: boolean): Promise<{ ok: boolean; error?: string }> {
        try {
            await this.saveData(SCHED_MIRROR_CONF_FILE, JSON.stringify({ autoAdopt: on }));
        } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
        }
        return { ok: true };
    }

    // ── timeblock 期 2 ② 读面切块：日面板数据/写通道 ──

    /** 当日班表块只读（kernel rpc sched-board-read：getChildBlocks 真序+IAL 直读=写后立读安全，
     *  绝不建档）。null=rpc 不可用/超时（日面板空态降级；月历块扫描源兜底可见） */
    async readDayBoard(day: string): Promise<import("./kernel/schedboard").BoardReadResult | null> {
        try {
            const call = (this as any).kernel?.rpc?.call?.[SCHED_BOARD_READ_METHOD]?.({ day }) ?? null;
            if (!call) return null;
            return await Promise.race([call, new Promise<null>((res) => setTimeout(() => res(null), 8000))]);
        } catch (e: any) {
            debugLog("schedboard", `readDayBoard rpc 异常: ${String(e?.message ?? e)}`);
            return null;
        }
    }

    /** mainfix0923 □5 文件地图跳转：当日日记（只定位不建档——B3 日账月账化后写落点=日记
     *  月文档 `/主线数据/日记/YYYY-MM`，故走 diaryJumpSqls 月文档优先+老每日文档兜底；
     *  ⚠勿用 sched-board-read 的 docId——其 locateDayDoc 是逐日 hpath 口径恒 null。
     *  定位不到=toast 提示懒建时机，不 ensure。跳转恒走 openDocNoFocus（禁聚焦政策）。 */
    async openTodayDiary(): Promise<void> {
        const day = getLogicalDay(new Date());
        let docId: string | null = null;
        try {
            for (const stmt of diaryJumpSqls(day)) {
                const docs = await feQuery<{ id: string }>(stmt);
                if (docs[0]?.id) {
                    docId = docs[0].id;
                    break;
                }
            }
        } catch (e: any) {
            debugLog("fe", `openTodayDiary 定位失败: ${String(e?.message ?? e)}`);
        }
        if (!docId) {
            showMessage(this.i18n.diaryNotYet ?? "今日日记还未生成（第一次打点/交接会时自动建）", 3500, "info");
            return;
        }
        this.openDocNoFocus(docId);
    }

    /** mainfix0923 □5 文件地图跳转：每日配置月文档（dayConfigDocSql=kernel locateDayConfigDoc
     *  的 gui 读半边，只定位不建档；定位不到=toast 提示懒建时机，不 ensure）。
     *  跳转恒走 openDocNoFocus（禁聚焦政策）。 */
    async openDayConfigDoc(): Promise<void> {
        const day = getLogicalDay(new Date());
        try {
            const docs = await feQuery<{ id: string }>(dayConfigDocSql(day));
            const docId = docs[0]?.id ?? null;
            if (!docId) {
                showMessage(this.i18n.dayConfigNotYet ?? "每日配置月文档还未生成（AI 写每日配置时自动建）", 3500, "info");
                return;
            }
            this.openDocNoFocus(docId);
        } catch (e: any) {
            debugLog("fe", `openDayConfigDoc 定位失败: ${String(e?.message ?? e)}`);
            showMessage(this.i18n.dayConfigNotYet ?? "每日配置月文档还未生成（AI 写每日配置时自动建）", 3500, "info");
        }
    }

    /** ammo □7：日账单日读（kernel rpc ammo-ledger-read——实况段数据源；null=rpc 不可用/失败，
     *  组件侧实况段缺席降级五源）。type=LedgerEntry 形态见 kernel/core/ammoLedger。 */
    async ammoLedgerReadDay(day?: string): Promise<import("./kernel/core/ammoLedger").AmmoLedgerEntry[] | null> {
        try {
            const call = (this as any).kernel?.rpc?.call?.[AMMO_LEDGER_READ_METHOD]?.(day ? { day } : {}) ?? null;
            if (!call) return null;
            const r = await Promise.race([call, new Promise<null>((res) => setTimeout(() => res(null), 8000))]);
            return r?.ok ? (r.items ?? []) : null;
        } catch (e: any) {
            debugLog("ammo", `ammoLedgerReadDay rpc 异常: ${String(e?.message ?? e)}`);
            return null;
        }
    }

    /** ammo □7：日账日窗读（月历 42 格窗——翻月按需拉；失败=null 组件侧保持上一窗） */
    async ammoLedgerReadDays(days: string[]): Promise<Array<{ day: string; items: import("./kernel/core/ammoLedger").AmmoLedgerEntry[] }> | null> {
        try {
            const call = (this as any).kernel?.rpc?.call?.[AMMO_LEDGER_READ_METHOD]?.({ days }) ?? null;
            if (!call) return null;
            const r = await Promise.race([call, new Promise<null>((res) => setTimeout(() => res(null), 20_000))]);
            return r?.ok ? (r.days ?? []) : null;
        } catch (e: any) {
            debugLog("ammo", `ammoLedgerReadDays rpc 异常: ${String(e?.message ?? e)}`);
            return null;
        }
    }

    /** tb2 H1：日历轴右键建带时间空段落块（bear 拍板「先简单只支持段落块」）——kernel rpc
     *  委托（ensureDayDiary+班表容器后插段+挂 custom-remind-at，走 remind 链全家桶） */
    async createRemindEntry(day: string, start: string): Promise<import("./kernel/schedboard").RemindEntryCreateResult | null> {
        try {
            const call = (this as any).kernel?.rpc?.call?.[REMIND_ENTRY_CREATE_METHOD]?.({ day, start }) ?? null;
            if (!call) return null;
            return await Promise.race([call, new Promise<null>((res) => setTimeout(() => res(null), 8000))]);
        } catch (e: any) {
            debugLog("schedboard", `createRemindEntry rpc 异常: ${String(e?.message ?? e)}`);
            return null;
        }
    }

    /** tb2 H4：飞书测试消息直发（bot 身份+可选加急；超时/异常回 {ok:false,error} 而非
     *  null——驾驶舱 toast 要透传错误细节） */
    async feishuTestSend(urgent: string, text?: string): Promise<{ ok: boolean; error?: string; urgentApplied?: string }> {
        try {
            const call = (this as any).kernel?.rpc?.call?.[FEISHU_TEST_SEND_METHOD]?.({ urgent, text }) ?? null;
            if (!call) return { ok: false, error: "kernel 未响应（插件重载中？稍后再试）" };
            return await Promise.race([call, new Promise<{ ok: false; error: string }>((res) => setTimeout(() => res({ ok: false, error: "kernel 8s 未回执" }), 8000))]);
        } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** tb2 H4：马上到期测试事件（oauth 身份建+清场旧测试事件；到点看手机弹没弹） */
    async feishuTestEvent(seconds: number): Promise<{ ok: boolean; error?: string; startAt?: string; swept?: number }> {
        try {
            const call = (this as any).kernel?.rpc?.call?.[FEISHU_TEST_EVENT_METHOD]?.({ seconds }) ?? null;
            if (!call) return { ok: false, error: "kernel 未响应（插件重载中？稍后再试）" };
            return await Promise.race([call, new Promise<{ ok: false; error: string }>((res) => setTimeout(() => res({ ok: false, error: "kernel 8s 未回执" }), 8000))]);
        } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** tb6 □6d：机器人身份自检（bot/v3/info——当前凭证的 bot 名+appId 尾 4 位，防配错） */
    async feishuBotInfo(): Promise<{ ok: boolean; error?: string; botName?: string; appIdTail?: string }> {
        try {
            const call = (this as any).kernel?.rpc?.call?.[FEISHU_BOT_INFO_METHOD]?.() ?? null;
            if (!call) return { ok: false, error: "kernel 未响应（插件重载中？稍后再试）" };
            return await Promise.race([call, new Promise<{ ok: false; error: string }>((res) => setTimeout(() => res({ ok: false, error: "kernel 8s 未回执" }), 8000))]);
        } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** 全库班表块扫描（月历 sched 源切块——petal 读面退役；SQL 通道） */
    async loadBoardRows(): Promise<BoardScanRow[]> {
        return feQuery(listBoardBlocksSql());
    }

    /** 月历班表源转换（boardRowsToSchedItems 直通——组件只拿 SchedItem 形态） */
    async loadBoardItems(): Promise<SchedItem[]> {
        try {
            const rows = await this.loadBoardRows();
            return boardRowsToSchedItems(rows, getLogicalDay(new Date()));
        } catch {
            return []; // SQL 通道错误=空源（月历其余源照常）
        }
    }

    /** 拖动 remind 块改时刻（setBlockAttrs 直写——块=真身；end 全量写=保时长平移语义由调用方算好）。
     *  写后搭车触发一轮 remind 同步（飞书事件跟着挪）；不广播——日面板本地乐观更新 */
    async moveRemindBlock(blockId: string, day: string, startHM: string, endHM: string | null): Promise<boolean> {
        try {
            await writeBlockAttrsDirect(blockId, {
                "custom-remind-at": `${day}T${startHM}`,
                "custom-remind-end": endHM ? `${day}T${endHM}` : "",
            });
            triggerRemindSync(this);
            return true;
        } catch (e: any) {
            debugLog("schedboard", `moveRemindBlock 失败: ${String(e?.message ?? e)}`);
            showMessage(this.i18n.schedMoveFail ?? "改时间失败", 3000, "error");
            return false;
        }
    }

    /** 拖动任务块改 due 时刻（同上；due_date 不动——日面板只挪当日时刻） */
    async moveTaskDueTime(blockId: string, timeHM: string): Promise<boolean> {
        try {
            await writeBlockAttrsDirect(blockId, { "custom-task-due-time": timeHM });
            triggerRemindSync(this);
            return true;
        } catch (e: any) {
            debugLog("schedboard", `moveTaskDueTime 失败: ${String(e?.message ?? e)}`);
            showMessage(this.i18n.schedMoveFail ?? "改时间失败", 3000, "error");
            return false;
        }
    }

    // ── 期 2 ⑤ 条目右键三动作通道（Calendar 日面板 contextmenu 消费） ──

    /** 删飞书外来事件（无块虚显条目的删除）：kernel rpc sched-foreign-delete——镜像定位真实历
     *  id+DELETE+清账本孤儿绑定+立即镜像轮询（广播回来防抖自刷=虚显行消失）。toast 在本通道层。 */
    async deleteForeignEvent(eventId: string): Promise<{ ok: boolean; error?: string } | null> {
        const live = this.liveSelf();
        if (live) return live.deleteForeignEvent(eventId); // 重载窗自愈
        let r: { ok: boolean; error?: string } | null = null;
        try {
            r = await ((this as any).kernel?.rpc?.call?.[SCHED_FOREIGN_DELETE_METHOD]?.({ eventId }) ?? null);
        } catch (e: any) {
            showMessage(String(e?.message ?? e), 3000, "error");
            return { ok: false, error: String(e?.message ?? e) };
        }
        if (!r) {
            showMessage(this.i18n.calAdoptNoChannel ?? "kernel rpc 不可用", 3000, "error");
            return { ok: false, error: "no channel" };
        }
        if (r.ok) {
            showMessage(this.i18n.calDeleteDone ?? "已删除", 2500, "info");
        } else {
            showMessage(r.error ?? "删除失败", 3000, "error");
        }
        return r;
    }

    /** 删块（remind/task 条目的删除=连块一起删，bear 二轮拍板）：块删后镜像事件下轮同步
     *  自清（liveKeys 消亡机制）；先触发一轮 remind-sync 加速收敛。 */
    async deleteBlockEntry(blockId: string): Promise<boolean> {
        try {
            const token = (window as any).siyuan?.config?.api?.token ?? "";
            const r = await fetch("/api/block/deleteBlock", {
                method: "POST",
                headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ id: blockId }),
            });
            const d = await r.json();
            if (d.code !== 0) throw new Error(d.msg ?? `deleteBlock failed: ${r.status}`);
            triggerRemindSync(this);
            return true;
        } catch (e: any) {
            debugLog("schedboard", `deleteBlockEntry 失败: ${String(e?.message ?? e)}`);
            showMessage(this.i18n.schedDeleteFail ?? "删除失败", 3000, "error");
            return false;
        }
    }

    /** remind 块去时间（块保留、退役出日程）：清 remind-at/end 两属性+触发同步（事件随消亡
     *  机制自清——remind 链「属性已清不进 live」剪枝侧删）。 */
    async untimeRemindBlock(blockId: string): Promise<boolean> {
        try {
            await writeBlockAttrsDirect(blockId, { "custom-remind-at": "", "custom-remind-end": "" });
            triggerRemindSync(this);
            return true;
        } catch (e: any) {
            debugLog("schedboard", `untimeRemindBlock 失败: ${String(e?.message ?? e)}`);
            showMessage(this.i18n.schedUntimeFail ?? "去掉时间失败", 3000, "error");
            return false;
        }
    }

    /** 任务块去时间（块保留、退役出日程）：清 due-date/due-time（只清 time 任务仍占当日日历）+触发同步。 */
    async untimeTaskDueTime(blockId: string): Promise<boolean> {
        try {
            await writeBlockAttrsDirect(blockId, { "custom-task-due-date": "", "custom-task-due-time": "" });
            triggerRemindSync(this);
            return true;
        } catch (e: any) {
            debugLog("schedboard", `untimeTaskDueTime 失败: ${String(e?.message ?? e)}`);
            showMessage(this.i18n.schedUntimeFail ?? "去掉时间失败", 3000, "error");
            return false;
        }
    }

    /** 提醒通道读（缺档/坏档=默认：内推送开/弹窗关/外部日历提醒开） */
    async loadReminderChannels(): Promise<ReminderChannels> {
        const raw = await this.readPetalJsonViaHttp(REMINDER_CHANNELS_FILE).catch(() => null);
        return {
            toast: raw?.toast === undefined ? DEFAULT_REMINDER_CHANNELS.toast : Boolean(raw.toast),
            dialog: raw?.dialog === undefined ? DEFAULT_REMINDER_CHANNELS.dialog : Boolean(raw.dialog),
            external: raw?.external === undefined ? DEFAULT_REMINDER_CHANNELS.external : Boolean(raw.external),
        };
    }
    /** □16 SchedNotifyHost 契约：全库块提醒扫描（60s 缓存在 notifier 侧） */
    loadRemindRows(): Promise<import("./schedNotify").RemindNotifyRow[]> {
        return feQuery(listRemindBlocksSql());
    }

    /** dataview □3 SchedNotifyHost 契约：锚点出发（kernel rpc ammo-depart——闭当前打点+开
     *  锚点出发型 B2.4）。rpc 不可用/异常/超时={ok:false,error}（弹窗侧降级提示，不炸提醒链
     *  ——readDayBoard 8s race 同款纪律；引擎侧自身兜底 {ok:false,error} 不 throw） */
    async ammoDepart(p: import("./ammoDepartWire").DepartWireParams): Promise<{ ok: boolean; error?: string }> {
        try {
            const call = (this as any).kernel?.rpc?.call?.[AMMO_DEPART_METHOD]?.(p) ?? null;
            if (!call) return { ok: false, error: this.i18n.calAdoptNoChannel ?? "kernel rpc 不可用" };
            return await Promise.race([
                call,
                new Promise<{ ok: boolean; error: string }>((res) => setTimeout(() => res({ ok: false, error: this.i18n.schedNotifyDepartTimeout ?? "rpc 无响应" }), 8000)),
            ]);
        } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** 提醒通道落盘（与镜像数据解耦的独立 petal 键；外部日历提醒位由 kernel 镜像链读） */
    async saveReminderChannels(ch: ReminderChannels): Promise<boolean> {
        try {
            await this.saveData(REMINDER_CHANNELS_FILE, JSON.stringify(ch));
            return true;
        } catch (e) {
            debugLog("sloop", `!! reminder-channels save failed: ${String(e)}`);
            return false;
        }
    }

    // ── sloop □6 作息训练·期 4：照镜子周报（kernel 独家写周报表；前端只读+角标） ──

    /** 周报表只读（readPetalJsonViaHttp 绕缓存恒新鲜；缺档/坏档=空表） */
    async loadWeeklyStore(): Promise<WeeklyStore | null> {
        return normalizeWeekly(await this.readPetalJsonViaHttp(ROUTINE_WEEKLY_FILE).catch(() => null));
    }

    /** 周报检查触发（hourlyTimer 搭车+onrunning 兜底；kernel 侧幂等=已生成周零写） */
    notifyWeeklyReportSync(): void {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.notify) return;
        try {
            rpc.notify[WEEKLY_REPORT_SYNC_METHOD]();
            debugLog("sloop", "weekly-report-sync notified");
        } catch (e) {
            debugLog("sloop", `!! weekly-report-sync notify failed: ${String(e)}`);
        }
    }

    /** 班表三操作（拖动/加/删）：整档读改写（saveData 恒带 app=本窗，不触发自身重载；
     *  与 kernel MCP 写者竞态窗=拖动与 AI 写同刻，不并存，last-writer-wins 可接受）。
     *  add 可带稳定 key（SchedAddKeyOp）：同 key 已存在=幂等覆盖（冻结链重试不产重复 chip）；
     *  key miss 时按同日同 summary 的 user 条目软回退（remap 后键=块 id，review P1-1——重试
     *  不因键迁移变新增重复）。
     *  期 2 ① 统一写链：改后日终态先经 kernel rpc sched-board-sync 落日记块（块=唯一真身），
     *  keyRemap 迁移 key=块 id 后再写 petal；块侧失败=petal 照写（双写互不阻塞，下轮自愈）。
     *  实例级串行（review P1-4）：连拖两条各自拿旧档算终态=后到重放删先到新块（事件驱动无
     *  对账循环不自愈）——promise 链排队整操作。rpc 带 8s 超时（review P1-5：goja 主循环被占
     *  rpc 可排队分钟级，不超时=用户编辑卡死半路 petal 也没写）。 */
    /** 重载窗自愈（tb2e e2e 实锤）：菜单/拖动回调持有旧实例 props 闭包，petal 写广播触发前端
     *  整重载后旧实例 kernel 桥 #destroyed——rpc 全 410「Plugin lifecycle has ended」（块删静默
     *  失败留残留块）。本实例已 unloaded 时转投当前活实例执行（同插件名，通道面一致）。 */
    private liveSelf(): ProjectPlugin | null {
        if (!this.unloaded) return null;
        // p !== this：unloaded 置位先于数组摘除（onunload→dispose 时序窗内 this 仍在列），不排除=转发给自己无限递归
        // !p?.unloaded：连续快速重载窗内数组可同时有 ≥2 个 unloaded 同名实例——不滤目标态=互转发栈溢出（复评新-1）
        const live = ((window.siyuan as any)?.ws?.app?.plugins ?? []).find((p: any) => p?.name === this.name && p !== this && !p?.unloaded) ?? null;
        return (live as ProjectPlugin | null) ?? null;
    }

    private schedEditChain: Promise<unknown> = Promise.resolve();
    schedEdit(op: SchedEditOp | SchedAddKeyOp): Promise<SchedStore | null> {
        const live = this.liveSelf();
        if (live) return live.schedEdit(op); // 重载窗自愈：旧实例链已死，转投活实例
        const run = this.schedEditChain.then(() => this.schedEditInner(op), () => this.schedEditInner(op));
        this.schedEditChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async schedEditInner(op: SchedEditOp | SchedAddKeyOp): Promise<SchedStore | null> {
        // 期 4 块化：班表行恒取当日块读面（块=唯一真身），辅助档只接 drags（交接会待确认）。
        // 返回值=辅助档（Calendar 的 handoff 角标消费 recon 态）。
        try {
            const now = new Date();
            const today = getLogicalDay(now);
            /** 当日块读行（SchedItem 形态；null=rpc 失败≠空板——写面见 null 须中止防空基底整日替换） */
            const dayRowsOf = async (day: string): Promise<SchedItem[] | null> => {
                const r = await this.readDayBoard(day);
                if (!r?.ok || !Array.isArray(r.items)) return null; // 失败≠空板（空基底落块=整日替换）
                return boardRowsToItems(day, r.items);
            };
            /** key 所在行：先当日（Calendar 拖动恒当日）再全库班表块扫描兜底（跨日 remove 防御） */
            const locateRow = async (key: string): Promise<SchedItem | null> => {
                const todayRows = (await dayRowsOf(today)) ?? [];
                const hit = todayRows.find((r) => r.key === key);
                if (hit) return hit;
                const all = await this.loadBoardItems().catch(() => [] as SchedItem[]);
                return all.find((r) => r.key === key) ?? null;
            };

            let boardDay: string | null = null;
            let overrides: SchedItem[] = [];
            const excludes = new Set<string>();
            const newDrags: DragRecord[] = [];
            if (op.type === "move") {
                const row = await locateRow(op.key);
                if (!row) return await this.loadScheduleStore(); // 行不在（块已删/索引窗）=无事可做
                boardDay = row.date;
                const d = applyDragRow(row, op.to, now);
                if (!d) return await this.loadScheduleStore();
                overrides = [d.row];
                newDrags.push(d.drag);
            } else if (op.type === "add") {
                const stableKey = "key" in op && typeof op.key === "string" && op.key ? op.key : "";
                const at = now.toISOString();
                boardDay = op.day;
                const dayRows = await dayRowsOf(op.day);
                if (dayRows == null) return null; // 读失败中止（防空基底整日替换）
                // 稳定键直命中 → 软回退（同日同 summary 的 user 条目——remap 迁键后的重试幂等面）
                const prev = (stableKey ? dayRows.find((r) => r.key === stableKey) : undefined)
                    ?? (stableKey ? dayRows.find((r) => r.origin === "user" && r.summary === op.item.summary) : undefined);
                const key = prev?.key || stableKey || genSchedKey();
                overrides = [{
                    key, summary: op.item.summary, date: op.day, start: op.item.start, end: op.item.end,
                    hard: op.item.hard, origin: "user", createdAt: prev?.createdAt ?? at, updatedAt: at,
                }];
            } else {
                const row = await locateRow(op.key);
                if (!row) return await this.loadScheduleStore();
                boardDay = row.date;
                excludes.add(op.key);
            }

            // 日终态=块真身基底+override−excludes（期 4：petal 行退役，块即基底）。
            // 读失败=中止本轮（空基底=当日既有块被 diff 替换清空——P1-1 纪律）
            const baseRows = await dayRowsOf(boardDay);
            if (baseRows == null) return null;
            const m = mergeBoardDayRows(boardDay, baseRows, overrides, excludes, now);
            const dayTarget = m.target;
            let wrote = false;
            try {
                const call = (this as any).kernel?.rpc?.call?.[SCHED_BOARD_SYNC_METHOD]?.({ day: boardDay, items: dayTarget }) ?? null;
                const r = call ? await Promise.race([call, new Promise<null>((res) => setTimeout(() => res(null), 8000))]) : null;
                if (r?.ok) wrote = true;
                else if (r && !r.ok) debugLog("sloop", `schedEdit 块写失败：${String(r.error ?? "")}`);
                else debugLog("sloop", "schedEdit 块写无响应/超时（kernel rpc 不可用或忙）");
            } catch (e: any) {
                debugLog("sloop", `!! schedEdit 块写异常：${String(e?.message ?? e)}`);
            }
            if (!wrote) return null;
            // 拖动记录落辅助档（交接会「待确认拖动」数据源；saveData 排除本窗）
            if (newDrags.length) {
                const cur = await this.loadScheduleStore();
                await this.saveData(SCHEDULE_FILE, { ...cur, drags: [...cur.drags, ...newDrags] });
            }
            // 前端侧写者直刷同窗 Calendar（kernel 广播只覆盖 kernel 写；OnboardDialog 冻结链 review P1-4）
            window.dispatchEvent(new CustomEvent("pj-schedule-updated"));
            // 期 4：班表块属性已变→remind 链搭车推飞书事件（notify 语义不等回执）
            triggerRemindSync(this);
            debugLog("sloop", `schedEdit ${op.type} ok (${dayTarget.length} items)`);
            return await this.loadScheduleStore();
        } catch (e: any) {
            debugLog("sloop", `!! schedEdit ${op.type} failed: ${String(e?.message ?? e)}`);
            return null;
        }
    }

    /** 交接会对话框（反 push 入口=班表可见按钮）：对账单预填三态+待确认拖动+开场包复制 */
    private handoffDialog: Dialog | null = null;
    private handoffComp: any = null;

    /** dataview □6：全局速记小窗（Dialog 壳+QuickEntryDialog 正文——输入件与 □4 看板列尾同件） */
    private quickEntryDialog: Dialog | null = null;
    private quickEntryComp: any = null;

    /** 速记入口：无活跃项目=toast 早退（小窗无事可做，诚实失败不开空窗） */
    openQuickEntry(): void {
        if (this.unloaded) return; // 重载竞态窗守卫（handoffDialog 同款）
        if (!this.activeProjectId) {
            showMessage(this.i18n.quickEntryNoProject, 3000, "error");
            return;
        }
        this.quickEntryDialog?.destroy();
        const hostId = `pj-quick-${Date.now().toString(36)}`;
        const dialog: Dialog = new Dialog({
            title: this.i18n.quickEntryTitle,
            content: `<div id="${hostId}" style="padding:16px 0 8px"></div>`,
            width: "min(520px, 92vw)",
            destroyCallback: () => {
                if (this.quickEntryDialog !== dialog) return; // 迟到回调守卫（Dialog destroy 异步）
                if (this.quickEntryComp) unmount(this.quickEntryComp);
                this.quickEntryComp = null;
                this.quickEntryDialog = null;
            },
        });
        this.quickEntryDialog = dialog;
        const host = dialog.element.querySelector(`#${hostId}`);
        if (!host) return;
        this.quickEntryComp = mount(QuickEntryDialog, {
            target: host,
            props: {
                t: this.i18n as unknown as Record<string, string>,
                submit: (parsed: QuickParseResult) => this.quickEntrySubmit(parsed),
                close: () => dialog.destroy(),
            },
        });
    }

    /** 速记落盘（写通道=gui/quickAdd——「## 任务」章节尾插+属性三类去向）；成功=toast+关窗 */
    private async quickEntrySubmit(parsed: QuickParseResult): Promise<{ ok: boolean; error?: string }> {
        const pid = this.activeProjectId;
        if (!pid) return { ok: false, error: this.i18n.quickEntryNoProject };
        let r: Awaited<ReturnType<typeof quickAddTask>>;
        try {
            r = await quickAddTask(pid, parsed);
        } catch (e: any) {
            debugLog("fe", `!! quickAdd failed: ${String(e?.message ?? e)}`);
            return { ok: false, error: `${this.i18n.quickEntryFail}：${String(e?.message ?? e)}` };
        }
        // strict:false 下 !r.ok 对判别联合不收窄（AGENTS 坑：判别用分支独有键 in 检查）
        if ("error" in r) {
            const msg = r.error === "no-task-name" ? this.i18n.quickEntryNoName : `${this.i18n.quickEntryFail}：${r.error}`;
            return { ok: false, error: msg };
        }
        // R5：属性段部分失败（块已建成）——小窗随成功关闭，警示走 toast 通道：讲
        // 「任务已建、参数未完全挂上」不谎报失败（重试=重复建块；参数可稍后补设）
        const partial = (r.warnings?.length ?? 0) > 0;
        showMessage(
            (partial ? this.i18n.quickEntryPartialAttr : this.i18n.quickEntryCreated).replace("{n}", parsed.name),
            3500,
            "info",
        );
        this.quickEntryDialog?.destroy();
        return { ok: true };
    }

    /** ammo □9：弹药库悬浮窗宿主（□6 Dialog 临时宿主退役——交付形态=常驻悬浮窗）。
     *  开合记忆/几何/透明度全 localStorage；unload 收尾在 onunload */
    private ammoFloat: AmmoFloatBox | null = null;

    openHandoffDialog(): void {
        if (this.unloaded) return; // 重载竞态窗守卫（confDialog 同款）
        this.handoffDialog?.destroy();
        void this.buildHandoffUI();
    }

    private async buildHandoffUI(): Promise<void> {
        const day = getLogicalDay(new Date());
        const n = new Date();
        const p2 = (x: number) => String(x).padStart(2, "0");
        const nowHM = `${p2(n.getHours())}:${p2(n.getMinutes())}`;
        // 画像（kernel rpc behavior-get；不可用/失败=null=开场包带「画像暂缺」段）
        let profile = null;
        try {
            const res = await ((this as any).kernel?.rpc?.call?.[BEHAVIOR_GET_METHOD]?.({ day }) ?? null);
            profile = res?.profile ?? null;
        } catch {
            profile = null;
        }
        const store = await this.loadScheduleStore();
        // 期 4 块化：当日班表行=块读面（月历同源全库扫描；store 只供 drags/prefs 等辅助态）
        const boardRows = await this.loadBoardItems().catch(() => [] as SchedItem[]);
        const items = boardRows.filter((i) => i.date === day);
        const recon = buildRecon(items, profile, day, nowHM);
        const drags = store.drags.filter((d) => d.day === day);
        const onboard = await this.loadOnboardStore();
        // □23 今日随手记（时间线行上记的——独立档，kernel routine.handoff 同源同段）
        const notes = feedbackOf(normalizeFeedback(await this.readPetalJsonViaHttp(FEEDBACK_FILE).catch(() => null)), day);
        const lang = (window.siyuan as any)?.config?.appearance?.lang ?? "zh_CN";
        // □8 期 6：训练参数段（kernel routine.handoff 同源纯函数——容量/异常周/结构余量；
        // 纯展示读：缺档=null 容量照常算，读异常=不带该段）
        let training: import("./kernel/core/training").TrainingContext | null = null;
        try {
            const [tRaw, wRaw] = await Promise.all([
                this.readPetalJsonViaHttp(ROUTINE_TRAINING_FILE).catch(() => null),
                this.readPetalJsonViaHttp(ROUTINE_WEEKLY_FILE).catch(() => null),
            ]);
            training = buildTrainingContext({
                today: day,
                targetDay: shiftDay(day, 1),
                training: normalizeTraining(tRaw),
                weekly: normalizeWeekly(wRaw),
                schedItems: Object.fromEntries(boardRows.map((i) => [i.key, i])),
                fallbackDraft: onboard?.baseline?.draft ?? null,
                almOf: dayAlmanac,
            });
        } catch {
            training = null;
        }
        const packet = buildHandoffPacket(lang, { day, recon, drags, prefs: store.prefs, profile, onboard, notes, training });

        const hostId = `pj-handoff-${Date.now().toString(36)}`;
        const dialog: Dialog = new Dialog({
            title: `${this.i18n.handoffTitle} · ${day}`,
            content: `<div id="${hostId}" style="height:100%"></div>`,
            width: "min(720px, 92vw)",
            height: "min(680px, 92vh)",
            destroyCallback: () => {
                if (this.handoffDialog !== dialog) return; // 迟到回调守卫（Dialog destroy 异步）
                if (this.handoffComp) unmount(this.handoffComp);
                this.handoffComp = null;
                this.handoffDialog = null;
            },
        });
        this.handoffDialog = dialog;
        const host = dialog.element.querySelector(`#${hostId}`);
        if (!host) return;
        this.handoffComp = mount(HandoffDialog, {
            target: host,
            props: {
                t: this.i18n as unknown as Record<string, string>,
                day,
                packet,
                recon,
                drags,
                // manualui：落对账写面（kernel rpc recon-record——routine recon_record 同链）
                rpc: (this as any).kernel?.rpc ?? null,
            },
        });
    }

    // ── sloop □5 作息训练·期 3：形态库+Onboarding（前端=onboard 档唯一写者） ──

    /** onboarding 档只读（readPetalJsonViaHttp 绕缓存恒新鲜；缺档/坏档=null=未开始） */
    async loadOnboardStore(): Promise<OnboardStore | null> {
        return normalizeOnboard(await this.readPetalJsonViaHttp(ONBOARD_FILE).catch(() => null));
    }

    /** onboarding 档写盘（saveData 带本窗 app=零自重载；写后 window 事件直刷 Calendar 状态条） */
    async saveOnboardStore(store: OnboardStore): Promise<boolean> {
        try {
            await this.saveData(ONBOARD_FILE, JSON.stringify(store));
            window.dispatchEvent(new CustomEvent("pj-onboard-updated"));
            return true;
        } catch (e: any) {
            debugLog("sloop", `!! onboard save failed: ${String(e?.message ?? e)}`);
            return false;
        }
    }

    /** 开步：挑身份+口述约束 → 观察期起今天（设计档 §5） */
    async startOnboarding(archetypeId: string, constraints: OnboardConstraints): Promise<OnboardStore | null> {
        const store = startObservingCore(archetypeId, constraints, getLogicalDay(new Date()));
        if (!store) return null;
        return (await this.saveOnboardStore(store)) ? store : null;
    }

    /** 首份照镜子报告组装：观察期日集 → 画像档逐日取（缺日容忍）→ 报告+粗排+AI 包 */
    async buildOnboardReport(onboard: OnboardStore): Promise<{
        report: string;
        match: ArchMatch[];
        draft: DraftItem[];
        packet: string;
        days: string[];
        shiftMin: number;
        writeDay: string;
    } | null> {
        const arch = getArchetype(onboard.archetypeId);
        if (!arch) return null;
        const today = getLogicalDay(new Date());
        const days = onboard.state === "baselined" && onboard.baseline ? onboard.baseline.observedDays : observeDays(onboard, today);
        const archive = await this.readPetalJsonViaHttp(BEHAVIOR_PROFILE_FILE).catch(() => null);
        const profiles = days.map((d) => archive?.days?.[d]).filter((p) => p && typeof p === "object");
        const lang = (window.siyuan as any)?.config?.appearance?.lang ?? "zh_CN";
        const zh = !lang || lang.toLowerCase().startsWith("zh");
        const input = { profiles, from: days[0] ?? onboard.observeStart, to: days[days.length - 1] ?? today, archetypeId: onboard.archetypeId, constraints: onboard.constraints };
        const { report, match } = buildBaselineReport(lang, input);
        const { items: draft, shiftMin } = projectDraft(arch, zh, onboard.constraints);
        const packet = buildMirrorPacket(lang, report, input);
        return { report, match, draft, packet, days, shiftMin, writeDay: shiftDay(today, 1) };
    }

    /** 冻结基线：初版粗排写明日班表（稳定键幂等——重试/重复冻结覆盖不重复）+首份报告落档。
     *  已 baselined=直接回（双窗/重开对话框不重写；回看走 frozen 态） */
    async freezeOnboardBaseline(baseline: OnboardBaseline): Promise<{ ok: boolean; written: number }> {
        const cur = await this.loadOnboardStore();
        if (!cur) return { ok: false, written: 0 };
        const writeDay = shiftDay(getLogicalDay(new Date()), 1);
        let written = 0;
        if (cur.state !== "baselined") {
            for (let i = 0; i < baseline.draft.length; i++) {
                const d = baseline.draft[i];
                // 串行读改写（schedEdit 整档 last-writer-wins——并行=互相覆盖）；稳定键=重试幂等
                const s = await this.schedEdit({ type: "add", day: writeDay, key: `ob-${writeDay}-${i}`, item: { summary: d.summary, start: d.start, end: d.end, hard: d.hard } });
                if (s) written += 1;
            }
        }
        const ok = await this.saveOnboardStore(freezeBaseline(cur, baseline));
        return { ok, written };
    }

    /** □10 手动建项目对话框（反 push 入口=切换器菜单「新建项目…」）：轻量裸建，
     *  建骨架逻辑归 kernel MCP project create 同一 handler（rpc 单一事实源），
     *  建完走 switchToProject（setActiveProject+开主文档+驾驶舱，与 AI 建后同一条路） */
    private createProjDialog: Dialog | null = null;
    /** 双开竞态代际 token：连点两下且首次 lsNotebooks 未返回时，destroy 扑空→双窗双组件
     *  （review P1-1）；await 后复查，旧代直接弃建 */
    private createProjGen = 0;

    openCreateProjectDialog(): void {
        if (this.unloaded) return; // 重载竞态窗守卫（onboardDialog 同款）
        this.createProjDialog?.destroy();
        const gen = ++this.createProjGen;
        void this.buildCreateProjectUI(gen);
    }

    private async buildCreateProjectUI(gen: number): Promise<void> {
        if (gen !== this.createProjGen || this.unloaded) return; // 已有新一代在飞/插件已卸载
        const hostId = `pj-create-${Date.now().toString(36)}`;
        // 本代组件走闭包局部引用：destroyCallback 迟到 190ms 也必拆（官方 destroy=setTimeout，
        // review P1-2——身份守卫只管共享引用防误拆新树，拆卸自己负责）
        let comp: any = null;
        const dialog: Dialog = new Dialog({
            title: this.i18n.createProjectTitle,
            content: `<div id="${hostId}"></div>`,
            width: "min(420px, 92vw)",
            destroyCallback: () => {
                if (comp) {
                    unmount(comp);
                    comp = null;
                }
                if (this.createProjDialog !== dialog) return; // 迟到回调守卫（Dialog destroy 异步）
                this.createProjDialog = null;
            },
        });
        this.createProjDialog = dialog;
        const host = dialog.element.querySelector(`#${hostId}`);
        if (!host) return;
        comp = mount(CreateProjectDialog, {
            target: host,
            props: {
                t: this.i18n as unknown as Record<string, string>,
                submit: (name: string) => this.createProjectViaKernel(name),
                close: () => dialog.destroy(),
            },
        });
    }

    /** rpc 建项目；成功=切换到新项目（顶栏新名直传绕 SQL 索引窗），失败=错误文案回对话框行内显示 */
    private async createProjectViaKernel(name: string): Promise<{ ok: boolean; id?: string; error?: string }> {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.call?.[PROJECT_CREATE_METHOD]) {
            return { ok: false, error: this.i18n.createProjectNoKernel };
        }
        try {
            const res = await rpc.call[PROJECT_CREATE_METHOD]({ name });
            if (res?.success && res.data?.id) {
                const id = String(res.data.id);
                await this.switchToProject(id);
                // 撞 restoring 旗时 onOpenScene 静默早退（活跃仍旧项目）——override 前验切到位，防顶栏新名错位（review P2-3）
                if (this.activeProjectId === id) this.updateSwitcherLabel(name);
                return { ok: true, id };
            }
            return { ok: false, error: res?.error ? String(res.error) : this.i18n.createProjectFail };
        } catch (e: any) {
            debugLog("fe", `!! project-create rpc failed: ${String(e)}`);
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** rpc 删项目（驾驶舱危险态钮）；成功且删的是活跃项目=清活跃指针（内存+petal 档）+顶栏回占位符。
     *  指针清理由前端做（defaults 记录）：kernel 侧写 petal 触发 dataChanges→前端插件整重载；
     *  前端 saveData 恒带 app 排除本窗，且活跃内存态/顶栏标签本就归前端管 */
    private async deleteProjectViaKernel(projectId: string): Promise<{ ok: boolean; totalDocs?: number; error?: string }> {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.call?.[PROJECT_DELETE_METHOD]) {
            return { ok: false, error: this.i18n.createProjectNoKernel };
        }
        try {
            const res = await rpc.call[PROJECT_DELETE_METHOD]({ projectId });
            if (res?.success) {
                if (this.activeProjectId === projectId) {
                    this.activeProjectId = null;
                    try {
                        await this.saveData(ACTIVE_PROJECT_KEY, { projectId: "", at: Date.now() });
                    } catch (e: any) {
                        // 撞插件重载 dispose 窗 reject——putFile 通道兜底（setActiveProject 同款）
                        debugLog("open", `!! saveData active-project clear rejected (${String(e?.message ?? e)}), putFile fallback`);
                        void this.putFileJson(`/data/storage/petal/${this.name}/${ACTIVE_PROJECT_KEY}`, { projectId: "", at: Date.now() });
                    }
                    void this.updateSwitcherLabel(); // 无活跃项目=顶栏回占位符
                }
                return { ok: true, totalDocs: Number(res?.data?.totalDocs ?? 1) };
            }
            return { ok: false, error: res?.error ? String(res.error) : this.i18n.deleteProjectFail };
        } catch (e: any) {
            debugLog("fe", `!! project-delete rpc failed: ${String(e)}`);
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** rpc 收拢已完成（03 收拢件；驾驶舱头部钮）——kernel sweepProjectDone 编排：
     *  顶层 done 任务（子树全 done）moveBlock 保 id 收进项目内「归档」区。写笔记文档非 petal，
     *  无 dataChanges 重载面；结果盘点由驾驶舱 toast 出示 */
    private async sweepDoneViaKernel(projectId: string): Promise<{ ok: boolean; swept?: number; skipped?: Array<{ id: string; name: string }>; error?: string }> {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.call?.[LINE_SWEEP_METHOD]) {
            return { ok: false, error: this.i18n.sweepDoneNoKernel };
        }
        try {
            return await rpc.call[LINE_SWEEP_METHOD]({ projectId });
        } catch (e: any) {
            debugLog("fe", `!! line-sweep rpc failed: ${String(e)}`);
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** Onboarding 对话框（反 push 入口=Calendar 可见按钮/状态条） */
    private onboardDialog: Dialog | null = null;
    private onboardComp: any = null;

    openOnboardDialog(): void {
        if (this.unloaded) return; // 重载竞态窗守卫（handoffDialog 同款）
        this.onboardDialog?.destroy();
        void this.buildOnboardUI();
    }

    private async buildOnboardUI(): Promise<void> {
        const onboard = await this.loadOnboardStore();
        const lang = (window.siyuan as any)?.config?.appearance?.lang ?? "zh_CN";
        const hostId = `pj-onboard-${Date.now().toString(36)}`;
        const dialog: Dialog = new Dialog({
            title: this.i18n.onboardTitle,
            content: `<div id="${hostId}" style="max-height:100%"></div>`,
            width: "min(720px, 92vw)",
            // 高度不传=auto（vision P1：固定 680px 在挑身份/约束步留 ~215px 死空间）；
            // 长内容滚动由 .pj-ob max-height + pre max-height 承担
            destroyCallback: () => {
                if (this.onboardDialog !== dialog) return; // 迟到回调守卫（Dialog destroy 异步）
                if (this.onboardComp) unmount(this.onboardComp);
                this.onboardComp = null;
                this.onboardDialog = null;
            },
        });
        this.onboardDialog = dialog;
        const host = dialog.element.querySelector(`#${hostId}`);
        if (!host) return;
        this.onboardComp = mount(OnboardDialog, {
            target: host,
            props: {
                t: this.i18n as unknown as Record<string, string>,
                lang,
                onboard,
                today: getLogicalDay(new Date()),
                startOnboarding: (archetypeId: string, constraints: OnboardConstraints) => this.startOnboarding(archetypeId, constraints),
                buildReport: async () => {
                    const cur = await this.loadOnboardStore(); // 重读：对话框内可能刚挑完身份（闭包初档已旧）
                    return cur ? await this.buildOnboardReport(cur) : null;
                },
                freeze: (baseline: OnboardBaseline) => this.freezeOnboardBaseline(baseline),
            },
        });
    }

    /** 日历目录（设置页勾选清单数据源；meta 由 kernel 轮询写——读 meta 恒新鲜通道） */
    async loadMirrorCatalog(): Promise<{ catalog: Array<{ id: string; summary: string; description: string; type: string }> | null; checked: Record<string, boolean> | null }> {
        const meta = await this.readPetalJsonViaHttp(CALENDAR_MIRROR_META_FILE).catch(() => null);
        const conf = await this.readPetalJsonViaHttp(CALENDAR_MIRROR_CONF_FILE).catch(() => null);
        return { catalog: Array.isArray(meta?.catalog) ? meta.catalog : null, checked: conf?.checked ?? null };
    }

    /** 勾选清单落盘（saveData 官方带 app=本窗免重载；写后即时拉一轮让镜像跟上勾选） */
    async saveMirrorConf(checked: Record<string, boolean>): Promise<boolean> {
        try {
            await this.saveData(CALENDAR_MIRROR_CONF_FILE, JSON.stringify({ checked }));
            this.notifyMirrorPoll();
            return true;
        } catch (e) {
            debugLog("cal", `!! mirror-conf save failed: ${String(e)}`);
            return false;
        }
    }

    /** 按钮化 b/d：kernel 状态广播到达——window 事件直刷面板+授权坏通知（同因当天一次防小时轮刷屏） */
    private onCalendarStatus(status: CalendarStatus): void {
        window.dispatchEvent(new CustomEvent(CALENDAR_STATUS_EVENT, { detail: status }));
        void this.remindInjector.refreshSyncState(); // tb2 H2：每轮同步完重拉账本刷块面徽标
        if (status?.authErrorCode === undefined) return;
        const day = getLogicalDay(new Date());
        try {
            const rec = JSON.parse(localStorage.getItem(AUTH_NOTIFY_KEY) || "null");
            if (rec?.code === status.authErrorCode && rec?.day === day) return; // 同因当天已提醒过
            localStorage.setItem(AUTH_NOTIFY_KEY, JSON.stringify({ code: status.authErrorCode, day }));
        } catch {
            // localStorage 不可用=退化为每轮都提醒（可接受）
        }
        showMessage(this.i18n.calAuthFailNotice, 7000, "error");
        debugLog("cal", `!! auth broken code=${status.authErrorCode}, notified`);
    }

    /** 按钮化 c：一键重授权 B 档——临时回调服务自动收 code→rpc calendar-auth 换证。
     *  manual=true 表示自动通道不可用（浏览器版/端口占/弹窗被拦），调用方提示走设置面板手动贴 code */
    async startReauth(): Promise<{ ok: boolean; error?: string; manual?: boolean }> {
        const appId = await this.loadFeishuAppId();
        if (!appId) return { ok: false, error: this.i18n.calReauthNoConfig };
        const r = await runOAuthFlow({
            appId,
            onCode: (code) => this.applyReauthCode(code),
        });
        debugLog("cal", `reauth flow stage=${r.stage} ok=${r.ok} err=${r.error ?? "-"}`);
        if (r.stage === "unsupported" || r.stage === "open") return { ...r, manual: true };
        return r;
    }

    /** 按钮化 c A 档：手动贴 code（Conf 输入框）与 B 档回调共用的换证通道 */
    async applyReauthCode(code: string): Promise<{ ok: boolean; error?: string }> {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.call?.[CALENDAR_AUTH_METHOD]) {
            debugLog("cal", "reauth rpc FAIL: kernel.rpc unavailable");
            return { ok: false, error: this.i18n.calReauthNoKernel };
        }
        try {
            const res = await rpc.call[CALENDAR_AUTH_METHOD]({ code });
            debugLog("cal", `reauth rpc result ok=${Boolean(res?.ok)} err=${res?.error ?? "-"}`);
            return { ok: Boolean(res?.ok), error: res?.error };
        } catch (e: any) {
            debugLog("cal", `reauth rpc THREW ${String(e?.message ?? e)}`);
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** 现有配置的 appId（重授权场景配置已在，只缺好 token） */
    private async loadFeishuAppId(): Promise<string | null> {
        try {
            const raw = await this.loadData("feishu-config.json");
            const cfg = typeof raw === "string" ? JSON.parse(raw || "null") : raw;
            return cfg?.appId ?? null;
        } catch {
            return null;
        }
    }

    // ── 首配纯 UI（calauth □2）：表单一键授权+手动贴码+清除配置 ──

    /** 表单一键授权 B 档：攒齐 appId/secret 才起流程，code 到手一次 rpc 落盘（中途零 petal 写） */
    async startSetup(appId: string, appSecret: string): Promise<{ ok: boolean; error?: string; manual?: boolean }> {
        if (!appId.trim() || !appSecret.trim()) return { ok: false, error: this.i18n.calSetupMissingCreds };
        const r = await runOAuthFlow({
            appId,
            onCode: (code) => this.applySetupCode(appId, appSecret, code),
        });
        debugLog("cal", `setup flow stage=${r.stage} ok=${r.ok} err=${r.error ?? "-"}`);
        if (r.stage === "unsupported" || r.stage === "open") return { ...r, manual: true };
        return r;
    }

    /** 表单 A 档：手动贴 code（浏览器版/端口占）与 B 档回调共用的落盘通道 */
    async applySetupCode(appId: string, appSecret: string, code: string): Promise<{ ok: boolean; error?: string }> {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.call?.[CALENDAR_SETUP_METHOD]) return { ok: false, error: this.i18n.calReauthNoKernel };
        try {
            const res = await rpc.call[CALENDAR_SETUP_METHOD]({ appId, appSecret, code });
            return { ok: Boolean(res?.ok), error: res?.error };
        } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** 清除配置：kernel 删整份 feishu-config.json+凭证留档（回执带回 creds 供表单就地预填） */
    async clearFeishu(): Promise<{ ok: boolean; error?: string; creds?: { appId: string; appSecret: string } }> {
        const rpc = (this as any).kernel?.rpc;
        if (!rpc?.call?.[CALENDAR_CLEAR_METHOD]) return { ok: false, error: this.i18n.calReauthNoKernel };
        try {
            const res = await rpc.call[CALENDAR_CLEAR_METHOD]({});
            return { ok: Boolean(res?.ok), error: res?.error, ...(res?.creds ? { creds: res.creds } : {}) };
        } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
        }
    }

    /** 凭证档案（清除后表单预填；无档案=null）——同样走 getFile 直读（清后即读须新鲜） */
    async loadFeishuCreds(): Promise<{ appId: string; appSecret: string } | null> {
        const rec = await this.readPetalJsonViaHttp("feishu-creds-archive.json");
        return rec?.appId ? { appId: String(rec.appId), appSecret: String(rec.appSecret ?? "") } : null;
    }

    /** 切换后刷新顶栏项目名（SQL 查名；无活跃项目=占位符，失败/零行保旧标签不动）。
     *  nameOverride：建/改名回执直传新名——SQL content 有索引窗，回查会闪旧名或占位符
     *  （□10 实锤：新建项目回查零行→占位符竞态覆盖 override 直传的新名） */
    private async updateSwitcherLabel(nameOverride?: string): Promise<void> {
        if (!this.switcherButton) return;
        if (nameOverride !== undefined) {
            renderSwitcherLabel(this.switcherButton, nameOverride);
            return;
        }
        let name: string | null = null;
        if (this.activeProjectId) {
            try {
                const rows = await feQuery<{ content: string }>(projectDocSql(this.activeProjectId));
                if (!rows[0]) return; // 零行=索引窗或已删，保持现标签（勿打回占位符）
                name = rows[0].content;
            } catch {
                // 查名失败=保持旧标签
                return;
            }
        }
        renderSwitcherLabel(this.switcherButton, name);
    }

    /** 收到 open 指令：先存旧项目现场（若有且≠目标）→恢复目标→更新活跃记录。
     *  closeExisting（按钮化 a 恢复语义 B）：先关本项目域页签再开快照页签（丢弃当前未存现场）。
     *  opts.forceDashboard（增补批二任务一）：显式菜单点击路径总弹驾驶舱（压过 dismissed 旗）；
     *  rpc/恢复链等既有调用不传=旗照拦，行为不变 */
    private async onOpenScene(payload: OpenScenePayload, opts?: { forceDashboard?: boolean }): Promise<void> {
        const { projectId, scene, fallbackDocId, closeExisting } = payload ?? {};
        if (!projectId) return;
        if (this.restoring) {
            debugLog("open", `!! restore in progress, ignored open=${projectId}`);
            return;
        }
        debugLog("open", `projectId=${projectId} sceneTabs=${scene?.tabs?.length ?? "null"} closeExisting=${closeExisting ? 1 : 0}`);
        this.restoring = true;
        try {
            if (this.activeProjectId && this.activeProjectId !== projectId) {
                await this.captureAndSave();
            }
            if (closeExisting) this.closeProjectTabs();
            if (scene && Array.isArray(scene.tabs) && scene.tabs.length > 0) {
                const steps = replayPlan(scene);
                const idx = scene.activeDocId
                    ? steps.findIndex((s) => s.docId === scene.activeDocId)
                    : -1;
                const res = await replaySteps(this.app, steps, idx === -1 ? undefined : idx);
                debugLog("open", `replayed docs=${res.opened} focus=${res.focusDocId ?? "-"} block=${res.focusBlockId ?? "-"}`);
                this.projectDocIds = new Set(steps.map((s) => s.docId));
            } else {
                await replaySteps(this.app, [{ docId: fallbackDocId }]);
                this.projectDocIds = new Set([fallbackDocId]);
                debugLog("open", `no scene, opened fallback=${fallbackDocId}`);
            }
            this.setActiveProject(projectId);
            this.updateSwitcherLabel();
            // 驾驶舱原地刷新（页签常驻同 id，切项目不重建组件）
            window.dispatchEvent(new CustomEvent(PROJECT_SWITCHED_EVENT, { detail: { projectId } }));
            // 任务一：菜单显式点击压过 dismissed 旗（其余通道旗照拦）
            if (opts?.forceDashboard || !this.dashboardDismissed) this.openDashboard();
        } catch (e: any) {
            debugLog("open", `!! restore failed: ${String(e)}`);
        } finally {
            this.restoring = false;
        }
    }

    /** 按钮化 a 恢复语义 B：关本项目域页签（域外页签不动；驾驶舱页签 model 无 editor 天然豁免） */
    private closeProjectTabs(): void {
        if (!this.projectDocIds) return;
        let closed = 0;
        for (const tab of getAllTabs() as any[]) {
            const docId = tab?.model?.editor?.protyle?.block?.rootID;
            if (docId && this.projectDocIds.has(docId)) {
                try {
                    tab.close();
                    closed++;
                } catch {
                    // 单个关失败不阻断恢复（openTab 兜底重开）
                }
            }
        }
        debugLog("open", `closeExisting tabs=${closed}`);
    }

    /** 按钮化 a：恢复现场按钮——读当前项目快照复用 onOpenScene 链（同项目不触发存旧；关域内页签回快照态） */
    private async restoreCurrentScene(): Promise<void> {
        if (!this.activeProjectId) return;
        const scene = await this.loadSceneSnapshot(this.activeProjectId);
        await this.onOpenScene({
            projectId: this.activeProjectId,
            scene: scene ?? undefined,
            fallbackDocId: this.activeProjectId,
            closeExisting: true,
        });
    }

    /** 捕获当前页签集→存活跃项目快照；无活跃项目=no-op */
    private async captureAndSave(): Promise<void> {
        if (!this.activeProjectId) {
            debugLog("cap", "no active project, skip");
            return;
        }
        const snapshot = this.captureCurrent();
        if (!snapshot) return;
        try {
            await this.saveData(sceneKey(this.activeProjectId), snapshot);
            debugLog("cap", `saved ${snapshot.tabs.length} tabs → ${sceneKey(this.activeProjectId)}`);
        } catch (e: any) {
            debugLog("cap", `!! save failed: ${String(e)}`);
        }
    }

    /** 页签集→快照（纯数据收集，捕获语义在 core/scene.captureScene；域过滤防互串） */
    private captureCurrent(): SceneSnapshot | null {
        try {
            const tabs = getAllTabs() as any[];
            // 3.8.3 实测：页签头=li.item（激活分屏内聚焦那个带 .item--focus，无 layout-tab-item 类）；
            // P1 的 .layout-tab-item--focus 与 --item.item--focus 两版选择器都恒空
            const activeTabId = document
                .querySelector(".layout__wnd--active .layout-tab-bar .item--focus")
                ?.getAttribute("data-id") ?? undefined;
            const editor = (() => {
                try {
                    // getActiveEditor() 返回 Protyle 实例：block 挂在 .protyle（IProtyle）下，
                    // 直读 p.block 恒 undefined（09-15 □12 实锤：快照 blockId 从未捕获成功，
                    // 块级恢复定位一直是死链）。协议层防双形态：protyle.block 优先。
                    const p: any = getActiveEditor();
                    const b = p?.protyle?.block ?? p?.block;
                    if (!b) return null;
                    // block.id 是「打开页签时携带的块 id」，完整文档渲染后内核复位为 rootID
                    // （思源 onGet:404）——不是当前光标块。真光标块从 selection 上爬最近
                    // [data-node-id]（closest 自光标向上=真块，无面包屑全局首查陷阱）。
                    const anchor = window.getSelection()?.rangeCount
                        ? (window.getSelection()!.getRangeAt(0).startContainer as Node)
                        : null;
                    const anchorEl = anchor instanceof Element ? anchor : anchor?.parentElement;
                    const cursorEl = anchorEl?.closest?.("[data-node-id]") as HTMLElement | null;
                    // 校验块真在本编辑器内（selection 可能在浮窗/其他分屏）
                    const inThisEditor = cursorEl && p?.protyle?.element?.contains?.(cursorEl);
                    const cursorBlockId = inThisEditor ? cursorEl.getAttribute("data-node-id") : undefined;
                    return { rootId: b.rootID as string, blockId: cursorBlockId };
                } catch {
                    return null;
                }
            })();
            const rawTabs = tabs.map((t) => ({
                id: t?.id as string,
                // 官方 Editor model 形态：tab.model.editor.protyle（model 本体≠Protyle，差一层 .editor）
                docId: t?.model?.editor?.protyle?.block?.rootID as string | undefined,
                title: t?.title as string | undefined,
                // 光标块只对活动编辑器页签有意义（rootId 匹配才挂）
                blockId:
                    editor && t?.model?.editor?.protyle?.block?.rootID === editor.rootId ? editor.blockId : undefined,
            }));
            // 域过滤：只收本项目页签域（未恢复过=首次全收）；域外页签（用户手开的无关文档/其他项目残留）不进快照
            const scoped = this.projectDocIds ? rawTabs.filter((t) => t.docId && this.projectDocIds!.has(t.docId)) : rawTabs;
            const snap = captureScene(this.activeProjectId!, scoped, {
                tabId: activeTabId,
                // 活动编辑器直供聚焦文档（authoritative，不受 DOM 类名/多分屏干扰）
                docId: editor?.rootId,
            });
            debugLog("cap", `tabs=${tabs.length} scoped=${scoped.length} editors=${rawTabs.filter((t) => t.docId).length} active=${snap.activeDocId ?? activeTabId ?? "-"}`);
            return snap;
        } catch (e: any) {
            debugLog("cap", `!! capture failed: ${String(e)}`);
            return null;
        }
    }

    private async setActiveProject(projectId: string): Promise<void> {
        // 同项目重开不写盘：at 时间戳每写必变=内容防抖失效，每次 MCP open 都白白
        // 触发一轮 dataChanges 插件重载（at 无消费方，仅 projectId 在 onload 恢复时读）
        if (this.activeProjectId === projectId) return;
        this.activeProjectId = projectId;
        const rec: ActiveProjectRecord = { projectId, at: Date.now() };
        try {
            await this.saveData(ACTIVE_PROJECT_KEY, rec);
        } catch (e: any) {
            // saveData 撞插件重载 dispose 窗会 reject（09-14 三轮 MCP open 记录蒸发实锤）——
            // putFile 通道兜底落盘，别让下次启动恢复到过期项目
            debugLog("open", `!! saveData active-project rejected (${String(e?.message ?? e)}), putFile fallback`);
            void this.putFileJson(`/data/storage/petal/${this.name}/${ACTIVE_PROJECT_KEY}`, rec);
        }
    }

    onunload(): void {
        debugLog("fe", "frontend unload");
        this.unloaded = true; // 重载竞态窗守卫（openSetting 早退）
        this.ammoFloat?.unload(); // ammo □9：悬浮窗壳/正文组件拆线（外壳挂 body 不随插件容器拆）
        if (this.hourlyTimer) {
            clearInterval(this.hourlyTimer);
            this.hourlyTimer = null;
        }
        this.confDialog?.destroy(); // 设置 Dialog 开着时插件卸载——同步拆壳防僵尸
        // Dialog 挂 document.body 不随插件容器拆——重载窗内壳在 effect 死=孤儿僵尸窗（review P1-3）
        this.createProjDialog?.destroy();
        this.onboardDialog?.destroy();
        this.handoffDialog?.destroy();
        this.quickEntryDialog?.destroy(); // dataview □6：速记小窗同款拆壳防僵尸
        this.remindInjector.destroy();
        this.taskBadgeInjector.destroy(); // dataview □7：徽标注入器拆观察器
        this.schedNotifier.destroy(); // sloop □7：班表到点提醒引擎拆线（Dialog/interval）
        stayTracker.dispose(); // sloop □3：插件重载不是页面卸载（beforeunload 不触发）——段结算+末次推送
        // P1 尾巴⑤：退出/重载时存最后现场——saveData 在 dispose 后 reject 410，
        // 改走 putFile 直写 petal 落盘（与 saveData 字面同目录）。退出竞态下尽力而为。
        this.captureAndSaveViaPutFile();
        for (const fn of this.unbindFns) {
            try {
                fn();
            } catch { /* 静默 */ }
        }
        this.unbindFns = [];
    }

    /** 本窗口 ws 的 app id——petal 写广播排除自身用（与官方 saveData 的 app 表单字段同义：
     *  内核 BroadcastByTypeAndExcludeApp 按 ws ?app= 分组键排除；读不到时空串=不排除）。
     *  □7：裸 putFile 缺此字段=本窗写 petal 也被广播重载自己——onunload 存现场→重载→
     *  现场又变→再存的 13s 级自持风暴环（Loki unload/onload 成对连发实锤，09-15 dev 复现） */
    private wsAppId(): string {
        try {
            const url = (window.siyuan as any)?.ws?.ws?.url as string | undefined;
            return url?.match(/[?&]app=([^&]+)/)?.[1] ?? "";
        } catch {
            return "";
        }
    }

    /** onunload 专用：saveData 已失效时的落盘通道（fire-and-forget，不 await）。
     *  端点=/api/file/putFile（内核唯一注册的 putFile 路由；filetree 前缀必 404——
     *  review P1-1 实锤，且 fetch 对 404 是 resolve，必须显式查 r.ok 才不算假成功）。
     *  ⚠️防抖：页签集与现快照实质相同（仅 capturedAt 新）则跳过——petal 每次写都触发
     *  内核 dataChanges→插件重载→又 unload 写=自持重载风暴环（09-14 e2e 实锤+putFile 触发对照实验） */
    private captureAndSaveViaPutFile(): void {
        if (!this.activeProjectId) return;
        try {
            const snapshot = this.captureCurrent();
            if (!snapshot) return;
            // 空场景不落盘：tabs=[]（页面只剩无 docId 的页签——驾驶舱/僵尸页签）时写盘
            // 无恢复价值，却是 dataChanges 写者——多页面互踩时可持续供燃重载环
            // （09-14 风暴现场：Chrome 调试页签以空场景每秒写盘 50 分钟）
            if (snapshot.tabs.length === 0) return;
            const path = `/data/storage/petal/${this.name}/${sceneKey(this.activeProjectId)}`;
            const headers = { Authorization: `Token ${window.siyuan.config.api.token}` };
            void this.readJsonViaGetFile(path).then(
                (prev) => {
                    if (sceneEquals(prev, snapshot)) {
                        debugLog("cap", "unload-skip: scene unchanged (dataChanges 风暴防抖)");
                        return;
                    }
                    const fd = new FormData();
                    fd.append("path", path);
                    fd.append("isDir", "false");
                    fd.append("modTime", String(Date.now()));
                    // □7：排除本窗（官方 saveData 同义字段）——防 onunload 写→广播重载自己→环
                    fd.append("app", this.wsAppId());
                    fd.append("file", new Blob([JSON.stringify(snapshot)], { type: "application/json" }), "scene.json");
                    return fetch("/api/file/putFile", { method: "POST", headers, body: fd }).then(
                        async (r) => {
                            // putFile 恒回 HTTP 200（defer c.JSON(StatusOK)），成败只看 body code
                            const bodyHead = (await r.text()).slice(0, 120);
                            if (r.ok && bodyHead.includes('"code":0')) {
                                debugLog("cap", `unload-saved ${snapshot.tabs.length} tabs via putFile`);
                            } else {
                                debugLog("cap", `!! unload putFile status=${r.status} body=${bodyHead}`);
                            }
                        },
                        (e) => debugLog("cap", `!! unload putFile failed: ${String(e)}`),
                    );
                },
                (e) => debugLog("cap", `!! unload readFile failed: ${String(e)}`),
            );
        } catch (e: any) {
            debugLog("cap", `!! unload capture failed: ${String(e)}`);
        }
    }

    /** petal JSON 直写通道（FormData putFile）：saveData 在插件重载竞态下 reject 410
     *  （dispose 窗内调用即丢——09-14 三轮 MCP open 的活跃项目记录全因此蒸发，petal
     *  停在 17:18 旧值），putFile 无 dispose 生命周期，兜底可用。
     *  端点=/api/file/putFile（内核唯一注册路由；filetree 前缀必 404——review P1-1
     *  实锤，fetch 对 404 是 resolve，必须显式查 r.ok）；putFile 恒回 HTTP 200，成败
     *  只看 body code。⚠️modTime 须毫秒——传秒会把文件 mtime 钉到 1970（实锤）。 */
    private async putFileJson(path: string, value: unknown): Promise<boolean> {
        try {
            const fd = new FormData();
            fd.append("path", path);
            fd.append("isDir", "false");
            fd.append("modTime", String(Date.now()));
            fd.append("app", this.wsAppId()); // □7：排除本窗防自重载（同 captureAndSaveViaPutFile）
            fd.append("file", new Blob([JSON.stringify(value)], { type: "application/json" }), "data.json");
            const r = await fetch("/api/file/putFile", {
                method: "POST",
                headers: { Authorization: `Token ${window.siyuan.config.api.token}` },
                body: fd,
            });
            const bodyHead = (await r.text()).slice(0, 120);
            return r.ok && bodyHead.includes('"code":0');
        } catch (e: any) {
            debugLog("fe", `!! putFileJson ${path} failed: ${String(e?.message ?? e)}`);
            return false;
        }
    }

    /** onunload 读兜底（loadData 已随 dispose 失效）：getFile 成功=body 即文件内容本体 */
    private async readJsonViaGetFile(path: string): Promise<SceneSnapshot | null> {
        try {
            const r = await fetch("/api/file/getFile", {
                method: "POST",
                headers: { Authorization: `Token ${window.siyuan.config.api.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ path }),
            });
            if (!r.ok) return null;
            const text = await r.text();
            return text ? JSON.parse(text) : null;
        } catch {
            return null;
        }
    }
}
