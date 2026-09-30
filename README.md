# CitySignal · Local Events Digest

A weekly, source-verified events digest for one specific reader — delivered as a public web page
plus a scheduled email. Built on Google Apps Script + Google Sheets, zero infrastructure cost.

> Every week, a hand-curated list of local events for one specific person, each **labelled with
> how far it can be trusted** — published automatically as a public web page plus a Wednesday email.

---

## The problem it actually solves

Event aggregators give you hundreds of listings a week with **no signal about which ones are real**.
An officially confirmed music festival and a third-hand forward from a WeChat group sit side by side.
That gap matters most for Chinese-community events in the Bay Area, which often exist only on
Xiaohongshu (RED) or in group chats, with no official page anywhere.

**This project's answer is not "aggregate more" — it's "label what you can trust."**

Every entry carries one of three verification levels:

| Badge | Criterion |
|---|---|
| **Verified** | Confirmed by an official source — `.gov`, venue site, or organizer's own page |
| **Venue verified** | Address confirmed real, but event details only appear on aggregators |
| **Unverified** | No independent source found (typical for small community events) |

**Unverified entries are still published.** Dropping them would systematically filter out exactly
the community-organized events the reader most wants and can least easily find elsewhere.
The rule is: *keep the content, never fake the confidence.* The reader decides.

---

## What's here

| Path | |
|---|---|
| [`src/Code.gs`](src/Code.gs) | The whole application — ~300 lines of Apps Script (sanitized; fill in `CONFIG`) |
| [Product spec](docs/%E5%8A%9F%E8%83%BD%E6%96%87%E6%A1%A3.md) | Product spec, **testing & evaluation**, defect log |
| [Technical design](docs/%E6%8A%80%E6%9C%AF%E6%96%87%E6%A1%A3.md) | Architecture, design decisions, deployment, security |
| [`data/schema.md`](data/schema.md) | The 12-column data contract |
| [`data/sample_events.tsv`](data/sample_events.tsv) | Sanitized sample issue |
| [`tests/validate_data.py`](tests/validate_data.py) | Runnable data validator, 10 rule classes |
| [`tests/fixtures_bad.tsv`](tests/fixtures_bad.tsv) | 9 known-defect regression cases |
| [`tests/render_test.js`](tests/render_test.js) | Node snapshot tests for rendering and mail routing, 21 assertions |

---

## Architecture

```
Editor ──weekly──► Google Sheet (Events tab, 12 cols)
                          │
                          ▼
                  Apps Script (Code.gs)
                    ├─ doGet()          → server-rendered HTML → public /exec page
                    └─ sendWeeklyEmail() → GmailApp → reader's inbox (Wed 09:00)
```

No database, no frontend framework, no third-party email service, no server.
The Sheet *is* the CMS; mail is sent from the author's own Google account so recipient
addresses never leave the author's control.

**Why Apps Script:** Netlify/Vercel can't do persistent content updates or scheduled mail;
a custom backend is wildly over-engineered for ~20 rows a week; SendGrid-style services would
require handing recipient emails to a third party, which the author explicitly ruled out.
Trade-off accepted: Google lock-in and a poor local dev story.

---

## Testing & evaluation

Run the validator:

```bash
python3 tests/validate_data.py data/sample_events.tsv    # → exit 0
python3 tests/validate_data.py tests/fixtures_bad.tsv    # → 10 ERROR, exit 1
node tests/render_test.js                                # → 21 passed, exit 0
```

The validator enforces 8 rule classes and also reports the **verification rate** per issue
(`verified / total`) — the closest thing this project has to an accuracy metric.

| Issue | Entries | Verified | Venue-verified | Unverified | Rate |
|---|---|---|---|---|---|
| 2026-08-26 | 33 | 17 | 12 | 4 | 52% |
| 2026-09-02 | 31 | 23 | 6 | 2 | 74% |

A lower rate isn't worse — issues with more community content are *structurally* less verifiable.
What matters is that unverified entries are labelled honestly and source conflicts are recorded.

Two of the regression fixtures encode **real production bugs**:
a `SubGroup == Title` case that printed every event title twice, and a WeChat ID in the `MapLink`
column that rendered a 404-bound button. Full defect log in the [product spec](docs/%E5%8A%9F%E8%83%BD%E6%96%87%E6%A1%A3.md).

---

## Setup

1. Create a Google Sheet, rename the first tab to `Events`, paste the 12 headers from
   [`data/schema.md`](data/schema.md)
2. Extensions → Apps Script, paste [`src/Code.gs`](src/Code.gs)
3. Fill in `CONFIG`: `SHEET_ID` and `RECIPIENT_EMAILS`
4. Deploy → New deployment → **Web app**, run as **Me**, access **Anyone**
5. Run `createWeeklyTrigger()` once (it will ask for one extra scope, `script.scriptapp`)

⚠️ **Two different paths to production.** Trigger code takes effect on save (triggers run HEAD).
The web page does **not** — you must publish a new version:
Deploy → Manage deployments → edit → Version: *New version* → Deploy.

---

## Known limitation

Xiaohongshu (RED) content can't be collected automatically — anti-scraping, `robots.txt`,
no compliant public API. So event *discovery* for community content stays manual: a person
forwards links. Automation covers everything after that — verification, structuring, ingestion,
publishing. That boundary is deliberate; working around a site's anti-scraping measures would be
neither reliable nor appropriate.

---

## License

MIT — see [LICENSE](LICENSE).
