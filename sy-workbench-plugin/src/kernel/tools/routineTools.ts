import { addDays, getLogicalDay } from "../core/dates";
import { HOME_DIARY_HPATH, HOME_DAYCONFIG_HPATH, HOME_AVERSION_HPATH } from "../../shared/homePaths";
import { isHourKey, shiftDay } from "../core/behavior";
import { handleGetProfile } from "../behavior";
import { addPref, clearDayRows, isValidDay, isValidHM, pruneSchedule, recordRecon, type ReconSettled, type SchedItem } from "../core/schedule";
import { normalizeOnboard } from "../core/onboard";
import { feedbackOf, normalizeFeedback } from "../core/feedback";
import { flashDueTimestamp, flashLimitHint, flashWaveSummary, normFlashInput, splitFlashWaves, type FlashWavePlan } from "../core/flashwave";
import { applyFlashDue, scoutFlashPool, waveCompletion, type FlashScout } from "../flashwave";
import { recentAnchorOfKind } from "../core/report";
import { guardStructure, weekStartOf } from "../core/training";
import { dayAlmanac } from "../../lunarInfo";
import { appearanceLang, assembleSchedView, buildReconForDay, loadSchedule, loadScheduleForWrite, newSchedKey, readDayItems, readRangeItems, saveSchedule } from "../schedule";
import { getTrainingContext, tomorrowOf } from "../training";
import { buildHandoffPacket, getPlanningRules, type HandoffData } from "../../handoffSeed";
import { petalGetJsonFresh, deleteBlock, getFlashcardLimits } from "../api";
import { syncDayBoardToDiary } from "../schedboard";
import { readDayLedger } from "../ammoLedger";
import { buildDailyNoteDigest, readDayConfig, scanForest, syncAversions, writeDayConfig, type AversionUpsert } from "../ammoQuadrant";
import { DEFAULT_HEARTH_FREQ, normAmmoPayload, poolMinutesFromLedger, type AmmoDayConfig } from "../core/ammoQuadrant";
import { buildMirrorSection, buildQuotaRecon, HEARTH_SCAN_WINDOW } from "../core/ammoRecon";
import { runRemindSyncGuarded, schedItemsToRemindHintRows } from "../remind";
import { fetchForeignEvents, lokiSchedLogger, recentSchedReceipts } from "../schedMirrorSync";
import { FEEDBACK_FILE, ONBOARD_FILE } from "../../shared/channels";
import { errorResponse, successResponse, objectSchema, wrapHandler, type ToolDefinition } from "./common";

const ACTIONS = [
    "handoff",
    "profile",
    "plan_context",
    "aversion_set",
    "recon",
    "recon_record",
    "schedule_get",
    "schedule_set",
    "schedule_remove",
    "pref_get",
    "pref_add",
] as const;

// 工具教育段：交接会五幕对应工具面（设计档 §2）+弹药库 v2（ammo □4 配弹药/□5 对账面：
// 弹药消耗对账+不想做镜子+aversion_set 森林增量）。班表=锚点域（窗口硬的事走时刻/提醒/飞书
// 镜像链零改动）；弹性任务=每日象限配置（池配比+任务挂载，写入森林域 AI 约定区域）。
const DESC =
    "弹药库模式·交接会（每晚 3 分钟日循环）+排期引擎。铁律：时间分两类——锚点（接送孩子/会议等窗口硬的）排时刻进班表；弹性任务（人生目标细拆/维持事务）只有配额没有时刻（AI 不再假装知道你下午三点该干嘛）。软配额全程不拦截：用完显示已消耗、多用显示多用 X 分钟。"
    + "标准流：① routine.handoff 拿完整开场包（五幕流程+红线+今日数据预填——弹药对账单/两类告警/不想做镜子/锚点对账单，照着它主持对话）；② 弹药对账单照念不评判；锚点对账单只问 ❓ 无证据的条目；不想做清单固定过一遍（戒条一问=答了记账不追问；告警措辞只引用用户原话，从不产生新指责）；"
    + "③ 明日方案点头后按三件套顺序落盘（失败从断点重跑自愈）：森林增量（aversion_set 不想做增删改+task.complete 勾选）→ routine.schedule_set 双载荷（单次调用内 ammo 配置先落再落锚点 items——items=锚点条目带 start、ammo=弹性任务配弹药 pools+tasks，任务 id 从 plan_context 的 forest 段拿）；"
    + "④ routine.recon_record 落今日对账结果；用户对拖动点头 → routine.pref_add 记长期偏好。"
    + "升格通道：对话中冒出值得跨多天推进的目标 → task.create 建到项目（森林图跟踪），森林=想要的世界、日账=发生的世界。"
    + "白天崩盘重排（锚点域）：routine.plan_context{target_day:今天} 拿侦察包 → 出方案 → 点头后 "
    + "schedule_set{day:今天, clear_from:\"now\", items:剩余锚点时段}——从 now 起不重排全天，已过条目保留当对账证据（弹性任务无时刻无崩盘，白天照打弹药）。"
    + "AI 写森林守卫（不可软化）：只动约定区域（任务勾选态/每日象限配置块/任务标记属性/不想做条目）；拆树/挪枝/删枝结构手术不在工具面——交接会对话点头后人工通道；配弹药任务行只能指向森林真实任务块（乱指块会被守卫拒）。"
    + "红线（不可软化）：不评价人（收据不是考卷）/不情绪施压/不做 streak/断签不追责/禁作文式追问/告警与超限措辞只引用用户原话。"
    + "Actions: handoff(交接会开场包{day?}——弹药对账单+两类告警（黄金保底被挤/炉火超上限或凉了，措辞只引用不想做原话）+不想做镜子+锚点对账单), profile(行为画像 JSON{day?}), "
    + "plan_context(排期侦察包{target_day?}——now 当前时刻(你不知道现在几点)/三源侦察：①dailyNote 手写感想 ②ledger 日账实况(各池已吃分钟=对账原料) ③forest 森林域(树任务块含 id/挂载/配额/里程碑/纯目标——配弹药的 task 字段用它们的 id+不想做清单原话)/今日与目标日既有象限配置/目标日锚点+外来日历占用/历法/睡眠锚点/近 3 日容量/prefs+排期规则段；配明日弹药或排锚点前先拿), "
    + "aversion_set(不想做清单写面{aversions:[{id?,text,kind,avatar?,capPool?}],remove?}——森林增量第一件：戒条vow无数据/怕来不及fear带正面化身avatar/防沉迷swallow带物化池capPool；原话原样落块=镜子素材), "
    + "recon(锚点对账单预填三态{day?}), recon_record(落锚点对账结果{day,results}), "
    + "schedule_get(读班表锚点域{day?}|{from,to}), schedule_set(双载荷写{day,items?,ammo?,replace?,clear_from?}——items=锚点条目[{key?,summary,start,end?,hard:true,flash?}]（班表=锚点域：时刻/提醒/飞书镜像链）；"
    + `ammo={pools:[{pool,ratio?,freq?}],tasks:[{task?,pool,quota?,summary}]}=弹性任务配弹药（池配比：gold.ratio=保底分钟/hearth.ratio=上限分钟+freq=最小频率天数（缺省3——超 N 天没看交接会报「炉子凉了」）；任务挂载：task=森林树任务块 id（缺省=无主预告行）、quota=任务级分钟；写森林域${HOME_DAYCONFIG_HPATH}/<月>/<日>，幂等整组重放）；`
    + "调用内顺序=ammo 配置先落再落锚点（守卫拒=整轮拒零污染；森林不可用=锚点照写+ammoWarning 重跑自愈）；弹性任务传 items（hard:false）会被拒——时刻语义已退役；"
    + "flash={quota:每波张数}=闪卡波次（期 3 语义不变：条目必带 start，重排=clear_from 后整批重写）；"
    + "clear_from:\"HH:mm\"|\"now\"=锚点域崩盘重排（清 start≥该时刻条目再写，与 replace 互斥)), "
    + "schedule_remove(删锚点条目{keys[]}), pref_get(长期偏好清单), pref_add(记长期偏好{text,origin?})。"
    + "训练参数（ammo □5 v2）：plan_context/handoff 带 training 块（各池吃量按日型学的 EWMA——明日池配比参照它，宁少勿多；周日不进样本/异常周整周剔除/只有打点收据日进分母）。"
    + "结构慢变守卫（代码级）：schedule_set/schedule_remove 若使本周锚点变动（锚点族=起床/睡/锻炼/晒太阳/深度块的新增/移除/中位挪动≥30 分钟）超过 2 处会被拒绝并说明超在哪——收敛方案而非换工具绕过；内容条目（非锚点）增删换不受限；用户自己拖动/手改班表不受限。"
    + `⚠班表=日志块（${HOME_DIARY_HPATH}/<day> 的「## 班表」——块=唯一真身，进日历/提醒链）；象限配置=森林域每日配置块（${HOME_DAYCONFIG_HPATH}/<YYYY-MM>/<day> 容器）；不想做清单=${HOME_AVERSION_HPATH} 三分区。回参 diary/diaryWarning=块侧落点/失败原因；ammo/ammoWarning=配置侧落点/守卫拦截。写后如需看效果，schedule_get 复核锚点、plan_context 复核配置与清单。`;

