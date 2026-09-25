import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// 纯函数单测（node 环境，零 siyuan 运行时依赖）；kernel tools 的编排测试 mock api 模块。
// dataview □4 起挂 svelte 插件：BoardView 等组件 DOM 断言测试（.svelte 编译进 vitest 链——
// 组件测试文件头 @vitest-environment happy-dom 单文件切换，其余 node 测试不受影响）。
export default defineConfig({
    plugins: [svelte()],
    resolve: {
        // 组件测试配方（svelte 官方 vitest 指南）：browser 条件让 `import "svelte"` 解析到
        // client 入口（缺它=SSR 入口 mount 报 lifecycle_function_unavailable）；纯函数测试
        // 不 import svelte 包不受影响。
        conditions: ["browser"],
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            // siyuan 官方包 exports 字段限定 node 条件无入口，测试链走本地 stub（行为由 vi.mock 整替）
            siyuan: fileURLToPath(new URL("./tests/__stubs__/siyuan.ts", import.meta.url)),
        },
    },
    test: {
        globals: true,
        reporters: ["verbose"],
        include: ["tests/unit/**/*.test.ts"],
        environment: "node",
    },
});
