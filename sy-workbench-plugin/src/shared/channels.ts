// 前后端共享常量（零依赖纯模块，kernel bundle 与前端 bundle 各自打包同一份源）。
// kernel 侧 import 前端纯模块的纪律：只允许零依赖常量/纯函数（mcp.md「前端模块 import 纪律」）。

/** kernel→前端：恢复现场（payload=OpenScenePayload） */
export const SCENE_CHANNEL = "sy-project/open-scene";

/** kernel→前端：指令捕获当前现场（无参数）。
 *  ⚠️ 当前 kernel 侧无广播方（project 工具只广播 SCENE_CHANNEL）——前端监听是预留位，
 *  留给未来「定时自动捕获」策略挂接（review 2026-09-10 注）。 */
export const CAPTURE_CHANNEL = "sy-project/capture-scene";

/** 现场快照存储键：siyuan.storage（kernel）与 saveData（前端）同目录共读写 */
export function sceneKey(projectId: string): string {
    return `scene-${projectId}.json`;
}

/** 日历账本存储键（kernel 同步链写 / Conf 日历区只读——前端勿写此文件） */
export const LEDGER_FILE = "calendar-ledger.json";

/** 日历同步状态存储键（kernel 每轮写 calendar-status.json / 前端驾驶舱+Conf 只读）。
 *  形态=CalendarStatus（core/calendarStatus.ts）；跳过原因存 reason code，i18n 归前端 */
export const CALENDAR_STATUS_FILE = "calendar-status.json";

/** kernel→前端：日历同步状态刷新（payload=CalendarStatus）——每轮同步完+授权失败时广播，
 *  前端驾驶舱日历区直刷（读文件是兜底通道，广播=实时通道） */
export const CALENDAR_STATUS_CHANNEL = "sy-project/calendar-status";

/** kernel→前端：主文档「## 动作」段被外部改写（MCP set_actions）——驾驶舱动作区直刷
 *  （payload=ActionsUpdatedPayload；记进度走前端本地刷新不经此通道） */
export const ACTIONS_UPDATED_CHANNEL = "sy-project/actions-updated";

export interface ActionsUpdatedPayload {
    projectId: string;
    /** 写入后的动作清单（前端即时重渲免 SQL 写后立读窗；块 id 由延迟重查补齐） */
    actions?: Array<{ label: string; command: string }>;
}

/** 前端→kernel：一键重授权换证（params={code, redirectUri?}→{ok, error?, probe?}）。
 *  kernel 侧 siyuan.rpc.bind 同名方法（exchangeCode→落盘→runProbe 只报告） */
export const CALENDAR_AUTH_METHOD = "calendar-auth";

/** 前端→kernel：首配表单一键落盘（calauth □2；params={appId, appSecret, code, redirectUri?}
 *  →{ok, error?, probe?}）。攒齐才写：先 runOAuthFlow 收 code 再调，中途零 petal 写 */
export const CALENDAR_SETUP_METHOD = "calendar-setup";

/** 前端→kernel：清除飞书配置（calauth □2；无参数→{ok, error?}）。
 *  删整份 feishu-config.json+凭证留档（feishu-creds-archive.json 供表单预填） */
export const CALENDAR_CLEAR_METHOD = "calendar-clear";

/** oauth 回调地址（前后端共用唯一事实源）：须与飞书开放平台「安全设置」登记一致；
 *  前端 B 档起临时 http server 监同端口自动收 code（MCP oauth_start 默认值同源） */
export const OAUTH_REDIRECT_URI = "http://localhost:19876/callback";

/** 飞书自建应用图文教程（外置运营文档；bear 09-14 拍板=私有不公开阶段，链接分享已 closed；
 *  settingsnav 向导头部「看图文教程」。公开时改分享权限即可，URL 不变） */
export const FEISHU_TUTORIAL_URL = "https://my.feishu.cn/docx/WXbFdaTCVoSNoAx5EZQcchXpnPg";

/** 当前活跃项目记录（前端写入，open 时 kernel 不读、恢复链前端自用） */
export const ACTIVE_PROJECT_KEY = "active-project.json";

