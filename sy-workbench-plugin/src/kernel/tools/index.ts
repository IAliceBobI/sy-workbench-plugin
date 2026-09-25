import type { ToolDefinition } from "./common";
import { createProjectTool } from "./projectTools";
import { createTaskTool } from "./taskTools";
import { createLineTool } from "./lineTools";
import { createCalendarTool } from "./calendarTools";
import { createReminderTool } from "./reminderTools";
import { createRoutineTool } from "./routineTools";

export type { ToolResponse, ToolDefinition } from "./common";

// 工具粒度定案（handoff □2 已拍板）：project+task 双工具，各 action 枚举个位数——
// AI 工具选择=按意图二分，避免单工具大枚举爆炸与细粒度工具选择负担。
// P2 增 line（换线四件套+blocks 读取）+ calendar（飞书日历，P2 日历提醒）；
// □3 增 reminder（块提醒建/查/删——「跟 AI 说」入口）；sloop □4 增 routine（交接会五幕：
// 读画像/对账三态/读写班表/长期偏好——作息训练日循环的 AI 面）。
export function createMcpRegistry(): ToolDefinition[] {
    return [createProjectTool(), createTaskTool(), createLineTool(), createCalendarTool(), createReminderTool(), createRoutineTool()];
}
