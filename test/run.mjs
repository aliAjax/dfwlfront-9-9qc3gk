// 纯 Node 业务测试：用 vite 自带的 esbuild 打包测试文件后执行（无需额外依赖）
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(dir, ".spec-build.cjs");

await build({
  entryPoints: [path.join(dir, "store.spec.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "warning"
});

const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);
