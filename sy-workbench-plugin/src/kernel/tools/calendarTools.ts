import { sql } from "../api";
import { getLogicalDay } from "../core/dates";
import { isDone } from "../core/progressCalc";
import { buildAllDayEventPayload, maskConfig, normalizeConfig, type FeishuConfig, type SyncTaskInput } from "../core/feishu";
import { LEDGER_SOURCES, taskKey, type LedgerSource } from "../core/ledger";
import {
    buildAuthorizeUrl,
    deleteLedgerEvent,
    exchangeCode,
    loadConfig,
    loadLedger,
    runProbe,
    saveConfig,
    saveLedger,
    syncTask,
    upsertEventByKey,
} from "../feishu";
import { OAUTH_REDIRECT_URI } from "../../shared/channels";
import { errorResponse, successResponse, objectSchema, wrapHandler, type ToolDefinition } from "./common";
import { buildTaskListSql, type TaskQueryRow } from "./taskTools";

const ACTIONS = ["set_config", "oauth_start", "get_config", "test", "sync", "unlink", "upsert", "sources", "set_sources"] as const;

/** 凭证类字段：任一在场=改动凭证→必须过体检才落盘；只调排程类字段则合入旧配置直接存 */
const CREDENTIAL_FIELDS = ["channel", "appId", "appSecret", "userOpenId", "code", "redirectUri"] as const;

const DEFAULT_REDIRECT_URI = OAUTH_REDIRECT_URI;

function assertBlockId(id: unknown, field: string): string {
    if (typeof id !== "string" || !/^20\d{12}-[0-9a-z]{7}$/.test(id)) {
        throw new Error(`字段 ${field} 必须是思源块 id（yyyymmddhhmmss-xxxxxxx）`);
    }
    return id;
}

/** 单任务行（SQL 携属性 GROUP_CONCAT）→同步输入 */
function rowToSyncTask(r: TaskQueryRow): SyncTaskInput {
    return {
        blockId: r.id,
        content: r.content,
        dueDate: r.due_date ?? undefined,
        dueTime: r.due_time ?? undefined,
        // □16 区间任务：start 侧齐则镜像起止区间
        ...(r.start_date ? { startDate: r.start_date } : {}),
        ...(r.start_time ? { startTime: r.start_time } : {}),
        done: isDone({ id: r.id, content: r.content, markdown: r.markdown, updated: r.updated, root_id: r.root_id }),
    };
}

