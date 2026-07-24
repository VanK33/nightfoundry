# archives-mock Fixture

Static fixture archives used by `test/test-usage-all.js` and `test/test-cli-router.js`
to exercise cross-archive usage analysis, cache-efficiency verdicts, and `--since` filtering
without hitting the real runs directory.

## Archives

| Archive     | Date range  | Cache ratio target | cacheEfficiency verdict |
|-------------|-------------|-------------------|------------------------|
| 001-alpha   | 2026-01-01  | ≥ 3.0             | excellent              |
| 002-beta    | 2026-02-01  | [1.0, 3.0)        | healthy                |
| 003-gamma   | 2026-03-01  | [0.3, 1.0)        | marginal               |
| 004-delta   | 2026-04-01  | < 0.3             | wasteful               |

## Ratio calculation

`ratio = sum(cacheRead) / sum(cacheCreation)` across all sessions with non-zero cacheCreation.

- **001-alpha**: cacheRead=12000, cacheCreation=3000 → ratio=4.0 (excellent ≥ 3.0)
- **002-beta**: cacheRead=6000, cacheCreation=3000 → ratio=2.0 (healthy ∈ [1.0, 3.0))
- **003-gamma**: cacheRead=1500, cacheCreation=3000 → ratio=0.5 (marginal ∈ [0.3, 1.0))
- **004-delta**: cacheRead=600, cacheCreation=3000 → ratio=0.2 (wasteful < 0.3)

## Session roles

Each archive contains at least one session of each role: `planner`, `executor`, `verifier`.

## Timestamp spread

`startedAt` values span **2026-01-01 → 2026-04-01** (roughly one month apart per archive),
so `--since` cutoffs can be placed cleanly between archives in CLI router tests.

## Schema

Each `session-summary.json` is a JSON array of objects conforming to the on-disk
`SessionSummaryEntry` schema:

```json
{
  "name": "string",
  "role": "planner|executor|verifier",
  "inputTokens": 0,
  "outputTokens": 0,
  "cacheCreation": 0,
  "cacheRead": 0,
  "totalCost": 0.0,
  "toolCalls": 0,
  "durationMs": 0,
  "startedAt": "ISO 8601",
  "finishedAt": "ISO 8601"
}
```
