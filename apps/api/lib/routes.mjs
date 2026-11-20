// API router.
//
// v0.2.0 routes (/health, project list, JSON project creation, auth gate)
// keep their validated behavior; everything else is additive v0.3.0.
// Every failure path returns a JSON error with a stable "code" field
// (see docs/development.md).

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ApiError, sendError, sendJson, readBody } from "./httputil.mjs";
import { parseMultipartUpload } from "./multipart.mjs";
import { stageFromUpload } from "./staging.mjs";
import { inspectAxureProject } from "./axure.mjs";
import { analyzeAxureReadiness } from "./axure-readiness.mjs";
import { buildEditableIR } from "../../../packages/rp-converter/ir.mjs";
import { convertIRToRP1 } from "../../../packages/rp-converter/rp1-bridge.mjs";
import { generateGithubWorkflow } from "./github-workflow.mjs";
import { compareProjectVersions } from "./version-diff.mjs";
import { exportProjectVersionZip } from "./zip-export.mjs";
import { readEditableHtml, publishEditedHtml } from "./html-editor.mjs";
import { listSourceFiles, readSourceFile, publishSourceChanges } from "./project-files.mjs";
import { createAiGenerator } from "./ai-generator.mjs";
import { parseDeployToken } from "./auth.mjs";
import { createLocalSession } from "./local-session.mjs";
import { createCloudflareAccessAuth } from "./cloudflare-access.mjs";
import { createTeamAccess, parseMemberToken, memberAction } from "./team-access.mjs";
import { createMemberPasswords } from "./member-passwords.mjs";

const PROJECT_ID = "([0-9a-f-]{36})";
const DETAIL_RE = new RegExp(`^/api/projects/${PROJECT_ID}$`);
const WORKFLOW_RE = new RegExp(`^/api/projects/${PROJECT_ID}/github-workflow$`);
const AXURE_READINESS_RE = new RegExp(`^/api/projects/${PROJECT_ID}/axure-readiness$`);
const AXURE_IR_RE = new RegExp(`^/api/projects/${PROJECT_ID}/axure-ir$`);
const AXURE_RP1_RE = new RegExp(`^/api/projects/${PROJECT_ID}/axure-rp1$`);
const VERSIONS_RE = new RegExp(`^/api/projects/${PROJECT_ID}/versions$`);
const HTML_EDITOR_RE = new RegExp(`^/api/projects/${PROJECT_ID}/html-editor$`);
const SOURCE_FILES_RE = new RegExp(`^/api/projects/${PROJECT_ID}/source/files$`);
const SOURCE_FILE_RE = new RegExp(`^/api/projects/${PROJECT_ID}/source/file$`);
const SOURCE_PUBLISH_RE = new RegExp(`^/api/projects/${PROJECT_ID}/source/publish$`);
const HTML_EDITOR_PUBLISH_RE = new RegExp(`^/api/projects/${PROJECT_ID}/html-editor/publish$`);
const VERSION_COMPARE_RE = new RegExp(`^/api/projects/${PROJECT_ID}/compare-versions$`);
const VERSION_EXPORT_RE = new RegExp(`^/api/projects/${PROJECT_ID}/export$`);
const VERSION_NOTE_RE = new RegExp(`^/api/projects/${PROJECT_ID}/versions/([0-9]+)$`);
const ROLLBACK_RE = new RegExp(`^/api/projects/${PROJECT_ID}/rollback$`);
const SHARES_RE = new RegExp(`^/api/projects/${PROJECT_ID}/shares$`);
const PREVIEW_TICKET_RE = new RegExp(`^/api/projects/${PROJECT_ID}/preview-ticket$`);
const SHARE_ACTION_RE = new RegExp(
  `^/api/projects/${PROJECT_ID}/shares/([0-9a-f]{16})/(revoke|enable|disable)$`
);
const USERS_RE = /^\/api\/users$/;
const USER_RE = /^\/api\/users\/([0-9a-f]{16})$/;
const USER_ROTATE_RE = /^\/api\/users\/([0-9a-f]{16})\/rotate-token$/;
const USER_INVITE_RE = /^\/api\/users\/([0-9a-f]{16})\/invite$/;
const MEMBERS_RE = new RegExp(`^/api/projects/${PROJECT_ID}/members$`);
const MEMBER_RE = new RegExp(`^/api/projects/${PROJECT_ID}/members/([0-9a-f]{16})$`);
const DEPLOY_KEYS_RE = new RegExp(`^/api/projects/${PROJECT_ID}/deploy-keys$`);
const DEPLOY_KEY_ACTION_RE = new RegExp(
  `^/api/projects/${PROJECT_ID}/deploy-keys/([0-9a-f]{16})/(revoke|enable|disable)$`
);

