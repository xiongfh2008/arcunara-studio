// Cloudflare Access browser authentication. Opt-in only for a trusted HTTPS
// application origin; no browser-visible bearer tokens, no trust in arbitrary
// identity headers. Each API request carries a signed Access assertion.
//
// This is deliberately separate from local loopback cookies and deploy keys.
// The Cloudflare origin should also be restricted to Cloudflare or a private
// tunnel; cryptographic verification still applies even on direct requests.

import crypto from "node:crypto";

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const MAX_ASSERTION_LENGTH = 16384;
const KEY_CACHE_MS = 10 * 60 * 1000;

function decodeJsonSegment(segment) {
  if (typeof segment !== "string" || !/^[a-zA-Z0-9_-]+$/.test(segment)) {
    throw new Error("Invalid JWT encoding");
  }
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json);
}

function getKeyId(jwk) {
  return jwk && jwk.kty === "RSA" && jwk.use !== "enc" &&
    (jwk.alg === undefined || jwk.alg === "RS256") &&
    typeof jwk.kid === "string" && jwk.kid.length > 0;
}

export function createCloudflareAccessAuth(config, { loadKeys } = {}) {
  const settings = config.cloudflareAccess;
  if (!settings) {
    return { enabled: false, authorized: async () => false };
  }

  let cache = null;
  let cacheExpires = 0;
  let inFlight = null;

  async function fetchKeys() {
    const resp = await fetch(settings.issuer + "/cdn-cgi/access/certs", {
      signal: AbortSignal.timeout(4000),
      headers: { accept: "application/json" },
      redirect: "error"
    });
    if (!resp.ok) throw new Error("Unable to get Cloudflare Access keys");
    const data = await resp.json();
    return data.keys;
  }

  async function keys(force = false) {
    if (!force && cache && Date.now() < cacheExpires) return cache;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const result = await (loadKeys ? loadKeys() : fetchKeys());
      if (!Array.isArray(result) || result.length === 0 || result.length > 50) {
        throw new Error("Invalid Cloudflare Access keys");
      }
      cache = result.filter(getKeyId);
      if (cache.length === 0) throw new Error("No valid Cloudflare Access signing keys");
      cacheExpires = Date.now() + KEY_CACHE_MS;
      return cache;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function verifyAssertion(token) {
    if (typeof token !== "string" || token.length > MAX_ASSERTION_LENGTH) return null;
    const segments = token.split(".");
    if (segments.length !== 3) return null;
    let header, payload;
    try {
      header = decodeJsonSegment(segments[0]);
      payload = decodeJsonSegment(segments[1]);
    } catch {
      return null;
    }

    if (!header || header.alg !== "RS256" || typeof header.kid !== "string") return null;
    if (!payload || typeof payload !== "object") return null;
    const aud = payload.aud;
    const matchedAudience = typeof aud === "string"
      ? aud === settings.audience
      : Array.isArray(aud) && aud.includes(settings.audience);
    const now = Math.floor(Date.now() / 1000);
    if (!matchedAudience || payload.iss !== settings.issuer ||
        !Number.isInteger(payload.exp) || payload.exp <= now ||
        (payload.nbf !== undefined && (!Number.isInteger(payload.nbf) || payload.nbf > now)) ||
        (payload.iat !== undefined && (!Number.isInteger(payload.iat) || payload.iat > now + 60)) ||
        typeof payload.email !== "string" ||
        payload.email.toLowerCase() !== settings.email) {
      return null;
    }

    let availableKeys;
    try {
      availableKeys = await keys();
      if (!availableKeys.some(k => k.kid === header.kid)) {
        availableKeys = await keys(true);
      }
    } catch {
      return null; // Key fetch failure must never fall back to trusting a header.
    }

    const jwk = availableKeys.find(k => k.kid === header.kid);
    if (!jwk) return null;

    try {
      const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
      return crypto.verify(
        "RSA-SHA256",
        Buffer.from(segments[0] + "." + segments[1], "ascii"),
        key,
        Buffer.from(segments[2], "base64url")
      ) ? payload : null;
    } catch {
      return null;
    }
  }

  async function authorized(req) {
    if (req.headers.authorization) return false;
    if (req.headers.host !== settings.host) return false;
    if (req.method !== "GET" && req.method !== "HEAD" &&
        !MUTATING.has(req.method)) return false;

    // A forged cross-origin form is insufficient even if the browser carries
    // a valid Cloudflare Access cookie. Cloudflare adds the signed assertion
    // at the origin after authenticating, so verify both identity and intent.
    if (MUTATING.has(req.method)) {
      const fetchSite = req.headers["sec-fetch-site"];
      if (req.headers.origin !== settings.origin ||
          req.headers["x-arcunara-access-request"] !== "1" ||
          (fetchSite && fetchSite !== "same-origin")) {
        return false;
      }
    }

    const token = req.headers["cf-access-jwt-assertion"];
    return Boolean(await verifyAssertion(token));
  }

  return { enabled: true, authorized, verifyAssertion };
}
