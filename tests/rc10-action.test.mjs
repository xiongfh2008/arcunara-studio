import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

test("reusable composite action uses only scoped credentials and prebuilt static output", async () => {
  const file = await fs.readFile(new URL("../action.yml", import.meta.url),"utf8");
  assert.match(file, /using: composite/);
  assert.match(file, /ARCU_DEPLOY_KEY:/);
  assert.match(file, /--skip-build/);
  assert.match(file, /--dir "\$ARCU_OUTPUT_DIR"/);
  assert.match(file, /--project "\$ARCU_PROJECT_ID"/);
  assert.match(file, /\$GITHUB_ACTION_PATH\/packages\/cli\/arcunara\.mjs/);
  assert.doesNotMatch(file, /echo.*ARCU_DEPLOY_KEY|--token|ARCU_API_TOKEN/);
});
