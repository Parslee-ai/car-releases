"""Local inference example.

Uses CAR's managed local model registry. The first run downloads weights, so
the first call can take minutes; later ones are fast.

Prereq:
    pip install car-runtime
    car setup          # pick and install a local model, once per machine

Run:
    python inference.py
"""

import json

import car_runtime


def main() -> None:
    rt = car_runtime.CarRuntime()

    # NOTE ON STREAMING: `rt.infer_stream(...)` is NOT available through the
    # Python bindings — it is an ABI-compatibility stub that always raises
    # RuntimeError. Token-by-token streaming lives on the daemon's WebSocket:
    # connect to ws://127.0.0.1:9100/ (start it with `car daemon`), call the
    # `infer_stream` JSON-RPC method, and read `inference.stream.event`
    # notifications. See docs/websocket-protocol.md, and cookbook 06 for a
    # minimal Python WebSocket client.
    #
    # One-shot tracked call returns the text plus usage + tool_calls.
    tracked = json.loads(
        rt.infer_tracked("Say 'CAR online' and nothing else.", max_tokens=32)
    )
    print("\ntracked:", tracked.get("text"))
    print("usage:", tracked.get("usage"))


if __name__ == "__main__":
    main()
