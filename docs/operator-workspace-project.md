# Operator workspace project contract

## Terminal outcome

An operator can use a local browser workspace every day to understand a Loop Engineering project's terminal contract, milestone progress and total-project status; trace checkpoint revisions, human gates, external-action reservations, acceptance reviews, and the independent final judge; and do so without granting the UI mutation authority or exposing raw/private artifacts.

No single page, milestone, checkpoint, or passing test subset completes this project. Completion requires every milestone below, the release checks, and an independent final judgement to pass together.

## Milestones

1. **Project projection and information architecture** — project-first projection, terminal/milestone separation, task linkage, revision and acceptance timeline, project detail API, responsive read-only workspace, security regression coverage, and operator documentation. Status: implemented and independently accepted.
2. **Daily interaction experience** — persistent URL filters and selection, accessible navigation/focus states, useful empty/error states, gate/reservation inspection, and responsive/accessibility assertions. Status: implemented and accepted.
3. **Release hardening** — schema compatibility, realistic large-workspace benchmark, live/static export tests, documentation, package dry run, full regression, and independent final judge. Status: implemented and accepted.

## Acceptance mapping

- Terminal contract, milestone and project status: milestone 1 projection/API/UI tests.
- Revision lineage and acceptance/final-judge timeline: milestone 1 task workspace fixtures.
- Human gates and external-action reservations: milestones 1–2 projection and inspection views.
- Safe read-only boundary: no mutation endpoints or controls; loopback default, explicit non-loopback override, redaction, XSS/path traversal checks.
- Information architecture, interaction and responsive UI: milestones 1–2.
- Tests, documentation and release-level acceptance: milestones 1–3.

## Explicit boundaries

The workspace does not approve gates, resume tasks, settle reservations, modify contracts, repair artifacts, or serve arbitrary evidence files. Those actions remain in governed CLI/control-plane workflows. A future authenticated mutation product would require a separate authority model and project contract.

## Project completion rule

The project reached its terminal acceptance candidate after all three milestones passed, all required checks were recorded, no required item remained unmet, and the independent 25-check final judgement returned `accept`. Milestone 1 acceptance was recorded only as a stage completion; project completion is based on the combined terminal evidence.
