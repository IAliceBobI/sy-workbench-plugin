// 作息训练·期 1（sloop □3 数据源③）：文档停留采集器（纯前端——switch-protyle 是
// 前端事件，kernel 无感）。可见停留累计（visibilitychange 剔挂机段：窗口最小化/隐藏
// 不计时；应用失焦但窗口可见仍计——期 1 方向性信号，粗粒度可接受）。
// 持久化=petal 档 stay-archive.json（lsfix 2026-10-13 家族战役：原 localStorage 按天键
// ——思源桌面 Electron 每次启动给内核随机端口，origin 含端口变=localStorage 换格子清空，
// 跨重启必丢，当日累计与昨日档补推全灭；且写频高，原「不触 petal 零重载副作用」的顾虑由
// 官方两参 saveData 通道消除——index.ts saveStayArchive 恒带 app 本窗免重载，不走
// window.siyuan.storage 广播通道）。档定义/归一见 uiState.ts；rpc behavior-stay 全量
// 快照幂等覆盖仍是主持久链（结算即推+hourly 保险+onload 恢复即推当日与昨日档——本档
// =重启恢复源，重启丢本档＝当日累计真丢：kernel 档已被部分覆盖）。旧 localStorage 键
// sy-project-stay-<day>（动态键族）由 adoptLegacy 一次性收编，收编后不回写不删。
// 翻日清档语义（原 checkDay 只保当日）由内存 entries.clear() 继续承担，petal 档只存不删
// （多天共存换「重启后昨日档仍可补推 kernel」）。
import { BEHAVIOR_STAY_METHOD } from "../shared/channels";
import { getLogicalDay } from "../kernel/core/dates";
import { shiftDay } from "../kernel/core/behavior";
import type { StayArchive, StayEntry } from "../uiState";

// 旧档收编源（qeballfix 前的主档，仅 adoptLegacy 读——按天动态键族，扫前缀）
const LS_PREFIX = "sy-project-stay-";

// ---------- 纯函数（单测 tests/unit/behaviorTracker.test.ts） ----------

/** 旧档一次性收编判定（qeBall.loadQEBallPos 同款）：petal 档空时把 localStorage
 *  sy-project-stay-<day> 前缀族收进档，值 {entries:[...]} 包层原形零变形（坏键剔除，
 *  归一在落盘读取侧由 normalizeStayArchive 兜底）；档非空（已收编过/新版写过）→ null
 *  不动；档空且无合法旧键 → null（不落空档）。固定端口环境（浏览器版）旧档有真值，
 *  桌面端随机端口 origin 下恒空。 */
export function adoptLegacyStay(
    existing: StayArchive,
    lsKeys: readonly string[],
    readKey: (day: string) => string | null,
): StayArchive | null {
    if (Object.keys(existing).length > 0) return null;
    const merged: StayArchive = {};
    for (const k of lsKeys) {
        if (!k.startsWith(LS_PREFIX)) continue;
        const day = k.slice(LS_PREFIX.length);
        if (!day) continue;
        try {
            const parsed = JSON.parse(readKey(day) ?? "null");
            if (Array.isArray(parsed?.entries)) merged[day] = parsed;
        } catch { /* 坏键剔除 */ }
    }
    return Object.keys(merged).length > 0 ? merged : null;
}

/** 当日档写入合并：全档快照保留其他天（petal 档只存不删——翻日清内存语义由 checkDay
 *  的 entries.clear() 承担）；同日幂等覆盖（当日快照即全量，不留旧累计） */
export function mergeDayArchive(existing: StayArchive, day: string, entries: StayEntry[]): StayArchive {
    return { ...existing, [day]: { entries } };
}

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

    /** onload 挂载：事件监听+旧档收编+当日档恢复+首推（含昨日档——kernel 冻结前补数） */
    setup(plugin: any): void {
        this.plugin = plugin;
        this.checkDay();
        this.adoptLegacy();
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

    /** 逻辑日翻转：结算+推旧日档+清内存（petal 档只存不删，其他天档保留；localStorage
     *  旧键族退役后不再读写——收编源留着无害，qeBall 同款不删） */
    private checkDay(): void {
        const day = getLogicalDay(new Date());
        if (day === this.day) return;
        if (this.day) {
            this.settle();
            void this.pushDay(this.day);
            this.entries.clear();
        }
        this.day = day;
    }

    /** 旧 localStorage 键族一次性收编（loadQEBallPos 同款）：档空时扫前缀进档落盘，
     *  成功后 restoreToday/昨日档补推直接读新档。不可用（隐私模式等）→ 跳过，petal 档照跑 */
    private adoptLegacy(): void {
        try {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) keys.push(k);
            }
            const merged = adoptLegacyStay(this.readArchiveAll(), keys, (day) => localStorage.getItem(LS_PREFIX + day));
            if (merged) this.writeArchive(merged);
        } catch { /* localStorage 不可用 → 不收编 */ }
    }

    private restoreToday(): void {
        const dayArchive = this.readArchiveAll()[this.day];
        if (!dayArchive) return;
        for (const e of dayArchive.entries) {
            if (typeof e?.id === "string") {
                this.entries.set(e.id, { id: e.id, title: String(e.title ?? ""), seconds: Number(e.seconds) || 0, sessions: Number(e.sessions) || 0 });
            }
        }
    }

    private persistToday(): void {
        this.writeArchive(mergeDayArchive(this.readArchiveAll(), this.day, [...this.entries.values()]));
    }

    /** petal 全档读（index.ts loadUiStatePrefs 预载的内存态；收编/结算写后即时可见） */
    private readArchiveAll(): StayArchive {
        return this.plugin?.uiStayArchive ?? {};
    }

    /** petal 全档写（index.ts saveStayArchive：内存态+官方两参 saveData 免重载落盘——
     *  高频写路径 fire-and-forget；落盘失败无害：hourly 保险推+kernel 主持久链兜底） */
    private writeArchive(v: StayArchive): void {
        const save = this.plugin?.saveStayArchive;
        if (typeof save !== "function") return;
        void Promise.resolve(save(v)).catch(() => { /* 落盘失败不追：下轮结算重写全量快照 */ });
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

    /** 昨日档推送（petal 档直读——kernel 启动重建昨日画像后、冻结前补 stay） */
    private async pushArchiveDay(day: string): Promise<void> {
        await this.rpcPush(day, this.readArchive(day));
    }

    private readArchive(day: string): StayEntry[] {
        return this.readArchiveAll()[day]?.entries ?? [];
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
