// 开发者本机调试日志（推本机 Grafana Loki，localhost:3100，见全局 loki skill）。
// 仅 dev 实例（端口段 6807~6999）推送——本插件现阶段只做开发验证，主实例零副作用；
// fire-and-forget，任何失败静默。时间戳必须纳秒（毫秒 ×1e6）。
// 自包含版（不复用 tomato logUtils：新插件独立生长，P1 再定是否共享码复用）。

const LOKI_PUSH_URL = "http://localhost:3100/loki/api/v1/push";

function isDevPort(port: string | undefined): boolean {
    const p = Number(port);
    return p >= 6807 && p <= 6999;
}

function portLabel(): string {
    // 非 browser 环境（纯 node 单测）无 location，占位保 label 值非空（Loki 拒空串）
    return globalThis.location?.port || "node";
}

export function debugLog(tag: string, msg: string): void {
    // 单测/node 环境无 location——恒跳（09-16 实锤：跑 vitest 往 Loki 灌假 calauth 行污染排障时间线）
    if (!globalThis.location) return;
    // cal 标签恒推（calauth 09-16 排障）：OAuth 授权链的 stage 证据在主实例才最有价值——
    // 前端 location.port 恒真值，还是 port=unknown 的 kernel 打点缺失的实例分流补充源。
    // 其余标签维持 dev-only（主实例零副作用立场不变）。
    if (!isDevPort(globalThis.location?.port) && tag !== "cal") return;
    const line = `[${tag}] ${msg}`;
    console.debug(`[project] ${line}`);
    const ts = `${Date.now()}000000`;
    const body = JSON.stringify({
        streams: [{
            stream: { job: "project-plugin", app: "frontend", port: portLabel() },
            values: [[ts, line]],
        }],
    });
    try {
        fetch(LOKI_PUSH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
        }).catch(() => { });
    } catch { /* 静默 */ }
}
