// 写盘验真链（calauth □1 RC-A）：siyuan.storage.put 无响应体校验——09-14 主实例实锤
// 「换证两轮 saveConfig rpc 回 ok、petal 文件 mtime/内容纹丝不动」的静默失败形态。
// 本模块把落盘语义从「信 put 的 resolve」升级为「信读回」：
//   put → 复核读（字节级比对）→ 失配同通道重试一次 → 再败 /api/file/putFile
//   独立通道兜底 → 仍失配=throw（上抛变 rpc 红——宁可见红，不可假绿）。
// Loki 时间线同步留痕三段结论（put/retry/fallback/fail），端到端复发可查。
// 适用面：oauth 配置等「丢了不可再生」的关键盘；账本/状态等自愈型写入不走此链（下轮重建）。
//
// calauth 09-16 升级：读回改**文件层权威**（/api/file/getFile 直读真盘）。旧版读回走
// siyuan.storage.get 与 put 共享同一缓存视图——09-15 20:05 实锤「put 留缓存未刷盘」形态下
// 同通道读回恒命中 → 报 ok via put 而盘上纹丝不动（新 refresh_token 未落、旧的已被滚动作废
// =授权链整条断掉）。storage 读回降级为观测面：两态分叉（storageOk=fileOk 不一致）即缓存
// 投影假绿的直接证据，打点行带 rt 指纹供跨 boot 对齐「哪个进程写的哪一版」。
import { putFileText, storageGetText, storagePutJson, getFileText } from "./api";
import { kernelLog } from "./loki";
import { fp8 } from "./core/feishu";

/** putFile/getFile 兜底与权威读的工作区绝对路径前缀（kernel sandbox baseDir=DataDir/storage/petal/<插件名>） */
const PETAL_DIR = "/data/storage/petal/sy-workbench-plugin";

/** 双通道读回状态：file=文件层真盘比对（判定权威）；storage=siyuan.storage 视图比对（观测） */
async function readbackState(key: string, payload: string): Promise<{ file: boolean; storage: boolean; note: string }> {
    const [fileTxt, storageTxt] = await Promise.all([
        getFileText(`${PETAL_DIR}/${key}`),
        storageGetText(key),
    ]);
    const file = fileTxt === payload;
    const storage = storageTxt === payload;
    const note = `file=${file ? "match" : fileTxt === null ? "miss" : "drift"},storage=${storage ? "match" : storageTxt === null ? "miss" : "drift"}`;
    return { file, storage, note };
}

/** oauth 配置专用指纹（rt=refreshToken 短哈希；其他键无 oauth 字段则不加） */
function rtFp(value: unknown): string {
    const rt = (value as any)?.oauth?.refreshToken;
    return rt ? `,rt=${fp8(String(rt))}` : "";
}

/** 验真写：三通道全败才 throw；成功路径见返回值（打点/测试断言用）。 */
export async function storagePutJsonVerified(
    key: string,
    value: unknown,
): Promise<{ via: "put" | "retry" | "fallback" }> {
    const payload = JSON.stringify(value);
    const bytes = payload.length;
    const fp = rtFp(value);
    let putErr: unknown = null;
    try {
        await storagePutJson(key, value);
    } catch (e) {
        putErr = e;
    }
    let rb = await readbackState(key, payload);
    if (rb.file) {
        kernelLog("calauth", `save ${key}: ok via put (bytes=${bytes}${fp}, ${rb.note})`);
        return { via: "put" };
    }
    // 中间态逐段留痕：哪一通道在哪一步分叉（file=drift,storage=match=缓存投影假绿指纹）
    kernelLog("calauth", `save ${key}: put readback MISS (${rb.note}) — retry`);
    // 同通道重试一次：瞬时窗口失败的自愈位（首次失败原因带上，无论 reject 还是 resolve-零写盘）
    try {
        await storagePutJson(key, value);
    } catch { /* 重试也败→兜底 */ }
    rb = await readbackState(key, payload);
    if (rb.file) {
        kernelLog("calauth", `save ${key}: ok via retry (first=${putErr ? "reject" : "resolve-no-write"}, bytes=${bytes}${fp}, ${rb.note})`);
        return { via: "retry" };
    }
    kernelLog("calauth", `save ${key}: retry readback MISS (${rb.note}) — putFile fallback`);
    // HTTP putFile 独立通道：绕开 siyuan.storage 整条实现
    const fallbackOk = await putFileText(`${PETAL_DIR}/${key}`, payload).catch((): boolean => false);
    rb = await readbackState(key, payload);
    if (fallbackOk && rb.file) {
        kernelLog("calauth", `save ${key}: ok via putFile fallback (first=${putErr ? "reject" : "resolve-no-write"}, bytes=${bytes}${fp}, ${rb.note})`);
        return { via: "fallback" };
    }
    kernelLog("calauth", `save ${key}: FAILED all channels (putFileOk=${fallbackOk}, ${rb.note})`);
    throw new Error(`写盘验真失败 ${key}：storage.put 两轮+putFile 兜底后文件层读回仍失配——数据未落盘，请重试；复发查 Loki {job="sy-workbench-plugin"}`);
}
