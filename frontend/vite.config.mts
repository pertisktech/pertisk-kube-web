import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  define: {
    // Make the version available at build time
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(
      process.env.VITE_APP_VERSION || process.env.VERSION || '0.1.0'
    ),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3001,
    proxy: {
      "/api": {
        target: process.env.VITE_BACKEND_URL || "http://localhost:8091",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    // Remove console/debugger statements from production bundle output.
    minify: "esbuild",
    esbuild: {
      drop: ["console", "debugger"],
    },
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-recharts": ["recharts"],
          "vendor-chartjs": ["chart.js", "react-chartjs-2"],
          "vendor-editor": ["ace-builds", "react-ace"],
          "vendor-terminal": ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-web-links"],
          "vendor-yaml": ["yaml"],
        },
      },
    },
  },
});

