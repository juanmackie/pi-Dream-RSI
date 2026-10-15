---
name: dream-rsi
description: Use Dream-RSI to assess a project, start a bounded improvement campaign, or inspect its campaign dashboard.
---

# Dream-RSI

For `/dream-rsi assess [what you want]`, read [dream-rsi-assess](../dream-rsi-assess/SKILL.md). Assessment ranks project levers and does not start a campaign.

For `/dream-rsi improve <what you want>`, read [dream-rsi-improve](../dream-rsi-improve/SKILL.md). The campaign controller checks the evaluator, runs bounded experiments, and applies only verified improvements.

`/dream-rsi watch` and `Ctrl+Shift+D` open the active campaign dashboard. `/dream-rsi status`, `stop`, and `resume` operate on the campaign. `/dream-rsi help` shows the command list and the [Dream-RSI paper](https://arxiv.org/abs/2609.14858).

Manual-loop data from earlier versions remains in `.dream-rsi/task.json` and `.dream-rsi/history/`; this release does not read or change it.
