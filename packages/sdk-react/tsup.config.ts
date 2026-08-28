import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react"],
  // esbuild (which tsup uses) drops the `"use client"` directive from
  // context.tsx during bundling — it isn't preserved as a top-level
  // banner automatically. Re-adding it here as a build-wide banner is
  // safe: every export from this package (Provider, hooks, the exposure
  // helper) is meant to run client-side anyway, and without it Next.js
  // would refuse to treat `RollfuseProvider` as a client boundary when a
  // Server Component imports it.
  banner: { js: '"use client";' },
});
