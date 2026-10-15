---
name: dream-rsi
description: Route Dream-RSI assessment, measurable improvement, and campaign status requests. Use when a user invokes `/dream-rsi` or asks what to improve with Dream-RSI.
---

# Dream-RSI

For `/dream-rsi assess [what you want] [--no-logs]`, read [dream-rsi-assess](../dream-rsi-assess/SKILL.md). Assessment analyzes project levers and does not start a campaign.

For `/dream-rsi improve <what you want>`, read [dream-rsi-improve](../dream-rsi-improve/SKILL.md). An explicit improve request authorizes the bounded campaign workflow described there.

`/dream-rsi watch` and `Ctrl+Shift+D` open the campaign dashboard. `/dream-rsi status`, `stop`, and `resume` inspect or control a campaign. `/dream-rsi help` shows the command list and the [Dream-RSI paper](https://arxiv.org/abs/2609.14858).

Use `dream_rsi_signals` for bounded, read-only evidence during assessment. Pass the user's goal as `focus`. Set `include_logs` to `false` for `--no-logs`; otherwise session signals are collected only from the active session manager's supplied directory. Report aggregates and sanitized evidence only. Never repeat raw commands, session text, commit subjects, or campaign reasons.

Manual-loop data from earlier versions remains in `.dream-rsi/task.json` and `.dream-rsi/history/`; this release does not read or change it.
