# n8n workflow: YouTube Summaries Nightly

`youtube-summaries-nightly.json` is an importable n8n workflow (built against n8n 2.33,
node parameters per [`docs/verified/2026-09-23-n8n-data-table-node.md`](../../docs/verified/2026-09-23-n8n-data-table-node.md))
that turns every video known to an n8n **Data Table** into an Obsidian note via this
service, whether the video is still in the inbox playlist or already sorted out of it.

```
Nightly 01:00 → Config → Health → Service ready? ─no→ Not ready (stop)
                                       │yes
                                       ▼
  Known Summaries (GET /summaries) → Get Notes (GET /notes) → Get Playlists (taxonomy table)
                                       ▼
                         Get Rows (all yt_inbox rows, once)
               │                  │                  │
               ▼                  ▼                  ▼
  Consumed Notes → Mark Consumed  Already Summarised   Plan: "classify" items (summary
                                   → Mark Done        exists, no suggestion yet) first,
                                                      then "summarize" items newest
                                                      first; cap, deadline
                                                     ▼
       ┌──────────────────────────────────────► Loop Videos ──done──► Summary
       │                                             ▼
       │                              In Time? ─no──► Deferred ──────────────────────┐
       │                                 │yes                                        │
       │                          Needs Summary? ──no (classify)──┐                  │
       │                                 │yes                     │                  │
       │               Summarize (GET /summary/:id) → Classify    │                  │
       │                 → Final? → Record Status / Record Note   │                  │
       │                 → Result → Suggest? (done) ─no──────────►│──► loop          │
       │                                 │yes                     ▼                  │
       │                        Suggest (POST /classify/:id) → Read Suggestion       │
       │                          → Suggestion OK? ─yes→ Record Suggestion           │
       │                                 ▼                                           │
       └────────────────────────── Suggest Result ◄──────────────────────────────────┘
```

The service does the heavy lifting: it fetches the transcript once, summarises with the
local LLM, caches both, writes the Obsidian note into the Syncthing folder, and suggests
a playlist from the summary (`POST /classify`). n8n decides *which* videos to ask for
and records the outcome in the table. Nothing is moved on YouTube: a suggestion only
becomes a move when you approve it (see [Suggestions](#suggestions)).

## The table

The workflow reads a Data Table (e.g. `yt_inbox`) that another workflow fills: one row
per video, keyed by `videoId`. It only reads `videoId`, `title`, `targetName` and
`createdAt`, and only writes these string columns, which you add before the first run:

| Column | Values |
|---|---|
| `summaryStatus` | empty (to do) · `done` · `no_captions` · `failed` |
| `summaryNote` | date + outcome or error, e.g. `2026-09-24 VIDEO_UNAVAILABLE: …` |
| `suggestedPlaylistId` | playlist id suggested by the LLM; empty for "none" |
| `suggestedName` | playlist name, or `none`; empty = not suggested yet |
| `suggestConfidence` | `high` · `medium` · `low` |
| `suggestReason` | one sentence from the model |
| `noteConsumedAt` | date the note was first seen missing from the Obsidian inbox (moved or deleted); set once |

A second table holds the taxonomy that is sent to `/classify`: one row per topic playlist
with `playlistId`, `name` and `description` (the description is a binding rule; a
`Not: … (-> other playlist)` part redirects topics). If it is empty, no suggestions are
made.

Rows with `targetName = dead` are skipped. If a column is missing, **Get Rows** fails
with `Column(s) "…" do not exist` and nothing is called.

The table updates map only their own columns, so they never touch the other workflow's
columns. The reverse must hold too: a workflow that **upserts** rows must not map these
seven columns, or an empty value there clears them (n8n writes NULL for a mapped empty
value).

## Import

1. Add the seven columns above to the table (n8n UI → *Data tables*) and create the
   taxonomy table.
2. n8n → *Workflows* → *Create* → menu *Import from File* → pick the JSON.
3. Open the **Config** node and set
   - `baseUrl`: the service on your tailnet, e.g. `http://<home-machine tailscale ip>:3000`
   - `dataTableId`: the video table's ID (from its URL)
   - `playlistsTableId`: the taxonomy table's ID
   - `stopAt` (default `06:30`): no new video starts after this time. One video takes
     at most ~15 minutes, so the run ends before 07:00
   - `maxRunMinutes` (default 330): the time budget for a run started *after* `stopAt`,
     e.g. a manual run during the day
   - `maxPerRun` (default 150): caps summaries per run, as a safety net; the deadline
     normally ends the run. Suggestion-only items are not capped (seconds each).
4. Check the credentials: **Known Summaries**, **Summarize** and **Suggest** need the HTTP Basic Auth
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

## Suggestions

After every `done`, and for every summarised row without a suggestion (including rows
that are already sorted, which gives live accuracy data), the workflow calls
`POST /classify/:videoId` with the taxonomy and writes the four `suggest*` columns. A
409, 503 or invalid model answer writes nothing; the row is tried again next run. To
re-suggest (e.g. after changing descriptions), clear `suggestedName`.

The workflow never writes `status` or the target columns. Approval happens in the sort
workflow: set a row's `status` to `approved` and the sort job copies `suggestedPlaylistId`
/ `suggestedName` into the target columns and moves the video. To decide differently, set
`targetPlaylistId`, `targetName`, `action = move`, `status = pending` yourself; the
suggestion stays, so suggested vs. decided remains comparable.

## Consumed notes

Once per run, **Consumed Notes** compares `GET /summaries` (videos whose note was
written, `exportedAt`) with `GET /notes` (notes still in the inbox) and sets
`noteConsumedAt` for videos whose note is gone, i.e. you moved it into another vault
folder or deleted it. The check only needs the inbox mirror on the home machine; the
vault itself is never read. It is set once and never cleared. If `/notes` does not answer
with a clean 200, nothing is marked that run.

## Node settings that matter

- **Summarize**: *Response → Include Response Headers and Status* (`fullResponse`) and
  *Never Error* are on, plus *Settings → On Error → Continue*, so a 404 or 503 becomes
  data for **Classify** instead of aborting the run. Timeout 900 000 ms.
- **Get Rows** has *Execute Once* on, so it runs once even though **Get Playlists**
  returns one item per playlist.
- **Suggest** posts the JSON body built from **Get Playlists** (*Send Body → JSON →
  Using JSON*), with the same response and error settings as **Summarize**.
- **Record Status / Record Note / Mark Done / Record Suggestion** are Data Table *update* nodes matched on
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
{ "processed": 60, "counts": { "done": 30, "classify-only": 18, "no_captions": 6, "retry": 1, "deferred": 5 },
  "suggestions": { "high": 31, "medium": 12, "low": 4, "retry": 1 }, "attention": [ … ] }
```

`attention` lists videos with status `retry` or `failed`, or a suggestion to retry. The table is the durable
record: filter it by `summaryStatus = failed` to review errors.
