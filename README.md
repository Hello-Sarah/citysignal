# SF Bay Weekly · 三藩市 & 湾区周报

A weekly, source-verified events digest for one specific reader — delivered as a public web page
plus a scheduled email. Built on Google Apps Script + Google Sheets, zero infrastructure cost.

> 每周为一个具体的人整理一份**标注了可信度**的湾区活动清单，
> 自动生成公开网页 + 每周三定时邮件。

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
| `已核实` **Verified** | Confirmed by an official source — `.gov`, venue site, or organizer's own page |
| `场地已核实` **Venue verified** | Address confirmed real, but event details only appear on aggregators |
| `未核实` **Unverified** | No independent source found (typical for small community events) |

**Unverified entries are still published.** Dropping them would systematically filter out exactly
the community-organized events the reader most wants and can least easily find elsewhere.
The rule is: *keep the content, never fake the confidence.* The reader decides.

---

## What's here

| Path | |
|---|---|
| [`src/Code.gs`](src/Code.gs) | The whole application — ~300 lines of Apps Script (sanitized; fill in `CONFIG`) |
| [`docs/功能文档.md`](docs/功能文档.md) | Product spec, **testing & evaluation**, defect log |
| [`docs/技术文档.md`](docs/技术文档.md) | Architecture, design decisions, deployment, security |
| [`data/schema.md`](data/schema.md) | The 12-column data contract |
| [`data/sample_events.tsv`](data/sample_events.tsv) | Sanitized sample issue |
| [`tests/validate_data.py`](tests/validate_data.py) | Runnable data validator, 8 rule classes |
| [`tests/fixtures_bad.tsv`](tests/fixtures_bad.tsv) | 7 known-defect regression cases |

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
python3 tests/validate_data.py tests/fixtures_bad.tsv    # → 8 ERROR, exit 1
node --check <(cat src/Code.gs)                          # syntax check
```

The validator enforces 8 rule classes and also reports the **verification rate** per issue
(`已核实 / total`) — the closest thing this project has to an accuracy metric.

| Issue | Entries | Verified | Venue-verified | Unverified | Rate |
|---|---|---|---|---|---|
| 2026-08-26 | 33 | 17 | 12 | 4 | 52% |
| 2026-09-02 | 20 | 15 | 5 | 0 | 75% |

A lower rate isn't worse — issues with more community content are *structurally* less verifiable.
What matters is that unverified entries are labelled honestly and source conflicts are recorded.

Two of the regression fixtures encode **real production bugs**:
a `SubGroup == Title` case that printed every event title twice, and a WeChat ID in the `MapLink`
column that rendered a 404-bound button. Full defect log in the 功能文档.

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
