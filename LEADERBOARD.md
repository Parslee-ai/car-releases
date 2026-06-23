# CAR agentic benchmark — machine leaderboard

Per-machine, per-model results from `car-bench-run` (the CAR agentic task
suite). Quality is ~machine-independent; **tokens/sec and TTFT are not** —
always read perf alongside its machine. Contribute via
`scripts/bench-contribute.sh` (see `bench/results/agentic/README.md`).

| Model | Track | Machine | Quality | Decode tok/s | TTFT p50 | Attempted | Skipped |
|---|---|---|--:|--:|--:|--:|--:|
| `mlx/gemma-4-12b-it:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 10.2 | 1076ms | 5 | 0 |
| `mlx/gemma-4-12b-it:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 16.1 | 381ms | 6 | 0 |
| `mlx/qwen3-0.6b:6bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | — | — | — | 0 | 5 |
| `mlx/qwen3-0.6b:6bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 107.9 | 26ms | 6 | 0 |
| `mlx/qwen3-1.7b:3bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | — | — | — | 0 | 5 |
| `mlx/qwen3-1.7b:3bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 85.3 | 62ms | 6 | 0 |
| `mlx/qwen3-30b-a3b:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 0.867 | 4.6 | 5568ms | 5 | 0 |
| `mlx/qwen3-30b-a3b:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 7.8 | 1576ms | 6 | 0 |
| `mlx/qwen3-4b:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 0.933 | 8.9 | 459ms | 5 | 0 |
| `mlx/qwen3-4b:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 40.8 | 142ms | 6 | 0 |
| `mlx/qwen3-8b:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 11.2 | 838ms | 5 | 0 |
| `mlx/qwen3-8b:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 22.4 | 256ms | 6 | 0 |

