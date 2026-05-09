"""Local inference + streaming example.

Uses CAR's managed local model registry. The first run will download weights.

Prereq:
    pip install car-runtime

Run:
    python inference.py
"""

import json
import sys

import car_runtime


def main() -> None:
    rt = car_runtime.CarRuntime()

    # Streaming — token-by-token.
    def on_event(event_json: str) -> None:
        e = json.loads(event_json)
        if e["type"] == "text":
            sys.stdout.write(e["data"])
            sys.stdout.flush()
        elif e["type"] == "done":
            print()  # final newline

    print("streaming inference:")
    rt.infer_stream(
        "Describe the Common Agent Runtime in one paragraph.",
        on_event,
        max_tokens=256,
    )

    # One-shot tracked call returns usage + tool_calls.
    tracked = json.loads(
        rt.infer_tracked("Say 'CAR online' and nothing else.", max_tokens=32)
    )
    print("\ntracked:", tracked.get("text"))
    print("usage:", tracked.get("usage"))


if __name__ == "__main__":
    main()
