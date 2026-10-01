# Weekly issue routine

This is the runbook the scheduled cloud task follows every Monday. A human approves each issue by merging its PR; nothing is published without that merge.

```
Mon (cloud task)  research + verify → data/issues/<WeekId>.tsv → PR "Issue <WeekId>"
Mon–Wed (editor)  review the PR on GitHub → Merge (= approve) or close (= skip the week)
Wed (Apps Script) sendWeeklyEmail(): import merged issues dated <= today → send each new issue once
```

## 1. Which week

- `WeekId` = the **next Wednesday** after the run date (Asia/Hong_Kong). Example: run on Mon 2026-10-05 → `2026-10-07`.
- Coverage window: events a reader can attend from `WeekId` through `WeekId + 11 days`, focus on the first 7.
- If `data/issues/<WeekId>.tsv` already exists on `main` or an open PR for it exists, stop and report.

## 2. Research — both cities

| City (`City` value) | Zones (`Zone`) | Target size |
|---|---|---|
| `三藩市湾区` | `三藩市市内` (~10–13), `湾区市外` (~4–6), `华人社群活动` (0–3, only with a checkable source) | 14–20 |
| `香港` | `港岛`, `九龙`, `新界` | 9–14 |

SubGroup / Category rules are in [`data/schema.md`](../data/schema.md). The SF reader likes food, new restaurant openings and markets; exhibitions and art; geeky / science / tech events. Mark 3–5 SF entries with `★` in `Pick`. Leave `Pick` empty for Hong Kong.

Do not repeat long-running items from the previous issue unless they close within the window (say so in `Note`).

## 3. Verification (the core of the product)

Open the source page and read the 2026 date yourself before assigning a status.

| `Status` | Meaning |
|---|---|
| `已核实` | Date confirmed on an official source: `.gov` / gov.hk, venue site, organizer site or its own ticketing page |
| `场地已核实` | Venue is real; event details only on aggregators or news round-ups |
| `未核实` | No independent source found — still publish, never fake the confidence |

Drop anything whose 2026 date cannot be confirmed anywhere. Known-good HK sources: info.gov.hk, lcsd.gov.hk, cpo.gov.hk, hk.heritage.museum, hkpm.org.hk, hk.space.museum, filmarchive.gov.hk, had.gov.hk. M+ and Tai Kwun block fetching.

## 4. Writing the file

`data/issues/<WeekId>.tsv`, UTF-8, tab-separated, this exact header:

```
City	WeekId	Zone	SubGroup	Category	Title	DateInfo	Location	Status	PriceInfo	MapLink	Note	Pick	StartAt	EndAt	Image	ImageCredit
```

- Enum columns use the simplified spellings above; free text (Title, DateInfo, PriceInfo, Note) in Traditional Chinese.
- `MapLink` = `https://www.google.com/maps/search/?api=1&query=` + URL-encoded location.
- `Note` ends with the source domain, e.g. `sfmoma.org官方`, `info.gov.hk政府`, `2026日期僅聚合站有·funcheap`.
- `StartAt` / `EndAt` (local wall time): `2026-10-08 18:00` for timed events, `2026-10-09` for all-day; multi-day festivals use all-day start/end. Leave both empty for long-running exhibitions, restaurants and recurring markets. Unknown end time → leave `EndAt` empty (defaults to 2 h).
- `Image` / `ImageCredit`: the **official** page's share image (its `og:image`, or `twitter:image`) and the domain it came from, e.g. `sfmoma.org`. Only from the organizer's / venue's / government's own site — never from aggregators or news sites. Skip site-wide logos and generic brand graphics. No suitable image → leave both empty; the page draws a category illustration instead.
- No tabs or newlines inside fields; no field may start with `=`, `+` or `@`.

## 5. Checks, then PR

```bash
python3 tests/validate_data.py data/issues/<WeekId>.tsv   # must be ERROR 0
node tests/render_test.js                                  # must pass
```

Branch `issue/<WeekId>`, commit only the new TSV, push, open a PR titled `Issue <WeekId>`. The PR body lists: counts and verification rate per city, the Picks, anything dropped and why, and one verification URL per row. Do not touch `src/`, tests or other data. Do not send email.
