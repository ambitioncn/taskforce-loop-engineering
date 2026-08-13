# Operator Dashboard and projection API

P3 provides a local-first, read-only view over durable Loop Engineering artifacts. It does not maintain a database, lock queue state, or write beneath `runtime/loops`. Every live request rebuilds a normalized projection; static export writes only to the explicitly selected output directory.

## Commands

```sh
loop-engineering dashboard-inspect --root /path/to/workspace --json
loop-engineering dashboard-inspect --state waiting_for_human --query approval --root /path/to/workspace --json
loop-engineering dashboard-health --max-age-seconds 3600 --root /path/to/workspace --json
loop-engineering dashboard-export --output-dir /tmp/loop-dashboard --root /path/to/workspace --json
loop-engineering dashboard-serve --root /path/to/workspace
```

`dashboard-serve` binds to `127.0.0.1` and an ephemeral port by default. A wider bind is rejected unless `--allow-non-loopback` is explicit. The server has no authentication and is intended for trusted local use. The CLI never starts it during checks or installation.

Endpoints are `GET /api/v1/overview`, `/api/v1/health`, `/api/v1/todos`, `/api/v1/todos/:id`, and `/api/v1/actions`. Overview and todo lists support `q` and `state` filters. Private raw files are not served.

## Projection and security rules

The schema is versioned as `1.0.0` in `templates/operator-projection.schema.json`. P0 parked human/external gates, reminders/escalations and next wake metadata are normalized alongside P1 reservations/reconciliation and P2 typed todos, owners, fencing leases and handoffs. Existing queue/project artifacts are projected as version 1 inputs when no source version exists.

Operator states remain distinct: `runnable`, `active`, `parked`, `waiting_for_human`, `waiting_for_external_condition`, `timed_out_or_escalated`, `reconciliation_required`, `blocked`, `completed`, and `failed`. Unknown action outcomes and expired active leases become `reconciliation_required`; the dashboard never repairs them.

Malformed artifacts produce degraded health instead of crashing the overview. `freshness_seconds` derives from the newest projected timestamp. Reads retry once to tolerate atomic replacement and warn when the runtime directory changes during a projection.

Secret/token/password/credential/API/private-key/provider fields are recursively replaced with `[REDACTED]`. Evidence links are safe workspace-relative paths; no arbitrary file reader exists. HTML uses DOM `textContent`, API responses are JSON, path traversal is rejected, and restrictive response headers are enabled.
