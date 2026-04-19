"""A real agent: read a directory, summarize README files, write a report.

Demonstrates:
  - registering concrete tools (list_dir, read_file, write_file)
  - policies that actually guard something (no writes outside /tmp)
  - tool callback dispatch
  - verify_proposal catching a policy violation before any side-effect

Prereq:
    pip install car-runtime

Run:
    python agent_with_tools.py [path]
"""

import json
import os
import sys
from pathlib import Path

import car_native


# ---------------------------------------------------------------------------
# Tools — plain Python functions. CAR doesn't own them; we dispatch via the
# tool_fn callback below.
# ---------------------------------------------------------------------------

def tool_list_dir(params: dict) -> dict:
    path = Path(params["path"]).expanduser().resolve()
    if not path.is_dir():
        return {"error": f"not a directory: {path}"}
    return {
        "path": str(path),
        "entries": sorted(p.name for p in path.iterdir()),
    }


def tool_read_file(params: dict) -> dict:
    path = Path(params["path"]).expanduser().resolve()
    try:
        return {"path": str(path), "content": path.read_text(errors="replace")[:4000]}
    except OSError as e:
        return {"error": str(e)}


def tool_write_file(params: dict) -> dict:
    path = Path(params["path"]).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(params["content"])
    return {"path": str(path), "bytes": len(params["content"])}


TOOLS = {
    "list_dir":   tool_list_dir,
    "read_file":  tool_read_file,
    "write_file": tool_write_file,
}


def tool_fn(name: str, params_json: str) -> str:
    params = json.loads(params_json)
    fn = TOOLS.get(name)
    if fn is None:
        return json.dumps({"error": f"unknown tool: {name}"})
    return json.dumps(fn(params))


# ---------------------------------------------------------------------------
# Build a proposal that lists, reads, and writes.
# ---------------------------------------------------------------------------

def build_proposal(target_dir: str) -> dict:
    report_path = "/tmp/car_report.md"
    return {
        "actions": [
            {
                "id": "ls",
                "type": "tool_call",
                "tool": "list_dir",
                "parameters": {"path": target_dir},
                "dependencies": [],
            },
            {
                "id": "read_readme",
                "type": "tool_call",
                "tool": "read_file",
                "parameters": {"path": f"{target_dir}/README.md"},
                "dependencies": ["ls"],
            },
            {
                "id": "write_report",
                "type": "tool_call",
                "tool": "write_file",
                "parameters": {
                    "path": report_path,
                    "content": f"# Report for {target_dir}\n\n(contents filled by agent)\n",
                },
                "dependencies": ["read_readme"],
            },
        ]
    }


def main() -> None:
    target = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    print(f"target directory: {target}")

    rt = car_native.CarRuntime()

    # 1. Tools.
    for name in TOOLS:
        rt.register_tool(name)

    # 2. Policies — these run in Rust on every action, before the tool fires.
    rt.register_policy(
        "writes_only_in_tmp",
        "deny_tool_param",
        target="write_file",
        key="path",
        pattern="/etc",
    )
    rt.register_policy(
        "no_read_ssh_keys",
        "deny_tool_param",
        target="read_file",
        key="path",
        pattern=".ssh",
    )

    # 3. Verify the whole plan before executing anything.
    proposal = build_proposal(target)
    check = json.loads(rt.verify_proposal(json.dumps(proposal)))
    print(f"verify: valid={check['valid']} issues={check['issues']}")
    if not check["valid"]:
        raise SystemExit("proposal failed verification")

    # 4. Execute.
    result = json.loads(rt.execute_proposal(json.dumps(proposal), tool_fn))
    print("\nexecution result:")
    print(json.dumps(result, indent=2)[:1200])
    print(f"\nevents logged: {rt.event_count()}")


if __name__ == "__main__":
    main()
