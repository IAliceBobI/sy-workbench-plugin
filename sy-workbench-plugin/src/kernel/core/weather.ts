// □18 自动天气·纯逻辑核：Open-Meteo 响应解析/WMO 天气码中文/事件载荷。零 siyuan/网络依赖。
import { buildAllDayEventPayload, type EventPayload } from "./feishu";

/** keyed 事件键（闪卡负担 keyed 同款先例：二次查同日更新同条不增条） */
export function weatherKey(day: string): string {
    return `weather:${day}`;
}

/** WMO weather code → 中文短语（open-meteo 文档枚举的实用子集；未收录=「天气」兜底） */
export function wmoText(code: number): string {
    if (code === 0) return "晴";
    if (code === 1) return "基本晴";
    if (code === 2) return "多云";
    if (code === 3) return "阴";
    if (code === 45 || code === 48) return "雾";
    if (code >= 51 && code <= 57) return "毛毛雨";
    if (code >= 61 && code <= 67) return "雨";
    if (code >= 71 && code <= 77) return "雪";
    if (code >= 80 && code <= 82) return "阵雨";
    if (code === 85 || code === 86) return "阵雪";
    if (code >= 95) return "雷暴";
    return "天气";
}

/** forecast 响应防御性归一（缺字段/空数组→null） */
export interface ForecastDay {
    date: string;
    code: number;
    max: number | null;
    min: number | null;
}
export interface ForecastParsed {
    currentTemp: number | null;
    days: ForecastDay[];
}
export function parseForecastResp(json: any): ForecastParsed | null {
    if (!json || typeof json !== "object") return null;
    const cur = typeof json.current?.temperature_2m === "number" ? json.current.temperature_2m : null;
    const d = json.daily;
    if (!d || !Array.isArray(d.time) || !d.time.length) return null;
    const days: ForecastDay[] = [];
    for (let i = 0; i < d.time.length; i++) {
        const date = typeof d.time[i] === "string" ? d.time[i] : "";
        if (!date) continue;
        days.push({
            date,
            code: typeof d.weather_code?.[i] === "number" ? d.weather_code[i] : -1,
            max: typeof d.temperature_2m_max?.[i] === "number" ? d.temperature_2m_max[i] : null,
            min: typeof d.temperature_2m_min?.[i] === "number" ? d.temperature_2m_min[i] : null,
        });
    }
    return days.length ? { currentTemp: cur, days } : null;
}

/** 选中行：目标日（城市日）命中优先，缺行回退 days[0]（跨时区宿主日与城市日错开时） */
export function pickWeatherDay(parsed: ForecastParsed, day: string): ForecastDay | null {
    return parsed.days.find((x) => x.date === day) ?? parsed.days[0] ?? null;
}

/** 天气事件载荷：标题一句话（拍板「主日历标题一句话」）；事件日期=选中行自己的日期 */
export function buildWeatherEventPayload(cityLabel: string, parsed: ForecastParsed, day: string): EventPayload | null {
    const d = pickWeatherDay(parsed, day);
    if (!d) return null;
    const temps = [d.min, d.max].filter((t): t is number => typeof t === "number");
    const tempText = temps.length === 2
        ? `${Math.round(temps[0])}~${Math.round(temps[1])}°C`
        : temps.length === 1 ? `${Math.round(temps[0])}°C` : "";
    const summary = `${cityLabel} ${tempText} ${wmoText(d.code)}`.replace(/\s+/g, " ").trim();
    if (!summary) return null;
    // desc 不含实况温度（□6a）：实况每轮在变，进 desc=payload 签名每轮漂移→同签名短路
    // 恒不命中→每轮必走 upsert 写路径（丢键竞态暴露面放大；P2-2「实况写 desc」反转）
    const desc = "sy-workbench-plugin 每日自动天气（Open-Meteo，免 key）——本条自动维护，改了也会被下轮覆盖";
    return buildAllDayEventPayload(summary, d.date, desc);
}
