# CAR agentic benchmark — machine leaderboard

Per-machine, per-model results from `car-bench-run` (the CAR agentic task
suite). Quality is ~machine-independent; **tokens/sec and TTFT are not** —
always read perf alongside its machine. Contribute via
`scripts/bench-contribute.sh` (see `bench/results/agentic/README.md`).

| Model | Track | Machine | Quality | Decode tok/s | TTFT p50 | Attempted | Skipped |
|---|---|---|--:|--:|--:|--:|--:|
| `anthropic/claude-fable-5:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.816 | 56.5 | — | 17 | 0 |
| `anthropic/claude-haiku-4-5:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.491 | 115.8 | — | 17 | 0 |
| `anthropic/claude-opus-4-6:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.770 | 56.6 | — | 17 | 0 |
| `anthropic/claude-opus-4-7:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.841 | 89.1 | — | 17 | 0 |
| `anthropic/claude-opus-4-8` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.836 | 92.6 | — | 17 | 0 |
| `anthropic/claude-opus-4-8` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.861 | 95.2 | — | 17 | 0 |
| `anthropic/claude-opus-5:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.765 | 51.5 | — | 17 | 0 |
| `anthropic/claude-sonnet-4-5:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.621 | 67.8 | — | 17 | 0 |
| `anthropic/claude-sonnet-4-6:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.800 | 66.1 | — | 17 | 0 |
| `anthropic/claude-sonnet-5:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.814 | 72.5 | — | 17 | 0 |
| `apple/foundation:default` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.282 | 49.8 | — | 17 | 0 |
| `mlx/gemma-4-12b-it:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 10.2 | 1076ms | 5 | 0 |
| `mlx/gemma-4-12b-it:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 16.1 | 381ms | 6 | 0 |
| `mlx/gemma-4-12b-it:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.485 | 30.3 | 238ms | 17 | 0 |
| `mlx/qwen3-0.6b:6bit` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `mlx/qwen3-0.6b:6bit` | agentic | aarch64 / 64GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `mlx/qwen3-0.6b:6bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | — | — | — | 0 | 5 |
| `mlx/qwen3-0.6b:6bit` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 86.0 | 21ms | 6 | 0 |
| `mlx/qwen3-0.6b:6bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 107.9 | 26ms | 6 | 0 |
| `mlx/qwen3-0.6b:6bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.130 | 33.1 | 46ms | 17 | 0 |
| `mlx/qwen3-1.7b:3bit` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `mlx/qwen3-1.7b:3bit` | agentic | aarch64 / 64GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `mlx/qwen3-1.7b:3bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | — | — | — | 0 | 5 |
| `mlx/qwen3-1.7b:3bit` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 93.7 | 46ms | 6 | 0 |
| `mlx/qwen3-1.7b:3bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 85.3 | 62ms | 6 | 0 |
| `mlx/qwen3-1.7b:3bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.045 | 56.3 | 47ms | 17 | 0 |
| `mlx/qwen3-30b-a3b:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 0.867 | 4.6 | 5568ms | 5 | 0 |
| `mlx/qwen3-30b-a3b:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 7.8 | 1576ms | 6 | 0 |
| `mlx/qwen3-30b-a3b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.456 | 26.0 | 311ms | 17 | 0 |
| `mlx/qwen3-30b-a3b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.484 | 29.0 | 326ms | 17 | 0 |
| `mlx/qwen3-4b:4bit` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | 0.933 | 33.0 | 322ms | 5 | 0 |
| `mlx/qwen3-4b:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 0.933 | 8.9 | 459ms | 5 | 0 |
| `mlx/qwen3-4b:4bit` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 46.1 | 102ms | 6 | 0 |
| `mlx/qwen3-4b:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 40.8 | 142ms | 6 | 0 |
| `mlx/qwen3-4b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.366 | 22.7 | 82ms | 17 | 0 |
| `mlx/qwen3-4b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.374 | 23.3 | 78ms | 17 | 0 |
| `mlx/qwen3-8b:4bit` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 21.1 | 573ms | 5 | 0 |
| `mlx/qwen3-8b:4bit` | agentic | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 11.2 | 838ms | 5 | 0 |
| `mlx/qwen3-8b:4bit` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 28.4 | 174ms | 6 | 0 |
| `mlx/qwen3-8b:4bit` | core | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 22.4 | 256ms | 6 | 0 |
| `mlx/qwen3-8b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.439 | 20.2 | 153ms | 17 | 0 |
| `openai/gpt-4.1-mini:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.645 | 148.3 | — | 17 | 0 |
| `openai/gpt-5.3-codex:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.772 | 84.6 | — | 17 | 0 |
| `openai/gpt-5.4-mini:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.542 | 220.5 | — | 17 | 0 |
| `openai/gpt-5.4:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.792 | 76.9 | — | 17 | 0 |
| `openai/gpt-5.5-2026-04-23` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.836 | 73.5 | — | 17 | 0 |
| `openai/gpt-5.5:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.875 | 71.5 | — | 17 | 0 |
| `openai/gpt-5.6-luna:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.847 | 97.7 | — | 17 | 0 |
| `openai/gpt-5.6-sol:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.934 | 68.7 | — | 17 | 0 |
| `openai/gpt-5.6-sol:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.941 | 70.4 | — | 17 | 0 |
| `openai/gpt-5.6-terra:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.875 | 88.1 | — | 17 | 0 |
| `openai/gpt-5.6-terra:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.926 | 88.3 | — | 17 | 0 |
| `openai/gpt-6.1-sol:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 51.6 | — | 17 | 0 |
| `openai/gpt-6.1-sol:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 1.000 | 60.7 | — | 17 | 0 |
| `openai/o3:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.770 | 138.4 | — | 17 | 0 |
| `openai/o4-mini:latest` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | could not run (2026-10-27) | — | — | 0 | 0 |
| `parslee/advisor` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.919 | 74.9 | — | 17 | 0 |
| `parslee/fast` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.926 | 63.8 | — | 17 | 0 |
| `parslee/reasoning` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.890 | 70.4 | — | 17 | 0 |
| `qwen/qwen3-1.7b:q8_0` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | — | — | — | 0 | 5 |
| `qwen/qwen3-1.7b:q8_0` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 94.8 | 46ms | 6 | 0 |
| `qwen/qwen3-4b:q4_k_m` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | 0.933 | 33.0 | 331ms | 5 | 0 |
| `qwen/qwen3-4b:q4_k_m` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 46.4 | 103ms | 6 | 0 |
| `qwen/qwen3-8b:q4_k_m` | agentic | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 20.7 | 633ms | 5 | 0 |
| `qwen/qwen3-8b:q4_k_m` | core | aarch64 / 36GB / metal (Apple M4 Max) | 1.000 | 28.0 | 188ms | 6 | 0 |
| `vllm-mlx/devstral-small-2-24b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.336 | 15.5 | — | 17 | 0 |
| `vllm-mlx/devstral-small-2-24b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.358 | 15.8 | — | 17 | 0 |
| `vllm-mlx/gemma-4-12b-it` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.408 | 31.0 | — | 17 | 0 |
| `vllm-mlx/gemma-4-26b-a4b-it` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.650 | 56.1 | — | 17 | 0 |
| `vllm-mlx/gemma-4-26b-a4b-it` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.658 | 29.3 | — | 17 | 0 |
| `vllm-mlx/gemma-4-26b-a4b-it` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.664 | 29.6 | — | 17 | 0 |
| `vllm-mlx/gemma-4-31b-it:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.458 | 8.6 | — | 17 | 0 |
| `vllm-mlx/gemma-4-31b-it:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.532 | 5.7 | — | 17 | 0 |
| `vllm-mlx/gemma-4-e2b-it` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.333 | 81.7 | — | 17 | 0 |
| `vllm-mlx/gemma-4-e2b-it` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.336 | 59.0 | — | 17 | 0 |
| `vllm-mlx/gemma-4-e4b-it` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.505 | 45.4 | — | 17 | 0 |
| `vllm-mlx/gemma-4-e4b-it` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.525 | 32.0 | — | 17 | 0 |
| `vllm-mlx/gemma-4-e4b-it` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.533 | 35.8 | — | 17 | 0 |
| `vllm-mlx/glm-4.7-flash:8bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.402 | 46.7 | — | 17 | 0 |
| `vllm-mlx/gpt-oss-20b:mxfp4` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.487 | 67.1 | — | 17 | 0 |
| `vllm-mlx/gpt-oss-20b:mxfp4` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.516 | 68.3 | — | 17 | 0 |
| `vllm-mlx/qwen3.5-0.8b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.039 | 340.6 | — | 17 | 0 |
| `vllm-mlx/qwen3.5-2b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.078 | 161.7 | — | 17 | 0 |
| `vllm-mlx/qwen3.5-4b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.412 | 51.3 | — | 17 | 0 |
| `vllm-mlx/qwen3.5-9b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.424 | 47.6 | — | 17 | 0 |
| `vllm-mlx/qwen3.5-9b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.427 | 52.4 | — | 17 | 0 |
| `vllm-mlx/qwen3.6-35b-a3b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.511 | 82.5 | — | 17 | 0 |
| `vllm-mlx/qwen3.6-35b-a3b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.517 | 83.9 | — | 17 | 0 |
| `vllm-mlx/qwen3.8-27b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.618 | 24.4 | — | 17 | 0 |
| `vllm-mlx/qwen3.8-27b:4bit` | judged | aarch64 / 64GB / metal (Apple M5 Pro) | 0.635 | 26.2 | — | 17 | 0 |

