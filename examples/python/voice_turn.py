"""Voice-sidecar dispatch (two-track conversation) — Python.

READ THIS FIRST: the voice-turn flow is DAEMON-ONLY. `dispatch_voice_turn`,
like `infer_stream`, is not exposed through the Python bindings — calling it
raises RuntimeError telling you to use the daemon. This file documents the
shape of the flow and the exact JSON-RPC calls to make; it is a reference, not
a script that drives voice by itself. For a runnable client, start
`car daemon` and follow cookbook 06 (minimal Python WebSocket client) plus
cookbook 13 (voice orchestration).

Demonstrates the voice-turn pattern:
  1. Register a voice-event handler to receive turn events
  2. Dispatch an utterance — get a synchronous turn_id back
  3. Stream fast-track deltas (you render to audio), then sidecar result

In real use the utterance comes from STT (transcribe_stream + the
provider='elevenlabs' realtime path, or local whisper.cpp /
Apple Speech), and the host plays audio from the fast-delta + sidecar
events. CAR does NOT own the speaker — events are pure data.

Prereq:
    pip install car-runtime

Run:
    python voice_turn.py      # prints the flow and the JSON-RPC calls to make
"""

import json
import sys
import time

import car_runtime


def on_voice_event(session_id: str, event_json: str) -> None:
    """Voice-event sink — invoked on every turn event."""
    event = json.loads(event_json)
    kind = event.get("type")
    if kind == "voice.turn.fast_delta":
        # The fast LLM streams text; pipe to your TTS as sentences land.
        sys.stdout.write(event["text"])
        sys.stdout.flush()
    elif kind == "voice.turn.fast_done":
        sys.stdout.write("\n[fast done]\n")
    elif kind == "voice.turn.bridge":
        # Tool-likely utterance — fast track skipped, hardcoded bridge
        # phrase plays while the sidecar runs the substantive query.
        # Prevents the fast model from inventing tool data
        # ("the STRUCTURAL HALLUCINATION FIX" per the proposal).
        print(f'\n[bridge: {event["kind"]}] "{event["phrase"]}"')
    elif kind == "voice.turn.sidecar":
        print(f'\n[sidecar] {event["text"]}')
    elif kind == "voice.turn.error":
        print(f'\n[error] turn {event["turn_id"]}: {event["error"]}', file=sys.stderr)
    elif kind == "voice.turn.cancelled":
        print(f'\n[cancelled] turn {event["turn_id"]}')


def main() -> None:
    rt = car_runtime.CarRuntime()
    car_runtime.register_voice_event_handler(on_voice_event)

    # Best-effort 1-token probe so the fast model is loaded into memory
    # before the first user utterance. Idempotent.
    rt.prewarm_voice_turn()

    # Dispatch a conversational utterance. Returns synchronously with
    # the turn_id; the actual fast/sidecar work happens in the
    # background and surfaces via the event handler above.
    # DAEMON CALL — over ws://127.0.0.1:9100/:
    #   {"jsonrpc":"2.0","id":1,"method":"voice.dispatch_turn",
    #    "params":{"utterance":"Tell me a one-line joke."}}
    # Returns the turn_id synchronously; fast deltas and the sidecar result
    # arrive as voice.event notifications on the same connection.
    print("\ndispatch: voice.dispatch_turn "
          '{"utterance": "Tell me a one-line joke."}')

    # Give the turn time to stream its fast deltas + sidecar resolve.
    # In real use you'd await a completion signal; here we just sleep.
    time.sleep(8)

    # Tool-likely utterance — the classifier routes this to the
    # bridge-phrase + sidecar-only path. The fast track is suppressed.
    print("\ndispatch: voice.dispatch_turn "
          '{"utterance": "What\'s on my calendar tomorrow?"}  '
          "# classifier routes this to bridge-phrase + sidecar-only")
    time.sleep(8)

    # Barge-in / supersede — cancels any in-flight turn. Bumps the
    # current turn id so any straggling sidecar result for the
    # cancelled turn is dropped at its arrival gate.
    rt.cancel_voice_turn()
    print("\ncancelled in-flight turn")


if __name__ == "__main__":
    main()
