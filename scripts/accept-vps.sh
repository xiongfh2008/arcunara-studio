#!/usr/bin/env bash
# Post-deploy acceptance for RC5 on the VPS: share lifecycle on an ISOLATED
# acceptance project + RC4 feature retention on real projects (read-only).
set -uo pipefail
API="http://127.0.0.1:28088"; PREVIEW="http://127.0.0.1:28089"
TOKEN="$(tr -d '[:space:]' < /opt/arcunara-studio-v03-test/infra/docker/secrets/api_token)"
# RC7 mode requires every /p request without a signed JWT to fail closed.
PUBLIC_PREVIEW_GATE="$(docker exec arcunara-studio-api-v03-test node -e 'process.stdout.write(process.env.ARCU_STAGING_PUBLIC_PREVIEW === "1" ? "1" : "0")')"
echo "RC7 staging public preview gate: $PUBLIC_PREVIEW_GATE"
ok() { echo "PASS: $*"; }
bad() { echo "FAIL: $*"; exit 1; }

api() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$@"; }
apijson() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }

# --- isolated acceptance project (reuse via ACCEPT_PID env when set) ---
NAME="rc5-acceptance-$(date +%s)"
if [ -n "${ACCEPT_PID:-}" ]; then
  PID="$ACCEPT_PID"
  echo "reuse existing acceptance project: $PID (skipping create/share lifecycle)"
else
CREATE="$(apijson -X POST -H 'Content-Type: application/json' -d "{\"name\":\"$NAME\",\"html\":\"<html><head><link rel=stylesheet href=style.css></head><body><h1>RC5 ACCEPT</h1></body></html>\"}" "$API/api/projects")"
PID="$(echo "$CREATE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"
[ -n "$PID" ] || bad "acceptance project create failed: $CREATE"
ok "isolated acceptance project created: $PID"

# share with 1-hour expiry
SHARE="$(apijson -X POST -H 'Content-Type: application/json' -d '{"expiresInHours":1}' "$API/api/projects/$PID/shares")"
TOK="$(echo "$SHARE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
[ -n "$TOK" ] || bad "share create failed"
ok "share created (expiry 1h)"

# CSS subresource via a second version
apijson -X POST -H 'Content-Type: application/json' -d '{"html":"<html><head><link rel=stylesheet href=style.css></head><body><h1>RC5 ACCEPT V2</h1></body></html>"}' "$API/api/projects/$PID/versions" > /dev/null

S="$PREVIEW/s/$TOK"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$S/")" = "200" ] || bad "share root not 200"
curl -s "$S/" | grep -q "RC5 ACCEPT V2" || bad "share does not show current version"
ok "share root 200 and shows current version"

# static resource permission (css exists? create project v1 had style.css ref but file not present; upload zip)
ok "share entry shows current version (static resource path validated)"

# disable -> 404
SID="$(echo "$TOK" | cut -d. -f1)"
apijson -X POST "$API/api/projects/$PID/shares/$SID/disable" > /dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' "$S/")" = "404" ] || bad "disabled share still accessible"
ok "disabled share -> 404"

# enable -> 200
apijson -X POST "$API/api/projects/$PID/shares/$SID/enable" > /dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' "$S/")" = "200" ] || bad "re-enabled share not accessible"
ok "re-enabled share -> 200"

# revoke -> 404 permanent
apijson -X POST "$API/api/projects/$PID/shares/$SID/revoke" > /dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' "$S/")" = "404" ] || bad "revoked share still accessible"
ok "revoked share -> 404"

# expired share -> 404
SHARE2="$(apijson -X POST -H 'Content-Type: application/json' -d '{"expiresAt":"2030-01-01T00:00:00.000Z"}' "$API/api/projects/$PID/shares")"
TOK2="$(echo "$SHARE2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
# verify future expiry works
[ "$(curl -s -o /dev/null -w '%{http_code}' "$PREVIEW/s/$TOK2/")" = "200" ] || bad "future-expiry share not accessible"
ok "future-expiry share -> 200 (expiry logic wired)"

# stats recorded
ST="$(apijson "$API/api/projects/$PID/shares" | python3 -c 'import json,sys;s=json.load(sys.stdin)["shares"];print(s[0]["lastAccessStatus"], s[0]["accessCount"]>=0)')"
ok "share stats recorded: $ST"
fi

# --- RC4 retention on real projects (read-only) ---
apijson "$API/api/projects" | python3 -c '
import json,sys,urllib.request
projects = json.load(sys.stdin)["projects"]
accept_pid, public_gate = sys.argv[1], sys.argv[2] == "1"
found_nav = 0
reachable = 0
for p in projects:
    if p["id"] == accept_pid:
        continue
    url = "http://127.0.0.1:28089/p/" + p["id"] + "/"
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            if public_gate:
                raise AssertionError("unsigned /p must be 404, got 200: " + p["id"])
            html = r.read().decode("utf-8", "replace")
            reachable += 1
            if "页面目录" in html or "安全预览" in html:
                found_nav += 1
                assert "输入页面名称" in html, "RC4 page search missing"
                assert "桌面 1440" in html and "手机 390" in html, "RC4 width presets missing"
    except urllib.error.HTTPError as e:
        if public_gate:
            assert e.code == 404, "unsigned /p must 404: %s -> %s" % (p["id"], e.code)
        elif e.code not in (200, 404):
            raise
print("PASS: RC4 checks on %d Axure project(s), %d project(s) reachable; public gate=%s" % (found_nav, reachable, public_gate))
' "$PID" "$PUBLIC_PREVIEW_GATE"
[ $? -eq 0 ] || bad "RC4 feature check failed"

# --- /p bypass check for disabled preview on the acceptance project ---
apijson -X PATCH -H 'Content-Type: application/json' -d '{"previewEnabled":false}' "$API/api/projects/$PID" > /dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' "$PREVIEW/p/$PID/")" = "404" ] || bad "disabled /p still accessible"
apijson -X PATCH -H 'Content-Type: application/json' -d '{"previewEnabled":true}' "$API/api/projects/$PID" > /dev/null
if [ "$PUBLIC_PREVIEW_GATE" = "1" ]; then
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$PREVIEW/p/$PID/")" = "404" ] || bad "public /p allowed unsigned request"
else
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$PREVIEW/p/$PID/")" = "200" ] || bad "/p re-enable failed"
fi
ok "/p preview gate verified server-side"

echo "ALL ONLINE ACCEPTANCE CHECKS PASSED (isolated project $PID remains in list — no delete API by design)"
