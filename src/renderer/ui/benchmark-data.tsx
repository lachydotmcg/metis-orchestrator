/** The benchmark's data tables — the wizard's steps, the hardware list, and the
 *  local models it recommends.
 *
 *  First slice of the App.tsx work in docs/STRUCTURAL_DEBT.md item 1. Pure data
 *  with no React in it: no hook, no bridge, no JSX. Moving it is a file move and
 *  an import list, which is what makes it the right thing to do first — 28% of
 *  App.tsx is in that category, and none of it needs the dependency injection
 *  the electron carves did, because there is nothing to inject.
 *
 *  **It is also the data docs/OPEN_QUESTIONS.md is asking about**, and that is
 *  half the reason to lift it out of an 18,000-line file. `GPUS` is six
 *  hand-written entries topping out at a 4090 — no 50-series, no AMD, no Intel,
 *  no laptop parts. `LOCAL_MODELS` carries `tps` figures that were typed rather
 *  than measured. Nothing here probes the machine; the GPU is whichever of the
 *  six you pick. Sitting in its own file that is obvious and editable, rather
 *  than buried at line 1,023 of the renderer.
 *
 *  Three of the six `BENCHMARK_STEPS` — `target`, `profile`, `export` — are
 *  never assigned and never rendered. The six-step flow is described here and
 *  built nowhere.
 */

import { HardDrive, Monitor } from "lucide-react";
export type BenchmarkStep = "welcome" | "target" | "profile" | "running" | "review" | "export";
export type BenchmarkTarget = "local" | "api";
export type BenchmarkProfile = "quick" | "balanced" | "deep";
export type BenchmarkRunStatus = "idle" | "running" | "complete";

export type BenchmarkWizardState = {
  step: BenchmarkStep;
  target: BenchmarkTarget;
  profile: BenchmarkProfile;
  status: BenchmarkRunStatus;
  progress: number;
  completedChecks: string[];
  recommendation: {
    preset: string;
    model: string;
    summary: string;
    next: string[];
  };
  updatedAt?: string;
};

/** The renderer's provider ids. A structural twin of App.tsx's `ProviderId`
 *  rather than an import, because importing it back would make
 *  `App -> benchmark-data -> App`. TypeScript matches by shape. */
type ProviderId =
  | "qwen"
  | "claude"
  | "openai"
  | "gemini"
  | "grok"
  | "deepseek"
  | "glm"
  | "ollama"
  | "nvidia"
  | "groq"
  | "openrouter";

export const BENCHMARK_STEPS: Array<{ key: BenchmarkStep; label: string }> = [
  { key: "welcome", label: "Check" },
  { key: "target", label: "Target" },
  { key: "profile", label: "Profile" },
  { key: "running", label: "Run" },
  { key: "review", label: "Review" },
  { key: "export", label: "Export" }
];

export const BENCHMARK_TARGETS: Array<{ key: BenchmarkTarget; title: string; detail: string; icon: JSX.Element }> = [
  { key: "local", title: "Local model", detail: "Test an Ollama or local runner model on this machine.", icon: <HardDrive size={18} /> },
  { key: "api", title: "API reference", detail: "Prototype the same flow for Claude, OpenAI, Gemini, or OpenRouter.", icon: <Monitor size={18} /> }
];

export const BENCHMARK_PROFILES: Array<{ key: BenchmarkProfile; title: string; detail: string; time: string }> = [
  { key: "quick", title: "Quick smoke", detail: "Small confidence pass for a newly installed model.", time: "5-10 min" },
  { key: "balanced", title: "Balanced study", detail: "Recommended default: quality, speed, memory, and recommendation signal.", time: "20-35 min" },
  { key: "deep", title: "Deep study", detail: "Repeats and harder tasks for publishing or comparing hardware.", time: "60+ min" }
];

