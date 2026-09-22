# n8n workflow: YouTube Inbox Summaries

`youtube-inbox-summaries.json` is an importable n8n workflow (tested with n8n 2.33) that
turns the videos in an "inbox" playlist into Obsidian notes via this service:

```
Daily 08:00 → Config → Health → Service ready? ─no→ Not ready (stop)
                                     │yes
                                     ▼
                       Known Summaries (GET /summaries)
                                     ▼
                       Get Inbox (YouTube node, playlist items)
                                     ▼
                       Plan (drop known / deleted / private, cap maxPerRun)
                                     ▼
                       Loop Videos ──► Summarize (GET /summary/:id, 15 min timeout)
                            ▲                        ▼
                            └──────────────── Classify (200 done · 404 no-captions · 503 retry · else failed)
                            │done
                            ▼
                         Summary (counts + list needing attention)
```

The service does the heavy lifting: it fetches the transcript once, summarises with the
local LLM, caches both, and writes the Obsidian note into the Syncthing folder. n8n only
decides *which* videos to ask for and reports the outcome.

## Import

1. n8n → *Workflows* → *Create* → menu *Import from File* → pick the JSON.
2. Open the **Config** node and set
   - `baseUrl` — the service on your tailnet, e.g. `http://<home-machine tailscale ip>:3000`
   - `playlistId` — the inbox playlist
   - `maxPerRun` — how many new videos one run may summarise (each uncached video takes
     one to six minutes; the default 20 keeps a run under ~1 h).
3. Check the two credentials: **Get Inbox** needs your YouTube OAuth2 credential,
   **Known Summaries** and **Summarize** need the HTTP Basic Auth credential with the
   service's `BASIC_AUTH_USER`/`BASIC_AUTH_PASS`. (The file references the credentials of
   the instance it was built on; on another instance re-select them.)
4. Run once manually, then activate. Adjust the schedule so it runs *before* any workflow
   that empties the inbox.

## Node settings that matter

- **Summarize**: *Response → Include Response Headers and Status* (`fullResponse`) and
  *Never Error* are on, plus *Settings → On Error → Continue*, so a 404 or 503 becomes
  data for **Classify** instead of aborting the run. Timeout 900 000 ms.
- **Health** has *On Error → Continue* too: an unreachable service lands in **Not ready**.
- **Loop Videos** uses batch size 1 so one slow or failing video never hides the others;
  the service serialises LLM calls anyway.
- Nothing is stored in n8n: the service's `GET /summaries` is the memory of what is done,
  so re-running the workflow is free (cache hits) and deleting a summary file on the home
  machine simply schedules that video again.

## Reading the result

The final **Summary** item looks like

```json
{ "processed": 5, "counts": { "done": 4, "no-captions": 1 }, "attention": [] }
```

`attention` lists videos with status `retry` (service or LLM temporarily unavailable,
YouTube block; they are picked up next run) or `failed` (look at the service logs).
`no-captions` videos are remembered by the service for `NO_CAPTIONS_TTL_DAYS` and
re-checked afterwards.
