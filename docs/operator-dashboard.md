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

`dashboard-serve` binds to `127.0.0.1` and an ephemeral port by default. A wider bind is rejected unless `--allow-non-loopback` is explicit. The server has no authentication and is intended for trusted local use.

The OpenClaw and Hermes integration installers also install a Dashboard service on port `4174` and systemd gateway drop-ins. Starting `openclaw-gateway.service` or `hermes-gateway.service` therefore starts the read-only Dashboard. The default `localhost` mode binds only `127.0.0.1`. Optional `tailscale` mode resolves `tailscale ip -4` at install time and binds only that Tailnet address; it never binds `0.0.0.0`. Tailnet access is governed by Tailscale ACLs/Grants, while the Dashboard itself remains read-only and has no application-level login.

```bash
loop-engineering-dashboard-autostart-install --root /path/to/workspace
loop-engineering-dashboard-autostart-install --root /path/to/workspace --confirm-install
loop-engineering-dashboard-autostart-install --root /path/to/workspace --listen tailscale --confirm-install
```

To make the workspace follow either the OpenClaw or Hermes user gateway lifecycle, install the loopback-only systemd integration:

```sh
loop-engineering-dashboard-autostart-install --root /path/to/workspace
loop-engineering-dashboard-autostart-install --root /path/to/workspace --confirm-install
```

This creates `loop-engineering-dashboard.service` on fixed port `4174` and systemd drop-ins for `openclaw-gateway.service` and `hermes-gateway.service`. Starting either gateway pulls in the same idempotent dashboard service. Use `--listen localhost` (the default) for local-only access or `--listen tailscale` for Tailnet access. The Tailscale mode fails closed if it cannot resolve exactly one `100.x` IPv4 address. Restrict port `4174` with Tailnet ACLs/Grants when the Tailnet contains users or devices that should not see project metadata.

The platform installers expose the same choice as `--dashboard-listen localhost|tailscale` and accept `--tailscale-bin` when the CLI is outside `PATH`.

Endpoints are `GET /api/v1/overview`, `/api/v1/health`, `/api/v1/projects`, `/api/v1/projects/:id`, `/api/v1/todos`, `/api/v1/todos/:id`, and `/api/v1/actions`. Overview and todo lists support `q` and `state` filters. Private raw files are not served.

The browser workspace leads with projects rather than queue rows. A project card keeps milestone progress separate from terminal acceptance; project detail exposes the terminal outcome/rules, milestone acceptance, checkpoint revision lineage, human gates, reservations, acceptance reviews, and the independent final-judge event. Task workspaces are linked to a project only by explicit `checkpoint.project_id`, so the projection does not guess ownership from names. Unlinked tasks remain available in `task_workspaces` and the operational queue.

The interface is responsive down to a narrow phone viewport, keyboard-operable for project selection, dependency-free, and safe for static export. It remains deliberately read-only: there are no approve, retry, settle, resume, or mutation controls.

## Projection and security rules

The schema is versioned as `1.0.0` in `templates/operator-projection.schema.json`. P0 parked human/external gates, reminders/escalations and next wake metadata are normalized alongside P1 reservations/reconciliation and P2 typed todos, owners, fencing leases and handoffs. Existing queue/project artifacts are projected as version 1 inputs when no source version exists.

Operator states remain distinct: `runnable`, `active`, `parked`, `waiting_for_human`, `waiting_for_external_condition`, `timed_out_or_escalated`, `reconciliation_required`, `blocked`, `completed`, and `failed`. Unknown action outcomes and expired active leases become `reconciliation_required`; the dashboard never repairs them.

Malformed artifacts produce degraded health instead of crashing the overview. `freshness_seconds` derives from the newest projected timestamp. Reads retry once to tolerate atomic replacement and warn when the runtime directory changes during a projection.

Secret/token/password/credential/API/private-key/provider fields are recursively replaced with `[REDACTED]`. Evidence links are safe workspace-relative paths; no arbitrary file reader exists. HTML uses DOM `textContent`, API responses are JSON, path traversal is rejected, and restrictive response headers are enabled.
