// 作息训练·期 1（sloop □3 数据源③）：文档停留采集器（纯前端——switch-protyle 是
// 前端事件，kernel 无感）。可见停留累计（visibilitychange 剔挂机段：窗口最小化/隐藏
// 不计时；应用失焦但窗口可见仍计——期 1 方向性信号，粗粒度可接受）。
// 持久化=localStorage 按天键（不触 petal 零重载副作用；reload/重启恢复当日累计），
// 推送=rpc behavior-stay 全量快照幂等覆盖（结算即推+hourly 保险+onload 恢复即推
// 当日与昨日档——昨日档给 kernel 冻结前补数）。
import { BEHAVIOR_STAY_METHOD } from "../shared/channels";
import { getLogicalDay } from "../kernel/core/dates";
import { shiftDay } from "../kernel/core/behavior";

interface StayEntry {
    id: string;
    title: string;
    seconds: number;
    sessions: number;
}

const LS_PREFIX = "sy-project-stay-";

/** 标题尽力拿：文档标题输入框（空=消费侧按 id 对齐画像 docs.title） */
function docTitle(protyle: any): string {
    return String(protyle?.title?.editorTitle?.value ?? protyle?.block?.rootTitle ?? "");
}

export class StayTracker {
    private plugin: any = null;
    private day = "";
    private entries = new Map<string, StayEntry>();
    /** 当前停留段（pausedAt 非空=挂机暂停中，恢复时跳过该段） */
    private cur: { id: string; title: string; since: number; pausedAt: number | null } | null = null;
    private attached = false;

    /** onload 挂载：事件监听+当日档恢复+首推（含昨日档——kernel 冻结前补数） */
    setup(plugin: any): void {
        this.plugin = plugin;
        this.checkDay();
        this.restoreToday();
        void this.pushToday();
        void this.pushArchiveDay(shiftDay(this.day, -1));
        if (this.attached) return;
        this.attached = true;

        plugin.eventBus.on("switch-protyle", ({ detail }) => {
            this.checkDay();
            const rootId = (detail as any)?.protyle?.block?.rootID;
            if (!rootId) return;
            this.settle();
            this.cur = { id: rootId, title: docTitle((detail as any).protyle), since: Date.now(), pausedAt: document.hidden ? Date.now() : null };
        });
        plugin.eventBus.on("destroy-protyle", ({ detail }) => {
            const rootId = (detail as any)?.protyle?.block?.rootID;
            if (this.cur && rootId && this.cur.id === rootId) this.settle();
        });
        document.addEventListener("visibilitychange", () => {
            if (!this.cur) return;
            this.checkDay();
            if (document.hidden) {
                this.cur.pausedAt = Date.now();
            } else if (this.cur.pausedAt != null) {
                // 挂机段剔除：起始时刻平移过隐藏段
                this.cur.since += Date.now() - this.cur.pausedAt;
                this.cur.pausedAt = null;
            }
        });
        window.addEventListener("beforeunload", () => this.settle());
    }

    /** hourlyTimer 保险推（段内未结算的累计不推——快照=已结算部分，下轮结算补上） */
    hourlyFlush(): void {
        this.checkDay();
        void this.pushToday();
    }

    /** 插件 onunload（重载非页面卸载，beforeunload 不触发）：结算当前段+末次推送。
     *  eventBus 监听随插件实例销毁（无需手动 off）；beforeunload 监听泄漏一个无伤
     *  （重载后 setup 幂等防重复挂 eventBus；beforeunload 重复挂无害——settle 幂等） */
    dispose(): void {
        this.settle();
        void this.pushToday();
    }

    /** 逻辑日翻转：结算+推旧日档+清内存与 localStorage 旧键 */
    private checkDay(): void {
        const day = getLogicalDay(new Date());
        if (day === this.day) return;
        if (this.day) {
            this.settle();
            void this.pushDay(this.day);
            this.entries.clear();
            try {
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith(LS_PREFIX) && k !== LS_PREFIX + day) localStorage.removeItem(k);
                }
            } catch { /* localStorage 不可用（隐私模式等）→ 内存态照跑 */ }
        }
        this.day = day;
    }

    private restoreToday(): void {
        try {
            const raw = localStorage.getItem(LS_PREFIX + this.day);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed?.entries)) {
                for (const e of parsed.entries) {
                    if (typeof e?.id === "string") {
                        this.entries.set(e.id, { id: e.id, title: String(e.title ?? ""), seconds: Number(e.seconds) || 0, sessions: Number(e.sessions) || 0 });
                    }
                }
            }
        } catch { /* 坏档=空起步 */ }
    }

    private persistToday(): void {
        try {
            localStorage.setItem(LS_PREFIX + this.day, JSON.stringify({ entries: [...this.entries.values()] }));
        } catch { /* 不可用即跳过 */ }
    }

    /** 结算当前段（结算后段关闭；挂机暂停态=零时长直接弃段） */
    private settle(): void {
        const c = this.cur;
        this.cur = null;
        if (!c) return;
        if (c.pausedAt != null) return; // 全程挂机=零时长
        const deltaSec = Math.max(0, Math.round((Date.now() - c.since) / 1000));
        if (deltaSec < 1) return;
        const prev = this.entries.get(c.id);
        this.entries.set(c.id, {
            id: c.id,
            title: c.title || prev?.title || "",
            seconds: (prev?.seconds ?? 0) + deltaSec,
            sessions: (prev?.sessions ?? 0) + 1,
        });
        this.persistToday();
        void this.pushToday();
    }

    private snapshot(): StayEntry[] {
        return [...this.entries.values()].map((e) => ({ ...e }));
    }

    private async pushDay(day: string): Promise<void> {
        const entries = day === this.day ? this.snapshot() : this.readArchive(day);
        await this.rpcPush(day, entries);
    }

    private async pushToday(): Promise<void> {
        await this.rpcPush(this.day, this.snapshot());
    }

    /** 昨日档推送（localStorage 直读——kernel 启动重建昨日画像后、冻结前补 stay） */
    private async pushArchiveDay(day: string): Promise<void> {
        await this.rpcPush(day, this.readArchive(day));
    }

    private readArchive(day: string): StayEntry[] {
        try {
            const raw = localStorage.getItem(LS_PREFIX + day);
            const parsed = raw ? JSON.parse(raw) : null;
            return Array.isArray(parsed?.entries) ? parsed.entries : [];
        } catch {
            return [];
        }
    }

    private async rpcPush(day: string, entries: StayEntry[]): Promise<void> {
        if (!day) return;
        const rpc = (this.plugin as any)?.kernel?.rpc;
        if (!rpc?.call) return;
        try {
            await rpc.call[BEHAVIOR_STAY_METHOD]({ day, entries });
        } catch (e) {
            // 推送失败无害：hourly 保险推+onload 恢复推兜底
        }
    }
}

export const stayTracker = new StayTracker();
