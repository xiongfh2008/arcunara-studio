// Opt-in developer convenience: an HttpOnly browser session scoped to the
// local API origin. Never exposes the administrator bearer token to HTML/JS.
// Disabled unless ARCU_LOCAL_AUTO_LOGIN=1 and both listeners bind loopback.
import crypto from "node:crypto";

const COOKIE_NAME = "arcu_local_session";
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function createLocalSession(config) {
  // Invalidated on each server restart; not stored on disk.
  const sessionId = crypto.randomBytes(32).toString("hex");
  const expected = Buffer.from(sessionId, "utf8");

  function eligible(req) {
    if (!config.localAutoLogin) return false;
    const socket = req.socket;
    if (
      socket.remoteAddress !== "127.0.0.1" ||
      socket.localAddress !== "127.0.0.1"
    ) return false;

    const host = req.headers.host;
    if (typeof host !== "string") return false;
    const match = /^(127[.]0[.]0[.]1|localhost):([0-9]{1,5})$/.exec(host);
    if (!match || Number(match[2]) !== socket.localPort) return false;

    return true;
  }

  function issueCookie(req) {
    if (!eligible(req)) return null;
    return `${COOKIE_NAME}=${sessionId}; Path=/api; Max-Age=14400; HttpOnly; SameSite=Strict`;
  }

  function authorized(req) {
    if (!eligible(req)) return false;

    // Requests supplying explicit authorization must still pass the existing
    // bearer/deploy-key checks and cannot fall back to this cookie.
    if (req.headers.authorization) return false;

    const cookies = (req.headers.cookie || "").split(";").map((part) => part.trim());
    const raw = cookies.find((part) => part.startsWith(`${COOKIE_NAME}=`));
    if (!raw) return false;
    const actual = Buffer.from(raw.slice(COOKIE_NAME.length + 1), "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return false;
    }

    // A cross-origin form must never be able to mutate local admin data.
    // Browsers set Origin on fetch POST/PATCH; the custom header prevents
    // simple cross-site requests from satisfying this check (no CORS grant).
    if (MUTATING_METHODS.has(req.method)) {
      const fetchSite = req.headers["sec-fetch-site"];
      return (
        req.headers["x-arcunara-local-request"] === "1" &&
        req.headers.origin === `http://${req.headers.host}` &&
        (!fetchSite || fetchSite === "same-origin")
      );
    }

    return req.method === "GET" || req.method === "HEAD";
  }

  return { eligible, issueCookie, authorized };
}
