# CAR agentic benchmark — machine leaderboard

Per-machine, per-model results from `car-bench-run` (the CAR agentic task
suite). Quality is ~machine-independent; **tokens/sec and TTFT are not** —
always read perf alongside its machine. Contribute via
`scripts/bench-contribute.sh` (see `bench/results/agentic/README.md`).

| Model | Track | Machine | Quality | Decode tok/s | TTFT p50 | Attempted | Skipped |
|---|---|---|--:|--:|--:|--:|--:|
| `claude-opus-4-8` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 90.7 | — | 8 | 0 |
| `gpt-5.5` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.952 | 64.7 | — | 8 | 0 |
| `mlx/gemma-4-12b-it:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 10.2 | 1076ms | 5 | 0 |
| `mlx/gemma-4-12b-it:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 16.1 | 381ms | 6 | 0 |
| `mlx/gemma-4-12b-it:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.835 | 13.2 | 686ms | 8 | 0 |
| `mlx/qwen3-0.6b:6bit` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `mlx/qwen3-0.6b:6bit` | agentic | aarch64 / 64GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `mlx/qwen3-0.6b:6bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | — | — | — | 0 | 5 |
| `mlx/qwen3-0.6b:6bit` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 86.0 | 21ms | 6 | 0 |
| `mlx/qwen3-0.6b:6bit` | core | aarch64 / 64GB / metal (Apple M4 Max) | 1.000 | — | 105949ms | 6 | 0 |
| `mlx/qwen3-0.6b:6bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 107.9 | 26ms | 6 | 0 |
| `mlx/qwen3-1.7b:3bit` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `mlx/qwen3-1.7b:3bit` | agentic | aarch64 / 64GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `mlx/qwen3-1.7b:3bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | — | — | — | 0 | 5 |
| `mlx/qwen3-1.7b:3bit` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 93.7 | 46ms | 6 | 0 |
| `mlx/qwen3-1.7b:3bit` | core | aarch64 / 64GB / metal (Apple M4 Max) | 1.000 | — | 241614ms | 6 | 0 |
| `mlx/qwen3-1.7b:3bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 85.3 | 62ms | 6 | 0 |
| `mlx/qwen3-30b-a3b:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 0.867 | 4.6 | 5568ms | 5 | 0 |
| `mlx/qwen3-30b-a3b:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 7.8 | 1576ms | 6 | 0 |
| `mlx/qwen3-30b-a3b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.605 | 13.2 | 4711ms | 8 | 0 |
| `mlx/qwen3-4b:4bit` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | 0.933 | 33.0 | 322ms | 5 | 0 |
| `mlx/qwen3-4b:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 0.933 | 8.9 | 459ms | 5 | 0 |
| `mlx/qwen3-4b:4bit` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 46.1 | 102ms | 6 | 0 |
| `mlx/qwen3-4b:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 40.8 | 142ms | 6 | 0 |
| `mlx/qwen3-4b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.542 | 25.7 | 294ms | 8 | 0 |
| `mlx/qwen3-8b:4bit` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 21.1 | 573ms | 5 | 0 |
| `mlx/qwen3-8b:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 11.2 | 838ms | 5 | 0 |
| `mlx/qwen3-8b:4bit` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 28.4 | 174ms | 6 | 0 |
| `mlx/qwen3-8b:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 22.4 | 256ms | 6 | 0 |
| `mlx/qwen3-8b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.765 | 24.4 | 451ms | 8 | 0 |
| `qwen/qwen3-1.7b:q8_0` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `qwen/qwen3-1.7b:q8_0` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 94.8 | 46ms | 6 | 0 |
| `qwen/qwen3-4b:q4_k_m` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | 0.933 | 33.0 | 331ms | 5 | 0 |
| `qwen/qwen3-4b:q4_k_m` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 46.4 | 103ms | 6 | 0 |
| `qwen/qwen3-8b:q4_k_m` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 20.7 | 633ms | 5 | 0 |
| `qwen/qwen3-8b:q4_k_m` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 28.0 | 188ms | 6 | 0 |

