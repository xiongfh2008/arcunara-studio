// RC10 — discover static web output for "arcunara publish".
// Deliberately supports built static assets, not SSR/server runtimes.
// Never uploads a repository root or .next / node_modules by accident.
import fs from "node:fs/promises";
import path from "node:path";

const OUTPUT_DIRS = ["dist", "build", "out"];

async function isSafeStaticDir(candidate) {
  try {
    const st = await fs.lstat(candidate);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    const index = await fs.lstat(path.join(candidate, "index.html"));
    return index.isFile() && !index.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function detectStaticOutput(cwd, explicitDir) {
  if (explicitDir) {
    const candidate = path.resolve(cwd, explicitDir);
    if (!await isSafeStaticDir(candidate)) {
      throw new Error(`输出目录没有常规 index.html 或包含不安全的符号链接：${candidate}`);
    }
    return candidate;
  }

  const candidates = [];
  for (const name of OUTPUT_DIRS) {
    const full = path.join(cwd, name);
    if (await isSafeStaticDir(full)) candidates.push(full);
  }
  if (candidates.length === 0) {
    throw new Error(
      "没有找到可发布的静态构建目录（dist/build/out 及 index.html）。" +
      "不支持直接部署 Next.js SSR/Node/Python 后端；可用 --dir 指定已构建静态目录。"
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      "检测到多个静态输出目录，请用 --dir 指定：" +
      candidates.map(x => path.basename(x)).join("、")
    );
  }
  return candidates[0];
}

export async function localBuildCommand(cwd, preferred) {
  if (preferred) return preferred;
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
  } catch {
    return null;
  }
  return typeof pkg?.scripts?.build === "string"
    ? "npm run build"
    : null;
}
