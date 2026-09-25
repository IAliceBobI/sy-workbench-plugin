// 前端一键重授权 B 档（按钮化 c）：临时本地 http server 监听回调自动收 code → rpc calendar-auth 换证。
// 桌面 Electron renderer 专属（nodeIntegration:true——window.require("http") 可用，思源官方主窗实锤；
// 浏览器版/移动端 window.require 不存在→stage:"unsupported"，调用方退 A 档「手动贴 code」）。
// 安全语义：只监听 127.0.0.1、收到首个合法回调即关服、state 与授权链接成对（错 state 回调页面照常响应但不认）。
import { buildAuthorizeUrl, fp8 } from "../kernel/core/feishu";
import { OAUTH_REDIRECT_URI } from "../shared/channels";
import { debugLog } from "../libs/debugLog";

export type OAuthStage = "unsupported" | "open" | "callback" | "exchange";

/** 手动贴码容错（bear 09-14 点名）：用户常把回调后的整条地址栏 URL 复制进来——自己解析出 code；
 *  纯 code 原样返回。正则取 query 段 code= 而非 new URL（用户粘贴的串可能被截断/带前后杂字） */
export function extractAuthCode(raw: string): string {
    const s = raw.trim();
    const m = s.match(/[?&]code=([^&\s]+)/);
    if (m) {
        try {
            return decodeURIComponent(m[1]);
        } catch {
            return m[1];
        }
    }
    return s;
}

export interface OAuthFlowResult {
    ok: boolean;
    stage: OAuthStage;
    error?: string;
}

export interface OAuthFlowOptions {
    appId: string;
    /** 须与开放平台「安全设置」登记一致（默认 OAUTH_REDIRECT_URI） */
    redirectUri?: string;
    /** 回调监听端口（默认 19876；单测用随机端口） */
    port?: number;
    /** 等授权回调窗口（默认 30s） */
    timeoutMs?: number;
    /** 收到 code 后的换证（rpc calendar-auth；返回 {ok,error?}） */
    onCode: (code: string) => Promise<{ ok: boolean; error?: string }>;
}

const CALLBACK_PAGE = '<html><body style="font-family:system-ui;padding:40px;text-align:center">'
    + "<h3>&#9989; 已收到授权</h3><p>请回到思源笔记，授权结果稍后显示。</p></body></html>";

export async function runOAuthFlow(opts: OAuthFlowOptions): Promise<OAuthFlowResult> {
    const w = (globalThis as any).window;
    const req = w?.require;
    if (typeof req !== "function") {
        // 浏览器版（无 nodeIntegration）起不了本地收码服务，但授权页必须照开——否则用户手里
        // 没有 code 可贴=流程断档（bear 09-14 主实例实测）。授权后飞书重定向 localhost:19876
        // 显示「无法访问」属预期：地址栏整条 URL 含 code，复制回来手动贴（extractAuthCode 容错）。
        // state 用随机值（手动流程换证只认 code 不验 state，仅保持 URL 形态完整）
        try {
            w?.open(buildAuthorizeUrl(opts.appId, opts.redirectUri ?? OAUTH_REDIRECT_URI, Math.random().toString(36).slice(2, 10)), "_blank");
        } catch {
            // 弹窗被拦：设置页第 4 步平铺的授权链接行兜底
        }
        return { ok: false, stage: "unsupported", error: "no-require" };
    }
    let http: any;
    try {
        http = req("http");
    } catch {
        return { ok: false, stage: "unsupported", error: "http-module" };
    }

    const port = opts.port ?? 19876;
    const redirectUri = opts.redirectUri ?? OAUTH_REDIRECT_URI;
    const state = Math.random().toString(36).slice(2, 10);

    return await new Promise<OAuthFlowResult>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const server = http.createServer((req2: any, res: any) => {
            // 无论认不认都回友好页（用户浏览器侧不该看到连接拒绝）
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(CALLBACK_PAGE);
            const url = new URL(req2.url ?? "/", "http://127.0.0.1");
            const code = url.searchParams.get("code");
            if (!code || url.searchParams.get("state") !== state) return; // 错 state/探活：页面照答、码不收
            closeServer();
            clearTimeout(timer);
            // 换证给长一点的窗（走内核 proxy 外网，慢网兜底）
            timer = setTimeout(() => finish({ ok: false, stage: "exchange", error: "exchange-timeout" }), 120_000);
            void Promise.resolve(opts.onCode(code)).then(
                (r) => finish(r.ok ? { ok: true, stage: "exchange" } : { ok: false, stage: "exchange", error: r.error }),
                (e: any) => finish({ ok: false, stage: "exchange", error: String(e?.message ?? e) }),
            );
        });
        const closeServer = () => {
            try {
                server.close();
            } catch {
                // 已关
            }
        };
        const finish = (r: OAuthFlowResult) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            closeServer();
            resolve(r);
        };

        server.on("error", (e: any) => finish({ ok: false, stage: "open", error: String(e?.code ?? e) }));
        server.listen(port, "127.0.0.1", () => {
            debugLog("cal", `oauth server listening :${port} — opening authorize page`);
            const opened = w.open(buildAuthorizeUrl(opts.appId, redirectUri, state), "_blank");
            if (!opened) {
                debugLog("cal", "oauth authorize popup BLOCKED — user must open link manually");
                finish({ ok: false, stage: "open", error: "popup-blocked" });
            }
        });
        server.on("request", (req2: any) => {
            // 探活/回调都过这里一眼（页面响应在 createServer 回调；此处只记 code 到手时刻——
            // 与 rpc called 的时间差=code 在手上多久，5 分钟过期窗的量化证据）
            try {
                const u = new URL((req2 as any).url ?? "/", "http://127.0.0.1");
                if (u.searchParams.get("code")) {
                    debugLog("cal", `oauth callback code received fp=${fp8(u.searchParams.get("code"))} stateOk=${u.searchParams.get("state") === state}`);
                }
            } catch { /* 打点失败无碍 */ }
        });
        timer = setTimeout(() => finish({ ok: false, stage: "callback", error: "timeout" }), opts.timeoutMs ?? 30_000);
    });
}