/** 前端→kernel：触发块提醒飞书同步（remind □1）。前端写完 custom-remind-at 即
 *  `kernel.rpc.notify["remind-sync"]()`——onrunning 每日兜底之外的事件驱动通道
 *  （防「思源常开不重启错过当天新设提醒」）。kernel 侧 siyuan.rpc.bind 同名方法。 */
export const REMIND_SYNC_METHOD = "remind-sync";

// ── □17 飞书日历回流读链（期2）──

/** 事件镜像存储键（kernel 轮询写 / 前端日历面板经 readPetalJsonViaHttp 只读——前端勿写）。
 *  自愈缓存非账本：键=calendar_id/event_id，删坏可全量重建（evicted 清场守卫例外——随档
 *  丢失，重建轮把 sched 账本条目全部注入=未知不判删，□25 P0-1），真相源在飞书侧。 */
export const CALENDAR_MIRROR_FILE = "calendar-mirror.json";

/** 轮询元数据存储键（kernel 写：日历目录 catalog+每历 sync_token 游标；内容防抖——
 *  目录与 token 都没变不落盘，时间戳不进内容〔广播承载纪律〕） */
export const CALENDAR_MIRROR_META_FILE = "calendar-mirror-meta.json";

/** 回流设置存储键（前端设置页写勾选清单 {checked:{calendarId:boolean}} / kernel 轮询读；
 *  缺文件/null=默认规则：全勾但「节假日」类系统日历不勾，防与 □16 本地历法层双显） */
export const CALENDAR_MIRROR_CONF_FILE = "calendar-mirror-conf.json";

/** 前端→kernel：触发镜像轮询（onrunning 启动兜底之外的事件驱动通道：前端 hourlyTimer
 *  搭 remind-sync 同刻 notify、设置页改勾选清单后即时拉一轮）。 */
export const CALENDAR_MIRROR_POLL_METHOD = "calendar-mirror-poll";

/** □18 自动天气配置存储键（前端设置页写 {enabled, city:{name,lat,lon}} / kernel 每日任务读；
 *  城市→坐标在保存时前端 geocoding 解析，kernel 只按坐标查（免每日解析歧义）） */
export const WEATHER_CONFIG_FILE = "weather-config.json";

/** 前端→kernel：触发天气任务（hourlyTimer 搭车+设置保存后即时跑一轮） */
export const WEATHER_SYNC_METHOD = "weather-sync";

/** 前端→kernel：拉可见窗日程实例（params={startTs,endTs} 秒；→{rows}|{ok:false,error}）。
 *  循环系列按需展开（list 只回主事件定义，instance_view 才有实例；窗须 <40 天，
 *  kernel 内部分块）；kernel 内存缓存 1h TTL——纯读无 petal 写，零重载副作用。 */
export const CALENDAR_INSTANCES_METHOD = "calendar-instances";

/** kernel→前端：外部通道写入了提醒属性（□3 飞书回写 / MCP reminder.set·delete）——
 *  前端 remindInjector.refreshBlock 直刷图标文案（setBlockAttrs 不广播，open 编辑器不刷就停在旧值） */
export const REMIND_WRITTEN_CHANNEL = "sy-project/remind-written";

export interface RemindWrittenPayload {
    blockId: string;
    /** null=属性已清（delete） */
    at: string | null;
    repeat: string | null;
    /** □16 结束时间：null=开放时长/已清 */
    end?: string | null;
}

// ── sloop □3 作息训练·期 1：数据源采集层（静默收据）──

/** 行为画像存储键（kernel 独家写：{days:{"YYYY-MM-DD":DayProfile}} 滚动窗+每日剪枝；
 *  当日进行稿只驻 kernel 内存，日终冻结才落盘——petal 写频率=天级，零重载风暴） */
export const BEHAVIOR_PROFILE_FILE = "behavior-profile.json";

/** 前端→kernel：推送文档停留收据（sloop □3 数据源③；params={day, entries:[{id,title,seconds,sessions}]}
 *  全量快照幂等覆盖；结算时+hourlyTimer 搭车+onload 恢复后推当日与昨日档） */
