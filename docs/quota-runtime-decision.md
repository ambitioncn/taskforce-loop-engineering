# Quota runtime decision engine

Quota is a runtime policy decision, not only a static credit check. Import `decideQuota` from `taskforce-loop-engineering/quota` and provide `limits`, already-recorded `spend`, the next slice `request`, work/error/external state, and optional lanes.

The result always chooses one of `execute`, `wait`, `ask`, `self-repair`, or `silent` and includes a scheduler hint. Budget vectors use `tokens`, `time_ms`, `money_minor`, and `rounds`.

`recordVerifiedSliceSpend` records spend only when a slice is both `completed` and `verified`. Idle, waiting, failed, or partially completed attempts record nothing. `slice_id` makes recording idempotent.

A lane waiting for a human may fall back only to a different lane marked both `safe_fallback: true` and `audited: true`; otherwise the decision is `ask`.
