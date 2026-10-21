---
name: dream-rsi-loop
description: Run the bounded autonomous Dream-RSI improvement loop on a local project. Use when asked to improve or optimize a target without supervising each experiment.
---

# Run the loop

Call `dream_rsi_loop` with `action: "start"`, `consent: true`, the target project, and the user's focus. Ask for explicit trusted-local consent if the user has not provided it. Consent means discovered repository code runs on this host with the host user's access.

The loop ranks project levers, builds and qualifies a metric, explores isolated candidate workspaces, reviews and confirms changes, applies verified gains, and checks each apply independently. It stops at its durable campaign, agent, evaluator, or time budget, or when it finds no verifiable lever.

Completed experiments become worlds for deterministic replay. A dream agent may propose bounded search configurations; the loop adopts one only when replay beats the incumbent with adequate coverage. Treat proposals as data, never as executable policy.

Defaults are 6 campaigns, 72 agent starts, 200 evaluator runs, and 120 minutes. Use lower caps when the user requests them. State remains under `<project>/.dream-rsi/`; applied edits remain in the working tree and can be reverted with Git.

Use `action: "status"`, `"stop"`, or `"resume"` to control a saved run. When status shows pending candidate confirmation, use `action: "confirm"`; it resumes saved pairs without repeating paid readings and does not start another search. Report the stop reason and actual spend. Do not start a real model run unless the user explicitly authorizes its cost.
