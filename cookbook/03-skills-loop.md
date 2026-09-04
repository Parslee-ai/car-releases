# Skills: ingest, find, report outcome

Skills are learned procedures stored as first-class graph nodes with trigger context. CAR finds them by spreading activation, ranks by past success, and auto-degrades the broken ones.

## The full loop

```typescript
import { CarRuntime } from 'car-runtime';
const rt = new CarRuntime();

// 1. Ingest a skill the first time it works.
rt.ingestSkill(
  'deploy-staging',
  // code: arbitrary string the agent will use to execute the skill.
  // Could be a shell command, a function name, a JSON spec, etc.
  'pnpm build && pnpm deploy --env staging',
  // platform: where the skill applies.
  'node',
  // persona: which agent role this is for.
  'engineer',
  // url_pattern: when navigating, only match these URLs (use "" for n/a).
  '',
  // task_keywords: terms that should trigger this skill.
  ['deploy', 'release', 'staging', 'ship'],
  // description: one-liner shown to the model when proposing this skill.
  'Deploy the current branch to staging',
);

// 2. Later, find the right skill for the current context.
const found = rt.findSkill(
  'engineer',                    // persona
  '',                            // url
  'ship this branch to staging', // task
  3,                             // top-k
);
const skills = found === 'null' ? [] : JSON.parse(found);
// [{ name, code, platform, description, stats, match_score }, ...]

// 3. Use it. Then record the outcome — this is what makes skills learn.
const skillUsed = skills[0];
let success = true;
try {
  // ... actually run the skill ...
} catch (e) {
  success = false;
}
rt.reportOutcome(skillUsed.name, success ? 'success' : 'fail');
```

## Auto-degradation

A skill is automatically marked `broken_for_repair` when `fail_count > success_count + 2`. Broken skills:

- still appear in `findSkill` results (so the model knows they exist)
- carry a flag the agent can branch on (don't propose, repair, or replace)
- can be repaired in-place via `repairSkill`:

```typescript
const repaired = await rt.repairSkill('deploy-staging');
// Returns the new code as a string, or null if the skill isn't degraded
// or repair fails. The repaired version is NOT auto-ingested — call
// ingestSkill again with `supersedes: 'deploy-staging'` to commit it.
```

For batch evolution across an entire failed-trace corpus:

```typescript
const events = await readTraceEventsFromDisk();
const newSkills = await rt.evolveSkills(JSON.stringify(events), 'engineer');
// Generates + ingests fresh skills informed by what just failed.
```

## Listing and inspecting

```typescript
const all = JSON.parse(rt.listSkills());
const engineerOnly = JSON.parse(rt.listSkills('engineer'));

// Domains where the average skill quality has dropped:
const needWork = rt.domainsNeedingEvolution(0.6);
// ["browser-automation", "deploy"]
```

## Distilling skills from execution traces

When the agent has just done something useful, extract reusable patterns from the event log:

```typescript
const distilled = JSON.parse(await rt.distillSkills(JSON.stringify(events)));
const ingestedCount = rt.ingestDistilledSkills(JSON.stringify(distilled));
```

This is how CAR's "the runtime gets smarter as you use it" loop closes. The dream/consolidation pass (`rt.consolidate()`) runs distillation periodically as part of the scheduler's idle work.
