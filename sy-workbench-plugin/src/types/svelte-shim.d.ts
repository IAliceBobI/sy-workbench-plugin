// tsc 不编译 .svelte（编译归 vite-plugin-svelte；check-pj 用裸 tsc）——ambient 声明放行 import。
// 组件内部类型检查由 svelte-check 层负责（后续接入时此文件可退役）。
declare module "*.svelte" {
    const component: any;
    export default component;
}