// The legacy JSON html cap — intentionally kept byte-identical with v0.2.0.
const LEGACY_HTML_BYTES = 180000;

// RC6: deploy keys are restricted to a fixed, exact-match allowlist scoped
// to the key's own project. Anything else — including every admin-only
// route (project creation, PATCH, rollback, share management, deploy-key
// management, other projects' endpoints) — is denied. Exact equality (not
// prefix matching) prevents path-shape bypasses such as
// /api/projects/{otherId}/versions or suffixed paths.
function deployKeyAllowed(method, pathname, projectId) {
  const versionsPath = `/api/projects/${projectId}/versions`;
  const detailPath = `/api/projects/${projectId}`;

  return (
    (method === "GET" && pathname === "/api/limits") ||
    (method === "POST" && pathname === versionsPath) ||
    (method === "GET" &&
      (pathname === versionsPath || pathname === detailPath))
  );
}

export function createApiHandler({ config, store, auth, previewTickets, version, getPreviewPort }) {
  // Only an explicitly enabled loopback development instance may issue a
  // short-lived browser cookie. The admin bearer token is never exposed.
  const localSession = createLocalSession(config);
  const cloudflareAccess = createCloudflareAccessAuth(config);
  const team = createTeamAccess(config, store);
  const passwords=createMemberPasswords(config,store);
  const ai=createAiGenerator(config);
  // The internal workbench is static, contains no credentials and remains
  // reachable without an API bearer token (as in previous versions).
  let consoleHtml = null;

  try {
    consoleHtml = readFileSync(
      new URL("../console.html", import.meta.url),
      "utf8"
    );
  } catch {
    consoleHtml = null;
  }

  function serveConsole(req, res) {
    if (!consoleHtml) {
      return sendJson(res, 404, { error: "Not Found" });
    }

    // Inject the browser-facing preview wiring: an absolute public base URL
    // when configured (Docker / dedicated preview origin), otherwise null —
    // the workbench then falls back to same-host + the ACTUAL bound preview
    // port (which may differ from the configured one under port 0 testing).
    const previewPort = getPreviewPort
      ? getPreviewPort()
      : config.previewPort;

    const html = consoleHtml
      .replace("__ARCU_PREVIEW_PORT__", String(previewPort))
      .replace("__ARCU_PREVIEW_BASE__", JSON.stringify(config.previewPublicBaseUrl))
      .replace("__ARCU_LOCAL_MODE_VALUE__", String(localSession.eligible(req)))
      .replace("__ARCU_ACCESS_MODE_VALUE__", String(cloudflareAccess.enabled))
      .replace("__ARCU_MEMBER_LOGIN_MODE_VALUE__", String(passwords.enabled))
      .replace("__ARCU_PUBLIC_PREVIEW_MODE_VALUE__", String(config.stagingPublicPreview === true))
      .replace("__ARCU_AXURE_NATIVE_ORIGIN_VALUE__", JSON.stringify(config.axureNativeOrigin || null))
      .replace("__ARCU_SITE_DOMAIN_VALUE__", JSON.stringify(config.siteHostingEnabled ? config.siteDomain : null));

    const localCookie = localSession.issueCookie(req);
    res.writeHead(200, {
      ...(localCookie ? { "Set-Cookie": localCookie } : {}),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; " +
        "script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; " +
        "frame-src 'self' blob:; " +
        "connect-src 'self'; " +
        "form-action 'none'; " +
        "frame-ancestors 'none'; " +
        "base-uri 'none'"
    });

    res.end(html);
  }

  return async function handle(req, res) {
    try {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;

      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          service: "arcunara-studio-dev",
          version
        });
      }

      if (
        req.method === "GET" &&
        (pathname === "/console" || pathname === "/console/")
      ) {
        return serveConsole(req, res);
      }

      // RC20B: invite-only member login. Anonymous requests are accepted only
      // on these explicit routes and only after exact Origin + CSRF validation.
      // No user signup, email dispatch or password recovery email is implied.
      if(pathname.startsWith("/api/auth/")) {
        if(!passwords.enabled)return sendJson(res,404,{error:"Not Found"});
        if(req.method==="POST" && pathname==="/api/auth/login") {
          passwords.checkRequest(req);
          if(req.headers.authorization)
            return sendJson(res,403,{error:"Forbidden",code:"MEMBER_CREDENTIAL_CONFLICT"});
          const credentials=await readJsonPayload(req,config.limits);
          const login=await passwords.login(credentials,req);
          if(!login.ok)return sendJson(res,401,{error:"Invalid credentials",code:"MEMBER_LOGIN_INVALID"});
          res.setHeader("Set-Cookie",login.cookie);
          return sendJson(res,200,{type:"member",user:login.user});
        }
        if(req.method==="POST" && pathname==="/api/auth/activate") {
          passwords.checkRequest(req);
          if(req.headers.authorization)
            return sendJson(res,403,{error:"Forbidden",code:"MEMBER_CREDENTIAL_CONFLICT"});
          const value=await readJsonPayload(req,config.limits);
          return sendJson(res,200,await passwords.activate(value,req));
        }
        const session=await passwords.authorizeSession(req);
        if(req.method==="GET" && pathname==="/api/auth/session") {
          if(!session)return sendJson(res,401,{error:"Unauthorized",code:"MEMBER_SESSION_INVALID"});
          return sendJson(res,200,{type:"member",user:session.user});
        }
        if(req.method==="POST" && pathname==="/api/auth/logout") {
          passwords.checkRequest(req);
          if(!session)return sendJson(res,401,{error:"Unauthorized",code:"MEMBER_SESSION_INVALID"});
          await passwords.logout(req);
          res.setHeader("Set-Cookie",passwords.clearCookie(req));
          return sendJson(res,200,{loggedOut:true});
        }
        if(req.method==="POST" && pathname==="/api/auth/change-password") {
          passwords.checkRequest(req);
          if(!session)return sendJson(res,401,{error:"Unauthorized",code:"MEMBER_SESSION_INVALID"});
          const value=await readJsonPayload(req,config.limits);
          const changed=await passwords.changePassword(
            session.user.id,value?.oldPassword,value?.newPassword);
          res.setHeader("Set-Cookie",passwords.clearCookie(req));
          return sendJson(res,200,changed);
        }
        return sendJson(res,404,{error:"Not Found"});
      }

      // RC6: deploy-key mode. The dpk_ prefix routes to the restricted
      // project-scoped guard; the admin token path below is unchanged and
      // never widened. A malformed or invalid deploy token is always 401.
      const deployToken = parseDeployToken(req.headers.authorization);

      if (deployToken) {
        if (!pathname.startsWith("/api/")) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }

        const verdict = await store.validateDeployKey(
          deployToken.keyId,
          deployToken.secret
        );

        if (!verdict || verdict.reason === "bad_token") {
          return sendJson(res, 401, {
            error: "Unauthorized",
            code: "DEPLOY_KEY_INVALID"
          });
        }

        if (verdict.reason) {
          return sendJson(res, 401, {
            error: `Deploy key ${verdict.reason}`,
            code: `DEPLOY_KEY_${verdict.reason.toUpperCase()}`
          });
        }

        if (!deployKeyAllowed(req.method, pathname, verdict.projectId)) {
          return sendJson(res, 403, {
            error: "Deploy key is not allowed to perform this operation",
            code: "DEPLOY_KEY_FORBIDDEN"
          });
        }

        req.deployKey = { projectId: verdict.projectId, keyId: verdict.key.id };
      } else if ((req.headers.authorization || "").startsWith("Bearer uat_")) {
        // A user token cannot fall through to an administrator browser cookie,
        // even if malformed, disabled, or revoked.
        const parsed = parseMemberToken(req.headers.authorization);
        const user = parsed && await team.authorize(parsed.id, parsed.secret);
        if (!user) {
          return sendJson(res, 401, {error:"Unauthorized",code:"TEAM_TOKEN_INVALID"});
        }
        req.teamMember = user;
      } else if (!req.headers.authorization &&
          (req.memberSession=await passwords.authorizeSession(req))) {
        // Member session is distinct from global administrator identity.
        req.teamMember=req.memberSession.user;
      } else if (
        !pathname.startsWith("/api/") ||
        (!auth(req) && !localSession.authorized(req) &&
          !(await cloudflareAccess.authorized(req)))
      ) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      if (req.teamMember) {
        const publicMemberPaths = pathname === "/api/limits" ||
          pathname === "/api/projects" || pathname === "/api/me";
        if (!(publicMemberPaths && req.method === "GET")) {
          const match = /^\/api\/projects\/([0-9a-f-]{36})(?:\/|$)/.exec(pathname);
          if (!match) {
            return sendJson(res,403,{error:"Forbidden",code:"TEAM_FORBIDDEN"});
          }
          const projectRole = await team.role(match[1],req.teamMember.id);
          if (!projectRole) {
            return sendJson(res,404,{error:"Not Found",code:"PROJECT_NOT_FOUND"});
          }
          // Hide missing or trashed projects, regardless of whether the
          // provided member token previously had access to them.
          const meta = await store.readRawMeta(match[1]);
          if (!meta || meta.lifecycleState === "trashed") {
            return sendJson(res,404,{error:"Not Found",code:"PROJECT_NOT_FOUND"});
          }
          if (!memberAction(req.method,pathname,projectRole)) {
            return sendJson(res,403,{error:"Forbidden",code:"TEAM_FORBIDDEN"});
          }
          req.teamRole = projectRole;
        }
      }

      if (req.method === "GET" && pathname === "/api/me") {
        if (req.deployKey) {
          return sendJson(res,403,{error:"Forbidden",code:"DEPLOY_KEY_FORBIDDEN"});
        }
        return sendJson(res,200,req.teamMember
          ? {type:"member",user:req.teamMember,
              memberships:await team.membershipsForUser(req.teamMember.id)}
          : {type:"admin",teamEnabled:team.enabled,memberLoginEnabled:passwords.enabled});
      }

      // Team registry management requires the existing global administrator
      // identity. Member roles never include user or membership administration.
      if (USERS_RE.test(pathname)) {
        if (!team.enabled) return sendJson(res,404,{error:"Not Found"});
        if (req.method === "GET") {
          return sendJson(res,200,{users:await team.listUsers()});
        }
        if (req.method === "POST") {
          const payload=await readJsonPayload(req,config.limits);
          return sendJson(res,201,await team.createUser(payload));
        }
      }
      const userMatch=USER_RE.exec(pathname);
      if (userMatch && req.method === "PATCH") {
        const payload=await readJsonPayload(req,config.limits);
        return sendJson(res,200,await team.editUser(userMatch[1],payload));
      }
      if(req.method==="GET" && pathname==="/api/audit/auth") {
        if(!passwords.enabled)return sendJson(res,404,{error:"Not Found"});
        return sendJson(res,200,{events:await passwords.logs()});
      }
      const inviteMatch=USER_INVITE_RE.exec(pathname);
      if(inviteMatch && req.method==="POST") {
        return sendJson(res,201,await passwords.issueInvite(inviteMatch[1]));
      }
      const rotateMatch=USER_ROTATE_RE.exec(pathname);
      if (rotateMatch && req.method === "POST") {
        return sendJson(res,200,await team.rotateToken(rotateMatch[1]));
      }
      const membersMatch=MEMBERS_RE.exec(pathname);
      if (membersMatch && req.method === "GET") {
        return sendJson(res,200,{
          projectId:membersMatch[1],
          members:await team.members(membersMatch[1])
        });
      }
      const memberMatch=MEMBER_RE.exec(pathname);
      if (memberMatch && req.method === "PUT") {
        const payload=await readJsonPayload(req,config.limits);
        return sendJson(res,200,await team.setMember(
          memberMatch[1],memberMatch[2],payload.role));
      }
      if (memberMatch && req.method === "DELETE") {
        return sendJson(res,200,await team.removeMember(memberMatch[1],memberMatch[2]));
      }

      // Opt-in paid model calls are restricted to the existing global
      // administrator identity; member tokens and deploy keys are excluded.
      if (req.method==="GET" && pathname==="/api/ai/status")
        return sendJson(res,200,ai.status());
      if (req.method==="POST" && pathname==="/api/ai/generate"){
        const payload=await readJsonPayload(req,config.limits);
        return sendJson(res,200,await ai.generate(payload));
      }

      if (req.method === "GET" && pathname === "/api/limits") {
        // Active upload quotas for the workbench's quota-aware error hints.
        // Values are configuration, not secrets; auth required to avoid
        // unfingerprinted probing.
        return sendJson(res, 200, { limits: config.limits });
      }

      if (req.method === "GET" && pathname === "/api/projects") {
        const projects = req.teamMember
          ? await team.projectsForUser(req.teamMember.id)
          : await store.listProjects();
        return sendJson(res, 200, { projects });
      }

      if (req.method === "POST" && pathname === "/api/projects") {
        return await handleCreateProject(req, res, { config, store });
      }

      // RC21B: multi-file source editor. Ordinary account and project RBAC
      // runs BEFORE this route; deploy keys have no access.
      const sourceList=SOURCE_FILES_RE.exec(pathname);
      if(sourceList && req.method==="GET")
        return sendJson(res,200,await listSourceFiles(store,sourceList[1]));
      const sourceFile=SOURCE_FILE_RE.exec(pathname);
      if(sourceFile && req.method==="GET"){
        const params=new URL(req.url||"/","http://localhost").searchParams;
        if(params.getAll("path").length!==1)
          throw new ApiError(400,"Exactly one source path required","EDITOR_PATH_INVALID");
        return sendJson(res,200,await readSourceFile(store,sourceFile[1],params.get("path")));
      }
      const sourcePublish=SOURCE_PUBLISH_RE.exec(pathname);
      if(sourcePublish && req.method==="POST"){
        const data=await readJsonPayload(req,config.limits);
        const result=await publishSourceChanges(store,sourcePublish[1],data);
        return sendJson(res,result.unchanged?200:201,result);
      }

      // RC21A — single-file HTML editor with current-version CAS.
      const editorMatch=HTML_EDITOR_RE.exec(pathname);
      if (editorMatch && req.method==="GET") {
        return sendJson(res,200,await readEditableHtml(store,editorMatch[1]));
      }
      const editorSave=HTML_EDITOR_PUBLISH_RE.exec(pathname);
      if (editorSave && req.method==="POST") {
        const payload=await readJsonPayload(req,config.limits);
        const result=await publishEditedHtml(store,editorSave[1],payload);
        return sendJson(res,result.unchanged?200:201,result);
      }

      const versionsMatch = VERSIONS_RE.exec(pathname);

      if (versionsMatch) {
        const id = versionsMatch[1];

        if (req.method === "POST") {
          try {
            return await handleVersionCreate(req, res, { config, store, id });
          } catch (err) {
            // Any failed deploy-key upload (validation, quota, staging...)
            // is recorded for the workbench display.
            await recordDeployUseIfKeyed(req, store, id, null, "failed");
            throw err;
          }
        }

        if (req.method === "GET") {
          const result = await store.listVersions(id);
          return sendJson(res, 200, result);
        }
      }

      const versionNoteMatch = VERSION_NOTE_RE.exec(pathname);
      if (versionNoteMatch && req.method === "PATCH") {
        const payload = await readJsonPayload(req, config.limits);
        const result = await store.updateVersionNote(
          versionNoteMatch[1], Number(versionNoteMatch[2]), payload.note
        );
        return sendJson(res, 200, result);
      }

      const diffMatch = VERSION_COMPARE_RE.exec(pathname);
      if (diffMatch && req.method === "GET") {
        const qs = new URL(req.url || "/", "http://localhost").searchParams;
        const from = qs.get("from");
        const to = qs.get("to");
        if (!from || !to || !/^[1-9][0-9]*$/.test(from) || !/^[1-9][0-9]*$/.test(to)) {
          throw new ApiError(400, "Invalid version parameters", "INVALID_VERSION");
        }
        return sendJson(res, 200, await compareProjectVersions(
          store,diffMatch[1],Number(from),Number(to)
        ));
      }

      // RC17: administrator-only, read-only download. Deploy keys have no
      // access because the allowlist intentionally excludes /export.
      const exportMatch = VERSION_EXPORT_RE.exec(pathname);
      if (exportMatch && req.method === "GET") {
        const qs = new URL(req.url || "/", "http://localhost").searchParams;
        const versions = qs.getAll("version");
        if (versions.length > 1 || (versions.length === 1 &&
            !/^[1-9][0-9]*$/.test(versions[0]))) {
          throw new ApiError(400, "Invalid version", "INVALID_VERSION");
        }
        const v = versions.length ? Number(versions[0]) : null;
        return await exportProjectVersionZip(store, exportMatch[1], v, res);
      }

      const rollbackMatch = ROLLBACK_RE.exec(pathname);

      if (rollbackMatch && req.method === "POST") {
        return await handleRollback(req, res, { config, store, id: rollbackMatch[1] });
      }

      // Read-only export readiness report; no untrusted uploaded code is executed.
      const readinessMatch = AXURE_READINESS_RE.exec(pathname);
      if (readinessMatch && req.method === "GET") {
        const query = new URL(req.url || "/", "http://localhost").searchParams;
        const rawVersion = query.get("version");
        if (rawVersion !== null && !/^[1-9][0-9]*$/.test(rawVersion)) {
          throw new ApiError(400, "Invalid version", "INVALID_VERSION");
        }
        const version = rawVersion === null ? undefined : Number(rawVersion);
        return sendJson(res, 200, await analyzeAxureReadiness(store, readinessMatch[1], version));
      }

      // RC18A: mapped editable-candidate JSON is NOT a native .rp file.
      // Existing admin auth applies; dpk_ deploy keys are excluded.
      const irMatch = AXURE_IR_RE.exec(pathname);
      if (irMatch && req.method === "GET") {
        const query = new URL(req.url || "/", "http://localhost").searchParams;
        const values = query.getAll("version");
        if (values.length > 1 || (values.length === 1 &&
            !/^[1-9][0-9]*$/.test(values[0]))) {
          throw new ApiError(400, "Invalid version", "INVALID_VERSION");
        }
        const requested = values.length ? Number(values[0]) : undefined;
        const report = await buildEditableIR(store, irMatch[1], requested);
        return sendJson(res, 200, report);
      }

      // RC18B: Zee-RP RP/1 JSON source only (target 9); not a native .rp.
      // Same administrative authentication and version policy as /axure-ir.
      const rp1Match = AXURE_RP1_RE.exec(pathname);
      if (rp1Match && req.method === "GET") {
        const qs = new URL(req.url || "/", "http://localhost").searchParams;
        const versions = qs.getAll("version");
        if (versions.length > 1 || (versions.length === 1 &&
            !/^[1-9][0-9]*$/.test(versions[0]))) {
          throw new ApiError(400, "Invalid version", "INVALID_VERSION");
        }
        const requested = versions.length ? Number(versions[0]) : undefined;
        const ir = await buildEditableIR(store, rp1Match[1], requested);
        const project = await store.getProject(rp1Match[1]);
        return sendJson(res, 200, convertIRToRP1(ir, { projectName: project.name }));
      }

      // GitHub integration is opt-in: provide a downloadable workflow only.
      // The server never connects to GitHub or reads/stores a repository key.
      const workflowMatch = WORKFLOW_RE.exec(pathname);
      if (workflowMatch && req.method === "GET") {
        const id = workflowMatch[1];
        const project = await store.getProject(id);
        if (project.lifecycleState === "trashed") {
          throw new ApiError(409, "Project is in trash", "PROJECT_TRASHED");
        }
        const qs = new URL(req.url || "/", "http://localhost").searchParams;
        return sendJson(res, 200, generateGithubWorkflow({
          projectId: id,
          outputDir: qs.get("outputDir") ?? "dist",
          buildMode: qs.get("buildMode") ?? "npm"
        }));
      }

      const detailMatch = DETAIL_RE.exec(pathname);

      if (detailMatch) {
        const id = detailMatch[1];

        if (req.method === "GET") {
          const view = await store.getProject(id);
          if (req.teamMember) view.role = req.teamRole;

          // Additive RC3 field: the workbench labels Axure projects with the
          // safe-preview entry (page directory) instead of the raw player.
          try {
            const meta = await store.readRawMeta(id);
            const entry = await store.currentVersionEntry(id, meta);
            view.isAxure = (
              await inspectAxureProject(store.versionSourceDir(id, entry))
            ).isAxure;
          } catch {
            view.isAxure = false;
          }

          view.siteUrl = config.siteHostingEnabled && view.siteEnabled
            ? `https://${id}.${config.siteDomain}/` : null;
          return sendJson(res, 200, view);
        }

        // RC16: admin-only irreversible removal, deliberately NOT allowed
        // for project-scoped deploy keys (see deployKeyAllowed).
        if (req.method === "DELETE") {
          const payload = await readJsonPayload(req, config.limits);
          return sendJson(res, 200, await store.permanentlyDeleteProject(
            id, payload.confirmProjectId
          ));
        }

        // RC5: edit project name/description/previewEnabled. Additive and
        // idempotent; the project id and all stored data are unchanged.
        if (req.method === "PATCH") {
          const payload = await readJsonPayload(req, config.limits);
          const patch = {};

          for (const key of ["name", "description", "previewEnabled", "lifecycleState", "siteEnabled"]) {
            if (payload[key] !== undefined) {
              patch[key] = payload[key];
            }
          }

          if (patch.siteEnabled === true && !config.siteHostingEnabled) {
            throw new ApiError(409, "Static website hosting is not enabled", "SITE_HOSTING_DISABLED");
          }
          const view = await store.updateProject(id, patch);
          return sendJson(res, 200, view);
        }
      }

      // Only an authenticated administrator can create a ten-minute
      // project-scoped browser capability. Deploy keys cannot access it.
      const ticketMatch = PREVIEW_TICKET_RE.exec(pathname);
      if (ticketMatch && req.method === "POST") {
        if (!config.stagingPublicPreview || !previewTickets) {
          return sendJson(res, 404, { error: "Not Found" });
        }
        const meta = await store.readRawMeta(ticketMatch[1]);
        if (!meta || meta.previewEnabled === false || meta.lifecycleState === "trashed") {
          return sendJson(res, 404, { error: "Not Found" });
        }
        const ticket = previewTickets.issue(ticketMatch[1]);
        return sendJson(res, 201, ticket);
      }

      const sharesMatch = SHARES_RE.exec(pathname);

      if (sharesMatch) {
        const id = sharesMatch[1];

        if (req.method === "GET") {
          return sendJson(res, 200, await store.listShares(id));
        }

        if (req.method === "POST") {
          const payload = await readJsonPayload(req, config.limits);
          const expiresAt = await resolveExpiry(payload);

          const share = await store.createShare(id, { expiresAt });
          return sendJson(res, 201, share);
        }
      }

      const shareActionMatch = SHARE_ACTION_RE.exec(pathname);

      if (shareActionMatch && req.method === "POST") {
        const [, id, shareId, action] = shareActionMatch;

        if (action === "revoke") {
          return sendJson(res, 200, await store.revokeShare(id, shareId));
        }

        if (action === "enable") {
          return sendJson(res, 200, await store.setShareEnabled(id, shareId, true));
        }

        return sendJson(res, 200, await store.setShareEnabled(id, shareId, false));
      }

      // RC6: deploy-key management (admin only — the deploy-key guard never
      // reaches here because the exact-match allowlist excludes this path).
      const deployKeysMatch = DEPLOY_KEYS_RE.exec(pathname);

      if (deployKeysMatch) {
        const id = deployKeysMatch[1];

        if (req.method === "GET") {
          return sendJson(res, 200, await store.listDeployKeys(id));
        }

        if (req.method === "POST") {
          const payload = await readJsonPayload(req, config.limits);
          const expiresAt = await resolveExpiry(payload);

          const key = await store.createDeployKey(id, { expiresAt });
          return sendJson(res, 201, key);
        }
      }

      const deployKeyActionMatch = DEPLOY_KEY_ACTION_RE.exec(pathname);

      if (deployKeyActionMatch && req.method === "POST") {
        const [, id, keyId, action] = deployKeyActionMatch;

        if (action === "revoke") {
          return sendJson(res, 200, await store.revokeDeployKey(id, keyId));
        }

        if (action === "enable") {
          return sendJson(res, 200, await store.setDeployKeyEnabled(id, keyId, true));
        }

        return sendJson(res, 200, await store.setDeployKeyEnabled(id, keyId, false));
      }

      return sendJson(res, 404, { error: "Not Found" });
    } catch (err) {
      sendError(res, err);
    }
  };
}

