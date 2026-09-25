/// <reference types="siyuan/kernel" />

// 内核侧入口：lifecycle 三钩子 + 双工具（project/task）注册。
// P1 正式面；P0 spike 探针已退役（proxyFetch/base64UrlEncode 迁至 api.ts 备 P2 飞书用）。
//
// 已知契约（docs/agents/debugging/kernel/mcp.md）：
// - goja 全局面无 fetch/setTimeout/console——打点唯一通道 siyuan.logger
// - lifecycle 三钩子无条件 AssertFunction（null 也会报 not bound），必须绑函数
// - 注册失败不 rethrow 炸生命周期：catch 记 logger.error 继续
import type { ILogger } from "siyuan/kernel";
import { runRemindSyncGuarded } from "./kernel/remind";
import { runTaskWriteback } from "./kernel/writeback";
import { migrateFolderModel } from "./kernel/homeMigrate";
import { applyOAuthCode, clearFeishuConfig, setupOAuthApp } from "./kernel/feishu";
import { fp8 } from "./kernel/core/feishu";
import { fetchInstancesRpc, runMirrorPollGuarded } from "./kernel/calendarMirror";
import { runDailyWeatherGuarded } from "./kernel/weather";
import { kernelLog } from "./kernel/loki";
import {
    BEHAVIOR_COLLECT_METHOD,
    BEHAVIOR_GET_METHOD,
    BEHAVIOR_STAY_METHOD,
    SCHEDULE_SYNC_METHOD,
    CALENDAR_AUTH_METHOD,
    CALENDAR_CLEAR_METHOD,
    CALENDAR_INSTANCES_METHOD,
    CALENDAR_MIRROR_POLL_METHOD,
    CALENDAR_SETUP_METHOD,
    PROJECT_CREATE_METHOD,
    PROJECT_DELETE_METHOD,
    REMIND_SYNC_METHOD,
    SCHED_BOARD_SYNC_METHOD,
    SCHED_BOARD_READ_METHOD,
    SCHED_FOREIGN_DELETE_METHOD,
    FEISHU_TEST_SEND_METHOD,
    FEISHU_TEST_EVENT_METHOD,
    FEISHU_BOT_INFO_METHOD,
    REMIND_ENTRY_CREATE_METHOD,
    WEATHER_SYNC_METHOD,
    WEEKLY_REPORT_SYNC_METHOD,
    AMMO_START_METHOD,
    AMMO_STOP_METHOD,
    AMMO_DEPART_METHOD,
    AMMO_STATE_METHOD,
    AMMO_RESOLVE_METHOD,
    AMMO_REFLECT_METHOD,
    AMMO_PANEL_METHOD,
    LINE_SWEEP_METHOD,
    AMMO_HEALTH_METHOD,
    AMMO_MOVE_POOL_METHOD,
    AMMO_SET_RATIO_METHOD,
    AMMO_SET_FREQ_METHOD,
    AMMO_SET_QUOTA_METHOD,
    AMMO_LEDGER_READ_METHOD,
    AMMO_LIVE_STATE_METHOD,
    AMMO_LIVE_SYNC_METHOD,
    AVERSION_WRITE_METHOD,
    RECON_RECORD_METHOD,
} from "./shared/channels";
import { handleGetProfile, handleStayReport, persistBehaviorOnUnload, runBehaviorCollectGuarded } from "./kernel/behavior";
import { runMorningRollGuarded } from "./kernel/schedule";
import { deleteForeignEventRpc, autoAdoptSweepRpc, lokiSchedLogger } from "./kernel/schedMirrorSync";
import { schedBoardSyncRpc, schedBoardReadRpc, createRemindEntryRpc } from "./kernel/schedboard";
import { sendTestMessageRpc, createTestEventRpc, getBotInfoRpc } from "./kernel/feishuTest";
import { runWeeklyReportGuarded } from "./kernel/report";
import { ammoStartRpc, ammoStopRpc, ammoDepartRpc, ammoStatusRpc, ammoResolveRpc, ammoReflectRpc, runAmmoRecoveryScan } from "./kernel/ammoEngine";
import { ammoPanelRpc } from "./kernel/ammoPanel";
import { ammoHealthRpc } from "./kernel/ammoHealth";
import { ammoLedgerReadRpc, ammoLiveStateRpc, ammoLiveSyncRpc } from "./kernel/ammoLiveSync";
import { runAmmoMigration, moveTaskPool, setPoolRatio, setPoolFreq, setTaskQuota, syncAversions } from "./kernel/ammoQuadrant";
import type { AversionUpsert } from "./kernel/ammoQuadrant";
import { createMcpRegistry } from "./kernel/tools";
import { createProjectTool, deleteProjectRpc } from "./kernel/tools/projectTools";
import { sweepProjectDone } from "./kernel/tools/lineTools";
import { createRoutineTool } from "./kernel/tools/routineTools";