export const DEFAULT_BENCHMARK_STATE: BenchmarkWizardState = {
  step: "welcome",
  target: "local",
  profile: "balanced",
  status: "idle",
  progress: 0,
  completedChecks: [],
  recommendation: {
    preset: "Balanced local-first router",
    model: "Qwen local router + Claude frontend fallback",
    summary: "Use local routing for fast/private work, then escalate design-heavy or agentic prompts when confidence drops.",
    next: ["Install the recommended local model", "Run the real Metis CLI bridge when enabled", "Save the resulting router preset"]
  }
};

// Built-in hardware + model-on-hardware data so Metis can recommend local models
// from your GPU/VRAM without forcing a benchmark run.
export type Gpu = { id: string; label: string; vram: number; note: string };
export const GPUS: Gpu[] = [
  { id: "rtx3060", label: "RTX 3060", vram: 8, note: "8 GB" },
  { id: "rtx4070", label: "RTX 4070", vram: 12, note: "12 GB" },
  { id: "rtx4080", label: "RTX 4080", vram: 16, note: "16 GB" },
  { id: "rtx4090", label: "RTX 4090", vram: 24, note: "24 GB" },
  { id: "m3max", label: "Apple M3 Max", vram: 36, note: "36 GB unified" },
  { id: "cpu", label: "CPU only", vram: 0, note: "system RAM" }
];