export const BEHAVIOR_STAY_METHOD = "behavior-stay";

/** 前端→kernel：触发一轮采集（onrunning 启动兜底之外的事件驱动通道：hourlyTimer 搭车；
 *  六路 kernel 自采源全量重建当日画像+日终冻结检查） */
export const BEHAVIOR_COLLECT_METHOD = "behavior-collect";

/** 前端/脚本→kernel：读画像（params={day?} 缺省=当日；内存优先盘兜底；e2e/交接会数据面） */
export const BEHAVIOR_GET_METHOD = "behavior-get";

// ── sloop □4 作息训练·期 2：交接会 MVP（本地班表+对账+拖动确认）──

/** 班表存储键（双写者：前端 saveData（拖动/增删，恒带 app 排除本窗）+ kernel storagePutJson
 *  （晨间滚动/MCP routine 工具面；写频=事件级罕见，重载代价可接受——calendar 账本同款先例）。
 *  形态=SchedStore（core/schedule.ts）；写入两侧均整档读改写，竞态窗=拖动与 AI 写同刻（不并存） */
export const SCHEDULE_FILE = "schedule.json";

/** 前端→kernel：晨间滚动检查（hourlyTimer 搭车+onrunning 兜底；lastRollDay 守卫=至多每日
 *  一次真写盘，零滚动=零写零重载） */
export const SCHEDULE_SYNC_METHOD = "schedule-sync";

/** kernel→前端：班表被 kernel 侧改写（晨间滚动/MCP 写入）——前端 window 事件直刷班表区
 *  （payload=SchedStore 概要；读真值走 readPetalJsonViaHttp 恒新鲜） */
export const SCHEDULE_UPDATED_CHANNEL = "sy-project/schedule-updated";

// ── sloop □5 作息训练·期 3：形态库+Onboarding ──

/** Onboarding 档存储键（前端唯一写者：挑身份/冻结基线均为用户动作，kernel 只读——
 *  与 schedule 双写者不同，此档无双写竞态，零广播需求（写者=本窗 UI 即时反馈）。
 *  形态=OnboardStore（core/onboard.ts） */
export const ONBOARD_FILE = "routine-onboard.json";

// ── sloop □23 执行期随手反馈（日循环收口）──

/** 随手反馈档存储键（前端唯一写者：时间线行上「记」钮，读改写整档走 saveData 恒带 app；
 *  kernel 只读喂交接会开场包「今日随手记」段（周报异常周段将来直读同档）。
 *  形态=FeedbackStore（core/feedback.ts）：day→[{at,text,target?}]——不挂 SchedItem key
 *  （条目剪枝/非 sched 源无 key），反馈自含目标快照，条目消失仍可读 */
export const FEEDBACK_FILE = "routine-feedback.json";

// ── 番茄账本+桥（bear 09-20「去自建钟用番茄工具箱」：自建钟引擎/运行态/参数三档退役，
//    番茄能力=桥只读 tomato 插件；本仓只留账本历史+桥轻状态） ──

/** 历史档（写者=时间线番茄桥唯一追加——tomato stats diff 回流；kernel 采集读档聚合=DayProfile
 *  第八路（深度块锚点证据）。形态=PomoLogStore：day→[]，条目形态见 gui/pomoBridge.ts） */
export const POMODORO_LOG_FILE = "pomodoro-log.json";
/** 桥状态档（前端唯一写者：「当前任务」标记+tomato stats 回流锚一档两键——重载不丢完成段） */
export const POMO_BRIDGE_STATE_FILE = "pomo-bridge.json";

// ── sloop □6 作息训练·期 4：照镜子周报 ──

/** 周报表存储键（kernel 独家写：{firstWeek, weeks:{weekStart:{num,at,docId,docName,day}}}
 *  滚动 8 周剪枝；幂等=weeks[weekStart] 已存在零写——petal 写频率=周级，零重载风暴；
 *  前端只读（未读角标数据源+周报 chip 开文档映射），已读标记走前端 localStorage 不回写）
 */
export const ROUTINE_WEEKLY_FILE = "routine-weekly.json";

