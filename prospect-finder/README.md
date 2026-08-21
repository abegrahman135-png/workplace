# ProspectFinder v2

Chrome MV3 extension that harvests Instagram follower/following lists, enriches
each profile, scores it, and presents the result in a fast filterable dashboard.

v2 is a full rewrite. See [`../PROSPECT_FINDER_REBUILD_PLAN.md`](../PROSPECT_FINDER_REBUILD_PLAN.md)
for the A–Z plan and rationale.

---

## The bug this rewrite exists to fix

v1 scanned 500+ profiles but the dashboard showed ~10.

Three independent causes, all fixed and now covered by tests:

| # | Cause | Fix |
|---|---|---|
| **P0-1** | Prospects, jobs and the processed-set were written in *separate* transactions. A failure between them left profiles scanned but unqueued and invisible. | `ingestBatch()` writes all three stores in **one** transaction over `[prospects, jobs, processedUsernames]`. |
| **P0-2** | The queue pump only ran while the popup was open; the MV3 service worker slept and jobs stalled mid-flight forever. | `chrome.alarms` pump every 60 s + a **90 s job lease** so a dead worker's claims are reclaimed. |
| **P0-3** | Profiles failing classification were dropped at scan time. | Nothing is ever dropped. Low-confidence rows land in `review`, never deleted. Enforced by test. |

`tests/integration/fixture_ingest.test.js` asserts conservation directly:
`inserted + merged + rejected === seen`, for 500 real fixtures and for
deliberately malformed input.

---

## Install (unpacked)

```bash
npm install
npm test
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this directory
4. Open an Instagram profile, click the toolbar icon, press **Start**

Requires Chrome 116+.

---

## Dashboard preview (no Chrome, no extension)

The dashboard runs standalone against a seeded in-memory database, so you can
work on UI without scraping anything:

```bash
npm run preview      # then open http://localhost:8080/dev/preview.html
```

`dev/seed.js` shims the `chrome.*` APIs and seeds **520 demo prospects** through
the *real* scoring, classifier and search modules — every filter, sort, tab and
action runs production code. A background interval drains the job queue so the
pipeline bar animates like a live run.

> Must be served over HTTP. ES modules and `fetch()` of `public/data/names.json`
> do not work from `file://`.

---

## Architecture

```
content/index.js ──port "harvest-stream"──▶ background/ingest.js
   scrolls list, taps XHR/fetch                one tx: prospects+jobs+processed
   sends FOLLOWER_BATCH + cursor                        │
   replays on BATCH_NACK                                ▼
                                            background/scheduler.js
                                            alarm pump, 90s leases, lanes
                                                        │
                                                        ▼
                                            background/enricher.js
                                            fetch profile → classify → score
                                                        │
                                              BroadcastChannel('pf-data')
                                                        ▼
                                                    ui/app.js
                                            IndexedDB-backed query, virtual grid
```

| Directory | Role |
|---|---|
| `src/lib/` | `Result`, constants, logger, utils |
| `src/db/` | Schema, migrations, per-store repos |
| `src/engines/` | Classifier, scoring, qualification, dedup |
| `src/search/` | Text index, predicates, query planner, saved views |
| `src/background/` | Ingest, scheduler, enricher, rate limiter, stats |
| `src/content/` | Instagram harvester (classic script, no imports) |
| `src/ui/` | Dashboard, popup, offscreen document |
| `public/` | MAIN-world interceptor, name dictionary, icons |

### Data flow guarantees

- **Forward-only.** Nothing is deleted; `stage` advances
  `discovered → queued → enriching → scored`, with `failed`/`dead` as retryable
  side states.
- **Idempotent ingest.** Re-scanning a list merges (appending `sourceUsernames`
  and `sessionIds`) instead of duplicating.
- **Resumable.** Real pagination cursors (`next_max_id` / `end_cursor`) are
  persisted with every batch, so an interrupted dig resumes where it stopped.

---

## Search

Two layers over IndexedDB, no full scans on the hot path.

**Shorthand** — typed straight into the search box:

```
private posts>50 !married          private accounts, 50+ posts, bio lacks "married"
@fashionhub_bd f>1000 single       from that source, 1k+ followers, not taken
verified score>70 high             verified, score above 70, high-priority tab
```

