// □3 MCP reminder 工具：「跟 AI 说」入口闭环（建/查/删块提醒）。
// 写完属性即触发一轮账本同步（runRemindSyncGuarded）+广播 REMIND_WRITTEN 前端直刷。
import { getBlockAttrs, setBlockAttrs, sql } from "../api";
import {
    ATTR_REMIND_AT,
    ATTR_REMIND_END,
    ATTR_REMIND_REPEAT,
    REMIND_AT_RE,
    isDueRemind,
    listRemindBlocksSql,
    parseRemindRepeat,
    remindEndValid,
    remindKey,
} from "../core/remind";
import { loadLedger } from "../feishu";
import { runRemindSyncGuarded, type RemindSyncResult } from "../remind";
import { REMIND_WRITTEN_CHANNEL } from "../../shared/channels";
import { errorResponse, successResponse, objectSchema, wrapHandler, type ToolDefinition } from "./common";

const ACTIONS = ["set", "list", "delete"] as const;

function assertBlockId(id: unknown, field: string): string {
    if (typeof id !== "string" || !/^20\d{12}-[0-9a-z]{7}$/.test(id)) {
        throw new Error(`字段 ${field} 必须是思源块 id（yyyymmddhhmmss-xxxxxxx）`);
    }
    return id;
}

async function broadcastRemindWritten(blockId: string, at: string | null, repeat: string | null, end: string | null = null): Promise<void> {
    try {
        await siyuan.rpc.broadcast(REMIND_WRITTEN_CHANNEL, { blockId, at, repeat, end });
    } catch { /* 广播失败无害：前端下次开文档扫描自愈 */ }
}

function syncSummary(sync: RemindSyncResult | null): Record<string, unknown> {
    if (!sync) return { merged: true, note: "已有同步轮在进行，本轮已并入补跑" };
    const out: Record<string, unknown> = {
        skipped: sync.skipped,
        created: sync.created,
        updated: sync.updated,
        deleted: sync.deleted,
        unchanged: sync.unchanged,
        writtenBack: sync.writtenBack,
    };
    if (sync.conflicts) out.conflicts = sync.conflicts;
    if (sync.invalid.length) out.invalid = sync.invalid;
    return out;
}

