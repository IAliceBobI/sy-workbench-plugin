// 甘特图偏好：petal gantt.json 轻量存储（entryToggles 同款容错归一）。
// compress 默认 true（断轴压缩默认开，spec 拍板）；旧 forest.json 方向偏好自然废弃不读。
// 写入走插件 saveData（恒带 app=排除本窗，不触发自身重载——AGENTS.md petal 写纪律）。

export const GANTT_PREFS_FILE = "gantt.json";

export interface GanttPrefs {
    compress: boolean;
}

export const DEFAULT_GANTT_COMPRESS = true;

/** 存档容错归一：loadData 双形态（字符串/对象）+未知值回落默认（旧档/手改坏档不炸） */
export function normalizeGanttPrefs(raw: unknown): GanttPrefs {
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw || "null");
        } catch {
            raw = null;
        }
    }
    const src = (raw && typeof raw === "object" ? raw : {}) as Partial<GanttPrefs>;
    return { compress: src.compress === false ? false : DEFAULT_GANTT_COMPRESS };
}
