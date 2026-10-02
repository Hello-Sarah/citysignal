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

**Plus, in both cities, a `演唱会与展览` zone** (on top of the targets above), about 6–9 concerts + 4–5 exhibitions:
- `SubGroup` = `演唱会` (Category `音乐`) or `展览` (Category `展`).
- Concerts: notable shows from this week up to ~3 months ahead (arena/stadium pop incl. Cantopop/Mandopop/K-pop, a couple of mid-size venues, 1 classical). Also include big shows whose tickets **go on sale** in the next few weeks — put `｜MM.DD 10am開售` at the end of `DateInfo`. Mark `PriceInfo` as `已售罄` when sold out. Drop postponed/cancelled shows.
- Exhibitions: on view during this issue's week; skip ones already listed in the city zones. Note the closed weekday only if the official page says so.
- Keep long-running items from last issue if still relevant, but refresh their dates/status.
- Concert posters are usually text-heavy key visuals — don't use them; use an artist photo from the official page, or a Wikimedia Commons photo of the venue.

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
City	WeekId	Zone	SubGroup	Category	Title	DateInfo	Location	Status	PriceInfo	MapLink	Note	Pick	StartAt	EndAt	Image	ImageCredit	Link	LinkType
```

- Enum columns use the simplified spellings above; free text (Title, DateInfo, PriceInfo, Note) in Traditional Chinese.
- `MapLink` = `https://www.google.com/maps/search/?api=1&query=` + URL-encoded location.
- `Note` ends with the source domain, e.g. `sfmoma.org官方`, `info.gov.hk政府`, `2026日期僅聚合站有·funcheap`.
- `StartAt` / `EndAt` (local wall time): `2026-10-08 18:00` for timed events, `2026-10-09` for all-day; multi-day festivals use all-day start/end. Leave both empty for long-running exhibitions, restaurants and recurring markets. Unknown end time → leave `EndAt` empty (defaults to 2 h).
- `Link` / `LinkType`: the one link a reader should click — the ticket page, the registration/RSVP/reservation page, or the official event page if it is free walk-in. Only the organizer's / venue's / government's own site, or the official ticketing platform their site links to (Ticketmaster, AXS, organizer-run Eventbrite, SevenRooms/Resy/Tock, URBTIX, Cityline, HK Ticketing). Never aggregators. `LinkType` is one of `购票` (buy tickets), `报名` (register/RSVP), `预约` (free reservation), `订位` (restaurant booking), `官网` (info only). Every row should have a Link.
- `Image` / `ImageCredit`: the **official** page's share image (its `og:image`, or `twitter:image`) and the domain it came from, e.g. `sfmoma.org`. Only from the organizer's / venue's / government's own site — never from aggregators or news sites. Skip site-wide logos and generic brand graphics. Must be a real **photograph** (no logos, cartoons, icons or text-only posters). If the event has no usable photo, use a photo of the venue from its official site, or a Wikimedia Commons photo of the venue/area (direct `upload.wikimedia.org/.../1280px-...` URL, credit `commons.wikimedia.org`). Every row should have one; if truly nothing exists, leave both empty and the card simply shows no picture (there is no cartoon fallback).
- No tabs or newlines inside fields; no field may start with `=`, `+` or `@`.

## 5. Checks, then PR

```bash
python3 tests/validate_data.py data/issues/<WeekId>.tsv   # must be ERROR 0
node tests/render_test.js                                  # must pass
```

Branch `issue/<WeekId>`, commit only the new TSV, push, open a PR titled `Issue <WeekId>`. The PR body lists: counts and verification rate per city, the Picks, anything dropped and why, and one verification URL per row. Do not touch `src/`, tests or other data. Do not send email.
