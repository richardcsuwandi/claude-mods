# claude-mods

My [Claude Code mods](https://claude.com/blog/claude-code-mods).

## Install

```
/plugin marketplace add richardcsuwandi/claude-mods
/plugin install deadlines@claude-mods
/reload-plugins
```

## deadlines

Live countdown to your next deadline in the status line, plus `/ddl` to see them all.

```
/ddl                                         list all deadlines
/ddl add AISTATS 2026-10-06 aoe              add (time defaults to 23:59)
/ddl add Group meeting 2026-10-16 14:00      times are your local time...
/ddl add ICLR rebuttal 2026-11-18 23:59 aoe  ...or AoE with `aoe`
/ddl rm AISTATS                              remove
```

Emoji show how close it is: 🌱 > 30d, 🗓 < 30d, ⏳ < 7d, 😬 < 3d, 🔥 < 1d.
The bar fills over the last 30 days. Deadlines persist across sessions.

Mods run with the same access as Claude Code itself; read the source before installing.

### Where deadlines are saved

In Claude Code's per-plugin store (`~/.claude/plugins/store/deadlines_<marketplace>-<hash>.json`), keyed by plugin and marketplace name, so updating the plugin keeps your list. A second copy is mirrored to `~/.claude/deadlines-backup.json`; if the store ever comes back empty or unreadable, `/ddl` restores from that copy instead of overwriting it. Renaming the marketplace creates a fresh store, so the backup is what saves you there.
