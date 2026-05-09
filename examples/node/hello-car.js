// Minimal CAR example in Node.js.
//
// Prereq: download a platform tarball from this repo's latest release and
// extract. Adjust the require() path below to the matching .node file.
//
//   curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-darwin-arm64.tar.gz | tar -xz
//
// Or via npm (handles platform resolution automatically):
//   npm install car-runtime
//
// Run:
//   node hello-car.js

const path = require('node:path');

// Pick the binary for your platform (darwin-arm64, darwin-x64, linux-x64-gnu,
// linux-arm64-gnu). Defaults to resolving from the current dir.
function loadNative() {
  const byPlatform = {
    'darwin-arm64': 'car-runtime.darwin-arm64.node',
    'darwin-x64':   'car-runtime.darwin-x64.node',
    'linux-x64':    'car-runtime.linux-x64-gnu.node',
    'linux-arm64':  'car-runtime.linux-arm64-gnu.node',
  };
  const key = `${process.platform}-${process.arch}`;
  const file = byPlatform[key];
  if (!file) throw new Error(`no CAR native binary for ${key}`);
  return require(path.resolve(process.cwd(), file));
}

async function main() {
  const native = loadNative();
  const rt = new native.CarRuntime();

  // 1. Register a tool + a policy.
  await rt.registerTool('echo');
  await rt.registerPolicy('no_rm', 'deny_tool_param', 'echo', 'msg', 'rm -rf');

  // 2. Seed a fact.
  rt.addFact('greeting', 'hello from CAR', 'pattern');
  console.log('facts:', rt.factCount());

  // 3. Verify.
  const proposal = JSON.stringify({
    actions: [
      { id: 'a1', type: 'tool_call', tool: 'echo', parameters: { msg: 'hello' }, dependencies: [] },
    ],
  });
  const report = JSON.parse(await rt.verifyProposal(proposal));
  console.log('verify:', report.valid);

  // 4. Execute with a JS tool callback.
  const result = await native.executeProposal(rt, proposal, async (callJson) => {
    const { tool, params } = JSON.parse(callJson);
    console.log(`  [${tool}] echoed: ${params.msg}`);
    return JSON.stringify({ ok: true, echoed: params.msg });
  });

  console.log('result:', JSON.parse(result));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
