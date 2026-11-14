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
