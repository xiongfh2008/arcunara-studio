#!/usr/bin/env bash
#
# Arcunara Studio — one-shot VPS deploy for the ISOLATED v0.3.0 test stack.
#
# Runs ON the VPS (invoke via ssh). Touches ONLY:
#   - directory /opt/arcunara-studio-v03-test
#   - compose project "arcunara-studio-v03-test"
#   - container    "arcunara-studio-api-v03-test"
# It NEVER stops/rebuilds/prunes anything else (no `down -v`, no
# `docker system prune`), never touches the v0.2.0 stack on 18088/18089 or
# any other project on the host.
#
# Usage:
#   DEPLOY_SHA=<40-hex commit sha> bash deploy-vps.sh
#
# Flow: pre-checks -> image/backup snapshot -> pure-source build context
# (git archive of the pinned commit; data/token/.env can never be inside) ->
# immutable image tag -> replace only the test container -> acceptance ->
# automatic rollback to the snapshotted image if acceptance fails.

set -uo pipefail

DEPLOY_SHA="${DEPLOY_SHA:-}"
TARGET_DIR="/opt/arcunara-studio-v03-test"
COMPOSE_PROJECT="arcunara-studio-v03-test"
CONTAINER="arcunara-studio-api-v03-test"
COMPOSE_FILE="$TARGET_DIR/infra/docker/compose.yaml"
DATA_DIR="$TARGET_DIR/infra/docker/data"
TOKEN_FILE="$TARGET_DIR/infra/docker/secrets/api_token"
BACKUP_ROOT="$TARGET_DIR/backups"
API="http://127.0.0.1:28088"
PREVIEW="http://127.0.0.1:28089"
LEGACY="http://127.0.0.1:18088"
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$BACKUP_ROOT/deploy-$TS.log"

mkdir -p "$BACKUP_ROOT"
exec > >(tee -a "$LOG_FILE") 2>&1

STEP=0
step() { STEP=$((STEP+1)); echo; echo "===== [$STEP] $* ====="; }
fail() { echo "!!!! DEPLOY ABORTED: $*" >&2; exit 1; }

echo "Arcunara Studio VPS deploy — $(date -u +%FT%TZ)"
echo "Target: $TARGET_DIR (project $COMPOSE_PROJECT / container $CONTAINER)"

# ---------------------------------------------------------------- pre-checks
step "Resolve deploy commit"
[ -n "$DEPLOY_SHA" ] || fail "DEPLOY_SHA is required (CI-verified commit)"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "DEPLOY_SHA must be a 40-hex sha, got '$DEPLOY_SHA'"
echo "Deploy commit: $DEPLOY_SHA"

step "SSH target directory"
[ -d "$TARGET_DIR" ] || fail "target dir missing: $TARGET_DIR"
[ -f "$COMPOSE_FILE" ] || fail "compose file missing: $COMPOSE_FILE"
[ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ] || fail "data dir missing or empty: $DATA_DIR"
[ -s "$TOKEN_FILE" ] || fail "token file missing or empty: $TOKEN_FILE"
echo "directory, compose file, data and token all present"

step "Git repository state"
cd "$TARGET_DIR" || fail "cannot cd into $TARGET_DIR"
BEFORE_GIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
git fetch origin main || fail "git fetch failed"
git cat-file -e "$DEPLOY_SHA^{commit}" || fail "commit $DEPLOY_SHA not found after fetch"
git merge-base --is-ancestor "$DEPLOY_SHA" origin/main || fail "commit $DEPLOY_SHA is not on origin/main"
echo "VPS repo HEAD before: $BEFORE_GIT"

step "Target container belongs to the pinned compose project and is healthy"
CT_PROJECT="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}')" \
  || fail "container $CONTAINER not found"