function cleanDescription(raw, limits) {
  if (typeof raw !== "string") {
    return undefined;
  }

  const value = raw.trim().slice(0, limits.maxDescriptionChars);
  return value.length > 0 ? value : undefined;
}

// Shared expiresAt/expiresInHours parsing for share and deploy-key creation
// (previously inline in the share route; behavior unchanged).
function resolveExpiry(payload) {
  if (payload.expiresAt !== undefined && payload.expiresAt !== null) {
    if (typeof payload.expiresAt !== "string") {
      throw new ApiError(400, "Invalid expiresAt", "INVALID_EXPIRES_AT");
    }
    return payload.expiresAt;
  }

  if (typeof payload.expiresInHours === "number") {
    if (
      !Number.isFinite(payload.expiresInHours) ||
      payload.expiresInHours <= 0 ||
      payload.expiresInHours > 24 * 365
    ) {
      throw new ApiError(400, "Invalid expiresInHours", "INVALID_EXPIRES_AT");
    }
    return new Date(
      Date.now() + payload.expiresInHours * 3600 * 1000
    ).toISOString();
  }

  return null;
}

async function readJsonPayload(req, limits) {
  try {
    return JSON.parse(await readBody(req, limits.maxJsonBodyBytes));
  } catch (err) {
    if (err instanceof ApiError) {
      throw err; // 413 passthrough with legacy message
    }
    throw new ApiError(400, "Invalid JSON");
  }
}