export function createCalendarTool(): ToolDefinition {
    return {
        name: "calendar",
        config: objectSchema(
            "飞书日历同步（任务带截止→自动建飞书日程，到点飞书服务端推送提醒——思源关着也到达）。"
            + "有限双向：due 变→改事件；飞书侧改时间→启动扫描回写属性；完成/清 due→删事件；取消勾选不自动恢复（重新 schedule 或 sync）。"
            + "Actions: set_config(收配置即体检——换token/列日历/建删测试日程三步，卡哪步把飞书报错原文给你，99991672 自带一键开权限链接; "
            + "开发者后台各步直达（拿 appId 拼 open.feishu.cn/app/<appId>/<段>——凭证与基础信息=baseinfo、权限管理=permission、安全设置=security；用户卡在找页面时把对应链接给他）; "
            + "主推 B 通道：先 oauth_start 拿授权链接给用户，授权回来带 code 走 {channel:\"oauth\", appId, appSecret, code}；"
            + "备选 A′ 通道：{channel:\"bot\", appId, appSecret, userOpenId}——共享日历「思源任务」，适合低频用户（免 30 天重授权）或不想日程进主日历要独立可隐藏日历者；"
            + "只调 enabled/reminderMinutes/calendarName 免体检), oauth_start(B 通道授权链接+安全设置直达), get_config(脱敏概览), "
            + "test(重跑体检), sync(taskId 单任务对齐 / projectId 全项目对齐+孤儿映射报告), unlink(taskId 摘钩子删事件), "
            + "upsert(keyed 全天事件建/改/删：同 key 幂等、remove:true 删、recurrence 建循环日程——闪卡今日负担事件由内核每日启动自动维护〔key=flashcard-burden:<projectId>:<日>〕，手动调仅排障), "
            + "sources(查四源开关：块提醒/任务截止/闪卡负担/班表镜像 各 enabled+allowWriteback), "
            + "set_sources(source+enabled/allowWriteback 改单源开关——enabled=false=整源停含剪枝；回写位=飞书改时间回写思源属性；闪卡负担恒关；班表镜像源整体不可 AI 改〔enabled/回写位均由设置页后端选择链对齐〕)."
            + "⚠️ B=用户主日历+提醒精确到分钟（含全天）；A′=bot 视角建共享日历并把你加为 writer（接受分享卡片后侧边栏可见），userOpenId 须是本应用视角的 open_id。",
            {
                action: { type: "string", enum: [...ACTIONS], description: "操作类型" },
                channel: { type: "string", enum: ["bot", "oauth"], description: "set_config: 主推 B=oauth（用户主日历）/ 备选 A′=bot（共享日历；不传按 bot 处理，走 B 请显式传 oauth）" },
                appId: { type: "string", description: "飞书开放平台 App ID" },
                appSecret: { type: "string", description: "App Secret（落盘 petal，回参永不回显）" },
                userOpenId: { type: "string", description: "A′: 你的 open_id（ou_ 前缀，本应用视角）" },
                calendarId: { type: "string", description: "set_config: 过继既有共享日历 id（丢配置找回用；默认自动新建）" },
                code: { type: "string", description: "oauth: 授权跳转带回的 code" },
                redirectUri: { type: "string", description: `oauth: 回调地址（默认 ${DEFAULT_REDIRECT_URI}，须与开放平台「安全设置」登记一致）` },
                calendarName: { type: "string", description: "共享日历名（默认 思源任务）" },
                reminderMinutes: { type: "number", description: "timed 日程提前 N 分钟提醒（默认 30；A′=bot 视角参考值，用户实收提醒走其飞书客户端默认设置；B/oauth=直接以用户身份生效）" },
                enabled: { type: "boolean", description: "同步总开关（false=任务操作不再挂日历）" },
                taskId: { type: "string", description: "sync/unlink: 任务块 id" },
                projectId: { type: "string", description: "sync: 项目主文档 id（全项目对齐）" },
                key: { type: "string", description: "upsert: keyed 事件稳定标识（如 flashcard-burden:<projectId>:<YYYY-MM-DD>）" },
                summary: { type: "string", description: "upsert: 事件标题" },
                description: { type: "string", description: "upsert: 事件描述（可选）" },
                date: { type: "string", description: "upsert: 全天事件日期 YYYY-MM-DD（默认今日）" },
                recurrence: { type: "string", description: "upsert: 重复规则 RRULE 纯串（FREQ= 开头、无 RRULE: 前缀；如 FREQ=DAILY 每天 / FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR 工作日）；空串=清成单次；不传=不改重复性" },
                remove: { type: "boolean", description: "upsert: true=删该 key 事件" },
                source: { type: "string", enum: [...LEDGER_SOURCES], description: "set_sources: 源名（remind=块提醒/task=任务截止/burden=闪卡负担/sched=班表镜像）" },
            },
            ["action"],
        ),
        handler: wrapHandler(async (input) => {
            const action = input?.action;
            if (!ACTIONS.includes(action)) return errorResponse(`未知 action: ${action}`);

            if (action === "set_config") {
                const touchedCredentials = CREDENTIAL_FIELDS.some((f) => input[f] !== undefined);
                const existing = await loadConfig();
                if (!touchedCredentials) {
                    if (!existing) return errorResponse("从未配置过凭证——先带 appId/appSecret/userOpenId 走一次完整 set_config");
                    const merged = normalizeConfig({
                        ...existing,
                        ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
                        ...(typeof input.reminderMinutes === "number" ? { reminderMinutes: input.reminderMinutes } : {}),
                        ...(typeof input.calendarName === "string" && input.calendarName.trim() ? { calendarName: input.calendarName } : {}),
                    });
                    // 改名可能指向另一块日历，calendarId 失配——清掉强制懒解析重定位
                    const next = typeof input.calendarName === "string" && input.calendarName.trim() && input.calendarName.trim() !== existing.calendarName
                        ? { ...merged, calendarId: undefined }
                        : merged;
                    await saveConfig(next);
                    return successResponse({ config: maskConfig(next), probe: existing.lastProbe ?? null, note: "未跑体检（未动凭证）" });
                }

                // 凭证路径：拼全量→（oauth 先换 token）→体检→过才落盘
                const channel = input.channel === "oauth" ? "oauth" : "bot";
                let oauth;
                if (channel === "oauth") {
                    if (!input.code) return errorResponse("oauth 通道须带 code——先 calendar.oauth_start 拿授权链接，浏览器授权后把跳转回来的 code 传这里");
                    oauth = await exchangeCode(
                        String(input.appId ?? existing?.appId ?? ""),
                        String(input.appSecret ?? existing?.appSecret ?? ""),
                        String(input.code),
                        String(input.redirectUri ?? DEFAULT_REDIRECT_URI),
                    );
                }
                const candidate = normalizeConfig({
                    ...(existing ?? {}),
                    channel,
                    ...(input.appId !== undefined ? { appId: input.appId } : {}),
                    ...(input.appSecret !== undefined ? { appSecret: input.appSecret } : {}),
                    ...(input.userOpenId !== undefined ? { userOpenId: input.userOpenId } : {}),
                    ...(input.calendarName !== undefined ? { calendarName: input.calendarName } : {}),
                    ...(input.reminderMinutes !== undefined ? { reminderMinutes: input.reminderMinutes } : {}),
                    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
                    ...(oauth ? { oauth } : {}),
                    ...(typeof input.calendarId === "string" && input.calendarId ? { calendarId: input.calendarId } : { calendarId: undefined }), // 显式过继既有日历（bot 通道 list 恒空，按名复用失效——丢配置找回的唯一通道）
                });
                const probe = await runProbe(candidate);
                if (!probe.ok) {
                    return errorResponse(`体检未过（${probe.failedStep} 步）：${probe.detail}\n——配置未保存，按报错处理后重试 set_config`);
                }
                const finalCfg: FeishuConfig = {
                    ...candidate,
                    calendarId: probe.resolvedCalendarId ?? candidate.calendarId,
                    lastProbe: { at: new Date().toISOString(), ok: true, step: "all" },
                };
                await saveConfig(finalCfg);
                return successResponse({
                    config: maskConfig(finalCfg),
                    probe,
                    createdCalendar: probe.createdCalendar ? "已新建共享日历并把你加为 writer 成员——飞书会给你发「日历分享」卡片，接受后侧边栏可见" : undefined,
                });
            }

            if (action === "oauth_start") {
                const appId = typeof input.appId === "string" ? input.appId : (await loadConfig())?.appId;
                const appSecret = typeof input.appSecret === "string" ? input.appSecret : (await loadConfig())?.appSecret;
                if (!appId || !appSecret) return errorResponse("oauth_start 须带 appId/appSecret（或已有配置可复用时省略）");
                const redirectUri = String(input.redirectUri ?? DEFAULT_REDIRECT_URI);
                const state = Math.random().toString(36).slice(2, 10);
                const authorizeUrl = buildAuthorizeUrl(appId, redirectUri, state);
                const securitySettingsUrl = `https://open.feishu.cn/app/${appId}/security`;
                return successResponse({
                    authorizeUrl,
                    redirectUri,
                    securitySettingsUrl,
                    next: `① 先把回调地址 ${redirectUri} 登记进安全设置（securitySettingsUrl 直达；已登记可跳过）→ ② 浏览器打开 authorizeUrl 并同意 → ③ 跳转到 ${redirectUri}?code=...&state=${state}（页面打不开没关系，地址栏有 code）→ ④ 把 code 传给 calendar.set_config {channel:"oauth", appId, appSecret, code}`,
                    note: "前提：开放平台已开通日历权限（calendar:calendar）",
                });
            }

            if (action === "get_config") {
                const cfg = await loadConfig();
                if (!cfg) return errorResponse("未配置——主推 B 通道：calendar.oauth_start 拿授权链接给用户，回来带 code 走 set_config；备选 A′：set_config 三件套 appId/appSecret/userOpenId");
                const ledger = await loadLedger();
                return successResponse({ config: maskConfig(cfg), mappingCount: Object.keys(ledger.entries).length, sources: ledger.sources });
            }

            if (action === "test") {
                const cfg = await loadConfig();
                if (!cfg) return errorResponse("未配置——先 calendar.set_config");
                const probe = await runProbe(cfg);
                await saveConfig({ ...cfg, lastProbe: { at: new Date().toISOString(), ok: probe.ok, step: probe.failedStep ?? "all", detail: probe.detail } });
                return probe.ok ? successResponse({ probe }) : errorResponse(`体检未过（${probe.failedStep} 步）：${probe.detail}`);
            }

            if (action === "sync") {
                const cfg = await loadConfig();
                if (!cfg) return errorResponse("日历未配置——calendar.set_config 一次配好（任务不受影响，只是没挂提醒）");
                if (input.taskId) {
                    const taskId = assertBlockId(input.taskId, "taskId");
                    // start 列必带（reasoning P1-1）：rowToSyncTask 缺 start → 区间任务被本补挂通道
                    // 按锚点 payload PATCH 推平（schedule 提示语给的正是这条路）
                    const rows = await sql<TaskQueryRow>(
                        `SELECT b.id, TRIM(b.content) AS content, b.markdown, b.updated, b.root_id,
                        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-date' THEN a.value END) AS due_date,
                        GROUP_CONCAT(CASE WHEN a.name='custom-task-due-time' THEN a.value END) AS due_time,
                        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-date' THEN a.value END) AS start_date,
                        GROUP_CONCAT(CASE WHEN a.name='custom-task-start-time' THEN a.value END) AS start_time
                        FROM blocks b
                        LEFT JOIN attributes a ON a.block_id=b.id AND a.name IN ('custom-task-due-date','custom-task-due-time','custom-task-start-date','custom-task-start-time')
                        WHERE b.id='${taskId}' GROUP BY b.id`,
                    );
                    if (!rows[0]) return errorResponse(`任务不存在: ${taskId}（刚建/刚改的任务有 3~10s SQL 索引延迟，稍等再 sync；task.create/schedule 本身已顺手同步过）`);
                    const result = await syncTask(rowToSyncTask(rows[0]), cfg);
                    return successResponse({ result, calendarId: cfg.calendarId });
                }
                if (input.projectId) {
                    const projectId = assertBlockId(input.projectId, "projectId");
                    const pathRows = await sql<{ id: string; path: string }>(`SELECT id, path FROM blocks WHERE id='${projectId}'`);
                    if (!pathRows[0]?.path) return errorResponse(`项目不存在: ${projectId}`);
                    const rows = await sql<TaskQueryRow>(buildTaskListSql(projectId, pathRows[0].path, 500));
                    const ledger = await loadLedger();
                    const results = [];
                    for (const row of rows) {
                        const task = rowToSyncTask(row);
                        const mapping = ledger.entries[taskKey(task.blockId)];
                        if (task.dueDate || mapping) {
                            try {
                                results.push({ taskId: task.blockId, ...(await syncTask(task, cfg)) });
                            } catch (e: any) {
                                results.push({ taskId: task.blockId, action: "error", error: e?.message ?? String(e) });
                            }
                        }
                    }
                    const live = new Set(rows.map((r) => r.id));
                    const stale = Object.keys(ledger.entries)
                        .filter((k) => k.startsWith("task:"))
                        .map((k) => k.slice("task:".length))
                        .filter((id) => !live.has(id));
                    return successResponse({ synced: results, stale: stale.length ? stale : undefined, staleNote: stale.length ? "这些映射的任务块已不在项目里（被删/搬走）——确认不要了就逐个 calendar.unlink 摘掉" : undefined });
                }
                return errorResponse("sync 须带 taskId（单任务）或 projectId（全项目）");
            }

            if (action === "upsert") {
                const key = typeof input.key === "string" ? input.key.trim() : "";
                if (!key) return errorResponse("upsert 须带 key（keyed 事件稳定标识，如 flashcard-burden:<projectId>:<YYYY-MM-DD>）");
                const cfg = await loadConfig();
                if (!cfg) return errorResponse("日历未配置——先 calendar.set_config");
                if (input.remove === true) {
                    const result = await upsertEventByKey(key, null, cfg);
                    return successResponse({ key, result });
                }
                const summary = typeof input.summary === "string" ? input.summary.trim() : "";
                if (!summary) return errorResponse("upsert 须带 summary（或 remove:true 删除）");
                let date: string;
                if (typeof input.date === "string" && input.date.trim()) {
                    date = input.date.trim();
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errorResponse(`date 须 YYYY-MM-DD: ${date}`);
                } else {
                    date = getLogicalDay(new Date());
                }
                const description = typeof input.description === "string" && input.description.trim() ? input.description.trim() : undefined;
                // □19 RRULE：非空须 FREQ= 开头纯串（带 RRULE: 前缀/数组形态飞书 9499 拒）；
                // ""=显式清成单次；不传=不带字段（PATCH 不动旧重复规则）。
                // 非 string（数组/null/number）显式拒——静默当不传会建出单次+success 假绿（review P1-1）
                let recurrence: string | undefined;
                if (input.recurrence !== undefined && typeof input.recurrence !== "string") {
                    return errorResponse(`recurrence 须字符串（FREQ= 开头 RRULE 纯串），收到 ${Array.isArray(input.recurrence) ? "数组" : input.recurrence === null ? "null" : typeof input.recurrence}——逐项合并成一条分号串`);
                }
                if (typeof input.recurrence === "string") {
                    recurrence = input.recurrence.trim();
                    if (recurrence && !/^FREQ=/.test(recurrence)) {
                        return errorResponse(`recurrence 须 FREQ= 开头的 RRULE 纯串（无 RRULE: 前缀），如 FREQ=DAILY / FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR：${recurrence.slice(0, 60)}`);
                    }
                }
                const payload = buildAllDayEventPayload(summary, date, description, recurrence);
                const result = await upsertEventByKey(key, payload, cfg);
                return successResponse({ key, date, ...(recurrence !== undefined ? { recurrence } : {}), result, calendarId: cfg.calendarId });
            }

            if (action === "sources") {
                const ledger = await loadLedger();
                return successResponse({
                    sources: ledger.sources,
                    note: "enabled=false=整源跳过含剪枝（pause：已建事件留飞书侧不动）；allowWriteback=飞书改时间是否回写思源属性（三态比较：只思源变推飞书/只飞书变回写/双变思源赢+冲突计数）。闪卡负担=派生数据恒不回写",
                });
            }

            if (action === "set_sources") {
                const source = input.source;
                if (!LEDGER_SOURCES.includes(source)) return errorResponse(`source 必须是 ${LEDGER_SOURCES.join("/")}（got: ${source}）`);
                const src = source as LedgerSource;
                if (src === "sched") {
                    // P2-2（□25 review）：enabled 位同样拒改——AI 拨了 sched 源开关，下轮 apply 按
                    // sched-mirror-conf 对齐写回=flip-flop 振荡。sched 源整条归设置页后端选择链唯一写
                    return errorResponse("班表镜像源（enabled/allowWriteback）由设置页「班表外部日历镜像」后端选择自动对齐（apply 唯一写者）——AI 不可改，防与设置页 flip-flop");
                }
                if (src === "burden" && input.allowWriteback === true) {
                    return errorResponse("闪卡负担=派生数据（每日重算重建），没有可回写的思源属性——allowWriteback 恒 false");
                }
                const ledger = await loadLedger();
                const cur = ledger.sources[src];
                const next = {
                    enabled: typeof input.enabled === "boolean" ? input.enabled : cur.enabled,
                    allowWriteback: src === "burden" ? false : (typeof input.allowWriteback === "boolean" ? input.allowWriteback : cur.allowWriteback),
                };
                ledger.sources[src] = next;
                await saveLedger(ledger);
                return successResponse({ source: src, sources: ledger.sources });
            }

            // unlink
            const taskId = assertBlockId(input.taskId, "taskId");
            const cfg = await loadConfig();
            if (!cfg) return errorResponse("日历未配置");
            const ledger = await loadLedger();
            const key = taskKey(taskId);
            const mapping = ledger.entries[key];
            if (!mapping) return errorResponse(`任务 ${taskId} 没有日历映射`);
            let warning: string | undefined;
            try {
                await deleteLedgerEvent(key, cfg);
            } catch (e: any) {
                warning = `删事件失败（${e?.message ?? e}）——映射保留，修好后重试 unlink`;
            }
            return successResponse({ taskId, removed: mapping.eventId, warning });
        }),
    };
}