[ "$CT_PROJECT" = "$COMPOSE_PROJECT" ] || fail "container belongs to project '$CT_PROJECT', expected '$COMPOSE_PROJECT'"
CT_HEALTH="$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}')"
[ "$CT_HEALTH" = "healthy" ] || fail "container health is '$CT_HEALTH', expected healthy"
BEFORE_IMAGE_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
echo "project ok, health ok, current image: $BEFORE_IMAGE_ID"

step "Compose configuration is valid"
docker compose -f "$COMPOSE_FILE" config -q || fail "docker compose config invalid"
echo "compose config OK"

step "Current services healthy (v0.2.0 must keep working)"
LEGACY_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$LEGACY/health")"
[ "$LEGACY_CODE" = "200" ] || fail "v0.2.0 health on $LEGACY returned $LEGACY_CODE"
BEFORE_HEALTH="$(curl -s --max-time 5 "$API/health")"
echo "$BEFORE_HEALTH" | grep -q '"ok":true' || fail "target API unhealthy before deploy: $BEFORE_HEALTH"
echo "v0.2.0 ($LEGACY): $LEGACY_CODE, target: $BEFORE_HEALTH"

step "Disk space"
AVAILABLE_KB="$(df -Pk / | awk 'NR==2 {print $4}')"
[ "$AVAILABLE_KB" -gt 2097152 ] || fail "less than 2 GiB free ($(du -m "$DATA_DIR" | cut -f1) MiB data; free ${AVAILABLE_KB} KiB)"
echo "free: $((AVAILABLE_KB/1024)) MiB"

step "Backup directory writable"
BACKUP_DIR="$BACKUP_ROOT/$TS"
mkdir -p "$BACKUP_DIR" || fail "cannot create $BACKUP_DIR"
touch "$BACKUP_DIR/.w" && rm "$BACKUP_DIR/.w" || fail "backup dir not writable"
echo "backup dir: $BACKUP_DIR"

step "Snapshot running containers (untouched-set for later comparison)"
docker ps --format '{{.Names}}' | sort > "$BACKUP_DIR/containers-before.txt"
echo "$(wc -l < "$BACKUP_DIR/containers-before.txt") containers running before deploy"

step "Snapshot current project state (read-only, for the record)"
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
[ -n "$TOKEN" ] || fail "token empty"
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/projects" > "$BACKUP_DIR/projects-before.json"
BEFORE_COUNT="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["projects"]))' "$BACKUP_DIR/projects-before.json" 2>/dev/null || echo '?')"
echo "projects before deploy: $BEFORE_COUNT -> $BACKUP_DIR/projects-before.json"

step "Data + token backup (timestamped, verified)"
tar -czf "$BACKUP_DIR/data.tar.gz" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" \
  || fail "data backup failed"
cp "$TOKEN_FILE" "$BACKUP_DIR/api_token" || fail "token backup failed"
chmod 600 "$BACKUP_DIR/api_token"
[ -s "$BACKUP_DIR/data.tar.gz" ] || fail "data backup empty"
[ -s "$BACKUP_DIR/api_token" ] || fail "token backup empty"
tar -tzf "$BACKUP_DIR/data.tar.gz" | head -3 > "$BACKUP_DIR/data-backup-listing.txt"
echo "backup verified: $(du -h "$BACKUP_DIR/data.tar.gz" | cut -f1), entries:"
cat "$BACKUP_DIR/data-backup-listing.txt"

step "Pin the currently running image for rollback"
ROLLBACK_TAG="arcunara-studio:rollback-$TS"
docker tag "$BEFORE_IMAGE_ID" "$ROLLBACK_TAG" || fail "cannot tag rollback image"
echo "rollback image: $ROLLBACK_TAG ($BEFORE_IMAGE_ID)"
echo "$ROLLBACK_TAG" > "$BACKUP_DIR/rollback-tag.txt"