// Stages a legacy-style JSON html payload as a single-file project.
async function stageJsonHtml(html, store) {
  const stagedDir = store.stagingDir("new");

  try {
    await fs.mkdir(stagedDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(stagedDir, "index.html"), html, {
      flag: "wx",
      mode: 0o600
    });

    return {
      stagedDir,
      stats: {
        fileCount: 1,
        totalSize: Buffer.byteLength(html),
        entryPoint: "index.html"
      }
    };
  } catch (err) {
    await fs.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function handleCreateProject(req, res, { config, store }) {
  const contentType = req.headers["content-type"] || "";

  if (contentType.startsWith("multipart/form-data")) {
    return await handleMultipartCreate(req, res, { config, store });
  }

  if (!contentType.startsWith("application/json")) {
    return sendJson(res, 415, {
      error: "Use application/json or multipart/form-data",
      code: "UNSUPPORTED_MEDIA_TYPE"
    });
  }

  const payload = await readJsonPayload(req, config.limits);

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const html = typeof payload.html === "string" ? payload.html : "";

  if (
    !name ||
    name.length > 100 ||
    !html.toLowerCase().includes("<html") ||
    Buffer.byteLength(html) > LEGACY_HTML_BYTES
  ) {
    return sendJson(res, 400, { error: "Invalid name or HTML" });
  }

  const description = cleanDescription(payload.description, config.limits);
  const staged = await stageJsonHtml(html, store);

  try {
    const view = await store.createProject({
      name,
      description,
      stagedDir: staged.stagedDir,
      stats: staged.stats
    });

    return sendJson(res, 201, view);
  } catch (err) {
    await fs.rm(staged.stagedDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// v0.3.0: multipart upload of a single .html/.htm/.zip file.
async function handleMultipartCreate(req, res, { config, store }) {
  const { fields, file } = await parseMultipartUpload(req, {
    tmpDir: store.tmpDir,
    limits: config.limits
  });

  try {
    const name = typeof fields.name === "string" ? fields.name.trim() : "";

    if (!name) {
      throw new ApiError(400, "Name is required", "NAME_REQUIRED");
    }

    if (name.length > 100) {
      throw new ApiError(
        400,
        "Name is too long (max 100 characters)",
        "NAME_TOO_LONG"
      );
    }

    const description = cleanDescription(fields.description, config.limits);
    const staged = await stageFromUpload(file, { store, limits: config.limits });

    try {
      const view = await store.createProject({
        name,
        description,
        stagedDir: staged.stagedDir,
        stats: staged.stats
      });

      return sendJson(res, 201, view);
    } catch (err) {
      await fs.rm(staged.stagedDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    // The parsed upload temp file belongs to this handler until staging
    // moves it; make sure route-level failures never leak it.
    await fs.rm(file.tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

// v0.3.0: upload a new version (multipart file or legacy JSON html).
// Failure at any validation stage never changes the current version.
// RC6: an optional X-Arcunara-Content-Hash header enables idempotent
// re-deploys (identical content to the current version is a no-op); when
// the caller authenticated with a deploy key, its usage is recorded for
// the workbench (success and failure). Deploy-key uploads never touch
// previewEnabled or any other project setting.
async function handleVersionCreate(req, res, { config, store, id }) {
  const rawHash = req.headers["x-arcunara-content-hash"];
  const contentHash =
    typeof rawHash === "string" && rawHash.trim() !== ""
      ? rawHash.trim().toLowerCase()
      : undefined;

  const meta = await store.readRawMeta(id);

  if (!meta) {
    throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
  }

  const contentType = req.headers["content-type"] || "";

  if (contentType.startsWith("multipart/form-data")) {
    const { fields: _fields, file } = await parseMultipartUpload(req, {
      tmpDir: store.tmpDir,
      limits: config.limits
    });

    try {
      const staged = await stageFromUpload(file, { store, limits: config.limits });

      try {
        const view = await store.addVersion(id, { ...staged, contentHash });
        await recordDeployUseIfKeyed(req, store, id, view.version, "ok");
        return sendJson(res, 201, view);
      } catch (err) {
        await fs.rm(staged.stagedDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    } catch (err) {
      await fs.rm(file.tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  if (contentType.startsWith("application/json")) {
    const payload = await readJsonPayload(req, config.limits);
    const html = typeof payload.html === "string" ? payload.html : "";

    if (
      !html.toLowerCase().includes("<html") ||
      Buffer.byteLength(html) > LEGACY_HTML_BYTES
    ) {
      throw new ApiError(400, "Invalid HTML payload", "INVALID_HTML");
    }

    const staged = await stageJsonHtml(html, store);

    try {
      const view = await store.addVersion(id, { ...staged, contentHash });
      await recordDeployUseIfKeyed(req, store, id, view.version, "ok");
      return sendJson(res, 201, view);
    } catch (err) {
      await fs.rm(staged.stagedDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  return sendJson(res, 415, {
    error: "Use application/json or multipart/form-data",
    code: "UNSUPPORTED_MEDIA_TYPE"
  });
}

// Best-effort deploy-key usage bookkeeping (RC6). No-op for admin calls.
async function recordDeployUseIfKeyed(req, store, projectId, version, result) {
  if (!req.deployKey || req.deployKey.projectId !== projectId) {
    return;
  }

  await store
    .recordDeployUse(projectId, req.deployKey.keyId, { version, result })
    .catch(() => {});
}

async function handleRollback(req, res, { config, store, id }) {
  const payload = await readJsonPayload(req, config.limits);
  const target = payload.version;

  if (!Number.isInteger(target) || target < 1) {
    throw new ApiError(
      400,
      "Version must be a positive integer",
      "INVALID_VERSION"
    );
  }

  const result = await store.rollback(id, target);
  return sendJson(res, 200, result);
}
