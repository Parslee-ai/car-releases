// Voice-sidecar dispatch (two-track conversation) — Node.js.
//
// READ THIS FIRST: the voice-turn flow is DAEMON-ONLY. `dispatchVoiceTurn`,
// like `inferStream`, `transcribeStream` and `ttsStreamStart`, is not exposed
// through the bindings — calling it throws, pointing at the daemon. This file
// documents the flow and the exact JSON-RPC calls; it is a reference, not a
// script that drives voice by itself. For a runnable client, start
// `car daemon` and follow cookbook 06 (WebSocket client) and 13 (voice).
//
// Demonstrates the voice-turn pattern:
//   1. Register a voice-event handler to receive turn events
//   2. Dispatch an utterance — get a synchronous turn_id back
//   3. Stream fast-track deltas (you render to audio), then sidecar result
//
// In real use the utterance comes from STT (transcribeStream + the
// `provider: 'elevenlabs'` realtime path, or local whisper.cpp /
// Apple Speech), and the host plays audio from the fast-delta + sidecar
// events. CAR does NOT own the speaker — events are pure data.
//
// Prereq:
//   npm install car-runtime
//
// Run:
//   node voice-turn.js

const {
  CarRuntime,
  registerVoiceEventHandler,
  cancelVoiceTurn,
  prewarmVoiceTurn,
} = require('car-runtime');

async function main() {
  const rt = new CarRuntime();

  // Best-effort 1-token probe so the fast model is loaded into memory
  // before the first user utterance. Idempotent. Errors are logged
  // server-side but don't reject — voice startup races inference cold-start.
  await prewarmVoiceTurn(rt);

  // The voice-event handler receives every turn event as JSON. The
  // session id is empty string ('') for turns that aren't bound to a
  // streaming STT session. In production you'd dispatch each event
  // type to your audio renderer.
  registerVoiceEventHandler((sessionId, eventJson) => {
    const event = JSON.parse(eventJson);
    switch (event.type) {
      case 'voice.turn.fast_delta':
        // The fast LLM streams text; pipe to your TTS as sentences land.
        process.stdout.write(event.text);
        break;
      case 'voice.turn.fast_done':
        process.stdout.write('\n[fast done]\n');
        break;
      case 'voice.turn.bridge':
        // Tool-likely utterance — fast track skipped, hardcoded bridge
        // phrase plays while the sidecar runs the substantive query.
        // Prevents the fast model from inventing tool data ("the
        // STRUCTURAL HALLUCINATION FIX" per the proposal).
        console.log(`\n[bridge: ${event.kind}] "${event.phrase}"`);
        break;
      case 'voice.turn.sidecar':
        console.log(`\n[sidecar] ${event.text}`);
        break;
      case 'voice.turn.error':
        console.error(`\n[error] turn ${event.turn_id}: ${event.error}`);
        break;
      case 'voice.turn.cancelled':
        console.log(`\n[cancelled] turn ${event.turn_id}`);
        break;
    }
  });

  // Dispatch a conversational utterance. Returns synchronously with
  // the turn_id; the actual fast/sidecar work happens in the
  // background and surfaces via the event handler above.
  // DAEMON CALL — over ws://127.0.0.1:9100/:
  //   {"jsonrpc":"2.0","id":1,"method":"voice.dispatch_turn",
  //    "params":{"utterance":"Tell me a one-line joke."}}
  // Returns the turn_id synchronously; fast deltas and the sidecar result
  // arrive as voice.event notifications on the same connection.
  console.log('\ndispatch: voice.dispatch_turn',
    JSON.stringify({ utterance: 'Tell me a one-line joke.' }));

  // Tool-likely utterance — the classifier routes this to the
  // bridge-phrase + sidecar-only path. The fast track is suppressed.
  console.log('\ndispatch: voice.dispatch_turn',
    JSON.stringify({ utterance: "What's on my calendar tomorrow?" }),
    '# classifier routes this to bridge-phrase + sidecar-only');

  // Barge-in / supersede — cancels any in-flight turn. Bumps the
  // current turn id so any straggling sidecar result for the
  // cancelled turn is dropped at its arrival gate.
  await cancelVoiceTurn(rt);
  console.log('\ncancelled in-flight turn');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
