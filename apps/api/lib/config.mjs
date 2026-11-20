// Environment-driven configuration.
//
// Server defaults match the validated v0.2.0 deployment. The ARCU_MAX_*
// limits govern the v0.3.0 multipart/ZIP upload engine and are enforced
// while streaming, not after completion.

import { readFileSync } from "node:fs";

const MIB = 1024 * 1024;

function intFromEnv(
  env,
  name,
  fallback,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {}
) {
  const raw = env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: "${raw}"`);
  }

  return value;
}

function portFromEnv(env, name, fallback) {
  return intFromEnv(env, name, fallback, { min: 0, max: 65535 });
}

// Browser-facing base URL for preview links built by the workbench.
// The preview server's LISTEN address (port/host) is an internal concern —
// under Docker the browser reaches previews via the host-mapped port or a
// dedicated public origin, so the workbench must never construct links from
// the internal port when an explicit base URL is configured.
function previewPublicBaseUrlFromEnv(env) {
  const raw = env.ARCU_PREVIEW_PUBLIC_BASE_URL;

  if (raw === undefined || raw.trim() === "") {
    return null;
  }

  let url;

  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid ARCU_PREVIEW_PUBLIC_BASE_URL: "${raw}"`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Invalid ARCU_PREVIEW_PUBLIC_BASE_URL protocol: "${url.protocol}" (use http/https)`
    );
  }

  if (url.username || url.password) {
    throw new Error("ARCU_PREVIEW_PUBLIC_BASE_URL must not contain credentials");
  }

  if (url.search || url.hash) {
    throw new Error("ARCU_PREVIEW_PUBLIC_BASE_URL must not contain a query or fragment");
  }

  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export function loadConfig(env = process.env) {
  const tokenFile = env.ARCU_TOKEN_FILE || "/run/secrets/api_token";
  const token = readFileSync(tokenFile, "utf8").trim();

  if (!token) {
    throw new Error("API token file is empty");
  }

  // Local convenience is opt-in and must never silently turn on in Docker/VPS.
  // Both listeners must bind exactly to IPv4 loopback before issuing a local
  // browser session. The admin token is still required for CLI and remote use.
  const apiHost = env.ARCU_API_HOST || "0.0.0.0";
  const previewHost = env.ARCU_PREVIEW_HOST || "0.0.0.0";
  const localFlag = env.ARCU_LOCAL_AUTO_LOGIN || "0";
  if (localFlag !== "0" && localFlag !== "1") {
    throw new Error("ARCU_LOCAL_AUTO_LOGIN must be 0 or 1");
  }
  const localAutoLogin = localFlag === "1";
  if (localAutoLogin && (apiHost !== "127.0.0.1" || previewHost !== "127.0.0.1")) {
    throw new Error("ARCU_LOCAL_AUTO_LOGIN requires both API and preview to bind 127.0.0.1");
  }

  // Cloudflare Access SSO is explicitly configured for a single HTTPS
  // hostname and one administrator email. Never implicitly trust edge headers.
  const accessEnvNames = [
    "ARCU_ACCESS_ISSUER",
    "ARCU_ACCESS_AUDIENCE",
    "ARCU_ACCESS_ADMIN_EMAIL",
    "ARCU_ACCESS_ORIGIN"
  ];
  const accessValues = accessEnvNames.map(name => (env[name] || "").trim());
  const accessSetCount = accessValues.filter(Boolean).length;
  let cloudflareAccess = null;
  if (accessSetCount > 0) {
    if (accessSetCount !== accessValues.length) {
      throw new Error("Cloudflare Access requires all four ARCU_ACCESS_* settings");
    }
    if (localAutoLogin) {
      throw new Error("Cloudflare Access and local auto login cannot both be enabled");
    }
    const [issuer, audience, email, origin] = accessValues;
    let issUrl, siteUrl;
    try {
      issUrl = new URL(issuer);
      siteUrl = new URL(origin);
    } catch {
      throw new Error("Cloudflare Access issuer and origin must be valid HTTPS URLs");
    }
    if (issUrl.protocol !== "https:" ||
        !/^[a-z0-9-]+[.]cloudflareaccess[.]com$/.test(issUrl.hostname) ||
        issUrl.origin !== issuer || !/^[0-9a-f]{64}$/i.test(audience) ||
        siteUrl.protocol !== "https:" || siteUrl.origin !== origin ||
        siteUrl.hostname === issUrl.hostname ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Invalid Cloudflare Access origin, issuer, audience or admin email");
    }
    cloudflareAccess = {
      issuer,
      audience,
      email: email.toLowerCase(),
      origin,
      host: siteUrl.host
    };
  }

  // Explicit staging-only, single-public-host preview gateway.
  // /p/ requires a *signed* Cloudflare Access JWT, while /s/ continues
  // to require a per-share secret.  Disabled unless explicitly enabled.
  // The browser's opaque-origin CSP sandbox remains mandatory.
  const publicPreviewFlag = env.ARCU_STAGING_PUBLIC_PREVIEW || "0";
  if (publicPreviewFlag !== "0" && publicPreviewFlag !== "1") {
    throw new Error("ARCU_STAGING_PUBLIC_PREVIEW must be 0 or 1");
  }
  const stagingPublicPreview = publicPreviewFlag === "1";
  const previewPublicBaseUrl = previewPublicBaseUrlFromEnv(env);
  if (stagingPublicPreview && (
    !cloudflareAccess ||
    previewPublicBaseUrl !== cloudflareAccess.origin ||
    localAutoLogin
  )) {
    throw new Error(
      "ARCU_STAGING_PUBLIC_PREVIEW requires Cloudflare Access and a preview base matching its HTTPS origin"
    );
  }

  // RC20A: opt-in project-scoped member tokens; existing administrator
  // credentials and Cloudflare Access stay unchanged by default.
  const teamFlag = env.ARCU_TEAM_ACCESS_ENABLED || "0";
  if (!["0","1"].includes(teamFlag)) {
    throw new Error("ARCU_TEAM_ACCESS_ENABLED must be 0 or 1");
  }
  const teamAccessEnabled = teamFlag === "1";

  // RC20B: invitation-only password accounts with HttpOnly sessions.
  // Disabled by default. Never allow public password auth on a directly
  // exposed HTTP listener; reverse proxies must terminate HTTPS and reach
  // Node only through IPv4 loopback.
  const memberLoginFlag=env.ARCU_MEMBER_LOGIN_ENABLED||"0";
  if(!["0","1"].includes(memberLoginFlag)) {
    throw new Error("ARCU_MEMBER_LOGIN_ENABLED must be 0 or 1");
  }
  const memberLoginEnabled=memberLoginFlag==="1";
  const originRaw=(env.ARCU_MEMBER_PUBLIC_ORIGIN||"").trim();
  let memberPublicOrigin=null;
  if(originRaw) {
    let u;
    try{u=new URL(originRaw);}
    catch{throw new Error("Invalid ARCU_MEMBER_PUBLIC_ORIGIN");}
    if(u.protocol!=="https:"||u.origin!==originRaw||
        u.username||u.password||u.search||u.hash||u.pathname!=="/") {
      throw new Error("ARCU_MEMBER_PUBLIC_ORIGIN must be a plain HTTPS origin");
    }
    memberPublicOrigin=originRaw;
  }
  if(memberLoginEnabled && (!teamAccessEnabled || apiHost!=="127.0.0.1")) {
    throw new Error("Member login requires team access and loopback API host");
  }

  // RC13: independent public static-site listener. Explicitly opt in and
  // route each project through a distinct UUID subdomain. Never reuse the
  // platform/admin/preview hostname, even though sites are public content.
  // No DNS, nginx, Cloudflare, or Docker port is automatically changed.
  const siteFlag = env.ARCU_SITE_HOSTING_ENABLED || "0";
  if (!["0","1"].includes(siteFlag)) {
    throw new Error("ARCU_SITE_HOSTING_ENABLED must be 0 or 1");
  }
  const siteHostingEnabled = siteFlag === "1";
  const siteDomain = (env.ARCU_SITE_DOMAIN || "").trim().toLowerCase();
  if (siteHostingEnabled) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$/.test(siteDomain)) {
      throw new Error("ARCU_SITE_DOMAIN requires a valid dedicated DNS suffix");
    }
    const adminHost = cloudflareAccess?.host ?? null;
    const previewHostName = previewPublicBaseUrl
      ? new URL(previewPublicBaseUrl).hostname : null;
    if (siteDomain === adminHost || siteDomain === previewHostName ||
        (adminHost && adminHost.endsWith("." + siteDomain)) ||
        (previewHostName && previewHostName.endsWith("." + siteDomain))) {
      throw new Error("Static site domain must be separate from the admin and preview origins");
    }
  }

  // Larger, previously tested Axure-export profile for explicitly enabled
  // loopback-only development. The normal production defaults stay strict.
  // Explicit ARCU_MAX_* overrides always take precedence.
  const localAxureLimits = localAutoLogin;
  const limits = {
    // Legacy JSON upload cap — kept byte-identical with v0.2.0 behavior.
    maxJsonBodyBytes: intFromEnv(env, "ARCU_MAX_JSON_BODY_BYTES", 256 * 1024),

    // Multipart/ZIP upload engine limits (see docs/development.md).
    maxZipBytes: intFromEnv(env, "ARCU_MAX_ZIP_BYTES", 20 * MIB),
    maxExtractBytes: intFromEnv(env, "ARCU_MAX_EXTRACT_BYTES", (localAxureLimits ? 128 : 80) * MIB),
    maxFileBytes: intFromEnv(env, "ARCU_MAX_FILE_BYTES", 20 * MIB),
    maxHtmlBytes: intFromEnv(env, "ARCU_MAX_HTML_BYTES", (localAxureLimits ? 8 : 2) * MIB),
    maxFiles: intFromEnv(env, "ARCU_MAX_FILES", localAxureLimits ? 5000 : 2000),
    maxDepth: intFromEnv(env, "ARCU_MAX_DEPTH", 20),
    maxPathLength: intFromEnv(env, "ARCU_MAX_PATH_LENGTH", 256),
    maxDescriptionChars: intFromEnv(env, "ARCU_MAX_DESCRIPTION_CHARS", 1000),
    maxUploadBodyBytes: intFromEnv(env, "ARCU_MAX_UPLOAD_BODY_BYTES", 24 * MIB)
  };


  return {
    cloudflareAccess,
    teamAccessEnabled,
    memberLoginEnabled,
    memberPublicOrigin,
    stagingPublicPreview,
    siteHostingEnabled,
    siteDomain: siteHostingEnabled ? siteDomain : null,
    sitePort: portFromEnv(env, "ARCU_SITE_PORT", 3002),
    siteHost: env.ARCU_SITE_HOST || "127.0.0.1",
    localAutoLogin,
    store: env.ARCU_DATA_DIR || "/app/data",
    token,
    tokenFile,
    apiPort: portFromEnv(env, "ARCU_API_PORT", 3000),
    apiHost,
    previewPort: portFromEnv(env, "ARCU_PREVIEW_PORT", 3001),
    previewHost,
    previewPublicBaseUrl,
    limits
  };
}
