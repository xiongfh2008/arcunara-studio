// UI regression: catch accidental lost bindings or inline JavaScript syntax errors.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html = readFileSync(new URL("../apps/api/console.html", import.meta.url), "utf8");

test("workspace provides project sidebar, creation dialog and four distinct panels", () => {
  assert.match(html, /id="openCreateDialog"/);
  assert.match(html, /id="newProjectDialog"/);
  assert.match(html, /id="projectCount"/);
  assert.match(html, /id="projectHeading"/);
  assert.match(html, /class="summary-grid"/);
  for (const name of ["overview", "versions", "shares", "deploy"]) {
    assert.match(html, new RegExp('data-tab="' + name + '"'));
    assert.match(html, new RegExp('data-panel="' + name + '"'));
  }
  assert.match(html, /showModal\(\)/);
  assert.match(html, /aria-selected/);
});

test("workspace keeps all existing RC2-RC6 control IDs exactly once", () => {
  const ids = [
    "tokenInput", "saveToken", "authBadge", "projectList", "projectSearch",
    "refreshBtn", "newName", "newDesc", "newFile", "newHtml", "createBtn",
    "detailCard", "detailMeta", "previewLink", "copyLink", "editName", "editDesc",
    "saveInfoBtn", "togglePreviewBtn", "versionFile", "uploadVersionBtn",
    "versionRows", "rollbackBtn", "createShareBtn", "shareExpiry", "shareRows",
    "newShareLink", "newShareBox", "copyNewShare", "shareStats",
    "createDeployKeyBtn", "deployKeyExpiry", "deployKeyRows",
    "newDeployKeyToken", "newDeployKeyBox", "copyNewDeployKey", "cliHint"
  ];
  for (const id of ids) {
    const matches = html.match(new RegExp('\\bid="' + id + '"', "g")) ?? [];
    assert.equal(matches.length, 1, "exactly one #" + id);
  }
});

test("all in-page scripts compile as JavaScript", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 2, "platform wiring and controller scripts exist");
  for (let i = 0; i < scripts.length; i++) {
    assert.doesNotThrow(() => new Script(scripts[i][1], { filename: "console-script-" + i }), "inline script " + i);
  }
});
