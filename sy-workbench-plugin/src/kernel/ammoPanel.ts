// ammo □6：四象限面板聚合读面（kernel rpc）——一面拿全面板原料（每日配置+日账实吃+
// 不想做清单+引擎运行态），前端 AmmoPanelHost 挂载首读与 AMMO_STATE_CHANNEL 广播后重拉
// 都走它（单面免四次 rpc 交错）。视图合成在 core/ammoPanel.ts 纯层（本文件只做 IO 编排）。
// 读通道零副作用零建档（sched-board-read 先例同款：locate/read 全家不建不写）。
// ⚠️全静态导入（CJS 打包图纪律：插件内动态 import 重排打包图=svelte internal 循环崩）。
import { getBlockAttrs } from "./api";
import { readDayLedger } from "./ammoLedger";
import { readDayConfig, readAversions, type AversionItem, type AversionsRead } from "./ammoQuadrant";
import { ammoStatusRpc } from "./ammoEngine";
import type { AmmoRunSnapshot, AmmoDanglingRef } from "./ammoEngine";
import { poolMinutesFromLedger } from "./core/ammoQuadrant";
import { buildPoolViews, buildTaskViews, buildCircleView, type AmmoPoolView, type AmmoTaskView, type AmmoCircleView } from "./core/ammoPanel";
import { isValidDay } from "./core/schedule";

/** 面板数据面（rpc 返回形态=组件 props 直喂） */
export interface AmmoPanelData {
    ok: boolean;
    day: string;
    /** 四池视图（配比+消耗态合成——core/ammoPanel buildPoolViews 产物） */
    pools: AmmoPoolView[];
    /** 当日任务行视图（含运行/悬账归属与 each key——core buildTaskViews 产物） */
    tasks: AmmoTaskView[];
    /** 中央不想做圈视图（鞭策墙+三分区） */
    circle: AmmoCircleView;
    /** 引擎运行中快照（null=无；锚点出发型任务行匹配不到，横幅显示） */
    running: AmmoRunSnapshot | null;
    /** 悬账清单（面板补结条逐条出示） */
    dangling: AmmoDanglingRef[];
    /** 引擎状态代数（透传——前端按 rev 判新鲜） */
    rev: number;
    /** 森林域/日记域读取可用性（false=note 有原因文案，组件空态展示） */
    available: boolean;
    note?: string;
    error?: string;
}

/** 本地日 YYYY-MM-DD（ammoEngine.localDay 同款——rpc 缺省日参用） */
function localDay(now: number): string {
    const d = new Date(now);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 悬账条目的 task 指针读（打点条目属性直读——AmmoDanglingRef 未带 task 字段，行归属
 *  判定补读一次；失败=空串不挂徽标，悬账条本体照常出示） */
async function readEntryTask(blockId: string): Promise<string> {
    try {
        const attrs = await getBlockAttrs(blockId);
        return attrs?.["custom-ammo-task"] ?? "";
    } catch {
        return "";
    }
}

/** 面板聚合读（零写零建档；任何子面失败不炸整面——failed 子面按空态落+note 说明）。
 *  悬账归属行判定=dangling 条目 task 指针集（锚点出发型/无主条目不挂行徽标，走悬账条）。 */
export async function ammoPanelRpc(day?: string): Promise<AmmoPanelData> {
    const today = isValidDay(day ?? "") ? day! : localDay(Date.now());
    // 子面并行发起（互相独立；readDayConfig/readDayLedger 全只读，无交错面）
    const [cfgRes, ledgerRes, stRes] = await Promise.all([
        readDayConfig(today).catch((e: any) => ({ ok: false, config: null, error: String(e?.message ?? e) })),
        readDayLedger(today).catch((e: any) => ({ ok: false, items: [], error: String(e?.message ?? e) })),
        ammoStatusRpc(today).catch((e: any) => ({ ok: false, running: null, dangling: [], focus: null, rev: 0, error: String(e?.message ?? e) })),
    ]);
    const digest = poolMinutesFromLedger(ledgerRes.items);
    const danglingTasks: string[] = [];
    for (const d of stRes.dangling ?? []) {
        const task = (await readEntryTask(d.blockId)).trim();
        if (task) danglingTasks.push(task);
    }
    const available = ledgerRes.ok && cfgRes.ok;
    const note = !ledgerRes.ok
        ? `日账读取失败：${ledgerRes.error ?? "?"}`
        : !cfgRes.ok
            ? `每日配置读取失败：${(cfgRes as any).error ?? "?"}`
            : undefined;
    // readAversions 读面失败不炸整面（fail-soft 同款——中央圈按空态落+默认分区名）；healthNote（分区
    // 结构体检提示）为 □8 体检入口素材，面板暂不展示。sectionTitles（文档实际分区标题）随行。
    const aversions = await readAversions().catch((): AversionsRead => ({ items: [] as AversionItem[] }));
    return {
        ok: true,
        day: today,
        pools: buildPoolViews({ config: cfgRes.config, actualByPool: digest.pools }),
        tasks: buildTaskViews({
            config: cfgRes.config,
            running: stRes.running,
            danglingTasks,
        }),
        circle: buildCircleView(aversions.items, aversions.sectionTitles),
        running: stRes.running,
        dangling: stRes.dangling ?? [],
        rev: stRes.rev ?? 0,
        available,
        ...(note ? { note } : {}),
    };
}