/** 前端→kernel：触发周报检查（hourlyTimer 搭车+onrunning 兜底；幂等守卫=已生成周零写） */
export const WEEKLY_REPORT_SYNC_METHOD = "weekly-report-sync";

// ── sloop □8 作息训练·期 6：训练循环深化 ──

/** 训练参数存储键（kernel 独家写：{capacity:{日型:{doneItems,pomoMinutes,doneRate,sampleDays}},
 *  log:[{weekStart,outcome,evidence,changes}]}——容量按日型 EWMA 周聚合+学习账本滚动 12 条；
 *  幂等=log 已有该 weekStart 零写；前端只读展示（交接会开场包训练参数段，HTTP getFile 读）
 */
export const ROUTINE_TRAINING_FILE = "routine-training.json";

// ── sloop □10 切换器「新建项目」手动入口 ──

/** 前端→kernel：手动建项目（params={notebook, name}→ToolResponse {success, data?{id,name}, error?}）。
 *  kernel 侧直调 MCP project create 同一 handler（单一事实源——前端不重写建骨架逻辑）；
 *  手动=轻量裸建（agentNote 走默认占位），与 AI 富建通道并存不冲突 */
export const PROJECT_CREATE_METHOD = "project-create";

/** 前端→kernel：删除项目（驾驶舱危险态钮；params={projectId}→ToolResponse
 *  {success, data?{id,name,deletedSubDocs,totalDocs}, error?}）。
 *  mainline-home-split 起项目全普通化：任何项目可删（旧「主线容器」守卫退役——三件套已迁
 *  /主线数据 屋檐）；防线=删前查子树含屋檐拒删（deleteProjectRpc 内）。
 *  ⚠️刻意独立 handler 不进 MCP project 工具 action 枚举——删除动作不对 AI 暴露
 *  （bear 拍板「MCP 删除动作砍掉不做」），前端 UI 专用通道。 */
export const PROJECT_DELETE_METHOD = "project-delete";

// ── sloop □7 作息训练·期 5：外部日历镜像+提醒通道 ──

/** 自动存入配置存储键：{autoAdopt?: boolean}（期 4 起 sched 镜像链/backend/writeback 退役，
 *  文件名沿用旧档零迁移——唯一存活位=autoAdopt 开关，缺省=开）。前端唯一写者：设置页 saveData；
 *  kernel poll 后 fresh 直读（勿走 storage 缓存） */
export const SCHED_MIRROR_CONF_FILE = "sched-mirror-conf.json";

/** 提醒通道勾选（与数据解耦=独立 petal 键；前端唯一写者）。
 *  toast=思源内推送（showMessage）；dialog=弹窗（用户显式勾选才弹——反 push 红线下的自愿通道）；
 *  external=已退役位（期 4 前控制 sched 镜像载荷带不带提醒；班表并入 remind 链后恒到点提醒，
 *  旧档宽容读保留字段、设置面不再呈现） */
export interface ReminderChannels {
    toast: boolean;
    dialog: boolean;
    external: boolean;
}

/** 提醒通道存储键 */
export const REMINDER_CHANNELS_FILE = "reminder-channels.json";

/** 默认：内推送开、弹窗关（弹窗须用户显式打开）、外部日历提醒开（镜像了自然要提醒） */
export const DEFAULT_REMINDER_CHANNELS: ReminderChannels = { toast: true, dialog: false, external: true };

/** 前端→kernel：班表日终态→日记班表块 diff 重放（timeblock 期 2 ① 统一写链 call→
 *  {ok, docId?, updated?, inserted?, deleted?, keyRemap: [oldKey, blockId][], error?}——
 *  schedEdit add/move/remove/冻结链的块写委托面；失败=前端 petal 照写不断供，下轮自愈） */
export const SCHED_BOARD_SYNC_METHOD = "sched-board-sync";

/** 前端→kernel：删飞书外来事件（timeblock 期 2 ⑤ 右键三动作·删除——无块虚显条目通道）→
 *  {ok, error?}——镜像定位真实历 id+DELETE 事件+清账本孤儿绑定+立即镜像轮询（广播回前端刷新）；
 *  订阅日历/无写权限=API 报错透传 */
