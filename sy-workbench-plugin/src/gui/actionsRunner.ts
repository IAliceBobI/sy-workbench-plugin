// □2 动作执行层（前端副作用，零纯逻辑——解析在 kernel/core/actions）：
// 桌面版 spawn 起外部进程 / play 思源内打开并 seek / 视频进度捕获 / 自由命令确认弹窗。
// 桌面判据与 gui/oauth.ts 同款：window.require（Electron renderer nodeIntegration）；
// 浏览器版/移动端无此能力→spawn 类动作置灰（play 走 openTab 前端 API，全端可用）。
import { confirm as siyuanConfirm, getAllEditor, openTab } from "siyuan";
import { debugLog } from "../libs/debugLog";
import type { ParsedAction } from "../kernel/core/actions";
import { OPEN_NO_FOCUS_ACTION } from "../scene/executor";

export interface RunResult {
    ok: boolean;
    error?: string;
}

/** 桌面 Electron renderer 判据（spawn 类动作可用性） */
export function desktopAvailable(): boolean {
    return typeof (globalThis as any).window?.require === "function";
}

/** 自由命令确认弹窗（siyuan confirm 是回调风格——包 Promise；两头只结算一次防双击） */
export function confirmAction(title: string, text: string): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v: boolean): void => {
            if (!settled) {
                settled = true;
                resolve(v);
            }
        };
        siyuanConfirm(title, text, () => done(true), () => done(false));
    });
}

/** 桌面版起外部进程（fire-and-forget：detached+stdio ignore，不收 stdout——VS Code/视频场景不需要）。
 *  spawn 的异步错误（ENOENT/EACCES）走 error 事件——留 300ms 短窗捕获上报，过了即视为已起 */
export async function runSpawnAction(action: ParsedAction): Promise<RunResult> {
    const req = (globalThis as any).window?.require;
    if (typeof req !== "function") return { ok: false, error: "desktop-only" };
    let cp: any;
    try {
        cp = req("child_process");
    } catch {
        return { ok: false, error: "child_process unavailable" };
    }
    debugLog("act", `spawn: ${action.command}`);
    return await new Promise<RunResult>((resolve) => {
        let settled = false;
        let child: any;
        try {
            child = cp.spawn(action.program, action.tokens.slice(1), { detached: true, stdio: "ignore" });
        } catch (e: any) {
            resolve({ ok: false, error: String(e?.message ?? e) });
            return;
        }
        const fail = (err: any): void => {
            if (!settled) {
                settled = true;
                resolve({ ok: false, error: String(err?.message ?? err) });
            }
        };
        try {
            child.on("error", fail);
            child.unref();
        } catch { /* unref 失败不影响已起进程 */ }
        setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve({ ok: true });
            }
        }, 300);
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function seekVideo(v: HTMLVideoElement, seconds: number): void {
    const apply = (): void => {
        try {
            v.currentTime = seconds;
        } catch {
            /* 元数据未到再等下一次 loadedmetadata */
        }
    };
    if (v.readyState >= 1) apply();
    else v.addEventListener("loadedmetadata", apply, { once: true });
}

function videosFor(target: string, isBlockId: boolean): HTMLVideoElement[] {
    if (!isBlockId) return Array.from(document.querySelectorAll("video")); // 资产页签播放器
    try {
        for (const ed of getAllEditor() as any[]) {
            if (ed?.protyle?.block?.rootID === target) {
                return Array.from(ed.protyle.element.querySelectorAll("video"));
            }
        }
    } catch {
        // getAllEditor 不可用=空
    }
    return [];
}

/** play：思源内打开（文档块 id 或 assets/ 路径）并 seek 到 --start（视频从哪开始看）。
 *  编辑器/页签异步渲染——轮询 6s 窗找 video；找不到也视为成功（打开本身已达成，seek 尽力） */
export async function runPlayAction(app: any, action: ParsedAction): Promise<RunResult> {
    const target = action.playTarget;
    if (!target) return { ok: false, error: "play 目标缺失（play 后跟文档 id 或 assets/ 路径）" };
    const isBlockId = /^20\d{12}-[0-9a-z]{7}$/.test(target);
    try {
        if (isBlockId) {
            // OPEN_NO_FOCUS_ACTION（□13）：isBlockId 接纳任意块 id，非根块裸开= getDoc
            // mode 0 聚焦形态；同款组合钉死（zoomIn:false 防回归）
            await openTab({ app, doc: { id: target, zoomIn: false, action: OPEN_NO_FOCUS_ACTION } });
        } else {
            await openTab({ app, asset: { path: target } });
        }
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }
    if (action.startSeconds === undefined) {
        debugLog("act", `play ${target} (no start)`);
        return { ok: true };
    }
    let sought = false;
    for (let i = 0; i < 20 && !sought; i++) {
        await sleep(300);
        const videos = videosFor(target, isBlockId);
        if (videos.length > 0) {
            for (const v of videos) seekVideo(v, action.startSeconds);
            sought = true;
        }
    }
    debugLog("act", `play ${target} start=${action.startSeconds}s sought=${sought ? 1 : 0}`);
    return { ok: true };
}

/** 当前视频播放位置（秒，向下取整）：全文档扫描，取看得最远的（多视频时选进度最深那个；
 *  全 0=没在播/刚开头——记进度无意义，回 null 让 UI 提示） */
export function captureVideoProgressSeconds(): number | null {
    const withPos = Array.from(document.querySelectorAll("video")).filter((v) => v.currentTime > 0);
    if (withPos.length === 0) return null;
    let best = withPos[0];
    for (const v of withPos) {
        if (v.currentTime > best.currentTime) best = v;
    }
    return Math.floor(best.currentTime);
}
