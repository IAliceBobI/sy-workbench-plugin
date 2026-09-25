// sloop □7：班表到点提醒引擎（思源内推送 toast / 弹窗——与「外部日历自带提醒」三通道解耦勾选）。
// 设计档 §1：提醒与数据解耦（不镜像也能在思源内收到到点提醒）；两大核心能力之一=到点提醒
// 开始/结束+做什么（bear 09-16 定位输入）。
// 30s 轻拍：班表缓存（pj-schedule-updated 事件失效+60s 兜底重拉）；已触发键按日记
// localStorage（跨 reload 去重）；迟开思源不追旧账（grace 窗 10 分钟）。
// □16 泛化：块提醒（custom-remind-at/end）接进同引擎同勾选清单——提醒通道不分家
// （开启 toast/弹窗后班表与块提醒都到点提醒）；循环=今日触发日才判、任务勾选静默（与图标红态同语义）。
import { Dialog, showMessage } from "siyuan";
import { getLogicalDay } from "./kernel/core/dates";
import { formatShortRemind, parseRemindAt, parseRemindRepeat, repeatParts, stripTaskMark, todayIsOccurrence } from "./kernel/core/remind";
import { DEFAULT_REMINDER_CHANNELS, type ReminderChannels } from "./shared/channels";
import { buildDepartParams, stripAnchorSummary, type DepartWireParams } from "./ammoDepartWire";

/** 块提醒行（feQuery=listRemindBlocksSql 直出形态） */
export interface RemindNotifyRow {
    id: string;
    at: string;
    end: string | null;
    repeat: string | null;
    content: string;
    markdown: string;
    /** 期② 班表块旗标（=班表条目块——s: 拍跳过同 key 条目，rs: 块真身路接管防双 toast） */
    sched_origin?: string | null;
}

export interface SchedNotifyHost {
    loadReminderChannels(): Promise<ReminderChannels>;
    /** □16：全库块提醒扫描（60s 缓存——写后最迟一分钟进入提醒窗，30s 拍照常兜） */
    loadRemindRows(): Promise<RemindNotifyRow[]>;
    /** dataview □3：锚点出发（kernel rpc ammo-depart——闭当前打点+开锚点出发型 B2.4）。
     *  可选=宿主无此通道时弹窗降级只出「知道了」（旧宿主/测试桩零破坏） */
    ammoDepart?(p: DepartWireParams): Promise<{ ok: boolean; error?: string }>;
    i18n: Record<string, string>;
}

const TICK_MS = 30_000;
/** 迟开/错过不追：到点 10 分钟后才开思源=不打扰（旧账去交接会对） */
const GRACE_MIN = 10;
/** 班表/通道缓存兜底重拉间隔 */
const REFRESH_MS = 60_000;
const LS_KEY = "pj-sched-fired";

interface FiredState {
    day: string;
    keys: string[];
}

function loadFired(day: string): Set<string> {
    try {
        const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as FiredState;
        if (raw?.day === day && Array.isArray(raw.keys)) return new Set(raw.keys);
    } catch {
        // 坏档=空集重记
    }
    return new Set();
}

function saveFired(day: string, keys: Set<string>): void {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({ day, keys: [...keys] } satisfies FiredState));
    } catch {
        // 隐私模式等 localStorage 不可用=跨 reload 可能重复提醒，可容忍
    }
}

export class SchedNotifier {
    private host: SchedNotifyHost | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private reminds: RemindNotifyRow[] | null = null;
    private remindsAt = 0;
    private channels: ReminderChannels = DEFAULT_REMINDER_CHANNELS;
    private channelsAt = 0;
    private dialog: Dialog | null = null;

    setup(host: SchedNotifyHost): void {
        this.host = host;
        window.addEventListener("pj-schedule-updated", this.bust);
        this.timer = setInterval(() => void this.tick(), TICK_MS);
    }

    destroy(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        window.removeEventListener("pj-schedule-updated", this.bust);
        this.dialog?.destroy();
        this.dialog = null;
        this.host = null;
    }

    /** 班表被改（前端 schedEdit/kernel 广播）→ remind 行缓存失效（班表块在 remind 行里），下拍重拉 */
    private bust = (): void => {
        this.reminds = null;
    };

    private async tick(): Promise<void> {
        const host = this.host;
        if (!host) return;
        const now = new Date();
        const day = getLogicalDay(now);
        if (!this.channels || Date.now() - this.channelsAt > REFRESH_MS) {
            this.channels = await host.loadReminderChannels().catch(() => DEFAULT_REMINDER_CHANNELS);
            this.channelsAt = Date.now();
        }
        if (!this.channels.toast && !this.channels.dialog) return;
        if (!this.reminds || Date.now() - this.remindsAt > REFRESH_MS) {
            this.reminds = await host.loadRemindRows().catch(() => null as unknown as RemindNotifyRow[]);
            this.remindsAt = Date.now();
        }
        if (!this.reminds) return;
        const t = host.i18n;
        const fired = loadFired(day);
        const touched = this.tickReminds(t, now, fired);
        if (touched) saveFired(day, fired);
    }