export function createReminderTool(): ToolDefinition {
    return {
        name: "reminder",
        config: objectSchema(
            "块级定时提醒（任意块/文档挂属性→飞书日历事件，到点飞书服务端推送——思源关着也响；块右上角闹钟图标+短文字常显，到期变红）。"
            + "属性语义：custom-remind-at=YYYY-MM-DDTHH:mm 墙上时间（本地时区，无秒）；"
            + "custom-remind-end=结束时间（□16 可空：空=开放时长，镜像默认 30min；须晚于 at，跨天允许——排时间段任务时设，如晚上 22:00~23:00 写作）；"
            + "custom-remind-repeat=循环枚举 daily / weekly:1,3（ISO 周一=1..周日=7）/ monthly:15（短月无该日跳过）/ every:3d（每隔 N 天），"
            + "remind-at 兼作循环起始时间锚。任务块勾选完成=当期静默（取消勾选自动恢复）。"
            + "Actions: set(blockId+at 设/改提醒，可选 end/repeat；不传=保持现状、传空串=清)， "
            + "list(全库提醒清单：时间升序，含到期红态/冲突计数/三源开关), delete(blockId 删提醒：属性+飞书事件全清)。"
            + "⚠️写后 SQL 索引 3~10s 延迟：set/delete 后别立即 list 复核，先干别的再查。"
            + "飞书同步在写后自动触发（日历未配置只写属性不报错——提醒图标仍生效，只是没推送）。",
            {
                action: { type: "string", enum: [...ACTIONS], description: "操作类型" },
                blockId: { type: "string", description: "目标块 id（set/delete 用；文档块 id 亦可）" },
                at: { type: "string", description: "set: 提醒时间 YYYY-MM-DDTHH:mm（如 2026-10-01T09:00）" },
                end: { type: "string", description: "set: 结束时间 YYYY-MM-DDTHH:mm（须晚于 at，跨天允许；不传=保持现状；空串=清结束转开放时长）" },
                repeat: { type: "string", description: "set: 循环枚举 daily / weekly:1,3 / monthly:15 / every:3d（不传=保持现状；空串=清循环转单次）" },
            },
            ["action"],
        ),
        handler: wrapHandler(async (input) => {
            const action = input?.action;
            if (!ACTIONS.includes(action)) return errorResponse(`未知 action: ${action}`);

            if (action === "set") {
                const blockId = assertBlockId(input.blockId, "blockId");
                const at = String(input.at ?? "").trim();
                if (!REMIND_AT_RE.test(at)) {
                    return errorResponse(`at 必须是 YYYY-MM-DDTHH:mm 墙上时间（如 2026-10-01T09:00），got: ${at || "（空）"}`);
                }
                // repeat/end 缺省=保持现状（先读现值回填——setBlockAttrs 是整包语义，漏键=不动，显式带上更稳）
                let currentRepeat = "";
                let currentEnd = "";
                try {
                    const attrs = await getBlockAttrs(blockId);
                    currentRepeat = attrs?.[ATTR_REMIND_REPEAT] ?? "";
                    currentEnd = attrs?.[ATTR_REMIND_END] ?? "";
                } catch { /* 读失败按空处理，写不进去自会报错 */ }
                let repeat = currentRepeat;
                if (input.repeat !== undefined) {
                    repeat = String(input.repeat).trim();
                    if (repeat && !parseRemindRepeat(repeat)) {
                        return errorResponse(`repeat 枚举：daily / weekly:1,3 / monthly:15 / every:3d（got: ${repeat}）`);
                    }
                }
                let end = currentEnd;
                if (input.end !== undefined) {
                    end = String(input.end).trim();
                    if (end && !remindEndValid(end, at)) {
                        return errorResponse(`end 必须是 YYYY-MM-DDTHH:mm 且严格晚于 at（got: ${end || "（空）"}，at=${at}）`);
                    }
                }
                await setBlockAttrs(blockId, { [ATTR_REMIND_AT]: at, [ATTR_REMIND_END]: end, [ATTR_REMIND_REPEAT]: repeat });
                await broadcastRemindWritten(blockId, at, repeat || null, end || null);
                const sync = await runRemindSyncGuarded(siyuan.logger);
                return successResponse({ blockId, at, ...(end ? { end } : {}), repeat: repeat || null, sync: syncSummary(sync) });
            }

            if (action === "list") {
                const rows = await sql<{ id: string; at: string; repeat: string | null; end: string | null; content: string; markdown: string }>(
                    `${listRemindBlocksSql()} ORDER BY at ASC`,
                );
                const ledger = await loadLedger();
                const now = new Date();
                return successResponse({
                    count: rows.length,
                    reminders: rows.map((r) => ({
                        id: r.id,
                        content: (r.content ?? "").slice(0, 80) || "（无内容）",
                        at: r.at,
                        end: r.end,
                        repeat: r.repeat,
                        due: isDueRemind(r.at, now, r.repeat),
                        conflicts: ledger.entries[remindKey(r.id)]?.conflicts ?? 0,
                    })),
                    sources: ledger.sources,
                    note: "due=true=已到期（红态）；conflicts>0=思源与飞书双变被思源赢裁决过的次数（可向用户汇报）",
                });
            }

            // delete
            const blockId = assertBlockId(input.blockId, "blockId");
            await setBlockAttrs(blockId, { [ATTR_REMIND_AT]: "", [ATTR_REMIND_END]: "", [ATTR_REMIND_REPEAT]: "" });
            await broadcastRemindWritten(blockId, null, null);
            const sync = await runRemindSyncGuarded(siyuan.logger);
            return successResponse({ blockId, removed: true, sync: syncSummary(sync) });
        }),
    };
}
