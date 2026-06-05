# prompts/ — cross-machine task briefs

Self-contained markdown briefs delivered through git from one machine's
Claude session to the other. The naming convention:

```
prompts/<target_machine>_<short_description>.md
```

Example targets: `librarian_*`, `performer_*`.

## How to use

1. On the originating machine, the Claude session authors a brief and
   commits + pushes it to `main`.
2. On the receiving machine, `git pull` makes the brief available.
3. The user starts a Claude session on that machine and says:
   *"Read `prompts/librarian_fix_led_zep_album.md` and execute it."*
4. The receiving Claude reads, proposes a plan to the user, gets
   confirmation, executes, marks the status section at the bottom
   `[x]`, and commits + pushes.
5. The next session can see at a glance which briefs are still
   actionable by scanning their status footer.

## Conventions

- Each brief is self-contained: assume the receiving Claude has read
  `CLAUDE.md` and `ARCHITECTURE.md` but knows nothing about this
  specific task.
- Always include a **Safety rules** section — what NOT to do.
- Always include a **Status** footer with checkboxes that get ticked
  as the work progresses.
- When done, leave the file in place (so future sessions can audit
  what was done). Don't delete.
- When stale (no longer relevant), append a final line:
  `_Superseded by: <new file>_` or `_Cancelled: <reason>_` and stop
  updating the status boxes.
