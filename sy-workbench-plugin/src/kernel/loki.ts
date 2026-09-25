// kernel 侧 Loki 打点（calauth □1）：落盘验真/换证/refresh 成败的时间线证据——
// 09-14 主实例「rpc 回 ok 但文件零变化」无任何留痕可查，本模块补观测面。
// 通道=proxyRequest→/api/network/proxy→127.0.0.1:3100（client.fetch 只能打内核自身端口；
// SSRF dialer 对私网默认放行仅告警——SafeMode 实例推不出去，静默容忍）。
// 纪律：①fire-and-forget 永不 await——Loki 挂/慢不得拖同步链（proxy 默认 7s 超时）；
// ②模块内串行队列防同 stream 乱序互拒（Loki 对倒序时间戳回 400 丢行）；
// ③body 传**对象**给 proxyRequest——它内部 stringify，预 stringify=双重编码 400（6810 实锤）；
// ④每链恒做原生 getConf 取 port label（不设缓存快路径）——每跳都被 RunOnLoop 唤醒，
//   不依赖「空转循环排纯 JS 微任务」这一未证行为；
// ⑤内容红线：绝不推 token/secret 本体，只推结论、错误码与长度级指标。
// 时间戳纳秒（毫秒×1e6）+同流单调递增计数；port=getConf system.port（HideConfSecret
// 不掩 Port；6806 主实例/68xx 隔离实例分流=RC-B 双实例排障判别键）。
import { proxyRequest } from "./api";

const LOKI_PUSH_URL = "http://127.0.0.1:3100/loki/api/v1/push";

let portCache: string | null = null;
let lastNs = 0;
let queue: Promise<void> = Promise.resolve();
/** 进程级分流 nonce：主实例 getConf 掩 system.port（6810 新内核不掩——两代掩码不一），
 *  port=unknown 时多实例会混流；boot id 区分并发进程（重启换 id=时间线天然分段） */
const BOOT_ID = Math.random().toString(36).slice(2, 8);

/** 同流时间戳单调递增（同毫秒连发防乱序互拒） */
function nextMonotonicNs(): string {
    const nowMs = Date.now();
    const ns = nowMs * 1e6 <= lastNs ? lastNs + 1 : nowMs * 1e6;
    lastNs = ns;
    return String(ns);
}

/** 每链恒做原生 fetch（localhost 一发开销）——失败回退上次值/unknown */
async function resolvePort(): Promise<string> {
    try {
        const resp = await siyuan.client.fetch("/api/system/getConf", { method: "POST", body: "{}" });
        const json = JSON.parse(await resp.text()) as any;
        portCache = String(json?.data?.conf?.system?.port || "") || portCache || "unknown";
    } catch {
        if (!portCache) portCache = "unknown";
    }
    return portCache;
}

/** 打点入口：永不抛、永不阻塞调用方（入队即返）。 */
export function kernelLog(tag: string, msg: string): void {
    const line = `[${tag}] ${msg}`;
    const ts = nextMonotonicNs();
    queue = queue
        .then(async () => {
            const port = await resolvePort();
            await proxyRequest(LOKI_PUSH_URL, "POST", {
                streams: [{
                    stream: { job: "sy-workbench-plugin", side: "kernel", port, boot: BOOT_ID },
                    values: [[ts, line]],
                }],
            }, { "Content-Type": ["application/json"] });
        })
        .catch(() => { /* 静默：打点失败不影响主流程 */ });
}