function normItemsInput(day: string, raw: any, now: Date): SchedItem[] {
    const at = now.toISOString();
    return (Array.isArray(raw) ? raw : [])
        .map((x: any) => {
            const summary = typeof x?.summary === "string" ? x.summary.trim().slice(0, 100) : "";
            if (!summary) return null;
            const start = isValidHM(x?.start) ? x.start : null;
            let end = isValidHM(x?.end) ? x.end : null;
            if (start && end && end <= start) end = null;
            const key = typeof x?.key === "string" && x.key ? x.key : newSchedKey();
            return {
                key,
                summary,
                date: day,
                start,
                end,
                hard: x?.hard === true,
                origin: "ai" as const,
                createdAt: at,
                updatedAt: at,
            };
        })
        .filter((x: SchedItem | null): x is SchedItem => x !== null);
}

export function createRoutineTool(): ToolDefinition {
    return {
        name: "routine",
        config: objectSchema(
            DESC,
            {
                action: { type: "string", enum: [...ACTIONS], description: "操作类型" },
                day: { type: "string", description: "YYYY-MM-DD（handoff/profile/plan_context 之外的读写面缺省=今天；plan_context 用 target_day）" },
                target_day: { type: "string", description: "plan_context: 目标日 YYYY-MM-DD（缺省=明天——排明日方案/错峰看的就是它）" },
                from: { type: "string", description: "schedule_get 范围起点 YYYY-MM-DD（与 to 连用）" },
                to: { type: "string", description: "schedule_get 范围终点 YYYY-MM-DD" },
                aversions: {
                    type: "array",
                    description: 'aversion_set: 不想做条目增改数组 [{id?(改既有), text:"用户原话", kind:"vow|fear|swallow", avatar?(仅fear=正面化身树任务块id), capPool?(仅swallow=物化池slug gold|deadline|hearth|crumbs)}]——原话原样落块文本（镜子措辞唯一素材源）',
                },
                remove: { type: "array", description: "aversion_set: 要删的条目块 id 数组（只删带 custom-ammo-aversion 的块——用户手写内容永不被 AI 删）" },
                items: {
                    type: "array",
                    description: 'schedule_set 锚点条目数组（班表=锚点域——窗口硬的事）：[{key?(改既有——波次条目勿用 key), summary, start:"HH:mm", end:"HH:mm"|null, hard:true, flash?:{quota:每波张数}(闪卡波次)}]；弹性任务勿进 items（hard:false 会被拒）——配弹药走 ammo 载荷',
                },
                ammo: {
                    type: "object",
                    description: 'schedule_set 弹性任务配弹药载荷：{pools:[{pool:"gold|deadline|hearth|crumbs", ratio?, freq?}], tasks:[{task?, pool, quota?, summary}]}——池配比（gold.ratio=保底分钟/hearth.ratio=上限分钟+freq=最小频率天数，缺省3）+任务挂载（task=森林树任务块 id 从 plan_context 的 forest 段拿，缺省=无主预告行；quota=任务级分钟）；写森林域每日配置块（幂等整组重放=改配置传全量）',
                },
                replace: { type: "boolean", description: "schedule_set: true=先清空该日其余条目再写（整日重排；与 clear_from 互斥）" },
                clear_from: { type: "string", description: 'schedule_set: "HH:mm"|"now"——清该日 start≥该时刻条目再写（崩盘重排；已过条目保留=对账证据；未定时托盘不动；与 replace 互斥）' },
                keys: { type: "array", description: "schedule_remove: 条目 key 数组" },
                results: {
                    type: "array",
                    description: "recon_record: [{key, verdict:\"done\"|\"missed\"|\"unknown\", note?}]——key/初判用 recon 返回的",
                },
                text: { type: "string", description: "pref_add: 偏好一句话（如「写作固定 11:00–12:30」）" },
                origin: { type: "string", enum: ["drag-confirm", "chat", "user"], description: "pref_add: 偏好来源（默认 chat）" },
            },
            ["action"],
        ),
        handler: wrapHandler(async (input) => {
            const action = input?.action;
            if (!ACTIONS.includes(action)) return errorResponse(`未知 action: ${action}`);
            const today = getLogicalDay(new Date());
            const dayOf = (fallback: string) => (isValidDay(input.day) ? input.day : fallback);

            if (action === "handoff") {
                const day = dayOf(today);
                const { recon, store, profile } = await buildReconForDay(day);
                const drags = store.drags.filter((d) => d.day === day);
                const onboard = normalizeOnboard(await petalGetJsonFresh(ONBOARD_FILE));
                // □23 今日随手记（时间线行上记的——独立档不挂班表，条目消失仍可读；空=不带段）
                const notes = feedbackOf(normalizeFeedback(await petalGetJsonFresh(FEEDBACK_FILE)), day);
                // □25 完全同步：近 24h 自动同步回执（期 4 起=飞书自动存入落块回执；重启清空=当日该段缺席不虚报）
                const fsReceipts = recentSchedReceipts();
                // □8 期 6：训练参数段（容量按日型学+异常周感知+结构守卫余量——第四幕量化参照；
                // 读失败=不带该段。items=块读面组装（近 4 周窗））
                const training = await getTrainingContext({ today: day, targetDay: tomorrowOf(day), schedItems: (await assembleSchedView(addDays(day, -27), day)).items }).catch(() => null);
                const lang = await appearanceLang();
                // ── ammo □5：弹药对账+不想做镜子（清单原话+今日吃量→拼接进提示词，不做评分） ──
                // 三源读面失败=该段缺席不阻塞锚点对账（独立失败域）；hearth 凉了扫描窗=
                // min(freq+1, HEARTH_SCAN_WINDOW) 天回看（freq 从今日配置取，缺省 3）。
                let ammoPacket: HandoffData["ammo"] = null;
                try {
                    const cfgRead = await readDayConfig(day);
                    const ledgerRead = await readDayLedger(day);
                    const forestScout = await scanForest();
                    if (cfgRead.ok && ledgerRead.ok) {
                        const digest = poolMinutesFromLedger(ledgerRead.items);
                        const freq = cfgRead.config?.pools.find((p) => p.pool === "hearth")?.freq ?? DEFAULT_HEARTH_FREQ;
                        const windowDays = Math.min(freq + 1, HEARTH_SCAN_WINDOW);
                        const recentHearthDays: string[] = [];
                        if ((digest.pools.hearth ?? 0) > 0) recentHearthDays.push(day);
                        for (let i = 1; i <= windowDays; i++) {
                            const d = addDays(day, -i);
                            const lr = await readDayLedger(d).catch(() => null);
                            if (lr?.ok && (poolMinutesFromLedger(lr.items).pools.hearth ?? 0) > 0) recentHearthDays.push(d);
                        }
                        const recon2 = buildQuotaRecon({ config: cfgRead.config, digest, today: day, recentHearthDays });
                        const mirror = buildMirrorSection({
                            today: day,
                            aversions: forestScout.available ? forestScout.aversions : [],
                            recon: recon2,
                            config: cfgRead.config,
                            zh: !lang || lang.toLowerCase().startsWith("zh"),
                            sectionTitles: forestScout.aversionTitles,
                        });
                        ammoPacket = { recon: recon2, mirror, noConfig: cfgRead.config == null, config: cfgRead.config };
                    }
                } catch {
                    ammoPacket = null; // 对账段缺席不阻塞交接会（锚点侧照常）
                }
                const prompt = buildHandoffPacket(lang, {
                    day, recon, drags, prefs: store.prefs, profile, onboard, notes,
                    ...(fsReceipts.length ? { fsReceipts } : {}),
                    ...(training ? { training } : {}),
                    ...(ammoPacket ? { ammo: ammoPacket } : {}),
                });
                return successResponse({ day, prompt, note: "照 prompt 主持五幕对话：弹药对账单照念（不问）；锚点对账单只问 ❓；不想做清单固定过一遍（戒条一问）" });
            }

            if (action === "profile") {
                const day = dayOf(today);
                const r = await handleGetProfile({ day });
                return successResponse({ day, profile: r.profile, note: "八路行为画像（文档/停留/活跃时段/日历/提醒/任务/历法/番茄）——对账证据源" });
            }

            if (action === "plan_context") {
                // □26 排期侦察包 + ammo □4 三源改造：读三源（Daily Note 手写+日账打点+森林文档
                // 子文档含不想做清单）替代原班表三态来源（弹性任务退役时刻表——今日班表=锚点域
                // 列表不带对账 verdict，配额消耗对账由 □5 交接会面接管）；now 三元组/外来日历占用
                // （跨天覆盖）/睡眠锚点三级回退/容量参数等既有侦察字段保留。
                const targetDay = isValidDay(input.target_day) ? input.target_day : addDays(today, 1);
                const lang = await appearanceLang();
                const now = new Date();
                const nowHM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                const wd = ["日", "一", "二", "三", "四", "五", "六"][new Date(`${today}T12:00:00`).getDay()];
                // 今日锚点（班表=锚点域——对账三态退役，实况由日账打点见证）
                const todayRows = (await readDayItems(today)) ?? [];
                const todayAnchors = todayRows.map((i) => ({ key: i.key, summary: i.summary, start: i.start, end: i.end, hard: i.hard }));
                const store = await loadSchedule();
                // 目标日已有条目（锚点错峰原料之一：自己的班表——晨间滚动/早前方案已落的部分；块读面）
                const targetDayRows = (await readDayItems(targetDay)) ?? [];
                const targetDayItems = targetDayRows
                    .sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99"))
                    .map((i) => ({ key: i.key, summary: i.summary, start: i.start, end: i.end, hard: i.hard }));
                // 外来日历占用（镜像档读=零网络；不可用=错峰退化为只看班表）
                const foreign = await fetchForeignEvents(targetDay).catch(() => null);
                // review P1-1b 工具面兜底：崩盘重排要的是「今天」的情报，缺省 target_day=明天——
                // 目标日≠今天时附今日占用，AI 忘带 target_day 也不至于拿明天的错峰原料排今天
                const todayForeign = targetDay === today ? foreign : await fetchForeignEvents(today).catch(() => null);
                // 期 3 闪卡波次侦察：目标日到期池（AI 定波数配额）+今日波次完成度（对账三态原料）；
                // 侦察失败=不带该块（排班其余原料照给）
                let flashContext: {
                    targetDayPool: { cards: number; newCards: number; reviewCards: number; docs: number; errors?: string[] };
                    todayWaves: Array<{ summary: string; start: string | null; cards: number; processed: number | null; total: number | null }>;
                } | null = null;
                // 方案 A：官方每日上限（getConf 读得到带实数、读不到固定句兜底——池=全空间
                // ≠实际可刷量，AI 定波数配额须知情）；随 flashContext 一起缺席于侦察失败
                let limits: { newCardLimit: number; reviewCardLimit: number } | null = null;
                try {
                    const sc = await scoutFlashPool(targetDay);
                    limits = await getFlashcardLimits();
                    const todayRows = (await readDayItems(today)) ?? [];
                    const todayWaves = todayRows
                        .filter((i) => i.flash && Array.isArray(i.flash.blocks) && i.flash.blocks.length)
                        .sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99"));
                    const waveStats: Array<{ summary: string; start: string | null; cards: number; processed: number | null; total: number | null }> = [];
                    for (const w of todayWaves) {
                        const due14 = w.start ? flashDueTimestamp(today, w.start) : "";
                        const c = due14 ? await waveCompletion(w.flash!.blocks, due14) : null;
                        waveStats.push({ summary: w.summary, start: w.start, cards: w.flash!.cards, processed: c?.processed ?? null, total: c?.total ?? null });
                    }
                    flashContext = {
                        targetDayPool: { cards: sc.cards, newCards: sc.newCards, reviewCards: sc.reviewCards, docs: sc.docs, ...(sc.errors.length ? { errors: sc.errors } : {}) },
                        todayWaves: waveStats,
                    };
                } catch {
                    // 侦察失败不带该块
                }
                const alm = dayAlmanac(targetDay);
                // □8 期 6：训练参数（容量按日型学/异常周感知/结构守卫余量）；读失败=不带该块。
                // items=块读面组装（近 4 周窗）
                const training = await getTrainingContext({ today, targetDay, schedItems: (await assembleSchedView(addDays(today, -27), targetDay)).items }).catch(() => null);
                // 睡眠锚点三级回退：onboard 口述 → 最近班表锚条目 → 缺失对话问（锚条目=块读近 7 天）
                const onboard = normalizeOnboard(await petalGetJsonFresh(ONBOARD_FILE).catch(() => null));
                const sleepHit = onboard?.constraints.sleep ?? null;
                const wakeHit = onboard?.constraints.wake ?? null;
                const recentRows = await readRangeItems(addDays(today, -6), today);
                const sleepRecent = recentAnchorOfKind(recentRows, "sleep", today);
                const wakeRecent = recentAnchorOfKind(recentRows, "wake", today);
                // 容量摘要（期 6 前简版）：近 3 日活跃时段——今日+昨日+前日，无数据日跳过
                // （键理论恒补零，数字排序双保险——坏归档不补零也不至于「14–9 点」倒挂；
                //  activeHours ?? {} =宽容归一档缺字段不炸整包，review P2-2）。
                // O2① 读面兜底：旧档已冻结的脏小时键（15 位 updated 残值产物 92/60 等）isHourKey
                // 滤除——写面归一只管新采集，归档直通不重写，此处保证出参键域恒 ≤23
                const capacity: Array<{ day: string; activeFrom: string; activeTo: string; peakHour: string }> = [];
                for (let i = 0; i < 3; i++) {
                    const d = addDays(today, -i);
                    const prof = (await handleGetProfile({ day: d })).profile;
                    const hours = prof ? Object.keys(prof.activeHours ?? {}).filter(isHourKey).sort((a, b) => Number(a) - Number(b)) : [];
                    if (!hours.length) continue;
                    const peak = hours.reduce((a, b) => (prof!.activeHours[a] >= prof!.activeHours[b] ? a : b));
                    capacity.push({ day: d, activeFrom: `${hours[0]}:00`, activeTo: `${hours[hours.length - 1]}:00`, peakHour: `${peak}:00` });
                }
                // ── ammo □4 三源侦察（弹性任务配弹药的原料面） ──
                // ①Daily Note 手写感想（SQL hpath 尾段日期启发式——查不到=缺席不阻塞）
                const dailyNote = await buildDailyNoteDigest(today);
                // ②日账实况（打点条目+各池已吃分钟=对账原料；锚点出发型 pool 空）
                const ledgerRead = await readDayLedger(today);
                const ledger = ledgerRead.ok
                    ? {
                        entries: ledgerRead.items.map((e) => ({
                            summary: e.summary, start: e.start, end: e.end, pool: e.pool, anchor: e.anchor,
                            durationMin: e.durationMin, reflections: e.reflections.map((r) => r.text),
                        })),
                        digest: poolMinutesFromLedger(ledgerRead.items),
                        note: "日账=发生的世界（打点实况）：digest.pools=各池已吃分钟（软配额照实记不评判）；unclosed=运行中/悬账段；anchor=锚点出发型",
                    }
                    : { entries: [], digest: { pools: {}, unclosed: [], totalClosed: 0, anchorCount: 0 }, note: `日账读失败（${ledgerRead.error ?? "unknown"}）——实况源缺席` };
                // ③森林域（树况+不想做清单原话+今日/目标日既有象限配置=续配原料）
                const forest = await scanForest();
                const forestTodayCfg = await readDayConfig(today);
                const forestTargetCfg = await readDayConfig(targetDay);
                return successResponse({
                    now: now.toISOString(),
                    nowWall: `${today} ${nowHM}（周${wd}）`,
                    nowHM,
                    today,
                    targetDay,
                    todayAnchors,
                    targetDayItems,
                    foreignEvents: foreign?.rows ?? [],
                    foreignEventsAvailable: foreign?.ok === true,
                    foreignMirrorAt: foreign?.mirrorAt ?? null,
                    ...(flashContext
                        ? {
                              flashcards: {
                                  ...flashContext,
                                  note: "闪卡波次（期 3）：targetDayPool=全空间目标日到期池（方案 A：不限于活跃项目——全库所有到期卡含旧日记/驾照等旧卡全收；New 卡恒计入——其 due 动态不可信；定波数配额用：池小=1 波、池大=2~3 波分散早/午/晚，schedule_set 条目带 flash:{quota} 即排，排班时刻=波次时刻一步对齐）；"
                                      + "todayWaves=今日各波完成度（processed/total=被推走卡数——刷卡或番茄推迟都算已处理，全部波 processed=total=今日闪卡全清，对账直接念证据）；"
                                      + flashLimitHint(limits),
                              },
                          }
                        : {}),
                    ...(targetDay !== today ? { todayForeignEvents: todayForeign?.rows ?? [] } : {}),
                    almanac: { lunarText: alm.lunarText, off: alm.off, work: alm.work, note: "目标日历法（off=节假日 work=调休上班）" },
                    sleepAnchor: {
                        sleep: sleepHit
                            ? { hm: sleepHit, source: "onboard" }
                            : sleepRecent
                                ? { hm: sleepRecent.start, source: "recent-schedule", since: sleepRecent.date }
                                : null,
                        wake: wakeHit
                            ? { hm: wakeHit, source: "onboard" }
                            : wakeRecent
                                ? { hm: wakeRecent.start, source: "recent-schedule", since: wakeRecent.date }
                                : null,
                        note: "三级回退：onboard 口述 → 最近班表锚条目 → null=对话里顺口问（旅游等不规则日灵活处理）",
                    },
                    capacity,
                    ...(training
                        ? {
                              training: {
                                  targetDayKind: training.dayKind,
                                  capacity: training.capacity,
                                  anomalyWeek: training.anomaly,
                                  structure: training.structure,
                                  note: "训练参数（ammo □5 v2 各池吃量按日型学）：capacity.pools=近几周该日型各池日均真实吃量分钟（EWMA；null=样本不足）——明日池配比参照它，宁少勿多（只有打点收据日进分母）；"
                                      + "anomalyWeek 非空=最近一周判定异常（该周数据已剔除不进参数——棘轮同理今晚也别问「更进一步」）；"
                                      + "structure=本周（目标日所在周）锚点变动已用 used/limit——超限的 schedule_set 会被结构守卫拒绝",
                              },
                          }
                        : {}),
                    prefs: store.prefs.map((x) => x.text),
                    rules: getPlanningRules(lang),
                    // ── ammo □4 三源段 ──
                    dailyNote: { found: dailyNote.found, docs: dailyNote.docs, note: dailyNote.note },
                    ledger,
                    forest: {
                        available: forest.available,
                        trees: forest.trees,
                        aversions: forest.aversions,
                        todayConfig: forestTodayCfg.config,
                        targetDayConfig: forestTargetCfg.config,
                        ...(forest.note ? { note: forest.note } : {}),
                    },
                    note: "排期侦察包（弹药库 v2）：now/nowHM/nowWall=当前时刻（对话模型不知道现在几点，一切时刻判断以它为准；goja 键序=字典序，勿依赖字段呈现序）；"
                        + "三源=①dailyNote（手写感想）②ledger（日账实况——digest.pools=各池已吃分钟）③forest（森林域：trees=树任务块（pool=当前挂载/quota=任务配额/milestone/goal——配弹药时 ammo.tasks[].task 用它们的 id）；aversions=不想做清单原话（镜子素材——超限提醒只引用用户原话，从不产生新指责）；todayConfig/targetDayConfig=既有象限配置（schedule_set 的 ammo 载荷=整组重放，改配置传全量））；"
                        + "锚点才进 items（班表=锚点域：todayAnchors/targetDayItems/闪卡波次/adopt；clear_from 崩盘重排语义保留）；弹性任务无时刻无崩盘——白天照打弹药；"
                        + "foreignEventsAvailable=false=外部日历镜像不可用（未配置/未轮询），错峰只看班表锚点；"
                        + "配明日弹药流：本包（forest 段拿任务 id+两日既有配置）→ 讨论定池与配额 → 点头后 schedule_set{day:明日, ammo:{pools,tasks}}（锚点同批进 items）",
                });
            }

            if (action === "aversion_set") {
                // ammo □5：不想做清单写面（森林增量=交接会三件套第一件——讨论点头后落盘）。
                // 原话原样落块文本（镜子措辞唯一素材源）；守卫在 syncAversions（kind 三值/
                // fear 才有化身/swallow 才有物化池+slug 白名单/非不想做块拒改拒删）。
                const upserts: AversionUpsert[] = (Array.isArray(input.aversions) ? input.aversions : [])
                    .map((x: any) => ({
                        ...(typeof x?.id === "string" && x.id ? { id: x.id } : {}),
                        text: typeof x?.text === "string" ? x.text.trim().slice(0, 100) : "",
                        kind: x?.kind,
                        ...(typeof x?.avatar === "string" && x.avatar ? { avatar: x.avatar } : {}),
                        ...(typeof x?.capPool === "string" && x.capPool ? { capPool: x.capPool } : {}),
                    }))
                    .filter((u: any) => u.text || u.id);
                const removeIds: string[] = (Array.isArray(input.remove) ? input.remove : []).filter((x: any) => typeof x === "string" && x);
                if (!upserts.length && !removeIds.length) return errorResponse('载荷空——aversions:[{text:"用户原话",kind:"vow|fear|swallow",id?,avatar?,capPool?}] 增改 / remove:[块id] 删');
                const r = await syncAversions(upserts, removeIds);
                if (!r.ok) {
                    return errorResponse(`${r.error ?? "写入失败"}——${r.violations ? "修正后重跑（已落条目幂等不重复）" : "稍后重跑自愈"}`);
                }
                return successResponse({
                    ...(r.docId ? { docId: r.docId } : {}),
                    inserted: r.inserted ?? 0,
                    updated: r.updated ?? 0,
                    removed: r.removed ?? 0,
                    note: `不想做清单已同步（${HOME_AVERSION_HPATH}——森林增量=三件套第一件；中央圈=配额的民意基础，镜子只引用用户原话）`,
                });
            }

            if (action === "recon") {
                const day = dayOf(today);
                const { recon } = await buildReconForDay(day);
                return successResponse({ day, items: recon });
            }

            if (action === "recon_record") {
                const day = dayOf(today);
                const results: ReconSettled[] = (Array.isArray(input.results) ? input.results : [])
                    .filter((r: any) => r && typeof r.key === "string" && ["done", "missed", "unknown"].includes(r.verdict))
                    .map((r: any) => ({
                        key: r.key,
                        summary: typeof r.summary === "string" ? r.summary : "",
                        verdict: r.verdict,
                        ...(typeof r.note === "string" && r.note ? { note: r.note } : {}),
                    }));
                if (!results.length) return errorResponse("results 为空——逐条 {key,verdict}（key/初判用 recon 返回的）");
                const store = await loadScheduleForWrite();
                if (!store) return errorResponse("班表直读失败（防旧档覆盖已放弃本轮）——稍后重试");
                const next = recordRecon(pruneSchedule(store, today), day, results, new Date());
                await saveSchedule(next, `recon ${day}`);
                return successResponse({ day, recorded: results.length, note: "当日待确认拖动已一并消费" });
            }

            if (action === "schedule_get") {
                let items: SchedItem[];
                if (isValidDay(input.from) && isValidDay(input.to)) {
                    items = (await readRangeItems(input.from, input.to))
                        .sort((a, b) => (a.date + (a.start ?? "99")).localeCompare(b.date + (b.start ?? "99")));
                } else {
                    const day = dayOf(today);
                    items = ((await readDayItems(day)) ?? []).sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99"));
                }
                return successResponse({ day: isValidDay(input.day) ? input.day : today, count: items.length, items });
            }

            if (action === "schedule_set") {
                const day = dayOf(today); // 缺省=今天；写明日方案须显式 day（提示词教育段已约定）
                // 期 3 闪卡波次：flash 载荷分离消化（拍板=进 schedule_set 一步到位）。
                // 输入条目带 flash:{quota}→侦察目标日到期池→加权均分波→产出实际波次条目
                // （文本「闪卡·第N波X张」+清单挂块属性）→既有链落块→落块成功后批量改 due。
                const rawArr: any[] = Array.isArray(input.items) ? input.items : [];
                const flashRaw = rawArr.filter((x) => x && typeof x === "object" && x.flash != null);
                const plainRaw = rawArr.filter((x) => !(x && typeof x === "object" && x.flash != null));
                const flashWaves: Array<{ start: string; end: string | null; hard: boolean; quota: number; base: string }> = [];
                for (const x of flashRaw) {
                    const fl = normFlashInput(x.flash);
                    if (!fl) return errorResponse('flash 载荷须 {quota:正整数}——闪卡波次条目形如 {summary:"闪卡", start:"10:00", flash:{quota:20}}');
                    if (!isValidHM(x?.start)) return errorResponse("闪卡波次条目必须带 start（波次时刻=due 规整落点，无时刻没法分波）");
                    if (typeof x?.key === "string" && x.key) return errorResponse("波次条目不支持 key 单改（同日两条波=清单重叠+保护线互踩）——重排波次=clear_from 后整批重写");
                    flashWaves.push({
                        start: x.start,
                        end: isValidHM(x?.end) ? x.end : null,
                        hard: x?.hard === true,
                        quota: fl.quota,
                        base: typeof x?.summary === "string" && x.summary.trim() ? x.summary.trim().slice(0, 50) : "闪卡",
                    });
                }
                flashWaves.sort((a, b) => a.start.localeCompare(b.start)); // 时刻序=波次号（1 起）
                const parsed = normItemsInput(day, plainRaw, new Date());
                // ammo □4：班表=锚点域——弹性任务退役时刻语义（hard=false 且非闪卡波次=弹性→拒+教育改道）
                const elastic = parsed.filter((it) => !it.hard && !it.flash);
                if (elastic.length) {
                    return errorResponse(
                        `班表已退役弹性时刻条目（${elastic.length} 条：${elastic.slice(0, 3).map((e) => e.summary).join("、")}${elastic.length > 3 ? "…" : ""}）——弹性任务只有配额没有时刻（弹药库 v2）。`
                        + "锚点（接送/会议等窗口硬的事）进 items（hard:true 带 start）；弹性任务配弹药改传 ammo 载荷 {pools:[{pool,ratio?,freq?}],tasks:[{task,pool,quota?,summary}]}——task 从 plan_context 的 forest 段拿（树任务块 id）",
                    );
                }
                // ammo 载荷归一前置（纯校验零副作用——载荷错=整轮拒，锚点不白写）
                let ammoConfig: AmmoDayConfig | null = null;
                if (input.ammo != null) {
                    const norm = normAmmoPayload(input.ammo, day);
                    if (!("config" in norm)) return errorResponse(norm.error); // strict:false 判别用 in（AGENTS 坑）
                    ammoConfig = norm.config;
                }
                if (!parsed.length && !flashWaves.length && !ammoConfig) return errorResponse('载荷空——锚点进 items（{summary,start,end,hard:true}），弹性任务配弹药进 ammo（{pools,tasks}）');
                // ── ammo □5：弹药先落（交接会落盘三件套顺序=森林增量→象限配置→锚点日程；单次调用内
                // 配置先落再落锚点——锚点链末端带提醒/飞书外效，配置未稳前不外发；失败方向可恢复=
                // 每步幂等，断点重跑自愈（□17 先例）。守卫拒=整轮拒（锚点未写零污染——比 □4 的
                // 「锚点已落再拒」更干净）；森林不可用/写异常=ammoWarning 放行锚点链（重跑自愈）。 ──
                let ammoNote: string | undefined;
                let ammoWarning: string | undefined;
                if (ammoConfig) {
                    try {
                        const scout = await scanForest();
                        if (!scout.available) {
                            ammoWarning = `森林域不可用（${scout.note}）——ammo 载荷未写，锚点链不受影响；稍后重跑 schedule_set（items 省略+ammo 原样，幂等）`;
                        } else {
                            const knownTasks = new Set(scout.trees.flatMap((t) => t.tasks.map((x) => x.id)));
                            const w = await writeDayConfig(day, ammoConfig, { knownTasks });
                            if (!w.ok) {
                                return errorResponse(
                                    `${w.violations ? `每日配置守卫：${w.violations.join("；")}` : `ammo 写入失败：${w.error}`}——锚点 items 未写（弹药先落序）；修正后重跑（ammo 修正+items 原样，幂等）`,
                                );
                            }
                            ammoNote = `弹药已配：${ammoConfig.pools.length} 池行+${ammoConfig.tasks.length} 任务行（${HOME_DAYCONFIG_HPATH}/${day.slice(0, 7)}/${day}，幂等整组重放）`;
                        }
                    } catch (e: any) {
                        ammoWarning = `ammo 载荷写入异常：${String(e?.message ?? e)}——锚点链继续；重跑 schedule_set 自愈（ammo 幂等）`;
                    }
                }
                // 侦察+分波（只读侦察可前置；改 due 严格等落块成功后）
                let flashPlans: FlashWavePlan[] = [];
                let flashScout: FlashScout | null = null;
                if (flashWaves.length) {
                    flashScout = await scoutFlashPool(day);
                    flashPlans = splitFlashWaves(flashScout.blocks, flashWaves.map((w) => w.quota));
                }
                const at = new Date().toISOString();
                // P2-1 空波跳号重编号：池<波数时空波不落条目，落条目的波按 1..N 连续
                //（否则「闪卡·第 3 波」而无 1/2 波——呈现惑）
                let waveSeq = 0;
                flashPlans.forEach((p, i) => {
                    if (p.cards <= 0) return; // 空波不落条目（池耗尽）
                    waveSeq += 1;
                    p.wave = waveSeq;
                    const w = flashWaves[i];
                    const due14 = flashDueTimestamp(day, w.start);
                    // 排班动作时刻（本地钟面 14 位——与内核 due/lastReview 的 RFC3339 本地字面同钟面可比；勿用 toISOString=UTC 错位 8h）
                    const nD = new Date();
                    const p2 = (x: number) => String(x).padStart(2, "0");
                    const at14 = `${nD.getFullYear()}${p2(nD.getMonth() + 1)}${p2(nD.getDate())}${p2(nD.getHours())}${p2(nD.getMinutes())}${p2(nD.getSeconds())}`;
                    parsed.push({
                        key: newSchedKey(),
                        summary: flashWaveSummary(w.base, p.wave, p.cards),
                        date: day,
                        start: w.start,
                        end: w.end,
                        hard: w.hard,
                        origin: "ai",
                        // due=首排规整时刻、at=排班动作时刻（两线合成微调重规整保护线：
                        // 推迟过的/排班后刷过的卡不覆盖 FSRS 调度）
                        flash: { wave: p.wave, cards: p.cards, blocks: p.blocks, ...(due14 ? { due: due14 } : {}), ...(at14 ? { at: at14 } : {}) },
                        createdAt: at,
                        updatedAt: at,
                    });
                });
                if (input.replace === true && typeof input.clear_from === "string") {
                    return errorResponse("replace 与 clear_from 互斥——整日重排用 replace，从某时刻起重排用 clear_from");
                }
                // 期 4 块化：写前读当日块行（replace/clear_from 的清除基线）+守卫视图（近两周——
                // 结构守卫的上周锚族基线+本周已用变动）
                const dayRows = await readDayItems(day);
                if (dayRows == null) return errorResponse("当日班表块读失败（防空基底整日替换，已放弃本轮）——稍后重试");
                const prevView = await assembleSchedView(addDays(weekStartOf(day), -7), shiftDay(weekStartOf(day), 13)); // P2-3：视图盖上周+目标周全周（守卫中位数/移除判据的原料面）
                let dayTarget: SchedItem[] = dayRows;
                let clearedFrom: string | null = null;
                if (input.replace === true) {
                    // 整日重排=当日既有行全清（adopt 行=外部承诺保留——锚点豁免同 clear_from 语义）
                    dayTarget = dayRows.filter((i) => i.origin === "adopt");
                } else if (typeof input.clear_from === "string") {
                    // □26 崩盘重排原子化：now 解析=调用时刻；清 start≥该时刻（已过保留=对账证据，托盘 null 不动）
                    const now = new Date();
                    if (input.clear_from === "now" && day !== today) {
                        return errorResponse('clear_from:"now" 仅当日（别日重排用显式 "HH:mm"）');
                    }
                    const cf = input.clear_from === "now"
                        ? `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
                        : isValidHM(input.clear_from) ? input.clear_from : null;
                    if (!cf) return errorResponse('clear_from 须 "HH:mm" 或 "now"');
                    const r = clearDayRows(dayRows, cf);
                    dayTarget = r.rows;
                    clearedFrom = `${cf}（清 ${r.cleared.length} 条）`;
                }
                for (const it of parsed) {
                    // 有 key=改（沿用 createdAt/origin）；无 key=增——key=临时键，落块后由 keyRemap 迁成块 id。
                    // 跨日 keyed 改写显式拒绝（P2-4：判据查多日视图——当日池 date 恒=目标日，恒假判
                    // 不住他日 key；块链跨日改写只会造双日双行双事件，挪日=删旧+新写两条）
                    const prevAny = prevView.items[it.key];
                    if (prevAny && prevAny.date !== day) return errorResponse(`key=${it.key} 属 ${prevAny.date} 的条目——跨日挪动请删旧条目（schedule_remove）后在新日重写`);
                    const prev = [...dayTarget, ...dayRows].find((x) => x.key === it.key);
                    if (prev) dayTarget = [...dayTarget.filter((x) => x.key !== it.key), { ...it, origin: prev.origin, rolledFrom: prev.rolledFrom, createdAt: prev.createdAt }];
                    else dayTarget = [...dayTarget, it];
                }
                // □8 期 6 结构慢变守卫（铁律 6 代码级）：本周锚点变动 vs 上周 ≤2，超出=拒绝——
                // 提示词约束升级；只拦 AI 写面（用户拖动/手改不走本工具不受限）。基线回退链=
                // 上周班表锚族 → onboard 初版粗排（首周）→ 皆无=放行
                const onboardForGuard = normalizeOnboard(await petalGetJsonFresh(ONBOARD_FILE).catch(() => null));
                const targetRecord = Object.fromEntries(dayTarget.map((i) => [i.key, i]));
                const guardItems = { ...prevView.items, ...targetRecord };
                const guard = guardStructure({ prevItems: prevView.items, items: guardItems, day, fallbackDraft: onboardForGuard?.baseline?.draft ?? null });
                if (!guard.ok) {
                    return errorResponse(
                        `结构慢变守卫：本周（${weekStartOf(day)} 起）锚点变动将达 ${guard.used} 处（上限 ${guard.limit}）——${guard.deviations.join("；")}。`
                            + "结构一周最多动一两个锚点：请把方案收敛到 ≤2 处锚点变动（内容条目的增删换不受限），其余结构改动留到下周；"
                            + "用户明确要更多变动的话，让他自己在班表/日历里拖动或手改（用户操作不受守卫限制）。",
                    );
                }
                // review P2-1：keyed 改写跨周（date 被强制到目标日）=原周失去该锚——原周补跑移除侧守卫
                for (const it of parsed) {
                    const prev = prevView.items[it.key];
                    if (!prev || prev.date === it.date || weekStartOf(prev.date) === weekStartOf(day)) continue;
                    const g2 = guardStructure({ prevItems: prevView.items, items: guardItems, day: prev.date, fallbackDraft: onboardForGuard?.baseline?.draft ?? null });
                    if (!g2.ok) {
                        return errorResponse(
                            `结构慢变守卫：把「${prev.summary}」从原周（${weekStartOf(prev.date)} 起）挪到目标周（${weekStartOf(day)} 起）将使原周锚点变动达 ${g2.used} 处（上限 ${g2.limit}）——${g2.deviations.join("；")}。跨周挪锚=结构变动，请收敛或留待下周。`,
                        );
                    }
                }
                // 期 1 块化：当日终态落日志块（/Project/日志/<day> 的班表列表——块=唯一真身）。
                // key=块 id 双写主键：新插条目拿块 id（keyRemap）；块链路失败=回参警告自愈
                // （班表区整批重写幂等，重跑 schedule_set 即恢复）。
                let diaryNote: string | undefined;
                let diaryWarning: string | undefined;
                let writtenRows: SchedItem[] = dayTarget;
                try {
                    const { items: remapped, board } = await syncDayBoardToDiary(day, targetRecord);
                    if (board.ok) {
                        writtenRows = Object.values(remapped).filter((i) => i.date === day);
                        diaryNote = `日志块已写：日志/${day}（增 ${board.inserted} 改 ${board.updated} 删 ${board.deleted}）`;
                    } else {
                        diaryWarning = `日志块写入失败：${board.error}（本轮回参条目未落块——重跑 schedule_set 自愈）`;
                    }
                } catch (e: any) {
                    diaryWarning = `日志块写入异常：${e?.message ?? e}（本轮回参条目未落块——重跑 schedule_set 自愈）`;
                }
                // 期 3：波次 due 规整——严格等块写成功（块=波次真身锚：custom-sched-flash 清单
                // 挂块上，块没落=规整了也无处锚定微调/对账）。失败不阻塞主链=回参警告自愈。
                let flashNote: string | undefined;
                let flashWarning: string | undefined;
                if (flashPlans.some((p) => p.cards > 0)) {
                    if (diaryWarning) {
                        flashWarning = "波次 due 未规整：日志块写入失败（波次条目缺块真身锚）——重跑 schedule_set 波次自愈";
                    } else {
                        const applied: string[] = [];
                        for (let i = 0; i < flashPlans.length; i++) {
                            const p = flashPlans[i];
                            if (p.cards <= 0) continue;
                            const due14 = flashDueTimestamp(day, flashWaves[i].start);
                            const r = await applyFlashDue(p.blocks, due14);
                            if (r.ok) applied.push(`第${p.wave}波 ${flashWaves[i].start}×${r.cards}张${r.skippedPostponed ? `（番茄推迟跳过${r.skippedPostponed}块）` : ""}`);
                            else flashWarning = `波次 due 规整失败（第${p.wave}波）：${r.error}——班表条目已写，到点前重跑 schedule_set 波次或用番茄工具箱推迟闪卡自愈`;
                        }
                        if (applied.length) flashNote = `闪卡波次已规整（池 ${flashScout?.cards ?? 0} 张）：${applied.join("；")}`;
                    }
                } else if (flashWaves.length) {
                    if (flashScout?.errors?.length) {
                        flashWarning = `闪卡侦察异常（${flashScout.errors.length} 项，如 ${flashScout.errors[0].slice(0, 80)}）——目标日到期池可能被低估（波次未排），稍后重跑 schedule_set 自愈`;
                    } else {
                        flashNote = `目标日无到期闪卡（池 0 张），波次未排——卡池为空时波次条目不落班表`;
                    }
                }
                // 班表块属性已落→remind 链搭车推飞书事件（fire-and-forget 不阻塞回参；
                // 串行守卫防叠）——期 4 起班表事件由 remind 链管辖。
                // 直喂行绕 attributes 索引窗：fire-and-forget 立即扫时新块尚未进 SQL 发现面
                // （09-20 首晨实弹：写完账本零绑定，手动踢同通道才推上）——writtenRows 直喂。
                void runRemindSyncGuarded(lokiSchedLogger(), new Date(), schedItemsToRemindHintRows(writtenRows));
                const dayItems = [...writtenRows].sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99"));
                return successResponse({
                    day,
                    written: parsed.length,
                    ...(clearedFrom ? { clearedFrom } : {}),
                    ...(guard.used > 0 ? { structure: { used: guard.used, limit: guard.limit } } : {}),
                    ...(diaryNote ? { diary: diaryNote } : {}),
                    ...(diaryWarning ? { diaryWarning } : {}),
                    ...(flashNote ? { flash: flashNote } : {}),
                    ...(flashWarning ? { flashWarning } : {}),
                    ...(ammoNote ? { ammo: ammoNote } : {}),
                    ...(ammoWarning ? { ammoWarning } : {}),
                    items: dayItems,
                    note: `已写入：锚点 items→日志班表块（日志/<day>——块=唯一真身，进日历/提醒链）；弹性任务 ammo→森林域每日配置块（池配比+任务挂载，整组重放幂等）`,
                });
            }

            if (action === "schedule_remove") {
                const keys: string[] = Array.isArray(input.keys) ? input.keys.filter((k: any) => typeof k === "string") : [];
                if (!keys.length) return errorResponse("keys 为空——用 schedule_get 先查 key");
                // 期 4 块化：key=块 id，命中判据=班表视图在场（过去 61 天+未来 14 天——
                // P1-3：终点须含未来域，AI 排好的明日班表才删得掉）
                const view = await assembleSchedView(addDays(today, -(62 - 1)), addDays(today, 14));
                const removed = keys.filter((k) => Boolean(view.items[k]));
                const missed = keys.filter((k) => !removed.includes(k));
                if (!removed.length) return successResponse({ removed: [], missed, note: "没有命中任何条目" });
                // □8 结构守卫（schedule_set 同款）：删锚点族=结构变动，逐受影响周判一次
                const onboardForGuard = normalizeOnboard(await petalGetJsonFresh(ONBOARD_FILE).catch(() => null));
                const afterItems = { ...view.items };
                for (const k of removed) delete afterItems[k];
                for (const k of removed) {
                    const it = view.items[k];
                    if (!it) continue;
                    const guard = guardStructure({ prevItems: view.items, items: afterItems, day: it.date, fallbackDraft: onboardForGuard?.baseline?.draft ?? null });
                    if (!guard.ok) {
                        return errorResponse(
                            `结构慢变守卫：删除将使本周（${weekStartOf(it.date)} 起）锚点变动达 ${guard.used} 处（上限 ${guard.limit}）——${guard.deviations.join("；")}。`
                                + "结构一周最多动一两个锚点：锚点条目先留着（可不排时刻入托盘），其余结构改动留到下周；用户明确要删的话让他自己在班表里删（用户操作不受守卫限制）。",
                        );
                    }
                }
                // 删块（块=唯一真身；块 id 形态才调——防御非块 id 键混入视图；失败吞=幂等——
                // 块已不在=目标态已达成，残留=下轮该日 diff 重放收编）
                for (const k of removed) {
                    if (!/^\d{14}-[a-z0-9]+$/.test(k)) continue;
                    try {
                        await deleteBlock(k);
                    } catch {
                        // 幂等吞
                    }
                }
                void runRemindSyncGuarded(lokiSchedLogger()); // 块删→remind 链剪枝清事件搭车
                return successResponse({ removed, missed });
            }

            if (action === "pref_get") {
                const store = await loadSchedule();
                return successResponse({ prefs: store.prefs, note: "排明日方案时遵守的长期偏好（拖动点头/口述沉淀）" });
            }

            // pref_add
            const text = typeof input.text === "string" ? input.text.trim() : "";
            if (!text) return errorResponse("text 为空——偏好一句话，如「写作固定 11:00–12:30」");
            const origin = input.origin === "drag-confirm" || input.origin === "user" ? input.origin : "chat";
            const store = await loadScheduleForWrite();
            if (!store) return errorResponse("班表直读失败（防旧档覆盖已放弃本轮）——稍后重试");
            const next = addPref(store, text, origin, new Date());
            if (next === store) return successResponse({ prefs: store.prefs, note: "同文偏好已存在，未重复写" });
            await saveSchedule(next, `pref +1`);
            return successResponse({ prefs: next.prefs });
        }),
    };
}
