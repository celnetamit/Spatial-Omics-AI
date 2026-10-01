import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from './package.json' with { type: 'json' };

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';

  return {
    server: {
      port: 5173,
      host: '0.0.0.0',
      // `npm run dev` serves the client only. Every scientific computation runs
      // on the Node server — the client never holds an engine — so the dev
      // server forwards the API rather than duplicating any of it.
      proxy: {
        '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
        '/healthz': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      },
    },

    plugins: [react(), tailwindcss()],

    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },

    resolve: {
      /*
       * `@engine` before `@`: aliases are matched by prefix in declaration
       * order, and the bare `@` would swallow `@engine/...` and resolve it one
       * directory short of `engine/src`.
       *
       * The alias exists for the server tests, which import server modules that
       * reach into the engine. Client code does not use it — an `export *`
       * barrel import from the engine put the whole thing in the entry bundle
       * once, and the import is the problem, not the alias.
       */
      alias: {
        '@engine': path.resolve(__dirname, 'engine/src'),
        '@': path.resolve(__dirname, '.'),
      },
      dedupe: ['react', 'react-dom'],
    },

    build: {
      outDir: 'dist/public',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: isProduction ? 'hidden' : true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 900,
      /*
       * No `manualChunks`. Naming a vendor chunk promotes it into the entry's
       * static import graph, so Vite emits a <link rel="modulepreload"> for it
       * and the `import()` that was keeping a heavy panel off the critical path
       * stops doing anything. Check with:
       *   npm run build && grep modulepreload dist/public/index.html
       */
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },

    esbuild: {
      pure: isProduction ? ['console.log', 'console.debug'] : [],
      legalComments: 'none',
    },

    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts', 'engine/tests/**/*.test.ts', 'server/tests/**/*.test.ts'],
      globals: false,
    },
  };
});