export const SCHED_FOREIGN_DELETE_METHOD = "sched-foreign-delete";

/** 前端→kernel：日历轴右键建带时间空段落块（tb2 H1 bear 拍板「先简单只支持段落块」）→
 *  {ok, blockId?, docId?, error?}——ensureDayDiary+班表容器后插段落+挂 custom-remind-at
 *  （无 custom-sched-origin/无 petal 行=走 remind 链全家桶：同步/块面时间/日轴 remind 源） */
export const REMIND_ENTRY_CREATE_METHOD = "remind-entry-create";

/** 前端→kernel：当日班表块只读（timeblock 期 2 ② 读面切块——日历页签日面板数据源）→
 *  {ok, docId?, boardId?, items: {key,summary,start,end,hard,origin}[], error?}——
 *  getChildBlocks 真序+IAL 直读（写后立读安全），绝不建档（读通道零副作用） */
export const SCHED_BOARD_READ_METHOD = "sched-board-read";

/** 前端→kernel：H4 测试消息直发（bear 09-19 拍板——排查手机端推送配置）→
 *  {ok, messageId?, urgentApplied?, error?}——bot 身份发 p2p 文本+可选加急
 *  （APP 应用内/SMS 短信/PHONE 电话/REPLY 需回复·签到式；加急只能加急自己发的消息=同 bot 身份） */
export const FEISHU_TEST_SEND_METHOD = "feishu-test-send";

/** 前端→kernel：H4 马上到期测试事件 → {ok, eventId?, startAt?, swept?, error?}——
 *  oauth 用户身份建 now+seconds 事件（到点提醒按用户身份生效）+清场回看窗内已触发的
 *  旧测试事件（标记串识别，未触发不误删）——到点看手机弹没弹 */
export const FEISHU_TEST_EVENT_METHOD = "feishu-test-event";

/** 前端→kernel：tb6 □6d 机器人身份自检 → {ok, botName?, appIdTail?, error?}——
 *  GET /bot/v3/info（tenant token）读当前凭证的 bot 名；「列出租户全部机器人」无公开
 *  API 不做（application/v6 仅按 app_id 单查——bear 已知悉）。防配错：换 app 凭证=换机器人 */
export const FEISHU_BOT_INFO_METHOD = "feishu-bot-info";

// ── 弹药库 □3：单任务运行引擎（ammo）──

/** kernel→前端：引擎状态变更广播（payload=AmmoEngineStatus；kernel/ammoEngine.ts 定义）。
 *  start/stop/depart/resolve 每次落账后广播；启动恢复扫描（runAmmoRecoveryScan）开机兜底
 *  一发（悬账提示面）。番茄区「当前任务」只读关联=消费本广播的 focus 字段（petal 零双写）。 */
export const AMMO_STATE_CHANNEL = "sy-project/ammo-state";

/** 前端→kernel：开始任务（互斥：闭前一个于新开始时刻+开新未闭合条目）
 *  → AmmoEngineStatus；参数 day/start/summary/pool?/task?/owner?（owner=本窗 app id 门牌） */
export const AMMO_START_METHOD = "ammo-start";

/** 前端→kernel：停止当前运行任务（补 end 闭合）→ AmmoEngineStatus；参数 day/end */
export const AMMO_STOP_METHOD = "ammo-stop";

/** 前端→kernel：锚点一键「出发」（闭当前+开锚点出发型条目 anchor=1/task=班表块/pool 空；
 *  显式用户动作不偷偷自动切）→ AmmoEngineStatus；参数 day/start/summary/task/owner? */
export const AMMO_DEPART_METHOD = "ammo-depart";

/** 前端→kernel：引擎状态只读面（启动恢复/挂载首读；零写零建档）→ AmmoEngineStatus；参数 day? */
export const AMMO_STATE_METHOD = "ammo-state";

/** 前端→kernel：悬账补结（UI 逐条提示后用户给 end 时刻；含丢弃=end 用户自估）
 *  → AmmoEngineStatus；参数 blockId/day/end */
export const AMMO_RESOLVE_METHOD = "ammo-resolve";

