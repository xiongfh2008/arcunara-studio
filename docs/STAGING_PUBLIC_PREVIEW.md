# RC7 — Staging public preview gateway on one custom hostname (opt-in)

**Status: code complete for staging experiments; NOT a production approval.**
No VPS, Cloudflare Access or Nginx changes are made automatically by this branch.
Keep the current SSH-only preview working until all guards and rollback steps are verified.

## Design

The only custom hostname is `https://staging.arcunara.com`:

| Path | Cloudflare Access | Nginx upstream | Origin authorization |
| --- | --- | --- | --- |
| `/console`, `/api/*`, all other paths | Existing **Arcunara Admin Only** | 127.0.0.1:28088 | Existing RS256 JWT / API bearer or deploy key |
| `/p/{project-uuid}/*` | Existing **Arcunara Admin Only**, unchanged | 127.0.0.1:28089 | **NEW** signed Access JWT on **every** request; 404 otherwise |
| `/s/{shareId}.{secret}/*` | More-specific **Bypass Everyone** **only for /s/** | 127.0.0.1:28089 | Existing token secret, expiry, enable/revoke and project binding on **every** request |

Do **not** add Bypass to the existing hostname-wide application. Instead
create a separate, more-specific Access application at
`staging.arcunara.com/s/*`, with one Bypass policy, Include Everyone.
Cloudflare explicitly says specific paths take precedence, and that
`/s/*` does not match the bare `/s`. Do not broaden this to `/*`,
`/p/*` or `/api/*`.
See https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
and https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ .

**Browser isolation**: all uploaded HTML/SVG preview responses continue to
carry the backend CSP `sandbox allow-scripts allow-forms` **without**
`allow-same-origin`; the navigation wrapper has a stricter sandbox. Thus
preview script execution uses an opaque origin, not the console's origin.
Nginx adds a second independent sandbox policy as defense in depth.
Do not remove either policy or enable `allow-same-origin`. No upload is
ever interpreted by the API server.

**Staging-only exception**: this is one HTTPS hostname with strict browser
sandboxing, *not* a separate network origin. A security review and a
dedicated preview hostname/origin remain required before production,
particularly for arbitrary untrusted HTML, browser compatibility, cookie
scope and defense against future CSP regressions. Do not claim this
single-host arrangement is general-purpose multi-tenant hosting.

## Configuration

In the existing private root `/opt/arcunara-studio-v03-test/.env`
**in addition to** the four previously configured `ARCU_ACCESS_*` values:

```dotenv
ARCU_STAGING_PUBLIC_PREVIEW=1
ARCU_PREVIEW_PUBLIC_BASE_URL=https://staging.arcunara.com
```

The flag defaults to `0`. With `1`, startup fails if the full Access
configuration is missing or the preview base URL is not exactly the configured
Access HTTPS origin. The flag changes **only** preview authorization and the
workbench base URL; it does not configure Cloudflare or Nginx.
`infra/docker/compose.yaml` forwards the flag; existing Compose support
for `ARCU_PREVIEW_PUBLIC_BASE_URL` is retained.

## Safe deployment order (manual, do not skip)

1. CI must pass for the exact pinned commit. Confirm current working
   `/console`, 8 existing projects, health, backups and other containers.
2. Deploy the tested code **first**, with `ARCU_STAGING_PUBLIC_PREVIEW=1`
   and `ARCU_PREVIEW_PUBLIC_BASE_URL=https://staging.arcunara.com`. Use
   the existing isolated `scripts/deploy-vps.sh` script, which explicitly
   reads the private root `.env`. **Do not expose /p in Nginx before this
   step**: earlier code treated /p as a bearer-less UUID route.
3. Before touching Nginx, verify on VPS:
   `curl -i http://127.0.0.1:28089/p/<existing-uuid>/` -> **404**
   WITHOUT JWT, including the UUID root and a static asset. Verify
   `/s/not-a-token/` -> **404** and existing API health and admin token
   remain correct.
4. Back up `/etc/nginx/sites-enabled/staging.arcunara.com` and inspect
   existing location blocks. Add **only these two locations** to the
   existing 443 `server { }` for `staging.arcunara.com` (adapt to
   existing include structure; do not add a new server or proxy port):
   ```nginx
   # Defense-in-depth at the Nginx ingress: this keeps /p private even if
   # someone rolls the preview service back to older code without its gate.
   # Requires nginx's standard auth_request module.
   location = /__arcunara_preview_access_check {
       internal;
       proxy_pass http://127.0.0.1:28088/api/limits;
       proxy_pass_request_body off;
       proxy_set_header Content-Length "";
       proxy_set_header Host staging.arcunara.com;
       proxy_set_header Authorization "";
       proxy_set_header Cookie "";
       proxy_set_header Cf-Access-Jwt-Assertion $http_cf_access_jwt_assertion;
   }
   location ^~ /p/ {
       limit_except GET { deny all; }
       auth_request /__arcunara_preview_access_check;
       proxy_pass http://127.0.0.1:28089;
       proxy_set_header Host staging.arcunara.com;
       proxy_set_header X-Forwarded-Proto https;
       proxy_set_header Authorization "";
       proxy_set_header Cookie "";
       proxy_set_header Cf-Access-Jwt-Assertion $http_cf_access_jwt_assertion;
       add_header Content-Security-Policy "sandbox allow-scripts allow-forms" always;
       add_header X-Content-Type-Options "nosniff" always;
       add_header Cache-Control "no-store" always;
   }
   location ^~ /s/ {
       limit_except GET { deny all; }
       proxy_pass http://127.0.0.1:28089;
       proxy_set_header Host staging.arcunara.com;
       proxy_set_header X-Forwarded-Proto https;
       proxy_set_header Authorization "";
       proxy_set_header Cookie "";
       proxy_set_header Cf-Access-Jwt-Assertion "";
       add_header Content-Security-Policy "sandbox allow-scripts allow-forms" always;
       add_header X-Content-Type-Options "nosniff" always;
       add_header Cache-Control "no-store" always;
   }
   ```
   Keep the existing default `location /` to API :28088 unchanged.
   `sudo nginx -t` must succeed before `sudo systemctl reload nginx`.
   Existing site shared configuration and default virtual hosts are NOT
   touched. Neither upstream port becomes public on the firewall. The
   `auth_request` subrequest must be verified with a real Cloudflare
   session before creating the /s bypass rule. Cloudflare /p failure
   should remain Access 302; direct-to-origin without JWT must be
   rejected by the backend and the Nginx auth subrequest.
5. With the existing hostname-wide Access policy *still active*, validate
   an unauthenticated `/console`, `/api/projects`, and `/p/uuid/` all
   redirect to Access (typically 302). A signed-in admin must get a real
   preview, and direct-to-origin requests forged with only an email header
   must return 404. Check the CSP *all the way through* Cloudflare on the
   returned HTML: `sandbox` present, no `allow-same-origin`.
6. **Only after these checks**, add the specific Cloudflare Access
   `staging.arcunara.com/s/*` application with **Bypass Everyone**,
   leaving the existing Admin Only application untouched. Test in a
   fresh incognito session: a valid **new** share link is usable, a
   revoked/expired share and an unknown token are 404; `/api/projects`
   and `/console` still redirect to Access; `/p/uuid/` still redirects.
   A share URL is a bearer capability: anyone possessing it can read
   the shared prototype until expiry/revocation.
7. Test the real 2,737-file Axure project: CSS, SVG, fonts, 12-page
   navigation, relative links, image decoding, and (known-limited)
   interactions. Test version changes and rollback with an existing
   share token. Keep the fallback SSH tunnel until confirmed.
8. Document the final Access rule screenshots and nginx config
   separately; never post `.env`, JWT assertion headers, bearer tokens,
   or full share secrets to a public issue.

## RC8: sandboxed iframe + Access cookie regression fix

**Observed issue (2026-11-18):** the outer `/p/{id}/` navigation page
loads through Access, but sandboxed child iframe requests are redirected
to `alexxiong2025.cloudflareaccess.com`. The browser blocks the login
page by the navigation page's `frame-src 'self'` CSP, so the content
area is blank. A separate blocked Cloudflare Insights beacon script is
nonessential. This is a third-party-cookie problem in sandboxed frames,
particularly Chrome Incognito; do not disable the CSP sandbox.

**RC8 mechanism:** The staging workbench remains protected by Access. On
each Preview click it makes an authenticated **POST**
`/api/projects/{id}/preview-ticket`. A successful request issues a
cryptographically random, **ten-minute**, project-scoped capability in
**server memory only**, then opens `/s/{ticket}/`. The Nginx /s route
proxies to the existing preview server. Cloudflare MUST exempt **only**
`staging.arcunara.com/s/*` from Access so embedded pages and all static
assets can load with **no cookie dependency**. The token stays in every
relative subresource URL and is validated on every request; disabling
project preview invalidates it. Tickets are not persisted, survive no
restart, and never appear in the normal shares list. An issued link is
a **bearer link**: anyone with the token can view it until expiry.

Safety: no `/p` Access Bypass; no `allow-same-origin`; no wider
CORS or `script-src`; API never accepts a preview ticket as admin
authorization; permanent share behavior stays unchanged; valid tokens
must still be unpredictable and expired/forged tokens return 404.

**Rollout order (after RC7 Nginx /p + /s has been installed and verified):**

1. Keep the current staging Host Access policy. Deploy CI-passed RC8 code,
   leave existing Nginx routing unchanged. Confirm admin /console and
   /api still work, eight projects preserved, and unauthenticated /p
   remains 401 at Nginx / 404 at backend.
2. On the VPS, exercise the ticket creation endpoint through the private
   API using the existing bearer token **without printing that bearer
   token or the issued ticket**, and check a real short-lived token
   returns 200 on `http://127.0.0.1:28089/s/{token}/`; a wrong
   token returns 404; a valid static asset returns 200. Confirm no
   extra record is added in the project's share list.
3. In Cloudflare Zero Trust > Access controls > Applications, create a
   separate more-specific Self-hosted app whose **only** target is
   `staging.arcunara.com/s/*`. Add a Bypass policy with Include:
   Everyone **for this path only**. Do not alter the original
   `Arcunara Studio Staging` application's Admin Only policy or
   any `/p`, `/api` or `/console` paths.
4. From a clean incognito window (no Access login), GET
   `/s/invalid-token/` should yield 404 rather than Access 302.
   Also test /console, /api/projects and /p/{id}/ all still
   redirect to Access; any private preview JWT-less request to origin
   remains denied. If these expectations fail, remove /s Bypass
   immediately. A valid share/token link is intentionally public
   to token holders.
5. Log in as admin, click Preview: it should open a ten-minute /s URL,
   render 12-page Axure navigation, CSS/SVG/fonts, and allow page
   switching without third-party cookies. Check expiry in a new tab
   after the ten-minute limit and project disable/enable.
6. Retain RC7 Nginx defense-in-depth auth_request for /p, and
   maintain the backend's CSP sandbox for all uploaded content.
   When in doubt, roll back the Cloudflare /s path exception first,
   not the core administrator Access policy.

Cloudflare official cookie docs:
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
Cloudflare path precedence:
https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/

## Fail closed / rollback

- If Nginx test fails: restore the saved staging site config and
  `nginx -t && systemctl reload nginx`; do not touch unrelated sites.
- If a public route behaves unexpectedly: **remove the new /p/, /s/
  and internal auth-request Nginx locations first**, then reload, then
  disable/revert the `/s/*` Bypass application. This restores private
  SSH preview.
- On application rollback, the Nginx `auth_request` remains a
  separate signed-JWT barrier. Nevertheless, safest procedure is to
  first remove the /p/ and /s/ Nginx routes, then set
  `ARCU_STAGING_PUBLIC_PREVIEW=0`, remove the custom preview base and
  deploy the prior image. **Never leave a /p/ public route without
  both the signed-JWT Nginx auth gate and a validated app gate.**
- Do not assume an HTTP 302 alone proves origin security; signed JWT
  verification must also pass/fail as expected.

## Limitations

- No second custom DNS hostname and no new VPS listener are required.
- Share pages run under a sandboxed opaque origin, so native Axure
  index.html player, XHR, localStorage, and `eval`-based workflows remain
  limited exactly as in `KNOWN_LIMITATIONS.md`.
- Cloudflare Access Bypass provides no Access identity check and no
  Access request logging for share traffic; audit/rate limiting at Nginx
  or platform is a further production task.
- Single-admin staging is not a tenant authorization model.