# ------------------------------------------------------------------- build
step "Pure-source build context from the pinned commit (git archive)"
BUILD_DIR="/tmp/arcunara-build-$TS"
mkdir -p "$BUILD_DIR/src"
git archive "$DEPLOY_SHA" | tar -x -C "$BUILD_DIR/src" || fail "git archive failed"
echo "context: $BUILD_DIR/src ($(find "$BUILD_DIR/src" -type f | wc -l) files)"

step "Verify no secrets/data/.env in the build context"
if find "$BUILD_DIR/src" \( -name 'api_token' -o -name '.env' -o -name '*.env' \) -print | grep -q .; then
  fail "token/.env file found in build context"
fi
[ ! -d "$BUILD_DIR/src/infra/docker/data" ] || fail "data directory found in build context"
[ ! -d "$BUILD_DIR/src/infra/docker/secrets" ] || fail "secrets directory found in build context"
echo "context clean (git-tracked sources only)"

step "Build immutable image"
IMAGE_TAG="arcunara-studio:0.3.0-${DEPLOY_SHA:0:7}"
docker build -f "$BUILD_DIR/src/infra/docker/Dockerfile" -t "$IMAGE_TAG" "$BUILD_DIR/src" \
  || fail "image build failed"
IMAGE_ID="$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')"
echo "built: $IMAGE_TAG ($IMAGE_ID)"

step "Check out the pinned commit in the VPS repository (tracked files only; data/token are gitignored)"
DIRTY="$(git status --porcelain --untracked-files=no)"
[ -z "$DIRTY" ] || fail "VPS repo has uncommitted tracked changes — refusing to checkout:\n$DIRTY"
git checkout --detach "$DEPLOY_SHA" || fail "git checkout failed"
echo "VPS repo HEAD now: $(git rev-parse HEAD)"

# ----------------------------------------------------------------- replace
rollback() {
  echo
  echo "!!!! DEPLOY FAILURE: $*"
  echo "$*" > "$BACKUP_DIR/acceptance-failure.txt"
  echo "----- automatic rollback to $ROLLBACK_TAG -----"
  cat > "$BACKUP_DIR/compose-rollback-override.yaml" <<EOF
services:
  api:
    image: $ROLLBACK_TAG
    build:
      context: $BUILD_DIR/src
      dockerfile: infra/docker/Dockerfile
EOF
  docker compose -f "$COMPOSE_FILE" -f "$BACKUP_DIR/compose-rollback-override.yaml" up -d --no-deps --no-build api \
    || { echo "!!!! rollback compose up FAILED — manual intervention required"; exit 2; }
  ROK=""
  for i in $(seq 1 30); do
    H="$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)"
    [ "$H" = "healthy" ] && { ROK=1; break; }
    sleep 2
  done
  [ -n "$ROK" ] || { echo "!!!! rolled-back container still not healthy — manual intervention required"; exit 2; }
  RH="$(curl -s --max-time 5 "$API/health")"
  echo "$RH" | grep -q '"ok":true' || { echo "!!!! rolled-back health bad: $RH"; exit 2; }
  RC="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" --max-time 5 "$API/api/limits")"
  [ "$RC" = "200" ] || { echo "!!!! rolled-back token auth bad: $RC"; exit 2; }
  echo "rollback verified: healthy, token valid, data untouched"
  echo "failure log: $LOG_FILE"
  exit 1
}

step "Write compose override (image pin + pure-source build context)"
OVERRIDE_FILE="$BUILD_DIR/compose-deploy-override.yaml"
cat > "$OVERRIDE_FILE" <<EOF
services:
  api:
    image: $IMAGE_TAG
    build:
      context: $BUILD_DIR/src
      dockerfile: infra/docker/Dockerfile
EOF
docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" config -q || fail "merged compose config invalid"

step "Replace only the pinned test container"
docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" up -d --no-deps --no-build api \
  || rollback "compose up -d failed"

step "Wait for container health"
OK=""
for i in $(seq 1 30); do
  H="$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)"
  if [ "$H" = "healthy" ]; then OK=1; break; fi
  sleep 2
