# The library

The Library tab is the master list of every song in the system. Click a row
to load the song into the player; everything else on the row is a shortcut
into that song's data.

![Library table](images/library_table.png)
*SCREENSHOT: the library table with several rows, one tag picker open*

## Columns, left to right

| Column | What it holds | Interactive? |
|---|---|---|
| **Set** | Checkbox for the batch-add flow. | Tick rows, then commit them into the active setlist via the green + on the ghost rows in the sidebar (see [04_GIGS_AND_SETLISTS.md](04_GIGS_AND_SETLISTS.md#batch-adding-songs--the-ghost-add-flow)). |
| **Song Title** | ☆ star + title. | The star toggles Favorite (syncs with the player and sidebar stars). Clicking the row loads the song. |
| **Artist** | Artist name. | Sortable. |
| **Tags** | Tag pills + readiness. | Click the cell to open the tag picker: toggle tags (upbeat, slow, protest, harmonies, singalong, crowd, opener, closer, and any custom ones), and set readiness (**InTheCan** / **Rehearse** / **tbd**). Tags feed the Gig Builder's filters. |
| **Dur** | mm:ss. | Sortable. |
| **Tempo** | Detected BPM. | Sortable. |
| **Key** | Detected key. | Sortable. |
| **Singer** | Pulldown: Bill / Matt / Dan / JD / All / —. | Sets `singer_lead` immediately. Note: the band's Google Sheet is canonical — the next daily sheet sync may overwrite an in-portal change, so use the pulldown for quick triage and the sheet for permanent assignments. |
| **Drum** | The song's drum-machine chip (e.g. `120@130`). | Shows which pattern the drum machine will use. |
| **Plays** | How many times audio actually produced output for this song (5+ seconds of real playback counts as a play). | Sortable; the tooltip shows how stale the song is (time since last play). Feeds the Gig Builder's Stale column. |
| **Action** | The ⋯ menu. | Opens the per-song options modal (below). |

## The ⋯ action menu

The options modal for one song, top to bottom:

- **Source URL** — the YouTube link the song came from, with **↗ Open**
  and **Re-fetch**. Paste a better version's URL and click Re-fetch to
  wipe the current audio and re-ingest from the new link. You'll be asked
  to confirm: *"This deletes the current stems/m4a and re-downloads."*
  The Librarian downloads; the Performer re-stems — expect the usual
  10–25 minute render.
- **All metadata** — an expandable table of everything known about the
  song (BPM, key, singer fields, durations, file inventory, source.wav
  size). URLs are clickable.
- **Re-stem in Logic Pro** — hands the song to the Keyboard Maestro
  macro "simpleStem", which drives Logic Pro's Stem Splitter as an
  alternative to the Demucs render. Advanced/optional; the macro takes
  about 3 minutes. The **🔓 Unlock (macro stuck)** button clears the
  macro lock if a previous run died mid-flight.
- **Delete permanently (not reversible)** — removes the song's stems,
  metadata, and cached files. Two clicks (button + confirmation).

![Action menu](images/library_action_menu.png)
*SCREENSHOT: the per-song options modal with the Source URL row and Re-stem section visible*

## Search

The search box lives at the top of the left sidebar (**Cmd+S** or **/**
focuses it). Matching is live and case-insensitive against:

- **Title** and **Artist** (substring),
- **Key** — type `d major` or `Am`,
- **BPM** — type a bare number like `120` and you get every song within
  **±3 BPM**; `120bpm` and `120 bpm` work too,
- the keyword **`stems`** — songs with a full six-stem set.

There is no field-prefix syntax (`singer:` etc.) — for roster and tag
filtering use the Gig Builder, and for stem-health queries like `0/6` use
the Librarian dashboard's library search.

## Sorting and views

Click any underlined column header (Title, Artist, Dur, Tempo, Key, Singer,
Drum, Plays) to sort; click again to flip direction.

The **List / Grid** toggle at the top right of the library switches to a
card grid — larger touch targets showing title, artist, and key facts, at
the cost of the editing columns. List view is the working view; grid is
for browsing on a touchscreen.

## Library Analytics

At the bottom of the sidebar, the collapsible **Library Analytics** rollup
summarizes the library:

- Stat cards: **Total Songs**, **Multitrack Stems**, **M4A Tracks**,
  **Artists**.
- **Tempo Profile** — Slow / Medium / Fast bars (below 90 / 90–125 /
  above 125 BPM).
- Key and singer distributions, derived from each song's metadata — the
  singer counts reflect the sheet sync plus your pulldown edits.

## The cache banner

If any library song is missing from the offline cache, a warning banner
appears above the table with a one-click **Flash Cache** action. A library
with the banner showing is not gig-safe; see the
[Gig Day Runbook](08_GIG_DAY_RUNBOOK.md).

## The ingest tracker

When you paste a YouTube URL, the tracker under the URL box follows it
through *pasted → librarian → queued → rendering → done* (or *failed* —
see [09_TROUBLESHOOTING.md](09_TROUBLESHOOTING.md#a-render-failed)). The
song appears in the table automatically when done; no refresh needed.
