import { resolve } from "path";
import { defineConfig } from "vite";
import minimist from "minimist";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// 前端产物（index.js，CJS）：四插件同款 Vite lib 模板。内核产物（kernel.js）走
// vite.kernel.config.ts 单独一条线，两者同目录共存、双向 emptyOutDir:false 防清空。
const args = minimist(process.argv.slice(2));
const isWatch = args.watch || args.w || false;
const devDistDir = process.env.SYPLUGINDIR ? process.env.SYPLUGINDIR + "/sy-workbench-plugin" : "build";
const distDir = devDistDir;

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },

  plugins: [
    svelte(),
    viteStaticCopy({
      targets: [
        { src: "./README*.md", dest: "./" },
        { src: "./icon.png", dest: "./" },
        { src: "./preview.png", dest: "./" },
        { src: "./group-qr.png", dest: "./" },
        { src: "./plugin.json", dest: "./" },
        { src: "./src/i18n/**", dest: "./i18n/" },
        { src: "./skills/**", dest: "./skills/" },
        { src: "./jxa/**", dest: "./jxa/" }, // sloop □7：macOS 日历 JXA 通道脚本（osascript -l JavaScript 执行）
      ],
    }),
  ],

  define: {
    "process.env.DEV_MODE": `"${isWatch}"`,
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
  },

  build: {
    outDir: distDir,
    emptyOutDir: false,
    sourcemap: false,
    minify: isWatch ? false : "esbuild",

    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      fileName: "index",
      formats: ["cjs"],
    },

    rollupOptions: {
      external: ["siyuan", "process", "fs", "fs/promises", "os", "path", "util", "child_process"],

      output: {
        entryFileNames: "[name].js",
        // 思源约定=自动加载插件目录的 index.css（tomato 同款改名；Svelte/全局样式汇成 style.css）
        assetFileNames: (assetInfo: any) => {
          if (assetInfo.names?.[0] === "style.css" || assetInfo.name === "style.css") {
            return "index.css";
          }
          return "[name][extname]";
        },
      },
    },
  },
});
