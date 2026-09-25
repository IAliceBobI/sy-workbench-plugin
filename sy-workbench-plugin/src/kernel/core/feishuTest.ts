// timeblock 期 2 H4（bear 09-19 拍板细化）：飞书推送链路直测——纯函数层。
// ①测试消息文案（默认带时刻，可覆盖）②马上到期测试事件载荷（到点提醒+标记串供清场）
// ③旧测试事件清场筛选。编排面在 kernel/feishuTest.ts（bot 身份发消息+加急、oauth 身份建事件）。
import type { EventPayload } from "./feishu";

/** 测试事件描述标记（清场按此识别插件建的测试事件，勿改——改了旧事件永不清理） */
export const TEST_EVENT_MARKER = "sy-plugin-h4-test";

/** 测试事件时长（分钟）——提醒锚点语义，非会议时长（与任务事件 30min 同族取短） */
export const TEST_EVENT_DURATION_MIN = 5;

export type TestUrgentChoice = "none" | "app" | "sms" | "phone" | "reply";

/** 加急方式 → 飞书 urgent_type（组合端点 PATCH /im/v1/messages/:id/urgent 的枚举值） */
export const URGENT_TYPE_MAP: Record<Exclude<TestUrgentChoice, "none">, string> = {
    app: "APP",
    sms: "SMS",
    phone: "PHONE",
    reply: "REPLY", // 「需要回复」加急=对方须回复才消——bear 说的「签到」最近似形态
};

export function isTestUrgentChoice(v: any): v is TestUrgentChoice {
    return v === "none" || v === "app" || v === "sms" || v === "phone" || v === "reply";
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** 测试消息文案：默认「插件推送测试 HH:mm:ss」（可自定义覆盖，截 500 字防长文） */
export function buildTestMessage(text: string | undefined, now: Date): string {
    const custom = (text ?? "").trim();
    if (custom) return custom.slice(0, 500);
    return `插件推送测试 ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
}

/** 马上到期测试事件载荷：start=now+seconds（秒级）、到点提醒（minutes:0）、描述带标记串。
 *  提醒生效身份=建事件的调用方（oauth 用户身份=用户收到；bot 身份=用户走客户端默认日程提醒——
 *  core/feishu.ts ALL_DAY 注释在档），编排层须用 oauth 通道建。 */
export function buildTestEventPayload(now: Date, seconds: number): EventPayload {
    const startMs = now.getTime() + seconds * 1000;
    const start = new Date(startMs);
    const summary = `测试提醒 ${p2(start.getHours())}:${p2(start.getMinutes())}`;
    return {
        summary,
        description: `${TEST_EVENT_MARKER} H4 推送测试事件（开始后可删）`,
        start_time: { timestamp: String(Math.floor(startMs / 1000)), timezone: "Asia/Shanghai" },
        end_time: { timestamp: String(Math.floor(startMs / 1000) + TEST_EVENT_DURATION_MIN * 60), timezone: "Asia/Shanghai" },
        reminders: [{ minutes: 0 }],
        vchat: { vc_type: "no_meeting" },
        attendee_ability: "can_see_others",
    };
}

/** 清场筛选：已开始（start_time.timestamp ≤ nowSec）且描述带标记串的事件 → event_id 列表。
 *  未开始的同标记事件保留（连点两档时前一笔待触发不能误删）；非标记事件永不动。 */
export function pickSweptEvents(items: any[], nowSec: number): string[] {
    const out: string[] = [];
    for (const ev of items ?? []) {
        const id = typeof ev?.event_id === "string" ? ev.event_id : "";
        const desc = typeof ev?.description === "string" ? ev.description : "";
        const ts = Number(ev?.start_time?.timestamp ?? 0);
        if (!id || !desc.includes(TEST_EVENT_MARKER)) continue;
        if (ts > 0 && ts <= nowSec) out.push(id);
    }
    return out;
}