    /** □16 块提醒拍：单次=绝对时刻窗；循环=今日触发日才判（at 时刻挂今天）；任务勾选静默。
     *  返回是否有新触发（调用方落 fired 池）。 */
    private tickReminds(t: Record<string, string>, now: Date, fired: Set<string>): boolean {
        const rows = this.reminds;
        if (!rows?.length || !this.channels) return false;
        const nowMs = now.getTime();
        let touched = false;
        for (const r of rows) {
            const atD = parseRemindAt(r.at);
            if (!atD) continue;
            if (/^\s*[-*+]\s*\[[xX]\]/.test(r.markdown ?? "")) continue; // 任务勾选静默（与红态同语义）
            const rp = r.repeat ? parseRemindRepeat(r.repeat) : null;
            // 跨零点 end（22:00~次日01:00）的结束提醒挂在「次日凌晨」——今日非触发日不代表昨日不是：
            // 只有「今日与昨日都不是触发日」才整行跳过（reasoning P2-1：weekly/every+跨零点曾被吞）
            const yesterday = new Date(now.getTime() - 86_400_000);
            const occursToday = !rp || todayIsOccurrence(r.at, rp, now);
            const crossMidnightEnd = Boolean(rp && r.end && parseRemindAt(r.end) && parseRemindAt(r.end)!.getDate() !== atD.getDate());
            if (!occursToday && !(crossMidnightEnd && todayIsOccurrence(r.at, rp!, yesterday))) continue;
            // 今日触发时刻：循环=at 时刻挂今天；单次=at 本身（过去单次只在 grace 窗内补提）
            const fireAt = rp
                ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), atD.getHours(), atD.getMinutes()).getTime()
                : atD.getTime();
            const plain = stripTaskMark(r.content ?? "");
            // 空草稿到点不弹「（无内容）」（期 2 ⑤ 班表草稿+H1 右键创建段落块同语义——
            // 与同步侧草稿闸对齐：空内容不建事件；写了字自然恢复弹+推）
            if (!plain.replace(/\u200b/g, "").trim()) continue;
            const label = plain.slice(0, 80) || "（无内容）";
            // slot：循环行=纯时刻（锚点日期无意义——12-01 锚在 12-20 触发会显示误导，reasoning P2-2）；
            // 同日 end 拼后缀与 formatShortRemind 同则，跨零点不拼。
            // 班表行（sched_origin，期 4 起进 remind 拍）=当日行——纯时刻段+班表文案（开始了：…），
            // 提醒体感与原班表拍一致
            const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
            const endD = r.end ? parseRemindAt(r.end) : null;
            const sameDayEnd = Boolean(endD && endD.getDate() === atD.getDate() && endD.getTime() > atD.getTime());
            const isBoard = Boolean(r.sched_origin);
            const slot = isBoard
                ? `${hhmm(atD)}${sameDayEnd ? `–${hhmm(endD!)}` : ""}`
                : !rp
                    ? formatShortRemind(r.at, now, r.end ?? null)
                    : `${repeatParts(r.repeat!, r.at)?.time ?? hhmm(atD)}${sameDayEnd ? `~${hhmm(endD!)}` : ""}`;
            const sKey = `rs:${r.id}`;
            if (!fired.has(sKey) && nowMs >= fireAt && nowMs <= fireAt + GRACE_MIN * 60_000) {
                fired.add(sKey);
                touched = true;
                const tmpl = isBoard ? (t.schedNotifyStart ?? "开始了：{s}（{slot}）") : (t.remindNotifyStart ?? "提醒到了：{s}（{slot}）");
                const msg = tmpl.replace("{s}", label).replace("{slot}", slot);
                if (this.channels.toast) showMessage(msg, 5000, "info");
                if (this.channels.dialog) {
                    // dataview □3：班表行（sched_origin=班表条目块）弹窗带「出发」钮——
                    // 锚点上下文=task 指针（块 id）+剥时刻头的纯摘要；普通块提醒不带（锚点
                    // 出发型的 task 须指向班表锚点条目，非班表块出发=造违约指针）。
                    // 空摘要不出发钮（引擎 summary 非空校验——裸时刻锚点无文案可落账）
                    const plainSummary = stripAnchorSummary(r.content);
                    const depart = isBoard && plainSummary ? { summary: plainSummary, task: r.id } : undefined;
                    this.popup(msg, slot, isBoard ? (t.schedNotifyDialogTitle ?? t.remindNotifyTitle) : (t.remindNotifyTitle ?? t.schedNotifyDialogTitle), depart);
                }
            }
            // 结束提醒（仅 toast；end 合法才判——循环跨零点 end 按当日时刻挂今天）
            const eKey = `re:${r.id}`;
            if (r.end && this.channels.toast && !fired.has(eKey)) {
                const endD = new Date(r.end);
                if (!Number.isNaN(endD.getTime()) && endD.getTime() > atD.getTime()) {
                    const fireEnd = rp
                        ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), endD.getHours(), endD.getMinutes()).getTime()
                        : endD.getTime();
                    if (nowMs >= fireEnd && nowMs <= fireEnd + GRACE_MIN * 60_000) {
                        fired.add(eKey);
                        touched = true;
                        const tmpl = isBoard ? (t.schedNotifyEnd ?? "到结束时间了：{s}（{slot}）") : (t.remindNotifyEnd ?? "到结束时间了：{s}（{slot}）");
                        showMessage(tmpl.replace("{s}", label).replace("{slot}", slot), 5000, "info");
                    }
                }
            }
        }
        return touched;
    }

    /** 弹窗通道（用户显式勾选才启用——反 push 红线下的自愿通道）；同刻只弹一个。
     *  summary 是用户/AI 文本——innerHTML 前转义；桌面 Dialog 无 ×（移动端限定）须自带关闭钮。
     *  depart（dataview □3）：班表锚点行+宿主有 ammoDepart 通道时加「出发」钮（主钮实心
     *  b3 默认态，「知道了」降 b3-button--cancel 弱化——两态控件纪律）。 */
    private popup(msg: string, _slot: string, title?: string, depart?: { summary: string; task: string }): void {
        const t = this.host?.i18n ?? {};
        const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        this.dialog?.destroy();
        const canDepart = Boolean(depart?.task && this.host?.ammoDepart);
        const dialog: Dialog = new Dialog({
            title: title ?? t.schedNotifyDialogTitle ?? "日程提醒",
            content: `<div class="b3-dialog__content" style="padding:16px">${esc(msg)}</div>`
                + `<div class="b3-dialog__action">`
                + (canDepart ? `<button class="b3-button pj-sched-depart-btn">${esc(t.schedNotifyDepart ?? "出发")}</button>` : "")
                + `<button class="b3-button b3-button--cancel pj-sched-ack-btn">${esc(t.schedNotifyBtn ?? "知道了")}</button>`
                + `</div>`,
            destroyCallback: () => {
                if (this.dialog === dialog) this.dialog = null;
            },
        });
        this.dialog = dialog;
        dialog.element.querySelector(".pj-sched-ack-btn")?.addEventListener("click", () => dialog.destroy());
        if (canDepart && depart) {
            const btn = dialog.element.querySelector(".pj-sched-depart-btn") as HTMLButtonElement | null;
            btn?.addEventListener("click", () => {
                void this.doDepart(dialog, btn, depart);
            });
        }
    }

    /** 出发动作（rpc in flight 期锁钮防双击）：回包 ok=关弹窗+确认 toast；失败=error toast
     *  留弹窗可重试（引擎 {ok:false,error} 不 throw——rpc 断链 catch 兜同形） */
    private async doDepart(dialog: Dialog, btn: HTMLButtonElement, depart: { summary: string; task: string }): Promise<void> {
        const host = this.host;
        if (!host?.ammoDepart) return;
        btn.disabled = true;
        const t = host.i18n ?? {};
        const p = buildDepartParams({
            summary: depart.summary,
            task: depart.task,
            now: new Date(),
            owner: schedOwnerAppId(),
        });
        const r = await host.ammoDepart(p).catch(() => ({ ok: false, error: "" }));
        if (r?.ok) {
            showMessage((t.schedNotifyDepartDone ?? "已出发：{s}").replace("{s}", depart.summary), 2500, "info");
            dialog.destroy();
        } else {
            btn.disabled = false;
            showMessage((t.schedNotifyDepartFail ?? "出发失败：{msg}").replace("{msg}", r?.error || (t.schedNotifyDepartTimeout ?? "rpc 无响应")), 3500, "error");
        }
    }
}

/** 本窗 app id（owner 门牌——引擎快照透传他窗只读展示；AmmoPanelHost ownerAppId 同款） */
function schedOwnerAppId(): string {
    try {
        return new URL((window as any).siyuan?.ws?.ws?.url ?? "").searchParams.get("app") ?? "";
    } catch {
        return "";
    }
}
