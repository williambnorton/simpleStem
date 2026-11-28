# The library

The Library tab is the master list of every song in the system. Click a row
to load the song into the player; everything else on the row is a shortcut
into that song's data.

![Library table](images/library_table.png)
*SCREENSHOT: the library table with several rows*

## Columns, left to right

| Column | What it holds | Interactive? |
|---|---|---|
| **Set** | Checkbox for the batch-add flow. | Tick rows, then commit them into the active setlist via the green + on the ghost rows in the sidebar (see [04_GIGS_AND_SETLISTS.md](04_GIGS_AND_SETLISTS.md#batch-adding-songs--the-ghost-add-flow)). |
| **Song Title** | ☆ star + title. | The star toggles Favorite (syncs with the player and sidebar stars). Clicking the row loads the song. |
| **Artist** | Artist name. | Sortable. |
| **Categories** | Ten checkboxes, one per category. The category names stand upright in the header. | Tick a box to put the song in that category. Click a name in the header to rename it, a **+** to name an unused slot (20 characters at most); an empty name removes the category and its ticks. A slot with no name is greyed. A tick on a selected row (Set checkbox) goes to every selected row. |
| **Dur** | mm:ss. | Sortable. |
| **Tempo** | Detected BPM. | Sortable. |
| **Key** | Detected key. | Sortable. |
| **Singer** | Four checkboxes under **B M D J**: Bill, Matt, Dan, JD. | Tick who sings the song (more than one is fine). Sortable. A tick on a selected row goes to every selected row. |
| **Drum** | The song's drum-machine chip (e.g. `120@130`). | Shows which pattern the drum machine will use. |
| **Plays** | How many times audio actually produced output for this song (5+ seconds of real playback counts as a play). | Sortable; the tooltip shows how stale the song is (time since last play). Feeds the Gig Builder's Stale column. |
| **Action** | The ⋯ menu. | Opens the per-song options modal (below). |

## Categories, singers and building a set

The names of the ten categories and every song's ticks are kept in one file,
`CATEGORIES.json` in the simpleStem folder on Drive (with a copy on the
Performer, so it works with no Drive). They are not stored in the song and
the band sheet does not change them. The values the band sheet syncs
(`singer_lead`, `readiness`) are still in each song and still feed the
built-in singer views (Bill Songs, Matt Songs, Dan Songs, JD Songs,
RoundRobin) and the Gig Builder; the library table no longer shows or
edits them.

The filter bar above the table has one chip per named category and per
singer, each with its song count, plus **none** (songs with no tick).
All chips start unchecked, which filters nothing; check chips to see only
the songs that have any of them.

To build a set: check a category or singer chip (or search), tick the songs
with the Set checkbox or the select-all box in the header, then **Make Gig
from selection**, **Make setlist from selection** or **Add to current
setlist**. To categorise many songs at once: tick them, then tick one
category box on any of the ticked rows.

## The ⋯ action menu

The options modal for one song, top to bottom:

- **Source URL** — the YouTube link the song came from, with **↗ Open**
  and **Re-fetch**. Paste a better version's URL and click Re-fetch to
  ingest the song again from the new link. You'll be asked to confirm.
  The Librarian downloads the new version and the song goes into the
  Logic Pro stemming queue; it keeps playing its present stems until
  that run replaces them.
- **All metadata** — an expandable table of everything known about the
  song (BPM, key, singer fields, durations) and, above it, the file
  inventory: stems, kit pieces and the size of the original stereo. URLs are clickable.
- **Delete permanently (not reversible)** — removes the song's stems,
  metadata, and cached files. Two clicks (button + confirmation).

![Action menu](images/library_action_menu.png)
*SCREENSHOT: the per-song options modal with the Source URL row visible*

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
  singer counts reflect the sheet sync.

## The cache banner

If any library song is missing from the offline cache, a warning banner
appears above the table with a one-click **Flash Cache** action. A library
with the banner showing is not gig-safe; see the
[Gig Day Runbook](08_GIG_DAY_RUNBOOK.md).

## The ingest tracker

When you paste a YouTube URL, the tracker under the URL box follows it
through *pasted → librarian → queued → fetching → done* (or *failed* —
see [09_TROUBLESHOOTING.md](09_TROUBLESHOOTING.md#an-ingest-failed)). The
song appears in the table automatically when done, marked **LOGIC QUEUE**
until Logic Pro has made its stems (Play gives the original stereo
meanwhile); no refresh needed.
