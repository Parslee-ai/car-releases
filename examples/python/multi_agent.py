"""Multi-agent pipeline + skill distillation + evolution.

Demonstrates the shape of the learning loop:
  1. run_pipeline — two agents working in sequence
  2. trace collection — synthesize TraceEvent objects from pipeline outcomes
  3. ingest_distilled_skills — save learned procedures to the memory graph
  4. domains_needing_evolution — find weak areas
  5. evolve_skills — generate new skill variants (requires configured inference)

The agent_fn and distilled skills are deterministic so the example runs in
~1 second without network. In production:
  - swap agent_fn for a call to your LLM (Claude, GPT, local Qwen3)
  - swap the mock skills for `rt.distill_skills(trace)` (uses inference)
  - keep the evolve_skills call — it also uses inference

Prereq:
    pip install car-runtime

Run:
    python multi_agent.py
"""

import json
import random

import car_native

random.seed(42)


# ---------------------------------------------------------------------------
# Agent callback — deterministic for reproducibility.
# ---------------------------------------------------------------------------

def agent_fn(spec_json: str, task: str) -> str:
    spec = json.loads(spec_json)
    role = spec["name"]

    base = {"name": role, "turns": 1, "tool_calls": 0, "duration_ms": 1.0}

    if role == "web_scraper":
        success = random.random() > 0.25
        if not success:
            return json.dumps({**base, "answer": "", "error": "timeout"})
        return json.dumps(
            {**base, "answer": f"scraped data for: {task}", "tool_calls": 1}
        )

    if role == "summarizer":
        return json.dumps({**base, "answer": f"summary: {task[:40]}..."})

    return json.dumps({**base, "answer": "(no-op)"})


def run_round() -> list[dict]:
    """Drive the pipeline a few times and convert outcomes into TraceEvents."""
    stages = json.dumps(
        [
            {
                "name": "web_scraper",
                "system_prompt": "scrape web pages",
                "tools": ["http_get"],
                "max_turns": 3,
                "metadata": {"domain": "web"},
            },
            {
                "name": "summarizer",
                "system_prompt": "summarize text",
                "tools": [],
                "max_turns": 1,
                "metadata": {"domain": "text"},
            },
        ]
    )

    trace = []
    for i in range(6):
        task = f"research topic #{i}"
        result = json.loads(car_native.run_pipeline(stages, task))
        for stage_name, domain in [("web_scraper", "web"), ("summarizer", "text")]:
            stage = next(
                (s for s in result.get("stages", []) if s.get("name") == stage_name),
                None,
            )
            if stage is None:
                continue
            trace.append(
                {
                    "kind": "action_failed" if stage.get("error") else "action_succeeded",
                    "action_id": f"round{i}_{stage_name}",
                    "tool": stage_name,
                    "data": {"task": task, "role": stage_name, "domain": domain},
                    "reward": 0.0 if stage.get("error") else 1.0,
                }
            )
    return trace


# ---------------------------------------------------------------------------
# Pre-built skills — shape matches what `rt.distill_skills(trace)` would
# produce. Hand-crafted here so the example doesn't depend on having an
# inference engine configured.
# ---------------------------------------------------------------------------

DEMO_SKILLS = [
    {
        "name": "scrape_and_summarize",
        "description": "Fetch a page, clean the text, pass to a summarizer agent.",
        "when_to_apply": "User asks for the essence of a linked resource.",
        "scope": {"domain": "web"},
        "source": "success",
        "domain": "web",
        "trigger": {
            "persona": "researcher",
            "url_pattern": "https://*",
            "task_keywords": ["summarize", "article", "link"],
        },
        "code": "http_get(url) → clean_html → summarize",
    },
    {
        "name": "write_concise_summary",
        "description": "Produce a 2-sentence summary of a text input.",
        "when_to_apply": "After a scrape or a long-form content read.",
        "scope": {"domain": "text"},
        "source": "success",
        "domain": "text",
        "trigger": {
            "persona": "summarizer",
            "url_pattern": "",
            "task_keywords": ["summarize", "brief", "tl;dr"],
        },
        "code": "first_2_sentences(input)",
    },
]


def main() -> None:
    rt = car_native.CarRuntime()
    car_native.register_agent_runner(agent_fn)

    print("round 1: pipeline runs")
    trace = run_round()
    successes = sum(1 for e in trace if e["kind"] == "action_succeeded")
    failures = sum(1 for e in trace if e["kind"] == "action_failed")
    print(f"  successes: {successes}, failures: {failures}")

    # In production:
    #   skills_json = rt.distill_skills(json.dumps(trace))
    # Here we use the pre-built DEMO_SKILLS so the example runs offline.
    print("\ningesting skills into the memory graph")
    ingested = rt.ingest_distilled_skills(json.dumps(DEMO_SKILLS))
    print(f"  ingested: {ingested}")
    print("  skills in graph:", len(json.loads(rt.list_skills())))

    # Report outcomes to update stats — this is what makes some domains
    # look 'weak' to `domains_needing_evolution`.
    print("\nreporting outcomes to simulate real use")
    for _ in range(4):
        rt.report_outcome("scrape_and_summarize", "success")
    for _ in range(3):
        rt.report_outcome("scrape_and_summarize", "fail")
    for _ in range(2):
        rt.report_outcome("write_concise_summary", "success")

    print("\nchecking which domains need evolution")
    weak = rt.domains_needing_evolution(threshold=0.6)
    print(f"  weak domains: {weak or 'none above threshold'}")

    if weak:
        domain = weak[0]
        print(f"\nwould evolve skills for '{domain}' here. In production:")
        print(f"    evolved = rt.evolve_skills(json.dumps(trace), '{domain}')")
        print(
            "  (skipped — requires a configured inference engine; comment it in "
            "once you have one)"
        )
    else:
        print(
            "  (add more failures above to push scrape_and_summarize below the "
            "threshold and see evolution kick in)"
        )

    print("\nround 2: pipeline re-runs (skills now available in memory)")
    trace2 = run_round()
    s2 = sum(1 for e in trace2 if e["kind"] == "action_succeeded")
    f2 = sum(1 for e in trace2 if e["kind"] == "action_failed")
    print(f"  successes: {s2}, failures: {f2}")

    print("\nfinal skill inventory:")
    for skill in json.loads(rt.list_skills()):
        print(f"  - {skill.get('name')}: {skill.get('description', '')[:60]}")


if __name__ == "__main__":
    main()
