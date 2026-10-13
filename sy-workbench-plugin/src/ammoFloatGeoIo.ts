// lsfix 2026-10-13 家族战役·弹药库悬浮窗几何档（消费者 src/AmmoFloatPanel.svelte）：
// localStorage「pj-ammo-float-panel」单键 JSON → petal 档（uiState.ts AMMO_FLOAT_GEO_FILE）。
// 思源桌面 Electron 壳每次启动给内置内核随机端口（server.listen(0)，origin 含端口），
// 浏览器 localStorage 按 origin 隔离=桌面端每次重启全部蒸发（会话内一切正常）——群实报
// 「块编辑器收缩球位置重启丢失」同病根（tomato qeBall/bkFloatPanelGeo 同族战役）。
// localStorage 降级为旧档一次性收编源（收编时读取、收编后不回写，qeBall.loadQEBallPos
// 同款）。store 层=index.ts uiAmmoFloatGeo 内存态（onload loadUiStatePrefs 预载归一）+
// saveAmmoFloatGeo 写盘方法族——宿主 AmmoFloat.ts 的 deps 面不透插件实例（宿主=开合档
// 站点消费者文件，勿动），经官方插件注册表 window.siyuan.ws.app.plugins 反查本插件实例
// （内核 loader.ts getPluginCatalogPlugins 同通道；attach 先于 onload=组件挂载时实例必
// 在表）。写路径恒走 saveAmmoFloatGeo（内部官方两参 saveData 恒带 app 本窗免重载，
// AGENTS petal 写纪律——绕开实例直连 putFile 会炸重载风暴环）。
import { normalizeAmmoFloatGeo, type AmmoFloatGeo } from "./uiState";

/** 旧档收编源（lsfix 前主档，仅 loadAmmoFloatGeo 读） */
export const AMMO_FLOAT_PANEL_LS_KEY = "pj-ammo-float-panel";

/** 本插件实例（uiAmmoFloatGeo/saveAmmoFloatGeo 登记宿主）；注册表未就绪/异名→null 不炸
 *  （globalThis.window 取值：node 单测环境无 window 声明，裸 window 引用会 ReferenceError） */
function workbenchPlugin(): any | null {
    const list = (globalThis as any).window?.siyuan?.ws?.app?.plugins;
    if (!Array.isArray(list)) return null;
    return list.find((p: any) => p?.name === "sy-workbench-plugin") ?? null;
}

/** 面板几何读档：store 档（实例内存态）优先——x/y/w/h 任一非 finite 判无档（坏档不猜
 *  半个几何）、o 坏值回 1（normalizeAmmoFloatGeo 容错，双保险防内存态被污染）；无档时
 *  收编 localStorage 旧档（固定端口环境有真值，桌面端随机端口 origin 下恒空）并落新档。
 *  均无→null（调用方回默认右下 640×560 落位） */
export function loadAmmoFloatGeo(): AmmoFloatGeo | null {
    const cur = normalizeAmmoFloatGeo(workbenchPlugin()?.uiAmmoFloatGeo ?? null);
    if (cur) return cur;
    const legacy = normalizeAmmoFloatGeo(
        typeof localStorage === "undefined" ? null : localStorage.getItem(AMMO_FLOAT_PANEL_LS_KEY),
    );
    if (legacy) saveAmmoFloatGeo(legacy);
    return legacy;
}

/** 面板几何落盘（拖拽/resize 松手、透明度 change 提交、旧档收编共用）：走登记方法
 *  saveAmmoFloatGeo=内存态 set+官方两参 saveData write 一体（qeBall「set 后紧跟
 *  void store.write()」的本插件同构——settingFactory 不在本插件基建内）。实例不在
 *  （异常时序）=静默 no-op；落盘失败吞错（几何仅会话内生效，原 localStorage
 *  try/catch 同语义——不吞会成 unhandled rejection） */
export function saveAmmoFloatGeo(v: AmmoFloatGeo | null): void {
    const p = workbenchPlugin();
    if (!p?.saveAmmoFloatGeo) return;
    Promise.resolve(p.saveAmmoFloatGeo(v)).catch(() => { /* 落盘失败：几何仅会话内生效 */ });
}
