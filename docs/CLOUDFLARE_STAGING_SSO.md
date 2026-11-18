# Cloudflare Access staging single sign-on (one public subdomain)

The isolated staging workbench is at `https://staging.arcunara.com/console`.
The existing preview port remains loopback-only. **Do not expose uploaded
HTML to the workbench origin** to make previews publicly reachable.

## Access setup

Create a Cloudflare Access **Self-hosted / Public DNS** application protecting
the full `staging.arcunara.com` hostname. Use an Allow policy listing only
the intended admin mailbox, not Everyone or Bypass. Confirm unauthenticated
`/console` **and** `/api/projects` return a Cloudflare Access redirect.

The app itself must cryptographically validate the application JWT. Cloudflare
Access provides `Cf-Access-Jwt-Assertion` to the origin. Never treat unverified
email headers or HTTP 302 from the edge as an administrator authorization.

## Optional automatic workbench connection

These settings are **disabled by default** and apply only when **all four**
are present. In the deployment's private, gitignored
`/opt/arcunara-studio-v03-test/.env`, add:

```dotenv
ARCU_ACCESS_ISSUER=https://YOUR-TEAM.cloudflareaccess.com
ARCU_ACCESS_AUDIENCE=YOUR_APPLICATION_64_HEX_AUD_TAG
ARCU_ACCESS_ADMIN_EMAIL=YOUR_EXACT_ALLOWED_EMAIL
ARCU_ACCESS_ORIGIN=https://staging.arcunara.com
```

**Never overwrite an existing .env or put this file into Git.** Copy the
issuer hostname and the **AUD tag** from the actual Cloudflare Access
application details; they must match the staging app, not another app.
A team hostname may look like `alexxiong2025.cloudflareaccess.com`.

The Docker Compose test stack passes these variables into the application.
Deploy a CI-verified commit using the existing isolated deployment script,
which takes backups, pins the image, runs acceptance and rolls back its own
container on failure. Do not touch the legacy Arcunara container or other
services. The script runs from the repository root so its private root
`.env` will be used for Compose interpolation. Verify the merged Compose
configuration **without printing environment values**.

After deployment, a valid logged-in browser will load `/api/limits` and
`/api/projects` without pasting a bearer Token. API requests with an
`Authorization` header continue through the prior bearer/deploy-key
guards. Manual fallback remains available for diagnostics.

The backend verifies the RS256 signature against the Cloudflare Access
team's public JWKS, issuer, audience, expiry/nbf and exact configured email.
Requests must use the intended staging Host. Mutating browser requests must
have `Origin: https://staging.arcunara.com`,
`X-Arcunara-Access-Request: 1` and (if supplied) same-origin
`Sec-Fetch-Site`. A missing, invalid or unverified JWT never grants access.

The app's own API token stays required for internal CLI use and is never
injected into `/console`.

## Deployment checks and remaining boundaries

- Keep `ARCU_LOCAL_AUTO_LOGIN=0` on the VPS.
- The Nginx staging proxy should preserve `Host` and forward the signed
  `Cf-Access-Jwt-Assertion` header to the backend (do not log its value).
- Access cannot replace origin hardening. Restrict direct-origin traffic
  where feasible, preserving unrelated virtual hosts and services.
- Test an anonymous request through public DNS: redirect to Access.
- Test direct origin requests **without** a signed assertion: API returns
  401 even if someone forges an email header. Keep the existing API token
  private.
- Test logged-in browser project read and write; cross-origin write without
  the custom header must fail.
- A Cloudflare Access app is not the full multi-tenant SaaS account system:
  this mode is for one staging administrator only.
- This change intentionally does **not** switch `arcunara.com` or make the
  preview port publicly reachable.

Cloudflare documentation:
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
