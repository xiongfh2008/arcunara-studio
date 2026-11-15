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
  assert.match(html, /class="project-inspector hidden"/);
  assert.match(html, /id="manageDialog"/);
  assert.match(html, /id="recentVersionList"/);
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

test("focuses the sidebar on projects and places features in selected project cards", () => {
  assert.match(html, /class="app-layout"/);
  assert.match(html, /class="app-sidebar"/);
  assert.match(html, /class="project-table-head"/);
  assert.match(html, /class="content-grid"/);
  assert.match(html, /--bg:#f6f8fc/);
  assert.equal((html.match(/class="side-nav side-nav-current"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-module="(shares|deploy|stats|settings)"/);
  assert.match(html, /id="activeShareCount"/);
  assert.match(html, /id="shareVisitCount"/);
  assert.match(html, /id="deployStatus"/);
  assert.match(html, /id="latestDeployTime"/);
  assert.match(html, /id="recentVersionList"/);
  assert.match(html, /id="previewQuickToggle"/);
  assert.match(html, /id="versionUploadDialog"/);
  assert.match(html, /id="openUploadDialog"/);
  assert.match(html, /id="openUploadDialogDetail"/);
  assert.match(html, /id="goShareDetail"/);
  assert.match(html, /function openManagePanel\(tab\)/);
  assert.match(html, /function openVersionDialog\(\)/);
  assert.match(html, /function renderRecentVersions\(\)/);
  assert.doesNotMatch(html, /产品设计工作区|搜索项目、版本或分享|200 MB/);
});

test("the version upload dialog has working file and paste modes", () => {
  assert.match(html, /id="versionDropzone"/);
  assert.match(html, /id="versionFilePanel"/);
  assert.match(html, /id="versionHtmlPanel"/);
  assert.match(html, /id="versionHtml"/);
  assert.match(html, /data-upload-mode="file"/);
  assert.match(html, /data-upload-mode="html"/);
  assert.match(html, /function setVersionUploadMode\(mode\)/);
  assert.match(html, /new DataTransfer\(\)/);
  assert.match(html, /body: JSON\.stringify\(\{ html \}\)/);
  assert.match(html, /method: "POST", body: fd/);
});

test("project creation accepts established manual or localhost cookie session", () => {
  assert.match(html, /let isAuthorized = false;/);
  assert.match(html, /isAuthorized = Boolean\(ok\);/);
  assert.match(html, /if \(!isAuthorized\) \{ feedback\("请先完成连接", false\); return; \}/);
  assert.doesNotMatch(html, /if \(!token\) \{ feedback\("请先连接 Token"/);
  assert.match(html, /window\.__ARCU_LOCAL_AUTO_LOGIN__/);
});

test("upload dialogs use server-advertised ZIP quotas instead of stale hardcoded limits", () => {
  assert.match(html, /id="archiveQuotaHint"/);
  assert.match(html, /id="newUploadLimitLabel"/);
  assert.match(html, /id="versionUploadQuotaHint"/);
  assert.match(html, /function renderUploadQuotas\(\)/);
  assert.match(html, /q\.maxFiles/);
  assert.match(html, /q\.maxExtractBytes/);
  assert.match(html, /renderUploadQuotas\(\);/);
});
