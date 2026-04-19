// Multi-agent pipeline + skill distillation + evolution (JS).
//
// Parity with examples/python/multi_agent.py. The agent callback is
// deterministic so the example is reproducible without an LLM;
// in production swap it for a real Anthropic / OpenAI / local call.
//
// Prereq:
//   npm install car-runtime
//
// Run:
//   node multi-agent.js

const { registerAgentRunner, runPipeline, CarRuntime } = require('car-runtime');

// ----------------------------------------------------------------------------
// Agent callback: deterministic per role for reproducibility.
// ----------------------------------------------------------------------------

let seed = 42;
function rand() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

async function agentFn(specJson, task) {
  const spec = JSON.parse(specJson);
  const role = spec.name;
  const base = { name: role, turns: 1, tool_calls: 0, duration_ms: 1.0 };

  if (role === 'web_scraper') {
    const ok = rand() > 0.25;
    if (!ok) {
      return JSON.stringify({ ...base, answer: '', error: 'timeout fetching page' });
    }
    return JSON.stringify({ ...base, answer: `scraped data for: ${task}`, tool_calls: 1 });
  }

  if (role === 'summarizer') {
    return JSON.stringify({ ...base, answer: `summary: ${task.slice(0, 40)}...` });
  }

  return JSON.stringify({ ...base, answer: '(no-op)' });
}

// ----------------------------------------------------------------------------
// Synthesize trace events from pipeline output — success or failure per stage.
// ----------------------------------------------------------------------------

async function runRound() {
  const stages = JSON.stringify([
    {
      name: 'web_scraper',
      system_prompt: 'scrape web pages',
      tools: ['http_get'],
      max_turns: 3,
      metadata: { domain: 'web' },
    },
    {
      name: 'summarizer',
      system_prompt: 'summarize text',
      tools: [],
      max_turns: 1,
      metadata: { domain: 'text' },
    },
  ]);

  const trace = [];
  for (let i = 0; i < 6; i++) {
    const task = `research topic #${i}`;
    const result = JSON.parse(await runPipeline(stages, task));

    for (const stageName of ['web_scraper', 'summarizer']) {
      const stage = (result.stages || []).find((s) => s.name === stageName);
      if (!stage) continue;
      const kind = stage.error ? 'action_failed' : 'action_succeeded';
      trace.push({
        kind,
        action_id: `round${i}_${stageName}`,
        tool: stageName,
        data: { task, role: stageName },
        reward: stage.error ? 0.0 : 1.0,
      });
    }
  }
  return trace;
}

// ----------------------------------------------------------------------------

// Pre-built skills — shape matches what `rt.distillSkills(trace)` would
// produce. Hand-crafted here so the example doesn't require a configured
// inference engine.
const DEMO_SKILLS = [
  {
    name: 'scrape_and_summarize',
    description: 'Fetch a page, clean the text, pass to a summarizer agent.',
    when_to_apply: 'User asks for the essence of a linked resource.',
    scope: { domain: 'web' },
    source: 'success',
    domain: 'web',
    trigger: {
      persona: 'researcher',
      url_pattern: 'https://*',
      task_keywords: ['summarize', 'article', 'link'],
    },
    code: 'http_get(url) → clean_html → summarize',
  },
  {
    name: 'write_concise_summary',
    description: 'Produce a 2-sentence summary of a text input.',
    when_to_apply: 'After a scrape or a long-form content read.',
    scope: { domain: 'text' },
    source: 'success',
    domain: 'text',
    trigger: { persona: 'summarizer', url_pattern: '', task_keywords: ['summarize', 'brief'] },
    code: 'first_2_sentences(input)',
  },
];

async function main() {
  const rt = new CarRuntime();
  await registerAgentRunner(agentFn);

  console.log('round 1: pipeline runs');
  const trace = await runRound();
  const successes = trace.filter((e) => e.kind === 'action_succeeded').length;
  const failures = trace.filter((e) => e.kind === 'action_failed').length;
  console.log(`  successes: ${successes}, failures: ${failures}`);

  // In production:
  //   const skillsJson = await rt.distillSkills(JSON.stringify(trace));
  // Here we use the pre-built DEMO_SKILLS so the example runs offline.
  console.log('\ningesting skills into the memory graph');
  const ingested = rt.ingestDistilledSkills(JSON.stringify(DEMO_SKILLS));
  console.log(`  ingested: ${ingested}`);
  console.log('  skills in graph:', JSON.parse(rt.listSkills()).length);

  console.log('\nreporting outcomes to simulate real use');
  for (let i = 0; i < 4; i++) rt.reportOutcome('scrape_and_summarize', 'success');
  for (let i = 0; i < 3; i++) rt.reportOutcome('scrape_and_summarize', 'fail');
  for (let i = 0; i < 2; i++) rt.reportOutcome('write_concise_summary', 'success');

  console.log('\nchecking which domains need evolution');
  const weak = rt.domainsNeedingEvolution(0.6);
  console.log(`  weak domains: ${weak.length ? weak.join(', ') : 'none'}`);

  if (weak.length > 0) {
    const domain = weak[0];
    console.log(`\nwould evolve skills for '${domain}' here. In production:`);
    console.log(`    evolved = await rt.evolveSkills(JSON.stringify(trace), '${domain}')`);
    console.log('  (skipped — requires a configured inference engine)');
  }

  console.log('\nround 2: pipeline re-runs (skills now in memory)');
  const trace2 = await runRound();
  const s2 = trace2.filter((e) => e.kind === 'action_succeeded').length;
  const f2 = trace2.filter((e) => e.kind === 'action_failed').length;
  console.log(`  successes: ${s2}, failures: ${f2}`);

  console.log('\nfinal skill inventory:');
  for (const skill of JSON.parse(rt.listSkills())) {
    const desc = (skill.description || '').slice(0, 60);
    console.log(`  - ${skill.name}: ${desc}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
