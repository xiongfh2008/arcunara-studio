// Timing-safe Bearer token authorization.
// v0.2.0 semantics preserved: the "Bearer " prefix match is case-sensitive,
// length mismatches fail fast without touching timingSafeEqual.

import crypto from "node:crypto";

export function createAuth(token) {
  const expected = Buffer.from(token);

  return function authorized(req) {
    const provided = (
      req.headers.authorization || ""
    ).replace(/^Bearer /, "");

    const actual = Buffer.from(provided);

    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
  };
}

// RC6 deploy keys ride the same Authorization header with a dpk_ prefix so
// they can never collide with the admin token comparison above: the API
// handler parses the header first and routes dpk_* to the restricted
// project-scoped guard instead of the admin check.
const DEPLOY_TOKEN_RE = /^Bearer dpk_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;

export function parseDeployToken(authHeader) {
  const match = DEPLOY_TOKEN_RE.exec(authHeader || "");

  return match ? { keyId: match[1], secret: match[2] } : null;
}
