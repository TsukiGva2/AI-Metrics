---
name: feedback
description: >
  Session Reflection & Friction Mapping. Analyzes the active pi session
  to classify architectural blockers into three categories (Context Fragmentation,
  State Brittleness, Missing Guardrails) and appends structured CSV rows to
  .pi/MAP.csv. Invoke via /feedback.
---

# Session Reflection & Friction Mapping

Analyses the current pi session's history and appends structured friction entries
to `.pi/MAP.csv`.

## Context Boundaries & Inputs

The session identity and usage metrics are obtained via the `session-info.ts`
extension tools at runtime. The agent must call these tools before generating CSV rows:

- `get_session_id` — Returns the session UUID and session file path.
- `usage_metrics` — Returns token counts (input, output, cache, total), cost
  (input, output, cache, total), context utilization, and model info.

## Analytical Engine Rules

Evaluate the session history and classify architectural blockers into exactly
**three categories**:

1. **Context Fragmentation**
   Excessive file hunting, parsing multiple directories to find basic
   implementations, or deep context bloating.

2. **State Brittleness**
   Tight coupling, recursive loops trying to fix cascading compilation/linter
   errors, or brittle testing states.

3. **Missing Guardrails**
   Opaque tool feedback, silent failures, or running tools with incorrect/brittle
   environment flags.

## Execution Constraints (Strict Formatting)

1. **Zero Conversational Text**
   Do not output any markdown headers, introductory text, greetings, or
   conclusions. Output *only* raw CSV rows.

2. **Scope column**
   Replace all file/directory references with a single capitalized module name
   — the business domain or logical module that best captures the affected
   area. Never use file paths, globs, or comma-separated lists.

   Optionally append a parenthetical sub-scope for granularity, used sparingly:
   `Checkout(tests)` when the friction is specifically about test code,
   `Checkout(db)` when it's about schema/migrations, etc.

   - GOOD: `Checkout`, `Checkout(tests)`, `Checkout(db)`
   - BAD: `checkout/`, `controllers/checkout/checkout.go`, `api_checkout_*_test.go`

3. **Apportioning Logic**
   Subjectively divide the cognitive effort spent across the session into
   relative integers representing percentages (e.g., 70, 30). The sum of the
   `Effort_Percentage` column across all rows generated for a single feedback
   loop **must equal exactly 100**.

## Target CSV Schema

Append new entries to the root file `.pi/MAP.csv` matching this exact layout:

```
session_id | friction_category | scope | effort_pct | diagnosis | tokens_in | tokens_out | tokens_total | cost_total | model_provider | model_id | timestamp
```

### Example Output

```
a1b2c3d4-e5f6-7a8b | State Brittleness | Checkout | 70 | Tests failed repeatedly due to structural spaghetti coupling inside the controller macros. | 48200 | 15200 | 63400 | 0.0842 | anthropic | claude-sonnet-4-20250514 | 2026-06-06T02:20:29.800Z
a1b2c3d4-e5f6-7a8b | Context Fragmentation | Checkout(queries) | 30 | Spent 30 percent of session token budget running grep commands due to stripped down busybox tool flags. | 48200 | 15200 | 63400 | 0.0842 | anthropic | claude-sonnet-4-20250514 | 2026-06-06T02:20:29.800Z
```

## Execution

When the user invokes `/feedback` (or `/skill:feedback`):

1. Read the session history and any available context from the active session.
2. Call **`get_session_id`** to obtain the session UUID.
3. Call **`usage_metrics`** to obtain token counts (input, output, total), cost
   (total), and model info (provider, id). Record these values for the CSV rows.
4. Apply the analytical engine rules above to classify blockers.
5. Apportion effort percentages summing to exactly 100.
6. Derive the timestamp from the session UUID obtained in step 2. The session
   IDs are **UUID v7**, which embed a 48-bit big-endian Unix epoch milliseconds
   timestamp in the first 12 hex characters. Decode it with:

   ```bash
   python3 -c "
   import datetime
   u = '$SESSION_UUID'
   hex_ts = u.replace('-', '')[:12]
   epoch_ms = int(hex_ts, 16)
   dt = datetime.datetime.fromtimestamp(epoch_ms / 1000, tz=datetime.timezone.utc)
   print(dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{epoch_ms % 1000:03d}Z')
   "
   ```

7. Append the resulting CSV rows (one per friction category identified) to
   `.pi/MAP.csv` using the **edit** tool. Each row must include all 12 columns
   from the schema above, filled with the values obtained in steps 2, 6, and 3.
8. If `.pi/MAP.csv` does not exist yet, create it with a header row first.
