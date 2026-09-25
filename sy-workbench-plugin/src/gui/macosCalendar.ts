// sloop □7：macOS 日历 JXA 通道·渲染进程封装。
// 前置=Electron renderer nodeIntegration（window.require 可用，思源桌面版恒开）+ 平台 darwin；
// 浏览器版/移动端/Windows/Linux=isMacCalendarAvailable()=false（设置页隐藏该后端）。
// 副作用收口：execFile(/usr/bin/osascript -l JavaScript jxa/sched-calendar.jxa, JSON argv)，
// 15s 超时兜底（goja 家族教训同源：无超时=hang 死锁；这里 node 侧有 timeout 保护）。
// 错误分类（调研实锤 09-16）：-1743=自动化权限被拒；-1712=授权窗挂起/用户没点。
// 单测 mock 边界=本模块 exec 调用（注入 runner）。

export type MacCalStatus = "ok" | "unavailable" | "perm_denied" | "perm_pending" | "error";

export interface MacCalReply<T = any> {
    ok: boolean;
    status: MacCalStatus;
    data?: T;
    error?: string;
}

/** node require 通道（浏览器版 window.require 不存在须退守） */
export function nodeRequire(): ((m: string) => any) | null {
    try {
        const r = (window as any).require;
        return typeof r === "function" ? r : null;
    } catch {
        return null;
    }
}

export function isMacCalendarAvailable(): boolean {
    const req = nodeRequire();
    if (!req) return false;
    try {
        return req("process").platform === "darwin";
    } catch {
        return false;
    }
}

/** JXA 脚本路径（插件产物根=工作区 data/plugins/<插件>/，jxa/ 随包分发） */
export function jxaScriptPath(): string {
    const dataDir = (window.siyuan as any)?.config?.system?.dataDir ?? "/data";
    return `${dataDir}/plugins/sy-workbench-plugin/jxa/sched-calendar.jxa`;
}

/** execFile 注入口（单测用；缺省=node child_process） */
export type JxaRunner = (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
let runner: JxaRunner | null = null;

export function setJxaRunner(r: JxaRunner | null): void {
    runner = r;
}

function defaultRunner(): JxaRunner | null {
    const req = nodeRequire();
    if (!req) return null;
    try {
        const { execFile } = req("child_process");
        return (args, timeoutMs) =>
            new Promise((resolve, reject) => {
                execFile(
                    "/usr/bin/osascript",
                    ["-l", "JavaScript", jxaScriptPath(), ...args],
                    { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
                    (err: any, stdout: string, stderr: string) => {
                        if (err) {
                            (err as any).stderr = stderr;
                            reject(err);
                        } else {
                            resolve({ stdout, stderr });
                        }
                    },
                );
            });
    } catch {
        return null;
    }
}

/** 调 JXA 命令（cmd 对象序列化为 argv[0]）；回执 JSON 解析+错误分类 */
export async function jxaCalendar<T = any>(cmd: Record<string, unknown>, timeoutMs = 15_000): Promise<MacCalReply<T>> {
    const run = runner ?? defaultRunner();
    if (!run) return { ok: false, status: "unavailable", error: "child_process 不可用（浏览器版/移动端）" };
    try {
        const { stdout } = await run([JSON.stringify(cmd)], timeoutMs);
        try {
            const data = JSON.parse(stdout) as { ok: boolean; error?: string };
            return data.ok
                ? { ok: true, status: "ok", data: data as T }
                : { ok: false, status: "error", error: data.error ?? "jxa error" };
        } catch {
            return { ok: false, status: "error", error: `jxa 输出非 JSON: ${stdout.slice(0, 160)}` };
        }
    } catch (e: any) {
        const err = String(e?.stderr ?? e?.message ?? e);
        if (err.includes("-1743")) return { ok: false, status: "perm_denied", error: err };
        if (err.includes("-1712")) return { ok: false, status: "perm_pending", error: err };
        return { ok: false, status: "error", error: err };
    }
}
