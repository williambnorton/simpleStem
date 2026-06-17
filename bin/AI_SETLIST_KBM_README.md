# Keyboard Maestro macro contract: simpleStem AI Setlist Bridge

simpleStem's AI Setlist Builder pipes its prompt through one or more
chatbot web UIs driven by Keyboard Maestro, so the operator's existing
chat subscriptions handle the LLM calls (no per-token API charge).
Each selected chatbot runs an independent macro and writes its reply
to a per-bot file; the portal renders one card per bot and lets the
operator pick whichever setlist they like best.

## File contract

When the operator clicks **Generate Setlist** in the portal, simpleStem
(on the Performer) creates a fresh job directory and one subdirectory
per selected bot:

```
~/ClaudeDrive/simpleStem/AI_SETLIST/<job_id>/
  prompt.txt        — the full prompt to paste into every chatbot
  library.json      — the library context (for reference, not pasted)
  meta.json         — { job_id, created_at, description, library_size,
                        bots: ["claude","chatgpt",...], status }
  claude/
    prompt.txt      — copy of the prompt (convenience for the macro)
    response.txt    — macro writes the reply here (does not yet exist)
  chatgpt/
    prompt.txt
    response.txt
  gemini/
    ...
```

Then it spawns `bin/ai_setlist_kbm.sh <job_dir> <bots_csv>`, which fires
one `kmtrigger://` URL per selected bot:

```
open "kmtrigger://macro=simpleStem%20AI%20Setlist%20Bridge%20-%20Claude&value=<bot_subdir>"
open "kmtrigger://macro=simpleStem%20AI%20Setlist%20Bridge%20-%20ChatGPT&value=<bot_subdir>"
...
```

Each macro receives its bot's **subdirectory** (not the parent job dir)
as `%TriggerValue%`, and must write its reply to `<bot_subdir>/response.txt`.

simpleStem polls every few seconds and renders each bot's card as soon
as that bot's `response.txt` appears.

## Macro names (exact, one per bot)

| Bot ID | Macro name |
|---|---|
| `claude` | `simpleStem AI Setlist Bridge - Claude` |
| `chatgpt` | `simpleStem AI Setlist Bridge - ChatGPT` |
| `gemini` | `simpleStem AI Setlist Bridge - Gemini` |
| `deepseek` | `simpleStem AI Setlist Bridge - DeepSeek` |
| `perplexity` | `simpleStem AI Setlist Bridge - Perplexity` |
| `grok` | `simpleStem AI Setlist Bridge - Grok` |

Build only the macros you want. The portal exposes per-bot manual-paste
textareas so you can run the rest by hand and paste the reply into the
card; the portal writes the file for you.

## Per-bot macro design

The same skeleton works for every bot — only the front browser URL and
chat input/copy selectors change.

Suggested actions, in order:

1. **Read the prompt from the per-bot subdir.**
   - `Set Variable to Text Contents of File`
   - File: `%TriggerValue%/prompt.txt`
   - Variable: `Local_Prompt`

2. **Bring Chrome forward on the bot's URL.**
   - `Activate a Specific Application` → Google Chrome
   - Use `Execute a JavaScript in Front Browser` to ensure the front
     tab is on the right host, navigating if not:
     | Bot | Chat URL |
     |---|---|
     | Claude | `https://claude.ai/new` |
     | ChatGPT | `https://chatgpt.com/` |
     | Gemini | `https://gemini.google.com/app` |
     | DeepSeek | `https://chat.deepseek.com/` |
     | Perplexity | `https://www.perplexity.ai/` |
     | Grok | `https://grok.com/` |

3. **Paste the prompt into the chat box.**
   - `Set System Clipboard to Text`: `%Variable%Local_Prompt%`
   - `Pause` 0.3s
   - Click the chat input (each bot has a different selector — easiest
     is `Type Keystroke` for the focus shortcut or `Move and Click`).
   - `Type Keystroke` → ⌘V
   - `Pause` 0.2s
   - `Type Keystroke` → Return

4. **Wait for the response to finish streaming.**
   - Simplest: `Pause` 5 minutes.
   - Smarter: poll the DOM for the per-bot "stop" / "regenerate" button
     to flip back to "send" / "copy".

5. **Copy the latest assistant message.**
   - Most bots expose a copy button on the latest message footer. The
     reliable pattern is:
     ```js
     const btns = Array.from(document.querySelectorAll('button[aria-label*="Copy" i], button[title*="Copy" i]'));
     const last = btns[btns.length - 1];
     if (last) last.click();
     ```
   - Or select all in the last message and ⌘C.

6. **Write the clipboard to the per-bot response.txt.**
   - `Write to a File`
   - File path: `%TriggerValue%/response.txt`
   - Text: `%CurrentClipboard%`

7. **(Optional) Append a final newline marker** so the file is fully
   flushed before the portal polls it.

## What goes inside response.txt

The JSON object the bot returned. The system prompt asks for *exactly*
this shape (per `aiSetlistBuildPrompt()` in `server.js`):

```json
{
  "flow_rationale": "A 4-8 sentence paragraph explaining the sequence aesthetics — why this set flows the way it does, what energy arc you're shaping, how you handled singer rotation, how key transitions support the vibe. Not per-song reasons — talk about the SEQUENCE.",
  "setlist": [
    {
      "time": "6:30 PM",
      "song_base": "Workin_For_A_Living_Huey_Lewis",
      "title": "Workin' for a Living",
      "artist": "Huey Lewis and the News",
      "singer": "Dan",
      "key": "A major",
      "bpm": 124,
      "duration_min": 4
    }
  ]
}
```

Notes:

- **No per-song `reason` field.** The prompt explicitly asks the bot
  to put its reasoning in the top-level `flow_rationale` paragraph
  rather than annotating individual rows.
- If the bot wraps the JSON in prose (e.g. "Here's your setlist:" before
  and "Let me know if…" after), the server's parser extracts the
  outermost `{ … }` block, so it's fine.
- `song_base` is the band's canonical slug. The bot is given the
  library as part of the prompt; the server cross-checks each
  `song_base` against the corpus and silently drops songs that don't
  match.

## Manual fallback (no macro yet)

The portal includes a per-bot **"Or paste the reply yourself"**
textarea on each card while it's still in the Waiting state. The
flow is:

1. Click **Generate Setlist** with the bot checked.
2. Run the chat yourself — paste `prompt.txt` into the bot's web UI,
   wait for the reply.
3. Copy the reply, paste into the card's textarea, click **Submit
   pasted reply**.

The portal writes it to the per-bot `response.txt` and the next poll
flips the card to Ready.

You can also do it from the command line:

```
cat ~/ClaudeDrive/simpleStem/AI_SETLIST/<job_id>/prompt.txt | pbcopy
# run the bot, copy the reply
pbpaste > ~/ClaudeDrive/simpleStem/AI_SETLIST/<job_id>/<bot>/response.txt
```
