# n8n workflow: YouTube Summaries Nightly

`youtube-summaries-nightly.json` is an importable n8n workflow (built against n8n 2.33,
node parameters per [`docs/verified/2026-09-23-n8n-data-table-node.md`](../../docs/verified/2026-09-23-n8n-data-table-node.md))
that turns every video known to an n8n **Data Table** into an Obsidian note via this
service, whether the video is still in the inbox playlist or already sorted out of it.

```
Nightly 01:00 → Config → Health → Service ready? ─no→ Not ready (stop)
                                       │yes
                                       ▼
                         Known Summaries (GET /summaries)
                                       ▼
                         Get Rows (table rows without a final summaryStatus)
                           │                         │
                           ▼                         ▼
             Already Summarised → Mark Done      Plan (drop known / dead, newest first,
                                                       cap maxPerRun, set deadline)
                                                     ▼
       ┌──────────────────────────────────────► Loop Videos ──done──► Summary
       │                                             ▼
       │                              In Time? ─no──► Deferred ─────────┐
       │                                 │yes                           │
       │                                 ▼                              │
       │               Summarize (GET /summary/:id, 15 min timeout)     │
       │                                 ▼                              │
       │                              Classify                          │
       │                                 ▼                              │
       │            Final? ─yes→ Record Status · ─no→ Record Note       │
       │                                 ▼                              │
       └──────────────────────────── Result ◄───────────────────────────┘
```

The service does the heavy lifting: it fetches the transcript once, summarises with the
local LLM, caches both, and writes the Obsidian note into the Syncthing folder. n8n
decides *which* videos to ask for and records the outcome in the table.

## The table

The workflow reads a Data Table (e.g. `yt_inbox`) that another workflow fills: one row
per video, keyed by `videoId`. It only reads `videoId`, `title`, `targetName` and
`createdAt`, and only writes two string columns you add before the first run:

| Column | Values |
|---|---|
| `summaryStatus` | empty (to do) · `done` · `no_captions` · `failed` |
| `summaryNote` | date + outcome or error, e.g. `2026-09-24 VIDEO_UNAVAILABLE: …` |

Rows with `targetName = dead` are skipped. If the columns are missing, **Get Rows**
fails with `Column(s) "summaryStatus" do not exist` and nothing is called.

The table updates map only these two columns, so they never touch the other workflow's
columns. The reverse must hold too: a workflow that **upserts** rows must not map
`summaryStatus`/`summaryNote`, or an empty value there clears them (n8n writes NULL for
a mapped empty value).

## Import

1. Add the two columns above to the table (n8n UI → *Data tables*).
2. n8n → *Workflows* → *Create* → menu *Import from File* → pick the JSON.
3. Open the **Config** node and set
   - `baseUrl`: the service on your tailnet, e.g. `http://<home-machine tailscale ip>:3000`
   - `dataTableId`: the table's ID (from its URL)
   - `stopAt` (default `06:30`): no new video starts after this time. One video takes
     at most ~15 minutes, so the run ends before 07:00
   - `maxRunMinutes` (default 330): the time budget for a run started *after* `stopAt`,
     e.g. a manual run during the day
   - `maxPerRun` (default 150): safety net only; the deadline normally ends the run.
4. Check the credentials: **Known Summaries** and **Summarize** need the HTTP Basic Auth
   credential with the service's `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` (the file references
   the credential of the instance it was built on; on another instance re-select it).
5. Times use the workflow timezone (*Settings → Timezone*, preset to `Europe/Vienna`).
6. Run once manually, then activate.

## Outcomes

| Service answer | Table | Next night |
|---|---|---|
| `200` | `summaryStatus = done`, note file name in `summaryNote` | skipped |
| `404` no captions | `no_captions` | skipped for good |
| `400` / `500` (invalid id, private or removed video, bad LLM output) | `failed` + code and reason | skipped for good |
| `503` (LLM down or slow, YouTube block, summaries disabled), any other code, request failed | status stays empty, reason in `summaryNote` | retried |
| deadline passed | nothing written | retried |

To re-queue a video, clear its `summaryStatus` in the table, e.g. to re-check
`no_captions` videos for captions added later, or `failed` ones after a fix.

Rows whose video already has a summary in the service (from earlier manual calls) are
marked `done` once by **Already Summarised → Mark Done**.

## Node settings that matter

- **Summarize**: *Response → Include Response Headers and Status* (`fullResponse`) and
  *Never Error* are on, plus *Settings → On Error → Continue*, so a 404 or 503 becomes
  data for **Classify** instead of aborting the run. Timeout 900 000 ms.
- **Record Status / Record Note / Mark Done** are Data Table *update* nodes matched on
  `videoId`, mapping only their columns (*Define below*). They have *Always Output Data*
  and *On Error → Continue*, so a table problem never stops the loop. If you edit their
  mapping in the UI, check that no other column was added to it.
- **Loop Videos** uses batch size 1 so one slow or failing video never hides the others;
  the service serialises LLM calls anyway.
- **Health** has *On Error → Continue*: an unreachable service or LLM lands in **Not ready**
  and nothing is written.

## Reading the result

The final **Summary** item looks like

```json
{ "processed": 42, "counts": { "done": 30, "no_captions": 6, "retry": 1, "deferred": 5 }, "attention": [ … ] }
```

`attention` lists videos with status `retry` or `failed`. The table is the durable
record: filter it by `summaryStatus = failed` to review errors.
