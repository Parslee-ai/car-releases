{% raw %}
# Advisor Pattern

The Advisor pattern lets a primary executor ask a stronger model for bounded
guidance without handing over execution.

The executor remains the actor. The advisor reviews evidence and returns a
structured verdict. The caller decides whether to continue, adjust the plan, or
stop.

> Source of truth: [`car-rs/crates/car-multi/src/patterns/advisor.rs`](../car-rs/crates/car-multi/src/patterns/advisor.rs).
> If this document drifts from the Rust types, the Rust types win.

---

## Why it exists

Most agent stacks have two unattractive options:

- run every step through the most capable model, which is expensive and slow
- run cheap models until they fail, then let them keep failing

Advisor is the middle path. A cheaper or local executor can keep the hot loop,
while a stronger model is consulted only at explicit decision points:

- repeated failures
- explicit uncertainty
- no approved guidance matched the task
- high-risk work
- final completion verification

This is not delegation. The advisor does not get tools, mutate state, or own
the task. It returns judgment.

---

## Core contract

An advisor consultation returns `AdvisorResult`:

```rust
pub struct AdvisorResult {
    pub verdict: AdvisorVerdict,
    pub advisor_output: AgentOutput,
    pub used: u32,
    pub max_uses: u32,
}
```

The verdict is one of:

| Verdict | Meaning |
|---------|---------|
| `Continue` | The current course is acceptable. |
| `Plan` | The executor should reset around a short revised plan. |
| `Correction` | The next action should change. |
| `Stop` | The run should halt instead of continuing autonomously. |
| `Uncertain` | The advisor cannot endorse the current state from available evidence. |

The advisor prompt asks the model to return one JSON object:

```json
{
  "verdict": "continue|plan|correction|stop|uncertain",
  "rationale": "text when verdict is continue",
  "guidance": "text when verdict is plan or correction",
  "reason": "text when verdict is stop or uncertain"
}
```

Malformed or incomplete responses are treated as `Uncertain`, not as success.

---

## Trigger policy

`AdvisorTriggerPolicy` is the bounded policy for deciding when the executor
should consult the advisor:

```rust
pub struct AdvisorTriggerPolicy {
    pub max_calls_per_run: u32,
    pub repeated_failure_threshold: u32,
    pub consult_on_missing_guidance: bool,
    pub require_on_high_risk: bool,
}
```

It evaluates an `AdvisorTriggerContext` and returns:

| Decision | Meaning |
|----------|---------|
| `NoConsult` | Keep running without an advisor call. |
| `OptionalConsult` | The caller may consult if the product wants extra judgment. |
| `MustConsult` | The policy says this state needs stronger-model review. |

The `Advisor` itself also enforces `max_uses`. Once the budget is exhausted,
`consult` returns `MultiError::AdvisorExhausted`.

---

## Rust usage

The caller provides an `AgentRunner`, just like the other `car-multi`
patterns. CAR owns the consultation shape and budget; the caller owns model
execution.

```rust,ignore
use std::sync::Arc;
use car_multi::{
    Advisor, AdvisorTriggerContext, AdvisorTriggerPolicy, AdvisorTriggerDecision,
    AgentRunner, AgentSpec, SharedInfra,
};

let advisor_spec = AgentSpec::new(
    "frontier_advisor",
    "You are a senior engineering advisor. Return only the requested verdict.",
);

let advisor = Advisor::new(advisor_spec, 3);
let policy = AdvisorTriggerPolicy::default();

let decision = policy.evaluate(&AdvisorTriggerContext {
    repeated_failures: 2,
    explicit_uncertainty: false,
    missing_guidance: true,
    prior_advisor_calls: advisor.used(),
    task_risk: car_multi::TaskRisk::Low,
    labels: vec!["same_tool_failed_twice".to_string()],
});

if matches!(decision, AdvisorTriggerDecision::MustConsult { .. }) {
    let result = advisor
        .consult(
            "The executor failed the same verification command twice. Review the evidence and suggest the next move.",
            &runner as &Arc<dyn AgentRunner>,
            &SharedInfra::new(),
        )
        .await?;

    match result.verdict {
        car_multi::AdvisorVerdict::Continue { .. } => {
            // Keep the executor's current plan.
        }
        car_multi::AdvisorVerdict::Correction { guidance }
        | car_multi::AdvisorVerdict::Plan { guidance } => {
            // Feed guidance back into the executor loop.
        }
        car_multi::AdvisorVerdict::Stop { reason }
        | car_multi::AdvisorVerdict::Uncertain { reason } => {
            // Halt or collect more evidence before continuing.
        }
    }
}
```

---

## Relationship to approved guidance

`car-memgine` adds the durable governance layer around this pattern:

- `GuidanceCandidate` is a distilled but unapproved learning.
- `ApprovedSkillPack` is the immutable runtime pack the product has approved.
- `ApprovedAdvisorTriggerRule` captures approved reasons to consult an advisor.
- `RuntimeSkillOverlay` tracks mutable outcome counts and review queues without
  mutating the approved pack.

The intended loop is:

1. The executor runs with approved skills and trigger rules.
2. Failures or uncertainty can trigger an advisor call.
3. Successful or failed trajectories can distill candidate guidance.
4. A review step promotes selected candidates into the next approved pack.
5. Runtime outcome stats identify skills or trigger rules that need review.

CAR provides the data structures. Product code decides the review and promotion
workflow.

---

## How it differs from other patterns

| Pattern | Who executes? | Use when |
|---------|---------------|----------|
| `Advisor` | The original executor | A stronger model should review decisions without taking over. |
| `Delegator` | A spawned specialist | A subtask should be executed by another agent. |
| `Supervisor` | Workers execute, supervisor reviews | Work needs iterative oversight across rounds. |
| `Vote` | Several agents answer independently | You want consensus or variance reduction. |
| `Swarm` | Many agents run on the task | You want parallel perspectives or debate. |

Use Advisor when control must stay local, auditable, and bounded.

---

## Known boundary

The current CAR implementation is the foundation API. It does not prescribe:

- which model should be the student or advisor
- how product prompts should package evidence
- how approved guidance is reviewed by humans
- how final-answer quality is scored

Those are product-level choices. Tokhn's advisor experiment is one concrete
consumer of this pattern, not the generic contract.

{% endraw %}
