"""Graph memory + skills: add facts, build context, learn skills.

Demonstrates:
  - adding facts and querying them via spreading activation
  - building a 4-layer context for grounding an LLM call
  - ingesting a skill with trigger context (persona, URL, task keywords)
  - finding the best skill for a context
  - reporting outcomes to update skill stats
  - persist / load memory

Prereq:
    pip install car-runtime

Run:
    python memory_and_skills.py
"""

import json
import tempfile

import car_runtime


def main() -> None:
    rt = car_runtime.CarRuntime()

    # ---- Facts ----
    print("seeding facts")
    rt.add_fact("project_language", "TypeScript", "pattern")
    rt.add_fact("framework", "React", "pattern")
    rt.add_fact("test_runner", "vitest", "pattern")
    rt.add_fact("style_rule", "no implicit any", "constraint")
    print(f"  {rt.fact_count()} facts in graph")

    print("\nquerying facts via spreading activation")
    hits = json.loads(rt.query_facts("what language is this project in?", k=3))
    for h in hits:
        print(f"  {h['subject']}: {h['body']}  (activation={h['confidence']:.3f})")

    # ---- 4-layer context ----
    print("\nbuilding the 4-layer context for an LLM call")
    ctx = rt.build_context(
        "The user wants to add a new component. What conventions apply?",
        model_context_window=8192,
    )
    print(f"  context length: {len(ctx)} chars")
    print(f"  preview: {ctx[:280]}...")

    # ---- Skills ----
    print("\ningesting a learned skill")
    rt.ingest_skill(
        name="add_component",
        code=(
            "mkdir -p src/components/$Name && "
            "touch src/components/$Name/index.tsx src/components/$Name/$Name.test.tsx"
        ),
        platform="bash",
        persona="frontend-engineer",
        url_pattern="file://*/components/",
        task_keywords=["component", "scaffold", "new"],
        description="Scaffold a new React component with test file",
    )
    print(f"  skills in graph: {len(json.loads(rt.list_skills()))}")

    print("\nfinding the best skill for a context")
    found = rt.find_skill(
        persona="frontend-engineer",
        url="file:///src/components/Button/",
        task="add a new component called Button",
        max_results=1,
    )
    if found != "null":
        # find_skill returns a JSON array; take the top result.
        skill = json.loads(found)[0]
        print(f"  matched: {skill['name']} (score={skill['match_score']:.3f})")
        print(f"  code: {skill['code']}")

    # ---- Report outcomes ----
    print("\nreporting execution outcomes")
    for outcome in ["success", "success", "fail", "success"]:
        stats = json.loads(rt.report_outcome("add_component", outcome))
        print(
            f"  outcome={outcome} → success={stats['success_count']} "
            f"fail={stats['fail_count']} degraded={stats['degraded']}"
        )

    # ---- Persist + reload ----
    print("\npersist + reload memory")
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        path = f.name
    rt.persist_memory(path)
    print(f"  persisted to {path}")

    rt2 = car_runtime.CarRuntime()
    loaded = rt2.load_memory(path)
    print(f"  reloaded into a fresh runtime: {loaded} facts")
    print(f"  roundtrip fact_count matches: {rt2.fact_count() == loaded}")


if __name__ == "__main__":
    main()
