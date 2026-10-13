// tsc 不编译 .svelte（编译归 vite-plugin-svelte；check-pj 用裸 tsc）——ambient 声明放行 import。
// svelte-check 已接入（make.sh check-pj），但裸 tsc 步骤仍需本文件，不退役。
declare module "*.svelte" {
    const component: any;
    export default component;
}
// CSS 副作用 import 放行（svelte-check 首接 pj 暴露：本仓 include 无 *.svelte 通配，
// css import 走裸 TS 解析——seller plg.d.ts 同款声明；含 node_modules 子路径如
// @xyflow/svelte/dist/style.css，通配单 * 全匹配）
declare module "*.css";