/** 前端→kernel：感想 append 到打点条目下（□2 appendLedgerReflection 的 rpc 面——写链已在，
 *  缺的只是常量+绑定+blockId 缺省解析）。→ {ok, blockId?, error?}；
 *  参数 {text, blockId?, day?}——blockId 缺省=当前运行中条目（kernel 侧 ammoReflectRpc 解析） */
export const AMMO_REFLECT_METHOD = "ammo-reflect";

/** 前端→kernel：四象限面板聚合读面（□6；读通道零副作用零建档——sched-board-read 先例同款）
 *  → AmmoPanelData（kernel/ammoPanel.ts 定义）；参数 {day?} 缺省=当日。
 *  一面聚合：每日配置（池配比+任务挂载）+日账实吃+不想做清单+引擎运行态——面板挂载首读与
 *  AMMO_STATE_CHANNEL 广播后的重拉都走它（单面免四次 rpc 交错）。 */
export const AMMO_PANEL_METHOD = "ammo-panel";

/** 前端→kernel：done 任务收拢（03 收拢件；驾驶舱「收拾已完成」按钮——MCP line sweep_done
 *  双通道共用编排 kernel sweepProjectDone）→ SweepDoneResult；参数 {projectId}。
 *  收拢单元=顶层 done 任务项（子树全 done），moveBlock 保 id 收进项目内「归档」区。 */
export const LINE_SWEEP_METHOD = "line-sweep";

/** 前端→kernel：格式体检聚合读面（dataview □8 fail-soft 的可见面；读通道零副作用零建档）
 *  → AmmoHealthReport（kernel/ammoHealth.ts 定义）；参数 {day?} 缺省=当日。
 *  三类发现：①分区结构异常（□1 非恰好三段 H2）②未认行（□2 双通道解析失败）③文本与属性
 *  冲突——判官全复用既有解析器，本面只做汇总；每条带块/文档 id 供点击跳转（cb-get-hl 禁聚焦）。 */
export const AMMO_HEALTH_METHOD = "ammo-health";

// ── 弹药库 dataview □5：拖拽调档两写面 ──

/** 前端→kernel：拖卡换池（□5① 单任务级写通道——kernel moveTaskPool，不动整组）→
 *  TaskMoveResult（kernel/ammoQuadrant.ts 定义）；
 *  参数 {day, task, name, pool, quota?}——task 空串=无主行按 name 匹配。
 *  幂等（已在目标池零写）+树块「今日位」缓存同步；串行=configWriteChain。 */
export const AMMO_MOVE_POOL_METHOD = "ammo-move-pool";

/** 前端→kernel：点池头改配比（□5③——kernel setPoolRatio，□2 文本写通道落池行文本）→
 *  PoolRatioResult；参数 {day, pool, ratio}——ratio 缺省/null=清配额（删 Nmin 尾语义）。
 *  读-改-写整段进串行链；守卫拒=violations 带出零写（□8 体检素材透传）。 */
export const AMMO_SET_RATIO_METHOD = "ammo-set-ratio";

/** 前端→kernel：炉火最小频率改写（第二批 R3——kernel setPoolFreq，setPoolRatio 姊妹通道）→
 *  PoolFreqResult；参数 {day, pool, freq}——pool 恒 "hearth"（freq 仅炉火有语义），
 *  freq 缺省/null=清属性回缺省（DEFAULT_HEARTH_FREQ）。freq 无自然文本形态→属性即真相
 *  （契约 §2 例外条款）；落盘走 □2 文本写通道（整组重放，池行文本零触碰）。 */
export const AMMO_SET_FREQ_METHOD = "ammo-set-freq";

/** 前端→kernel：任务级配额改写（dataview □7 徽标菜单配额步进——kernel setTaskQuota，
 *  moveTaskPool 姊妹通道）→ TaskQuotaResult；参数 {day, task, name, quota}——quota
 *  缺省/null=清配额。双半边：块缓存（custom-ammo-quota）恒写+配置行在才改行文本
 *  （· Nmin 尾=真相）；行不在不追加（挂池归换池/速记链）；串行=configWriteChain。 */
