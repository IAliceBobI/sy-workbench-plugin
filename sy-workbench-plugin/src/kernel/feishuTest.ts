// timeblock 期 2 H4：飞书推送链路直测——编排层（kernel rpc 面）。
// ①sendTestMessage：bot 身份发测试消息给用户（p2p open_id）+可选加急（APP 应用内/SMS 短信/
//   PHONE 电话/REPLY 需回复——「签到」最近似形态）；全链同一 bot 身份（加急只能加急自己发的消息）。
// ②createTestEvent：oauth 用户身份建马上到期测试事件（到点提醒按用户身份生效）+清场已触发的
//   旧测试事件（标记串识别，未触发的不误删）。
// 用途=帮用户排查手机端推送配置（发/建后看手机弹没弹——□2 同域）。
import { callFeishu, callFeishuAsApp, ensureCalendar, FeishuApiError, getTenantToken, loadConfig } from "./feishu";
import { proxyRequest } from "./api";
import { FEISHU_BASE } from "./core/feishu";
import { buildTestEventPayload, buildTestMessage, isTestUrgentChoice, pickSweptEvents, URGENT_TYPE_MAP, type TestUrgentChoice } from "./core/feishuTest";

export interface TestSendInput {
    text?: string;
    urgent?: TestUrgentChoice;
}
export interface TestSendResult {
    ok: boolean;
    error?: string;
    messageId?: string;
    /** 实际生效的加急方式（none=未加急） */
    urgentApplied?: TestUrgentChoice;
}
export interface TestEventResult {
    ok: boolean;
    error?: string;
    eventId?: string;
    /** 事件开始时刻（本地 HH:mm:ss——用户等提醒的对表锚点） */
    startAt?: string;
    /** 清场删掉的旧测试事件数 */
    swept?: number;
}

/** oauth 通道缺 userOpenId 时从用户身份自动解析（加急/发消息都要用户 open_id） */
async function resolveUserOpenId(config: any): Promise<string> {
    if (config.userOpenId) return config.userOpenId;
    if (config.channel === "oauth") {
        // GET /authen/v1/user_info（user token）→ data.open_id；失败上抛透传
        const data = await callFeishu(config, "GET", "/authen/v1/user_info");
        const oid = typeof data?.open_id === "string" ? data.open_id : "";
        if (oid) return oid;
    }
    throw new Error("缺少 userOpenId（oauth 自动解析失败或 bot 通道未填）——设置里补收件人 open_id");
}

