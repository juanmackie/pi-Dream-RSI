---
name: dream-rsi
description: Route Dream-RSI assessment, loop, and campaign status requests. Use when a user invokes `/dream-rsi` or asks what to improve with Dream-RSI.
---

# Dream-RSI

Use [dream-rsi-assess](../dream-rsi-assess/SKILL.md) for read-only project assessment. Use [dream-rsi-loop](../dream-rsi-loop/SKILL.md) when the user asks Dream-RSI to improve a project autonomously.

`/dream-rsi status`, `stop`, `resume`, and `watch` inspect or control the loop. `/dream-rsi improve` and `/dream-rsi start` were removed in 3.0; use `/dream-rsi loop`.

Use `dream_rsi_signals` for bounded, read-only evidence. Pass the user's goal as `focus`. Set `include_logs` to false when requested. Report sanitized aggregates only.