export const AMMO_SET_QUOTA_METHOD = "ammo-set-quota";

// ── 弹药库 □7：时间线实况轴+日历双类+飞书手动同步 ──

/** 前端→kernel：日账读面（□7 实况轴/月历回填数据源；readDayLedger 的 rpc 面）。
 *  参数 {day?} 单日（时间线/页签）或 {days: string[]} 窗口（月历 42 格，kernel 侧顺序循环；
 *  单日通道零副作用零建档——locate/read 全家不建不写）→ {ok, days: {day, items}[] | 单日形态} */
export const AMMO_LEDGER_READ_METHOD = "ammo-ledger-read";

/** 前端→kernel：实况手动同步态读面（□7 同步钮颜色标态数据源；纯读零写零网络）→
 *  AmmoLiveState（kernel/ammoLiveSync.ts 定义）；参数 {day?} 缺省=当日。
 *  state：empty=无闭合实况段（灰）/dirty=有未同步新打点（黄）/synced=已同步（绿）/
 *  off=飞书未配置或停用（灰）。 */
export const AMMO_LIVE_STATE_METHOD = "ammo-live-state";

/** 前端→kernel：实况手动同步（□7 bear 拍板 pull 式——用户按钮触发，勿实时推）→
 *  AmmoLiveSyncResult；参数 {day?}。闭合实况段推成飞书事件（无提醒纯展示，单向投影不回写）；
 *  kernel 侧串行单飞链防并发双跑，plan 幂等（重复点=全 unchanged 零写零网络）。 */
export const AMMO_LIVE_SYNC_METHOD = "ammo-live-sync";

/** kernel→前端：实况同步完成广播（payload=AmmoLiveSyncResult）——同步钮/实况段同步徽标
 *  直刷（index.ts 转发 window「pj-ammo-live-synced」；非 SQL 轮询——投影刷新走内存事件链）。 */
export const AMMO_LIVE_SYNCED_CHANNEL = "sy-project/ammo-live-synced";

/** 前端→kernel：不想做清单手动编辑（中央圈只读镜子变可编辑——manualui）。
 *  写面=kernel syncAversions 单一事实源（AI 交接会 aversion_set 背后同一实现，UI 不另写）→
 *  AversionSyncResult（kernel/ammoQuadrant.ts 定义）。参数 {upserts, remove}（载荷形态直映
 *  syncAversions 签名——薄转发零翻译层）：
 *  - 增={upserts:[{text, kind:"vow"}]}（手动通道 kind 恒 vow、不暴露 avatar/capPool——AI 对话仍可补）；
 *  - 改={upserts:[{id, text, kind, avatar?, capPool?}]}（kind/avatar/capPool 从读面透传——
 *    保分区不丢 fear 化身/swallow 物化池〔syncAversions 同 kind 原地更新会确定性重挂全键属性〕）；
 *  - 删={remove:[块id]}（直接删不弹确认——AI 面同款语义；守卫=非不想做块拒删）。 */
export const AVERSION_WRITE_METHOD = "aversion-write";

/** 前端→kernel：交接会手动落对账（manualui——对账单三态勾选落盘，「不开 AI 走完交接会」
 *  收尾件）。写面=routine 工具 recon_record 同一 handler（单一事实源——校验/读改写/当日
 *  拖动消费全同 AI 通道，project-create 直调先例）；载荷 {day, results} 直映
 *  core recordRecon 签名（results=[{key,summary,verdict:"done"|"missed"|"unknown",note?}]）
 *  → ToolResponse {success, data:{day,recorded,note}, error?}。 */
export const RECON_RECORD_METHOD = "recon-record";

export interface OpenScenePayload {
    projectId: string;
    /** 上次快照；null=首次打开（前端走 fallback 开主文档） */
    scene: import("../kernel/core/scene").SceneSnapshot | null;
    fallbackDocId: string;
    /** 恢复现场语义 B（按钮化 a）：true=先关本项目域页签再开快照页签（丢弃当前未存现场）。
     *  kernel project.open 不传（跨项目切换不关旧项目页签=既有语义） */
    closeExisting?: boolean;
}
