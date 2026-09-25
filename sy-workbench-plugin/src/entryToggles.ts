// pjux □2 命令与入口开关：petal entry-toggles.json 轻量存储（project 无 settingCfg 基建，
// 走插件原生 loadData/saveData——读写同 petal 目录）。默认全开：键缺失/文件不存在=旧版
// 升级用户无感。消费四点：onload 命令注册链（saveScene/setRemind off=不 push——命令面板
// 即消失）、onload 顶栏按钮注册（openAmmoTopbar off=不 addTopBar——可见入口即消失）、
// open-menu-content handler（off=不加项，活读即时）、protyleSlash（off=不 push，
// 运行期活插拔——slash 菜单构建时活读数组，思源源码 extend.ts 实证）。命令/顶栏开关改动经
// 「存盘+收面板+reloadSelfPlugin」生效（命令与 addTopBar 都注册在 onload；重载链=tomato
// pluginReload.ts 跨插件先例；思源 3.9+ 命令面板走冻结式 registry，数组活拔不注销，只能重载）。

/** type alias（非 interface）：对象字面量形态才带隐式索引签名，可直接赋 Record<string, boolean> */
export type EntryToggles = {
    saveScene: boolean;
    setRemind: boolean;
    contextMenu: boolean;
    slash: boolean;
    /** caltab：命令面板「打开时间线」（off=命令不注册——命令面板/键位即消失） */
    openTimeline: boolean;
    /** ammoentry □2：顶栏「弹药库」按钮（off=不 addTopBar——可见入口即消失；openAmmo 命令
     *  本体不受控=命令面板/键位照常） */
    openAmmoTopbar: boolean;
};

export const ENTRY_TOGGLES_FILE = "entry-toggles.json";

export const DEFAULT_ENTRY_TOGGLES: EntryToggles = {
    saveScene: true,
    setRemind: true,
    contextMenu: true,
    slash: true,
    openTimeline: true,
    openAmmoTopbar: true,
};

/** 存档容错归一：loadData 双形态（content-type 非 json 返回字符串——仓内其它消费点同款
 *  双形态容错）+部分键缺失/类型不对回落默认（旧档升级、手改坏档都不炸） */
export function normalizeEntryToggles(raw: unknown): EntryToggles {
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw || "null");
        } catch {
            raw = null;
        }
    }
    const src = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof EntryToggles, unknown>>;
    const out = { ...DEFAULT_ENTRY_TOGGLES };
    for (const k of Object.keys(DEFAULT_ENTRY_TOGGLES) as Array<keyof EntryToggles>) {
        if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
    }
    return out;
}
