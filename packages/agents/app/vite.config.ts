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
  optimizeDeps: {
    exclude: ["@nuraly/lumenui"],
    include: ["socket.io-client", "lit", "dayjs"],
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
