"""Minimal CAR example: state, facts, verify + execute a proposal.

Prereq:
    pip install https://github.com/Parslee-ai/car-releases/releases/download/v0.3.0/<your-platform>.whl

Run:
    python hello_car.py
"""

import json

import car_native


def main() -> None:
    rt = car_native.CarRuntime()

    # 1. Register a tool (you provide the implementation via callback).
    rt.register_tool("echo")

    # 2. Register a policy enforced by the runtime.
    rt.register_policy(
        "no_dangerous_shell",
        "deny_tool_param",
        target="echo",
        key="msg",
        pattern="rm -rf",
    )

    # 3. Seed a fact.
    rt.add_fact("greeting", "hello from CAR", "pattern")
    print("facts:", rt.fact_count())

    # 4. Verify a proposal before executing it.
    proposal = json.dumps(
        {
            "actions": [
                {
                    "id": "a1",
                    "type": "tool_call",
                    "tool": "echo",
                    "parameters": {"msg": "hello"},
                    "dependencies": [],
                }
            ]
        }
    )
    report = json.loads(rt.verify_proposal(proposal))
    print("verify:", report["valid"])

    # 5. Execute with a Python tool callback.
    def tool_fn(tool: str, params_json: str) -> str:
        params = json.loads(params_json)
        print(f"  [{tool}] echoed: {params['msg']}")
        return json.dumps({"ok": True, "echoed": params["msg"]})

    result = json.loads(rt.execute_proposal(proposal, tool_fn))
    print("result:", result)


if __name__ == "__main__":
    main()
