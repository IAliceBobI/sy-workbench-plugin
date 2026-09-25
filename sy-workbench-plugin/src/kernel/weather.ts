// □18 自动天气·编排层：每日 1~2 次静默查 Open-Meteo（onrunning+rpc weather-sync 搭 hourlyTimer），
// 一天一条全天事件 upsert 进主日历（键=weather:日期，二次查更新同条）；失败静默零弹窗（拍板）。
// 副作用走 api/feishu 客户端层；纯决策在 core/weather。回流呈现走 □17 镜像零新件。
import { proxyRequest, petalGetJsonFresh } from "./api";
import { loadConfig, loadLedger, mutateLedgerKeys, upsertEventByKey } from "./feishu";
import { getLogicalDay } from "./core/dates";
import { buildWeatherEventPayload, parseForecastResp, pickWeatherDay, weatherKey } from "./core/weather";
import { payloadSig } from "./core/ledger";
import { WEATHER_CONFIG_FILE } from "../shared/channels";

export interface WeatherLogger {
    info: (msg: string, ...rest: unknown[]) => unknown;
    error: (msg: string, ...rest: unknown[]) => unknown;
}

export interface WeatherResult {
    skipped: boolean;
    reason?: string;
    day?: string;
    action?: "create" | "update" | "delete" | "none";
}

export async function runDailyWeather(logger: WeatherLogger, now: Date = new Date()): Promise<WeatherResult> {
    const cfg = await loadConfig();
    if (!cfg || !cfg.enabled) return { skipped: true, reason: "未配置/已停用" };
    const wc = await petalGetJsonFresh<any>(WEATHER_CONFIG_FILE); // 前端设置页写（fresh 读同族，review P1-4）
    const city = wc?.city;
    if (!wc?.enabled || typeof city?.lat !== "number" || typeof city?.lon !== "number") {
        return { skipped: true, reason: "天气未开启或城市未配置" };
    }
    const day = getLogicalDay(now);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
        + `&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min`
        + `&timezone=auto&forecast_days=2`;
    let parsed: ReturnType<typeof parseForecastResp> = null;
    try {
        const resp = await proxyRequest(url, "GET");
        if (resp.ok) parsed = parseForecastResp(JSON.parse(resp.body));
    } catch (e: any) {
        logger.error(`[weather] ${day} 查询异常（静默跳过）: ${String(e?.message ?? e).slice(0, 120)}`);
        return { skipped: true, reason: "查询异常", day };
    }
    if (!parsed) {
        logger.error(`[weather] ${day} 响应形态异常（静默跳过）`);
        return { skipped: true, reason: "响应异常", day };
    }
    // 键/事件日期=选中行日期（城市日，review P1-2）：跨时区宿主日与城市日错开时键不漂移、
    // 不产生同日双事件；同时区用户选中行===宿主逻辑日，行为不变
    const row = pickWeatherDay(parsed, day);
    if (!row) return { skipped: true, reason: "无可用天气行", day };
    const evtDay = row.date;
    const key = weatherKey(evtDay);
    const payload = buildWeatherEventPayload(String(city.name ?? "当地"), parsed, day);
    // 内容未变零写（hourly 搭车防放大）：同签名不 PATCH 不写账本——petal 零写=不触发前端整重载；
    // key=weather:日期每日新键，温度变化=签名变化才推（自然收敛「每日 1~2 次实效写」拍板）
    let ledger = null as Awaited<ReturnType<typeof loadLedger>> | null;
    try {
        ledger = await loadLedger();
        if (ledger.entries[key]?.sySnap === payloadSig(payload)) {
            return { skipped: false, day: evtDay, action: "none" };
        }
    } catch { /* 账本不可读=走直推兜底 */ }
    // weather: 旧键剪枝（review P2-1）：每日 +1 永续累积纯死重；飞书侧事件不动=用户要看的天气日记。
    // 剪了才写盘（日切换后首轮一次）；同签名短路轮在上方 early-return 不达此段（同键短路时无新 stale 键，无碍）。
    // □6a：改键级写（mutateLedgerKeys 进账本写队列）——旧「load→删→save 整文件」在
    // remind/adopt 链并发写时会用旧快照覆盖他键（09-19 丢键四连 create 根因之一）
    try {
        await mutateLedgerKeys((entries) => {
            for (const k of Object.keys(entries)) {
                if (k.startsWith("weather:") && k !== key) delete entries[k];
            }
        });
    } catch { /* 剪枝失败不碍正事 */ }
    try {
        const r = await upsertEventByKey(key, payload, cfg);
        logger.info(`[weather] ${evtDay} 完成: ${r.action} ${payload.summary ?? ""}`);
        return { skipped: false, day: evtDay, action: r.action };
    } catch (e: any) {
        // 飞书写失败零弹窗（拍板）：下轮自愈（upsert 幂等）
        logger.error(`[weather] ${evtDay} 写事件失败（静默跳过）: ${String(e?.message ?? e).slice(0, 120)}`);
        return { skipped: true, reason: "写失败", day: evtDay };
    }
}

// ── 串行守卫（remind/mirror 同款）：onrunning 与 rpc 同刻触发合并补跑 ──

let inFlight = false;
let inFlightSince = 0;
let pending = false;
const INFLIGHT_DEADLOCK_MS = 10 * 60_000;

export async function runDailyWeatherGuarded(logger: WeatherLogger, now: Date = new Date()): Promise<WeatherResult | null> {
    if (inFlight && Date.now() - inFlightSince < INFLIGHT_DEADLOCK_MS) {
        pending = true;
        return null;
    }
    inFlight = true;
    inFlightSince = Date.now();
    try {
        let last: WeatherResult | null = null;
        do {
            pending = false;
            last = await runDailyWeather(logger, now);
        } while (pending);
        return last;
    } finally {
        inFlight = false;
    }
}
