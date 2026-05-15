// Voice-sidecar dispatch (two-track conversation) — Node.js.
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
  dispatchVoiceTurn,
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
  const conversational = await dispatchVoiceTurn(
    rt,
    JSON.stringify({ utterance: 'Tell me a one-line joke.' }),
  );
  console.log('\nstarted turn:', conversational);

  // Give the turn time to stream its fast deltas + sidecar resolve.
  // In real use you'd await some completion signal; here we just sleep.
  await new Promise((r) => setTimeout(r, 8000));

  // Tool-likely utterance — the classifier routes this to the
  // bridge-phrase + sidecar-only path. The fast track is suppressed.
  const toolish = await dispatchVoiceTurn(
    rt,
    JSON.stringify({ utterance: "What's on my calendar tomorrow?" }),
  );
  console.log('\nstarted tool-likely turn:', toolish);
  await new Promise((r) => setTimeout(r, 8000));

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
