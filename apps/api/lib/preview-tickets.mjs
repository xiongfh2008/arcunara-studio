// Short-lived staging preview capabilities (in memory only).
//
// Cloudflare Access cookie-based authentication can fail from an opaque-origin
// sandboxed iframe (especially in private browsing). A signed-in administrator
// obtains a 10-minute, project-bound capability via the authenticated API,
// then every HTML/JS/CSS/image request uses the same /s/{token}/ prefix.
//
// A ticket is NOT a permanent share. It is not written to meta.json,
// does not survive process restart, is never returned by the shares API, and
// cannot grant API/admin privileges. Sharing the URL still gives the holder
// access to that project's preview until expiry. Keep TTL short.
import crypto from "node:crypto";

const SECRET_BYTES = 32;
const TICKET_MS = 10 * 60 * 1000;
const MAX_LIVE_TICKETS = 1024;

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

export function createPreviewTickets({ now = () => Date.now() } = {}) {
  const tickets = new Map();

  function sweep() {
    const current = now();
    for (const [id, record] of tickets) {
      if (record.expiresAt <= current) tickets.delete(id);
    }
  }

  function issue(projectId) {
    sweep();
    while (tickets.size >= MAX_LIVE_TICKETS) {
      tickets.delete(tickets.keys().next().value);
    }
    let id;
    do {
      id = "ee" + crypto.randomBytes(7).toString("hex");
    } while (tickets.has(id));
    const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
    const expiresAt = now() + TICKET_MS;
    tickets.set(id, { projectId, tokenHash: hashSecret(secret), expiresAt });
    return {
      token: `${id}.${secret}`,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  function validate(id, secret) {
    if (typeof secret !== "string" ||
        !/^[0-9a-f]{16}$/.test(id) ||
        !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    const ticket = tickets.get(id);
    if (!ticket) return null;
    if (ticket.expiresAt <= now()) {
      tickets.delete(id);
      return null;
    }
    const candidate = hashSecret(secret);
    if (!crypto.timingSafeEqual(candidate, ticket.tokenHash)) return null;
    return { projectId: ticket.projectId, expiresAt: ticket.expiresAt };
  }

  return { issue, validate };
}