Fields: `f`/`followers`, `p`/`posts`, `score`, `female`, `ratio`.
Flags: `private`, `public`, `verified`, `business`, `personal`, `taken`,
`single`, `story`, `boosted`, `high`, `qualified`, `review`, `failed`.
`@source` filters by origin list; `!word` excludes a bio term.

**Structured filters** — sidebar controls compile to a condition tree
(`{logic, conditions[], groups[]}`) supporting `eq, neq, gt, gte, lt, lte,
between, in, notIn, contains, containsAny, containsAll, hasAny, within, older`.

### Why text search is fast

Naive trigram intersection took **1740 ms** at 10k rows. The planner instead
uses the `byToken` multi-entry index to `count()` each candidate term, bails
immediately if any term has zero hits, `getAll()`s only the **rarest** term,
then filters that small set in memory.

Measured at 10k rows:

| Query | Time |
|---|---|
| Label + score (compound index) | 20.7 ms |
| Full-text | 62.6 ms |
| 4 filters combined | 52.6 ms |
| Tab counts (index `count()` only) | 14.1 ms |

---

## Classifier

Scores **100 = female, 0 = male, 50 = unknown**, combining weighted signals:

| Signal | Prior |
|---|---|
| Exact name match | 1.00 |
| Pronouns in bio | 0.95 |
| Visual (opt-in) | 0.75 |
| Name suffix | 0.50 |
| Bio keywords | 0.45 |
| Name n-gram | 0.30 |
| Username | 0.25 |

**Invariant: a low or unknown classification never removes a profile.** It only
routes it to the `review` lane.

Bulk dictionary lives in `public/data/names.json` (791 entries); the curated
Bengali/Arabic/South-Asian lists in `src/engines/classifier/names.js` take
precedence.

### Photo analysis is off by default

Visual gender inference requires downloading each profile picture and running a
face model in an offscreen document. Analysing faces to infer a protected
attribute may constitute biometric processing under **BIPA** and **GDPR
Art. 9**. Leave it off unless you have a lawful basis. The settings panel
repeats this warning at the toggle.

---

## Scoring

Base 100 = Posts (60) + Followers (25) + Following (15), then multiplicative
gates: likely-male ×0.15, zero posts ×0, business ×0.4, verified ×0.5.

Labels: **≥70** high priority · **≥45** qualified · **>0** review · else excluded.
Followers sweet spot 500–2000; above 50k scores 10%.

`scoreProspect()` is pure and returns a frozen object with a `reasons[]` array —
that array is what the card's **Why?** disclosure renders, so the UI never
invents an explanation the engine didn't produce.

---

## Testing

```bash
npm test               # 52 tests
npm run test:unit
npm run test:integration
npm run gen:fixture    # regenerate deterministic fixtures
npm run gen:names      # rebuild the name dictionary
```

Fixtures are seeded (mulberry32, seed `20260821`) and byte-identical across
runs, so a fixture change is a reviewable diff rather than test flake.

Coverage: ingest conservation, dedup/merge, queue leasing, classifier priors,
scoring gates, predicate operators, query performance budgets, hostile input
handling, and the plan's §13 acceptance criteria.

`tests/integration/acceptance.test.js` encodes the acceptance criteria that can
be checked headlessly (1, 2, 5, 6, 11, 12, 13, 14). Criteria **3, 4, 8 and 9**
— service-worker kill/restart recovery, 10k-row cold-open timing and scroll
preservation under live updates — need a real Chrome and are **not yet
verified**.

---

## Known gaps

- **Not yet exercised against live Instagram.** Selectors in
  `content/index.js` (`findScroller()`'s four fallbacks) are the fragile part
  and will need adjustment when Instagram's DOM shifts.
- `public/face-api/` is absent by design. Visual classification degrades to
  `{detected: false, reason: 'model_unavailable'}` unless you add the models.
- `repo.prospects.mergeSighting` and `dedup.mergeProspect` overlap; both work,
  neither is dead, but they should be reconciled.
- Search runs on the main thread. It is comfortably fast at 10k rows; a Worker
  wrapper is the next step if datasets grow past ~50k.

---

## Operational notes

Rate limiting uses a token bucket with jittered 1.8–3.2 s delays. On HTTP
429/403 a circuit breaker trips and defers the queue 60 s. Instagram
checkpoint/challenge pages pause the dig and heartbeat every 15 s rather than
hammering through — if you see a challenge, solve it in the tab and the
harvester resumes on its own.

Scrape responsibly and within Instagram's terms; this tool automates a logged-in
session and aggressive use risks the account.
