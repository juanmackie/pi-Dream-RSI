# 1.0 implementation contract

The user plan is in `.audit/plan.txt`. The user requires Luna agents at high reasoning effort, guided and checked by the parent. One writer runs at a time. Do not spawn other agents or change model.

Before editing, read the assigned modules and relevant tests. Follow the TypeScript skill at `C:/Users/juanm/.agents/skills/typescript-best-practices/SKILL.md` and its type-system principle. Use plain writing. Add behavior tests for new behavior before implementation. Keep unchanged existing runtime diagnostics and the five-minute timeout cap. Campaign record version stays 1. Old manual task/history data must remain untouched.

Change only assigned paths. Do not commit, push, publish, merge, modify this contract, or run external project benchmarks. Do not insert provider/model names or model-specific knobs in shipped code, prompts, or docs. Every agent role uses a call-time resolver with campaign-record fallback. Tests may use dummy identifiers.

Verify with `npm run typecheck` and the named targeted tests. Full tests may be run after a coherent slice. Do not weaken tests to hide behavior regressions. New features must have outcome assertions, including failure paths. Preserve existing internal live/dream/policy algorithms and their tests.

Return a receipt with changed paths, design decisions, exact commands and outcomes, known gaps, and integration instructions. The parent reads the diff, reruns checks, resolves gaps and makes local commits.
