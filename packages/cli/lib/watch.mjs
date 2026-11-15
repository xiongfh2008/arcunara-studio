// `arcunara watch` — monitor a prototype directory and auto-publish a new
// version whenever the content stabilizes.
//
// Behavior:
// - Only the given directory is watched (fs.watch recursive). No system
//   scanning beyond the specified path.
// - Debounce: bursts of writes collapse into one publish attempt.
// - Stability check: the content hash is sampled twice; if it changed
//   between samples, writers are still active — wait again. This keeps
//   half-written files from being published.
// - Single flight: at most one upload runs at a time; triggers arriving
//   mid-upload coalesce into one follow-up run.
// - Idempotent: identical content is skipped (server-side content-hash
//   dedupe also protects against races).
// - Bounded retries with exponential backoff; the current version is never
//   rolled back on failure. SIGINT exits cleanly.

import fsSync from "node:fs";
import path from "node:path";
import { collectDirectory } from "./collect.mjs";
import { publishOnce, withRetry, fmtSize } from "./deploy.mjs";

function log(message) {
  process.stderr.write(`${message}\n`);
}

const DEFAULTS = {
  debounceMs: 800,
  settleMs: 500,
  attempts: 3
};

export async function watchDir({
  sourcePath,
  apiBase,
  projectId,
  token,
  debounceMs = DEFAULTS.debounceMs,
  settleMs = DEFAULTS.settleMs,
  attempts = DEFAULTS.attempts
}) {
  const resolved = path.resolve(sourcePath);

  if (!fsSync.statSync(resolved).isDirectory()) {
    throw new Error(`watch 仅支持目录：${resolved}`);
  }

  let lastPublishedHash = null;
  let running = false;
  let pendingAgain = false;
  let debounceTimer = null;
  let stopped = false;
  let onResult = null;

  function schedule() {
    if (stopped) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      run().catch(() => {});
    }, debounceMs);
  }

  async function currentHash() {
    const collected = await collectDirectory(resolved, null);
    return { hash: collected.contentHash, stats: collected };
  }

  async function run() {
    if (stopped) return;

    if (running) {
      pendingAgain = true;
      return;
    }

    running = true;

    try {
      // Stability loop: wait until the content hash is unchanged across a
      // settle interval (writers finished), bounded to avoid spinning on a
      // pathological writer.
      let sample = await currentHash();

      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, settleMs));

        if (stopped) return;

        const next = await currentHash();

        if (next.hash === sample.hash) {
          sample = next;
          break;
        }

        sample = next;
      }

      if (stopped) return;

      if (sample.hash === lastPublishedHash) {
        log("内容未变化，跳过发布。");
        return;
      }

      log(`检测到内容变化（${sample.fileCount} 个文件，${fmtSize(sample.totalSize)}），开始发布 ...`);

      const { view } = await withRetry(
        () =>
          publishOnce({
            apiBase,
            projectId,
            token,
            sourcePath: resolved
          }),
        {
          attempts,
          onRetry(err, attempt, delay) {
            log(`发布失败（第 ${attempt} 次）：${err.message}，${delay}ms 后重试。`);
          }
        }
      );

      lastPublishedHash = sample.hash;

      if (view.deduplicated) {
        log(`内容与当前版本 v${view.version} 相同，服务器已跳过重复发布。`);
      } else {
        log(`发布成功：版本 v${view.version}（当前版本 v${view.currentVersion}）。`);
      }

      if (onResult) {
        onResult(view);
      }
    } catch (err) {
      // Bounded retries exhausted: keep the previous version untouched and
      // wait for the next change instead of spinning forever.
      log(`发布失败（已重试 ${attempts} 次，保留当前版本）：${err.message}`);
    } finally {
      running = false;

      if (pendingAgain && !stopped) {
        pendingAgain = false;
        schedule();
      }
    }
  }

  const watcher = fsSync.watch(resolved, { recursive: true }, (_event, filename) => {
    // Ignore the CLI's own config file churn.
    if (filename && String(filename).endsWith(".arcunara.json")) {
      return;
    }

    schedule();
  });

  watcher.on("error", (err) => {
    log(`watch 错误：${err.message}`);
  });

  log(`正在监视 ${resolved}（debounce ${debounceMs}ms）。按 Ctrl+C 退出。`);

  return {
    close() {
      stopped = true;
      clearTimeout(debounceTimer);
      watcher.close();
    },
    set onResult(fn) {
      onResult = fn;
    }
  };
}