done
[ -n "$OK" ] || rollback "container not healthy 60s after replacement"

# -------------------------------------------------------------- acceptance
step "Acceptance: health, image identity, token, data, previews, isolation"
RUNNING_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
[ "$RUNNING_ID" = "$IMAGE_ID" ] || rollback "running image $RUNNING_ID != built $IMAGE_ID"

H="$(curl -s --max-time 5 "$API/health")"
echo "$H" | grep -q '"ok":true' || rollback "health: $H"

CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" --max-time 5 "$API/api/limits")"
[ "$CODE" = "200" ] || rollback "token auth failed ($CODE)"

curl -s -H "Authorization: Bearer $TOKEN" "$API/api/projects" > "$BACKUP_DIR/projects-after.json"
AFTER_COUNT="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["projects"]))' "$BACKUP_DIR/projects-after.json" 2>/dev/null || echo '?')"
[ "$AFTER_COUNT" = "$BEFORE_COUNT" ] || rollback "project count changed: $BEFORE_COUNT -> $AFTER_COUNT"
echo "projects preserved: $AFTER_COUNT"

# RC5 API wiring + per-project read-only preview checks (enabled -> 200,
# disabled -> 404) on the CURRENT version entry.
python3 - "$BACKUP_DIR/projects-after.json" "$PREVIEW" "$API" "$TOKEN" <<'PYEOF' || rollback "preview/API checks failed (see log)"
import json, sys, urllib.request

projects, preview_base, api_base, token = json.load(open(sys.argv[1]))["projects"], sys.argv[2], sys.argv[3], sys.argv[4]

def get(url, auth=False):
    req = urllib.request.Request(url)
    if auth:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return None, str(e)

assert len(projects) > 0, "no projects"
checked = 0
for p in projects:
    pid = p["id"]
    st, body = get(f"{api_base}/api/projects/{pid}", auth=True)
    assert st == 200, f"detail {pid}: {st}"
    detail = json.loads(body)
    assert "previewEnabled" in detail, f"RC5 field missing on {pid}"
    st, _ = get(f"{api_base}/api/projects/{pid}/shares", auth=True)
    assert st == 200, f"shares list {pid}: {st}"
    st, _ = get(f"{preview_base}/p/{pid}/")
    if detail.get("previewEnabled", True):
        assert st == 200, f"preview of enabled project {pid}: {st}"
    else:
        assert st == 404, f"disabled project {pid} preview must 404, got {st}"
    checked += 1
print(f"RC5 detail/shares/preview checks passed for {checked} project(s)")

# Share route wired: unknown token -> 404 (not 500/redirect)
st, _ = get(f"{preview_base}/s/0123456789abcdef/{'A'*43}/")
assert st == 404, f"unknown share token should 404, got {st}"
print("share route wired (unknown token -> 404)")
PYEOF

# Loopback-only bindings
ss -tln | grep -E ':28088|:28089' | grep -vq '127.0.0.1:2808[89]' && rollback "28088/28089 not loopback-only"
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$LEGACY/health")" = "200" ] || rollback "v0.2.0 degraded"
echo "loopback bindings + v0.2.0 OK"

# Untouched set
docker ps --format '{{.Names}}' | sort > "$BACKUP_DIR/containers-after.txt"
MISSING="$(comm -23 "$BACKUP_DIR/containers-before.txt" "$BACKUP_DIR/containers-after.txt")"
[ -z "$MISSING" ] || rollback "containers disappeared: $MISSING"
echo "all $(wc -l < "$BACKUP_DIR/containers-after.txt") pre-existing containers still running"

step "Deploy SUCCESS"
echo "image:    $IMAGE_TAG ($IMAGE_ID)"
echo "backup:   $BACKUP_DIR"
echo "rollback: docker compose -f $COMPOSE_FILE up -d (after tagging) or image $ROLLBACK_TAG"
rm -rf "$BUILD_DIR"
exit 0
