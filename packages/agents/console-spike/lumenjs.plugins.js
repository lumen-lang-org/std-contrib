// Vite-level config the console needs and LumenJS does not supply.
// Dev-only by construction (Vite plugins do not run under `lumenjs serve`),
// which is correct here: every entry is about the dep optimizer or the dev
// file server, and neither exists in a built image.
export default [
  {
    name: 'console-spike-vite-config',
    config() {
      return {
        resolve: {
          // `src` is a symlink to the shipping app's src/. Without this, Vite
          // resolves it to its real path and every bare import inside those
          // files is looked up from app/node_modules — a second copy of lit
          // beside the spike's own, which is how "multiple versions of Lit
          // loaded" and mismatched ReactiveElement classes start. Preserving
          // the symlink keeps one node_modules in play.
          preserveSymlinks: true,
        },
        server: {
          fs: {
            // The symlink target, for the case where something resolves
            // through the real path anyway.
            allow: ['/home/ubuntu/projects/std-contrib/packages/agents/app'],
          },
        },
        // Ported verbatim in intent from app/vite.config.ts. The dep
        // optimizer cannot statically resolve lumenui's dynamic locale
        // import, so the package is excluded — it is ESM and needs no
        // pre-bundling. Its socket.io-client dependency chain is CommonJS,
        // though, and skipping the optimizer skips the CJS conversion too,
        // so that chain is re-included explicitly.
        //
        // The canvas bundle brings another one: highlight.js. It is
        // CommonJS, so without this the browser asks for a `default` export
        // the served module does not have — and because that throws while
        // the module graph is loading, nothing renders at all.
        optimizeDeps: {
          exclude: ['@nuraly/lumenui'],
          include: [
            // `lit` is in vite.config.ts's list and must NOT be here.
            // LumenJS's litDedupPlugin marks lit external so exactly one copy
            // reaches the page; asking the optimizer to pre-bundle an
            // externalized entry is a hard esbuild error ("the entry point
            // \"lit\" cannot be marked as external") and the dev server dies
            // at boot rather than degrading.
            'socket.io-client', 'dayjs',
            'highlight.js/lib/core',
            'highlight.js/lib/languages/css',
            'highlight.js/lib/languages/javascript',
            'highlight.js/lib/languages/json',
            'highlight.js/lib/languages/markdown',
            'highlight.js/lib/languages/python',
            'highlight.js/lib/languages/sql',
            'highlight.js/lib/languages/typescript',
            'highlight.js/lib/languages/xml',
          ],
        },
      };
    },
  },
];
