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
    // The preview host is a second name for this same server, and Vite refuses
    // a Host it does not recognise. Previews are only ever served from a host
    // the operator names, so the same name has to be allowed in here for dev.
    allowedHosts: process.env.AGENTS_PREVIEW_HOST
      ? [process.env.AGENTS_PREVIEW_HOST.split(":")[0]]
      : [],
    proxy: {
      // Previews are served by the API at its own root, not under /api: the
      // URL a page's relative links resolve against has to be the artifact's
      // own path, so it cannot carry a prefix belonging to the console.
      "/preview": {
        target: process.env.AGENTS_API ?? "http://127.0.0.1:8100",
        changeOrigin: false,
      },
      "/api": {
        target: process.env.AGENTS_API ?? "http://127.0.0.1:8100",
        // Keep the browser's Host. `changeOrigin: true` rewrites it to the
        // target, which is the same hole nginx had: the preview route decides
        // its content type from that header, and a rewritten one is a decision
        // made about a host nobody asked for.
        changeOrigin: false,
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
