import { defineConfig } from "vite";

// One origin in every environment: the dev server proxies /api to the Lumen
// agents API exactly the way nginx does in the compose file, so CORS never
// exists as a problem to solve.
export default defineConfig({
  // The dep optimizer cannot statically resolve lumenui's dynamic locale
  // import, so the package is excluded — it is ESM and needs no pre-bundling.
  // Its socket.io-client dependency chain is CommonJS, though, and skipping
  // the optimizer skips the CJS conversion too, so that chain is re-included
  // explicitly.
  //
  // The canvas bundle brings another one: highlight.js, which it uses to draw
  // code inside a node. It is CommonJS, so without this the browser asks for a
  // `default` export the served module does not have — and because that throws
  // while the module graph is loading, nothing renders at all. The console
  // went blank, not just the canvas.
  optimizeDeps: {
    exclude: ["@nuraly/lumenui"],
    include: [
      "socket.io-client", "lit", "dayjs",
      "highlight.js/lib/core",
      "highlight.js/lib/languages/css",
      "highlight.js/lib/languages/javascript",
      "highlight.js/lib/languages/json",
      "highlight.js/lib/languages/markdown",
      "highlight.js/lib/languages/python",
      "highlight.js/lib/languages/sql",
      "highlight.js/lib/languages/typescript",
      "highlight.js/lib/languages/xml",
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.AGENTS_API ?? "http://127.0.0.1:8100",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // The UI library is an order of magnitude bigger than the app and
        // changes on its own schedule; its own chunk keeps the app chunk
        // cache-friendly. By path, so a newly imported component cannot
        // silently land in the app chunk.
        manualChunks(id: string) {
          if (id.includes("node_modules")) return "lumenui";
        },
      },
    },
  },
});