export type LocalModel = {
  name: string;
  params: string;
  vram: number;
  quant: string;
  tps: number;
  role: string;
  roles?: string[];
  provider?: ProviderId;
  ollamaTag?: string;
};
export const LOCAL_MODELS: LocalModel[] = [
  { name: "Qwen3 1.7B", params: "1.7B", vram: 2, quant: "Q4_K_M", tps: 95, role: "tiny fast router", roles: ["router"], provider: "qwen", ollamaTag: "qwen3:1.7b" },
  { name: "Qwen3 4B", params: "4B", vram: 3.5, quant: "Q4_K_M", tps: 78, role: "fast router / general", roles: ["router", "general"], provider: "qwen", ollamaTag: "qwen3:4b" },
  { name: "Phi-4 Mini 3.8B", params: "3.8B", vram: 3, quant: "Q4_K_M", tps: 70, role: "router / low-VRAM chat", roles: ["router", "general"], ollamaTag: "phi4-mini" },
  { name: "Qwen2.5 7B", params: "7B", vram: 6, quant: "Q4_K_M", tps: 52, role: "fast router / general", roles: ["router", "general"], provider: "qwen", ollamaTag: "qwen2.5:7b" },
  { name: "Llama 3.1 8B", params: "8B", vram: 6.5, quant: "Q4_K_M", tps: 47, role: "general chat", roles: ["general"], ollamaTag: "llama3.1:8b" },
  { name: "Qwen3 8B", params: "8B", vram: 6.5, quant: "Q4_K_M", tps: 45, role: "general / agentic", roles: ["general", "coding"], provider: "qwen", ollamaTag: "qwen3:8b" },
  { name: "GLM-4 9B", params: "9B", vram: 7, quant: "Q4_K_M", tps: 41, role: "chat / agentic", roles: ["general", "coding"], provider: "glm", ollamaTag: "glm4:9b" },
  { name: "Gemma 3 12B", params: "12B", vram: 9, quant: "Q4_K_M", tps: 34, role: "general / planning", roles: ["general", "planning"], ollamaTag: "gemma3:12b" },
  { name: "Mistral Small 24B", params: "24B", vram: 15, quant: "Q4_K_M", tps: 24, role: "coding / tool use", roles: ["coding", "planning"], ollamaTag: "mistral-small:24b" },
  { name: "DeepSeek-R1 Distill 14B", params: "14B", vram: 10, quant: "Q4_K_M", tps: 28, role: "reasoning", roles: ["planning"], provider: "deepseek", ollamaTag: "deepseek-r1:14b" },
  { name: "Phi-4 14B", params: "14B", vram: 10, quant: "Q4_K_M", tps: 27, role: "reasoning / math", roles: ["planning", "coding"], ollamaTag: "phi4" },
  { name: "Qwen3 14B", params: "14B", vram: 10, quant: "Q4_K_M", tps: 26, role: "planning / agentic", roles: ["planning", "coding"], provider: "qwen", ollamaTag: "qwen3:14b" },
  { name: "Qwen2.5 32B", params: "32B", vram: 20, quant: "Q4_K_M", tps: 18, role: "strong coding", roles: ["coding"], provider: "qwen", ollamaTag: "qwen2.5:32b" },
  { name: "Qwen3 32B", params: "32B", vram: 20, quant: "Q4_K_M", tps: 17, role: "strong coding / planning", roles: ["coding", "planning"], provider: "qwen", ollamaTag: "qwen3:32b" },
  { name: "QwQ 32B", params: "32B", vram: 20, quant: "Q4_K_M", tps: 15, role: "deep reasoning", roles: ["planning"], provider: "qwen", ollamaTag: "qwq:32b" },
  { name: "DeepSeek-R1 Distill 32B", params: "32B", vram: 20, quant: "Q4_K_M", tps: 16, role: "reasoning", roles: ["planning"], provider: "deepseek", ollamaTag: "deepseek-r1:32b" },
  { name: "Gemma 3 27B", params: "27B", vram: 17, quant: "Q4_K_M", tps: 19, role: "general / vision-adjacent", roles: ["general", "planning"], ollamaTag: "gemma3:27b" },
  { name: "Ornith 1.0 35B", params: "35B", vram: 22, quant: "Q4_K_M", tps: 16, role: "RL-tuned coding agent", roles: ["coding"] },
  { name: "Qwen2.5 72B", params: "72B", vram: 42, quant: "Q4_K_M", tps: 9, role: "near-frontier local", roles: ["planning", "general"], provider: "qwen", ollamaTag: "qwen2.5:72b" },
  { name: "DeepSeek-R1 Distill 70B", params: "70B", vram: 42, quant: "Q4_K_M", tps: 8, role: "near-frontier reasoning", roles: ["planning"], provider: "deepseek", ollamaTag: "deepseek-r1:70b" },
  { name: "Llama 4 Scout 109B MoE", params: "109B MoE", vram: 36, quant: "Q4_K_M", tps: 22, role: "near-frontier MoE, fast", roles: ["general", "planning"], ollamaTag: "llama4:scout" },
  { name: "Moondream 2", params: "1.8B", vram: 2, quant: "Q4_K_M", tps: 60, role: "tiny vision captioner", roles: ["vision"], ollamaTag: "moondream" },
  { name: "LLaVA 13B", params: "13B", vram: 9, quant: "Q4_K_M", tps: 30, role: "vision + language", roles: ["vision"], ollamaTag: "llava:13b" },
  { name: "Qwen3-VL 8B", params: "8B", vram: 6.5, quant: "Q4_K_M", tps: 40, role: "vision-language", roles: ["vision"], provider: "qwen", ollamaTag: "qwen3-vl:8b" },
  { name: "Qwen3-VL 32B", params: "32B", vram: 20, quant: "Q4_K_M", tps: 15, role: "strong vision-language", roles: ["vision"], provider: "qwen", ollamaTag: "qwen3-vl:32b" },
  { name: "Nomic Embed Text", params: "137M", vram: 1, quant: "F16", tps: 200, role: "text embeddings", roles: ["embeddings"], ollamaTag: "nomic-embed-text" },
  { name: "MxBai Embed Large", params: "335M", vram: 1, quant: "F16", tps: 160, role: "text embeddings, higher quality", roles: ["embeddings"], ollamaTag: "mxbai-embed-large" },
  { name: "Qwen3 Embedding 4B", params: "4B", vram: 3.5, quant: "Q4_K_M", tps: 90, role: "multilingual embeddings", roles: ["embeddings"], provider: "qwen", ollamaTag: "qwen3-embedding:4b" }
];