class KernelPlugin {
    private readonly logger: ILogger;
    private registeredToolNames: string[] = [];

    constructor() {
        this.logger = siyuan.logger;
        siyuan.plugin.lifecycle.onload = this.onload.bind(this);
        siyuan.plugin.lifecycle.onrunning = async () => {
            await this.logger.info("[kernel] onrunning");
            // remind □1：块提醒→飞书 timed 事件（启动兜底一轮；前端写属性另有 rpc 事件驱动）
            try {
                await runRemindSyncGuarded(this.logger);
            } catch (error) {
                await this.logger.error("[kernel] [remind] failed:", error);
            }
            // □3 任务截止回写扫描：飞书侧改时间→回写 due 属性（有限双向；同引擎三态裁决）
            try {
                await runTaskWriteback(this.logger);
            } catch (error) {
                await this.logger.error("[kernel] [writeback] failed:", error);
            }
            // □17 飞书日历回流读链：启动兜底一轮镜像轮询（每小时档由前端 hourlyTimer rpc 搭车）
            try {
                await runMirrorPollGuarded(this.logger);
            } catch (error) {
                await this.logger.error("[kernel] [calmirror] failed:", error);
            }
            // □18 自动天气：每日一条主日历事件（启动兜底+hourly 搭车；失败静默零弹窗）
            try {
                await runDailyWeatherGuarded(this.logger);
            } catch (error) {
                await this.logger.error("[kernel] [weather] failed:", error);
            }
            // sloop □3 作息训练·期 1：行为画像采集（六路自采+昨日缺档重建+日终冻结；
            // 前端停留走 behavior-stay 推送，hourly 搭车在 index.ts）
            try {
                await runBehaviorCollectGuarded(this.logger);
            } catch (error) {
                await this.logger.error("[kernel] [behavior] failed:", error);
            }
            // sloop □4 晨间断签自愈：昨晚交接会没开→昨日计划自动顺延到今天（不追责；
            // lastRollDay 守卫=每日至多一次真写盘，零滚动=零写零重载）
            try {
                await runMorningRollGuarded(this.logger);
            } catch (error: any) {
                await this.logger.error("[kernel] [schedule] failed:", error);
            }
            // 弹药库 □3 启动恢复扫描：读未闭合分类（running 候选/悬账）广播唤醒提示面——
            // 零写（不偷偷自动切/不擅自闭合，日账信用底线；B2.5 恢复协议）
            try {
                await runAmmoRecoveryScan();
            } catch (error: any) {
                await this.logger.error("[kernel] [ammo-recovery] failed:", error);
            }
            // 弹药库 □4 存量迁移：既有班表弹性行一次性转池配置（今天..+14；幂等=无弹性行
            // 零写，重跑即重扫——失败日下轮自愈）
            try {
                const mig = await runAmmoMigration();
                if (mig.migrated || mig.errors.length) {
                    await this.logger.info(`[kernel] [ammo-migration] migrated ${mig.migrated} rows on ${mig.migratedDays.length} days${mig.errors.length ? `, errors: ${mig.errors.join("; ").slice(0, 200)}` : ""}`);
                }
            } catch (error: any) {
                await this.logger.error("[kernel] [ammo-migration] failed:", error);
            }
            // sloop □6 照镜子周报：周日晚 20:00 起的目标周首跑生成（四段全文→日记本/照镜子/
            // +班表条目+周报表；幂等=已生成周零写，空周不生成不记档）
            try {
                await runWeeklyReportGuarded(this.logger);
            } catch (error) {
                await this.logger.error("[kernel] [weekly] failed:", error);
            }
        };
        siyuan.plugin.lifecycle.onunload = this.onunload.bind(this);
    }

