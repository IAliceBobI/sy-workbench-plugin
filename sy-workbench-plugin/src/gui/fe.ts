// 前端副作用通道（零纯逻辑）：SQL fetch + DOM 转义。驾驶舱/切换器共用。
// /api/query 与 kernel 同端点同鉴权；GUI 不绕 kernel MCP 面（P3 拍板：手眼直连数据）。

export async function feQuery<T>(stmt: string): Promise<T[]> {
    const token = (window as any).siyuan?.config?.api?.token ?? "";
    const r = await fetch("/api/query/sql", {
        method: "POST",
        headers: { Authorization: `Token ${token}` },
        body: JSON.stringify({ stmt }),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(d.msg ?? `query failed: ${r.status}`);
    return (d.data ?? []) as T[];
}

/** Menu.addItem 的 label 走 innerHTML——用户文本（项目/线名）必须转义（AGENTS.md Menu 坑） */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** 前端直调内核 HTTP 写通道（鉴权同 feQuery；code!=0 throw msg）。
 *  造文档/钉序/改名等文件树操作走此通道——P3 拍板「手眼直连数据」同款边界。 */
export async function feCall<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
    const token = (window as any).siyuan?.config?.api?.token ?? "";
    const r = await fetch(path, {
        method: "POST",
        headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(d.msg ?? `${path} failed: ${r.status}`);
    return d.data as T;
}