export async function sendTestMessageRpc(input: TestSendInput): Promise<TestSendResult> {
    try {
        const config = await loadConfig();
        if (!config?.enabled) return { ok: false, error: "飞书未配置或已停用" };
        const urgent: TestUrgentChoice = isTestUrgentChoice(input?.urgent) ? input.urgent : "none";
        const uid = await resolveUserOpenId(config);

        // ① bot 身份发 p2p 文本消息（需开放平台开机器人能力+消息权限）
        const content = JSON.stringify({ text: buildTestMessage(input?.text, new Date()) });
        const sent = await callFeishuAsApp(config, "POST", "/im/v1/messages?receive_id_type=open_id", {
            receive_id: uid,
            msg_type: "text",
            content,
        });
        const messageId = typeof sent?.message_id === "string" ? sent.message_id : "";
        if (!messageId) throw new FeishuApiError(-1, "发消息成功但响应无 message_id");

        // ② 可选加急（组合端点；路径不存在〔分端点族新形态〕→按类型落分端点兜底，REPLY 无分端点）
        if (urgent !== "none") {
            try {
                await callFeishuAsApp(config, "PATCH", `/im/v1/messages/${messageId}/urgent`, {
                    user_id_type: "open_id",
                    user_ids: [uid],
                    urgent_type: URGENT_TYPE_MAP[urgent],
                });
            } catch (e: any) {
                const perType: Partial<Record<TestUrgentChoice, string>> = { app: "urgent_app", sms: "urgent_sms", phone: "urgent_phone" };
                const sub = perType[urgent];
                if (!sub || !isPathGone(e)) throw e;
                await callFeishuAsApp(config, "PATCH", `/im/v1/messages/${messageId}/${sub}`, {
                    user_id_type: "open_id",
                    user_ids: [uid],
                });
            }
        }
        return { ok: true, messageId, urgentApplied: urgent };
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}

/** 路径/端点不存在（HTTP 404 族或飞书业务码=接口不存在）——分端点兜底判据 */
function isPathGone(e: any): boolean {
    if (e instanceof FeishuApiError) return e.code === 404 || e.code === 99991663 || String(e.message).includes("Not Found");
    return false;
}

const SWEEP_WINDOW_SEC = 2 * 86400; // 清场回看窗：两天内已触发的测试事件

export async function createTestEventRpc(seconds: number): Promise<TestEventResult> {
    try {
        const config = await loadConfig();
        if (!config?.enabled) return { ok: false, error: "飞书未配置或已停用" };
        const sec = Math.max(5, Math.min(3600, Math.floor(Number(seconds) || 0)));
        const ref = await ensureCalendar(config);
        const now = new Date();

        // 清场：回看窗内已开始（已触发提醒）的测试事件删掉，防测试残留堆积；未触发的不动
        let swept = 0;
        try {
            const anchor = Math.floor(now.getTime() / 1000) - SWEEP_WINDOW_SEC;
            const data = await callFeishu(config, "GET", `/calendar/v4/calendars/${ref.calendarId}/events?page_size=50&anchor_time=${anchor}`);
            for (const id of pickSweptEvents(data?.items ?? [], Math.floor(now.getTime() / 1000))) {
                try {
                    await callFeishu(config, "DELETE", `/calendar/v4/calendars/${ref.calendarId}/events/${id}`);
                    swept += 1;
                } catch {
                    // 单条清场失败不阻塞建新事件（下轮再清）
                }
            }
        } catch {
            // 清场整体失败（列表权限/网络）不阻塞主路径
        }

        const payload = buildTestEventPayload(now, sec);
        const ev = await callFeishu(config, "POST", `/calendar/v4/calendars/${ref.calendarId}/events`, payload);
        const eventId = typeof ev?.event?.event_id === "string" ? ev.event.event_id : "";
        if (!eventId) throw new FeishuApiError(-1, "建日程成功但响应无 event_id");
        const startMs = Number(payload.start_time.timestamp) * 1000;
        const d = new Date(startMs);
        const p2 = (n: number) => String(n).padStart(2, "0");
        return { ok: true, eventId, startAt: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`, swept };
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}

export interface BotInfoResult {
    ok: boolean;
    error?: string;
    /** bot 名（bot/v3/info 的 bot.name） */
    botName?: string;
    /** appId 尾 4 位（身份卡防配错对照——换凭证一眼可见） */
    appIdTail?: string;
}

/** tb6 □6d 机器人身份自检：GET /bot/v3/info（tenant token）——回答「现在用的是哪个机器人」。
 *  响应无 bot.name=应用未开机器人能力（发消息会失败的前兆，错误透传教育）。 */
export async function getBotInfoRpc(): Promise<BotInfoResult> {
    try {
        const config = await loadConfig();
        if (!config?.enabled) return { ok: false, error: "飞书未配置或已停用" };
        // bot/v3/info 是老 v3 端点：响应顶层即 bot 段（无新 API 的 data 壳）——
        // callFeishuAsApp 统一解包 json.data 会把 bot 段丢掉（主实例实弹纠偏），走原始通道自解
        const token = await getTenantToken(config.appId, config.appSecret);
        const resp = await proxyRequest(`${FEISHU_BASE}/bot/v3/info`, "GET", undefined, {
            Authorization: [`Bearer ${token}`],
        });
        const info = JSON.parse(resp.body);
        const botName = typeof info?.bot?.app_name === "string" && info.bot.app_name
            ? info.bot.app_name
            : (typeof info?.bot?.name === "string" ? info.bot.name : "");
        if (!botName) throw new FeishuApiError(-1, "bot/v3/info 响应无 bot 名（应用未开机器人能力？）");
        return { ok: true, botName, appIdTail: String(config.appId ?? "").slice(-4) };
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}