    private async onload(): Promise<void> {
        await this.logger.info("[kernel] sy-workbench-plugin loading");
        // calauth □1：boot 心跳——Loki 时间线起点锚（打点链活着的最小证据；Loki 不在则静默）
        kernelLog("calauth", "kernel onload (storageVerify+loki instrumented)");
        // 前端→kernel 事件驱动同步通道（remind □1）：面板保存/删除即推飞书，不等下次启动
        try {
            await siyuan.rpc.bind(REMIND_SYNC_METHOD, async () => {
                await runRemindSyncGuarded(this.logger);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind remind-sync failed:", error);
        }
        // 一键重授权（按钮化 c）：前端收 code 后换证+体检（B 档回调服务/手动贴 code 共用）
        try {
            await siyuan.rpc.bind(CALENDAR_AUTH_METHOD, async (params: any) => {
                // calauth 09-16：redirect_uri 空串曾压掉 applyOAuthCode 默认值→换证恒 20063
                // （setup 路径 `uri || undefined` 一直在保护、reauth 路径漏了同款——09-16 重连失败根因）
                const ru = String(params?.redirectUri ?? "") || undefined;
                kernelLog("calauth", `calendar-auth rpc called (code len=${String(params?.code ?? "").length}, code fp=${fp8(String(params?.code ?? ""))}, ru=${ru ?? "(default)"})`);
                try {
                    return await applyOAuthCode(String(params?.code ?? ""), ru);
                } catch (error: any) {
                    return { ok: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind calendar-auth failed:", error);
        }
        // 首配表单一键落盘+清除配置（calauth □2）：与 calendar-auth 同款包装语义
        try {
            await siyuan.rpc.bind(CALENDAR_SETUP_METHOD, async (params: any) => {
                kernelLog("calauth", "calendar-setup rpc called");
                try {
                    const uri = String(params?.redirectUri ?? "").trim();
                    return await setupOAuthApp(String(params?.appId ?? ""), String(params?.appSecret ?? ""), String(params?.code ?? ""), uri || undefined);
                } catch (error: any) {
                    return { ok: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind calendar-setup failed:", error);
        }
        try {
            await siyuan.rpc.bind(CALENDAR_CLEAR_METHOD, async () => {
                kernelLog("calauth", "calendar-clear rpc called");
                try {
                    return await clearFeishuConfig();
                } catch (error: any) {
                    return { ok: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind calendar-clear failed:", error);
        }
        // □17 回流读链双 rpc：触发镜像轮询（前端 hourlyTimer/勾选保存搭车）+实例按需拉取
        try {
            await siyuan.rpc.bind(CALENDAR_MIRROR_POLL_METHOD, async () => {
                kernelLog("calmirror", "mirror-poll rpc called");
                try {
                    const r = await runMirrorPollGuarded(this.logger);
                    // sloop □25：轮询成功→飞书侧改动回写班表一轮（gates 内自跳过；
                    // 错误不连坐轮询回执——writeback 下轮 poll 重试）
                    if (r && !r.skipped) {
                        // 期 2 ③ 全映射自动 adopt：镜像轮询后扫一轮新事件批量落块（幂等=账本
                        // eventId 绑定防重；零新事件零写。错误不连坐轮询回执）
                        try {
                            await autoAdoptSweepRpc(lokiSchedLogger());
                        } catch (aaError) {
                            await this.logger.error("[kernel] [schedadopt] after poll failed:", aaError);
                        }
                    }
                    return r;
                } catch (error: any) {
                    return { skipped: false, calendars: 0, events: 0, changed: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind mirror-poll failed:", error);
        }
        try {
            await siyuan.rpc.bind(CALENDAR_INSTANCES_METHOD, async (params: any) => {
                try {
                    return await fetchInstancesRpc(this.logger, Number(params?.startTs), Number(params?.endTs));
                } catch (error: any) {
                    return { ok: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind instances failed:", error);
        }
        // □18 自动天气：触发通道（前端 hourlyTimer/设置保存搭车）
        try {
            await siyuan.rpc.bind(WEATHER_SYNC_METHOD, async () => {
                try {
                    return await runDailyWeatherGuarded(this.logger);
                } catch (error: any) {
                    return { skipped: true, reason: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind weather-sync failed:", error);
        }
        // sloop □3 行为画像三面：前端停留推送（幂等覆盖）/触发采集/读画像
        try {
            await siyuan.rpc.bind(BEHAVIOR_STAY_METHOD, async (params: any) => {
                try {
                    return await handleStayReport(params);
                } catch (error: any) {
                    return { ok: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind behavior-stay failed:", error);
        }
        try {
            await siyuan.rpc.bind(BEHAVIOR_COLLECT_METHOD, async () => {
                try {
                    return await runBehaviorCollectGuarded(this.logger);
                } catch (error: any) {
                    return { ok: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind behavior-collect failed:", error);
        }
        try {
            await siyuan.rpc.bind(BEHAVIOR_GET_METHOD, async (params: any) => {
                try {
                    return await handleGetProfile(params);
                } catch (error: any) {
                    return { ok: false, profile: null, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind behavior-get failed:", error);
        }
        // sloop □4 晨间滚动检查（前端 hourlyTimer 搭车——常开不重启也能滚）
        try {
            await siyuan.rpc.bind(SCHEDULE_SYNC_METHOD, async () => {
                try {
                    const r = await runMorningRollGuarded(this.logger);
                    return r;
                } catch (error: any) {
                    return { day: "", rolled: 0, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind schedule-sync failed:", error);
        }
        // sloop □7 班表镜像三 rpc：触发同步（notify）/后端切换落地（call）/回流信号清单（call）
        // sloop □17 飞书先建事件落地（日历日视图「存入班表」钮；纯飞书→完全同步跃迁）
        // timeblock 期 2 ① 统一写链：前端 schedEdit（add/move/remove/冻结）的块写委托面——
        // 日终态 diff 重放进日记班表块，keyRemap 回传前端迁移 petal key（key=块 id 双写主键）
        try {
            await siyuan.rpc.bind(SCHED_BOARD_SYNC_METHOD, async (params: any) => {
                kernelLog("schedboard", `sched-board-sync rpc called (day=${String(params?.day ?? "")})`);
                try {
                    return await schedBoardSyncRpc(params);
                } catch (error: any) {
                    return { ok: false, keyRemap: [], error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind sched-board-sync failed:", error);
        }
        // timeblock 期 2 ② 读面切块：当日班表块只读面（日历页签日面板——getChildChunks 真序+IAL 直读，
        // 不建档零副作用；日窗闸在 rpc 内）
        try {
            await siyuan.rpc.bind(SCHED_BOARD_READ_METHOD, async (params: any) => {
                try {
                    return await schedBoardReadRpc(params);
                } catch (error: any) {
                    return { ok: false, items: [], error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind sched-board-read failed:", error);
        }
        try {
            await siyuan.rpc.bind(SCHED_FOREIGN_DELETE_METHOD, async (params: any) => {
                try {
                    return await deleteForeignEventRpc(String(params?.eventId ?? ""), lokiSchedLogger());
                } catch (error: any) {
                    return { ok: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind sched-foreign-delete failed:", error);
        }
        // tb2 H1：日历轴右键建带时间空段落块（remind 链全家桶——段落块拍板）
        try {
            await siyuan.rpc.bind(REMIND_ENTRY_CREATE_METHOD, async (params: any) => {
                kernelLog("schedboard", `remind-entry-create rpc called (day=${String(params?.day ?? "")} start=${String(params?.start ?? "")})`);
                try {
                    return await createRemindEntryRpc(params);
                } catch (error: any) {
                    return { ok: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind remind-entry-create failed:", error);
        }
        // tb2 H4：飞书推送链路直测（消息+加急 / 马上到期事件——排查手机端推送配置）
        try {
            await siyuan.rpc.bind(FEISHU_TEST_SEND_METHOD, async (params: any) => {
                kernelLog("cal", `feishu-test-send rpc called (urgent=${String(params?.urgent ?? "none")})`);
                return await sendTestMessageRpc(params ?? {});
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind feishu-test-send failed:", error);
        }
        try {
            await siyuan.rpc.bind(FEISHU_TEST_EVENT_METHOD, async (params: any) => {
                kernelLog("cal", `feishu-test-event rpc called (seconds=${String(params?.seconds ?? "")})`);
                return await createTestEventRpc(Number(params?.seconds));
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind feishu-test-event failed:", error);
        }
        // tb6 □6d 机器人身份自检（bot/v3/info——当前凭证是哪个 bot，防配错）
        try {
            await siyuan.rpc.bind(FEISHU_BOT_INFO_METHOD, async () => {
                kernelLog("cal", "feishu-bot-info rpc called");
                return await getBotInfoRpc();
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind feishu-bot-info failed:", error);
        }
        // sloop □6 照镜子周报检查（前端 hourlyTimer 搭车+onrunning 兜底；幂等零写）
        try {
            await siyuan.rpc.bind(WEEKLY_REPORT_SYNC_METHOD, async () => {
                try {
                    return await runWeeklyReportGuarded(this.logger);
                } catch (error: any) {
                    return { skipped: true, reason: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind weekly-report-sync failed:", error);
        }
        // 弹药库 □3：单任务运行引擎五面（start/stop/depart/state/resolve）——互斥执行层，
        // □6/□7 UI 经 rpc 调用；引擎自身兜底 {ok:false,error} 不 throw（双包 catch 防生命周期炸链）
        try {
            await siyuan.rpc.bind(AMMO_START_METHOD, async (params: any) => {
                kernelLog("ammo", `ammo-start rpc called (day=${String(params?.day ?? "")} start=${String(params?.start ?? "")})`);
                return await ammoStartRpc(params);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-start failed:", error);
        }
        try {
            await siyuan.rpc.bind(AMMO_STOP_METHOD, async (params: any) => {
                kernelLog("ammo", `ammo-stop rpc called (day=${String(params?.day ?? "")})`);
                return await ammoStopRpc(params);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-stop failed:", error);
        }
        try {
            await siyuan.rpc.bind(AMMO_DEPART_METHOD, async (params: any) => {
                kernelLog("ammo", `ammo-depart rpc called (day=${String(params?.day ?? "")} start=${String(params?.start ?? "")})`);
                return await ammoDepartRpc(params);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-depart failed:", error);
        }
        try {
            await siyuan.rpc.bind(AMMO_STATE_METHOD, async (params: any) => {
                return await ammoStatusRpc(params?.day);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-state failed:", error);
        }
        try {
            await siyuan.rpc.bind(AMMO_RESOLVE_METHOD, async (params: any) => {
                kernelLog("ammo", `ammo-resolve rpc called (blockId=${String(params?.blockId ?? "")})`);
                return await ammoResolveRpc(params);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-resolve failed:", error);
        }
        // ammo □6：感想 append 面（blockId 缺省=当前运行中条目——引擎侧解析）
        try {
            await siyuan.rpc.bind(AMMO_REFLECT_METHOD, async (params: any) => {
                return await ammoReflectRpc(params);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-reflect failed:", error);
        }
        // ammo □6：四象限面板聚合读面（只读零建档——挂载首读+广播后重拉共用）
        try {
            await siyuan.rpc.bind(AMMO_PANEL_METHOD, async (params: any) => {
                return await ammoPanelRpc(params?.day);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-panel failed:", error);
        }
        // 03 收拢件：done 任务收拢（驾驶舱「收拾已完成」按钮——MCP line sweep_done 双通道同编排）
        try {
            await siyuan.rpc.bind(LINE_SWEEP_METHOD, async (params: any) => {
                return await sweepProjectDone(String(params?.projectId ?? ""));
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind line-sweep failed:", error);
        }
        // dataview □8：格式体检聚合读面（fail-soft 可见面——分区结构/未认行/文本属性冲突三类汇总）
        try {
            await siyuan.rpc.bind(AMMO_HEALTH_METHOD, async (params: any) => {
                kernelLog("ammo", `ammo-health rpc called (day=${String(params?.day ?? "")})`);
                return await ammoHealthRpc(params?.day);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-health failed:", error);
        }
        // dataview □5①：拖卡换池（单任务级写通道——面板/看板拖拽共用；引擎自身兜底不 throw）
        try {
            await siyuan.rpc.bind(AMMO_MOVE_POOL_METHOD, async (params: any) => {
                kernelLog("ammo", `ammo-move-pool rpc called (day=${String(params?.day ?? "")} pool=${String(params?.pool ?? "")})`);
                return await moveTaskPool(String(params?.day ?? ""), {
                    task: typeof params?.task === "string" ? params.task : "",
                    name: typeof params?.name === "string" ? params.name : "",
                    pool: params?.pool,
                    ...(params?.quota != null ? { quota: params.quota } : {}),
                });
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-move-pool failed:", error);
        }
        // dataview □5③：点池头改配比（□2 文本写通道——ratio 落池行文本）
        try {
            await siyuan.rpc.bind(AMMO_SET_RATIO_METHOD, async (params: any) => {
                kernelLog("ammo", `ammo-set-ratio rpc called (day=${String(params?.day ?? "")} pool=${String(params?.pool ?? "")} ratio=${String(params?.ratio ?? "null")})`);
                return await setPoolRatio(String(params?.day ?? ""), params?.pool, params?.ratio == null ? null : Number(params.ratio));
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-set-ratio failed:", error);
        }
        // 第二批 R3：炉火最小频率面板通道（freq 无文本形态——属性即真相，契约 §2 例外条款）
        try {
            await siyuan.rpc.bind(AMMO_SET_FREQ_METHOD, async (params: any) => {
                kernelLog("ammo", `ammo-set-freq rpc called (day=${String(params?.day ?? "")} pool=${String(params?.pool ?? "")} freq=${String(params?.freq ?? "null")})`);
                return await setPoolFreq(String(params?.day ?? ""), params?.pool, params?.freq == null ? null : Number(params.freq));
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-set-freq failed:", error);
        }
        // dataview □7：徽标菜单配额步进（任务级 quota 写通道——行在改行文本，行不在只写块缓存）
        try {
            await siyuan.rpc.bind(AMMO_SET_QUOTA_METHOD, async (params: any) => {
                kernelLog("ammo", `ammo-set-quota rpc called (day=${String(params?.day ?? "")} task=${String(params?.task ?? "")} quota=${String(params?.quota ?? "null")})`);
                return await setTaskQuota(String(params?.day ?? ""), typeof params?.task === "string" ? params.task : "", typeof params?.name === "string" ? params.name : "", params?.quota == null ? null : Number(params.quota));
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-set-quota failed:", error);
        }
        // manualui：不想做清单手动编辑（中央圈可编辑面）——薄转发 syncAversions（aversion_set
        // 背后同一 core 实现=单一事实源；载荷归一仿 routineTools aversion_set——text 归一在 core）
        try {
            await siyuan.rpc.bind(AVERSION_WRITE_METHOD, async (params: any) => {
                kernelLog("ammo", `aversion-write rpc called (upserts=${String(Array.isArray(params?.upserts) ? params.upserts.length : 0)} remove=${String(Array.isArray(params?.remove) ? params.remove.length : 0)})`);
                const upserts: AversionUpsert[] = (Array.isArray(params?.upserts) ? params.upserts : [])
                    .filter((x: any) => x && typeof x === "object")
                    .map((x: any) => ({
                        ...(typeof x?.id === "string" && x.id ? { id: x.id } : {}),
                        text: typeof x?.text === "string" ? x.text : "",
                        kind: x?.kind,
                        ...(typeof x?.avatar === "string" && x.avatar ? { avatar: x.avatar } : {}),
                        ...(typeof x?.capPool === "string" && x.capPool ? { capPool: x.capPool } : {}),
                    }));
                const removeIds: string[] = (Array.isArray(params?.remove) ? params.remove : []).filter((x: any) => typeof x === "string" && x);
                if (!upserts.length && !removeIds.length) return { ok: false, error: "载荷空——upserts:[{text,kind}] 增改 / remove:[块id] 删" };
                return await syncAversions(upserts, removeIds);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind aversion-write failed:", error);
        }
        // ammo □7：日账读面（单日/日窗两形态——时间线单日、月历 42 格窗；读通道零副作用）
        try {
            await siyuan.rpc.bind(AMMO_LEDGER_READ_METHOD, async (params: any) => {
                return await ammoLedgerReadRpc(params);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-ledger-read failed:", error);
        }
        // ammo □7：实况手动同步态读面（同步钮颜色标态数据源——纯读零写零网络）
        try {
            await siyuan.rpc.bind(AMMO_LIVE_STATE_METHOD, async (params: any) => {
                return await ammoLiveStateRpc(params?.day);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-live-state failed:", error);
        }
        // ammo □7：实况手动同步（用户按钮触发——pull 式勿实时推，L4 频控红线）
        try {
            await siyuan.rpc.bind(AMMO_LIVE_SYNC_METHOD, async (params: any) => {
                kernelLog("ammosync", `ammo-live-sync rpc called (day=${String(params?.day ?? "")})`);
                return await ammoLiveSyncRpc(params?.day);
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind ammo-live-sync failed:", error);
        }
        // sloop □10 切换器「新建项目」手动入口：直调 MCP project create 同一 handler
        // （单一事实源——手动=轻量裸建，agentNote 缺省占位，与 AI 富建通道并存）
        try {
            await siyuan.rpc.bind(PROJECT_CREATE_METHOD, async (params: any) => {
                kernelLog("pjcreate", `project-create rpc called (name=${String(params?.name ?? "")})`);
                try {
                    return await createProjectTool().handler({
                        action: "create",
                        notebook: params?.notebook,
                        name: params?.name,
                    });
                } catch (error: any) {
                    return { success: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind project-create failed:", error);
        }
        // 删除项目（驾驶舱危险态钮）：独立 handler 不进 MCP 工具枚举（删除动作不对 AI 暴露）；
        // 屋檐防线（子树含 /主线数据 拒删）在 deleteProjectRpc 内，双包 catch 恒 ToolResponse 不炸生命周期
        try {
            await siyuan.rpc.bind(PROJECT_DELETE_METHOD, async (params: any) => {
                kernelLog("pjcreate", `project-delete rpc called (id=${String(params?.projectId ?? "")})`);
                try {
                    return await deleteProjectRpc({ projectId: params?.projectId });
                } catch (error: any) {
                    return { success: false, error: String(error?.message ?? error) };
                }
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind project-delete failed:", error);
        }
        // manualui：交接会手动落对账（对账单三态勾选落盘）——直调 routine recon_record 同一
        // handler（单一事实源：载荷归一/班表读改写/当日拖动消费全同 AI 通道，UI 不另写落账链；
        // project-create 直调先例。wrapHandler 兜异常=恒 ToolResponse 不炸生命周期）
        try {
            await siyuan.rpc.bind(RECON_RECORD_METHOD, async (params: any) => {
                kernelLog("sched", `recon-record rpc called (day=${String(params?.day ?? "")} results=${String(Array.isArray(params?.results) ? params.results.length : 0)})`);
                return await createRoutineTool().handler({
                    action: "recon_record",
                    day: typeof params?.day === "string" ? params.day : undefined,
                    results: params?.results,
                });
            });
        } catch (error: any) {
            await this.logger.error("[kernel] bind recon-record failed:", error);
        }
        // folder-model：两代起点存量迁移（幂等；目录懒建在迁移内=装完即有）。
        // fire-and-forget——生命周期不阻塞，失败只记日志（下轮 onload 幂等重试）
        void migrateFolderModel().then((r) => {
            if (!r.noop) kernelLog("home", `folder-model migrated: moved=[${r.moved.join(",")}] renamed=[${r.renamed.join(",")}] shells=[${r.removedShells.join(",")}]`);
            if (r.error) kernelLog("home", `!! migrate skipped: ${r.error}`);
        }).catch(() => { /* 下轮 onload 重试 */ });
        for (const tool of createMcpRegistry()) {
            try {
                const registered = await this.registerCapability(tool.name, tool.config, tool.handler);
                this.registeredToolNames.push(tool.name);
                await this.logger.info("[kernel] registered tool:", registered?.name ?? tool.name);
            } catch (error: any) {
                await this.logger.error(`[kernel] register tool ${tool.name} failed:`, error);
            }
        }
    }

    // 现役通道=siyuan.agent.registerCapability；siyuan.mcp.registerTool 是更老内核的兼容
    // 形态（t/p/r kernel.ts 同源模式）。须走 any 视图：tsconfig 含 tomato 共享源后两侧
    // node_modules 的 siyuan/kernel 类型是两份身份，强类型直调互不兼容。
    private async registerCapability(name: string, config: any, handler: any): Promise<any> {
        const s = siyuan as any;
        if (s?.agent && typeof s.agent.registerCapability === "function") {
            return await s.agent.registerCapability(name, config, handler);
        }
        if (s?.mcp && typeof s.mcp.registerTool === "function") {
            return await s.mcp.registerTool(name, config, handler);
        }
        throw new Error("no MCP registration channel on this kernel");
    }

    private async onunload(): Promise<void> {
        try {
            await siyuan.rpc.unbind(REMIND_SYNC_METHOD);
        } catch (error: any) {
            await this.logger.error("[kernel] unbind remind-sync failed:", error);
        }
        try {
            await siyuan.rpc.unbind(CALENDAR_AUTH_METHOD);
        } catch (error: any) {
            await this.logger.error("[kernel] unbind calendar-auth failed:", error);
        }
        try {
            await siyuan.rpc.unbind(CALENDAR_MIRROR_POLL_METHOD);
        } catch (error: any) {
            await this.logger.error("[kernel] unbind mirror-poll failed:", error);
        }
        try {
            await siyuan.rpc.unbind(CALENDAR_INSTANCES_METHOD);
        } catch (error: any) {
            await this.logger.error("[kernel] unbind instances failed:", error);
        }
        try {
            await siyuan.rpc.unbind(WEATHER_SYNC_METHOD);
        } catch (error: any) {
            await this.logger.error("[kernel] unbind weather-sync failed:", error);
        }
        for (const m of [BEHAVIOR_STAY_METHOD, BEHAVIOR_COLLECT_METHOD, BEHAVIOR_GET_METHOD, SCHEDULE_SYNC_METHOD, WEEKLY_REPORT_SYNC_METHOD, PROJECT_CREATE_METHOD, PROJECT_DELETE_METHOD, CALENDAR_SETUP_METHOD, CALENDAR_CLEAR_METHOD, SCHED_BOARD_SYNC_METHOD, SCHED_BOARD_READ_METHOD, SCHED_FOREIGN_DELETE_METHOD, REMIND_ENTRY_CREATE_METHOD, FEISHU_TEST_SEND_METHOD, FEISHU_TEST_EVENT_METHOD, FEISHU_BOT_INFO_METHOD, AMMO_START_METHOD, AMMO_STOP_METHOD, AMMO_DEPART_METHOD, AMMO_STATE_METHOD, AMMO_RESOLVE_METHOD, AMMO_REFLECT_METHOD, AMMO_PANEL_METHOD, LINE_SWEEP_METHOD, AMMO_HEALTH_METHOD, AMMO_MOVE_POOL_METHOD, AMMO_SET_RATIO_METHOD, AMMO_SET_FREQ_METHOD, AMMO_SET_QUOTA_METHOD, AMMO_LEDGER_READ_METHOD, AMMO_LIVE_STATE_METHOD, AMMO_LIVE_SYNC_METHOD, AVERSION_WRITE_METHOD, RECON_RECORD_METHOD]) {
            try {
                await siyuan.rpc.unbind(m);
            } catch (error: any) {
                await this.logger.error(`[kernel] unbind ${m} failed:`, error);
            }
        }
        // sloop □3：退出/重载前尽力冻结当日进行稿（六路可重建，stay 由前端 onload 恢复补推）
        try {
            await persistBehaviorOnUnload();
        } catch (error: any) {
            await this.logger.error("[kernel] behavior persist-on-unload failed:", error);
        }
        for (const name of this.registeredToolNames) {
            try {
                const s = siyuan as any;
                if (s?.agent && typeof s.agent.unregisterCapability === "function") {
                    await s.agent.unregisterCapability(name);
                } else if (s?.mcp && typeof s.mcp.unregisterTool === "function") {
                    await s.mcp.unregisterTool(name);
                }
            } catch (error: any) {
                await this.logger.error(`[kernel] unregister tool ${name} failed:`, error);
            }
        }
        this.registeredToolNames = [];
    }
}

new KernelPlugin();
