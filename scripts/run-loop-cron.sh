#!/usr/bin/env bash
set -euo pipefail

WORKDIR="${LOOP_WORKDIR:-$(pwd)}"
CONFIG="${1:-}"
LOG_DIR="${LOOP_LOG_DIR:-$WORKDIR/logs}"
SEND_CMD="${LOOP_ALERT_COMMAND:-}"

if [[ -z "$CONFIG" ]]; then
  echo "Usage: run-loop-cron.sh <loop-config.json>" >&2
  exit 2
fi

mkdir -p "$LOG_DIR"
cd "$WORKDIR"

# LOOP_ALERT_COMMAND may include arguments ("openclaw message send --target x");
# the message is passed as one extra argument, never interpolated.
alert() {
  local message="$1" log="$2"
  if [[ -n "$SEND_CMD" ]]; then
    if ! sh -c "$SEND_CMD \"\$1\"" loop-alert "$message"; then
      printf '[%s] alert command failed: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$SEND_CMD" >> "$log"
    fi
  else
    printf '%s\n' "$message" >&2
  fi
}

if ! loop_id="$(node -e '
const fs = require("fs");
const config = process.argv[1];
try {
  const spec = JSON.parse(fs.readFileSync(config, "utf8"));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(spec.id || "")) process.exit(2);
  process.stdout.write(spec.id);
} catch {
  process.exit(2);
}
' "$CONFIG")"; then
  stamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  log_file="$LOG_DIR/loop-cron-invalid-config.log"
  printf '[%s] %s: unreadable config or invalid id\n' "$stamp" "$CONFIG" >> "$log_file"
  alert "Loop escalation ($stamp): $CONFIG is unreadable or has an invalid id; the loop did not run." "$log_file"
  exit 2
fi

stamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
log_file="$LOG_DIR/loop-cron-${loop_id}.log"
tmp_out="$(mktemp)"
exit_code=0

if loop-engineering run --config "$CONFIG" --root "$WORKDIR" > "$tmp_out" 2>&1; then
  exit_code=0
else
  exit_code=$?
fi

{
  printf '[%s] %s exit=%s\n' "$stamp" "$loop_id" "$exit_code"
  sed -n '1,80p' "$tmp_out"
  printf '\n'
} >> "$log_file"

if [[ "$exit_code" == "0" ]]; then
  rm -f "$tmp_out"
  exit 0
fi

summary="$(node -e '
const fs = require("fs");
const path = require("path");
const loopId = process.argv[1];
const dir = path.join("runtime", "loops", loopId, "runs");
let latest = null;
try {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (files.length > 0) {
    const file = path.join(dir, files[files.length - 1]);
    const run = JSON.parse(fs.readFileSync(file, "utf8"));
    const failed = Array.isArray(run.checks)
      ? run.checks.filter((check) => !check.ok).map((check) => check.id).join(", ")
      : "";
    latest = [
      `outcome=${run.outcome || "unknown"}`,
      `reason=${run.breaker?.reason || run.runtimeError || "runner failed"}`,
      failed ? `failed_checks=${failed}` : null,
      `run=${run.runPath || file}`
    ].filter(Boolean).join("; ");
  }
} catch {}
process.stdout.write(latest || "runner failed before writing a run artifact");
' "$loop_id")"

message="Loop escalation ($stamp): $loop_id exit=$exit_code. $summary"
alert "$message" "$log_file"

rm -f "$tmp_out"
exit "$exit_code"
