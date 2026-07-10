import {
  type CSSProperties,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Cable,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CheckCircle2,
  Circle,
  ClipboardList,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FilePlus,
  FileText,
  Folder,
  GalleryHorizontalEnd,
  GitBranch,
  GitFork,
  Github,
  Globe,
  HardDrive,
  HelpCircle,
  ImageIcon,
  ImagePlus,
  Layers,
  ListTodo,
  LogOut,
  Loader2,
  Maximize2,
  Menu,
  Mic,
  MessageCircle,
  Minus,
  Monitor,
  MoreHorizontal,
  MoreVertical,
  Network,
  Newspaper,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  PanelRightClose,
  PanelRightOpen,
  ScrollText,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Terminal,
  Trash2,
  Upload,
  Wand2,
  Waypoints,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type {
  AuditEvent,
  CatalogModel,
  ConversationRecord,
  ConversationTurnRecord,
  GraphPipelineConfig,
  GraphPipelineStage,
  ManagerChatMessage,
  ModelCatalogState,
  OllamaListResult,
  OllamaPullProgress,
  PermissionGrant,
  PermissionMode,
  PermissionScope,
  PolicyDecisionResult,
  PolicyStatus,
  ProviderKey,
  ProviderStatus,
  ProjectSnapshot,
  ProjectWorkspace,
  ProjectWorkspaceResource,
  AgentOperation,
  PulseFeed,
  RegistryPackage,
  RegistryPackageKind,
  RegistryState,
  Routine,
  SessionAttachment,
  SessionRun,
  SessionRunInput,
  SessionPipelineStep,
  SessionStreamEvent,
  SessionTimelineEvent,
  SecretStatus,
  StyleCard,
  UpdateCheckResult
} from "../../shared/runtime-contracts";

/** Narrows SessionStreamEvent down to the `stage_call` variant (docs/FABLE_PLANS.md
 *  §26) so ConversationTurn and the side-chat stack can reference its `call`
 *  shape without repeating the union. */
type StageCallEvent = Extract<SessionStreamEvent, { kind: "stage_call" }>;

type NavKey = "session" | "orchestration" | "routines" | "marketplace" | "gallery" | "graph" | "benchmark" | "todo" | "manager" | "settings" | "pulse";
type NodeKind = "router" | "agent" | "skill";

type ProviderId =
  | "qwen"
  | "claude"
  | "openai"
  | "gemini"
  | "grok"
  | "deepseek"
  | "glm"
  | "nvidia"
  | "groq";

type Vec = { x: number; y: number };
type ModelRef = { provider: ProviderId; model: string };
type ProjectFolder = { name: string; latest: string; age: string; path?: string };

type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  pos: Vec;
  provider?: ProviderId;
  model?: string;
  fallbacks?: ModelRef[];
  intent?: string;
  skills?: string[];
  temperature?: number;
  /** @deprecated "Access via" override (docs/FABLE_PLANS.md section 21) —
   *  superseded by `gateway` (section 25 update). Kept only so loadNodes can
   *  migrate old persisted graphs: on load, an existing `accessVia` with no
   *  `gateway` set becomes the node's `gateway`. Not written by the
   *  NodeInspector anymore; do not read it directly elsewhere. */
  accessVia?: ProviderId;
  /** Gateway (docs/FABLE_PLANS.md section 25, renamed from "Access via"):
   *  pins this node's primary model to a specific route provider instead of
   *  Auto resolution. Persisted with the rest of the graph node state (see
   *  the GraphWorkspace localStorage effect) and projected into
   *  GraphPipelineStage.gateway by projectGraphPipeline for main.ts to
   *  consume as the stage's first route preference. */
  gateway?: ProviderId;
  /** Gateway fallbacks (docs/FABLE_PLANS.md section 25): an ordered list of
   *  additional route providers to try, in order, after `gateway` and before
   *  falling through to the model's remaining routes by health. Mirrors the
   *  per-node model fallback chain's interaction pattern (add/remove/promote). */
  gatewayFallbacks?: ProviderId[];
};

type DragPayload =
  | { kind: "skill"; name: string }
  | { kind: "model"; provider: ProviderId; model: string };

type RouteSegment = { from: Vec; to: Vec };

/** A user-authored local skill (text-based for now; file-based can follow later).
 *  Persisted under the `customSkills` app-store key (docs/FABLE_PLANS.md section 18). */
type CustomSkill = { id: string; name: string; description?: string };
// Stable empty-array fallbacks for useAppStoreState: an inline `[] as T[]` literal is a fresh
// reference every render, which re-fires the store's load effect and can stomp a just-written
// update before it's ever persisted. Module-level constants keep the reference stable.
const EMPTY_CUSTOM_SKILLS: CustomSkill[] = [];
const EMPTY_STARRED_PACKAGES: string[] = [];

type GhostDrag = { payload: DragPayload };
type RouteTestState = { agentId: string; status: "running" | "complete" | "error"; startedAt: number; completedAt?: number; message?: string };
type ProviderConnectionState = "connected" | "local" | "missing" | "unknown";

/** One row of the real Run Test popover — an agent node's configured model plus its live
 *  health (docs/FABLE_PLANS.md section 18; folds the old titlebar health sweep in here). */
type RunTestAgentRow = { id: string; name: string; model: string; status: HealthRowStatus; detail: string };
type RunTestResult = {
  routeLabel: string;
  routeDetail: string;
  routeStatus: HealthRowStatus;
  agents: RunTestAgentRow[];
};

type MemoryNodeType = "home" | "project" | "folder" | "note" | "date" | "file" | "conversation" | "run" | "operation";

type MemoryGraphNode = {
  id: string;
  label: string;
  type: MemoryNodeType;
  pos: Vec;
  size?: number;
  detail?: string;
  conversationId?: string;
  runId?: string;
  operationId?: string;
  path?: string;
};

type MemoryGraphLink = { from: string; to: string; strength?: number };

/** Physics body for the force-directed Graph View sim — verlet-integrated, lives in sim-space (not screen px). */
type PhysicsNode = {
  id: string;
  x: number;
  y: number;
  px: number;
  py: number;
  degree: number;
  pinned: boolean;
  radius: number;
};

/** A color-group rule, Obsidian-style: first matching rule wins. Structured so free-text/tag/path queries can be added later. */
type ColorRule = { id: string; match: (node: MemoryGraphNode) => boolean; color: string; label: string };

/** Persisted Graph View physics + display settings (see useAppStoreState). */
type GraphPhysicsSettings = {
  repelForce: number;
  centerForce: number;
  linkDistance: number;
  linkThickness: number;
};

const DEFAULT_GRAPH_PHYSICS: GraphPhysicsSettings = {
  repelForce: 1,
  centerForce: 1,
  linkDistance: 110,
  linkThickness: 1
};

// Stable module-level fallback for useAppStoreState("graphPinnedNotes", ...): a `[]` literal
// passed inline would be a new array identity every render, and useAppStoreState's load effect
// depends on that fallback reference, so it would re-fetch from the store on every re-render
// (the graph's physics tick re-renders often) and could clobber an in-flight pin toggle a moment
// after the click. Matches DEFAULT_GRAPH_PHYSICS above, which is stable for the same reason.
const EMPTY_PINNED_NOTES: string[] = [];

/** Muted 6-hue ramp for auto-assigned project color groups (Obsidian-ish, kept desaturated to match the greyscale UI). */
const GRAPH_HUE_RAMP = [210, 265, 25, 160, 320, 45];

type MemoryFolder = {
  name: string;
  children?: MemoryFolder[];
  notes?: string[];
};

type BenchmarkStep = "welcome" | "target" | "profile" | "running" | "review" | "export";
type BenchmarkTarget = "local" | "api";
type BenchmarkProfile = "quick" | "balanced" | "deep";
type BenchmarkRunStatus = "idle" | "running" | "complete";

type BenchmarkWizardState = {
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

type GalleryImage = {
  id: string;
  src: string;
  title: string;
  tags: string[];
  analysis: string;
};

type GalleryBoard = {
  id: string;
  title: string;
  description: string;
  coverImage: string;
  images: GalleryImage[];
  tags: string[];
  linkedSkill: boolean;
};

/** Visual data for a gallery board projected into the orchestration graph (owner idea: "Gallery
 *  model-visualisation inside orchestration") — a board's cover thumbnail and a handful of
 *  aggregated palette swatches (from its analyzed StyleCards), keyed by the same skill-name
 *  string a board is dragged onto the graph as (`Gallery: ${title}`), so the Palette list and
 *  the graph node can both look a skill name up against this map without adding new node fields. */
type GalleryVisual = { coverImage: string; palette: string[] };

type MarketplaceCategory = "all" | "mcp" | "skill" | "preset";
// Presentation-level normalization only (owner: "presets pipelines and templates ... just needs to
// be presets"). The underlying RegistryPackageKind union and registry data keep "pipeline"/
// "template" as real kinds; the UI just displays/groups/filters them as "preset".
type DisplayKind = "mcp" | "skill" | "preset";
function displayKind(kind: RegistryPackageKind): DisplayKind {
  if (kind === "pipeline" || kind === "template") return "preset";
  return kind;
}
type MarketplaceState = { category: MarketplaceCategory; query: string };

/** Parsed `owner/repo` GitHub coordinates for a package's `source_url`, when it points at
 *  raw.githubusercontent.com or github.com (docs/FABLE_PLANS.md section 18, "Marketplace trust + detail"). */
type GithubRepoRef = { owner: string; repo: string };

/** Subset of the GitHub `GET /repos/{owner}/{repo}` response the detail view renders. */
type GithubRepoStats = { stars: number; forks: number; pushedAt: string; htmlUrl: string };

type AppSettings = {
  globalInstructions: string;
  language: string;
  subscriptionMode: "bring-your-own-key" | "metis-subscription";
  defaultPreset: "balanced" | "local_first" | "best_quality" | "cheapest" | "private";
  rawPromptStorage: "local-only" | "hash-only";
  /** Settings > Chat section (docs/FABLE_PLANS.md settings rebuild) — how much
   *  of the routing/operation ceremony shows up in the side-chat stack. */
  chatVerbosity: "minimal" | "normal" | "verbose";
  /** Settings > Chat — whether new runs prefer `metisSession.runStream` over
   *  the non-streaming `run` fallback when both are available. */
  streamingEnabled: boolean;
};

/** Settings > Appearance — one root accent + its readable on-accent text
 *  color, applied as CSS custom properties on <html> so every existing
 *  `var(--accent)` usage across styles.css picks it up live, app-wide. */
type AccentPreset = { id: string; label: string; hex: string; textHex: string };
const ACCENT_PRESETS: AccentPreset[] = [
  { id: "slate", label: "Slate", hex: "#aeb7c6", textHex: "#14161b" },
  { id: "amber", label: "Amber", hex: "#e0a458", textHex: "#1c1206" },
  { id: "violet", label: "Violet", hex: "#9c8cff", textHex: "#15111f" },
  { id: "teal", label: "Teal", hex: "#5fb8ad", textHex: "#08201c" },
  { id: "rose", label: "Rose", hex: "#d98a99", textHex: "#210b10" }
];

type AppearanceSettings = {
  accent: string;
  density: "comfortable" | "compact";
  fontSize: "small" | "normal" | "large";
};
const DEFAULT_APPEARANCE: AppearanceSettings = { accent: "slate", density: "comfortable", fontSize: "normal" };
const FONT_SCALE: Record<AppearanceSettings["fontSize"], string> = { small: "0.93", normal: "1", large: "1.08" };

/** Applies a persisted Appearance choice to the document root so it takes
 *  effect app-wide (not just while the Settings screen is mounted) — called
 *  once from App() on load and again from SettingsWorkspace whenever the
 *  owner changes a control. Reversible: "Reset to default" just re-runs this
 *  with DEFAULT_APPEARANCE. */
function applyAppearance(appearance: AppearanceSettings): void {
  if (typeof document === "undefined") return;
  const preset = ACCENT_PRESETS.find((item) => item.id === appearance.accent) ?? ACCENT_PRESETS[0];
  const root = document.documentElement;
  root.style.setProperty("--accent", preset.hex);
  root.style.setProperty("--accent-text", preset.textHex);
  root.classList.toggle("density-compact", appearance.density === "compact");
  // The stylesheet uses fixed px sizes rather than rem, so a true
  // font-size-only cascade isn't wired without a broader CSS pass — `zoom`
  // (Electron/Chromium-only, safe here) gives the same real, reversible
  // "small/normal/large" effect across the whole renderer.
  document.body.style.zoom = FONT_SCALE[appearance.fontSize];
}

type ConversationTurn = {
  id: string;
  prompt: string;
  /** True when this entry is a mid-run steering directive, not a full run. */
  directive?: boolean;
  /** User-attached reference images for this turn — kept in-memory only (the
   *  live pending-turn bucket), never written to the persisted conversation
   *  record, so raw base64 never bloats long-term storage. Undefined once
   *  the app reloads and this turn is rehydrated from storage. */
  attachments?: SessionAttachment[];
  status: "running" | "complete" | "error";
  run?: SessionRun;
  streamEvents?: SessionTimelineEvent[];
  streamStages?: NonNullable<SessionRun["stages"]>;
  streamOperations?: AgentOperation[];
  streamSteps?: SessionPipelineStep[];
  streamProject?: SessionRun["projectResult"];
  /** Side-chat cards — one per model-call attempt the orchestrator makes
   *  during this run (docs/FABLE_PLANS.md §26). Capped at ~30, oldest dropped
   *  first, so a long run's side-chat stack never grows unbounded. */
  streamCalls?: StageCallEvent["call"][];
  liveAssistantText?: string;
  liveThoughtText?: string;
  error?: string;
  /** In-run permission prompt awaiting a verdict (docs/FABLE_PLANS.md §24) —
   *  cleared once a later stream event arrives or the user responds. */
  pendingPermission?: { id: string; scope: PermissionScope; target: string; detail: string; resolved?: { verdict: "allow" | "always" | "deny" } };
  /** AskUserQuestion awaiting an answer (docs/FABLE_PLANS.md §24). */
  pendingQuestion?: { id: string; text: string; options: string[]; resolved?: { answer: string } };
};

const ACCOUNT_EMAIL = "bytehavencreations@gmail.com";
const METIS_REPO_URL = "https://github.com/lachydotmcg/metis-orchestrator";

/** Lets deeply-nested "Preview" links (inside CompletedRun / TimelineOperations)
 *  open the live preview rail without prop-drilling through every layer. */
type PreviewRailControl = { open: (url: string, title: string) => void } | null;
const PreviewRailContext = createContext<PreviewRailControl>(null);

function openPreviewOrExternal(control: PreviewRailControl, url: string, title = "Preview"): void {
  if (control) {
    control.open(url, title);
    return;
  }
  openExternal(url);
}

function openExternal(url: string): void {
  if (window.metisShell) {
    void window.metisShell.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noreferrer");
}

function openLocalPath(path: string): void {
  if (window.metisShell) void window.metisShell.openPath(path);
}

function applyStreamEventToTurn(turn: ConversationTurn, event: SessionStreamEvent): ConversationTurn {
  if (event.kind === "timeline") {
    return { ...turn, streamEvents: [...(turn.streamEvents ?? []), event.event] };
  }
  if (event.kind === "message_delta") {
    return { ...turn, liveAssistantText: `${turn.liveAssistantText ?? ""}${event.delta}` };
  }
  if (event.kind === "thought_delta") {
    return { ...turn, liveThoughtText: `${turn.liveThoughtText ?? ""}${event.delta}` };
  }
  if (event.kind === "stage") {
    return { ...turn, streamStages: [...(turn.streamStages ?? []).filter((stage) => stage.id !== event.stage.id), event.stage] };
  }
  if (event.kind === "operation") {
    return {
      ...turn,
      streamOperations: [...(turn.streamOperations ?? []).filter((operation) => operation.id !== event.operation.id), event.operation]
    };
  }
  if (event.kind === "step") {
    return { ...turn, streamSteps: [...(turn.streamSteps ?? []).filter((step) => step.id !== event.step.id), event.step] };
  }
  if (event.kind === "project") {
    return { ...turn, streamProject: event.project };
  }
  if (event.kind === "stage_call") {
    // Side-chat cards (docs/FABLE_PLANS.md §26): same id updates in place
    // (start -> complete/failed), new ids append. Capped at ~30 stored calls
    // per conversation turn — drop the oldest once the cap is hit so a long
    // run's stack never grows unbounded.
    const existing = turn.streamCalls ?? [];
    const withoutThis = existing.filter((call) => call.id !== event.call.id);
    const next = [...withoutThis, event.call];
    const capped = next.length > 30 ? next.slice(next.length - 30) : next;
    return { ...turn, streamCalls: capped };
  }
  if (event.kind === "complete") {
    return { ...turn, id: event.run.id, status: "complete", run: event.run };
  }
  if (event.kind === "error") {
    return { ...turn, status: "error", error: event.message };
  }
  if (event.kind === "permission_request") {
    return { ...turn, pendingPermission: { id: event.request.id, scope: event.request.scope, target: event.request.target, detail: event.request.detail } };
  }
  if (event.kind === "user_question") {
    return { ...turn, pendingQuestion: { id: event.question.id, text: event.question.text, options: event.question.options } };
  }
  return turn;
}

const PROVIDERS: Record<ProviderId, { label: string; logo: string; tier: "cloud" | "local" }> = {
  qwen: { label: "Qwen", logo: "assets/providers/qwen.png", tier: "local" },
  claude: { label: "Claude", logo: "assets/providers/claude.png", tier: "cloud" },
  openai: { label: "OpenAI", logo: "assets/providers/openai.png", tier: "cloud" },
  gemini: { label: "Gemini", logo: "assets/providers/gemini.png", tier: "cloud" },
  grok: { label: "Grok", logo: "assets/providers/grok.png", tier: "cloud" },
  deepseek: { label: "DeepSeek", logo: "assets/providers/deepseek.png", tier: "cloud" },
  glm: { label: "GLM", logo: "assets/providers/glm.png", tier: "local" },
  // No brand logo assets exist yet for these two free-tier pool providers
  // (docs/FABLE_PLANS.md §19) — reuse the auto-router glyph as a safe generic
  // fallback rather than a broken <img>.
  nvidia: { label: "NVIDIA NIM", logo: "assets/providers/autorouter.png", tier: "cloud" },
  groq: { label: "Groq", logo: "assets/providers/autorouter.png", tier: "cloud" }
};
// nvidia/groq are GATEWAYS (API-key route providers), never standalone model
// brands in the picker — a model reached through them is expressed as an
// access route (docs/FABLE_PLANS.md §21/§25b), surfaced on the node Gateway
// control, not as its own brand here.
const GATEWAY_ONLY_BRANDS: ProviderId[] = ["nvidia", "groq"];
const AUTOROUTER_LOGO = "assets/providers/autorouter.png";
const HEAT_ALPHAS = ["0", "0.18", "0.38", "0.62", "1"];

const PROVIDER_CONNECTIONS: Record<ProviderId, ProviderKey> = {
  qwen: "ollama",
  claude: "anthropic",
  openai: "openai",
  gemini: "gemini",
  grok: "openrouter",
  deepseek: "deepseek",
  glm: "ollama",
  nvidia: "nvidia",
  groq: "groq"
};

/** Maps the live registry's `catalog/models.json` provider naming (ProviderKey,
 *  e.g. "anthropic") onto the renderer's brand-style ids (e.g. "claude") used
 *  by the model picker. Ollama-tier catalog entries all land on "qwen" since
 *  that's the picker's default local brand bucket. */
const CATALOG_PROVIDER_TO_BRAND: Record<ProviderKey, ProviderId> = {
  anthropic: "claude",
  openai: "openai",
  gemini: "gemini",
  deepseek: "deepseek",
  openrouter: "grok",
  nvidia: "nvidia",
  groq: "groq",
  ollama: "qwen"
};

const MODEL_LIBRARY: ModelRef[] = [
  { provider: "claude", model: "Opus 4.8" },
  { provider: "claude", model: "Sonnet 5" },
  { provider: "claude", model: "Fable 5" },
  { provider: "claude", model: "Haiku 4.5" },
  { provider: "openai", model: "GPT-5.1" },
  { provider: "openai", model: "GPT-5 mini" },
  { provider: "gemini", model: "2.5 Pro" },
  { provider: "gemini", model: "2.5 Flash" },
  { provider: "grok", model: "Grok 4" },
  { provider: "deepseek", model: "V3" },
  { provider: "deepseek", model: "R1" },
  { provider: "qwen", model: "Qwen2.5 72B" },
  { provider: "qwen", model: "Qwen3 4B" },
  { provider: "glm", model: "GLM-4.6" }
];

function providerConnectionStatus(provider: ProviderId, states: Partial<Record<ProviderKey, ProviderConnectionState>>): ProviderConnectionState {
  const key = PROVIDER_CONNECTIONS[provider];
  if (key === "ollama" || PROVIDERS[provider].tier === "local") return "local";
  return states[key] ?? "unknown";
}

const SKILL_LIBRARY = [
  "UI Design",
  "Frontend Patterns",
  "Component Library",
  "Planning",
  "Agentic Tasks",
  "Code Review",
  "Testing",
  "Documentation",
  "Data Modeling",
  "Security Audit"
];

const BENCHMARK_STEPS: Array<{ key: BenchmarkStep; label: string }> = [
  { key: "welcome", label: "Check" },
  { key: "target", label: "Target" },
  { key: "profile", label: "Profile" },
  { key: "running", label: "Run" },
  { key: "review", label: "Review" },
  { key: "export", label: "Export" }
];

const BENCHMARK_TARGETS: Array<{ key: BenchmarkTarget; title: string; detail: string; icon: JSX.Element }> = [
  { key: "local", title: "Local model", detail: "Test an Ollama or local runner model on this machine.", icon: <HardDrive size={18} /> },
  { key: "api", title: "API reference", detail: "Prototype the same flow for Claude, OpenAI, Gemini, or OpenRouter.", icon: <Monitor size={18} /> }
];

const BENCHMARK_PROFILES: Array<{ key: BenchmarkProfile; title: string; detail: string; time: string }> = [
  { key: "quick", title: "Quick smoke", detail: "Small confidence pass for a newly installed model.", time: "5-10 min" },
  { key: "balanced", title: "Balanced study", detail: "Recommended default: quality, speed, memory, and recommendation signal.", time: "20-35 min" },
  { key: "deep", title: "Deep study", detail: "Repeats and harder tasks for publishing or comparing hardware.", time: "60+ min" }
];

const DEFAULT_BENCHMARK_STATE: BenchmarkWizardState = {
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
type Gpu = { id: string; label: string; vram: number; note: string };
const GPUS: Gpu[] = [
  { id: "rtx3060", label: "RTX 3060", vram: 8, note: "8 GB" },
  { id: "rtx4070", label: "RTX 4070", vram: 12, note: "12 GB" },
  { id: "rtx4080", label: "RTX 4080", vram: 16, note: "16 GB" },
  { id: "rtx4090", label: "RTX 4090", vram: 24, note: "24 GB" },
  { id: "m3max", label: "Apple M3 Max", vram: 36, note: "36 GB unified" },
  { id: "cpu", label: "CPU only", vram: 0, note: "system RAM" }
];

type LocalModel = { name: string; params: string; vram: number; quant: string; tps: number; role: string; provider?: ProviderId; ollamaTag?: string };
const LOCAL_MODELS: LocalModel[] = [
  { name: "Qwen2.5 7B", params: "7B", vram: 6, quant: "Q4_K_M", tps: 52, role: "fast router / general", provider: "qwen", ollamaTag: "qwen2.5:7b" },
  { name: "Llama 3.1 8B", params: "8B", vram: 6.5, quant: "Q4_K_M", tps: 47, role: "general chat", ollamaTag: "llama3.1:8b" },
  { name: "GLM-4 9B", params: "9B", vram: 7, quant: "Q4_K_M", tps: 41, role: "chat / agentic", provider: "glm", ollamaTag: "glm4:9b" },
  { name: "DeepSeek-R1 Distill 14B", params: "14B", vram: 10, quant: "Q4_K_M", tps: 28, role: "reasoning", provider: "deepseek", ollamaTag: "deepseek-r1:14b" },
  { name: "Qwen2.5 32B", params: "32B", vram: 20, quant: "Q4_K_M", tps: 18, role: "strong coding", provider: "qwen", ollamaTag: "qwen2.5:32b" },
  { name: "Ornith 1.0 35B", params: "35B", vram: 22, quant: "Q4_K_M", tps: 16, role: "RL-tuned coding agent" },
  { name: "Qwen2.5 72B", params: "72B", vram: 42, quant: "Q4_K_M", tps: 9, role: "near-frontier local", provider: "qwen", ollamaTag: "qwen2.5:72b" }
];

type Fit = "great" | "tight" | "over" | "cpu";
type ScoredModel = LocalModel & { fit: Fit };

function fitFor(vram: number, modelVram: number): Fit {
  if (vram === 0) return "cpu";
  const ratio = modelVram / vram;
  if (ratio <= 0.85) return "great";
  if (ratio <= 1.05) return "tight";
  return "over";
}

function fitLabel(fit: Fit): string {
  return fit === "great" ? "Great fit" : fit === "tight" ? "Tight" : fit === "cpu" ? "CPU · slow" : "Needs more VRAM";
}

// New installs start with a single empty board and no seeded sample images —
// "Add sample reference" and the demo boards were removed per docs/FABLE_PLANS.md
// section 23 ("real images only"). Existing stores keep whatever the owner already
// has; this default only applies when no `galleryBoards` value has been persisted yet.
const DEFAULT_GALLERY_BOARDS: GalleryBoard[] = [
  {
    id: "references",
    title: "References",
    description: "Drop your own design references here to build visual style memory for builds.",
    coverImage: "",
    tags: [],
    linkedSkill: false,
    images: []
  }
];

const DEFAULT_MARKETPLACE_STATE: MarketplaceState = { category: "all", query: "" };
const DEFAULT_SETTINGS: AppSettings = {
  globalInstructions: "",
  language: "en",
  subscriptionMode: "bring-your-own-key",
  defaultPreset: "balanced",
  rawPromptStorage: "local-only",
  chatVerbosity: "normal",
  streamingEnabled: true
};
const PROVIDER_KEYS: ProviderKey[] = ["ollama", "anthropic", "openai", "gemini", "deepseek", "openrouter", "nvidia", "groq"];
const PROVIDER_LABELS: Record<ProviderKey, string> = {
  ollama: "Ollama",
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  nvidia: "NVIDIA NIM",
  groq: "Groq"
};
const PERMISSION_PRESETS: Array<{ scope: PermissionScope; target: string; note: string }> = [
  { scope: "filesystem.read", target: "current project", note: "Index project files for Graph View retrieval." },
  { scope: "network.provider", target: "configured providers", note: "Call selected local/cloud routes after policy chooses them." },
  { scope: "process.spawn", target: "metis-policy CLI", note: "Run policy decisions through the separate routing contract." },
  { scope: "mcp.invoke", target: "installed MCP tools", note: "Let enabled connections expose approved tools to routes." }
];
const FALLBACK_POLICY_STATUS: PolicyStatus = {
  available: false,
  detail: "Electron runtime APIs are unavailable in browser preview."
};
const FALLBACK_REGISTRY: RegistryState = {
  sourceUrl: "bundled-preview",
  status: "idle",
  packages: []
};
const FALLBACK_MODEL_CATALOG: ModelCatalogState = {
  sourceUrl: "bundled-preview",
  status: "idle",
  models: []
};
const FALLBACK_PULSE: PulseFeed = {
  sourceUrl: "bundled-preview",
  status: "idle",
  changelog: [],
  community: [],
  news: []
};

const MARKETPLACE_CATEGORIES: Array<{ key: MarketplaceCategory; label: string; detail: string; icon: JSX.Element }> = [
  { key: "all", label: "All", detail: "Everything", icon: <Sparkles size={20} /> },
  { key: "mcp", label: "MCP Connections", detail: "Tools", icon: <Plug size={20} /> },
  { key: "skill", label: "Skills", detail: "Prompt packs", icon: <ClipboardList size={20} /> },
  { key: "preset", label: "Presets", detail: "Routers, flows, starters", icon: <Star size={20} /> }
];

/** Browser-preview fallback when `window.metisRegistry` is absent (no Electron bridge). */
const FALLBACK_MARKETPLACE_PACKAGES: RegistryPackage[] = [
  {
    schema_version: "0.1.0",
    id: "ui-ux-pro-max",
    kind: "skill",
    name: "UI / UX Pro Max",
    version: "1.0.0",
    publisher: "metis",
    description: "Design-review and implementation skill for polished interfaces.",
    tags: ["frontend", "design"],
    permissions_requested: [],
    source_url: ""
  },
  {
    schema_version: "0.1.0",
    id: "gallery-reference-pack",
    kind: "skill",
    name: "Gallery Reference Pack",
    version: "1.0.0",
    publisher: "metis",
    description: "Turns saved boards into route-aware visual inspiration.",
    tags: ["frontend", "design"],
    permissions_requested: [],
    source_url: ""
  },
  {
    schema_version: "0.1.0",
    id: "browser-mcp",
    kind: "mcp",
    name: "Browser Control",
    version: "1.0.0",
    publisher: "metis",
    description: "Inspect local previews, screenshots, and web app flows.",
    tags: ["productivity"],
    permissions_requested: ["network.web"],
    source_url: ""
  },
  {
    schema_version: "0.1.0",
    id: "filesystem-mcp",
    kind: "mcp",
    name: "Filesystem Workspace",
    version: "1.0.0",
    publisher: "metis",
    description: "Let routes read and write approved project files.",
    tags: ["productivity"],
    permissions_requested: ["filesystem.read", "filesystem.write"],
    source_url: ""
  },
  {
    schema_version: "0.1.0",
    id: "local-first-router",
    kind: "preset",
    name: "Local-first Router",
    version: "1.0.0",
    publisher: "metis",
    description: "Prefer local models, escalate when task confidence or quality risk says so.",
    tags: ["cost-control"],
    permissions_requested: [],
    source_url: ""
  },
  {
    schema_version: "0.1.0",
    id: "frontend-studio",
    kind: "preset",
    name: "Frontend Studio",
    version: "1.0.0",
    publisher: "metis",
    description: "Gallery references, UI skill, and premium cloud fallback for design work.",
    tags: ["frontend", "design"],
    permissions_requested: [],
    source_url: ""
  },
  {
    schema_version: "0.1.0",
    id: "security-audit",
    kind: "skill",
    name: "Security Audit Pack",
    version: "1.0.0",
    publisher: "metis",
    description: "Threat-model review, code audit prompts, and safe reporting format.",
    tags: ["security"],
    permissions_requested: [],
    source_url: ""
  }
];

const MEMORY_GRAPH_NODES: MemoryGraphNode[] = [
  { id: "home", label: "Home", type: "home", pos: { x: 0, y: 0 }, size: 42, detail: "root memory index" },
  { id: "lachys-web-dev", label: "Lachys Web Dev", type: "project", pos: { x: 210, y: -210 }, size: 36, detail: "project workspace" },
  { id: "metis", label: "Metis", type: "project", pos: { x: -245, y: -150 }, size: 34, detail: "benchmark suite" },
  { id: "metis-orchestrator", label: "metis-orchestrator", type: "project", pos: { x: -120, y: 180 }, size: 31, detail: "desktop orchestration UI" },
  { id: "aid-helpdesk", label: "AID Helpdesk", type: "project", pos: { x: 285, y: 90 }, size: 30, detail: "support automation" },
  { id: "portfolio", label: "portfolio", type: "project", pos: { x: -360, y: 120 }, size: 28, detail: "public writing and demos" },
  { id: "supargus", label: "supargus-web", type: "project", pos: { x: 110, y: 240 }, size: 27, detail: "hosted dashboard" },
  { id: "dpsai", label: "dpsai", type: "project", pos: { x: -35, y: -275 }, size: 27, detail: "school AI product" },
  { id: "graph-view", label: "Graph View", type: "note", pos: { x: -180, y: 40 }, detail: "linked logs and note traversal" },
  { id: "orchestration-ui", label: "orchestration-ui", type: "note", pos: { x: -25, y: 120 }, detail: "router process tree" },
  { id: "routing-policy", label: "routing-policy-contract", type: "file", pos: { x: -240, y: 220 }, detail: "future policy export" },
  { id: "benchmark-plan", label: "benchmark-suite-planning", type: "note", pos: { x: -420, y: -230 }, detail: "Metis benchmark next steps" },
  { id: "ceiling-effect", label: "findings-ceiling-effect", type: "note", pos: { x: -355, y: -30 }, detail: "quality saturation caveat" },
  { id: "marketplace", label: "marketplace", type: "note", pos: { x: 55, y: 315 }, detail: "skills, MCPs, presets" },
  { id: "env-vars", label: "provider-env-vars", type: "file", pos: { x: -155, y: 320 }, detail: "provider-level API keys" },
  { id: "gallery", label: "Gallery", type: "folder", pos: { x: 340, y: -30 }, detail: "design references" },
  { id: "deploy-checklist", label: "deploy-checklist", type: "file", pos: { x: 385, y: -310 }, detail: "web deployment notes" },
  { id: "club-window", label: "Club Window Services", type: "note", pos: { x: 525, y: -205 }, detail: "client project" },
  { id: "github-profile", label: "Lachlan GitHub profile", type: "note", pos: { x: -530, y: 25 }, detail: "portfolio note" },
  { id: "mcp-essay", label: "mcp-backdoor-essay", type: "file", pos: { x: -520, y: 215 }, detail: "security writing" },
  { id: "date-2026-05-24", label: "2026-05-24", type: "date", pos: { x: 470, y: 165 }, detail: "conversation log" },
  { id: "date-2026-05-31", label: "2026-05-31", type: "date", pos: { x: 450, y: 330 }, detail: "conversation log" },
  { id: "date-2026-06-21", label: "2026-06-21", type: "date", pos: { x: 615, y: 65 }, detail: "conversation log" },
  { id: "local-file-agent", label: "local-file-agent-setup-guide", type: "file", pos: { x: 90, y: -390 }, detail: "retrieval helper idea" },
  { id: "goals", label: "goals", type: "note", pos: { x: -95, y: -390 }, detail: "project goals" }
];

const MEMORY_GRAPH_LINKS: MemoryGraphLink[] = [
  { from: "home", to: "lachys-web-dev", strength: 2 },
  { from: "home", to: "metis", strength: 2 },
  { from: "home", to: "metis-orchestrator", strength: 2 },
  { from: "home", to: "aid-helpdesk" },
  { from: "home", to: "portfolio" },
  { from: "home", to: "supargus" },
  { from: "home", to: "dpsai" },
  { from: "metis", to: "benchmark-plan", strength: 2 },
  { from: "metis", to: "ceiling-effect", strength: 2 },
  { from: "metis", to: "routing-policy" },
  { from: "metis", to: "metis-orchestrator", strength: 2 },
  { from: "metis-orchestrator", to: "orchestration-ui", strength: 2 },
  { from: "metis-orchestrator", to: "graph-view", strength: 2 },
  { from: "metis-orchestrator", to: "marketplace" },
  { from: "metis-orchestrator", to: "env-vars" },
  { from: "graph-view", to: "local-file-agent" },
  { from: "graph-view", to: "goals" },
  { from: "orchestration-ui", to: "routing-policy", strength: 2 },
  { from: "marketplace", to: "gallery" },
  { from: "gallery", to: "lachys-web-dev" },
  { from: "lachys-web-dev", to: "deploy-checklist", strength: 2 },
  { from: "lachys-web-dev", to: "club-window" },
  { from: "portfolio", to: "github-profile" },
  { from: "portfolio", to: "mcp-essay" },
  { from: "aid-helpdesk", to: "date-2026-05-24" },
  { from: "aid-helpdesk", to: "date-2026-05-31" },
  { from: "aid-helpdesk", to: "date-2026-06-21" },
  { from: "dpsai", to: "goals" },
  { from: "supargus", to: "deploy-checklist" }
];

function buildRuntimeMemoryGraph(conversations: ConversationRecord[], runs: SessionRun[]): { nodes: MemoryGraphNode[]; links: MemoryGraphLink[]; tree: MemoryFolder | null } {
  const staticIds = new Set(MEMORY_GRAPH_NODES.map((node) => node.id));
  const nodes: MemoryGraphNode[] = [];
  const links: MemoryGraphLink[] = [];
  const linkKeys = new Set(MEMORY_GRAPH_LINKS.map((link) => `${link.from}->${link.to}`));
  const projectNodes = new Map<string, { id: string; label: string; pos: Vec; conversations: string[] }>();
  const mergedRuns = new Map<string, SessionRun>();

  for (const run of runs) mergedRuns.set(run.id, run);
  for (const conversation of conversations) {
    for (const turn of conversation.turns) {
      if (turn.run) mergedRuns.set(turn.run.id, turn.run);
    }
  }

  const recentConversations = [...conversations].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 12);

  function addLink(from: string, to: string, strength?: number): void {
    const key = `${from}->${to}`;
    if (linkKeys.has(key)) return;
    links.push({ from, to, strength });
    linkKeys.add(key);
  }

  function ensureProject(conversation: ConversationRecord, index: number): { id: string; label: string; pos: Vec; conversations: string[] } {
    const label = projectNameFromPath(conversation.projectPath);
    const normalized = normalizeMemoryLabel(label) || "workspace";
    const staticProject = MEMORY_GRAPH_NODES.find((node) => node.type === "project" && (node.id === normalized || normalizeMemoryLabel(node.label) === normalized));
    const id = staticProject?.id ?? `runtime-project-${normalized}`;
    const existing = projectNodes.get(id);
    if (existing) return existing;
    const pos = staticProject?.pos ?? { x: 760 + (index % 3) * 130, y: -260 + Math.floor(index / 3) * 145 };
    const project = { id, label, pos, conversations: [] };
    projectNodes.set(id, project);
    if (!staticIds.has(id)) {
      nodes.push({
        id,
        label,
        type: "project",
        pos,
        size: 30,
        detail: conversation.projectPath ?? "runtime workspace"
      });
      addLink("home", id, 2);
    }
    return project;
  }

  recentConversations.forEach((conversation, index) => {
    const project = ensureProject(conversation, index);
    const projectConversationIndex = project.conversations.length;
    const conversationId = `conversation-${conversation.id}`;
    project.conversations.push(conversationId);
      nodes.push({
        id: conversationId,
        label: conversation.title,
        type: "conversation",
      pos: {
        x: project.pos.x + 130 + (projectConversationIndex % 2) * 100,
        y: project.pos.y - 80 + projectConversationIndex * 58
      },
        size: 20,
        detail: `${conversation.turns.length} turn${conversation.turns.length === 1 ? "" : "s"} / ${ageLabel(conversation.updatedAt)}`,
        conversationId: conversation.id,
        path: conversation.projectPath
      });
    addLink(project.id, conversationId, 2);

    const conversationRuns = collectConversationRuns(conversation, Array.from(mergedRuns.values())).slice(0, 3);
    conversationRuns.forEach((run, runIndex) => {
      const runId = `run-${run.id}`;
      const operations = run.operations?.length ? run.operations : operationsFromArtifacts(run);
      nodes.push({
        id: runId,
        label: run.routeLabel ?? run.pipelineName.replace(" Orchestration Pipeline", ""),
        type: "run",
        pos: {
          x: project.pos.x + 325 + runIndex * 86,
          y: project.pos.y - 58 + projectConversationIndex * 58 + runIndex * 52
        },
        size: 18,
        detail: `${run.decision.decision.task_type} / ${operations.length} operation${operations.length === 1 ? "" : "s"}`,
        conversationId: conversation.id,
        runId: run.id,
        path: run.projectPath
      });
      addLink(conversationId, runId, 2);

      if (run.projectSnapshot) {
        const snapshotId = `snapshot-${run.id}`;
        nodes.push({
          id: snapshotId,
          label: run.projectSnapshot.rootName,
          type: "folder",
          pos: {
            x: project.pos.x + 360 + runIndex * 80,
            y: project.pos.y + 105 + projectConversationIndex * 58 + runIndex * 44
          },
          size: 16,
          detail: `${run.projectSnapshot.packageManager ?? "repo"} / ${run.projectSnapshot.totals.files} files`,
          conversationId: conversation.id,
          runId: run.id,
          path: run.projectSnapshot.rootPath
        });
        addLink(runId, snapshotId);
        run.projectSnapshot.files.slice(0, 6).forEach((file, fileIndex) => {
          const fileId = `snapshot-file-${run.id}-${fileIndex}`;
          nodes.push({
            id: fileId,
            label: file.path,
            type: file.kind === "directory" ? "folder" : "file",
            pos: {
              x: project.pos.x + 520 + runIndex * 70,
              y: project.pos.y + 72 + projectConversationIndex * 58 + runIndex * 44 + fileIndex * 28
            },
            size: file.kind === "directory" ? 12 : 10,
            detail: file.bytes ? `${Math.round(file.bytes / 100) / 10} KB` : file.kind,
            conversationId: conversation.id,
            runId: run.id,
            path: `${run.projectSnapshot?.rootPath}/${file.path}`
          });
          addLink(snapshotId, fileId);
        });
      }

      operations.slice(0, 5).forEach((operation, operationIndex) => {
        const operationId = `operation-${run.id}-${operation.id}`;
        nodes.push({
          id: operationId,
          label: operation.label,
          type: "operation",
          pos: {
            x: project.pos.x + 475 + runIndex * 70,
            y: project.pos.y - 112 + projectConversationIndex * 58 + runIndex * 52 + operationIndex * 38
          },
          size: operation.status === "complete" ? 12 : 16,
          detail: operation.target ?? operation.command ?? operation.detail ?? operation.kind,
          conversationId: conversation.id,
          runId: run.id,
          operationId: operation.id,
          path: operation.target
        });
        addLink(runId, operationId);
      });
    });
  });

  if (recentConversations.length === 0) return { nodes, links, tree: null };

  return {
    nodes,
    links,
    tree: {
      name: "runtime",
      children: Array.from(projectNodes.values()).map((project) => ({
        name: project.label,
        notes: recentConversations.filter((conversation) => projectNameFromPath(conversation.projectPath) === project.label).map((conversation) => conversation.title)
      }))
    }
  };
}

function collectConversationRuns(conversation: ConversationRecord, runs: SessionRun[]): SessionRun[] {
  const byId = new Map<string, SessionRun>();
  for (const run of runs) {
    if (run.conversationId === conversation.id) byId.set(run.id, run);
  }
  for (const turn of conversation.turns) {
    if (turn.run) byId.set(turn.run.id, turn.run);
  }
  return Array.from(byId.values()).sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
}

const SEED_NODES: GraphNode[] = [
  {
    id: "router",
    kind: "router",
    label: "Router",
    pos: { x: 0, y: 250 },
    provider: "qwen",
    model: "Default router",
    temperature: 0.2,
    fallbacks: [{ provider: "glm", model: "GLM-4.6" }]
  },
  {
    id: "agent-frontend",
    kind: "agent",
    label: "Frontend",
    pos: { x: 40, y: -290 },
    provider: "claude",
    model: "Sonnet 4.6",
    intent: "frontend / UI design",
    temperature: 0.6,
    skills: ["skill-ui", "skill-components"],
    fallbacks: [{ provider: "deepseek", model: "V3" }]
  },
  { id: "agent-planning", kind: "agent", label: "Planning", pos: { x: -270, y: -200 }, provider: "gemini", model: "2.5 Pro", intent: "planning & breakdown", temperature: 0.4, skills: [] },
  { id: "agent-backend", kind: "agent", label: "Backend", pos: { x: 340, y: -190 }, provider: "deepseek", model: "V3", intent: "backend / APIs", temperature: 0.3, skills: [] },
  { id: "agent-agentic", kind: "agent", label: "Agentic tasks", pos: { x: -480, y: 70 }, provider: "openai", model: "GPT-5.1", intent: "agentic / tool use", temperature: 0.5, skills: [] },
  { id: "agent-research", kind: "agent", label: "Research", pos: { x: 520, y: 60 }, provider: "grok", model: "Grok 4", intent: "research & search", temperature: 0.4, skills: [] },
  { id: "skill-ui", kind: "skill", label: "UI Design", pos: { x: -90, y: -30 } },
  { id: "skill-components", kind: "skill", label: "Component Library", pos: { x: 150, y: -40 } }
];

type PresetKey = "recommended" | "local" | "quality" | "speed";

const PRESETS: { key: PresetKey; label: string; note: string; router: ModelRef; pick: (role: string) => ModelRef }[] = [
  {
    key: "recommended",
    label: "Recommended",
    note: "Balanced quality / cost",
    router: { provider: "qwen", model: "Default router" },
    pick: (role) =>
      role.includes("front")
        ? { provider: "claude", model: "Sonnet 4.6" }
        : role.includes("plan")
          ? { provider: "gemini", model: "2.5 Pro" }
          : role.includes("back")
            ? { provider: "deepseek", model: "V3" }
            : role.includes("research")
              ? { provider: "grok", model: "Grok 4" }
              : { provider: "openai", model: "GPT-5.1" }
  },
  {
    key: "local",
    label: "Local-first",
    note: "Cheap, runs on your VRAM",
    router: { provider: "qwen", model: "Qwen3 4B" },
    pick: (role) => (role.includes("front") || role.includes("research") ? { provider: "qwen", model: "Qwen2.5 72B" } : { provider: "glm", model: "GLM-4.6" })
  },
  {
    key: "quality",
    label: "Max quality",
    note: "Best models everywhere",
    router: { provider: "claude", model: "Opus 4.8" },
    pick: () => ({ provider: "claude", model: "Opus 4.8" })
  },
  {
    key: "speed",
    label: "Speed",
    note: "Smallest fast models",
    router: { provider: "qwen", model: "Qwen3 4B" },
    pick: (role) => (role.includes("plan") ? { provider: "gemini", model: "2.5 Flash" } : { provider: "claude", model: "Haiku 4.5" })
  }
];

const STORAGE_KEY = "metis-graph-v3";
const PRESET_STORAGE_KEY = "metis-orchestration-preset-v1";
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 1.9;
const TARGET_RADIUS = 160; // screen px
const ROUTE_TARGET_RADIUS = 95; // screen px
const EXISTING_SKILL_TARGET_RADIUS = 96; // screen px
const EXISTING_SKILL_ROUTE_RADIUS = 52; // screen px
const GHOST_FOLLOW = 0.3;
const MAX_TILT = 15;

const prefersReducedMotion =
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;

function makeGalleryThumb(label: string, start: string, end: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="650" viewBox="0 0 900 650"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect width="900" height="650" fill="url(#g)"/><rect x="58" y="64" width="784" height="92" rx="18" fill="rgba(255,255,255,.14)"/><rect x="58" y="196" width="360" height="300" rx="26" fill="rgba(255,255,255,.18)"/><rect x="458" y="196" width="384" height="56" rx="16" fill="rgba(255,255,255,.20)"/><rect x="458" y="282" width="306" height="42" rx="13" fill="rgba(255,255,255,.14)"/><rect x="458" y="356" width="348" height="42" rx="13" fill="rgba(255,255,255,.14)"/><rect x="458" y="450" width="178" height="58" rx="17" fill="rgba(255,255,255,.28)"/><text x="76" y="125" fill="white" font-family="Segoe UI, Arial, sans-serif" font-size="38" font-weight="800">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function readAppStore<T>(key: string, fallback: T): Promise<T> {
  if (typeof window === "undefined") return fallback;
  if (window.metisStore) return window.metisStore.get(key, fallback);
  try {
    const raw = window.localStorage.getItem(`metis-store:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeAppStore<T>(key: string, value: T): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.metisStore) {
    await window.metisStore.set(key, value);
    return;
  }
  window.localStorage.setItem(`metis-store:${key}`, JSON.stringify(value));
}

function useAppStoreState<T>(key: string, fallback: T): [T, (next: T | ((current: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void readAppStore(key, fallback).then((stored) => {
      if (!alive) return;
      setValue(stored);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [fallback, key]);

  useEffect(() => {
    if (!loaded) return;
    void writeAppStore(key, value);
  }, [key, loaded, value]);

  const update = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => (typeof next === "function" ? (next as (current: T) => T)(current) : next));
  }, []);

  return [value, update, loaded];
}

function ageLabel(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function projectNameFromPath(path?: string): string {
  if (!path) return "Unassigned workspace";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function conversationProjects(conversations: ConversationRecord[]): ProjectFolder[] {
  const grouped = new Map<string, ConversationRecord[]>();
  for (const conversation of conversations) {
    const key = conversation.projectPath ?? "";
    grouped.set(key, [...(grouped.get(key) ?? []), conversation]);
  }
  return Array.from(grouped.entries()).map(([path, items]) => {
    const sorted = [...items].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const newest = sorted[0];
    return {
      name: projectNameFromPath(path || undefined),
      path: path || undefined,
      latest: newest?.title ?? "No conversations yet",
      age: newest ? ageLabel(newest.updatedAt) : ""
    };
  });
}

type SidebarConversation = { id: string; title: string; summary: string; age: string };

function conversationsByProject(conversations: ConversationRecord[]): Record<string, SidebarConversation[]> {
  const grouped: Record<string, SidebarConversation[]> = {};
  for (const conversation of conversations) {
    const key = projectNameFromPath(conversation.projectPath);
    grouped[key] ??= [];
    const lastUser = [...conversation.turns].reverse().find((turn) => turn.role === "user");
    grouped[key].push({
      id: conversation.id,
      title: conversation.title,
      summary: lastUser?.content.slice(0, 90) ?? "Stored Metis conversation",
      age: ageLabel(conversation.updatedAt)
    });
  }
  return grouped;
}

function conversationProjectMatchesPath(conversation: ConversationRecord, projectPath?: string): boolean {
  return (conversation.projectPath ?? "").toLowerCase() === (projectPath ?? "").toLowerCase();
}

export function App(): JSX.Element {
  const [activeNav, setActiveNav] = useState<NavKey>("benchmark");
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [storedConversations, setStoredConversations] = useState<ConversationRecord[]>([]);
  const [openConversation, setOpenConversation] = useState<ConversationRecord | null>(null);
  const initialNavResolved = useRef(false);

  // Parallel sessions phase A (docs/FABLE_PLANS.md section 3) — pending-turn
  // and busy state live HERE, not inside NewSessionWorkspace, because that
  // component remounts (key={sessionKey}) every time the user opens a new
  // draft session or switches conversations. Keeping this state above the
  // remount boundary is what lets a run keep streaming in the background
  // while the user navigates elsewhere. Keyed by "conversation key": the real
  // conversationId once known, else a `draft-<timestamp>` key for a brand-new
  // session whose first run hasn't returned a conversationId yet.
  const [pendingByConversation, setPendingByConversation] = useState<Record<string, ConversationTurn[]>>({});
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  // Consulted by every in-flight stream-event write so a run started under a
  // draft-<ts> key keeps landing in the right bucket after the first response
  // migrates that bucket to the real conversationId (see submitPrompt in
  // NewSessionWorkspace). A ref (not state) because it must be read inside
  // closures created before the migration happened, without re-render.
  const draftToRealRef = useRef<Map<string, string>>(new Map());

  const refreshConversations = useCallback(() => {
    if (window.metisConversations) void window.metisConversations.list().then(setStoredConversations);
  }, []);

  const openConversationById = useCallback(
    (id: string) => {
      const record = storedConversations.find((conversation) => conversation.id === id);
      if (!record) return;
      setOpenConversation(record);
      setActiveNav("session");
    },
    [storedConversations]
  );
  const deleteConversationById = useCallback(
    async (id: string) => {
      if (!window.metisConversations) return;
      const record = storedConversations.find((conversation) => conversation.id === id);
      const confirmed = window.confirm(`Delete "${record?.title ?? "this conversation"}"? This removes the stored chat and its run history.`);
      if (!confirmed) return;
      const next = await window.metisConversations.delete(id);
      setStoredConversations(next);
      if (openConversation?.id === id) {
        setOpenConversation(null);
        setSessionKey((current) => current + 1);
      }
    },
    [openConversation?.id, storedConversations]
  );
  const renameConversationById = useCallback(
    async (id: string, title: string) => {
      if (!window.metisConversations) return;
      const next = await window.metisConversations.rename(id, title);
      setStoredConversations(next);
      if (openConversation?.id === id) {
        const updated = next.find((conversation) => conversation.id === id);
        if (updated) setOpenConversation(updated);
      }
    },
    [openConversation?.id]
  );
  const archiveConversationById = useCallback(
    async (id: string, archived: boolean) => {
      if (!window.metisConversations) return;
      const next = await window.metisConversations.archive(id, archived);
      setStoredConversations(next);
      if (archived && openConversation?.id === id) {
        setOpenConversation(null);
        setSessionKey((current) => current + 1);
      } else if (openConversation?.id === id) {
        const updated = next.find((conversation) => conversation.id === id);
        if (updated) setOpenConversation(updated);
      }
    },
    [openConversation?.id]
  );
  const deleteProjectByPath = useCallback(
    async (project: ProjectFolder) => {
      if (!window.metisConversations) return;
      const confirmed = window.confirm(`Delete "${project.name}" conversations? This removes stored chats and run history for that project.`);
      if (!confirmed) return;
      const next = await window.metisConversations.deleteProject(project.path);
      setStoredConversations(next);
      setExpandedProject(null);
      if (openConversation && conversationProjectMatchesPath(openConversation, project.path)) {
        setOpenConversation(null);
        setSessionKey((current) => current + 1);
      }
    },
    [openConversation]
  );
  const [benchmarkWizard, setBenchmarkWizard, benchmarkLoaded] = useAppStoreState("benchmarkWizard", DEFAULT_BENCHMARK_STATE);
  const [galleryBoards, setGalleryBoards] = useAppStoreState("galleryBoards", DEFAULT_GALLERY_BOARDS);
  const [pinnedConversationIds, setPinnedConversationIds] = useAppStoreState("pinnedConversationIds", [] as string[]);
  const benchmarkGateLocked = !benchmarkLoaded || benchmarkWizard.status !== "complete";
  // Gallery boards are always part of orchestration now (docs/FABLE_PLANS.md section 23) —
  // no per-board "linked" toggle, every board's title feeds the skills palette.
  const linkedGallerySkills = useMemo(() => galleryBoards.map((board) => `Gallery: ${board.title}`), [galleryBoards]);
  // Style memory for the orchestration graph's moodboard visualisation (owner idea: "Gallery
  // model-visualisation inside orchestration"): read the same window.metisGallery.cards() bridge
  // GalleryWorkspace uses, independently, so the graph can render a board's palette/cover without
  // a parallel store. Re-read on nav changes so a just-analyzed board's palette shows up once the
  // user switches back to Orchestration; a no-op (empty array) in preview where the bridge is absent.
  const [galleryStyleCards, setGalleryStyleCards] = useState<StyleCard[]>([]);
  useEffect(() => {
    if (!window.metisGallery) return;
    let cancelled = false;
    window.metisGallery
      .cards()
      .then((cards) => {
        if (!cancelled) setGalleryStyleCards(cards);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeNav]);
  const galleryVisuals = useMemo<Record<string, GalleryVisual>>(() => {
    const map: Record<string, GalleryVisual> = {};
    for (const board of galleryBoards) {
      const palette: string[] = [];
      for (const card of galleryStyleCards) {
        if (card.boardId !== board.id) continue;
        for (const hex of card.palette) {
          if (hex && !palette.includes(hex)) palette.push(hex);
          if (palette.length >= 5) break;
        }
        if (palette.length >= 5) break;
      }
      map[`Gallery: ${board.title}`] = { coverImage: board.coverImage, palette };
    }
    return map;
  }, [galleryBoards, galleryStyleCards]);
  const activeStoredConversations = useMemo(() => storedConversations.filter((conversation) => !conversation.archived), [storedConversations]);
  const archivedConversations = useMemo(
    () =>
      storedConversations
        .filter((conversation) => conversation.archived)
        .map((conversation) => ({ id: conversation.id, title: conversation.title, age: ageLabel(conversation.updatedAt) })),
    [storedConversations]
  );
  const sidebarProjects = useMemo(() => conversationProjects(activeStoredConversations), [activeStoredConversations]);
  const sidebarConversations = useMemo(() => conversationsByProject(activeStoredConversations), [activeStoredConversations]);
  const pinnedConversations = useMemo(
    () =>
      pinnedConversationIds
        .map((id) => storedConversations.find((conversation) => conversation.id === id))
        .filter((conversation): conversation is ConversationRecord => Boolean(conversation))
        .map((conversation) => ({ id: conversation.id, title: conversation.title })),
    [pinnedConversationIds, storedConversations]
  );
  const toggleConversationPinned = useCallback(
    (id: string) => {
      void setPinnedConversationIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    },
    [setPinnedConversationIds]
  );

  function startNewSession(): void {
    if (benchmarkGateLocked) {
      setActiveNav("benchmark");
      return;
    }
    setOpenConversation(null);
    setSessionKey((current) => current + 1);
    setActiveNav("session");
  }

  function selectNav(key: NavKey): void {
    if (benchmarkGateLocked && key !== "benchmark" && key !== "settings") {
      setActiveNav("benchmark");
      return;
    }
    if (key !== "session") setOpenConversation(null);
    setActiveNav(key);
  }

  function selectProject(project: ProjectFolder): void {
    if (benchmarkGateLocked) {
      setActiveNav("benchmark");
      return;
    }
    setExpandedProject((current) => (current === project.name ? null : project.name));
  }

  useEffect(() => {
    void Promise.all([
      readAppStore("marketplaceState", DEFAULT_MARKETPLACE_STATE).then((value) => writeAppStore("marketplaceState", value)),
      readAppStore("settings", DEFAULT_SETTINGS).then((value) => writeAppStore("settings", value)),
      // Settings > Appearance persists here (docs/FABLE_PLANS.md settings
      // rebuild) — apply it once on every app load so a chosen accent/density/
      // font-size takes effect immediately, not only while Settings is open.
      readAppStore("appearance", DEFAULT_APPEARANCE).then((value) => {
        const merged = { ...DEFAULT_APPEARANCE, ...value };
        applyAppearance(merged);
        return writeAppStore("appearance", merged);
      })
    ]);
    if (window.metisConversations) {
      void window.metisConversations.list().then(setStoredConversations);
    }
  }, []);

  /** Settings > MCP servers "Add more" — stages the Marketplace's MCP filter
   *  in the shared `marketplaceState` store key before navigating, so the tab
   *  opens straight onto the MCP category (MarketplaceWorkspace reads this
   *  key itself on mount; no new bridge needed). */
  function openMcpMarketplace(): void {
    void writeAppStore("marketplaceState", { category: "mcp", query: "" } as MarketplaceState).then(() => setActiveNav("marketplace"));
  }

  useEffect(() => {
    if (!benchmarkLoaded) {
      setActiveNav("benchmark");
      return;
    }

    if (!initialNavResolved.current) {
      initialNavResolved.current = true;
      setActiveNav(benchmarkWizard.status === "complete" ? "orchestration" : "benchmark");
      return;
    }

    if (benchmarkWizard.status !== "complete") {
      setActiveNav("benchmark");
      setExpandedProject(null);
    }
  }, [benchmarkLoaded, benchmarkWizard.status]);

  return (
    <div className="app-root">
      <Titlebar collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((current) => !current)} onOpenPulse={() => setActiveNav("pulse")} />
      <div className={`metis-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${activeNav === "settings" ? "settings-mode" : ""}`}>
      {activeNav !== "settings" ? (
        <Sidebar
          activeNav={activeNav}
          activeProject={expandedProject}
          archivedConversations={archivedConversations}
          benchmarkLocked={benchmarkGateLocked}
          busyKeys={busyKeys}
          collapsed={sidebarCollapsed}
          conversationsByProject={sidebarConversations}
          onConversationArchive={archiveConversationById}
          onConversationOpen={openConversationById}
          onConversationDelete={deleteConversationById}
          onConversationRename={renameConversationById}
          onNewSession={startNewSession}
          onNewSessionForProject={(project) => {
            setExpandedProject(project.name);
            startNewSession();
          }}
          onProjectDelete={deleteProjectByPath}
          onProjectSelect={selectProject}
          onSelect={selectNav}
          onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
          onTogglePinned={toggleConversationPinned}
          pinnedConversationIds={pinnedConversationIds}
          pinnedConversations={pinnedConversations}
          projects={sidebarProjects}
        />
      ) : null}
      {activeNav === "session" ? (
        <NewSessionWorkspace
          key={sessionKey}
          openConversation={openConversation}
          onConversationsChanged={refreshConversations}
          onNewSession={startNewSession}
          storedConversations={storedConversations}
          pendingByConversation={pendingByConversation}
          setPendingByConversation={setPendingByConversation}
          busyKeys={busyKeys}
          setBusyKeys={setBusyKeys}
          draftToRealRef={draftToRealRef}
        />
      ) : null}
      {activeNav === "graph" ? (
        <MemoryGraphWorkspace onConversationOpen={openConversationById} />
      ) : null}
      {activeNav === "benchmark" ? <BenchmarkWorkspace locked={benchmarkGateLocked} onComplete={() => setActiveNav("orchestration")} onWizardChange={setBenchmarkWizard} wizard={benchmarkWizard} /> : null}
      {activeNav === "gallery" ? <GalleryWorkspace boards={galleryBoards} onBoardsChange={setGalleryBoards} /> : null}
      {activeNav === "marketplace" ? <MarketplaceWorkspace /> : null}
      {activeNav === "routines" ? <RoutinesWorkspace onConversationOpen={openConversationById} /> : null}
      {activeNav === "todo" ? <TodoWorkspace storedConversations={storedConversations} /> : null}
      {activeNav === "manager" ? <ManagerWorkspace onNavigate={setActiveNav} /> : null}
      {activeNav === "pulse" ? <PulseWorkspace /> : null}
      {activeNav === "settings" ? (
        <SettingsWorkspace onBack={() => setActiveNav(benchmarkWizard.status === "complete" ? "orchestration" : "benchmark")} onOpenMcpMarketplace={openMcpMarketplace} />
      ) : null}
      {activeNav !== "session" && activeNav !== "graph" && activeNav !== "benchmark" && activeNav !== "gallery" && activeNav !== "marketplace" && activeNav !== "routines" && activeNav !== "todo" && activeNav !== "manager" && activeNav !== "pulse" && activeNav !== "settings" ? (
        <GraphWorkspace activeNav={activeNav} gallerySkills={linkedGallerySkills} galleryVisuals={galleryVisuals} />
      ) : null}
      </div>
      <ManagerWidget />
    </div>
  );
}

type HealthRowStatus = "ok" | "warn" | "error" | "loading" | "unavailable";
type HealthRow = { id: string; name: string; status: HealthRowStatus; detail: string };

function healthDotClass(status: HealthRowStatus): string {
  if (status === "ok") return "ok";
  if (status === "warn") return "warn";
  if (status === "error") return "error";
  return "never";
}

/** Real Run Test results popover, anchored to the Orchestration toolbar's Run test button
 *  (docs/FABLE_PLANS.md section 18). Folds in what used to be the titlebar "Check everything"
 *  health sweep: a policy route-decision row plus a per-agent-node provider health row. Reuses
 *  the health-sweep row styling verbatim. */
function RunTestPanel({
  loading,
  result,
  onClose,
  onRerun
}: {
  loading: boolean;
  result: RunTestResult | null;
  onClose: () => void;
  onRerun: () => void;
}): JSX.Element {
  return (
    <div className="healthsweep-panel run-test-panel" role="dialog" aria-label="Run test results">
      <header className="healthsweep-head">
        <Play size={14} />
        <strong>Run test</strong>
        <button type="button" className="healthsweep-rerun" onClick={onRerun} disabled={loading}>
          {loading ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
          <span>Re-run</span>
        </button>
        <button type="button" aria-label="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </header>
      <div className="healthsweep-rows">
        {loading && !result ? <p className="healthsweep-empty">Routing a test prompt…</p> : null}
        {result ? (
          <>
            <div className="healthsweep-row" key="route">
              <span className={`healthsweep-dot ${healthDotClass(result.routeStatus)}`} aria-hidden="true" />
              <span className="healthsweep-row-body">
                <strong>{result.routeLabel}</strong>
                <small title={result.routeDetail}>{result.routeDetail}</small>
              </span>
            </div>
            <p className="run-test-subhead">Agent nodes</p>
            {result.agents.map((row) => (
              <div className="healthsweep-row" key={row.id}>
                <span className={`healthsweep-dot ${healthDotClass(row.status)}`} aria-hidden="true" title={row.detail} />
                <span className="healthsweep-row-body">
                  <strong>{row.name}</strong>
                  <small title={row.detail}>{row.model}</small>
                </span>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Titlebar({
  collapsed,
  onToggleCollapse,
  onOpenPulse
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenPulse: () => void;
}): JSX.Element {
  const hasWindow = typeof window !== "undefined" && Boolean(window.metisWindow);
  const [pulse, setPulse] = useState<PulseFeed>(FALLBACK_PULSE);
  const [lastSeenPulse, setLastSeenPulse] = useAppStoreState<string | undefined>("lastSeenPulse", undefined);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | undefined>(undefined);

  useEffect(() => {
    if (!window.metisPulse) return;
    window.metisPulse
      .feed()
      .then((feed) => setPulse(feed))
      .catch(() => undefined);
  }, []);

  // Titlebar "Update available" badge (see UpdateCheckResult / metis-updates:check in
  // main.ts): a one-shot check on mount, guarded for `window.metisUpdates` being absent
  // in the browser/preview build. This only checks + surfaces a badge that links out to
  // the GitHub release page — true auto-download/install (electron-updater against
  // published GitHub Releases) is a follow-up needing a publish config + packaged app.
  useEffect(() => {
    if (!window.metisUpdates) return;
    window.metisUpdates
      .check()
      .then((result) => setUpdateCheck(result))
      .catch(() => undefined);
  }, []);

  const hasUnseenUpdate = Boolean(pulse.updated && pulse.updated !== lastSeenPulse);

  function handleOpenPulse(): void {
    if (pulse.updated) setLastSeenPulse(pulse.updated);
    onOpenPulse();
  }

  function handleOpenUpdate(): void {
    if (updateCheck?.url && window.metisShell) {
      window.metisShell.openExternal(updateCheck.url);
      return;
    }
    onOpenPulse();
  }

  return (
    <div className="titlebar">
      <div className="titlebar-tools">
        <button className="titlebar-icon" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggleCollapse}>
          <Menu size={17} />
        </button>
        <button className="titlebar-icon" type="button" aria-label="Search" title="Global search — coming soon" disabled>
          <Search size={16} />
        </button>
        <button className="titlebar-icon" type="button" aria-label="Pulse" onClick={handleOpenPulse}>
          <Newspaper size={16} />
          {hasUnseenUpdate ? <span className="pulse-dot" aria-hidden="true" /> : null}
        </button>
        {updateCheck?.updateAvailable ? (
          <button
            className="titlebar-update-badge"
            type="button"
            title={updateCheck.latestVersion ? `v${updateCheck.latestVersion} available` : "Update available"}
            onClick={handleOpenUpdate}
          >
            <Download size={12} />
            <span>Update available</span>
          </button>
        ) : null}
      </div>
      <div className="titlebar-drag" />
      {hasWindow ? (
        <div className="window-controls">
          <button type="button" aria-label="Minimize" onClick={() => window.metisWindow?.minimize()}>
            <Minus size={15} />
          </button>
          <button type="button" aria-label="Maximize" onClick={() => window.metisWindow?.toggleMaximize()}>
            <Square size={12} />
          </button>
          <button type="button" className="window-close" aria-label="Close" onClick={() => window.metisWindow?.close()}>
            <X size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Pulse, promoted from a titlebar popover to a full nav view (docs/FABLE_PLANS.md section 18) —
 *  a centered, generously-spaced feed: Changelog as a vertical timeline, Community as cards,
 *  News as compact link rows via openExternal. Reuses window.metisPulse.feed() verbatim. */
function PulseWorkspace(): JSX.Element {
  const [pulse, setPulse] = useState<PulseFeed>(FALLBACK_PULSE);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (!window.metisPulse) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.metisPulse
      .feed()
      .then(setPulse)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasAny = pulse.changelog.length > 0 || pulse.community.length > 0 || pulse.news.length > 0;

  // Featured hero = first news entry; falls back to the first community package so the
  // bento never opens on an empty hero when only community data is present.
  const heroEntry = pulse.news[0];
  const heroCommunity = heroEntry ? undefined : pulse.community[0];
  const hero: { title: string; blurb?: string; image?: string; tag?: string } | null = heroEntry
    ? { title: heroEntry.title, blurb: heroEntry.blurb, image: heroEntry.image, tag: heroEntry.tag }
    : heroCommunity
    ? { title: heroCommunity.name, blurb: heroCommunity.description, image: heroCommunity.images?.[0], tag: "COMMUNITY" }
    : null;
  const restNews = heroEntry ? pulse.news.slice(1) : pulse.news;
  const restCommunity = heroCommunity ? pulse.community.slice(1) : pulse.community;

  return (
    <main className="product-workspace pulse-workspace" aria-label="Pulse">
      <div className="pulse-workspace-column">
        <header className="pulse-workspace-head">
          <h1>Pulse</h1>
          <p>{pulse.status === "offline" ? "Showing the cached feed — offline" : "News, community projects, and what's new"}</p>
          <button type="button" className="pulse-workspace-refresh" onClick={refresh} disabled={loading}>
            {loading ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
            <span>Refresh</span>
          </button>
        </header>

        {!hasAny && !loading ? <p className="pulse-empty">Nothing new yet.</p> : null}

        <div className="pulse-bento">
          {hero
            ? (() => {
                const clickable = Boolean(heroEntry?.url);
                const className = `pulse-tile pulse-tile-hero${hero.image ? " image" : ""}`;
                const style: CSSProperties | undefined = hero.image ? { backgroundImage: `url(${hero.image})` } : undefined;
                const body = (
                  <>
                    {hero.image ? <div className="pulse-scrim" aria-hidden="true" /> : null}
                    <div className="pulse-tile-body">
                      <span className="pulse-tag">{hero.tag ?? "FEATURED"}</span>
                      <h2>{hero.title}</h2>
                      {hero.blurb ? <p>{hero.blurb}</p> : null}
                    </div>
                  </>
                );
                return clickable ? (
                  <button type="button" className={className} style={style} onClick={() => openExternal(heroEntry!.url)}>
                    {body}
                  </button>
                ) : (
                  <article className={className} style={style}>
                    {body}
                  </article>
                );
              })()
            : null}

          {restNews.map((entry) => (
            <button
              key={entry.url}
              type="button"
              className={`pulse-tile pulse-tile-news${entry.image ? " image" : ""}`}
              style={entry.image ? { backgroundImage: `url(${entry.image})` } : undefined}
              onClick={() => openExternal(entry.url)}
            >
              {entry.image ? <div className="pulse-scrim" aria-hidden="true" /> : null}
              <div className="pulse-tile-body">
                <span className="pulse-tag">{entry.tag ?? "NEWS"}</span>
                <h3>{entry.title}</h3>
                {entry.blurb ? <p>{entry.blurb}</p> : null}
                {!entry.image ? <ExternalLink size={14} className="pulse-tile-link-icon" aria-hidden="true" /> : null}
              </div>
            </button>
          ))}

          {restCommunity.map((item) => (
            <article className="pulse-tile pulse-tile-community" key={item.id}>
              <span className="pulse-tag">BUILT WITH METIS</span>
              {item.images?.[0] ? (
                <div className="pulse-tile-art" style={{ backgroundImage: `url(${item.images[0]})` }} aria-hidden="true" />
              ) : item.ascii_art?.length ? (
                <pre className="pulse-tile-ascii">{item.ascii_art.join("\n")}</pre>
              ) : null}
              <div className="pulse-tile-body">
                <strong>{item.name}</strong>
                <p>{item.description}</p>
                <small>{item.publisher}</small>
              </div>
            </article>
          ))}

          {pulse.changelog.length ? (
            <article className="pulse-tile pulse-tile-changelog">
              <span className="pulse-tag">WHAT'S NEW</span>
              <ul className="pulse-changelog-list">
                {pulse.changelog.slice(0, 3).map((entry) => (
                  <li key={`${entry.date}-${entry.title}`}>
                    <span className="pulse-changelog-date">{entry.date}</span>
                    <span className="pulse-changelog-title">{entry.title}</span>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}

          <button
            type="button"
            className="pulse-tile pulse-tile-discord"
            onClick={() => openExternal(pulse.discordInvite ?? "https://discord.gg/")}
          >
            <span className="pulse-discord-icon">
              <img
                src="assets/providers/discord.png"
                alt="Discord"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                  const fallback = event.currentTarget.nextElementSibling;
                  if (fallback) fallback.classList.remove("hidden");
                }}
              />
              <MessageCircle size={28} className="pulse-discord-fallback hidden" aria-hidden="true" />
            </span>
            <div className="pulse-tile-body">
              <strong>Join the community!</strong>
              <p>Chat with other builders, share pipelines, and get help on Discord.</p>
            </div>
          </button>
        </div>
      </div>
    </main>
  );
}

type RowMenuTarget = { kind: "conversation"; id: string } | { kind: "project"; project: ProjectFolder };

function Sidebar({
  activeNav,
  activeProject,
  archivedConversations,
  benchmarkLocked,
  busyKeys,
  collapsed,
  conversationsByProject,
  onConversationArchive,
  onConversationDelete,
  onConversationOpen,
  onConversationRename,
  onNewSession,
  onNewSessionForProject,
  onProjectDelete,
  onProjectSelect,
  onSelect,
  onToggleCollapse,
  onTogglePinned,
  pinnedConversationIds,
  pinnedConversations,
  projects
}: {
  activeNav: NavKey;
  activeProject: string | null;
  archivedConversations: { id: string; title: string; age: string }[];
  benchmarkLocked: boolean;
  /** Parallel sessions phase A: conversation keys (real conversationId or
   *  draft-<timestamp>) with a run currently streaming. Drives the pulsing
   *  busy dot on sidebar rows; also lets the "New session" row show a dot
   *  when an as-yet-unnamed draft session is mid-run. */
  busyKeys: Set<string>;
  collapsed: boolean;
  conversationsByProject: Record<string, SidebarConversation[]>;
  onConversationArchive: (id: string, archived: boolean) => void;
  onConversationDelete: (id: string) => void;
  onConversationOpen: (id: string) => void;
  onConversationRename: (id: string, title: string) => void;
  onNewSession: () => void;
  onNewSessionForProject: (project: ProjectFolder) => void;
  onProjectDelete: (project: ProjectFolder) => void;
  onProjectSelect: (project: ProjectFolder) => void;
  onSelect: (key: NavKey) => void;
  onToggleCollapse: () => void;
  onTogglePinned: (id: string) => void;
  pinnedConversationIds: string[];
  pinnedConversations: { id: string; title: string }[];
  projects: ProjectFolder[];
}): JSX.Element {
  const [accountOpen, setAccountOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [rowMenu, setRowMenu] = useState<RowMenuTarget | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);

  function toggleRowMenu(target: RowMenuTarget): void {
    setRowMenu((current) =>
      current &&
      current.kind === target.kind &&
      (current.kind === "conversation" ? current.id === (target as { kind: "conversation"; id: string }).id : current.project.name === (target as { kind: "project"; project: ProjectFolder }).project.name)
        ? null
        : target
    );
  }

  function beginRename(id: string, currentTitle: string): void {
    setRenamingId(id);
    setRenameDraft(currentTitle);
  }

  function commitRename(id: string): void {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (title) onConversationRename(id, title);
  }

  // Any still-streaming draft session (no conversationId yet) shows as a dot
  // on "New session" itself, since there's no row for it yet.
  const hasBusyDraft = useMemo(() => Array.from(busyKeys).some((key) => key.startsWith("draft-")), [busyKeys]);

  const visibleProjects = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => project.name.toLowerCase().includes(query) || project.latest.toLowerCase().includes(query));
  }, [projects, filterText]);

  function openSettings(): void {
    setAccountOpen(false);
    onSelect("settings");
  }

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <button
        className={`new-session ${activeNav === "session" ? "active" : ""}`}
        type="button"
        disabled={benchmarkLocked}
        title={benchmarkLocked ? "Finish the benchmark wizard first" : undefined}
        onClick={onNewSession}
      >
        <Plus size={18} />
        <span>New session</span>
        {hasBusyDraft ? <span className="row-busy-dot" aria-label="A new session is still running" title="A new session is still running" /> : null}
      </button>

      <div className="sidebar-scroll">
      <nav className="sidebar-nav" aria-label="Primary">
        <NavButton active={activeNav === "orchestration"} disabled={benchmarkLocked} icon={<GitBranch size={16} />} label="Orchestration" onClick={() => onSelect("orchestration")} />
        <NavButton active={activeNav === "manager"} disabled={benchmarkLocked} icon={<Bot size={16} />} label="Manager" onClick={() => onSelect("manager")} />
        <NavButton active={activeNav === "marketplace"} disabled={benchmarkLocked} icon={<Cable size={16} />} label="Marketplace" onClick={() => onSelect("marketplace")} />
        {moreOpen ? (
          <>
            <NavButton active={activeNav === "routines"} disabled={benchmarkLocked} icon={<CalendarClock size={16} />} label="Routines" onClick={() => onSelect("routines")} />
            <NavButton active={activeNav === "todo"} disabled={benchmarkLocked} icon={<ListTodo size={16} />} label="To Do List" onClick={() => onSelect("todo")} />
            <NavButton active={activeNav === "gallery"} disabled={benchmarkLocked} icon={<GalleryHorizontalEnd size={16} />} label="Gallery" onClick={() => onSelect("gallery")} />
            <NavButton active={activeNav === "graph"} disabled={benchmarkLocked} icon={<Network size={16} />} label="Graph View" onClick={() => onSelect("graph")} />
            <NavButton active={activeNav === "benchmark"} icon={<Cpu size={16} />} label="Benchmark" onClick={() => onSelect("benchmark")} />
          </>
        ) : null}
        <button className="nav-more" type="button" onClick={() => setMoreOpen((open) => !open)}>
          <ChevronDown className={moreOpen ? "open" : ""} size={14} />
          <span>{moreOpen ? "Less" : "More"}</span>
        </button>
      </nav>

      {pinnedConversations.length ? (
        <SidebarSection title="Pinned">
          {pinnedConversations.map((item) => (
            <button className="tiny-row" key={item.id} type="button" onClick={() => onConversationOpen(item.id)}>
              <Pin size={13} />
              <span>{item.title}</span>
            </button>
          ))}
        </SidebarSection>
      ) : null}

      <SidebarSection
        action={
          <>
            <button type="button" aria-label="Filter project folders" className={filterOpen ? "active" : ""} onClick={() => setFilterOpen((open) => !open)}>
              <SlidersHorizontal size={14} />
            </button>
            <button type="button" aria-label="New session" onClick={onNewSession}>
              <Plus size={15} />
            </button>
          </>
        }
        title="Project folders"
      >
        {filterOpen ? (
          <div className="sidebar-filter" role="search">
            <Search size={13} />
            <input value={filterText} placeholder="Filter folders" onChange={(event) => setFilterText(event.target.value)} />
            {filterText ? (
              <button type="button" aria-label="Clear filter" onClick={() => setFilterText("")}>
                <X size={12} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="project-list">
          {visibleProjects.length === 0 && projects.length > 0 ? <p className="sidebar-empty">No folders match that filter.</p> : null}
          {visibleProjects.map((project) => {
            const expanded = activeProject === project.name;
            const conversations = conversationsByProject[project.name] ?? [];
            const projectMenuOpen = rowMenu?.kind === "project" && rowMenu.project.name === project.name;
            return (
              <div className={`project-group ${expanded ? "expanded" : ""}`} key={project.name}>
                <div className="project-row-wrap row-menu-wrap">
                  <button
                    className={`project-row ${expanded ? "active" : ""}`}
                    type="button"
                    disabled={benchmarkLocked}
                    title={benchmarkLocked ? "Finish the benchmark wizard first" : undefined}
                    onClick={() => onProjectSelect(project)}
                  >
                    <ChevronRight className={expanded ? "open" : ""} size={14} />
                    <Folder size={16} />
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.latest}</small>
                    </span>
                  </button>
                  <button
                    className={`row-menu-btn ${projectMenuOpen ? "open" : ""}`}
                    type="button"
                    aria-label={`More actions for ${project.name}`}
                    disabled={benchmarkLocked}
                    onClick={() => toggleRowMenu({ kind: "project", project })}
                  >
                    <MoreVertical size={14} />
                  </button>
                  {projectMenuOpen ? (
                    <>
                      <button className="router-backdrop" type="button" aria-label="Close menu" onClick={() => setRowMenu(null)} />
                      <div className="row-menu-popover" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setRowMenu(null);
                            onNewSessionForProject(project);
                          }}
                        >
                          <Plus size={13} />
                          <span>New session here</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => {
                            setRowMenu(null);
                            onProjectDelete(project);
                          }}
                        >
                          <Trash2 size={13} />
                          <span>Delete chats</span>
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
                {expanded ? (
                  <div className="project-conversations">
                    {conversations.map((conversation) => {
                      const conversationMenuOpen = rowMenu?.kind === "conversation" && rowMenu.id === conversation.id;
                      const isPinned = pinnedConversationIds.includes(conversation.id);
                      const isRenaming = renamingId === conversation.id;
                      return (
                        <div className="project-conversation-wrap row-menu-wrap" key={conversation.id}>
                          {isRenaming ? (
                            <input
                              autoFocus
                              className="project-conversation-rename-input"
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onBlur={() => commitRename(conversation.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitRename(conversation.id);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  setRenamingId(null);
                                }
                              }}
                            />
                          ) : (
                            <button className="project-conversation-row" type="button" onClick={() => onConversationOpen(conversation.id)}>
                              <span>
                                <strong>{conversation.title}</strong>
                                <small>{conversation.summary}</small>
                              </span>
                            </button>
                          )}
                          {busyKeys.has(conversation.id) ? (
                            <span className="row-busy-dot" aria-label="Run in progress" title="Run in progress" />
                          ) : null}
                          <button
                            className={`row-menu-btn ${conversationMenuOpen ? "open" : ""}`}
                            type="button"
                            aria-label={`More actions for ${conversation.title}`}
                            onClick={() => toggleRowMenu({ kind: "conversation", id: conversation.id })}
                          >
                            <MoreVertical size={14} />
                          </button>
                          {conversationMenuOpen ? (
                            <>
                              <button className="router-backdrop" type="button" aria-label="Close menu" onClick={() => setRowMenu(null)} />
                              <div className="row-menu-popover" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    setRowMenu(null);
                                    onTogglePinned(conversation.id);
                                  }}
                                >
                                  {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                                  <span>{isPinned ? "Unpin" : "Pin"}</span>
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    setRowMenu(null);
                                    beginRename(conversation.id, conversation.title);
                                  }}
                                >
                                  <Pencil size={13} />
                                  <span>Rename</span>
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    setRowMenu(null);
                                    onConversationArchive(conversation.id, true);
                                  }}
                                >
                                  <Archive size={13} />
                                  <span>Archive</span>
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="danger"
                                  onClick={() => {
                                    setRowMenu(null);
                                    onConversationDelete(conversation.id);
                                  }}
                                >
                                  <Trash2 size={13} />
                                  <span>Delete</span>
                                </button>
                              </div>
                            </>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SidebarSection>

      {archivedConversations.length > 0 ? (
        <SidebarSection
          action={
            <button type="button" aria-label={archivedOpen ? "Collapse archived" : "Expand archived"} onClick={() => setArchivedOpen((open) => !open)}>
              <ChevronDown className={archivedOpen ? "open" : ""} size={14} />
            </button>
          }
          title="Archived"
        >
          {archivedOpen ? (
            <div className="project-conversations">
              {archivedConversations.map((conversation) => {
                const conversationMenuOpen = rowMenu?.kind === "conversation" && rowMenu.id === conversation.id;
                return (
                  <div className="project-conversation-wrap row-menu-wrap" key={conversation.id}>
                    <button className="project-conversation-row" type="button" onClick={() => onConversationOpen(conversation.id)}>
                      <span>
                        <strong>{conversation.title}</strong>
                        <small>{conversation.age}</small>
                      </span>
                    </button>
                    <button
                      className={`row-menu-btn ${conversationMenuOpen ? "open" : ""}`}
                      type="button"
                      aria-label={`More actions for ${conversation.title}`}
                      onClick={() => toggleRowMenu({ kind: "conversation", id: conversation.id })}
                    >
                      <MoreVertical size={14} />
                    </button>
                    {conversationMenuOpen ? (
                      <>
                        <button className="router-backdrop" type="button" aria-label="Close menu" onClick={() => setRowMenu(null)} />
                        <div className="row-menu-popover" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setRowMenu(null);
                              onConversationArchive(conversation.id, false);
                            }}
                          >
                            <ArchiveRestore size={13} />
                            <span>Unarchive</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="danger"
                            onClick={() => {
                              setRowMenu(null);
                              onConversationDelete(conversation.id);
                            }}
                          >
                            <Trash2 size={13} />
                            <span>Delete</span>
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </SidebarSection>
      ) : null}
      </div>

      <div className="account-wrap">
        {accountOpen ? (
          <>
            <button className="account-backdrop" type="button" aria-label="Close account menu" onClick={() => setAccountOpen(false)} />
            <div className="account-menu" role="menu">
              <div className="account-menu-head">{ACCOUNT_EMAIL}</div>
              <div className="account-menu-group">
                <button type="button" role="menuitem" onClick={openSettings}>
                  <Settings size={15} />
                  <span>Settings</span>
                  <em>Ctrl ,</em>
                </button>
                <button type="button" role="menuitem" title="Coming soon" disabled>
                  <Globe size={15} />
                  <span>Language</span>
                  <ChevronRight size={14} className="account-menu-caret" />
                </button>
                <button type="button" role="menuitem" onClick={() => openExternal(`${METIS_REPO_URL}/issues`)}>
                  <HelpCircle size={15} />
                  <span>Get help</span>
                </button>
              </div>
              <div className="account-menu-group">
                <button type="button" role="menuitem" onClick={() => openExternal(METIS_REPO_URL)}>
                  <Github size={15} />
                  <span>GitHub repo</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false);
                    onSelect("pulse");
                  }}
                >
                  <ScrollText size={15} />
                  <span>View changelog</span>
                </button>
              </div>
              <div className="account-menu-group">
                <button type="button" role="menuitem" title="Coming soon" disabled>
                  <LogOut size={15} />
                  <span>Log out</span>
                </button>
              </div>
            </div>
          </>
        ) : null}
        <button className={`account-row ${accountOpen || activeNav === "settings" ? "active" : ""}`} type="button" onClick={() => setAccountOpen((open) => !open)}>
          <span>bro</span>
          <small>Pro</small>
          <ChevronDown size={15} />
        </button>
      </div>
    </aside>
  );
}

function NavButton({
  active,
  badge,
  disabled = false,
  icon,
  label,
  onClick
}: {
  active: boolean;
  badge?: string;
  disabled?: boolean;
  icon: JSX.Element;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button className={`nav-row ${active ? "active" : ""}`} type="button" disabled={disabled} title={disabled ? "Finish the benchmark wizard first" : undefined} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {badge ? <em>{badge}</em> : null}
    </button>
  );
}

function SidebarSection({ action, children, title }: { action?: JSX.Element; children: ReactNode; title: string }): JSX.Element {
  return (
    <section className="sidebar-section">
      <div className="section-title">
        <span>{title}</span>
        {action ? <div className="section-actions">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

type SelectOption = { value: string; label: string; hint?: string };

function CustomSelect({
  ariaLabel,
  className,
  onChange,
  options,
  placeholder,
  value
}: {
  ariaLabel?: string;
  className?: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  value: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`custom-select ${open ? "open" : ""} ${className ?? ""}`} ref={ref}>
      <button type="button" className="custom-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((value) => !value)}>
        <span>{current ? current.label : placeholder ?? "Select"}</span>
        <ChevronDown className="custom-select-caret" size={15} />
      </button>
      {open ? (
        <div className="custom-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`custom-option ${option.value === value ? "selected" : ""}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="custom-option-text">
                <span>{option.label}</span>
                {option.hint ? <small>{option.hint}</small> : null}
              </span>
              {option.value === value ? <Check size={15} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Five permission modes (docs/FABLE_PLANS.md section 24), replacing the old
 *  restricted/standard/trusted three-level scheme. Selected in the composer's
 *  Permissions popover and persisted via useAppStoreState("permissionMode"). */
const PERMISSION_MODES: { key: PermissionMode; label: string; desc: string }[] = [
  { key: "ask", label: "Ask Permissions", desc: "Every file write, command, and new network scope pauses the run and asks." },
  { key: "edits", label: "Accept Edits", desc: "File writes auto-approved; commands and new scopes still ask." },
  { key: "plan", label: "Plan Mode", desc: "Read-only — plans and reports what it would do. No writes, no commands." },
  { key: "auto", label: "Auto Mode", desc: "Proceeds, asking only for destructive or never-granted scopes. Default." },
  { key: "bypass", label: "Bypass Permissions", desc: "No prompts at all. Use with care." }
];

const OVERVIEW_STATS = [
  { label: "Sessions", value: "189" },
  { label: "Messages", value: "26,665" },
  { label: "Tokens routed", value: "34.3M" },
  { label: "Active days", value: "21" },
  { label: "Saved by routing", value: "41%" },
  { label: "Top model", value: "Opus 4.8" }
];

const RANGE_DAYS: Record<"all" | "30d" | "7d", number | null> = { "7d": 7, "30d": 30, all: null };

const TOKEN_REFERENCE_WORKS: { name: string; tokens: number }[] = [
  { name: "an average novel", tokens: 120_000 },
  { name: "The Lord of the Rings", tokens: 750_000 },
  { name: "the Bible", tokens: 1_000_000 },
  { name: "the Harry Potter series", tokens: 1_400_000 }
];

function estimateTokensFromText(text?: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

const ONGOING_WORK_NOUNS = ["migration", "refactor", "rewrite", "cleanup", "clean-up", "integration", "deployment"];

/** Derives one short, imperative "what's next" suggestion from the last
 *  completed run and the last user message in an open conversation. Pure
 *  heuristic (v1, no model calls) — see docs/FABLE_PLANS.md section 15.
 *  Returns null far more often than not; silence beats a wrong guess. */
function suggestNextStep(lastRun: SessionRun | undefined, lastUserMessage: string | undefined): string | null {
  if (lastRun) {
    const project = lastRun.projectResult;
    if (project && project.verified === false) return "Fix the remaining verification errors";

    const repairFailed =
      /repair/i.test(lastRun.assistantText ?? "") &&
      /(gave up|still fail|could not|failed)/i.test(lastRun.assistantText ?? "") ||
      lastRun.steps?.some((step) => /repair/i.test(step.label) && step.status === "error");
    if (repairFailed) return "Retry the build with a different model";

    if (project && project.verified === true) {
      const isBuildPipeline = /orchestration pipeline/i.test(lastRun.pipelineName ?? "");
      if (isBuildPipeline) return "Add a second page";
      return "Open the preview and refine the design";
    }
  }

  if (lastUserMessage) {
    const noun = ONGOING_WORK_NOUNS.find((word) => new RegExp(`\\b${word}\\b`, "i").test(lastUserMessage));
    if (noun) return `Continue the ${noun}`;
  }

  return null;
}

function NewSessionWorkspace({
  onConversationsChanged,
  onNewSession,
  openConversation,
  storedConversations = [],
  pendingByConversation,
  setPendingByConversation,
  busyKeys,
  setBusyKeys,
  draftToRealRef
}: {
  onConversationsChanged?: () => void;
  onNewSession?: () => void;
  openConversation?: ConversationRecord | null;
  storedConversations?: ConversationRecord[];
  /** Parallel sessions phase A — lifted to App() (see comment there) so runs
   *  survive this component remounting on session switch. Keyed by
   *  conversation key: real conversationId once known, else draft-<ts>. */
  pendingByConversation: Record<string, ConversationTurn[]>;
  setPendingByConversation: Dispatch<SetStateAction<Record<string, ConversationTurn[]>>>;
  busyKeys: Set<string>;
  setBusyKeys: Dispatch<SetStateAction<Set<string>>>;
  draftToRealRef: MutableRefObject<Map<string, string>>;
}): JSX.Element {
  // Runs not tied to any stored conversation (rare, but the session bridge is
  // the source of truth) are pulled in lazily so token telemetry stays accurate
  // even before a conversation record exists. Absent in the browser preview.
  const [runtimeTelemetryRuns, setRuntimeTelemetryRuns] = useState<SessionRun[]>([]);
  useEffect(() => {
    if (!window.metisSession) return;
    let alive = true;
    void window.metisSession.list().then((runs) => {
      if (alive) setRuntimeTelemetryRuns(runs);
    });
    return () => {
      alive = false;
    };
  }, []);

  const [overviewTab, setOverviewTab] = useState<"overview" | "models">("overview");
  const [range, setRange] = useState<"all" | "30d" | "7d">("all");

  // One flattened pass over conversations + runtime runs into per-message and
  // per-model-usage events, each carrying a timestamp so every stat below can
  // simply filter by the selected range instead of re-walking the data.
  type UsageEvent = { provider: string; model: string; tokens: number; at: number };
  type MessageEvent = { conversationId: string; at: number; hour: number; dateKey: string };
  const telemetryData = useMemo(() => {
    const usageEvents: UsageEvent[] = [];
    const userMessages: MessageEvent[] = [];
    let messageCount = 0;

    const addUsage = (provider: string | undefined, model: string | undefined, tokens: number, at: number): void => {
      if (tokens <= 0 || !provider) return;
      usageEvents.push({ provider, model: model ?? "", tokens, at });
    };

    const seenRunIds = new Set<string>();
    const consumeRun = (run: SessionRun | undefined, at: number): void => {
      if (!run || seenRunIds.has(run.id)) return;
      seenRunIds.add(run.id);
      const ts = Number.isNaN(new Date(run.createdAt).getTime()) ? at : new Date(run.createdAt).getTime();
      addUsage(run.providerResult?.provider, run.providerResult?.model, estimateTokensFromText(run.providerResult?.output), ts);
      run.stages?.forEach((stage) => addUsage(stage.provider, stage.model, estimateTokensFromText(stage.output), ts));
      // Fall back to assistantText when there's no providerResult/stage breakdown
      // (e.g. placeholder/local-only responses) so totals aren't undercounted.
      if (!run.providerResult && !run.stages?.length) {
        usageEvents.push({ provider: "", model: "", tokens: estimateTokensFromText(run.assistantText), at: ts });
      }
    };

    storedConversations.forEach((conversation) => {
      conversation.turns.forEach((turn) => {
        const created = new Date(turn.createdAt);
        const at = Number.isNaN(created.getTime()) ? Date.now() : created.getTime();
        if (turn.role === "user") {
          messageCount += 1;
          usageEvents.push({ provider: "", model: "", tokens: estimateTokensFromText(turn.content), at });
          userMessages.push({ conversationId: conversation.id, at, hour: created.getHours(), dateKey: created.toDateString() });
        } else {
          messageCount += 1;
          consumeRun(turn.run, at);
        }
      });
    });
    runtimeTelemetryRuns.forEach((run) => consumeRun(run, new Date(run.createdAt).getTime()));

    return { usageEvents, userMessages, messageCount };
  }, [storedConversations, runtimeTelemetryRuns]);

  const rangeCutoff = useMemo(() => {
    const days = RANGE_DAYS[range];
    if (days === null) return 0;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    today.setDate(today.getDate() - (days - 1));
    return today.getTime();
  }, [range]);

  const overviewStats = useMemo(() => {
    const conversationsInRange = storedConversations.filter((conversation) => new Date(conversation.updatedAt).getTime() >= rangeCutoff);
    const conversationIdsInRange = new Set(conversationsInRange.map((c) => c.id));
    const userMessagesInRange = telemetryData.userMessages.filter((m) => m.at >= rangeCutoff);
    const messagesInRange = conversationsInRange.reduce((total, c) => total + c.turns.length, 0);
    const usageInRange = telemetryData.usageEvents.filter((e) => e.at >= rangeCutoff);
    const totalTokens = usageInRange.reduce((sum, e) => sum + e.tokens, 0);

    const activeDayKeys = new Set(userMessagesInRange.map((m) => m.dateKey));
    const activeDays = activeDayKeys.size;

    // Streaks over the full user-message history (streak math should not be
    // truncated by the range window), expressed in days ending today.
    const allDayKeys = new Set(telemetryData.userMessages.map((m) => m.dateKey));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let currentStreak = 0;
    for (let i = 0; ; i++) {
      const day = new Date(today);
      day.setDate(day.getDate() - i);
      if (allDayKeys.has(day.toDateString())) currentStreak += 1;
      else break;
    }
    let longestStreak = 0;
    let running = 0;
    const sortedDayKeys = Array.from(allDayKeys)
      .map((key) => new Date(key).getTime())
      .sort((a, b) => a - b);
    for (let i = 0; i < sortedDayKeys.length; i++) {
      if (i === 0 || sortedDayKeys[i] - sortedDayKeys[i - 1] === 86_400_000) running += 1;
      else running = 1;
      longestStreak = Math.max(longestStreak, running);
    }

    // Peak hour = mode of local hour-of-day across in-range user messages.
    const hourCounts = new Map<number, number>();
    userMessagesInRange.forEach((m) => hourCounts.set(m.hour, (hourCounts.get(m.hour) ?? 0) + 1));
    let peakHour: number | null = null;
    let peakHourCount = 0;
    hourCounts.forEach((count, hour) => {
      if (count > peakHourCount) {
        peakHourCount = count;
        peakHour = hour;
      }
    });
    const peakHourLabel = peakHour === null ? "—" : new Date(2000, 0, 1, peakHour).toLocaleTimeString(undefined, { hour: "numeric" }).replace(":00", "");

    const modelTotals = new Map<string, { provider: ProviderKey; model: string; tokens: number }>();
    usageInRange.forEach((e) => {
      if (!e.provider || !e.model) return;
      const key = `${e.provider}::${e.model}`;
      const entry = modelTotals.get(key) ?? { provider: e.provider as ProviderKey, model: e.model, tokens: 0 };
      entry.tokens += e.tokens;
      modelTotals.set(key, entry);
    });
    let favoriteModel: { provider: ProviderKey; model: string; tokens: number } | null = null;
    modelTotals.forEach((entry) => {
      if (!favoriteModel || entry.tokens > favoriteModel.tokens) favoriteModel = entry;
    });
    const favoriteModelLabel = favoriteModel ? prettyModelName((favoriteModel as { provider: ProviderKey; model: string; tokens: number }).provider, (favoriteModel as { provider: ProviderKey; model: string; tokens: number }).model) : "—";

    const localTokens = usageInRange.filter((e) => e.provider === "ollama").reduce((sum, e) => sum + e.tokens, 0);
    const localSavedUsd = (localTokens / 1_000_000) * 3.0;
    const localSavedLabel = localSavedUsd <= 0 ? "$0.00" : localSavedUsd < 0.1 ? "<$0.10" : `$${localSavedUsd.toFixed(1)}`;

    const cells: { label: string; value: string; title?: string }[] = [
      { label: "Sessions", value: String(conversationsInRange.length) },
      { label: "Messages", value: String(messagesInRange) },
      { label: "Total tokens", value: formatTokenCount(totalTokens) },
      { label: "Active days", value: String(activeDays) },
      { label: "Current streak", value: currentStreak > 0 ? `${currentStreak}d` : "0d" },
      { label: "Longest streak", value: longestStreak > 0 ? `${longestStreak}d` : "0d" },
      { label: "Peak hour", value: peakHourLabel },
      { label: "Favorite model", value: favoriteModelLabel }
    ];

    return { cells, totalTokens, localTokens, localSavedLabel, conversationIdsInRange, modelTotals };
  }, [storedConversations, telemetryData, rangeCutoff]);

  const modelBreakdown = useMemo(() => {
    let sum = 0;
    overviewStats.modelTotals.forEach((entry) => (sum += entry.tokens));
    return Array.from(overviewStats.modelTotals.values())
      .sort((a, b) => b.tokens - a.tokens)
      .map((entry) => ({
        key: `${entry.provider}::${entry.model}`,
        label: prettyModelName(entry.provider, entry.model),
        tokens: entry.tokens,
        pct: sum > 0 ? Math.round((entry.tokens / sum) * 100) : 0
      }));
  }, [overviewStats.modelTotals]);

  const footerLine = useMemo(() => {
    const total = overviewStats.totalTokens;
    if (total < 100_000) {
      const novel = TOKEN_REFERENCE_WORKS[0];
      const ratio = total / novel.tokens;
      return `~${ratio < 0.1 ? ratio.toFixed(2) : ratio.toFixed(1)}× of an average novel.`;
    }
    // Prefer whichever reference work lands the multiplier closest to (but
    // within) a readable 1.5x-99x band; fall back to the closest option.
    let best: { name: string; multiplier: number } | null = null;
    for (const work of TOKEN_REFERENCE_WORKS) {
      const multiplier = total / work.tokens;
      if (multiplier >= 1.5 && multiplier <= 99) {
        if (!best || Math.abs(multiplier - 10) < Math.abs(best.multiplier - 10)) best = { name: work.name, multiplier };
      }
    }
    if (!best) {
      const closest = TOKEN_REFERENCE_WORKS.reduce((acc, work) => {
        const multiplier = total / work.tokens;
        return Math.abs(multiplier - 1) < Math.abs(acc.multiplier - 1) ? { name: work.name, multiplier } : acc;
      }, { name: TOKEN_REFERENCE_WORKS[0].name, multiplier: total / TOKEN_REFERENCE_WORKS[0].tokens });
      best = closest;
    }
    const roundedMultiplier = best.multiplier >= 10 ? Math.round(best.multiplier) : Math.round(best.multiplier * 10) / 10;
    return `You've used ~${roundedMultiplier}× more tokens than ${best.name}.`;
  }, [overviewStats.totalTokens]);

  // UPRIGHT github-style grid: 7 day-rows (Mon top) x N week-columns, most
  // recent week rightmost. Column count adapts to range; "all" is capped so
  // the card never needs horizontal scroll.
  const heatmap = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayDow = (today.getDay() + 6) % 7; // Monday = 0

    const weeks = range === "7d" ? 1 : range === "30d" ? 5 : 26;
    const totalDays = weeks * 7;
    const gridStart = new Date(today);
    gridStart.setDate(gridStart.getDate() - todayDow - (weeks - 1) * 7);

    const counts = new Map<string, number>();
    telemetryData.userMessages.forEach((m) => {
      const d = new Date(m.at);
      const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toDateString();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });

    let max = 0;
    const dayCells: { date: Date; count: number; future: boolean }[] = [];
    for (let i = 0; i < totalDays; i++) {
      const day = new Date(gridStart);
      day.setDate(day.getDate() + i);
      const future = day.getTime() > today.getTime();
      const count = future ? 0 : counts.get(day.toDateString()) ?? 0;
      if (!future) max = Math.max(max, count);
      dayCells.push({ date: day, count, future });
    }

    const bucketFor = (count: number): number => {
      if (count <= 0) return 0;
      if (max <= 1) return 4;
      const ratioVal = count / max;
      return ratioVal > 0.75 ? 4 : ratioVal > 0.5 ? 3 : ratioVal > 0.25 ? 2 : 1;
    };

    // Columns first (weeks), each holding 7 day-rows (Mon..Sun) for CSS grid-auto-flow: column.
    const columns: { date: Date; count: number; bucket: number; future: boolean; label: string }[][] = [];
    for (let w = 0; w < weeks; w++) {
      const col: (typeof columns)[number] = [];
      for (let d = 0; d < 7; d++) {
        const cell = dayCells[w * 7 + d];
        col.push({
          date: cell.date,
          count: cell.count,
          bucket: bucketFor(cell.count),
          future: cell.future,
          label: cell.future ? "" : `${cell.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} — ${cell.count} message${cell.count === 1 ? "" : "s"}`
        });
      }
      columns.push(col);
    }

    const totalMessages = dayCells.reduce((sum, c) => sum + c.count, 0);
    const activeDays = dayCells.filter((c) => c.count > 0).length;
    return { columns, totalMessages, activeDays };
  }, [telemetryData.userMessages, range]);

  const [permissionMode, setPermissionMode] = useAppStoreState<PermissionMode>("permissionMode", "auto");
  const [projectPickerBusy, setProjectPickerBusy] = useState(false);
  const [projectWorkspace, setProjectWorkspace] = useState<ProjectWorkspace | null>(null);
  const [workspaceResources, setWorkspaceResources] = useState<ProjectWorkspaceResource[]>([]);
  const [resourceMenuOpen, setResourceMenuOpen] = useState(false);
  const [routerOpen, setRouterOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
  const [routerFilter, setRouterFilter] = useState("");
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [draftModelName, setDraftModelName] = useState("");
  const [draftModelProvider, setDraftModelProvider] = useState<ProviderId>("claude");
  const [customModels, setCustomModels] = useAppStoreState("customModels", [] as ModelRef[]);
  const [remoteModelCatalog, setRemoteModelCatalog] = useState<CatalogModel[]>([]);
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([]);

  // Live model catalog (docs/FABLE_PLANS.md section 14) — fetched on mount from
  // the registry's catalog/models.json (cached by main process for offline use).
  // Guarded for browser preview where window.metisCatalog doesn't exist.
  useEffect(() => {
    if (!window.metisCatalog) return;
    window.metisCatalog
      .models()
      .then((state) => setRemoteModelCatalog(state.models))
      .catch(() => undefined);
  }, []);

  // Provider configured/cooling status (docs/FABLE_PLANS.md section 21) — used
  // only for the picker's lightweight "via <Provider>" route-suffix approximation
  // below; a fresh health check isn't needed here, list() already reflects
  // configured + cooling state. Guarded for browser preview.
  useEffect(() => {
    if (!window.metisProviders) return;
    window.metisProviders
      .list()
      .then(setProviderStatuses)
      .catch(() => undefined);
  }, []);

  // Remote catalog entries mapped onto the picker's ModelRef shape and brand ids.
  const remoteModelRefs = useMemo(
    () => remoteModelCatalog.map((entry): ModelRef => ({ provider: CATALOG_PROVIDER_TO_BRAND[entry.provider], model: entry.name })),
    [remoteModelCatalog]
  );

  // "via <Provider>" route suffix (docs/FABLE_PLANS.md section 21) — a
  // lightweight, pure-renderer approximation of route resolution: for a model
  // with multiple known access routes, find the first route whose provider is
  // configured and not cooling (falling back to the first configured route),
  // and show its brand label as a suffix when it's NOT the model's own default
  // provider (i.e. the interesting "reached through a different API" case).
  // configured ≈ status !== "not_configured"; cooling shows up as status
  // "unavailable" with a cooldown detail string (see healthCheckProvider/
  // listProviders in main.ts) — approximate but fine for a picker hint.
  const resolveRouteSuffix = useCallback(
    (ref: ModelRef): string | null => {
      const entry = remoteModelCatalog.find((candidate) => candidate.name.toLowerCase() === ref.model.toLowerCase());
      const access = entry?.access;
      if (!entry || !access || access.length < 2) return null;

      const statusFor = (key: ProviderKey) => providerStatuses.find((status) => status.provider === key);
      const configuredNotCooling = access.find((route) => {
        const status = statusFor(route.provider);
        return status && status.status !== "not_configured" && status.status !== "unavailable";
      });
      const bestRoute = configuredNotCooling ?? access.find((route) => statusFor(route.provider)?.status !== "not_configured") ?? access[0];
      if (bestRoute.provider === entry.provider) return null;

      const brand = CATALOG_PROVIDER_TO_BRAND[bestRoute.provider];
      return brand ? PROVIDERS[brand].label : null;
    },
    [remoteModelCatalog, providerStatuses]
  );

  // Cloud/Local -> brand -> models, filtered. Remote catalog models extend
  // MODEL_LIBRARY (deduped by provider+display name); custom user models are
  // an overlay on top of that.
  const modelGroups = useMemo(() => {
    const query = routerFilter.trim().toLowerCase();
    const merged = [...MODEL_LIBRARY];
    remoteModelRefs.forEach((ref) => {
      if (!merged.some((existing) => existing.provider === ref.provider && existing.model === ref.model)) merged.push(ref);
    });
    const all = [...merged, ...customModels];
    const tiers: { tier: "cloud" | "local"; label: string; brands: { provider: ProviderId; models: ModelRef[] }[] }[] = [
      { tier: "cloud", label: "Cloud", brands: [] },
      { tier: "local", label: "Local", brands: [] }
    ];
    (Object.keys(PROVIDERS) as ProviderId[]).forEach((provider) => {
      if (GATEWAY_ONLY_BRANDS.includes(provider)) return;
      const models = all.filter(
        (ref) => ref.provider === provider && (!query || ref.model.toLowerCase().includes(query) || PROVIDERS[provider].label.toLowerCase().includes(query))
      );
      if (!models.length) return;
      const tier = tiers.find((entry) => entry.tier === PROVIDERS[provider].tier);
      tier?.brands.push({ provider, models });
    });
    return tiers.filter((entry) => entry.brands.length);
  }, [routerFilter, customModels, remoteModelRefs]);

  function addCustomModel(): void {
    const name = draftModelName.trim();
    if (!name) return;
    void setCustomModels((current) => (current.some((ref) => ref.provider === draftModelProvider && ref.model === name) ? current : [...current, { provider: draftModelProvider, model: name }]));
    setSelectedModel({ provider: draftModelProvider, model: name });
    setDraftModelName("");
    setAddModelOpen(false);
    setRouterOpen(false);
  }
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>();
  // This workspace instance's own draft key, minted once per mount. Every
  // "New session" click remounts NewSessionWorkspace (key={sessionKey} in
  // App()), so a fresh draft key here is exactly "a new, distinct draft
  // session" — while pendingByConversation/busyKeys live above the remount
  // boundary, any run already in flight under a PREVIOUS draft key keeps
  // streaming into its own bucket untouched.
  const draftKeyRef = useRef(`draft-${Date.now()}`);
  // The key this open view reads/writes pending turns under: the real
  // conversationId once the first run has returned one, else our draft key.
  const activeKey = activeConversationId ?? draftKeyRef.current;
  const conversation = pendingByConversation[activeKey] ?? [];
  const sessionBusy = busyKeys.has(activeKey);
  // A live-readable mirror of activeKey for long-lived closures (the
  // runStream event callback below persists for a run's whole lifetime, so it
  // can't rely on the `activeKey` const captured at submit time to know
  // whether the user is STILL looking at this conversation later on).
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const [history, setHistory] = useState<ConversationTurnRecord[]>([]);
  const hasConversation = conversation.length > 0 || history.length > 0;
  const homeScrollRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState(0);
  const [workspaceContextOpen, setWorkspaceContextOpen] = useState(false);
  const [previewRail, setPreviewRail] = useState<{ url: string; title: string } | null>(null);
  const [previewRefreshTick, setPreviewRefreshTick] = useState(0);
  // Side-chat stack (docs/FABLE_PLANS.md §26): user-dismissable independent of
  // the underlying data — the cards themselves live on each turn's
  // streamCalls (so they survive scrollback / re-render), this flag just lets
  // the user close the whole stack for the current conversation. Reset (shown
  // again) on the next run and on conversation switch, same lifecycle as the
  // preview rail.
  const [sideChatClosed, setSideChatClosed] = useState(false);
  const [sideChatCollapsed, setSideChatCollapsed] = useState(false);
  const [contextRenaming, setContextRenaming] = useState(false);
  const [contextRenameDraft, setContextRenameDraft] = useState("");
  const [contextDeleteArmed, setContextDeleteArmed] = useState(false);

  const openStoredConversation = useMemo(
    () => storedConversations.find((item) => item.id === activeConversationId) ?? null,
    [storedConversations, activeConversationId]
  );

  useEffect(() => {
    setContextDeleteArmed(false);
  }, [activeConversationId]);

  function beginContextRename(): void {
    if (!openStoredConversation) return;
    setContextRenameDraft(openStoredConversation.title);
    setContextRenaming(true);
  }

  async function commitContextRename(): Promise<void> {
    setContextRenaming(false);
    const title = contextRenameDraft.trim();
    if (!title || !openStoredConversation || !window.metisConversations) return;
    await window.metisConversations.rename(openStoredConversation.id, title);
    onConversationsChanged?.();
  }

  async function archiveOpenConversation(): Promise<void> {
    if (!openStoredConversation || !window.metisConversations) return;
    await window.metisConversations.archive(openStoredConversation.id, true);
    onConversationsChanged?.();
    setWorkspaceContextOpen(false);
    onNewSession?.();
  }

  async function deleteOpenConversation(): Promise<void> {
    if (!openStoredConversation || !window.metisConversations) return;
    if (!contextDeleteArmed) {
      setContextDeleteArmed(true);
      window.setTimeout(() => setContextDeleteArmed(false), 3000);
      return;
    }
    await window.metisConversations.delete(openStoredConversation.id);
    onConversationsChanged?.();
    setWorkspaceContextOpen(false);
    setContextDeleteArmed(false);
    onNewSession?.();
  }

  const openPreviewRail = useCallback((url: string, title: string) => {
    setPreviewRail((current) => (current ? { ...current, url, title } : { url, title }));
  }, []);
  const previewControl = useMemo(() => ({ open: openPreviewRail }), [openPreviewRail]);

  // Minimap sections — one entry per user message ("part" of the conversation).
  const sections = useMemo(() => {
    const items: { id: string; label: string }[] = [];
    history.forEach((turn, index) => {
      if (turn.role === "user") items.push({ id: `sec-h-${index}`, label: turn.content });
    });
    conversation.forEach((turn) => items.push({ id: `sec-c-${turn.id}`, label: turn.prompt }));
    return items;
  }, [history, conversation]);

  // Cap the minimap at 10 bars. Few messages -> one bar each; many -> bucket
  // into 10 (~10% chunks), each bar jumping to the first message in its chunk.
  const minimapBars = useMemo(() => {
    const total = sections.length;
    const count = Math.min(total, 10);
    return Array.from({ length: count }, (_, index) => {
      const sectionIndex = Math.floor((index * total) / count);
      return { sectionIndex, section: sections[sectionIndex] };
    });
  }, [sections]);
  const activeBar = sections.length === 0 ? 0 : Math.min(minimapBars.length - 1, Math.floor((activeSection * minimapBars.length) / sections.length));

  // Side-chat cards (docs/FABLE_PLANS.md §26): flatten every visible turn's
  // streamCalls into one ordered stack for this conversation, newest last,
  // capped at ~30 so a long multi-run conversation doesn't grow unbounded.
  const sideChatCalls = useMemo(() => {
    const all = conversation.flatMap((turn) => turn.streamCalls ?? []);
    return all.length > 30 ? all.slice(all.length - 30) : all;
  }, [conversation]);

  // Smart composer suggestion (docs/FABLE_PLANS.md section 15) — derived from
  // the last completed run and last user message in this open conversation.
  // Dismissed (typing/Escape) until the next run completes or the
  // conversation switches.
  const lastRun = useMemo(() => {
    const completedInSession = [...conversation].reverse().find((turn) => turn.status === "complete" && turn.run)?.run;
    if (completedInSession) return completedInSession;
    const lastHistoryRun = [...history].reverse().find((turn) => turn.role === "assistant" && turn.run)?.run;
    return lastHistoryRun;
  }, [conversation, history]);
  const lastUserMessage = useMemo(() => {
    const lastConversationPrompt = [...conversation].reverse().find((turn) => !turn.directive)?.prompt;
    if (lastConversationPrompt) return lastConversationPrompt;
    return [...history].reverse().find((turn) => turn.role === "user")?.content;
  }, [conversation, history]);
  const composerSuggestion = useMemo(() => suggestNextStep(lastRun, lastUserMessage), [lastRun, lastUserMessage]);

  useEffect(() => {
    const el = homeScrollRef.current;
    if (!el || sections.length === 0) return;
    function onScroll(): void {
      if (!el) return;
      // At (near) the bottom, the last message is the current one.
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 6) {
        setActiveSection(sections.length - 1);
        return;
      }
      const threshold = el.getBoundingClientRect().top + 90;
      let index = 0;
      sections.forEach((section, i) => {
        const anchor = document.getElementById(section.id);
        if (anchor && anchor.getBoundingClientRect().top <= threshold) index = i;
      });
      setActiveSection(index);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [sections]);

  // Opening a stored conversation from the sidebar loads its turns as read-only
  // history; new sends continue the same conversation below.
  const openConversationId = openConversation?.id;
  useEffect(() => {
    if (!openConversation) return;
    setHistory(openConversation.turns);
    setActiveConversationId(openConversation.id);
    // No need to clear pending turns here: `conversation` is now derived from
    // pendingByConversation[activeKey] (parallel sessions phase A), so simply
    // switching activeConversationId re-derives the feed from this
    // conversation's own bucket — including a still-streaming turn if this
    // conversation has a run in flight in the background.
    setPreviewRail(null);
    setSideChatClosed(false);
    setSideChatCollapsed(false);
    // Land at the top of the conversation, not the bottom.
    requestAnimationFrame(() => homeScrollRef.current?.scrollTo({ top: 0 }));

    // If the last run in this stored conversation has a preview/output URL,
    // probe it — its per-run preview server may or may not still be alive.
    // Reopen the rail only if it responds; stay silent otherwise.
    const lastTurnRun = [...openConversation.turns].reverse().find((turn) => turn.run)?.run;
    const candidateUrl = lastTurnRun?.projectResult?.previewUrl ?? lastTurnRun?.outputUrl;
    if (!candidateUrl) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 1500);
    void fetch(candidateUrl, { method: "HEAD", signal: controller.signal })
      .then(() => {
        if (cancelled) return;
        const title = lastTurnRun?.projectResult ? projectNameFromPath(lastTurnRun.projectResult.projectRoot) : "Preview";
        setPreviewRail({ url: candidateUrl, title });
      })
      .catch(() => {
        // Dead port / no server — no error UI, just leave the rail closed.
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [openConversationId]);

  useEffect(() => {
    if (!window.metisProject) return;
    let alive = true;
    void Promise.all([window.metisProject.getWorkspace(), window.metisProject.listResources()]).then(([workspace, resources]) => {
      if (!alive) return;
      setProjectWorkspace(workspace);
      setWorkspaceResources(resources);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function chooseProjectFolder(): Promise<void> {
    if (!window.metisProject || projectPickerBusy) return;
    setProjectPickerBusy(true);
    try {
      const result = await window.metisProject.selectFolder();
      if (!result.canceled && result.workspace) {
        setProjectWorkspace(result.workspace);
      }
    } finally {
      setProjectPickerBusy(false);
    }
  }

  async function addWorkspaceResource(kind: "file" | "folder"): Promise<void> {
    if (!window.metisProject || projectPickerBusy) return;
    setResourceMenuOpen(false);
    setProjectPickerBusy(true);
    try {
      const next = kind === "file" ? await window.metisProject.addFiles() : await window.metisProject.addFolder();
      setWorkspaceResources(next);
    } finally {
      setProjectPickerBusy(false);
    }
  }

  async function removeWorkspaceResource(id: string): Promise<void> {
    if (!window.metisProject) return;
    const next = await window.metisProject.removeResource(id);
    setWorkspaceResources(next);
  }

  // Applies an update to one conversation key's pending-turn bucket, resolving
  // through draftToRealRef first: if this key was a draft that has since
  // migrated to a real conversationId (see the `complete` handling below),
  // writes land in the migrated bucket instead of recreating the stale one.
  function updatePendingTurns(key: string, updater: (current: ConversationTurn[]) => ConversationTurn[]): void {
    setPendingByConversation((current) => {
      const resolvedKey = draftToRealRef.current.get(key) ?? key;
      const bucket = current[resolvedKey] ?? [];
      return { ...current, [resolvedKey]: updater(bucket) };
    });
  }

  async function submitPrompt(text: string, attachments?: SessionAttachment[]): Promise<void> {
    const hasAttachments = Boolean(attachments && attachments.length);
    if (!text && !hasAttachments) return;
    // Steering directives are per-active-conversation: this posts against the
    // conversation currently open in this view, regardless of what else may
    // be streaming elsewhere. Empty-prompt "stop" is handled by the composer's
    // stop button, not here. Attachments are ignored on the directive path —
    // steering directives are text-only; images belong to a fresh run.
    if (sessionBusy) {
      if (!text || !window.metisBus) return;
      updatePendingTurns(activeKey, (current) => [
        ...current,
        { id: `directive-${Date.now()}`, prompt: text, status: "complete", directive: true }
      ]);
      void window.metisBus.post({ projectPath: projectWorkspace?.path, conversationId: activeConversationId, text });
      return;
    }
    // Capture the key THIS run submits under. If this is a brand-new session
    // it's the draft key; every event callback below closes over `runKey`
    // (not `activeKey`, which can change if the user navigates elsewhere
    // while this run streams) so writes always land in the right bucket.
    const runKey = activeKey;
    const turnId = `turn-${Date.now()}`;
    const pending = makePendingTurn(turnId, text, attachments);
    updatePendingTurns(runKey, (current) => [...current, pending]);
    setBusyKeys((current) => new Set(current).add(runKey));
    // New runs in the same conversation reopen the side-chat stack even if the
    // user closed it during a previous run (docs/FABLE_PLANS.md §26).
    setSideChatClosed(false);
    try {
      if (!window.metisSession) {
        const previewRun = makePreviewRun(text);
        updatePendingTurns(runKey, (current) =>
          current.map((turn) => (turn.id === turnId ? { ...turn, status: "complete", run: previewRun } : turn))
        );
        return;
      }
      const sessionInput: SessionRunInput = {
        prompt: text,
        conversationId: activeConversationId,
        projectPath: projectWorkspace?.path,
        permissionMode,
        rawPromptStorage: "local-only",
        modelOverride: selectedModel
          ? {
              provider: PROVIDER_CONNECTIONS[selectedModel.provider],
              model: selectedModel.model,
              label: `${PROVIDERS[selectedModel.provider].label} ${selectedModel.model}`
            }
          : undefined,
        attachments: hasAttachments ? attachments : undefined
      };
      const run = window.metisSession.runStream
        ? await window.metisSession.runStream(sessionInput, (streamEvent) => {
            updatePendingTurns(runKey, (current) =>
              current.map((turn) => (turn.id === turnId ? applyStreamEventToTurn(turn, streamEvent) : turn))
            );
            // A "project" event carries the latest written project (including
            // repair-pass rewrites) — auto-open/refresh the rail only while
            // this run's conversation is the one actually open right now, so
            // a background run never hijacks the visible preview.
            if (streamEvent.kind === "project" && streamEvent.project.previewUrl && activeKeyRef.current === runKey) {
              const url = streamEvent.project.previewUrl;
              const title = projectNameFromPath(streamEvent.project.projectRoot);
              setPreviewRail((current) => (current ? { ...current, url, title } : { url, title }));
              setPreviewRefreshTick((tick) => tick + 1);
            }
          })
        : await window.metisSession.run(sessionInput);
      // The backend creates the conversationId on the FIRST run of a brand-new
      // session. Migrate this draft key's bucket to the real id so the open
      // view (if still on this draft) follows seamlessly, and record the
      // mapping so any writes still in flight under `runKey` (there shouldn't
      // be more after this point, but future events from this same
      // runStream call are also written via updatePendingTurns, which
      // consults this map) land in the migrated bucket too.
      const realConversationId = run.conversationId;
      if (realConversationId && realConversationId !== runKey) {
        draftToRealRef.current.set(runKey, realConversationId);
        setPendingByConversation((current) => {
          if (!(runKey in current)) return current;
          const { [runKey]: migratedTurns, ...rest } = current;
          return { ...rest, [realConversationId]: [...(current[realConversationId] ?? []), ...migratedTurns] };
        });
        setBusyKeys((current) => {
          if (!current.has(runKey)) return current;
          const next = new Set(current);
          next.delete(runKey);
          next.add(realConversationId);
          return next;
        });
        // Only follow the view if the user is still looking at this draft
        // (they may have switched to another conversation while this ran).
        if (activeKeyRef.current === runKey) {
          setActiveConversationId(realConversationId);
        }
      }
      updatePendingTurns(runKey, (current) =>
        current.map((turn) => (turn.id === turnId ? { ...turn, id: run.id, status: "complete", run } : turn))
      );
      const finalPreviewUrl = run.projectResult?.previewUrl ?? run.outputUrl;
      if (finalPreviewUrl && activeKeyRef.current === runKey) {
        const title = run.projectResult ? projectNameFromPath(run.projectResult.projectRoot) : "Preview";
        setPreviewRail({ url: finalPreviewUrl, title });
      }
      onConversationsChanged?.();
    } catch (error) {
      updatePendingTurns(runKey, (current) =>
        current.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status: "error",
                error: error instanceof Error ? error.message : String(error)
              }
            : turn
        )
      );
    } finally {
      const settledKey = draftToRealRef.current.get(runKey) ?? runKey;
      setBusyKeys((current) => {
        if (!current.has(settledKey)) return current;
        const next = new Set(current);
        next.delete(settledKey);
        return next;
      });
    }
  }

  return (
    <PreviewRailContext.Provider value={previewControl}>
    <main className={`product-workspace session-home ${hasConversation ? "has-result" : ""}`} aria-label="New session">
    <div className="session-home-main">
      <div className="workspace-header">
        <div className="workspace-context-wrap">
          <button
            className={`workspace-context-btn ${workspaceContextOpen ? "active" : ""}`}
            type="button"
            aria-label="Project context"
            aria-expanded={workspaceContextOpen}
            title={projectWorkspace?.path ?? "Project context"}
            onClick={() => setWorkspaceContextOpen((open) => !open)}
          >
            <MoreHorizontal size={16} />
          </button>
          {workspaceContextOpen ? (
            <>
              <button className="router-backdrop" type="button" aria-label="Close project context" onClick={() => setWorkspaceContextOpen(false)} />
              <div className="workspace-context-popover" role="dialog" aria-label="Project context">
                <header>
                  <Folder size={14} />
                  <strong>Project context</strong>
                  <button type="button" aria-label="Close" onClick={() => setWorkspaceContextOpen(false)}>
                    <X size={13} />
                  </button>
                </header>
                <div className="workspace-context-path" title={projectWorkspace?.path}>
                  {projectWorkspace ? projectWorkspace.path : "No project folder selected yet."}
                </div>
                {workspaceResources.length > 0 ? (
                  <div className="workspace-context-resources">
                    {workspaceResources.map((resource) => (
                      <div className="workspace-context-resource" key={resource.id}>
                        <Folder size={12} />
                        <span title={resource.path}>{resource.name}</span>
                        <button type="button" aria-label={`Remove ${resource.name}`} onClick={() => void removeWorkspaceResource(resource.id)}>
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="workspace-context-actions">
                  <button type="button" disabled={projectPickerBusy || !window.metisProject} onClick={chooseProjectFolder}>
                    {projectPickerBusy ? <Loader2 size={13} /> : <Folder size={13} />}
                    {projectWorkspace ? "Change folder" : "Choose folder"}
                  </button>
                </div>
                <div className="workspace-context-divider" role="separator" aria-hidden="true" />
                {window.metisConversations && openStoredConversation ? (
                  <div className="workspace-context-actions workspace-context-conversation-actions">
                    {contextRenaming ? (
                      <input
                        autoFocus
                        className="project-conversation-rename-input"
                        value={contextRenameDraft}
                        onChange={(event) => setContextRenameDraft(event.target.value)}
                        onBlur={() => void commitContextRename()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void commitContextRename();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setContextRenaming(false);
                          }
                        }}
                      />
                    ) : (
                      <button type="button" onClick={beginContextRename}>
                        <Pencil size={13} />
                        Rename
                      </button>
                    )}
                    <button type="button" onClick={() => void archiveOpenConversation()}>
                      <Archive size={13} />
                      Archive
                    </button>
                    <button type="button" className={`danger ${contextDeleteArmed ? "armed" : ""}`} onClick={() => void deleteOpenConversation()}>
                      <Trash2 size={13} />
                      {contextDeleteArmed ? "Confirm delete" : "Delete"}
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="home-scroll" ref={homeScrollRef}>
        {hasConversation ? (
          openConversation ? <div className="conversation-title">{openConversation.title}</div> : null
        ) : (
          <header className="home-greeting">
            <Sparkles size={22} />
            <h1>What&rsquo;s up next, bro?</h1>
          </header>
        )}

        {hasConversation ? null : (
        <section className="overview-card" aria-label="Usage overview">
          <div className="overview-top">
            <div className="seg" role="tablist" aria-label="Overview view">
              <button type="button" role="tab" aria-selected={overviewTab === "overview"} className={overviewTab === "overview" ? "active" : ""} onClick={() => setOverviewTab("overview")}>
                Overview
              </button>
              <button type="button" role="tab" aria-selected={overviewTab === "models"} className={overviewTab === "models" ? "active" : ""} onClick={() => setOverviewTab("models")}>
                Models
              </button>
            </div>
            <div className="seg" role="tablist" aria-label="Time range">
              {(["all", "30d", "7d"] as const).map((key) => (
                <button key={key} type="button" role="tab" aria-selected={range === key} className={range === key ? "active" : ""} onClick={() => setRange(key)}>
                  {key === "all" ? "All" : key}
                </button>
              ))}
            </div>
          </div>

          {overviewTab === "overview" ? (
            <>
              <div className="stat-grid">
                {overviewStats.cells.map((stat) => (
                  <div className="stat-cell" key={stat.label} title={stat.title}>
                    <small>{stat.label}</small>
                    <strong>{stat.value}</strong>
                  </div>
                ))}
              </div>
              <div className="overview-heat" aria-hidden="true">
                {heatmap.columns.map((col, colIndex) => (
                  <div className="heat-col" key={colIndex}>
                    {col.map((cell, rowIndex) => (
                      <div
                        className={cell.future ? "heat-cell future" : cell.bucket > 0 ? "heat-cell filled" : "heat-cell"}
                        key={rowIndex}
                        style={!cell.future && cell.bucket > 0 ? ({ "--a": HEAT_ALPHAS[cell.bucket] } as CSSProperties) : undefined}
                        title={cell.label || undefined}
                      />
                    ))}
                  </div>
                ))}
              </div>
              <p
                className="overview-foot"
                title={overviewStats.localTokens > 0 ? `~${formatTokenCount(overviewStats.localTokens)} tokens kept local · ≈ ${overviewStats.localSavedLabel} saved` : undefined}
              >
                {footerLine}
                {overviewStats.localTokens > 0 ? ` · ~${formatTokenCount(overviewStats.localTokens)} kept local (≈ ${overviewStats.localSavedLabel} saved)` : ""}
              </p>
            </>
          ) : (
            <div className="model-share-list">
              {modelBreakdown.length === 0 ? (
                <p className="overview-foot">No model usage yet in this range.</p>
              ) : (
                modelBreakdown.map((entry) => (
                  <div className="model-share-row" key={entry.key}>
                    <span className="model-share-name">{entry.label}</span>
                    <span className="model-share-bar">
                      <span className="model-share-fill" style={{ width: `${Math.max(entry.pct, entry.tokens > 0 ? 2 : 0)}%` } as CSSProperties} />
                    </span>
                    <span className="model-share-tokens">{formatTokenCount(entry.tokens)}</span>
                    <span className="model-share-pct">{entry.pct}%</span>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
        )}

        {hasConversation ? (
          <section className="conversation-feed" aria-label="Conversation">
            {history.map((turn, index) =>
              turn.role === "user" ? (
                <div className="message-row user-message" id={`sec-h-${index}`} key={`history-${index}`}>
                  <div className="user-bubble">
                    <p>{turn.content}</p>
                  </div>
                </div>
              ) : (
                <div className="message-row assistant-message" key={`history-${index}`}>
                  {turn.run ? <CompletedRun run={turn.run} /> : <Markdown>{turn.content}</Markdown>}
                </div>
              )
            )}
            {conversation.map((turn) => (
              <ConversationTurnCard key={turn.id} anchorId={`sec-c-${turn.id}`} turn={turn} />
            ))}
          </section>
        ) : null}
      </div>

      {hasConversation && minimapBars.length > 1 ? (
        <nav className="conversation-minimap" aria-label="Jump to message">
          {minimapBars.map((bar, index) => (
            <button
              key={bar.section.id}
              type="button"
              className={`minimap-tick ${index === activeBar ? "active" : ""}`}
              onClick={() => document.getElementById(bar.section.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              <span className="minimap-tip">{bar.section.label.slice(0, 70)}</span>
            </button>
          ))}
        </nav>
      ) : null}

      <div className="home-dock">
        <SessionComposer
          sessionBusy={sessionBusy}
          projectWorkspace={projectWorkspace}
          suggestion={composerSuggestion}
          suggestionResetKey={`${lastRun?.id ?? "none"}::${activeConversationId ?? "none"}`}
          onSubmit={submitPrompt}
          permissionMode={permissionMode}
          setPermissionMode={setPermissionMode}
          resourceMenuOpen={resourceMenuOpen}
          setResourceMenuOpen={setResourceMenuOpen}
          projectPickerBusy={projectPickerBusy}
          addWorkspaceResource={addWorkspaceResource}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          modelGroups={modelGroups}
          routerFilter={routerFilter}
          setRouterFilter={setRouterFilter}
          addModelOpen={addModelOpen}
          setAddModelOpen={setAddModelOpen}
          draftModelName={draftModelName}
          setDraftModelName={setDraftModelName}
          draftModelProvider={draftModelProvider}
          setDraftModelProvider={setDraftModelProvider}
          addCustomModel={addCustomModel}
          resolveRouteSuffix={resolveRouteSuffix}
        />
      </div>
    </div>
    {previewRail || (sideChatCalls.length > 0 && !sideChatClosed) ? (
      <div className="right-rail">
        {previewRail ? (
          <PreviewRail
            key={previewRail.url}
            onClose={() => setPreviewRail(null)}
            refreshTick={previewRefreshTick}
            title={previewRail.title}
            url={previewRail.url}
          />
        ) : null}
        {sideChatCalls.length > 0 && !sideChatClosed ? (
          <SideChatStack
            calls={sideChatCalls}
            collapsed={sideChatCollapsed}
            onToggleCollapsed={() => setSideChatCollapsed((value) => !value)}
            onClose={() => setSideChatClosed(true)}
          />
        ) : null}
      </div>
    ) : null}
    </main>
    </PreviewRailContext.Provider>
  );
}

type SessionComposerModelGroups = { tier: "cloud" | "local"; label: string; brands: { provider: ProviderId; models: ModelRef[] }[] }[];

// Owns the `prompt` string locally so every keystroke only re-renders the
// composer, not the whole workspace (conversation feed, telemetry card,
// minimap, model picker data all live in the parent and are passed as props).
function SessionComposer({
  sessionBusy,
  projectWorkspace,
  suggestion,
  suggestionResetKey,
  onSubmit,
  permissionMode,
  setPermissionMode,
  resourceMenuOpen,
  setResourceMenuOpen,
  projectPickerBusy,
  addWorkspaceResource,
  selectedModel,
  setSelectedModel,
  modelGroups,
  routerFilter,
  setRouterFilter,
  addModelOpen,
  setAddModelOpen,
  draftModelName,
  setDraftModelName,
  draftModelProvider,
  setDraftModelProvider,
  addCustomModel,
  resolveRouteSuffix
}: {
  sessionBusy: boolean;
  projectWorkspace: ProjectWorkspace | null;
  suggestion: string | null | undefined;
  suggestionResetKey: string;
  onSubmit: (text: string, attachments?: SessionAttachment[]) => void | Promise<void>;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode | ((current: PermissionMode) => PermissionMode)) => void;
  resourceMenuOpen: boolean;
  setResourceMenuOpen: (value: boolean | ((open: boolean) => boolean)) => void;
  projectPickerBusy: boolean;
  addWorkspaceResource: (kind: "file" | "folder") => void | Promise<void>;
  selectedModel: ModelRef | null;
  setSelectedModel: (ref: ModelRef | null) => void;
  modelGroups: SessionComposerModelGroups;
  routerFilter: string;
  setRouterFilter: (value: string) => void;
  addModelOpen: boolean;
  setAddModelOpen: (open: boolean) => void;
  draftModelName: string;
  setDraftModelName: (value: string) => void;
  draftModelProvider: ProviderId;
  setDraftModelProvider: (provider: ProviderId) => void;
  addCustomModel: () => void;
  /** "via <Provider>" route-suffix approximation (docs/FABLE_PLANS.md section
   *  21) — null when the model has one route or resolves through its own
   *  default provider (the non-interesting case). */
  resolveRouteSuffix: (ref: ModelRef) => string | null;
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [permOpen, setPermOpen] = useState(false);
  const [routerOpen, setRouterOpen] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  // Reference images for the NEXT submit — reset after every send. Capped at
  // MAX_ATTACHMENTS; an image-only submit (no typed text) is valid, so the
  // submit guard below checks this alongside `prompt`.
  const [attachments, setAttachments] = useState<SessionAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const MAX_ATTACHMENTS = 4;
  const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

  useEffect(() => {
    setSuggestionDismissed(false);
  }, [suggestionResetKey]);

  const showSuggestion = Boolean(suggestion) && !suggestionDismissed && !sessionBusy && prompt.trim().length === 0;
  // Mirrors main.ts's ORCHESTRATION_COMMAND_RE (/orchestration or /orch as the
  // leading token) purely for the composer nicety chip below — no autocomplete
  // menu, just a small heads-up that this prompt will force the build pipeline.
  const showOrchestrationChip = /^\s*\/(orchestration|orch)\b/i.test(prompt);

  function handleAttachFiles(event: ChangeEvent<HTMLInputElement>): void {
    const files = event.target.files;
    // Snapshot into a plain array BEFORE resetting event.target.value — in
    // Chromium, clearing .value on the input truncates the live FileList it
    // still holds a reference to, so reading `files` after the reset silently
    // yields zero items.
    const picked = files ? Array.from(files) : [];
    // Reset immediately so re-picking the same file later still fires onChange.
    event.target.value = "";
    if (!picked.length) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) return;
    picked
      .slice(0, room)
      .forEach((file) => {
        if (!file.type.startsWith("image/")) return;
        if (file.size > MAX_ATTACHMENT_BYTES) return;
        const reader = new FileReader();
        reader.onload = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          const commaIndex = result.indexOf(",");
          const dataBase64 = commaIndex >= 0 ? result.slice(commaIndex + 1) : result;
          if (!dataBase64) return;
          setAttachments((current) =>
            current.length >= MAX_ATTACHMENTS
              ? current
              : [...current, { id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: file.name, mimeType: file.type, dataBase64 }]
          );
        };
        reader.readAsDataURL(file);
      });
  }

  function removeAttachment(id: string | undefined): void {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = prompt.trim();
    if (!text && !attachments.length) return;
    setPrompt("");
    const sentAttachments = attachments;
    setAttachments([]);
    void onSubmit(text, sentAttachments.length ? sentAttachments : undefined);
  }

  return (
    <form className="home-composer" onSubmit={handleSubmit}>
      {showOrchestrationChip ? (
        <span className="composer-suggestion-chip composer-orchestration-chip">Build pipeline will run</span>
      ) : null}
      {attachments.length > 0 ? (
        <div className="composer-attachment-strip" aria-label="Attached images">
          {attachments.map((item) => (
            <div className="composer-attachment-thumb" key={item.id}>
              <img src={`data:${item.mimeType};base64,${item.dataBase64}`} alt={item.name} title={item.name} />
              <button type="button" className="composer-attachment-remove" aria-label={`Remove ${item.name}`} onClick={() => removeAttachment(item.id)}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="composer-input-wrap">
        <textarea
          value={prompt}
          rows={3}
          placeholder={showSuggestion ? "" : sessionBusy ? "Steer the running build — e.g. “skip the b feature, add d instead”" : "Describe a task or ask a question"}
          aria-label={showSuggestion ? `Prompt — suggestion: ${suggestion} — press Tab to accept` : "Prompt"}
          onChange={(event) => {
            setPrompt(event.target.value);
            if (event.target.value) setSuggestionDismissed(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab" && showSuggestion && suggestion) {
              event.preventDefault();
              setPrompt(suggestion);
              return;
            }
            if (event.key === "Escape" && showSuggestion) {
              setSuggestionDismissed(true);
            }
          }}
        />
        {showSuggestion && suggestion ? (
          <button
            type="button"
            className="composer-suggestion"
            onClick={() => setPrompt(suggestion)}
            tabIndex={-1}
            aria-hidden="true"
          >
            <span className="composer-suggestion-text">{suggestion}</span>
            <span className="composer-suggestion-chip">↹ Tab</span>
          </button>
        ) : null}
      </div>
      <div className="home-composer-bar">
        <div className="composer-tools">
          <div className="perm-wrap">
            <button
              className={`tool-btn ${permOpen ? "active" : ""} ${permissionMode === "bypass" ? "bypass" : ""}`}
              type="button"
              aria-label="Permissions"
              aria-expanded={permOpen}
              onClick={() => setPermOpen((open) => !open)}
            >
              {permissionMode === "bypass" ? <ShieldAlert size={16} /> : <Shield size={16} />}
            </button>
            {permOpen ? (
              <>
                <div className="perm-backdrop" onClick={() => setPermOpen(false)} />
                <div className="perm-popover" role="dialog" aria-label="Permissions">
                  <header>
                    <Shield size={15} />
                    <strong>Permissions</strong>
                    <button type="button" aria-label="Close" onClick={() => setPermOpen(false)}>
                      <X size={14} />
                    </button>
                  </header>
                  <div className="perm-levels">
                    {PERMISSION_MODES.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        className={`perm-level ${permissionMode === option.key ? "active" : ""} ${option.key === "bypass" ? "bypass" : ""}`}
                        onClick={() => setPermissionMode(option.key)}
                      >
                        <span className="perm-radio" />
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.desc}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="perm-scope">
                    <span>This session can touch</span>
                    <ul>
                      <li className="on">
                        <HardDrive size={13} /> Local workspace
                      </li>
                      <li className={permissionMode !== "plan" ? "on" : ""}>
                        <Folder size={13} /> Project folder · Metis
                      </li>
                      <li className={permissionMode === "auto" || permissionMode === "bypass" ? "on" : ""}>
                        <Network size={13} /> Graph memory + network
                      </li>
                    </ul>
                  </div>
                </div>
              </>
            ) : null}
          </div>
          <div className="resource-wrap">
            <button
              className={`tool-btn ${resourceMenuOpen ? "active" : ""}`}
              type="button"
              aria-label="Add files or folders"
              aria-expanded={resourceMenuOpen}
              disabled={projectPickerBusy || !window.metisProject}
              onClick={() => setResourceMenuOpen((open) => !open)}
            >
              <Plus size={16} />
            </button>
            {resourceMenuOpen ? (
              <>
                <div className="resource-backdrop" onClick={() => setResourceMenuOpen(false)} />
                <div className="resource-popover" role="menu" aria-label="Add workspace context">
                  <button type="button" role="menuitem" onClick={() => void addWorkspaceResource("file")}>
                    <FilePlus size={15} />
                    <span>
                      <strong>Add files</strong>
                      <small>Attach docs, specs, logs, or notes</small>
                    </span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => void addWorkspaceResource("folder")}>
                    <Folder size={15} />
                    <span>
                      <strong>Add folder</strong>
                      <small>Index a repo, memory folder, or assets</small>
                    </span>
                  </button>
                </div>
              </>
            ) : null}
          </div>
          <button
            className="tool-btn"
            type="button"
            aria-label="Attach images"
            title={attachments.length >= MAX_ATTACHMENTS ? `Up to ${MAX_ATTACHMENTS} images` : "Attach images"}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={16} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="composer-file-input"
            onChange={handleAttachFiles}
          />
          <button className="tool-btn" type="button" aria-label="Voice input" title="Voice input — coming soon" disabled>
            <Mic size={16} />
          </button>
        </div>
        <div className="composer-send">
          <div className="router-wrap">
            <button className={`router-pill ${routerOpen ? "active" : ""}`} type="button" aria-haspopup="listbox" aria-expanded={routerOpen} onClick={() => setRouterOpen((open) => !open)}>
              <img src={selectedModel ? PROVIDERS[selectedModel.provider].logo : AUTOROUTER_LOGO} alt="" />
              {selectedModel ? selectedModel.model : "Auto router"}
              {selectedModel && resolveRouteSuffix(selectedModel) ? <small className="router-route-suffix">via {resolveRouteSuffix(selectedModel)}</small> : null}
              <ChevronUp className={`router-caret ${routerOpen ? "open" : ""}`} size={14} />
            </button>
            {routerOpen ? (
              <>
                <div className="router-backdrop" onClick={() => setRouterOpen(false)} />
                <div className="router-menu" role="listbox" aria-label="Choose a model">
                  <div className="router-menu-search">
                    <Search size={13} />
                    <input value={routerFilter} placeholder="Search models" autoFocus onChange={(event) => setRouterFilter(event.target.value)} />
                  </div>
                  <div className="router-menu-scroll">
                    {!routerFilter.trim() ? (
                      <button type="button" role="option" aria-selected={!selectedModel} className={`router-option auto ${!selectedModel ? "active" : ""}`} onClick={() => { setSelectedModel(null); setRouterOpen(false); }}>
                        <img src={AUTOROUTER_LOGO} alt="" />
                        <span><strong>Auto router</strong><small>Let Metis Policy choose</small></span>
                        {!selectedModel ? <Check size={14} /> : null}
                      </button>
                    ) : null}
                    {modelGroups.map((tier) => (
                      <div className="router-tier" key={tier.tier}>
                        <div className="router-tier-label">{tier.label}</div>
                        {tier.brands.map((brand) => (
                          <div className="router-brand" key={brand.provider}>
                            <div className="router-brand-label">
                              <img src={PROVIDERS[brand.provider].logo} alt="" />
                              {PROVIDERS[brand.provider].label}
                            </div>
                            {brand.models.map((ref) => {
                              const active = selectedModel?.provider === ref.provider && selectedModel?.model === ref.model;
                              const routeSuffix = resolveRouteSuffix(ref);
                              return (
                                <button key={`${ref.provider}-${ref.model}`} type="button" role="option" aria-selected={active} className={`router-option ${active ? "active" : ""}`} onClick={() => { setSelectedModel(ref); setRouterOpen(false); }}>
                                  <span className="router-option-name">
                                    {ref.model}
                                    {routeSuffix ? <small className="router-route-suffix">via {routeSuffix}</small> : null}
                                  </span>
                                  {active ? <Check size={14} /> : null}
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    ))}
                    {modelGroups.length === 0 ? <p className="router-empty">No models match. Add one below.</p> : null}
                  </div>
                  {addModelOpen ? (
                    <div className="router-add-form">
                      <input value={draftModelName} placeholder="Model name (e.g. GPT-5.6)" onChange={(event) => setDraftModelName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addCustomModel(); }} />
                      <CustomSelect
                        ariaLabel="Model provider"
                        value={draftModelProvider}
                        onChange={(value) => setDraftModelProvider(value as ProviderId)}
                        options={(Object.keys(PROVIDERS) as ProviderId[]).map((provider) => ({ value: provider, label: PROVIDERS[provider].label }))}
                      />
                      <div className="router-add-actions">
                        <button type="button" onClick={addCustomModel}>Add</button>
                        <button type="button" className="ghost" onClick={() => setAddModelOpen(false)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="router-add-trigger" onClick={() => setAddModelOpen(true)}>
                      <Plus size={13} /> Add a model
                    </button>
                  )}
                </div>
              </>
            ) : null}
          </div>
          {sessionBusy && !prompt.trim() ? (
            <button
              className="send-btn stop-btn"
              type="button"
              aria-label="Stop the run"
              title="Stop — the run halts at its next stage boundary"
              // NOTE (parallel sessions phase A): metisSession.cancel is
              // projectPath-scoped, not conversation-scoped, in the main
              // process today. If two conversations in this same project
              // folder are both streaming, this can stop the sibling run too.
              // Acceptable for phase A — a conversation-scoped cancel is a
              // backend change out of this refactor's contained scope.
              onClick={() => window.metisSession?.cancel?.(projectWorkspace?.path)}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-btn"
              type="submit"
              aria-label={sessionBusy ? "Send direction to the running build" : "Send message"}
              disabled={(!prompt.trim() && !attachments.length) || (sessionBusy && !window.metisBus)}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function PreviewRail({
  onClose,
  refreshTick,
  title,
  url
}: {
  onClose: () => void;
  refreshTick: number;
  title: string;
  url: string;
}): JSX.Element {
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  return (
    <aside className="preview-rail" aria-label="Live preview">
      <div className="preview-rail-header">
        <Monitor size={15} />
        <span className="preview-rail-title" title={title}>{title}</span>
        <div className="preview-rail-actions">
          <button type="button" aria-label="Refresh preview" onClick={() => setManualRefreshTick((tick) => tick + 1)}>
            <RefreshCw size={14} />
          </button>
          <button type="button" aria-label="Open in browser" onClick={() => openExternal(url)}>
            <ExternalLink size={14} />
          </button>
          <button type="button" aria-label="Close preview" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="preview-rail-body">
        <iframe
          key={`${refreshTick}-${manualRefreshTick}`}
          sandbox="allow-scripts allow-same-origin"
          src={url}
          title={title}
        />
      </div>
    </aside>
  );
}

/** One live model-call card (docs/FABLE_PLANS.md §26) — a "side chat" the user
 *  can watch happen, restyled as a miniature chat transcript so it reads like
 *  a real conversation instead of a collapsed log entry:
 *  - header (status dot, stage, pretty model, route chip) — click to collapse
 *    to just the header, as before.
 *  - a compact right-aligned "Router" bubble (the router speaking as the
 *    user) holding promptPreview, expandable to the fuller `prompt` field
 *    (capped ~2000 chars server-side) when there's more to show.
 *  - a left-aligned plain-markdown "AI" reply under the pretty model name.
 *  - while status is "start", the AI slot shows the shared thinking-dots
 *    typing indicator instead of output.
 *  - failures render the failure detail in the AI slot with a warning tint.
 *  Collapsed by default once resolved (complete/failed); the active (still
 *  "start") call stays expanded so its activity is visible without a click. */
function SideChatCard({ call }: { call: StageCallEvent["call"] }): JSX.Element {
  const resolved = call.status !== "start";
  const [expanded, setExpanded] = useState(!resolved);
  const [promptExpanded, setPromptExpanded] = useState(false);
  useEffect(() => {
    // Auto-expand the moment a card goes live; leave the user's manual
    // collapse/expand choice alone once it's resolved (no snapping shut a
    // card the user opened to read).
    if (!resolved) setExpanded(true);
  }, [resolved]);
  const hasMorePrompt = Boolean(call.prompt && call.prompt.length > call.promptPreview.length);
  const modelName = prettyModelName(call.provider, call.model);
  return (
    <div className={`side-chat-card ${call.status}`}>
      <button type="button" className="side-chat-card-head" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <ChevronRight className={`stage-caret ${expanded ? "open" : ""}`} size={13} />
        <span className={`side-chat-dot ${call.status}`} aria-hidden="true" />
        <span className="side-chat-stage">{call.stageLabel}</span>
        <span className="side-chat-model">{modelName}</span>
        <span className="side-chat-route">{providerLabel(call.provider)}</span>
      </button>
      {expanded ? (
        <div className="side-chat-card-body">
          <div className="side-chat-turn side-chat-turn-router">
            <span className="side-chat-caption">Router</span>
            <div className="side-chat-bubble side-chat-bubble-router">
              <p>{promptExpanded && call.prompt ? call.prompt : call.promptPreview}</p>
            </div>
            {hasMorePrompt ? (
              <button type="button" className="side-chat-prompt-toggle" onClick={() => setPromptExpanded((value) => !value)}>
                {promptExpanded ? "Show less" : "Show full prompt"}
              </button>
            ) : null}
          </div>
          <div className="side-chat-turn side-chat-turn-ai">
            <span className="side-chat-caption">{modelName}</span>
            {call.status === "start" ? (
              <div className="side-chat-bubble side-chat-bubble-ai">
                <span className="thinking-dots" aria-label="Waiting on a response">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ) : call.status === "failed" ? (
              <div className="side-chat-bubble side-chat-bubble-ai side-chat-bubble-warning">
                <p className="side-chat-failed">{call.detail ?? "This call failed."}</p>
              </div>
            ) : call.output ? (
              <div className="side-chat-bubble side-chat-bubble-ai">
                <Markdown>{call.output}</Markdown>
              </div>
            ) : (
              <p className="side-chat-pending">No output.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Right-side stack of every model call the orchestrator makes during a run
 *  (docs/FABLE_PLANS.md §26) — shares the rail with PreviewRail: when both
 *  exist they stack vertically, each independently scrollable, so a build
 *  with a live preview AND several stage calls doesn't have to choose. */
function SideChatStack({
  calls,
  collapsed,
  onToggleCollapsed,
  onClose
}: {
  calls: StageCallEvent["call"][];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <aside className="side-chat-stack" aria-label="Side chats">
      <div className="side-chat-stack-header">
        <Waypoints size={14} />
        <span className="side-chat-stack-title">Side chats ({calls.length})</span>
        <div className="side-chat-stack-actions">
          <button type="button" aria-label={collapsed ? "Expand side chats" : "Collapse side chats"} onClick={onToggleCollapsed}>
            {collapsed ? <ChevronDown size={14} /> : <Minus size={14} />}
          </button>
          <button type="button" aria-label="Close side chats" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      {collapsed ? null : (
        <div className="side-chat-stack-body">
          {calls.length === 0 ? (
            <p className="side-chat-empty">No model calls yet.</p>
          ) : (
            calls.map((call) => <SideChatCard key={call.id} call={call} />)
          )}
        </div>
      )}
    </aside>
  );
}

function reactNodeToPlainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeToPlainText).join("");
  if (isValidElement(node)) return reactNodeToPlainText((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }): JSX.Element | null {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  if (!reactNodeToPlainText(children).trim()) return null;
  function copy(): void {
    const text = ref.current?.innerText ?? "";
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <div className="md-codeblock">
      <button type="button" className="md-copy" onClick={copy} aria-label="Copy code">
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => (className ? <code className={className}>{children}</code> : <code className="md-inline">{children}</code>),
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) openExternal(href);
      }}
    >
      {children}
    </a>
  )
};

function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Builds a clean markdown transcript of one completed turn — assistant text
 *  plus each pipeline stage's output — from the run data itself (never DOM
 *  innerText), for the per-turn copy affordance. */
function turnToMarkdown(run: SessionRun): string {
  const parts: string[] = [];
  if (run.assistantText.trim()) parts.push(run.assistantText.trim());
  for (const stage of run.stages ?? []) {
    if (!stage.output.trim()) continue;
    parts.push(`## ${stage.label} (${prettyModelName(stage.provider, stage.model)})\n\n${stage.output.trim()}`);
  }
  return parts.join("\n\n").trim();
}

function TurnCopyButton({ run }: { run: SessionRun }): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const text = turnToMarkdown(run);
  if (!text) return null;
  function copy(): void {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <button type="button" className="turn-copy" onClick={copy} aria-label="Copy conversation turn">
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

const ConversationTurnCard = memo(function ConversationTurnCard({ anchorId, turn }: { anchorId?: string; turn: ConversationTurn }): JSX.Element {
  if (turn.directive) {
    return (
      <article className="conversation-turn directive" id={anchorId}>
        <div className="message-row user-message">
          <div className="user-bubble">
            <p>{turn.prompt}</p>
          </div>
        </div>
        <div className="message-row assistant-message">
          <div className="route-line">
            <Waypoints size={13} />
            <span>Direction queued — the running build picks it up before its next stage.</span>
          </div>
        </div>
      </article>
    );
  }
  return (
    <article className={`conversation-turn ${turn.status}`} id={anchorId}>
      <div className="message-row user-message">
        <div className="user-bubble">
          {turn.attachments && turn.attachments.length ? (
            <div className="turn-attachment-row" aria-label="Attached images">
              {turn.attachments.map((item, index) => (
                <img
                  key={item.id ?? `${turn.id}-att-${index}`}
                  className="turn-attachment-thumb"
                  src={`data:${item.mimeType};base64,${item.dataBase64}`}
                  alt={item.name}
                  title={item.name}
                />
              ))}
            </div>
          ) : null}
          {turn.prompt ? <p>{turn.prompt}</p> : null}
        </div>
      </div>

      <div className="message-row assistant-message">
        {turn.run ? (
          <>
            <TurnCopyButton run={turn.run} />
            <CompletedRun run={turn.run} />
          </>
        ) : (
          <PendingRun turn={turn} />
        )}
      </div>
    </article>
  );
});

function PendingRun({ turn }: { turn: ConversationTurn }): JSX.Element {
  if (turn.status === "error") {
    return <small className="session-warning">{turn.error ?? "Something went wrong on that route."}</small>;
  }
  if (turn.streamEvents?.length || turn.liveAssistantText || turn.liveThoughtText) {
    return <LiveRunTimeline turn={turn} />;
  }
  return (
    <details className="route-line-details pending-thinking">
      <summary className="route-line running" role="status" aria-label="Thinking">
        <ChevronRight className="stage-caret" size={14} />
        <Waypoints size={13} />
        <span className="thinking-text" aria-hidden="true" />
        <span className="sr-only">Thinking...</span>
      </summary>
      <div className="route-trace-body">
        <p>Waiting for the first streamed model or tool event.</p>
      </div>
    </details>
  );
}

function LiveRunTimeline({ turn }: { turn: ConversationTurn }): JSX.Element {
  return (
    <div className="run-timeline live">
      {turn.liveAssistantText?.trim() ? (
        <AssistantResponse source={{ kind: "local", label: "Local output" }}>{turn.liveAssistantText}</AssistantResponse>
      ) : null}
      {turn.liveThoughtText?.trim() ? <ModelThoughts text={turn.liveThoughtText} live /> : null}
      {turn.streamEvents?.map((event) => {
        if (event.kind === "text") {
          return <AssistantResponse key={event.id} source={{ kind: "metis", label: "Metis synthesis" }}>{event.content}</AssistantResponse>;
        }
        if (event.kind === "route") {
          return (
            <details className="route-line-details" key={event.id}>
              <summary className="route-line">
                <ChevronRight className="stage-caret" size={14} />
                <Waypoints size={13} />
                <span>Routed via {event.label ?? "Metis"}</span>
              </summary>
              <div className="route-trace-body">
                {turn.streamSteps?.length ? <PipelineSteps steps={turn.streamSteps} /> : <p className="live-pending-note">Route selected. Waiting for the next pipeline event.</p>}
              </div>
            </details>
          );
        }
        if (event.kind === "stage") {
          const stage = turn.streamStages?.find((item) => item.id === event.stageId);
          return stage ? <StageBlock key={event.id} stage={stage} /> : <LiveStatusLine key={event.id} label="Running model stage" />;
        }
        if (event.kind === "operations") {
          const eventOperations = event.operationIds?.length
            ? (turn.streamOperations ?? []).filter((operation) => event.operationIds?.includes(operation.id))
            : turn.streamOperations ?? [];
          return eventOperations.length ? (
            <TimelineOperations key={event.id} detail={event.detail} operations={eventOperations} project={turn.streamProject} title={event.title} />
          ) : (
            <LiveStatusLine key={event.id} label={event.title} />
          );
        }
        return null;
      })}
      {turn.pendingPermission ? <PermissionRequestCard request={turn.pendingPermission} /> : null}
      {turn.pendingQuestion ? <UserQuestionCard question={turn.pendingQuestion} /> : null}
      {!turn.pendingPermission && !turn.pendingQuestion ? (
        <div className="route-line running" role="status" aria-label="Still running">
          <Waypoints size={13} />
          <span className="thinking-text" aria-hidden="true" />
          <span className="sr-only">Thinking...</span>
        </div>
      ) : null}
    </div>
  );
}

/** In-run permission approval card (docs/FABLE_PLANS.md §24) — slim,
 *  accent-left-border, matching the chat grammar. Collapses to a one-line
 *  record after a verdict; shows a disabled note in the no-bridge preview. */
function PermissionRequestCard({ request }: { request: NonNullable<ConversationTurn["pendingPermission"]> }): JSX.Element {
  const [resolved, setResolved] = useState<"allow" | "always" | "deny" | null>(null);

  function respond(verdict: "allow" | "always" | "deny"): void {
    setResolved(verdict);
    window.metisPermissions?.respond(request.id, verdict);
  }

  if (resolved) {
    const label = resolved === "deny" ? "Denied" : resolved === "always" ? "Always allowed" : "Allowed once";
    return (
      <div className="permission-card resolved">
        <ShieldCheck size={13} />
        <span>
          {label} — {request.detail}
        </span>
      </div>
    );
  }

  return (
    <div className="permission-card" role="dialog" aria-label="Permission request">
      <div className="permission-card-detail">
        <Shield size={14} />
        <span>{request.detail}</span>
      </div>
      {window.metisPermissions ? (
        <div className="permission-card-actions">
          <button type="button" onClick={() => respond("allow")}>
            Allow once
          </button>
          <button type="button" onClick={() => respond("always")}>
            Always allow
          </button>
          <button type="button" className="deny" onClick={() => respond("deny")}>
            Deny
          </button>
        </div>
      ) : (
        <small className="permission-card-disabled">Permission prompts need the desktop app — this is a preview.</small>
      )}
    </div>
  );
}

/** AskUserQuestion card (docs/FABLE_PLANS.md §24) — option chips plus a small
 *  free-text input; collapses to "You answered: X" once answered. */
function UserQuestionCard({ question }: { question: NonNullable<ConversationTurn["pendingQuestion"]> }): JSX.Element {
  const [answer, setAnswer] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");

  function respond(value: string): void {
    const text = value.trim();
    if (!text) return;
    setAnswer(text);
    window.metisSession?.answerQuestion(question.id, text);
  }

  if (answer) {
    return (
      <div className="permission-card resolved">
        <HelpCircle size={13} />
        <span>You answered: {answer}</span>
      </div>
    );
  }

  return (
    <div className="permission-card question-card" role="dialog" aria-label="Question">
      <div className="permission-card-detail">
        <HelpCircle size={14} />
        <span>{question.text}</span>
      </div>
      {question.options.length > 0 ? (
        <div className="question-card-options">
          {question.options.map((option) => (
            <button key={option} type="button" onClick={() => respond(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {window.metisSession ? (
        <form
          className="question-card-freetext"
          onSubmit={(event) => {
            event.preventDefault();
            respond(freeText);
          }}
        >
          <input value={freeText} onChange={(event) => setFreeText(event.target.value)} placeholder="Or type your own answer" />
          <button type="submit">Send</button>
        </form>
      ) : (
        <small className="permission-card-disabled">Answering needs the desktop app — this is a preview.</small>
      )}
    </div>
  );
}

function ModelThoughts({ live = false, text }: { live?: boolean; text: string }): JSX.Element {
  if (!text.trim()) return <></>;
  return (
    <details className={`route-line-details model-thoughts ${live ? "live" : ""}`}>
      <summary className="route-line">
        <ChevronRight className="stage-caret" size={14} />
        <Waypoints size={13} />
        <span>{live ? "Thinking" : "Model thoughts"}</span>
      </summary>
      <div className="route-trace-body thought-body">
        <Markdown>{text}</Markdown>
      </div>
    </details>
  );
}

function LiveStatusLine({ label }: { label: string }): JSX.Element {
  return (
    <div className="route-line running">
      <Waypoints size={13} />
      <span>{label}</span>
    </div>
  );
}

function routeDisplayName(run: SessionRun): string {
  if (run.routeLabel) return run.routeLabel;
  const name = run.pipelineName
    .replace(/\s*Orchestration Pipeline$/i, "")
    .replace(/\s*Assistant Pipeline$/i, "")
    .replace(/\s*Pipeline$/i, "")
    .trim();
  return name || "Metis";
}

function providerLabel(provider: ProviderKey): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  if (provider === "gemini") return "Gemini";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "nvidia") return "NVIDIA NIM";
  if (provider === "groq") return "Groq";
  return "Ollama";
}

// Known API model ids -> human display names. Anything not listed falls back
// to a generic prettifier (strip provider prefixes, split on separators,
// capitalize words, keep version dots/numbers intact).
const PRETTY_MODEL_NAMES: Record<string, string> = {
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  "deepseek-chat": "DeepSeek V3",
  "deepseek-reasoner": "DeepSeek R1",
  "deepseek-ai/deepseek-v3.1": "DeepSeek V3.1 (NVIDIA)",
  "llama-3.3-70b-versatile": "Llama 3.3 70B (Groq)",
  "gpt-5.1": "GPT-5.1",
  "gpt-5": "GPT-5",
  "gpt-4.1": "GPT-4.1",
  "gpt-4o": "GPT-4o",
  "qwen3:8b": "Qwen3 8B",
  "qwen3:14b": "Qwen3 14B",
  "qwen3:32b": "Qwen3 32B",
  "llama3.1:8b": "Llama 3.1 8B",
  "llama3.1:70b": "Llama 3.1 70B",
  "mistral:7b": "Mistral 7B"
};

function prettyModelName(provider: ProviderKey, model: string): string {
  if (!model) return providerLabel(provider);
  const known = PRETTY_MODEL_NAMES[model.toLowerCase()];
  if (known) return known;

  // Generic fallback: strip a leading provider-ish prefix, split on common
  // separators, capitalize each word, and keep version numbers (with dots)
  // and trailing size suffixes (e.g. "8b", "70b") intact.
  const stripped = model.replace(/^(claude|gemini|gpt|deepseek|qwen|llama|mistral|openrouter)[-:_]?/i, (match) =>
    // Keep the prefix if stripping would leave nothing usable.
    match.length >= model.length ? match : ""
  );
  const base = stripped || model;
  const words = base.split(/[-_:\/\s]+/).filter(Boolean);
  const pretty = words
    .map((word) => {
      if (/^v?\d+(\.\d+)*[a-z]?$/i.test(word)) return word.replace(/^v/i, "v").toUpperCase().replace(/^V/, "v");
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
  const prefixLabel = providerLabel(provider);
  return pretty ? `${prefixLabel} ${pretty}`.replace(/\s+/g, " ").trim() : prefixLabel;
}

function responseSource(run: SessionRun): { kind: "cloud" | "local" | "metis"; label: string } {
  const providerResult = run.providerResult;
  const providerOutput = providerResult?.source !== "placeholder" ? providerResult?.output.trim() : "";
  if (providerOutput && run.assistantText.trim() === providerOutput) {
    const local = providerResult?.provider === "ollama";
    return {
      kind: local ? "local" : "cloud",
      label: `${local || !providerResult ? "Local" : providerLabel(providerResult.provider)} output`
    };
  }
  return { kind: "metis", label: "Metis synthesis" };
}

function AssistantResponse({ children, source }: { children: string; source: ReturnType<typeof responseSource> }): JSX.Element {
  // The provider/source is shown in the "Routed via" line — no per-message label.
  return (
    <div className={`assistant-response ${source.kind}`}>
      <Markdown>{children}</Markdown>
    </div>
  );
}

const CompletedRun = memo(function CompletedRun({ run }: { run: SessionRun }): JSX.Element {
  const warnings = visibleRunWarnings(run.warnings);
  const showRouteTrace = shouldShowRouteTrace(run, warnings);

  if (run.timeline?.length) {
    return <RunTimeline run={run} events={run.timeline} warnings={warnings} />;
  }

  if (run.stages && run.stages.length > 0) {
    return (
      <>
        <Markdown>{run.assistantText}</Markdown>
        {run.stages.map((stage) => (
          <StageBlock stage={stage} key={stage.id} />
        ))}
        {run.projectResult ? <ProjectArtifacts run={run} /> : null}
        <details className="route-line-details">
          <summary className="route-line">
            <Waypoints size={13} />
            <span>Routed via {routeDisplayName(run)}</span>
          </summary>
          <div className="route-trace-body">
            <PipelineSteps steps={run.steps} />
          </div>
        </details>
        {warnings.length > 0 ? <small className="session-warning">{warnings[0]}</small> : null}
      </>
    );
  }

  const [opening, followUp] = splitAssistantTextForTimeline(run.assistantText);
  const source = responseSource(run);
  return (
    <>
      <AssistantResponse source={source}>{showRouteTrace ? opening : run.assistantText}</AssistantResponse>
      {run.modelThoughts ? <ModelThoughts text={run.modelThoughts} /> : null}
      {run.projectResult ? <ProjectArtifacts run={run} /> : null}
      {!run.projectResult && run.operations?.length ? <RunOperations operations={run.operations} /> : null}
      {showRouteTrace ? (
        <details className="route-line-details">
          <summary className="route-line">
            <Waypoints size={13} />
            <span>Routed via {routeDisplayName(run)}</span>
          </summary>
          <div className="route-trace-body">
            <PipelineSteps steps={run.steps} />
          </div>
        </details>
      ) : null}
      {showRouteTrace && followUp ? <AssistantResponse source={source}>{followUp}</AssistantResponse> : null}
      {warnings.length > 0 ? <small className="session-warning">{warnings[0]}</small> : null}
    </>
  );
});

function RunTimeline({ events, run, warnings }: { events: SessionTimelineEvent[]; run: SessionRun; warnings: string[] }): JSX.Element {
  const source = responseSource(run);
  const operations = run.operations ?? [];
  return (
    <div className="run-timeline">
      {events.map((event) => {
        if (event.kind === "text") {
          return <AssistantResponse key={event.id} source={source}>{event.content}</AssistantResponse>;
        }
        if (event.kind === "route") {
          return (
            <details className="route-line-details" key={event.id}>
              <summary className="route-line">
                <ChevronRight className="stage-caret" size={14} />
                <Waypoints size={13} />
                <span>Routed via {routeDisplayName(run)}</span>
              </summary>
              <div className="route-trace-body">
                <PipelineSteps steps={run.steps} />
              </div>
            </details>
          );
        }
        if (event.kind === "stage") {
          const stage = run.stages?.find((item) => item.id === event.stageId);
          return stage ? <StageBlock key={event.id} stage={stage} /> : null;
        }
        if (event.kind === "operations") {
          const eventOperations = event.operationIds?.length ? operations.filter((operation) => event.operationIds?.includes(operation.id)) : operations;
          if (eventOperations.length === 0) return null;
          return <TimelineOperations key={event.id} detail={event.detail} operations={eventOperations} project={run.projectResult} title={event.title} />;
        }
        return null;
      })}
      {warnings.length > 0 ? <small className="session-warning">{warnings[0]}</small> : null}
    </div>
  );
}

function StageBlock({ stage }: { stage: NonNullable<SessionRun["stages"]>[number] }): JSX.Element {
  return (
    <details className={`stage-block ${stage.failed ? "failed" : ""}`}>
      <summary className="stage-head">
        <ChevronRight className="stage-caret" size={14} />
        <span className="stage-name">{stage.label}</span>
        <span className="stage-model">{prettyModelName(stage.provider, stage.model)}</span>
      </summary>
      <div className="stage-body">
        {stage.fallbackNotes.map((note, index) => (
          <p className="stage-fallback" key={index}>{note}</p>
        ))}
        {stage.thoughts?.trim() ? <ModelThoughts text={stage.thoughts} /> : null}
        {stage.output ? <Markdown>{stage.output}</Markdown> : stage.failed ? <p className="stage-fallback">This stage produced no output.</p> : null}
      </div>
    </details>
  );
}

/** Slim, Claude-Code-style single-line operation rows for the conversation
 *  feed. No box, no headers, no filter tabs — just a stack of collapsed
 *  one-liners that expand into the full detail on click.
 *
 *  §20 grammar: batches of MORE THAN this many ops collapse into one summary
 *  row ("Edited 3 files, read 2 files, ran 2 checks") that expands into the
 *  full flat stack of SlimOperationLine rows. 3 or fewer stays flat — no
 *  over-nesting for a couple of ops. */
const SLIM_OPERATION_GROUP_THRESHOLD = 3;

/** Claude-Code-style natural-order summary of a batch of operations: file ops
 *  first (edited/created, merged), then context loads ("read N files"), then
 *  commands+browser checks ("ran N checks"), then anything else by label.
 *  Failures/warnings are appended per-clause ("edited 3 files, 1 failed").
 *  Shared by the grouped-summary row (this file) and any other collapsed
 *  one-liner that wants the same grammar — the single summarizer for the
 *  whole app, no duplicate summary styles. */
function timelineOperationLabel(operations: AgentOperation[]): string {
  if (operations.length === 0) return "";

  const edited = operations.filter((op) => op.kind === "file_edit");
  const created = operations.filter((op) => op.kind === "file_create");
  const contextLoads = operations.filter((op) => op.kind === "context_load");
  const checks = operations.filter((op) => op.kind === "command" || op.kind === "browser_check");
  const knownKinds = new Set(["file_edit", "file_create", "context_load", "command", "browser_check"]);
  const others = operations.filter((op) => !knownKinds.has(op.kind));

  function clause(count: number, verb: string, noun: string, group: AgentOperation[]): string | null {
    if (count === 0) return null;
    const failed = group.filter((op) => op.status !== "complete").length;
    const base = `${verb} ${count} ${noun}${count === 1 ? "" : "s"}`;
    return failed > 0 ? `${base}, ${failed} failed` : base;
  }

  const clauses: string[] = [];
  const fileClause = clause(edited.length + created.length, edited.length && created.length ? "Edited/created" : created.length ? "Created" : "Edited", "file", [...edited, ...created]);
  if (fileClause) clauses.push(fileClause);
  const readClause = clause(contextLoads.length, "Read", "file", contextLoads);
  if (readClause) clauses.push(readClause);
  const checkClause = clause(checks.length, "Ran", "check", checks);
  if (checkClause) clauses.push(checkClause);

  // Group "others" by label so e.g. two "git" ops become "2 git" not two lines.
  const othersByLabel = new Map<string, AgentOperation[]>();
  for (const op of others) {
    const list = othersByLabel.get(op.label) ?? [];
    list.push(op);
    othersByLabel.set(op.label, list);
  }
  for (const [label, group] of othersByLabel) {
    clauses.push(group.length > 1 ? `${label} ×${group.length}` : label);
  }

  if (clauses.length === 0) return `${operations.length} operations`;
  return clauses.join(", ");
}

function operationBasename(operation: AgentOperation): string {
  const source = operation.target ?? operation.command ?? "";
  if (!source) return operation.label;
  const base = source.split(/[\\/]/).pop() ?? source;
  return base || operation.label;
}

function operationFullPath(operation: AgentOperation): string | undefined {
  return operation.target ?? operation.cwd;
}

function SlimOperationLine({ operation, targetDir }: { operation: AgentOperation; targetDir?: string }): JSX.Element {
  const isFile = operation.kind === "file_edit" || operation.kind === "file_create";
  const isCheck = operation.kind === "command" || operation.kind === "browser_check";
  const fullPath = operationFullPath(operation);
  const hasBody = Boolean(
    fullPath ||
      targetDir ||
      operation.detail ||
      operation.title ||
      operation.command ||
      operation.cwd ||
      operation.stdout ||
      operation.stderr ||
      operation.permission ||
      operation.screenshotPath ||
      operation.consoleErrors?.length
  );
  const summaryContent = (
    <>
      <OperationIcon kind={operation.kind} />
      <span>{isFile ? `${operation.label} ${operationBasename(operation)}` : operation.label}</span>
      {isFile ? (
        <em className="diff-stat">
          <b>+{operation.addedLines ?? 0}</b>
          <i>-{operation.removedLines ?? 0}</i>
        </em>
      ) : isCheck ? (
        <em>
          {operation.status === "complete" ? "ok" : operation.status}
          {operation.durationMs !== undefined ? ` · ${operation.durationMs}ms` : ""}
        </em>
      ) : operation.status !== "complete" ? (
        <em>{operation.status}</em>
      ) : null}
    </>
  );
  if (!hasBody) {
    return <div className={`slim-op-line ${operation.status}`}>{summaryContent}</div>;
  }
  return (
    <details className={`slim-op-line-details ${operation.status}`}>
      <summary className="slim-op-line">{summaryContent}</summary>
      <div className="operation-detail-body">
        {targetDir ? <small>Target folder: {targetDir}</small> : null}
        {fullPath ? <small>Path: {fullPath}</small> : null}
        {operation.detail ? <p>{operation.detail}</p> : null}
        {operation.title ? <small>Title: {operation.title}</small> : null}
        {operation.durationMs !== undefined ? <small>Duration: {operation.durationMs}ms</small> : null}
        {operation.command ? <code>{operation.command}</code> : null}
        {operation.cwd ? <small>CWD: {operation.cwd}</small> : null}
        {operation.permission ? <small>Permission: {operation.permission}</small> : null}
        {operation.screenshotPath ? (
          <span className="operation-file-link">
            <small>Screenshot: {operation.screenshotPath}</small>
            {window.metisShell ? (
              <button type="button" onClick={() => openLocalPath(operation.screenshotPath ?? "")}>
                Open
              </button>
            ) : null}
          </span>
        ) : null}
        {operation.consoleErrors?.length ? <pre className="error">{operation.consoleErrors.join("\n")}</pre> : null}
        {operation.stdout ? <pre>{operation.stdout}</pre> : null}
        {operation.stderr ? <pre className="error">{operation.stderr}</pre> : null}
      </div>
    </details>
  );
}

/** One collapsed summary row for a batch of >3 operations — the Claude-Code
 *  "Edited 3 files, read 2 files, ran 2 checks" grammar. Expands (native
 *  <details>) into the exact same SlimOperationLine stack used for small
 *  batches; each line keeps its own nested expandable detail. */
function GroupedOperationSummary({ operations, targetDir }: { operations: AgentOperation[]; targetDir?: string }): JSX.Element {
  const hasIssue = operations.some((op) => op.status !== "complete");
  const tone = operations.some((op) => op.status === "error") ? "error" : hasIssue ? "warning" : "complete";
  return (
    <details className={`slim-op-line-details slim-op-group ${tone}`}>
      <summary className="slim-op-line">
        <ChevronRight className="stage-caret" size={13} />
        <Folder size={14} />
        <span>{timelineOperationLabel(operations)}</span>
      </summary>
      <div className="operation-detail-body slim-op-group-body">
        {targetDir ? <small>Target folder: {targetDir}</small> : null}
        {operations.map((operation) => (
          <SlimOperationLine key={operation.id} operation={operation} />
        ))}
      </div>
    </details>
  );
}

function SlimOperationList({
  extraDetail,
  operations,
  previewUrl,
  targetDir
}: {
  extraDetail?: string;
  operations: AgentOperation[];
  previewUrl?: string;
  targetDir?: string;
}): JSX.Element | null {
  const previewControl = useContext(PreviewRailContext);
  if (operations.length === 0 && !previewUrl) return null;
  const grouped = operations.length > SLIM_OPERATION_GROUP_THRESHOLD;
  return (
    <div className="slim-op-list">
      {grouped ? (
        <GroupedOperationSummary operations={operations} targetDir={targetDir} />
      ) : (
        operations.map((operation, index) => (
          <SlimOperationLine key={operation.id} operation={operation} targetDir={index === 0 ? targetDir : undefined} />
        ))
      )}
      {previewUrl ? (
        <div className="slim-op-line preview-line">
          <Monitor size={14} />
          <a
            href={previewUrl}
            onClick={(event) => {
              event.preventDefault();
              openPreviewOrExternal(previewControl, previewUrl, targetDir ? projectNameFromPath(targetDir) : "Preview");
            }}
          >
            Preview
          </a>
        </div>
      ) : null}
      {extraDetail ? <p className="slim-op-extra">{extraDetail}</p> : null}
    </div>
  );
}

function TimelineOperations({
  detail,
  operations,
  project,
  title
}: {
  detail?: string;
  operations: AgentOperation[];
  project?: SessionRun["projectResult"];
  title: string;
}): JSX.Element | null {
  const showPreview = Boolean(project?.previewUrl && title.toLowerCase().includes("verification"));
  if (operations.length === 0 && !showPreview) return null;
  return (
    <SlimOperationList
      operations={operations}
      previewUrl={showPreview ? project?.previewUrl : undefined}
      extraDetail={detail}
    />
  );
}

function splitAssistantTextForTimeline(text: string): [string, string] {
  const trimmed = text.trim();
  if (!trimmed) return ["", ""];
  // Never split text that contains a markdown list — splitting mid-list left
  // list items dangling with no content (e.g. "1. 2. 3." rendering empty).
  if (/^\s*(\d+\.|[-*])\s/m.test(trimmed)) return [trimmed, ""];
  const paragraphBreak = trimmed.search(/\n\s*\n/);
  if (paragraphBreak > 0) {
    return [trimmed.slice(0, paragraphBreak).trim(), trimmed.slice(paragraphBreak).trim()];
  }
  const sentenceMatch = /([.!?])\s+/.exec(trimmed);
  if (!sentenceMatch || sentenceMatch.index < 0) return [trimmed, ""];
  const splitAt = sentenceMatch.index + sentenceMatch[0].length;
  return [trimmed.slice(0, splitAt).trim(), trimmed.slice(splitAt).trim()];
}

function visibleRunWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => !/proxy evidence|quality for .* uses proxy|needs judge or human visual validation/i.test(warning));
}

function shouldShowRouteTrace(run: SessionRun, warnings: string[]): boolean {
  if (run.projectResult) return true;
  if (warnings.length > 0) return true;
  return run.decision.decision.task_type !== "general_chat";
}

function ProjectArtifacts({ run }: { run: SessionRun }): JSX.Element | null {
  const project = run.projectResult;
  if (!project) return null;
  const operations = run.operations?.length ? run.operations : operationsFromArtifacts(run);
  const showPreview = Boolean(project.previewUrl);
  return (
    <SlimOperationList
      operations={operations}
      previewUrl={showPreview ? project.previewUrl : undefined}
      targetDir={project.projectRoot}
      extraDetail={!project.verified ? project.verificationDetail : undefined}
    />
  );
}

function RunOperations({ operations }: { operations: AgentOperation[] }): JSX.Element | null {
  if (operations.length === 0) return null;
  return <SlimOperationList operations={operations} />;
}

type OperationFilter = "all" | "files" | "checks" | "issues";

const OPERATION_FILTERS: { key: OperationFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "files", label: "Files" },
  { key: "checks", label: "Checks" },
  { key: "issues", label: "Issues" }
];

function OperationTimeline({ operations }: { operations: AgentOperation[] }): JSX.Element {
  const [filter, setFilter] = useState<OperationFilter>("all");
  const edits = operations.filter((operation) => operation.kind === "file_edit" || operation.kind === "file_create").length;
  const checks = operations.filter((operation) => operation.kind === "browser_check" || operation.kind === "command").length;
  const issues = operations.filter((operation) => operation.status !== "complete").length;
  const visibleOperations = operations.filter((operation) => operationMatchesFilter(operation, filter));
  return (
    <section className="operation-timeline" aria-label="Agent operations">
      <header>
        <span>Operations</span>
        <em className="operation-summary">{edits} edit{edits === 1 ? "" : "s"} / {checks} check{checks === 1 ? "" : "s"} / {issues} issue{issues === 1 ? "" : "s"}</em>
        <em>{edits} edit{edits === 1 ? "" : "s"} · {checks} check{checks === 1 ? "" : "s"}</em>
      </header>
      <div className="operation-filters" role="tablist" aria-label="Operation filters">
        {OPERATION_FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={filter === item.key}
            className={filter === item.key ? "active" : ""}
            onClick={() => setFilter(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="artifact-list">
        {visibleOperations.map((operation) => (
          <OperationRow key={operation.id} operation={operation} />
        ))}
        {visibleOperations.length === 0 ? <p className="operation-empty">No operations in this view yet.</p> : null}
      </div>
    </section>
  );
}

function operationMatchesFilter(operation: AgentOperation, filter: OperationFilter): boolean {
  if (filter === "files") return operation.kind === "file_edit" || operation.kind === "file_create" || operation.kind === "directory_create";
  if (filter === "checks") return operation.kind === "browser_check" || operation.kind === "command" || operation.kind === "mcp_call" || operation.kind === "git";
  if (filter === "issues") return operation.status !== "complete";
  return true;
}

function OperationRow({ operation }: { operation: AgentOperation }): JSX.Element {
  const hasDetails = Boolean(
    operation.detail ||
      operation.title ||
      operation.durationMs !== undefined ||
      operation.command ||
      operation.cwd ||
      operation.stdout ||
      operation.stderr ||
      operation.permission ||
      operation.screenshotPath ||
      operation.consoleErrors?.length
  );
  const row = (
    <>
      <span className="artifact-icon">
        <OperationIcon kind={operation.kind} />
      </span>
      <span>
        <strong>{operation.label}</strong>
        <small>{operation.target ?? operation.command ?? operation.detail ?? operation.kind}</small>
      </span>
      <OperationMeta operation={operation} />
    </>
  );
  if (!hasDetails) {
    return <div className={`artifact-row ${operation.kind} ${operation.status}`}>{row}</div>;
  }
  return (
    <details className={`artifact-row operation-details ${operation.kind} ${operation.status}`}>
      <summary>{row}</summary>
      <div className="operation-detail-body">
        {operation.detail ? <p>{operation.detail}</p> : null}
        {operation.title ? <small>Title: {operation.title}</small> : null}
        {operation.durationMs !== undefined ? <small>Duration: {operation.durationMs}ms</small> : null}
        {operation.command ? <code>{operation.command}</code> : null}
        {operation.cwd ? <small>CWD: {operation.cwd}</small> : null}
        {operation.permission ? <small>Permission: {operation.permission}</small> : null}
        {operation.screenshotPath ? (
          <span className="operation-file-link">
            <small>Screenshot: {operation.screenshotPath}</small>
            {window.metisShell ? (
              <button type="button" onClick={() => openLocalPath(operation.screenshotPath ?? "")}>
                Open
              </button>
            ) : null}
          </span>
        ) : null}
        {operation.consoleErrors?.length ? (
          <pre className="error">{operation.consoleErrors.join("\n")}</pre>
        ) : null}
        {operation.stdout ? <pre>{operation.stdout}</pre> : null}
        {operation.stderr ? <pre className="error">{operation.stderr}</pre> : null}
      </div>
    </details>
  );
}

function OperationIcon({ kind }: { kind: AgentOperation["kind"] }): JSX.Element {
  if (kind === "file_edit" || kind === "file_create") return <Pencil size={14} />;
  if (kind === "command") return <Terminal size={14} />;
  if (kind === "browser_check") return <Monitor size={14} />;
  if (kind === "mcp_call") return <Plug size={14} />;
  if (kind === "git") return <GitBranch size={14} />;
  return <Folder size={14} />;
}

function OperationMeta({ operation }: { operation: AgentOperation }): JSX.Element | null {
  if (operation.kind === "file_edit" || operation.kind === "file_create") {
    return (
      <em className="diff-stat">
        <b>+{operation.addedLines ?? 0}</b>
        <i>-{operation.removedLines ?? 0}</i>
      </em>
    );
  }
  if (operation.kind === "command") {
    return (
      <em className="command-stat">
        <Terminal size={12} /> {operation.exitCode === 0 ? "ok" : `exit ${operation.exitCode ?? "?"}`}{operation.durationMs !== undefined ? ` · ${operation.durationMs}ms` : ""}
      </em>
    );
  }
  if (operation.kind === "browser_check") {
    return (
      <em className="command-stat">
        <Monitor size={12} /> {operation.status === "complete" ? "ok" : operation.status}{operation.durationMs !== undefined ? ` · ${operation.durationMs}ms` : ""}
      </em>
    );
  }
  if (operation.status !== "complete") return <em className="command-stat">{operation.status}</em>;
  return null;
}

function operationsFromArtifacts(run: SessionRun): AgentOperation[] {
  const project = run.projectResult;
  if (!project) return [];
  return project.artifacts.map((artifact, index) => {
    if (artifact.kind === "file" || artifact.kind === "file_create") {
      return {
        id: `${run.id}-artifact-${index}`,
        kind: artifact.kind === "file_create" ? "file_create" : "file_edit",
        label: `${artifact.kind === "file_create" ? "Created" : "Edited"} ${artifact.label}`,
        target: artifact.path,
        status: "complete",
        addedLines: artifact.addedLines ?? 0,
        removedLines: artifact.removedLines ?? 0,
        permission: "filesystem.write",
        detail: artifact.bytes ? `${Math.round(artifact.bytes / 100) / 10} KB written` : undefined
      };
    }
    if (artifact.kind === "preview") {
      return {
        id: `${run.id}-artifact-${index}`,
        kind: "browser_check",
        label: "Checked local preview",
        target: artifact.url,
        url: artifact.url,
        title: project.verificationTitle,
        screenshotPath: project.verificationScreenshotPath,
        consoleErrors: project.verificationConsoleErrors,
        status: project.verified ? "complete" : "warning",
        permission: "network.web",
        durationMs: project.verificationDurationMs,
        detail: project.verificationDetail
      };
    }
    return {
      id: `${run.id}-artifact-${index}`,
      kind: "directory_create",
      label: artifact.label,
      target: artifact.path,
      status: "complete",
      permission: "filesystem.write"
    };
  });
}

function PipelineSteps({ steps }: { steps: SessionPipelineStep[] }): JSX.Element {
  return (
    <ol className="pipeline-steps">
      {steps.map((step) => (
        <li className="pipeline-step" key={step.id}>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

function introForPipeline(name: string): string {
  if (name.includes("Front End")) {
    return "I can totally design the front end for you. I routed this according to your orchestration pipeline, then prepared the testing pass.";
  }
  if (name.includes("Coding")) {
    return "I can handle that. I routed it through the coding pipeline and prepared the verification pass.";
  }
  return "I routed this according to your orchestration pipeline and kept the route trace attached.";
}

function makePendingTurn(id: string, prompt: string, attachments?: SessionAttachment[]): ConversationTurn {
  return { id, prompt, status: "running", attachments: attachments && attachments.length ? attachments : undefined };
}

function makePreviewRun(prompt: string): SessionRun {
  const createdAt = new Date().toISOString();
  const isFrontend = /\b(front\s*end|landing page|website|ui|design)\b/i.test(prompt);
  const pipelineName = isFrontend ? "Front End Orchestration Pipeline" : "General Assistant Pipeline";
  const steps: SessionPipelineStep[] = [
    {
      id: "route",
      label: "Route through Metis Policy",
      detail: "Browser preview cannot access Electron IPC, so this uses the safe preview route.",
      status: "complete",
      startedAt: createdAt,
      completedAt: createdAt
    },
    {
      id: "orchestration",
      label: `Run ${pipelineName}`,
      detail: "The desktop app will load skills, presets, context, and route overrides here.",
      status: "complete",
      startedAt: createdAt,
      completedAt: createdAt
    },
    {
      id: "provider",
      label: "Call selected model",
      detail: "Skipped in browser preview so no prompt is sent anywhere.",
      status: "skipped",
      startedAt: createdAt,
      completedAt: createdAt
    },
    {
      id: "verify",
      label: isFrontend ? "Run Testing Orchestration Pipeline" : "Run Verification Pipeline",
      detail: "The desktop app will connect this to browser checks, tests, screenshots, and file diffs.",
      status: "skipped",
      startedAt: createdAt,
      completedAt: createdAt
    }
  ];
  return {
    id: `preview-${Date.now()}`,
    createdAt,
    completedAt: createdAt,
    promptSha256: "preview",
    promptPreview: prompt.slice(0, 180),
    rawPromptStored: false,
    pipelineName,
    decision: {
      source: "sample",
      decision: {
        ...samplePreviewDecision,
        task_type: isFrontend ? "frontend_design" : "general_chat",
        reason: "Browser preview cannot access Electron runtime APIs. The desktop app will route this through Metis Policy."
      },
      warnings: ["Electron runtime APIs are unavailable in browser preview."]
    },
    steps,
    assistantText: isFrontend
      ? "Your front end route is ready in the desktop runtime. Once project tools are enabled, Metis will create the files, start the preview, run checks, and return the localhost URL."
      : "Your route is ready in the desktop runtime. Once providers and project tools are enabled, Metis will run the selected model and attach the result here.",
    warnings: ["Electron runtime APIs are unavailable in browser preview."]
  };
}

const samplePreviewDecision: PolicyDecisionResult["decision"] = {
  schema_version: "0.1.0",
  policy_version: "0.1.0",
  created_at: "2026-06-29T00:00:00.000Z",
  task_type: "general_chat",
  prompt_profile: {
    estimated_tokens: 0,
    signals: [],
    raw_prompt_stored: false,
    prompt_sha256: "preview"
  },
  router_preset: "balanced",
  selected_route: {
    kind: "router",
    preset: "balanced",
    availability: "available"
  },
  confidence: 0,
  fallback_routes: [],
  reason: "Browser preview cannot access Electron runtime APIs. The desktop app will route this through Metis Policy.",
  evidence: [],
  scores: [],
  warnings: [],
  reproducibility: {
    ruleset_version: "preview",
    deterministic: true,
    profile_id: "preview"
  }
};

type Interaction =
  | { type: "pan"; startClient: Vec; startPan: Vec }
  | { type: "node"; id: string; offset: Vec; isSkill: boolean; moved: boolean }
  | null;

/** Migrates a single persisted node's legacy `accessVia` pin onto the new
 *  `gateway` field (docs/FABLE_PLANS.md section 25 update) — old graphs saved
 *  before the Gateway/Gateway fallbacks rework only have `accessVia`; new
 *  graphs write `gateway` directly. `accessVia` is left in place afterward
 *  (harmless, unread elsewhere) rather than deleted, so a downgrade to an
 *  older build wouldn't silently lose the pin. */
function migrateNodeGateway(node: GraphNode): GraphNode {
  if (node.gateway === undefined && node.accessVia !== undefined) {
    return { ...node, gateway: node.accessVia };
  }
  return node;
}

function loadNodes(): GraphNode[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { nodes?: GraphNode[] };
      if (parsed.nodes?.length) return parsed.nodes.map(migrateNodeGateway);
    }
  } catch {
    /* ignore malformed cache */
  }
  return SEED_NODES;
}

/** Regexes used to guess a sensible pipeline ORDER from an agent node's intent
 *  and label (docs/FABLE_PLANS.md section 25) — planning-ish nodes run first,
 *  frontend-ish nodes next, everything else after, in original relative order
 *  within each bucket. Best-effort only: a graph with no matching nodes just
 *  keeps its original node order. */
const PLAN_INTENT_PATTERN = /\b(plan|architect)/i;
const FRONTEND_INTENT_PATTERN = /\b(front|ui|design)/i;

function graphNodeOrderRank(node: GraphNode): number {
  const text = `${node.intent ?? ""} ${node.label ?? ""}`;
  if (PLAN_INTENT_PATTERN.test(text)) return 0;
  if (FRONTEND_INTENT_PATTERN.test(text)) return 1;
  return 2;
}

/** Projects the live graph's agent nodes into the compact pipeline config
 *  main.ts reads from the "graphPipeline" store key (docs/FABLE_PLANS.md
 *  section 25) — the graph persists to localStorage, which the main process
 *  cannot read, so this is the bridge. Nodes with no assigned provider/model,
 *  or whose provider doesn't map to a known ProviderKey, are dropped silently
 *  (fail-soft — main.ts's own validity check requires >=2 usable stages
 *  anyway). Ordered planning-ish first, frontend-ish second, everything else
 *  after (stable within each bucket). */
function projectGraphPipeline(nodes: GraphNode[]): GraphPipelineConfig {
  const agentNodes = nodes.filter((node) => node.kind === "agent" || node.kind === "router");
  const ordered = agentNodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const rankDiff = graphNodeOrderRank(a.node) - graphNodeOrderRank(b.node);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.node);

  const stages: GraphPipelineStage[] = [];
  for (const node of ordered) {
    if (!node.provider || !node.model?.trim()) continue;
    const providerKey = PROVIDER_CONNECTIONS[node.provider];
    if (!providerKey) continue;
    const fallback = (node.fallbacks ?? [])
      .filter((ref) => ref.model?.trim() && PROVIDER_CONNECTIONS[ref.provider])
      .map((ref) => ({ provider: PROVIDER_CONNECTIONS[ref.provider], model: ref.model }));
    const gatewayKey = node.gateway ? PROVIDER_CONNECTIONS[node.gateway] : undefined;
    const gatewayFallbackKeys = (node.gatewayFallbacks ?? [])
      .map((brand) => PROVIDER_CONNECTIONS[brand])
      .filter((key): key is ProviderKey => Boolean(key));
    stages.push({
      id: node.id,
      label: node.label,
      provider: providerKey,
      model: node.model,
      // `accessVia` kept populated with the same value for back-compat with
      // older main.ts builds/consumers that only read the single pin.
      accessVia: gatewayKey,
      gateway: gatewayKey,
      gatewayFallbacks: gatewayFallbackKeys.length > 0 ? gatewayFallbackKeys : undefined,
      fallback
    });
  }
  return { updatedAt: new Date().toISOString(), stages };
}

function GraphWorkspace({ activeNav, gallerySkills, galleryVisuals }: { activeNav: NavKey; gallerySkills: string[]; galleryVisuals: Record<string, GalleryVisual> }): JSX.Element {
  const [nodes, setNodes] = useState<GraphNode[]>(loadNodes);
  const [installedSkills, setInstalledSkills] = useState<RegistryPackage[]>([]);
  const [customSkills, setCustomSkills] = useAppStoreState("customSkills", EMPTY_CUSTOM_SKILLS);
  const [pan, setPan] = useState<Vec>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [interaction, setInteraction] = useState<Interaction>(null);
  const [drag, setDrag] = useState<GhostDrag | null>(null);
  const [overTarget, setOverTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pulse, setPulse] = useState<{ agentId: string; key: number } | null>(null);
  const [routeTest, setRouteTest] = useState<RouteTestState | null>(null);
  const [connectionStates, setConnectionStates] = useState<Partial<Record<ProviderKey, ProviderConnectionState>>>({ ollama: "local" });
  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(false);
  // Real Run Test results (docs/FABLE_PLANS.md section 18) — a real policy decision plus a
  // per-agent-node health row, shown in a slim popover anchored to the toolbar Run test button.
  // Folds in what used to be the titlebar "Check everything" health sweep (now removed).
  const [runTestOpen, setRunTestOpen] = useState(false);
  const [runTestLoading, setRunTestLoading] = useState(false);
  const [runTestResult, setRunTestResult] = useState<RunTestResult | null>(null);
  const [hasSavedPreset, setHasSavedPreset] = useState(() => {
    try {
      return Boolean(localStorage.getItem(PRESET_STORAGE_KEY));
    } catch {
      return false;
    }
  });

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const lineRef = useRef<SVGLineElement | null>(null);
  const pointerRef = useRef<Vec>({ x: 0, y: 0 });
  const ghostPosRef = useRef<Vec>({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const idSeq = useRef(0);

  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const nodesRef = useRef(nodes);
  const dragRef = useRef(drag);
  const overRef = useRef(overTarget);
  const selectedRef = useRef(selected);
  panRef.current = pan;
  zoomRef.current = zoom;
  nodesRef.current = nodes;
  dragRef.current = drag;
  overRef.current = overTarget;
  selectedRef.current = selected;

  const nextId = useCallback((prefix: string) => `${prefix}-${Date.now().toString(36)}-${idSeq.current++}`, []);
  const posOf = useCallback((id: string): Vec => nodesRef.current.find((n) => n.id === id)?.pos ?? { x: 0, y: 0 }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes }));
    } catch {
      /* storage may be unavailable */
    }
  }, [nodes]);

  // Graph -> app-store pipeline projection (docs/FABLE_PLANS.md section 25):
  // the build pipeline in main.ts can't read the graph's localStorage, so
  // whenever the agent nodes change, project a compact pipeline config and
  // push it through the app-store bridge. Debounced (~1s) so dragging a node
  // around doesn't spam writes; skipped entirely in browser preview, where
  // window.metisStore doesn't exist.
  useEffect(() => {
    if (!window.metisStore) return;
    const handle = window.setTimeout(() => {
      const config = projectGraphPipeline(nodesRef.current);
      void window.metisStore?.set("graphPipeline", config);
    }, 1000);
    return () => window.clearTimeout(handle);
  }, [nodes]);

  // Marketplace-installed skill packages, merged into the Skills palette (docs/FABLE_PLANS.md
  // section 18): "Installed skills -> Library". The graph itself only ever stores skill node
  // labels (see the `payload.kind === "skill"` branch below), so surfacing these here is enough
  // for them to be attachable exactly like the built-ins — no further plumbing needed this pass.
  useEffect(() => {
    if (!window.metisRegistry) return;
    void window.metisRegistry
      .listInstalled()
      .then((packages) => setInstalledSkills(packages.filter((pkg) => pkg.kind === "skill")))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    async function loadConnections(): Promise<void> {
      if (!window.metisSecrets) return;
      const secrets = await window.metisSecrets.list();
      if (!alive) return;
      const next: Partial<Record<ProviderKey, ProviderConnectionState>> = { ollama: "local" };
      for (const secret of secrets) {
        next[secret.provider] = secret.provider === "ollama" ? "local" : secret.hasSecret ? "connected" : "missing";
      }
      setConnectionStates(next);
    }
    void loadConnections();
    return () => {
      alive = false;
    };
  }, []);

  const fitTo = useCallback((list: GraphNode[]) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || list.length === 0) return;
    const margin = 120;
    const footprint = 78;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of list) {
      minX = Math.min(minX, node.pos.x - footprint);
      minY = Math.min(minY, node.pos.y - footprint);
      maxX = Math.max(maxX, node.pos.x + footprint);
      maxY = Math.max(maxY, node.pos.y + footprint);
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((rect.width - margin * 2) / spanX, (rect.height - margin * 2) / spanY)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setZoom(nextZoom);
    setPan({ x: rect.width / 2 - cx * nextZoom, y: rect.height / 2 - cy * nextZoom });
  }, []);

  useLayoutEffect(() => {
    fitTo(nodesRef.current);
  }, [fitTo]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function onWheel(event: WheelEvent): void {
      event.preventDefault();
      const rect = el!.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      setZoom((prevZoom) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prevZoom * Math.exp(-event.deltaY * 0.0012)));
        setPan((prevPan) => ({ x: cx - ((cx - prevPan.x) / prevZoom) * next, y: cy - ((cy - prevPan.y) / prevZoom) * next }));
        return next;
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function toWorld(clientX: number, clientY: number): Vec {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - panRef.current.x) / zoomRef.current, y: (clientY - rect.top - panRef.current.y) / zoomRef.current };
  }

  // ----- Canvas pan + node repositioning (router / agent / skill) -----

  function beginPan(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    canvasRef.current?.setPointerCapture(event.pointerId);
    setInteraction({ type: "pan", startClient: { x: event.clientX, y: event.clientY }, startPan: pan });
  }

  function onNodePointerDown(event: ReactPointerEvent<HTMLElement>, node: GraphNode): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    setSelected(node.id);
    canvasRef.current?.setPointerCapture(event.pointerId);
    const world = toWorld(event.clientX, event.clientY);
    setInteraction({ type: "node", id: node.id, offset: { x: world.x - node.pos.x, y: world.y - node.pos.y }, isSkill: node.kind === "skill", moved: false });
  }

  function onCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!interaction) return;
    if (interaction.type === "pan") {
      setPan({ x: interaction.startPan.x + (event.clientX - interaction.startClient.x), y: interaction.startPan.y + (event.clientY - interaction.startClient.y) });
      return;
    }
    const world = toWorld(event.clientX, event.clientY);
    const nextPos = { x: world.x - interaction.offset.x, y: world.y - interaction.offset.y };
    setNodes((current) => current.map((node) => (node.id === interaction.id ? { ...node, pos: nextPos } : node)));
    if (!interaction.moved) setInteraction({ ...interaction, moved: true });
    if (interaction.isSkill) setOverTarget(nearestSkillTarget(nextPos, interaction.id));
  }

  function endCanvasPointer(event: ReactPointerEvent<HTMLDivElement>): void {
    if (interaction?.type === "node" && interaction.isSkill && interaction.moved && overTarget) {
      attachSkillToAgent(interaction.id, overTarget);
    }
    setOverTarget(null);
    setInteraction(null);
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId);
  }

  function nearestSkillTarget(pos: Vec, skipId?: string): string | null {
    const isExistingSkill = Boolean(skipId && nodesRef.current.some((node) => node.id === skipId && node.kind === "skill"));
    const nodeRadius = (isExistingSkill ? EXISTING_SKILL_TARGET_RADIUS : TARGET_RADIUS) / zoomRef.current;
    const routeRadius = (isExistingSkill ? EXISTING_SKILL_ROUTE_RADIUS : ROUTE_TARGET_RADIUS) / zoomRef.current;
    const router = nodesRef.current.find((node) => node.kind === "router");
    const currentAgentId = skipId ? attachedAgentForSkill(skipId) : null;
    let best: string | null = null;
    let bestDist = Infinity;
    let currentDist = Infinity;
    for (const node of nodesRef.current) {
      if (node.kind !== "agent" || node.id === skipId) continue;
      let dist = Math.hypot(node.pos.x - pos.x, node.pos.y - pos.y);
      let threshold = nodeRadius;
      if (router) {
        const skillIds = (node.skills ?? []).filter((id) => id !== skipId);
        for (const segment of routeSegments(router.pos, node, skillIds, posOf)) {
          const routeDist = distancePointToSegment(pos, segment.from, segment.to);
          if (routeDist < dist) {
            dist = routeDist;
            threshold = routeRadius;
          }
        }
      }
      if (node.id === currentAgentId) currentDist = dist;
      if (dist < threshold && dist < bestDist) {
        bestDist = dist;
        best = node.id;
      }
    }
    if (isExistingSkill && currentAgentId && best && best !== currentAgentId && currentDist < Infinity && bestDist > currentDist * 0.55) {
      return currentAgentId;
    }
    return best;
  }

  function attachedAgentForSkill(skillId: string): string | null {
    return nodesRef.current.find((node) => node.kind === "agent" && node.skills?.includes(skillId))?.id ?? null;
  }

  function attachSkillToAgent(skillId: string, agentId: string): void {
    setNodes((list) =>
      list.map((node) => {
        if (node.kind !== "agent") return node;
        const without = (node.skills ?? []).filter((id) => id !== skillId);
        if (node.id === agentId) return { ...node, skills: [...without, skillId] };
        return without.length === (node.skills ?? []).length ? node : { ...node, skills: without };
      })
    );
  }

  // ----- Ghost drag from the palette (wobble physics) -----

  const findGhostTarget = useCallback((clientX: number, clientY: number): string | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const payload = dragRef.current?.payload;
    if (!rect || !payload) return null;
    const wx = (clientX - rect.left - panRef.current.x) / zoomRef.current;
    const wy = (clientY - rect.top - panRef.current.y) / zoomRef.current;
    if (payload.kind === "skill") return nearestSkillTarget({ x: wx, y: wy });
    const radius = TARGET_RADIUS / zoomRef.current;
    let best: string | null = null;
    let bestDist = radius;
    for (const node of nodesRef.current) {
      if (node.kind !== "agent" && node.kind !== "router") continue;
      const dist = Math.hypot(node.pos.x - wx, node.pos.y - wy);
      if (dist < bestDist) {
        bestDist = dist;
        best = node.id;
      }
    }
    return best;
  }, []);

  const ghostFrame = useCallback(() => {
    const pointer = pointerRef.current;
    const ghost = ghostPosRef.current;
    ghost.x += (pointer.x - ghost.x) * GHOST_FOLLOW;
    ghost.y += (pointer.y - ghost.y) * GHOST_FOLLOW;
    const lagX = pointer.x - ghost.x;
    const tilt = prefersReducedMotion ? 0 : Math.max(-MAX_TILT, Math.min(MAX_TILT, lagX * 0.45));
    if (ghostRef.current) {
      ghostRef.current.style.transform = `translate(${ghost.x}px, ${ghost.y}px) translate(-50%, -50%) scale(${zoomRef.current}) rotate(${tilt}deg)`;
    }
    if (lineRef.current) {
      const over = overRef.current;
      const payload = dragRef.current?.payload;
      const rect = canvasRef.current?.getBoundingClientRect();
      const target = over ? nodesRef.current.find((node) => node.id === over) : null;
      if (over && target && rect && payload?.kind === "skill") {
        lineRef.current.setAttribute("opacity", "1");
        lineRef.current.setAttribute("x1", String(ghost.x));
        lineRef.current.setAttribute("y1", String(ghost.y));
        lineRef.current.setAttribute("x2", String(rect.left + panRef.current.x + target.pos.x * zoomRef.current));
        lineRef.current.setAttribute("y2", String(rect.top + panRef.current.y + target.pos.y * zoomRef.current));
      } else {
        lineRef.current.setAttribute("opacity", "0");
      }
    }
    rafRef.current = requestAnimationFrame(ghostFrame);
  }, []);

  const onGhostMove = useCallback(
    (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      const next = findGhostTarget(event.clientX, event.clientY);
      if (next !== overRef.current) setOverTarget(next);
    },
    [findGhostTarget]
  );

  const finishGhostDrag = useCallback((): void => {
    window.removeEventListener("pointermove", onGhostMove);
    window.removeEventListener("pointerup", finishGhostDrag);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    const current = dragRef.current;
    const pointer = pointerRef.current;
    const over = overRef.current ?? findGhostTarget(pointer.x, pointer.y);
    const dropElement = document.elementFromPoint(pointer.x, pointer.y);
    const cancelledIntoLibrary = Boolean(dropElement?.closest(".side-panel-shell, .palette, .utility-panel, .panel-rail-toggle"));
    const inspectorDrop = Boolean(dropElement?.closest(".palette.inspector"));
    if (current) {
      const { payload } = current;
      const inspectorTarget = inspectorDrop ? selectedRef.current : null;
      if (payload.kind === "model" && inspectorTarget) {
        setNodes((list) => list.map((node) => (node.id === inspectorTarget && node.kind !== "skill" ? { ...node, provider: payload.provider, model: payload.model } : node)));
        setSelected(inspectorTarget);
      } else if (cancelledIntoLibrary) {
        /* The user dragged it back to the library, so treat this as cancel. */
      } else if (payload.kind === "model" && over) {
        setNodes((list) => list.map((node) => (node.id === over ? { ...node, provider: payload.provider, model: payload.model } : node)));
        setSelected(over);
      } else if (payload.kind === "model") {
        const world = toWorld(pointer.x, pointer.y);
        const agentId = nextId("agent");
        setNodes((list) => [
          ...list,
          {
            id: agentId,
            kind: "agent",
            label: payload.model,
            pos: world,
            provider: payload.provider,
            model: payload.model,
            intent: "new route",
            temperature: 0.4,
            skills: []
          }
        ]);
        setSelected(agentId);
      } else if (payload.kind === "skill") {
        const world = toWorld(pointer.x, pointer.y);
        const skillId = nextId("skill");
        setNodes((list) => {
          const next = [...list, { id: skillId, kind: "skill" as const, label: payload.name, pos: world }];
          if (!over) return next;
          return next.map((node) =>
            node.kind === "agent" && node.id === over ? { ...node, skills: [...(node.skills ?? []), skillId] } : node
          );
        });
      }
    }
    setDrag(null);
    setOverTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findGhostTarget, nextId, onGhostMove]);

  function startGhostDrag(clientX: number, clientY: number, payload: DragPayload): void {
    pointerRef.current = { x: clientX, y: clientY };
    ghostPosRef.current = { x: clientX, y: clientY };
    setDrag({ payload });
    setOverTarget(findGhostTarget(clientX, clientY));
    window.addEventListener("pointermove", onGhostMove);
    window.addEventListener("pointerup", finishGhostDrag);
    rafRef.current = requestAnimationFrame(ghostFrame);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onGhostMove);
      window.removeEventListener("pointerup", finishGhostDrag);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [onGhostMove, finishGhostDrag]);

  // ----- Node mutations (inspector) -----

  const updateNode = useCallback((id: string, patch: Partial<GraphNode>) => {
    setNodes((list) => list.map((node) => (node.id === id ? { ...node, ...patch } : node)));
  }, []);

  function removeNode(id: string): void {
    setNodes((list) =>
      list.filter((node) => node.id !== id).map((node) => (node.kind === "agent" && node.skills ? { ...node, skills: node.skills.filter((s) => s !== id) } : node))
    );
    setSelected((current) => (current === id ? null : current));
  }

  function detachSkill(skillId: string): void {
    setNodes((list) => list.map((node) => (node.kind === "agent" && node.skills?.includes(skillId) ? { ...node, skills: node.skills.filter((s) => s !== skillId) } : node)));
  }

  function applyPreset(key: PresetKey): void {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setNodes((list) =>
      list.map((node) => {
        if (node.kind === "router") return { ...node, provider: preset.router.provider, model: preset.router.model };
        if (node.kind === "agent") {
          const ref = preset.pick((node.intent ?? node.label).toLowerCase());
          return { ...node, provider: ref.provider, model: ref.model };
        }
        return node;
      })
    );
  }

  function savePreset(): void {
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify({ nodes: nodesRef.current, saved_at: new Date().toISOString() }));
      setHasSavedPreset(true);
    } catch {
      /* storage may be unavailable */
    }
  }

  function loadPreset(): void {
    try {
      const raw = localStorage.getItem(PRESET_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { nodes?: GraphNode[] };
      if (!parsed.nodes?.length) return;
      setNodes(parsed.nodes);
      setSelected(null);
      fitTo(parsed.nodes);
    } catch {
      /* ignore malformed presets */
    }
  }

  function runTest(agentId: string): void {
    const agent = nodesRef.current.find((node) => node.id === agentId);
    const status = agent?.provider ? providerConnectionStatus(agent.provider, connectionStates) : "unknown";
    setPulse({ agentId, key: Date.now() });
    setSelected(agentId);
    if (status !== "local" && status !== "connected") {
      setRouteTest({
        agentId,
        status: "error",
        startedAt: Date.now(),
        completedAt: Date.now(),
        message: "Provider API key is not connected. Add it in Settings before testing this route."
      });
      window.setTimeout(() => setPulse((current) => (current?.agentId === agentId ? null : current)), 900);
      return;
    }
    setRouteTest({ agentId, status: "running", startedAt: Date.now() });
    window.setTimeout(() => setPulse((current) => (current?.agentId === agentId ? null : current)), 2000);
    window.setTimeout(() => setRouteTest((current) => (current?.agentId === agentId ? { ...current, status: "complete", completedAt: Date.now() } : current)), 1900);
  }

  /** Real Run Test (docs/FABLE_PLANS.md section 18): keeps the visual packet pulse on whichever
   *  agent is selected, but also fires an actual policy decision plus a health check per agent
   *  node's provider — replacing the titlebar "Check everything" sweep. Every bridge is guarded
   *  for browser preview, where the rows read "unavailable in preview". */
  async function runRealTest(): Promise<void> {
    setRunTestOpen(true);
    setRunTestLoading(true);
    const currentAgents = nodesRef.current.filter((node) => node.kind === "agent");
    // Seed the panel with pending rows so results fill in progressively.
    const pendingRows: RunTestAgentRow[] = currentAgents.map((node) => ({
      id: node.id,
      name: node.label,
      model: node.provider ? `${PROVIDERS[node.provider].label} / ${node.model ?? "auto"}` : "No model assigned",
      status: "unavailable",
      detail: "Testing…"
    }));
    setRunTestResult({
      routeLabel: `Testing ${currentAgents.length} route${currentAgents.length === 1 ? "" : "s"}…`,
      routeDetail: "Each node gets a policy decision for its route intent plus a provider health check.",
      routeStatus: "ok",
      agents: pendingRows
    });
    try {
      const providerList = window.metisProviders ? await window.metisProviders.list().catch(() => []) : [];
      let okCount = 0;
      // Sequential on purpose: the packet pulse animates the node under test while
      // its policy decision + health check run, so every route visibly gets tested.
      for (const node of currentAgents) {
        runTest(node.id);
        let row: RunTestAgentRow;
        const model = node.provider ? `${PROVIDERS[node.provider].label} / ${node.model ?? "auto"}` : "No model assigned";
        if (!node.provider) {
          row = { id: node.id, name: node.label, model, status: "warn", detail: "No provider configured for this node." };
        } else if (!window.metisProviders) {
          row = { id: node.id, name: node.label, model, status: "unavailable", detail: "unavailable in preview" };
        } else {
          const key = PROVIDER_CONNECTIONS[node.provider];
          const known = providerList.find((p) => p.provider === key);
          try {
            const [decision, health] = await Promise.all([
              window.metisPolicy
                ? window.metisPolicy.decide({ prompt: `Route test: ${node.intent ?? node.label}` }).catch(() => null)
                : Promise.resolve(null),
              known ? window.metisProviders.healthCheck(key) : Promise.resolve(undefined)
            ]);
            const status = health?.status ?? known?.status;
            const policyPick = decision
              ? decision.decision.selected_route.model ?? decision.decision.selected_route.provider ?? decision.decision.selected_route.kind
              : null;
            const rowStatus: HealthRowStatus =
              status === "available" ? "ok" : status === "not_configured" ? "warn" : status ? "error" : "unavailable";
            if (rowStatus === "ok") okCount += 1;
            row = {
              id: node.id,
              name: node.label,
              model,
              status: rowStatus,
              detail: `${policyPick ? `Policy picks ${policyPick} for "${node.intent ?? node.label}". ` : ""}${health?.detail ?? known?.detail ?? "Provider not found."}`
            };
          } catch (error) {
            row = { id: node.id, name: node.label, model, status: "error", detail: error instanceof Error ? error.message : String(error) };
          }
        }
        setRunTestResult((current) =>
          current ? { ...current, agents: current.agents.map((entry) => (entry.id === row.id ? row : entry)) } : current
        );
        // Let the pulse be seen before moving to the next node.
        await new Promise((resolve) => window.setTimeout(resolve, 650));
      }
      setRunTestResult((current) =>
        current
          ? {
              ...current,
              routeLabel: `Tested ${currentAgents.length} route${currentAgents.length === 1 ? "" : "s"} — ${okCount} healthy`,
              routeDetail: "Per-node policy decision for each route intent + provider health.",
              routeStatus: okCount === currentAgents.length ? "ok" : okCount > 0 ? "warn" : "error"
            }
          : current
      );
    } finally {
      setRunTestLoading(false);
    }
  }

  function zoomBy(factor: number): void {
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 0;
    const cy = rect ? rect.height / 2 : 0;
    setZoom((prevZoom) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prevZoom * factor));
      setPan((prevPan) => ({ x: cx - ((cx - prevPan.x) / prevZoom) * next, y: cy - ((cy - prevPan.y) / prevZoom) * next }));
      return next;
    });
  }

  function resetGraph(): void {
    setNodes(SEED_NODES);
    setSelected(null);
    fitTo(SEED_NODES);
  }

  const agents = nodes.filter((node) => node.kind === "agent");
  const routerNode = nodes.find((node) => node.kind === "router");
  const selectedNode = nodes.find((node) => node.id === selected) ?? null;
  const gridSize = 42 * zoom;

  type EdgeSeg = { id: string; d: string; active: boolean };
  const edges: EdgeSeg[] = [];
  const intentPills: { id: string; pos: Vec; text: string; agentId: string; active: boolean }[] = [];
  if (routerNode) {
    for (const agent of agents) {
      const active = selected === agent.id || selected === routerNode.id || (agent.skills ?? []).includes(selected ?? "");
      const skillIds = agent.skills ?? [];
      routeSegments(routerNode.pos, agent, skillIds, posOf).forEach((segment, index) => {
        edges.push({ id: `${agent.id}-route-${index}`, d: curve(segment.from, segment.to), active });
      });
      if (agent.intent) {
        intentPills.push({ id: `intent-${agent.id}`, pos: lerp(routerNode.pos, agent.pos, 0.4), text: agent.intent, agentId: agent.id, active });
      }
    }
  }
  const pulseAgent = pulse ? nodes.find((n) => n.id === pulse.agentId) : null;
  const pulsePath = pulse && routerNode && pulseAgent ? curve(routerNode.pos, pulseAgent.pos) : "";
  // Packet that travels the route while a test run is in flight. It rides the
  // actual drawn route segments (router -> skills -> agent), not a straight
  // center-to-center line, so it visibly follows the path.
  const packetAgent = routeTest && routeTest.status !== "error" ? nodes.find((n) => n.id === routeTest.agentId) : null;
  const packetPath = packetAgent
    ? edges
        .filter((edge) => edge.id.startsWith(`${packetAgent.id}-route-`))
        .map((edge) => edge.d)
        .join(" ")
    : "";
  const packetRunning = routeTest?.status === "running";
  const sidePanel = selectedNode ? (
    <NodeInspector
      node={selectedNode}
      nodes={nodes}
      onClose={() => setSelected(null)}
      onUpdate={updateNode}
      onDelete={removeNode}
      onDetachSkill={detachSkill}
      connectionStates={connectionStates}
      routeTest={routeTest?.agentId === selectedNode.id ? routeTest : null}
      onTest={runTest}
    />
  ) : activeNav === "routines" ? (
    <RoutinesPanel />
  ) : (
    <Palette
      customSkills={customSkills}
      gallerySkills={gallerySkills}
      galleryVisuals={galleryVisuals}
      hasSavedPreset={hasSavedPreset}
      installedSkills={installedSkills}
      onAddCustomSkill={(skill) => setCustomSkills((current) => [...current, skill])}
      onLoadPreset={loadPreset}
      onPick={startGhostDrag}
      onPreset={applyPreset}
      onSavePreset={savePreset}
    />
  );

  return (
    <main className={`graph-workspace ${sidePanelCollapsed ? "panel-collapsed" : ""}`} aria-label="Router pipeline graph">
      <div
        className={`graph-canvas ${interaction?.type === "pan" ? "panning" : ""} ${drag ? "dragging-item" : ""}`}
        ref={canvasRef}
        onPointerDown={beginPan}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={endCanvasPointer}
        onPointerCancel={endCanvasPointer}
        style={{ backgroundPosition: `${pan.x}px ${pan.y}px`, backgroundSize: `${gridSize}px ${gridSize}px` }}
      >
        <div className="graph-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <svg className="graph-edges" width="1" height="1" aria-hidden="true">
            {edges.map((edge) => (
              <g key={edge.id}>
                <path className={`edge route-edge ${edge.active ? "active" : ""}`} d={edge.d} vectorEffect="non-scaling-stroke" />
                {!prefersReducedMotion ? <path className={`edge route-flow ${edge.active ? "active" : ""}`} d={edge.d} vectorEffect="non-scaling-stroke" /> : null}
              </g>
            ))}
            {packetPath && packetRunning && !prefersReducedMotion ? (
              // key by the run's start time so each Run Test remounts + restarts the SMIL motion.
              <g className="route-packet running" key={routeTest?.startedAt}>
                <rect className="packet-trail" x="-11" y="-5" width="22" height="10" rx="5">
                  <animateMotion dur="0.95s" path={packetPath} rotate="auto" repeatCount="indefinite" />
                </rect>
                <rect className="packet-body" x="-7" y="-4" width="14" height="8" rx="3">
                  <animateMotion dur="0.95s" path={packetPath} rotate="auto" repeatCount="indefinite" />
                </rect>
              </g>
            ) : pulse && pulsePath ? (
              <circle key={pulse.key} className="route-pulse" r="7">
                <animateMotion dur="1.2s" path={pulsePath} fill="freeze" />
              </circle>
            ) : null}
          </svg>

          {intentPills.map((pill) => (
            <button
              key={pill.id}
              className={`route-pill ${pill.active ? "active" : ""}`}
              type="button"
              style={{ left: `${pill.pos.x}px`, top: `${pill.pos.y}px` }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setSelected(pill.agentId);
              }}
            >
              {pill.text}
            </button>
          ))}

          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selected={selected === node.id}
              targetMode={overTarget === node.id ? (drag?.payload.kind ?? (interaction?.type === "node" && interaction.isSkill ? "skill" : null)) : null}
              galleryVisual={node.kind === "skill" ? galleryVisuals[node.label] : undefined}
              onPointerDown={onNodePointerDown}
              onDelete={removeNode}
            />
          ))}
        </div>

        <div className="graph-toolbar" role="toolbar" aria-label="Canvas controls" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            <ZoomOut size={16} />
          </button>
          <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
            <ZoomIn size={16} />
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <button type="button" aria-label="Fit to view" onClick={() => fitTo(nodesRef.current)}>
            <Maximize2 size={15} />
          </button>
          <button type="button" aria-label="Reset pipeline" onClick={resetGraph}>
            <RotateCcw size={15} />
          </button>
          <div className="run-test-anchor">
            <button
              type="button"
              className="toolbar-run"
              aria-label="Run test"
              aria-expanded={runTestOpen}
              disabled={agents.length === 0}
              onClick={() => void runRealTest()}
            >
              <Play size={14} />
              <span>Run test</span>
            </button>
            {runTestOpen ? (
              <>
                <button className="run-test-backdrop" type="button" aria-label="Close run test results" onClick={() => setRunTestOpen(false)} />
                <RunTestPanel loading={runTestLoading} result={runTestResult} onClose={() => setRunTestOpen(false)} onRerun={() => void runRealTest()} />
              </>
            ) : null}
          </div>
        </div>

        <p className="graph-hint">Drag to pan - scroll to zoom - click a node to inspect it - drag skills and models from Library</p>
      </div>

      {sidePanelCollapsed ? (
        <button className="panel-rail-toggle" type="button" onClick={() => setSidePanelCollapsed(false)}>
          <ChevronLeft size={16} />
          <span>Library</span>
        </button>
      ) : (
        <div className="side-panel-shell">
          <button className="panel-collapse-toggle" type="button" aria-label="Collapse library panel" onClick={() => setSidePanelCollapsed(true)}>
            <ChevronRight size={16} />
          </button>
          {sidePanel}
        </div>
      )}

      {drag ? (
        <div className="drag-layer" aria-hidden="true">
          <svg className="drag-overlay">
            <line ref={lineRef} className="pending-line" opacity="0" />
          </svg>
          <div className="drag-ghost" ref={ghostRef}>
            {drag.payload.kind === "model" ? (
              <>
                <span className="node-icon logo">
                  <img alt="" src={PROVIDERS[drag.payload.provider].logo} />
                </span>
                <span className="node-caption">
                  <strong>{PROVIDERS[drag.payload.provider].label}</strong>
                  <small>{drag.payload.model}</small>
                </span>
              </>
            ) : (
              <>
                <span className={`node-icon skill${galleryVisuals[drag.payload.name] ? " gallery" : ""}`}>
                  {galleryVisuals[drag.payload.name] ? <GalleryHorizontalEnd size={24} strokeWidth={1.8} /> : <ClipboardList size={24} strokeWidth={1.8} />}
                </span>
                <span className="node-caption">
                  <strong>{drag.payload.name}</strong>
                  <small>{galleryVisuals[drag.payload.name] ? "Board · loads first" : "Skill · loads first"}</small>
                  {galleryVisuals[drag.payload.name]?.palette.length ? (
                    <span className="node-palette-strip" aria-hidden="true">
                      {galleryVisuals[drag.payload.name].palette.slice(0, 5).map((hex, index) => (
                        <span key={`${hex}-${index}`} className="node-palette-swatch" style={{ background: hex }} />
                      ))}
                    </span>
                  ) : null}
                </span>
              </>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function NodeCard({
  node,
  selected,
  targetMode,
  galleryVisual,
  onPointerDown,
  onDelete
}: {
  node: GraphNode;
  selected: boolean;
  targetMode: DragPayload["kind"] | null;
  /** When this skill node matches a gallery board (by its `Gallery: <title>` label), its cover
   *  thumbnail + aggregated palette swatches — so the node renders as a moodboard step in the
   *  pipeline (owner idea "Gallery model-visualisation inside orchestration") instead of a plain
   *  skill. Undefined for every non-gallery node. */
  galleryVisual?: GalleryVisual;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, node: GraphNode) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  const provider = node.provider ? PROVIDERS[node.provider] : null;
  const isMoodboard = node.kind === "skill" && Boolean(galleryVisual);
  const sublabel = node.kind === "skill" ? (isMoodboard ? "Board · loads first" : "Skill · loads first") : `${provider?.label ?? "Unassigned"}${node.model ? ` · ${node.model}` : ""}`;
  const fallbacks = node.fallbacks ?? [];
  const palette = galleryVisual?.palette ?? [];

  return (
    <article
      aria-label={`${node.label} ${sublabel}`}
      className={["graph-node", `${node.kind}-node`, isMoodboard ? "moodboard-node" : "", selected ? "selected" : "", targetMode === "model" ? "target-model" : "", targetMode === "skill" ? "target-skill" : ""]
        .filter(Boolean)
        .join(" ")}
      role="button"
      tabIndex={0}
      style={{ left: `${node.pos.x}px`, top: `${node.pos.y}px` }}
      onPointerDown={(event) => onPointerDown(event, node)}
    >
      <span className={`${node.kind === "skill" ? "node-icon skill" : "node-icon logo"}${isMoodboard ? " gallery" : ""}`}>
        {node.kind !== "router" ? (
          <button
            className="node-delete"
            type="button"
            aria-label={`Remove ${node.label}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(node.id);
            }}
          >
            <X size={12} />
          </button>
        ) : null}
        {node.kind === "router" ? <span className="node-tag">ROUTER</span> : null}
        {provider?.tier === "local" && node.kind !== "skill" ? <span className="node-pill">local</span> : null}
        {isMoodboard ? (
          <GalleryHorizontalEnd size={24} strokeWidth={1.8} />
        ) : node.kind === "skill" ? (
          <ClipboardList size={24} strokeWidth={1.8} />
        ) : (
          <img alt="" src={provider?.logo ?? PROVIDERS.qwen.logo} />
        )}
      </span>

      <span className="node-caption">
        <strong>{node.label}</strong>
        <small>{sublabel}</small>
        {isMoodboard && palette.length ? (
          <span className="node-palette-strip" aria-hidden="true">
            {palette.slice(0, 5).map((hex, index) => (
              <span key={`${hex}-${index}`} className="node-palette-swatch" style={{ background: hex }} />
            ))}
          </span>
        ) : null}
      </span>

      {fallbacks.length ? (
        <span className="node-fallbacks" aria-hidden="true">
          {fallbacks.slice(0, 3).map((ref, index) => (
            <span className="fallback-dot" key={`${ref.provider}-${ref.model}-${index}`} title={`${PROVIDERS[ref.provider].label} ${ref.model}`}>
              <img alt="" src={PROVIDERS[ref.provider].logo} />
            </span>
          ))}
          <em>fallback</em>
        </span>
      ) : null}
    </article>
  );
}

/** One entry in the merged Skills palette: built-ins (SKILL_LIBRARY + gallery), Marketplace-installed
 *  packages (kind "skill"), and user-authored custom skills all render the same way, distinguished
 *  only by a small chip (docs/FABLE_PLANS.md section 18, "Installed skills -> Library"). */
type PaletteSkill = { name: string; source: "builtin" | "installed" | "custom"; description?: string; gallery?: GalleryVisual };

function Palette({
  customSkills,
  gallerySkills,
  galleryVisuals,
  hasSavedPreset,
  installedSkills,
  onAddCustomSkill,
  onLoadPreset,
  onPick,
  onPreset,
  onSavePreset
}: {
  customSkills: CustomSkill[];
  gallerySkills: string[];
  galleryVisuals: Record<string, GalleryVisual>;
  hasSavedPreset: boolean;
  installedSkills: RegistryPackage[];
  onAddCustomSkill: (skill: CustomSkill) => void;
  onLoadPreset: () => void;
  onPick: (clientX: number, clientY: number, payload: DragPayload) => void;
  onPreset: (key: PresetKey) => void;
  onSavePreset: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<"skills" | "models" | "presets">("skills");
  const [query, setQuery] = useState("");
  const [addingSkill, setAddingSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDescription, setNewSkillDescription] = useState("");

  const skills = useMemo<PaletteSkill[]>(() => {
    const builtins = [...new Set([...SKILL_LIBRARY, ...gallerySkills])].map((name) => ({ name, source: "builtin" as const, gallery: galleryVisuals[name] }));
    const installed = installedSkills.map((pkg) => ({ name: pkg.name, source: "installed" as const, description: pkg.description }));
    const custom = customSkills.map((skill) => ({ name: skill.name, source: "custom" as const, description: skill.description }));
    const seen = new Set<string>();
    const merged: PaletteSkill[] = [];
    for (const entry of [...installed, ...custom, ...builtins]) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      merged.push(entry);
    }
    return merged.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()));
  }, [customSkills, gallerySkills, galleryVisuals, installedSkills, query]);
  // Gallery boards read as a distinct "Moodboards" group at the top of the Skills tab (owner idea:
  // model-visualisation inside orchestration) — a board carries a GalleryVisual; everything else is
  // a plain skill. Both drag via the same onPick skill path, so attach-to-agent is unchanged.
  const moodboardSkills = useMemo(() => skills.filter((entry) => Boolean(entry.gallery)), [skills]);
  const plainSkills = useMemo(() => skills.filter((entry) => !entry.gallery), [skills]);
  const models = useMemo(() => MODEL_LIBRARY.filter((entry) => `${PROVIDERS[entry.provider].label} ${entry.model}`.toLowerCase().includes(query.toLowerCase())), [query]);
  const showSearch = tab === "skills" || tab === "models";

  function pick(event: ReactPointerEvent<HTMLDivElement>, payload: DragPayload): void {
    if (event.button !== 0) return;
    event.preventDefault();
    onPick(event.clientX, event.clientY, payload);
  }

  function submitCustomSkill(): void {
    const name = newSkillName.trim();
    if (!name) return;
    onAddCustomSkill({ id: `custom-skill-${Date.now().toString(36)}`, name, description: newSkillDescription.trim() || undefined });
    setNewSkillName("");
    setNewSkillDescription("");
    setAddingSkill(false);
  }

  return (
    <aside className="palette" aria-label="Pipeline library">
      <header className="palette-head">
        <h2>Library</h2>
        <p>Drag onto the pipeline to wire it up</p>
      </header>

      <div className="palette-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "skills"} className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>
          <Layers size={15} /> Skills
        </button>
        <button type="button" role="tab" aria-selected={tab === "models"} className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>
          <Cpu size={15} /> Models
        </button>
        <button type="button" role="tab" aria-selected={tab === "presets"} className={tab === "presets" ? "active" : ""} onClick={() => setTab("presets")}>
          <Star size={15} /> Presets
        </button>
      </div>

      {showSearch ? (
        <label className="palette-search">
          <Search size={14} />
          <input type="text" value={query} placeholder={tab === "skills" ? "Search skills" : "Search models"} onChange={(event) => setQuery(event.target.value)} />
        </label>
      ) : null}

      <div className="palette-list">
        {tab === "skills"
          ? (
            <>
              {moodboardSkills.length ? (
                <div className="palette-group">
                  <span className="palette-subhead">
                    <GalleryHorizontalEnd size={12} strokeWidth={2} /> Boards
                  </span>
                  {moodboardSkills.map((entry) => (
                    <div
                      key={entry.name}
                      className="palette-item skill moodboard"
                      title={entry.description ?? entry.name}
                      onPointerDown={(event) => pick(event, { kind: "skill", name: entry.name })}
                    >
                      <span className="palette-icon skill gallery">
                        <GalleryHorizontalEnd size={16} strokeWidth={1.9} />
                      </span>
                      <span className="palette-label">
                        <span className="palette-label-text">{entry.name.replace(/^Gallery:\s*/, "")}</span>
                        {entry.gallery?.palette.length ? (
                          <span className="palette-mini-strip" aria-hidden="true">
                            {entry.gallery.palette.slice(0, 5).map((hex, index) => (
                              <span key={`${hex}-${index}`} className="palette-mini-swatch" style={{ background: hex }} />
                            ))}
                          </span>
                        ) : null}
                      </span>
                      <span className="palette-chip palette-chip-moodboard">board</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {plainSkills.length ? (
                <div className="palette-group">
                  <span className="palette-subhead">
                    <Layers size={12} strokeWidth={2} /> Skills
                  </span>
                  {plainSkills.map((entry) => (
                    <div key={entry.name} className="palette-item skill" title={entry.description} onPointerDown={(event) => pick(event, { kind: "skill", name: entry.name })}>
                      <span className="palette-icon skill">
                        <ClipboardList size={16} strokeWidth={1.9} />
                      </span>
                      <span className="palette-label">{entry.name}</span>
                      {entry.source === "installed" ? <span className="palette-chip palette-chip-installed">installed</span> : null}
                      {entry.source === "custom" ? <span className="palette-chip palette-chip-custom">custom</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )
          : tab === "models"
            ? models.map((entry) => (
              <div key={`${entry.provider}-${entry.model}`} className="palette-item model" onPointerDown={(event) => pick(event, { kind: "model", provider: entry.provider, model: entry.model })}>
                <span className="palette-icon logo">
                  <img alt="" src={PROVIDERS[entry.provider].logo} />
                </span>
                <span className="palette-label">
                  <strong>{PROVIDERS[entry.provider].label}</strong>
                  <small>
                    {entry.model}
                    {PROVIDERS[entry.provider].tier === "local" ? " · local" : ""}
                  </small>
                </span>
              </div>
            ))
          : null}
        {tab === "skills" ? (
          <div className="palette-add-skill">
            {addingSkill ? (
              <div className="palette-add-skill-form">
                <input
                  type="text"
                  placeholder="Skill name"
                  value={newSkillName}
                  autoFocus
                  onChange={(event) => setNewSkillName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitCustomSkill();
                    if (event.key === "Escape") setAddingSkill(false);
                  }}
                />
                <textarea
                  placeholder="Optional description or notes"
                  value={newSkillDescription}
                  onChange={(event) => setNewSkillDescription(event.target.value)}
                  rows={2}
                />
                <div className="panel-actions">
                  <button type="button" onClick={submitCustomSkill} disabled={!newSkillName.trim()}>
                    Save skill
                  </button>
                  <button type="button" onClick={() => setAddingSkill(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="palette-add-skill-trigger" onClick={() => setAddingSkill(true)}>
                <Plus size={14} /> Add skill
              </button>
            )}
          </div>
        ) : null}
        {tab === "presets" ? (
          <div className="preset-library">
            {PRESETS.map((preset) => (
              <button key={preset.key} type="button" className={`preset-library-card ${preset.key === "recommended" ? "recommended" : ""}`} onClick={() => onPreset(preset.key)}>
                <span>{preset.label}</span>
                <small>{preset.note}</small>
              </button>
            ))}
            <div className="panel-actions">
              <button type="button" onClick={onSavePreset}>
                Save current
              </button>
              <button type="button" disabled={!hasSavedPreset} onClick={onLoadPreset}>
                Load saved
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <footer className="palette-foot">
        {tab === "skills"
          ? "Drag a skill onto an agent or route line. It will load before that route runs."
          : tab === "models"
            ? "Drag a model onto an agent or router to set who handles that call."
            : "Presets are local for now. Save/load keeps this graph read-write without a backend."}
      </footer>
    </aside>
  );
}

/** Assigns a project (or other grouping key) a stable muted hue from GRAPH_HUE_RAMP, so the same project always gets the same color group. */
function hueForKey(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return GRAPH_HUE_RAMP[hash % GRAPH_HUE_RAMP.length];
}

/** Base built-in color-group rules: packages first (distinct base tone), then per-project hues, falling back to node-type greys. A rule is {match, color} so query-based rules can slot in later without touching the renderer.
 *  Owner feedback (docs/FABLE_PLANS.md section 17): the hue ramp is OPT-IN via the graph settings
 *  "Colour by project" toggle (default off) — when disabled this returns no rules at all, so every
 *  node falls through to the sleek-dark greyscale in colorForNode(). */
function buildColorRules(graphNodes: MemoryGraphNode[], colorByProject: boolean): ColorRule[] {
  if (!colorByProject) return [];
  const projectKeys = new Set<string>();
  for (const node of graphNodes) {
    if (node.type === "project") projectKeys.add(node.id);
  }
  const rules: ColorRule[] = [
    { id: "package", match: (node) => node.type === "file" && node.detail === "installed package", color: "hsl(45 55% 58%)", label: "Packages" }
  ];
  for (const key of projectKeys) {
    rules.push({
      id: `project:${key}`,
      match: (node) => node.id === key || node.path?.includes(key) === true,
      color: `hsl(${hueForKey(key)} 38% 58%)`,
      label: key
    });
  }
  return rules;
}

/** Obsidian-style light body fill on the dark canvas — colour (when the opt-in "Colour by
 *  project" rule matches) is the only source of hue; otherwise every node reads as a light
 *  grey/white whose brightness ramps with degree (dimmer for low-degree leaves, brighter for
 *  hubs), landing in the #b9bdc6–#d8dade range per owner feedback (2026-07-03 batch, §18). */
function colorForNode(node: MemoryGraphNode, rules: ColorRule[], degree = 0): string {
  for (const rule of rules) {
    if (rule.match(node)) return rule.color;
  }
  const t = Math.max(0, Math.min(1, degree / 6));
  const lightness = 74 + t * 10; // 74% (#b9bdc6-ish) -> 84% (#d8dade-ish)
  return `hsl(228 8% ${lightness}%)`;
}

const GRAPH_KINETIC_SLEEP_THRESHOLD = 0.015;
const GRAPH_DAMPING = 0.86;

/** Seeds physics bodies for a node set, reusing prior positions/velocity where the id already existed (keeps the sim continuous across data refreshes). */
function seedPhysicsNodes(graphNodes: MemoryGraphNode[], degree: Map<string, number>, prior: Map<string, PhysicsNode>): Map<string, PhysicsNode> {
  const next = new Map<string, PhysicsNode>();
  graphNodes.forEach((node, index) => {
    const existing = prior.get(node.id);
    const d = degree.get(node.id) ?? 0;
    // Obsidian-style nodes read smaller than the old dark-fill design (~60-70% of prior radii).
    const radius = Math.max(4, Math.min(20, 4 + d * 1.6 + (node.size ?? 18) * 0.17));
    if (existing) {
      next.set(node.id, { ...existing, degree: d, radius });
      return;
    }
    const angle = (index / Math.max(1, graphNodes.length)) * Math.PI * 2;
    const spread = 90 + (index % 7) * 40;
    const x = node.pos.x || Math.cos(angle) * spread;
    const y = node.pos.y || Math.sin(angle) * spread;
    next.set(node.id, { id: node.id, x, y, px: x, py: y, degree: d, pinned: false, radius });
  });
  return next;
}

/**
 * One verlet-integration physics step for the Graph View force sim (Obsidian-style):
 * pairwise Coulomb-ish repulsion (capped, O(n^2) — fine at the hundreds-of-nodes scale this view sees),
 * spring attraction along edges toward `linkDistance`, and gravity pulling every free node toward the origin.
 * Returns the total kinetic energy so the caller can decide whether the sim should keep animating or sleep.
 */
function stepPhysics(
  nodes: Map<string, PhysicsNode>,
  links: MemoryGraphLink[],
  settings: GraphPhysicsSettings,
  draggingId: string | null,
  dt: number
): number {
  const list = Array.from(nodes.values());
  const forces = new Map<string, Vec>(list.map((n) => [n.id, { x: 0, y: 0 }]));

  // Pairwise repulsion (Coulomb-ish, capped so close overlaps don't blow up).
  const repelK = 2600 * settings.repelForce;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        distSq = 1;
      }
      const dist = Math.sqrt(distSq);
      const force = Math.min(120, repelK / distSq);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      forces.get(a.id)!.x += fx;
      forces.get(a.id)!.y += fy;
      forces.get(b.id)!.x -= fx;
      forces.get(b.id)!.y -= fy;
    }
  }

  // Spring attraction along edges toward the target link distance.
  const springK = 0.045;
  for (const link of links) {
    const a = nodes.get(link.from);
    const b = nodes.get(link.to);
    if (!a || !b) continue;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const target = settings.linkDistance * (link.strength ? 1 / Math.min(2, link.strength) : 1);
    const delta = (dist - target) * springK;
    const fx = (dx / dist) * delta;
    const fy = (dy / dist) * delta;
    forces.get(a.id)!.x += fx;
    forces.get(a.id)!.y += fy;
    forces.get(b.id)!.x -= fx;
    forces.get(b.id)!.y -= fy;
  }

  // Center gravity — keeps free nodes from drifting off into the void.
  const gravityK = 0.0022 * settings.centerForce;
  for (const node of list) {
    forces.get(node.id)!.x += -node.x * gravityK;
    forces.get(node.id)!.y += -node.y * gravityK;
  }

  let kinetic = 0;
  for (const node of list) {
    if (node.id === draggingId) {
      node.px = node.x;
      node.py = node.y;
      continue;
    }
    const f = forces.get(node.id)!;
    const vx = (node.x - node.px) * GRAPH_DAMPING + f.x * dt * dt;
    const vy = (node.y - node.py) * GRAPH_DAMPING + f.y * dt * dt;
    node.px = node.x;
    node.py = node.y;
    node.x += vx;
    node.y += vy;
    kinetic += vx * vx + vy * vy;
  }
  return kinetic;
}

/** Builds the neighbor-depth filter for local graph mode: BFS out from `rootId` up to `depth` hops. */
function localGraphIds(rootId: string, links: MemoryGraphLink[], depth: number): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    (adjacency.get(link.from) ?? adjacency.set(link.from, []).get(link.from)!).push(link.to);
    (adjacency.get(link.to) ?? adjacency.set(link.to, []).get(link.to)!).push(link.from);
  }
  const visited = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visited;
}

function MemoryGraphWorkspace({
  onConversationOpen
}: {
  onConversationOpen?: (id: string) => void;
}): JSX.Element {
  const [pan, setPan] = useState<Vec>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [focusRoot, setFocusRoot] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState(2);
  const [runtimeConversations, setRuntimeConversations] = useState<ConversationRecord[]>([]);
  const [runtimeRuns, setRuntimeRuns] = useState<SessionRun[]>([]);
  const [installedPackages, setInstalledPackages] = useState<RegistryPackage[]>([]);
  const [projectWorkspace, setProjectWorkspace] = useState<ProjectWorkspace | null>(null);
  const [projectSnapshot, setProjectSnapshot] = useState<ProjectSnapshot | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Document viewer (owner: "view the documents when I click on a node") — file-node click opens
  // this instead of a conversation. Kept separate from `selected` so the detail card and doc panel
  // can coexist without fighting over one piece of state.
  const [openDoc, setOpenDoc] = useState<{ path: string; name: string; content: string; truncated: boolean } | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  // Obsidian-style edit/save for the doc panel (owner: "make it editable"). `docEditing` toggles
  // the panel between the read-only pre/markdown view and a textarea over `docDraft`. Save status
  // is a transient banner, not persisted — it just confirms the write landed.
  const [docEditing, setDocEditing] = useState(false);
  const [docDraft, setDocDraft] = useState("");
  const [docSaving, setDocSaving] = useState(false);
  const [docSaveStatus, setDocSaveStatus] = useState<"saved" | "error" | null>(null);
  const [docSaveError, setDocSaveError] = useState<string | null>(null);
  // Owner wants the physics feel kept but the customizer UI gone, so this stays read-only here:
  // whatever was last persisted (or the default) still drives the sim, there's just no in-app
  // control surface to change it anymore.
  const [physics] = useAppStoreState<GraphPhysicsSettings>("graphPhysics", DEFAULT_GRAPH_PHYSICS);
  const [colorByProject] = useAppStoreState<boolean>("graphColorByProject", false);
  // "Search notes" / "Pinned notes" toolbar buttons (owner: "a lot of buttons that just do
  // nothing") — wired to a real client-side filter over the note tree instead of being no-ops.
  // Pins persist via the same local app-store hook physics/colorByProject use, so they survive
  // reloads without any new backend/IPC surface.
  const [treeSearchOpen, setTreeSearchOpen] = useState(false);
  const [treeSearchQuery, setTreeSearchQuery] = useState("");
  const [pinnedNotes, setPinnedNotes] = useAppStoreState<string[]>("graphPinnedNotes", EMPTY_PINNED_NOTES);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "agent-memory": true,
    "ad-helpdesk": true,
    metis: true,
    "metis-orchestrator": true,
    runtime: true
  });
  const [dragging, setDragging] = useState<{ startClient: Vec; startPan: Vec } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  // Tracks the pointerdown client position so pointerup can tell a click (no/tiny movement) from a
  // drag (owner feedback: click on a conversation-backed node should OPEN it, drag should still move it).
  const pointerDownAtRef = useRef<Vec | null>(null);

  const runtimeGraph = useMemo(() => buildRuntimeMemoryGraph(runtimeConversations, runtimeRuns), [runtimeConversations, runtimeRuns]);

  const packageNodes = useMemo<MemoryGraphNode[]>(
    () =>
      installedPackages.slice(0, 40).map((pkg, index) => ({
        id: `package-${pkg.id}`,
        label: pkg.name,
        type: "file" as MemoryNodeType,
        pos: { x: 900 + (index % 5) * 90, y: 400 + Math.floor(index / 5) * 70 },
        size: 12,
        detail: "installed package",
        path: pkg.kind
      })),
    [installedPackages]
  );

  // Project file nodes (owner: "view the documents when I click on a node") — the focused project's
  // snapshot files, capped ~40, restricted to doc-ish extensions so the graph doesn't fill up with
  // every source file. Linked to the matching static project node when the workspace name matches
  // one of MEMORY_GRAPH_NODES' project ids/labels, otherwise to "home" so they're never orphaned.
  // Node id is prefixed `project-file-` (not `package-`) — that's how the click handler tells a real,
  // openable-on-disk file apart from the `package-*` file-typed nodes above, whose `path` is just a kind string.
  const DOC_FILE_EXTENSIONS = useMemo(
    () => new Set([".md", ".txt", ".json", ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".svg", ".py", ".yml", ".yaml"]),
    []
  );
  const projectFileNodes = useMemo<MemoryGraphNode[]>(() => {
    if (!projectWorkspace || !projectSnapshot) return [];
    const docFiles = projectSnapshot.files
      .filter((file) => file.kind === "file" && DOC_FILE_EXTENSIONS.has(extnameLower(file.path)))
      .slice(0, 60);
    return docFiles.map((file, index) => ({
      id: `project-file-${index}-${file.path}`,
      label: file.path.split("/").pop() ?? file.path,
      type: "file" as MemoryNodeType,
      pos: { x: -900 + (index % 6) * 90, y: 400 + Math.floor(index / 6) * 70 },
      size: 10,
      detail: file.path,
      // Defensive join: strip any trailing separator on the workspace root and any leading
      // separator on the (already-relative) snapshot path so this can never produce a double
      // slash before it's normalised — backend's isPathInside guard still does the real check.
      path: `${projectWorkspace.path.replace(/[\\/]+$/, "")}/${file.path.replace(/^[\\/]+/, "")}`.replace(/\\/g, "/")
    }));
  }, [projectWorkspace, projectSnapshot, DOC_FILE_EXTENSIONS]);

  const projectFileParentId = useMemo(() => {
    if (!projectWorkspace) return "home";
    const normalized = normalizeMemoryLabel(projectWorkspace.name);
    const match = MEMORY_GRAPH_NODES.find((node) => node.type === "project" && (node.id === normalized || normalizeMemoryLabel(node.label) === normalized));
    return match?.id ?? "home";
  }, [projectWorkspace]);

  const allNodes = useMemo(
    () => [...MEMORY_GRAPH_NODES, ...runtimeGraph.nodes, ...packageNodes, ...projectFileNodes],
    [runtimeGraph.nodes, packageNodes, projectFileNodes]
  );
  const allLinks = useMemo(() => {
    const links = [...MEMORY_GRAPH_LINKS, ...runtimeGraph.links];
    for (const pkgNode of packageNodes) links.push({ from: "marketplace", to: pkgNode.id });
    for (const fileNode of projectFileNodes) links.push({ from: projectFileParentId, to: fileNode.id });
    return links;
  }, [runtimeGraph.links, packageNodes, projectFileNodes, projectFileParentId]);

  // Welcome cluster: if there's truly no live data (no runtime conversations, no packages), the static
  // MEMORY_GRAPH_NODES/LINKS above already act as the seeded "welcome" cluster, so the view is never blank.
  // Directory folder tree = REAL data only (the runtime conversation tree, grouped by project). The
  // old hardcoded MEMORY_TREE demo folders were removed — they showed placeholder notes that could
  // never open (owner asked to rip out the fake demo tree).
  const graphTree = useMemo(() => (runtimeGraph.tree ? [runtimeGraph.tree] : []), [runtimeGraph.tree]);

  // Directory panel (owner: "the right-hand directory items still do not open documents") — groups
  // the REAL project files (same list the canvas draws as project-file-* nodes) by folder so the
  // tree reads like a file browser instead of the old static demo note tree. Folder key is the
  // project-relative directory ("" becomes a synthetic "(root)" bucket for top-level files).
  const projectFileGroups = useMemo<{ folder: string; files: MemoryGraphNode[] }[]>(() => {
    const groups = new Map<string, MemoryGraphNode[]>();
    for (const node of projectFileNodes) {
      const relPath = node.detail ?? node.label;
      const slashIdx = relPath.lastIndexOf("/");
      const folder = slashIdx === -1 ? "" : relPath.slice(0, slashIdx);
      (groups.get(folder) ?? groups.set(folder, []).get(folder)!).push(node);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, files]) => ({ folder: folder || "(root)", files: [...files].sort((a, b) => a.label.localeCompare(b.label)) }));
  }, [projectFileNodes]);

  // Search + pinned toolbar buttons now target this real file list (owner: repurpose the buttons
  // that used to filter the fake demo notes). Folders with nothing left after filtering are dropped.
  const visibleFileGroups = useMemo(() => {
    const query = treeSearchQuery.trim().toLowerCase();
    const pinnedSet = new Set(pinnedNotes);
    if (!query && !pinnedOnly) return projectFileGroups;
    return projectFileGroups
      .map((group) => ({
        folder: group.folder,
        files: group.files.filter(
          (file) => (!pinnedOnly || pinnedSet.has(file.detail ?? file.label)) && (!query || file.label.toLowerCase().includes(query))
        )
      }))
      .filter((group) => group.files.length > 0);
  }, [projectFileGroups, treeSearchQuery, pinnedOnly, pinnedNotes]);
  const isFilteringFiles = Boolean(treeSearchQuery.trim()) || pinnedOnly;

  // The directory keeps its folder structure (owner: "I didn't mean remove everything from the
  // directory"), but each leaf now resolves to what it actually is so it shows the right glyph and
  // OPENS the right thing (documents get the doc glyph + full-view; conversations get the chat glyph).
  function leafKind(label: string): "doc" | "conversation" | "note" {
    if (allNodes.some((node) => node.type === "conversation" && node.label === label && node.conversationId)) return "conversation";
    if (projectFileNodes.some((node) => node.label === label || node.detail === label)) return "doc";
    return "note";
  }
  function openTreeLeaf(label: string): void {
    const conversation = allNodes.find((node) => node.type === "conversation" && node.label === label && node.conversationId);
    if (conversation?.conversationId) {
      onConversationOpen?.(conversation.conversationId);
      return;
    }
    const doc = projectFileNodes.find((node) => node.label === label || node.detail === label);
    if (doc) {
      openDocForNode(doc);
      return;
    }
    selectByLabel(label);
  }
  // Add/open a folder to browse (owner: "I need to be able to add folders"). selectFolder points the
  // active project at the chosen folder; refreshing then loads that folder's documents into the
  // directory + canvas. Guarded for the browser preview where the bridge is absent.
  async function addFolderToGraph(): Promise<void> {
    if (!window.metisProject) return;
    try {
      await window.metisProject.selectFolder();
      refreshRuntimeGraph();
    } catch {
      /* folder picker cancelled */
    }
  }

  function togglePinnedNote(note: string): void {
    setPinnedNotes((current) => (current.includes(note) ? current.filter((n) => n !== note) : [...current, note]));
  }

  const degree = useMemo(() => {
    const map = new Map<string, number>();
    for (const link of allLinks) {
      map.set(link.from, (map.get(link.from) ?? 0) + 1);
      map.set(link.to, (map.get(link.to) ?? 0) + 1);
    }
    return map;
  }, [allLinks]);

  const visibleIds = useMemo(() => {
    if (!focusRoot) return null;
    return localGraphIds(focusRoot, allLinks, focusDepth);
  }, [focusRoot, allLinks, focusDepth]);

  const graphNodes = useMemo(() => (visibleIds ? allNodes.filter((n) => visibleIds.has(n.id)) : allNodes), [allNodes, visibleIds]);
  const graphLinks = useMemo(
    () => (visibleIds ? allLinks.filter((l) => visibleIds.has(l.from) && visibleIds.has(l.to)) : allLinks),
    [allLinks, visibleIds]
  );

  const colorRules = useMemo(() => buildColorRules(graphNodes, colorByProject), [graphNodes, colorByProject]);
  const nodeMap = useMemo(() => new Map(graphNodes.map((node) => [node.id, node])), [graphNodes]);
  const selectedNode = selected ? nodeMap.get(selected) : undefined;
  const connected = useMemo(() => {
    const ids = new Set<string>();
    if (!selected) return ids;
    for (const link of graphLinks) {
      if (link.from === selected) ids.add(link.to);
      if (link.to === selected) ids.add(link.from);
    }
    return ids;
  }, [graphLinks, selected]);

  // Physics bodies persist across renders in a ref (not state) so the rAF loop can mutate them every
  // frame without triggering React re-renders — only the canvas draw call reads them each tick.
  const physicsRef = useRef<Map<string, PhysicsNode>>(new Map());
  const draggingNodeRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);

  // Live refs so the rAF frame callback (created once) always reads current props/state without
  // needing to be re-created — this lets wake() start the loop directly, from any event handler.
  const liveRef = useRef({ graphNodes, graphLinks, physics, pan, zoom, selected, hoveredId, colorRules, connected });
  liveRef.current = { graphNodes, graphLinks, physics, pan, zoom, selected, hoveredId, colorRules, connected };

  useEffect(() => {
    physicsRef.current = seedPhysicsNodes(graphNodes, degree, physicsRef.current);
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphNodes, degree]);

  const refreshRuntimeGraph = useCallback(() => {
    if (window.metisConversations) void window.metisConversations.list().then(setRuntimeConversations);
    if (window.metisSession) void window.metisSession.list().then(setRuntimeRuns);
    if (window.metisRegistry) void window.metisRegistry.listInstalled().then(setInstalledPackages).catch(() => undefined);
    if (window.metisProject) {
      void window.metisProject
        .getWorkspace()
        .then((workspace) => {
          setProjectWorkspace(workspace);
          if (!workspace) {
            setProjectSnapshot(null);
            return undefined;
          }
          return window.metisProject?.snapshot().then(setProjectSnapshot).catch(() => setProjectSnapshot(null));
        })
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    refreshRuntimeGraph();
  }, [refreshRuntimeGraph]);

  function drawGraph(): void {
    const { graphNodes: nodesToDraw, graphLinks: linksToDraw, physics: currentPhysics, pan: currentPan, zoom: currentZoom, selected: currentSelected, hoveredId: currentHovered, colorRules: currentRules } =
      liveRef.current;
    const canvas = canvasElRef.current;
    const container = canvasRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.save();
    ctx.translate(rect.width / 2 + currentPan.x, rect.height / 2 + currentPan.y);
    ctx.scale(currentZoom, currentZoom);

    const nodes = physicsRef.current;
    const textFadeThreshold = 0.62;
    const showAllLabels = currentZoom >= textFadeThreshold;

    ctx.lineCap = "round";
    for (const link of linksToDraw) {
      const a = nodes.get(link.from);
      const b = nodes.get(link.to);
      if (!a || !b) continue;
      const active = currentSelected === link.from || currentSelected === link.to;
      ctx.strokeStyle = active ? "rgba(220,220,220,0.9)" : "rgba(120,120,120,0.4)";
      ctx.lineWidth = (currentPhysics.linkThickness * (link.strength ?? 1)) / currentZoom;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const node of nodesToDraw) {
      const body = nodes.get(node.id);
      if (!body) continue;
      const active = currentSelected === node.id;
      const related = liveRef.current.connected.has(node.id);
      const hovered = currentHovered === node.id;
      const color = colorForNode(node, currentRules, body.degree);
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = active || related || hovered ? 1 : 0.82;
      ctx.fill();
      // Obsidian-style bodies have no border — just a barely-darker rim so pale nodes still read
      // against the dark canvas. Selected/hovered keep a subtle accent ring on top of that.
      ctx.lineWidth = 1 / currentZoom;
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.stroke();
      if (active || hovered) {
        ctx.beginPath();
        ctx.arc(body.x, body.y, body.radius + 2.5 / currentZoom, 0, Math.PI * 2);
        ctx.lineWidth = 1.6 / currentZoom;
        ctx.strokeStyle = "#aeb7c6"; // --accent — canvas context can't read CSS custom properties directly
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Text fade: labels fade below the zoom threshold, and small-degree nodes lose labels first.
      // Labels stay --soft regardless of node brightness (owner feedback, §18).
      const labelChance = Math.min(1, (body.degree + 1) / 4);
      if ((showAllLabels || active || hovered) && (labelChance >= 1 || currentZoom > textFadeThreshold * (1.4 - labelChance))) {
        ctx.font = `${active ? "700" : "500"} ${12 / currentZoom}px 'Inter', system-ui, sans-serif`;
        ctx.fillStyle = active ? "#f2f2f2" : "#c2c2c2";
        ctx.textAlign = "center";
        ctx.fillText(node.label, body.x, body.y + body.radius + 13 / currentZoom);
      }
    }
    ctx.restore();
  }

  // The rAF physics + draw loop. wake() (re)starts it; it sleeps (cancels the frame) once kinetic
  // energy drops below GRAPH_KINETIC_SLEEP_THRESHOLD so an idle graph doesn't burn battery.
  function frame(): void {
    const { graphLinks: currentLinks, physics: currentPhysics } = liveRef.current;
    const kinetic = stepPhysics(physicsRef.current, currentLinks, currentPhysics, draggingNodeRef.current, 1);
    drawGraph();
    if (draggingNodeRef.current || kinetic > GRAPH_KINETIC_SLEEP_THRESHOLD) {
      rafRef.current = requestAnimationFrame(frame);
    } else {
      rafRef.current = null;
    }
  }

  function wake(): void {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(frame);
  }

  // Wake on any prop/state change that should redraw or resume the sim (zoom, pan, focus, selection, hover).
  useEffect(() => {
    wake();
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphLinks, graphNodes, physics, pan, zoom, selected, hoveredId, colorRules]);

  function screenToWorld(clientX: number, clientY: number): Vec {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const cx = clientX - rect.left - rect.width / 2 - pan.x;
    const cy = clientY - rect.top - rect.height / 2 - pan.y;
    return { x: cx / zoom, y: cy / zoom };
  }

  function hitTest(clientX: number, clientY: number): string | null {
    const world = screenToWorld(clientX, clientY);
    let closest: { id: string; dist: number } | null = null;
    for (const node of graphNodes) {
      const body = physicsRef.current.get(node.id);
      if (!body) continue;
      const dx = body.x - world.x;
      const dy = body.y - world.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= body.radius + 3 && (!closest || dist < closest.dist)) closest = { id: node.id, dist };
    }
    return closest?.id ?? null;
  }

  function toggleFolder(name: string): void {
    setExpanded((current) => ({ ...current, [name]: !current[name] }));
  }

  function selectByLabel(label: string): void {
    const normalized = normalizeMemoryLabel(label);
    const match = graphNodes.find((node) => node.id === normalized || normalizeMemoryLabel(node.label) === normalized);
    if (match) setSelected(match.id);
  }

  function onWheel(event: ReactWheelEvent<HTMLElement>): void {
    event.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = event.clientX - rect.left - rect.width / 2;
    const cy = event.clientY - rect.top - rect.height / 2;
    setZoom((prevZoom) => {
      const next = Math.min(2.6, Math.max(0.2, prevZoom * Math.exp(-event.deltaY * 0.0012)));
      setPan((prevPan) => ({ x: cx - ((cx - prevPan.x) / prevZoom) * next, y: cy - ((cy - prevPan.y) / prevZoom) * next }));
      return next;
    });
    wake();
  }

  function beginPan(event: ReactPointerEvent<HTMLElement>): void {
    if (event.button !== 0) return;
    pointerDownAtRef.current = { x: event.clientX, y: event.clientY };
    const hitId = hitTest(event.clientX, event.clientY);
    canvasRef.current?.setPointerCapture(event.pointerId);
    if (hitId) {
      draggingNodeRef.current = hitId;
      wake();
      return;
    }
    setDragging({ startClient: { x: event.clientX, y: event.clientY }, startPan: pan });
  }

  function movePan(event: ReactPointerEvent<HTMLElement>): void {
    if (draggingNodeRef.current) {
      const world = screenToWorld(event.clientX, event.clientY);
      const body = physicsRef.current.get(draggingNodeRef.current);
      if (body) {
        body.x = world.x;
        body.y = world.y;
      }
      wake();
      return;
    }
    if (dragging) {
      setPan({ x: dragging.startPan.x + (event.clientX - dragging.startClient.x), y: dragging.startPan.y + (event.clientY - dragging.startClient.y) });
      return;
    }
    setHoveredId(hitTest(event.clientX, event.clientY));
  }

  function endPan(event: ReactPointerEvent<HTMLElement>): void {
    if (draggingNodeRef.current) {
      draggingNodeRef.current = null;
      wake();
    }
    setDragging(null);
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId);
  }

  // Opens the document viewer for a project-file node (id prefix `project-file-`, real
  // absolute path in `node.path`). Guards for the no-bridge browser-preview case per node
  // click, not just at mount, since the bridge can't appear mid-session either way.
  function openDocForNode(node: MemoryGraphNode): void {
    setSelected(node.id);
    setDocError(null);
    setDocEditing(false);
    setDocSaveStatus(null);
    setDocSaveError(null);
    if (!window.metisFiles) {
      setOpenDoc(null);
      setDocError("unavailable in preview");
      return;
    }
    if (!node.path) return;
    setDocLoading(true);
    void window.metisFiles
      .read(node.path)
      .then((result) => {
        setOpenDoc(result);
        setDocError(null);
      })
      .catch((error) => {
        setOpenDoc(null);
        setDocError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setDocLoading(false));
  }

  // Enters edit mode over the currently-loaded doc. Guarded at the call site (button hidden) for
  // the no-bridge preview case and for truncated reads, where saving would clobber the untruncated
  // rest of the file on disk.
  function beginDocEdit(): void {
    if (!openDoc) return;
    setDocDraft(openDoc.content);
    setDocEditing(true);
    setDocSaveStatus(null);
    setDocSaveError(null);
  }

  function cancelDocEdit(): void {
    setDocEditing(false);
    setDocSaveStatus(null);
    setDocSaveError(null);
  }

  function saveDocEdit(): void {
    if (!openDoc || !window.metisFiles) return;
    setDocSaving(true);
    setDocSaveStatus(null);
    setDocSaveError(null);
    void window.metisFiles
      .write(openDoc.path, docDraft)
      .then((result) => {
        if (result.ok) {
          setOpenDoc({ ...openDoc, content: docDraft });
          setDocEditing(false);
          setDocSaveStatus("saved");
        } else {
          setDocSaveStatus("error");
          setDocSaveError(result.error ?? "Save failed.");
        }
      })
      .catch((error) => {
        setDocSaveStatus("error");
        setDocSaveError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setDocSaving(false));
  }

  function onCanvasClick(event: ReactPointerEvent<HTMLElement>): void {
    if (dragging) return;
    const downAt = pointerDownAtRef.current;
    pointerDownAtRef.current = null;
    const moved = downAt ? Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) : 0;
    const hitId = hitTest(event.clientX, event.clientY);
    // Click (< 4px movement) on a conversation-backed node OPENS it directly — the graph is a
    // launcher, not just a viewer. A bigger movement means the pointerdown/up pair was a drag that
    // just ended on top of a node, so it still only selects. Non-openable nodes (projects, packages,
    // welcome nodes with no conversationId) keep the existing select/detail-panel behavior.
    if (hitId && moved < 4) {
      const node = nodeMap.get(hitId);
      if (node?.conversationId && onConversationOpen) {
        onConversationOpen(node.conversationId);
        return;
      }
      // Project file nodes (owner: "view the documents when I click on a node") open the
      // in-app document viewer instead of just selecting. Package/kind "file" nodes from the
      // marketplace (id prefix `package-`) keep the plain select/detail-panel behavior.
      if (node && node.type === "file" && node.id.startsWith("project-file-")) {
        openDocForNode(node);
        return;
      }
    }
    setOpenDoc(null);
    setSelected(hitId);
  }

  function zoomBy(factor: number): void {
    setZoom((current) => Math.min(2.6, Math.max(0.2, current * factor)));
    wake();
  }

  return (
    <main className={`memory-workspace ${treeCollapsed ? "tree-collapsed" : ""}`} aria-label="Graph View">
      <section
        className={`memory-canvas ${dragging ? "panning" : ""} ${draggingNodeRef.current ? "dragging-node" : ""}`}
        ref={canvasRef}
        onWheel={onWheel}
        onPointerDown={beginPan}
        onPointerMove={movePan}
        onPointerUp={(event) => {
          endPan(event);
          onCanvasClick(event);
        }}
        onPointerCancel={endPan}
      >
        <canvas ref={canvasElRef} className="memory-canvas-surface" />
        <div className="memory-toolbar">
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.18)}>
            <ZoomOut size={16} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.18)}>
            <ZoomIn size={16} />
          </button>
          <button type="button" aria-label="Center graph" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); wake(); }}>
            <Maximize2 size={15} />
          </button>
          <button type="button" aria-label="Refresh runtime memory" onClick={refreshRuntimeGraph}>
            <RotateCcw size={15} />
          </button>
          {/* Always-present directory toggle so the panel can always be reopened (owner: "when I
              collapse the window I cant reopen the graph window") — the floating pill was easy to miss. */}
          <button
            type="button"
            aria-label={treeCollapsed ? "Show directory" : "Hide directory"}
            title={treeCollapsed ? "Show directory" : "Hide directory"}
            className={treeCollapsed ? "" : "active"}
            onClick={() => setTreeCollapsed((v) => !v)}
          >
            {treeCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
          </button>
        </div>
        {focusRoot ? (
          <div className="memory-focus-bar">
            <span>Local graph — depth {focusDepth}</span>
            <input type="range" min={1} max={3} step={1} value={focusDepth} onChange={(e) => setFocusDepth(Number(e.target.value))} />
            <button type="button" aria-label="Exit local graph" onClick={() => setFocusRoot(null)}>
              <X size={13} /> Global graph
            </button>
          </div>
        ) : null}
        {selectedNode ? (
          <aside className="memory-detail">
            <small>{selectedNode.type}</small>
            <strong>{selectedNode.label}</strong>
            <span>{selectedNode.detail}</span>
            <em>{connected.size} linked node{connected.size === 1 ? "" : "s"}</em>
            <div className="memory-detail-actions">
              {selectedNode.id !== focusRoot ? (
                <button type="button" onClick={() => setFocusRoot(selectedNode.id)}>
                  Focus local graph
                </button>
              ) : null}
              {selectedNode.conversationId && onConversationOpen ? (
                <button type="button" onClick={() => onConversationOpen(selectedNode.conversationId ?? "")}>
                  Open conversation
                </button>
              ) : null}
              {selectedNode.type === "file" && selectedNode.id.startsWith("project-file-") ? (
                <button type="button" onClick={() => openDocForNode(selectedNode)}>
                  Open document
                </button>
              ) : null}
            </div>
            {selectedNode.path ? <code>{selectedNode.path}</code> : null}
          </aside>
        ) : null}
        {treeCollapsed ? (
          <button className="panel-rail-toggle memory-panel-widget" type="button" onClick={() => setTreeCollapsed(false)}>
            <ChevronLeft size={16} />
            <span>Directory</span>
          </button>
        ) : null}
      </section>

      {docLoading || openDoc || docError ? (
        <aside className="memory-doc-panel" aria-label="Document viewer">
          <header className="memory-doc-panel-header">
            <FileText size={15} />
            <span className="memory-doc-panel-title">{openDoc?.name ?? "Document"}</span>
            {docSaveStatus === "saved" ? (
              <span className="memory-doc-panel-status memory-doc-panel-status-saved">
                <Check size={12} /> Saved
              </span>
            ) : null}
            {openDoc && window.metisFiles && !docEditing ? (
              <button
                type="button"
                className="memory-doc-panel-edit"
                aria-label="Edit document"
                title={openDoc.truncated ? "Editing is disabled for truncated files" : "Edit document"}
                disabled={openDoc.truncated}
                onClick={beginDocEdit}
              >
                <Pencil size={14} />
              </button>
            ) : null}
            {docEditing ? (
              <>
                <button
                  type="button"
                  className="memory-doc-panel-cancel"
                  aria-label="Cancel edit"
                  disabled={docSaving}
                  onClick={cancelDocEdit}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="memory-doc-panel-save"
                  aria-label="Save document"
                  disabled={docSaving || docDraft === openDoc?.content}
                  onClick={saveDocEdit}
                >
                  {docSaving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
                  Save
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="memory-doc-panel-close"
              aria-label="Close document viewer"
              onClick={() => {
                setOpenDoc(null);
                setDocError(null);
                setDocEditing(false);
                setDocSaveStatus(null);
                setDocSaveError(null);
              }}
            >
              <X size={15} />
            </button>
          </header>
          <div className="memory-doc-panel-body">
            {docLoading ? (
              <p className="memory-doc-panel-empty">Loading…</p>
            ) : docError ? (
              <p className="memory-doc-panel-empty">{docError}</p>
            ) : openDoc ? (
              docEditing ? (
                <>
                  {openDoc.truncated ? (
                    <p className="memory-doc-panel-warning">This view was truncated — editing is disabled to avoid overwriting the rest of the file.</p>
                  ) : null}
                  {docSaveStatus === "error" ? <p className="memory-doc-panel-warning">{docSaveError}</p> : null}
                  <textarea
                    className="memory-doc-panel-editor"
                    value={docDraft}
                    onChange={(event) => setDocDraft(event.target.value)}
                    spellCheck={false}
                  />
                </>
              ) : extnameLower(openDoc.path) === ".md" ? (
                <Markdown>{openDoc.content}</Markdown>
              ) : (
                <pre>{openDoc.content}</pre>
              )
            ) : null}
          </div>
        </aside>
      ) : null}

      {!treeCollapsed ? (
        <aside className="memory-tree" aria-label="Note folders">
          <header className="memory-tree-head">
            <div className="memory-tree-actions">
              <button
                type="button"
                aria-label="Add folder"
                title="Open a folder to browse its documents"
                onClick={() => void addFolderToGraph()}
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                aria-label="Search files"
                className={treeSearchOpen ? "active" : ""}
                onClick={() => setTreeSearchOpen((v) => { const next = !v; if (!next) setTreeSearchQuery(""); return next; })}
              >
                <Search size={16} />
              </button>
              <button
                type="button"
                aria-label="Pinned files"
                className={pinnedOnly ? "active" : ""}
                title={pinnedNotes.length ? `${pinnedNotes.length} pinned` : "No files pinned yet — pin one from the list"}
                onClick={() => setPinnedOnly((v) => !v)}
              >
                <Pin size={15} />
              </button>
            </div>
            <button className="memory-tree-collapse" type="button" aria-label="Collapse file directory" onClick={() => setTreeCollapsed(true)}>
              <ChevronRight size={16} />
            </button>
          </header>
          {treeSearchOpen ? (
            <div className="memory-tree-search">
              <Search size={13} />
              <input
                type="text"
                value={treeSearchQuery}
                onChange={(e) => setTreeSearchQuery(e.target.value)}
                placeholder="Search…"
                autoFocus
              />
            </div>
          ) : null}
          {/* One directory area (owner: no separate Files-vs-Notes split, but nothing removed):
              the current project's documents grouped by folder, then the folder tree of notes and
              conversations. Every leaf resolves to a doc glyph (opens full-view) or a chat glyph
              (opens the conversation); unmatched notes still select on the canvas. */}
          <div className="memory-tree-list">
            {visibleFileGroups.map((group) => (
              <ProjectFileTreeGroup
                key={group.folder}
                group={group}
                expanded={expanded}
                onToggle={toggleFolder}
                forceOpen={isFilteringFiles}
                pinnedNotes={pinnedNotes}
                onTogglePin={togglePinnedNote}
                onOpen={openDocForNode}
              />
            ))}
            {graphTree.map((folder) => (
              <MemoryTreeFolder
                key={folder.name}
                depth={0}
                expanded={expanded}
                folder={folder}
                onPick={openTreeLeaf}
                onToggle={toggleFolder}
                forceOpen={isFilteringFiles}
                pinnedNotes={pinnedNotes}
                onTogglePin={togglePinnedNote}
                leafKind={leafKind}
              />
            ))}
            {visibleFileGroups.length === 0 && graphTree.length === 0 ? (
              <p className="memory-tree-empty">
                {!projectWorkspace || !projectSnapshot
                  ? "Select a project folder to see its documents. Your conversations show here too."
                  : "No documents or conversations yet."}
              </p>
            ) : null}
          </div>
        </aside>
      ) : null}
    </main>
  );
}

// Renders one folder bucket of real project files in the directory panel (owner: "the right-hand
// directory items still do not open documents"). A row click calls `onOpen`, the same
// `openDocForNode` path the canvas file nodes already use, so this is a second entry point into
// the same doc viewer rather than a separate select-only affordance like the old note tree.
function ProjectFileTreeGroup({
  group,
  expanded,
  onToggle,
  forceOpen,
  pinnedNotes,
  onTogglePin,
  onOpen
}: {
  group: { folder: string; files: MemoryGraphNode[] };
  expanded: Record<string, boolean>;
  onToggle: (name: string) => void;
  forceOpen?: boolean;
  pinnedNotes: string[];
  onTogglePin: (note: string) => void;
  onOpen: (node: MemoryGraphNode) => void;
}): JSX.Element {
  const groupKey = `files:${group.folder}`;
  const isOpen = forceOpen || Boolean(expanded[groupKey]);
  const pinnedSet = new Set(pinnedNotes);
  return (
    <div className="memory-tree-group">
      <button className="memory-tree-row folder" type="button" style={{ paddingLeft: "10px" }} onClick={() => onToggle(groupKey)}>
        <ChevronRight className={isOpen ? "open" : ""} size={14} />
        <Folder size={13} />
        <span>{group.folder}</span>
      </button>
      {isOpen
        ? group.files.map((file) => {
            const pinKey = file.detail ?? file.label;
            const isPinned = pinnedSet.has(pinKey);
            return (
              <div key={file.id} className="memory-tree-row note" style={{ paddingLeft: "34px" }}>
                <button type="button" className="memory-tree-note-label" onClick={() => onOpen(file)} title={file.detail ?? file.label}>
                  <FileText size={12} />
                  <span>{file.label}</span>
                </button>
                <button
                  type="button"
                  className={`memory-tree-pin ${isPinned ? "pinned" : ""}`}
                  aria-label={isPinned ? `Unpin ${file.label}` : `Pin ${file.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePin(pinKey);
                  }}
                >
                  <Pin size={11} />
                </button>
              </div>
            );
          })
        : null}
    </div>
  );
}

function MemoryTreeFolder({
  depth,
  expanded,
  folder,
  onPick,
  onToggle,
  forceOpen,
  pinnedNotes,
  onTogglePin,
  leafKind
}: {
  depth: number;
  expanded: Record<string, boolean>;
  folder: MemoryFolder;
  onPick: (label: string) => void;
  onToggle: (name: string) => void;
  // While a search/pinned-only filter is active, every remaining folder is force-expanded so
  // matches are never hidden behind a collapsed parent the user hasn't manually opened.
  forceOpen?: boolean;
  pinnedNotes?: string[];
  onTogglePin?: (note: string) => void;
  // Owner: "documents can have that document svg icon ... conversations can have the chat [icon]".
  // Resolves each leaf to what it actually is so the row shows the right glyph and opens the right thing.
  leafKind?: (label: string) => "doc" | "conversation" | "note";
}): JSX.Element {
  const isOpen = forceOpen || Boolean(expanded[folder.name]);
  return (
    <div className="memory-tree-group">
      <button className="memory-tree-row folder" type="button" style={{ paddingLeft: `${depth * 14 + 10}px` }} onClick={() => onToggle(folder.name)}>
        <ChevronRight className={isOpen ? "open" : ""} size={14} />
        <span>{folder.name}</span>
      </button>
      {isOpen ? (
        <>
          {folder.children?.map((child) => (
            <MemoryTreeFolder
              key={child.name}
              depth={depth + 1}
              expanded={expanded}
              folder={child}
              onPick={onPick}
              onToggle={onToggle}
              forceOpen={forceOpen}
              pinnedNotes={pinnedNotes}
              onTogglePin={onTogglePin}
              leafKind={leafKind}
            />
          ))}
          {folder.notes?.map((note) => {
            const kind = leafKind ? leafKind(note) : "note";
            return (
            <div key={note} className="memory-tree-row note" style={{ paddingLeft: `${(depth + 1) * 14 + 20}px` }}>
              <button type="button" className="memory-tree-note-label" onClick={() => onPick(note)}>
                {kind === "doc" ? <FileText size={12} /> : kind === "conversation" ? <MessageCircle size={12} /> : null}
                <span>{note}</span>
              </button>
              {onTogglePin ? (
                <button
                  type="button"
                  className={`memory-tree-pin ${pinnedNotes?.includes(note) ? "pinned" : ""}`}
                  aria-label={pinnedNotes?.includes(note) ? `Unpin ${note}` : `Pin ${note}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePin(note);
                  }}
                >
                  <Pin size={11} />
                </button>
              ) : null}
            </div>
            );
          })}
        </>
      ) : null}
    </div>
  );
}

function MemoryGraphPanel(): JSX.Element {
  return (
    <aside className="palette utility-panel" aria-label="Memory graph">
      <header className="panel-head">
        <span>
          <small>Context graph</small>
          <h2>Graph View</h2>
        </span>
        <Network size={18} />
      </header>
      <div className="library-panel">
        <PanelRow icon={<Network size={16} />} title="Conversation graph" detail="Logs, notes, tasks, and files as linked nodes instead of one dumped context blob." />
        <PanelRow icon={<Search size={16} />} title="Traversal retrieval" detail="Follow relevant links first, then expand only when the route needs more evidence." />
        <PanelRow icon={<ClipboardList size={16} />} title="Token budget view" detail="Show what was loaded, why it was loaded, and what stayed out of context." />
      </div>
      <footer className="palette-foot">This is separate from Orchestration. Orchestration routes work; Graph View explains and retrieves memory.</footer>
    </aside>
  );
}

function BenchmarkWorkspace({
  locked,
  onComplete,
  onWizardChange,
  wizard
}: {
  locked: boolean;
  onComplete: () => void;
  onWizardChange: (next: BenchmarkWizardState | ((current: BenchmarkWizardState) => BenchmarkWizardState)) => void;
  wizard: BenchmarkWizardState;
}): JSX.Element {
  const setWizard = onWizardChange;
  const [gpuId, setGpuId] = useState("rtx3060");
  const runChecks = ["Preflight hardware check", "Prompt suite loaded", "Simulated decode/VRAM capture", "Recommendation generated"];

  useEffect(() => {
    if (wizard.step !== "running" || wizard.status !== "running") return;
    const id = window.setInterval(() => {
      setWizard((current) => {
        if (current.step !== "running" || current.status !== "running") return current;
        const nextProgress = Math.min(100, current.progress + 14);
        if (nextProgress < 100) {
          return { ...current, progress: nextProgress, completedChecks: runChecks.slice(0, Math.max(1, Math.floor(nextProgress / 28))), updatedAt: new Date().toISOString() };
        }
        return { ...current, status: "complete", progress: 100, completedChecks: runChecks, updatedAt: new Date().toISOString() };
      });
    }, 480);
    return () => window.clearInterval(id);
  }, [setWizard, wizard.status, wizard.step]);

  const gpu = GPUS.find((item) => item.id === gpuId) ?? GPUS[0];
  const scored: ScoredModel[] = useMemo(() => LOCAL_MODELS.map((model) => ({ ...model, fit: fitFor(gpu.vram, model.vram) })), [gpu.vram]);
  const greatFits = scored.filter((model) => model.fit === "great");
  const usableFits = scored.filter((model) => model.fit === "great" || model.fit === "tight");
  const router = greatFits[0] ?? usableFits[0] ?? scored[0];
  const workhorse = usableFits[usableFits.length - 1] ?? router;

  const [ollamaInfo, setOllamaInfo] = useState<OllamaListResult | null>(null);
  const [pullProgress, setPullProgress] = useState<Record<string, OllamaPullProgress>>({});

  useEffect(() => {
    if (!window.metisOllama) return;
    let alive = true;
    void window.metisOllama.list().then((info) => {
      if (alive) setOllamaInfo(info);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!window.metisOllama) return;
    return window.metisOllama.onPullProgress((progress) => {
      setPullProgress((current) => ({ ...current, [progress.model]: progress }));
      if (progress.done && !progress.error) {
        setOllamaInfo((current) =>
          current ? { ...current, installed: current.installed.includes(progress.model) ? current.installed : [...current.installed, progress.model] } : current
        );
      }
    });
  }, []);

  const installTargets = useMemo(() => {
    const tags = [router.ollamaTag, workhorse.ollamaTag].filter((tag): tag is string => Boolean(tag));
    return Array.from(new Set(tags)).map((tag) => {
      const source = tag === router.ollamaTag ? router : workhorse;
      return { tag, name: source.name };
    });
  }, [router, workhorse]);

  const manualModels = useMemo(() => {
    const names = new Set<string>();
    if (!router.ollamaTag) names.add(router.name);
    if (!workhorse.ollamaTag) names.add(workhorse.name);
    return Array.from(names);
  }, [router, workhorse]);

  function targetStatus(tag: string): "installed" | "downloading" | "error" | "pending" {
    if (ollamaInfo?.installed.includes(tag)) return "installed";
    const progress = pullProgress[tag];
    if (progress) {
      if (progress.error) return "error";
      if (progress.done) return "installed";
      return "downloading";
    }
    return "pending";
  }

  const ollamaReachable = Boolean(window.metisOllama) && ollamaInfo?.reachable !== false;
  const anyDownloading = installTargets.some((target) => targetStatus(target.tag) === "downloading");
  const allInstalled = installTargets.length > 0 && installTargets.every((target) => targetStatus(target.tag) === "installed");

  function pullTag(tag: string): void {
    if (!window.metisOllama) return;
    setPullProgress((current) => ({ ...current, [tag]: { model: tag, status: "pulling manifest", done: false } }));
    void window.metisOllama.pull(tag);
  }

  function installRecommendedSetup(): void {
    for (const target of installTargets) {
      if (targetStatus(target.tag) !== "installed") pullTag(target.tag);
    }
  }

  function applySetup(): void {
    setWizard((current) => ({
      ...current,
      step: "review",
      status: "complete",
      progress: 100,
      completedChecks: ["Hardware matched", "Recommendation generated"],
      recommendation: {
        preset: "Balanced local-first router",
        model: `${router.name} router · ${workhorse.name} workhorse · Claude fallback`,
        summary: `Matched to your ${gpu.label} (${gpu.note}). Local routes handle fast / private work and hard prompts escalate to a cloud fallback.`,
        next: ["Open Orchestration and tweak the routes", "Add a cloud fallback for design-heavy work", "Run a full benchmark when you install a new model"]
      },
      updatedAt: new Date().toISOString()
    }));
    onComplete();
  }

  function startRun(): void {
    setWizard((current) => ({ ...current, step: "running", status: "running", progress: 0, completedChecks: [], updatedAt: new Date().toISOString() }));
  }

  const running = wizard.step === "running" && wizard.status === "running";

  return (
    <main className="product-workspace benchmark-workspace" aria-label="Hardware and models">
      <section className="product-hero">
        <span className="hero-icon">
          <Cpu size={20} />
        </span>
        <div>
          <small>Metis Benchmark</small>
          <h1>Hardware &amp; models</h1>
          <p>Metis matched your hardware to a recommended local setup from existing benchmark data — no run required. Run a full benchmark later for proof-grade numbers.</p>
        </div>
        <span className={`wizard-status-pill ${locked ? "locked" : "complete"}`}>
          {locked ? <Loader2 size={14} /> : <CheckCircle2 size={14} />}
          {locked ? "Setup required" : "Setup ready"}
        </span>
      </section>

      <div className="bench-grid">
        <section className="bench-panel">
          <header className="bench-panel-head">
            <span><Monitor size={15} /> Detected hardware</span>
            <label className="bench-select">
              GPU
              <CustomSelect
                ariaLabel="Detected GPU"
                value={gpuId}
                onChange={setGpuId}
                options={GPUS.map((item) => ({ value: item.id, label: item.label, hint: item.note }))}
              />
            </label>
          </header>
          <div className="bench-specs">
            <div className="stat-cell">
              <small>GPU</small>
              <strong>{gpu.label}</strong>
            </div>
            <div className="stat-cell">
              <small>VRAM</small>
              <strong>{gpu.vram ? `${gpu.vram} GB` : "—"}</strong>
            </div>
            <div className="stat-cell">
              <small>System RAM</small>
              <strong>32 GB</strong>
            </div>
            <div className="stat-cell">
              <small>Match</small>
              <strong>Existing data</strong>
            </div>
          </div>
          <p className="bench-note">
            <ShieldCheck size={14} /> Recommendations come from Metis&rsquo;s model-on-hardware dataset. Nothing runs on your machine until you ask it to.
          </p>
        </section>

        <section className="bench-panel rec-panel">
          <header className="bench-panel-head">
            <span><Sparkles size={15} /> Recommended setup</span>
            <em className="auto-tag">Auto-picked</em>
          </header>
          <div className="rec-chain">
            <RecSlot role="Router" model={router} />
            <ArrowRight className="rec-arrow" size={16} />
            <RecSlot role="Workhorse" model={workhorse} />
            <ArrowRight className="rec-arrow" size={16} />
            <RecSlot role="Fallback" cloud="Sonnet 4.6" provider="claude" />
          </div>
          <p className="bench-summary">Matched to your {gpu.label}. Local models handle fast / private work; hard prompts escalate to a cloud fallback.</p>
          <div className="bench-actions">
            <button className="primary-action" type="button" onClick={applySetup}>
              {locked ? "Use this setup" : "Update setup"} <ArrowRight size={16} />
            </button>
            {!locked ? (
              <button className="ghost-action" type="button" onClick={onComplete}>
                Open Orchestration
              </button>
            ) : null}
          </div>
        </section>
      </div>

      <section className="bench-panel">
        <header className="bench-panel-head">
          <span><HardDrive size={15} /> Local models for {gpu.label}</span>
          <em className="bench-count">{scored.filter((model) => model.fit !== "over").length} run here</em>
        </header>
        <div className="model-table">
          {scored.map((model) => (
            <div key={model.name} className={`model-row ${model.fit}`}>
              <span className="model-id">
                <span className="model-logo">{model.provider ? <img alt="" src={PROVIDERS[model.provider].logo} /> : <Cpu size={16} />}</span>
                <span className="model-name">
                  <strong>{model.name}</strong>
                  <small>{model.role}</small>
                </span>
              </span>
              <span className="model-spec">
                <small>Params</small>
                {model.params}
              </span>
              <span className="model-spec">
                <small>VRAM</small>
                {model.vram} GB
              </span>
              <span className="model-spec">
                <small>Quant</small>
                {model.quant}
              </span>
              <span className="model-spec">
                <small>Speed</small>~{model.tps} tok/s
              </span>
              <span className={`fit-badge ${model.fit}`}>{fitLabel(model.fit)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="bench-panel bench-install">
        <header className="bench-panel-head">
          <span><Download size={15} /> Install recommended models</span>
          {ollamaReachable && allInstalled ? <em className="auto-tag">Ready</em> : null}
        </header>
        <p className="bench-note">
          Pulls the router and workhorse above straight from Ollama, with live progress. &ldquo;Use this setup&rdquo; already completes setup either way &mdash; installing just gets the models onto disk.
        </p>

        {!ollamaReachable ? (
          <p className="bench-note install-unavailable">
            <ShieldAlert size={14} /> Ollama not detected &mdash; start Ollama (or install it) to pull models from here.
          </p>
        ) : (
          <>
            <div className="install-rows">
              {installTargets.map((target) => {
                const status = targetStatus(target.tag);
                const progress = pullProgress[target.tag];
                const pct = progress?.completed && progress?.total ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : null;
                return (
                  <div key={target.tag} className={`install-row ${status}`}>
                    <span className="install-model">
                      <strong>{target.name}</strong>
                      <small>{target.tag}</small>
                    </span>
                    <span className="install-state">
                      {status === "installed" ? (
                        <span className="install-installed">
                          <CheckCircle2 size={14} /> Installed
                        </span>
                      ) : status === "downloading" ? (
                        <span className="install-progress">
                          <span className="install-bar-shell">
                            <span className={pct === null ? "install-bar indeterminate" : "install-bar"} style={pct === null ? undefined : { width: `${pct}%` }} />
                          </span>
                          <small>
                            {progress?.status ?? "downloading"}
                            {pct !== null ? ` · ${pct}%` : ""}
                          </small>
                        </span>
                      ) : status === "error" ? (
                        <span className="install-error">
                          <ShieldAlert size={13} /> {progress?.error ?? "Pull failed"}
                          <button type="button" className="ghost-action install-retry" onClick={() => pullTag(target.tag)}>
                            <RefreshCw size={12} /> Retry
                          </button>
                        </span>
                      ) : (
                        <small className="install-pending">Not installed</small>
                      )}
                    </span>
                  </div>
                );
              })}
              {manualModels.map((name) => (
                <div key={name} className="install-row manual">
                  <span className="install-model">
                    <strong>{name}</strong>
                    <small>no public Ollama tag</small>
                  </span>
                  <span className="install-state">
                    <small className="install-pending">Manual install</small>
                  </span>
                </div>
              ))}
            </div>
            <div className="bench-actions">
              {allInstalled ? (
                <span className="install-installed install-done">
                  <CheckCircle2 size={16} /> All models installed
                </span>
              ) : (
                <button
                  className="primary-action"
                  type="button"
                  onClick={installRecommendedSetup}
                  disabled={anyDownloading || installTargets.length === 0}
                >
                  {anyDownloading ? <Loader2 size={16} className="spin" /> : <Download size={16} />} Install recommended setup
                </button>
              )}
            </div>
          </>
        )}

        <div className="install-skills">
          <small className="install-skills-label">Recommended skills</small>
          <div className="chip-row">
            {["Planning", "Agentic Tasks", "UI Design"].map((skill) => (
              <span key={skill} className="preset-chip">
                {skill}
              </span>
            ))}
          </div>
          <p className="bench-note">Manage skill installs in the Marketplace.</p>
        </div>
      </section>

      <section className="bench-panel advanced">
        <header className="bench-panel-head">
          <span><Play size={15} /> Run a full benchmark</span>
          <em className="optional-tag">optional</em>
        </header>
        <p className="bench-note">For leaderboard-grade numbers or after installing a new model. The recommendation above is enough to start.</p>
        {running ? (
          <>
            <div className="progress-shell">
              <span style={{ width: `${wizard.progress}%` }} />
            </div>
            <div className="run-log">
              {runChecks.map((check) => (
                <div key={check} className={wizard.completedChecks.includes(check) ? "complete" : ""}>
                  {wizard.completedChecks.includes(check) ? <CheckCircle2 size={15} /> : <Loader2 size={15} />}
                  <span>{check}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="bench-actions">
            <button className="ghost-action" type="button" onClick={startRun}>
              <Play size={15} /> Run benchmark (simulated)
            </button>
            <a className="repo-link" href="https://github.com/lachydotmcg/metis" rel="noreferrer" target="_blank">
              <GitBranch size={15} /> github.com/lachydotmcg/metis
            </a>
          </div>
        )}
      </section>
    </main>
  );
}

function RecSlot({ role, model, cloud, provider }: { role: string; model?: ScoredModel; cloud?: string; provider?: ProviderId }): JSX.Element {
  const logoProvider = model?.provider ?? provider;
  return (
    <span className="rec-slot">
      <small>{role}</small>
      <span className="rec-slot-main">
        <span className="model-logo">{logoProvider ? <img alt="" src={PROVIDERS[logoProvider].logo} /> : <Cpu size={15} />}</span>
        <strong>{model ? model.name : cloud}</strong>
      </span>
    </span>
  );
}

function MetricCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="metric-card">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

// One-time sample purge (docs/FABLE_PLANS.md section 23b): the earlier "real images only"
// cleanup (section 23) only stopped seeding NEW installs — owners with a persisted store from
// before that change still have the old seeded board+images. This strips the known seed shape
// (board id "client-websites" with images "cw-1".."cw-4" — see the pre-section-23 seed in git
// history at commit 1e25c68) and, if that leaves the seeded board with zero images, drops the
// board too. Anything else (user-created boards/images, even ones that happen to be empty) is
// left untouched.
//
// Match is by id ONLY (not src/mime) — some installs rasterized the seed svgs to PNG at some
// point, so an `src.startsWith("data:image/svg+xml")` guard silently stopped matching them. The
// id set is fixed and known (cw-1..cw-4 on client-websites only), so dropping the mime check
// can't touch a user's own images regardless of format.
//
// This runs every time GalleryWorkspace mounts (see the effect below) rather than being gated by
// a persisted "already ran" flag — the function is idempotent (no-op once the seed is gone), so
// re-running it on every Gallery visit is simpler and correct, and it means an owner on an older
// build that already "ran" a stricter purge once still gets the broadened check applied next
// time they open the tab, with no version bump needed.
const SEED_BOARD_ID = "client-websites";
const SEED_IMAGE_IDS = new Set(["cw-1", "cw-2", "cw-3", "cw-4"]);

function purgeSeededGalleryBoards(current: GalleryBoard[]): GalleryBoard[] {
  let mutated = false;
  const next = current
    .map((board) => {
      if (board.id !== SEED_BOARD_ID) return board;
      const filteredImages = board.images.filter((image) => !SEED_IMAGE_IDS.has(image.id));
      if (filteredImages.length === board.images.length) return board;
      mutated = true;
      return { ...board, images: filteredImages };
    })
    .filter((board) => !(board.id === SEED_BOARD_ID && board.images.length === 0));
  if (!mutated && next.length === current.length) return current;
  return next;
}

function GalleryWorkspace({ boards, onBoardsChange }: { boards: GalleryBoard[]; onBoardsChange: (next: GalleryBoard[] | ((current: GalleryBoard[]) => GalleryBoard[])) => void }): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const headerFileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedBoard = boards.find((board) => board.id === selectedId) ?? null;
  // Style memory (docs/FABLE_PLANS.md section 4): cards come from window.metisGallery, keyed by
  // imageId. Loaded once on mount (guarded for preview, where the bridge doesn't exist) and again
  // after each "Analyze board" run so the palette strips/captions show up immediately.
  const [cards, setCards] = useState<StyleCard[]>([]);
  const [analyzingBoardId, setAnalyzingBoardId] = useState<string | null>(null);
  const [hoveredImageId, setHoveredImageId] = useState<string | null>(null);
  // Selecting an image (docs/FABLE_PLANS.md section 23b): a click selects the image; its
  // title/description/mood-tags then surface for click-to-edit-in-place in the header cluster
  // (same interaction as the board title), and a Delete image action becomes available.
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<"board-title" | "image-title" | "image-caption" | null>(null);
  const [fieldDraft, setFieldDraft] = useState("");
  const [moodDraft, setMoodDraft] = useState("");
  const [deleteImageArmed, setDeleteImageArmed] = useState(false);
  const [reanalyzingImageId, setReanalyzingImageId] = useState<string | null>(null);
  // Delete-board affordance on the grid card (owner: no way to remove a board). Arm-then-confirm,
  // same UX as deleteSelectedImage above — first click arms a 3s confirm window, second click within
  // it actually removes the board.
  const [deleteBoardArmedId, setDeleteBoardArmedId] = useState<string | null>(null);

  const refreshCards = useCallback(async () => {
    if (!window.metisGallery) return;
    try {
      setCards(await window.metisGallery.cards());
    } catch {
      /* gallery bridge may be unavailable mid-session */
    }
  }, []);

  useEffect(() => {
    void refreshCards();
  }, [refreshCards]);

  // One-time sample purge (docs/FABLE_PLANS.md section 23b) — runs once when boards first load
  // from the persisted store. purgeSeededGalleryBoards is a no-op (returns the same reference)
  // once the seed is gone, so this settles after the first mutation and never loops.
  useEffect(() => {
    onBoardsChange((current) => purgeSeededGalleryBoards(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSelectedImageId(null);
    setEditingField(null);
    setDeleteImageArmed(false);
  }, [selectedId]);

  const selectedImage = selectedBoard?.images.find((image) => image.id === selectedImageId) ?? null;
  const selectedCard = selectedBoard && selectedImage ? cardFor(selectedBoard.id, selectedImage.id) : undefined;

  // Mood-tags input is a plain controlled field (not click-to-edit like title/caption), so its
  // draft needs to re-sync whenever the selected image (or its card) changes underneath it.
  useEffect(() => {
    setMoodDraft((selectedCard?.moodTags ?? selectedImage?.tags ?? []).join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedImageId, selectedCard?.moodTags]);

  function cardFor(boardId: string, imageId: string): StyleCard | undefined {
    return cards.find((card) => card.boardId === boardId && card.imageId === imageId);
  }

  function startEditBoardTitle(board: GalleryBoard): void {
    setEditingField("board-title");
    setFieldDraft(board.title);
  }

  function startEditImageTitle(image: GalleryImage, card: StyleCard | undefined): void {
    setEditingField("image-title");
    setFieldDraft(card?.title ?? image.title);
  }

  function startEditImageCaption(image: GalleryImage, card: StyleCard | undefined): void {
    setEditingField("image-caption");
    setFieldDraft(card?.caption ?? image.analysis);
  }

  function cancelFieldEdit(): void {
    setEditingField(null);
  }

  async function commitFieldEdit(boardId: string): Promise<void> {
    const value = fieldDraft.trim();
    if (editingField === "board-title") {
      if (value) updateBoard(boardId, { title: value });
      setEditingField(null);
      return;
    }
    if ((editingField === "image-title" || editingField === "image-caption") && selectedImageId) {
      const patch = editingField === "image-title" ? { title: value } : { caption: value };
      if (window.metisGallery) {
        try {
          const updated = await window.metisGallery.updateCard(selectedImageId, boardId, patch);
          setCards((current) => {
            const rest = current.filter((card) => card.imageId !== updated.imageId);
            return [...rest, updated];
          });
        } catch {
          /* edit still applies locally even if persistence fails */
        }
      }
    }
    setEditingField(null);
  }

  async function commitMoodTags(boardId: string, image: GalleryImage): Promise<void> {
    const moodTags = moodDraft
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    if (window.metisGallery) {
      try {
        const updated = await window.metisGallery.updateCard(image.id, boardId, { moodTags });
        setCards((current) => {
          const rest = current.filter((card) => card.imageId !== updated.imageId);
          return [...rest, updated];
        });
      } catch {
        /* leave existing cards in place on failure */
      }
    }
  }

  async function deleteSelectedImage(board: GalleryBoard): Promise<void> {
    if (!selectedImageId) return;
    if (!deleteImageArmed) {
      setDeleteImageArmed(true);
      window.setTimeout(() => setDeleteImageArmed(false), 3000);
      return;
    }
    const imageId = selectedImageId;
    onBoardsChange((current) =>
      current.map((item) => {
        if (item.id !== board.id) return item;
        const images = item.images.filter((image) => image.id !== imageId);
        // Cover follows the latest remaining image (docs/FABLE_PLANS.md section 23c).
        return { ...item, images, coverImage: images.length > 0 ? images[images.length - 1].src : "" };
      })
    );
    setCards((current) => current.filter((card) => card.imageId !== imageId));
    setSelectedImageId(null);
    setDeleteImageArmed(false);
    if (window.metisGallery) {
      try {
        await window.metisGallery.deleteCard(imageId);
      } catch {
        /* orphan card, harmless */
      }
    }
  }

  async function reanalyzeSelectedImage(board: GalleryBoard, image: GalleryImage): Promise<void> {
    if (!window.metisGallery || reanalyzingImageId) return;
    setReanalyzingImageId(image.id);
    try {
      const card = await window.metisGallery.analyzeImage(board.id, image.id);
      if (card) {
        setCards((current) => [...current.filter((entry) => entry.imageId !== card.imageId), card]);
      }
    } catch {
      /* keep the existing card on failure */
    } finally {
      setReanalyzingImageId(null);
    }
  }

  async function analyzeBoard(board: GalleryBoard): Promise<void> {
    if (!window.metisGallery || analyzingBoardId) return;
    setAnalyzingBoardId(board.id);
    try {
      await window.metisGallery.analyzeBoard(board.id);
      await refreshCards();
    } catch {
      /* leave existing cards in place on failure */
    } finally {
      setAnalyzingBoardId(null);
    }
  }

  function updateBoard(id: string, patch: Partial<GalleryBoard>): void {
    onBoardsChange((current) => current.map((board) => (board.id === id ? { ...board, ...patch } : board)));
  }

  function deleteBoard(board: GalleryBoard): void {
    if (deleteBoardArmedId !== board.id) {
      setDeleteBoardArmedId(board.id);
      window.setTimeout(() => setDeleteBoardArmedId((current) => (current === board.id ? null : current)), 3000);
      return;
    }
    setDeleteBoardArmedId(null);
    onBoardsChange((current) => current.filter((item) => item.id !== board.id));
    if (window.metisGallery) {
      for (const image of board.images) {
        void window.metisGallery.deleteCard(image.id).catch(() => {
          /* best-effort — board removal already went through */
        });
      }
    }
  }

  function addBoard(): void {
    const id = `board-${Date.now()}`;
    const image = makeGalleryThumb("New Board", "#111827", "#64748b");
    onBoardsChange((current) => [
      ...current,
      { id, title: "Untitled board", description: "Drop references here and turn them into a route-aware skill.", coverImage: image, images: [], tags: [], linkedSkill: false }
    ]);
    setSelectedId(id);
  }

  function importFiles(files: FileList | File[], board: GalleryBoard): void {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    void Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<GalleryImage>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                id: `image-${Date.now()}-${file.name}`,
                src: String(reader.result),
                title: file.name.replace(/\.[^.]+$/, ""),
                tags: ["imported", "needs analysis"],
                analysis: "Not analysed yet — run Analyze board."
              });
            };
            reader.readAsDataURL(file);
          })
      )
    ).then((images) => {
      onBoardsChange((current) =>
        current.map((item) => {
          if (item.id !== board.id) return item;
          // Adding a real image to the seed board also clears any leftover cw-* seed images in
          // the same update (the owner's expectation: "remove it when someone adds an image"),
          // not just on the next purge pass.
          const baseImages = item.id === SEED_BOARD_ID ? item.images.filter((image) => !SEED_IMAGE_IDS.has(image.id)) : item.images;
          const nextImages = [...baseImages, ...images];
          // Board cover always tracks the most recently added image (docs/FABLE_PLANS.md section 23c).
          return { ...item, coverImage: images[images.length - 1].src, images: nextImages };
        })
      );
    });
  }

  if (selectedBoard) {
    const boardCardCount = selectedBoard.images.filter((image) => cardFor(selectedBoard.id, image.id)).length;
    const isAnalyzing = analyzingBoardId === selectedBoard.id;
    const isEditingBoardTitle = editingField === "board-title";
    const isEditingImageTitle = editingField === "image-title";
    const isEditingImageCaption = editingField === "image-caption";
    return (
      <main className="product-workspace gallery-workspace" aria-label="Gallery board">
        <section
          className="gallery-board-head"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            importFiles(event.dataTransfer.files, selectedBoard);
          }}
        >
          <button type="button" onClick={() => setSelectedId(null)}>
            <ChevronLeft size={16} /> Boards
          </button>
          <span className="hero-icon"><GalleryHorizontalEnd size={19} /></span>
          <div className="gallery-board-head-title">
            <small>Board title</small>
            {isEditingBoardTitle ? (
              <input
                autoFocus
                value={fieldDraft}
                onChange={(event) => setFieldDraft(event.target.value)}
                onBlur={() => void commitFieldEdit(selectedBoard.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void commitFieldEdit(selectedBoard.id);
                  if (event.key === "Escape") cancelFieldEdit();
                }}
              />
            ) : (
              <button type="button" className="click-to-edit" onClick={() => startEditBoardTitle(selectedBoard)}>
                {selectedBoard.title}
              </button>
            )}
          </div>

          <div className="gallery-header-add-control">
            <button type="button" onClick={() => headerFileInputRef.current?.click()}>
              <ImagePlus size={15} /> Add images
            </button>
            <input
              ref={headerFileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => event.target.files && importFiles(event.target.files, selectedBoard)}
            />
          </div>
        </section>

        {boardCardCount > 0 ? (
          <p className="gallery-style-memory-note">
            Style memory: {boardCardCount} of {selectedBoard.images.length} images carded — used automatically as style references in builds.
          </p>
        ) : null}

        <section className="gallery-detail-grid">
          <aside className="gallery-board-meta">
            {selectedImage ? (
              <div className="gallery-image-editor">
                <img alt={selectedCard?.title ?? selectedImage.title} src={selectedImage.src} />
                {selectedCard && selectedCard.palette.some(Boolean) ? (
                  <div className="gallery-image-editor-field">
                    <small>Palette</small>
                    <div className="palette-strip" aria-label="Extracted palette">
                      {selectedCard.palette.filter(Boolean).map((hex, index) => (
                        <span key={`${hex}-${index}`} className="palette-swatch" style={{ background: hex }} title={hex} />
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="gallery-image-editor-field">
                  <small>Image title</small>
                  {isEditingImageTitle ? (
                    <input
                      autoFocus
                      value={fieldDraft}
                      onChange={(event) => setFieldDraft(event.target.value)}
                      onBlur={() => void commitFieldEdit(selectedBoard.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void commitFieldEdit(selectedBoard.id);
                        if (event.key === "Escape") cancelFieldEdit();
                      }}
                    />
                  ) : (
                    <button type="button" className="click-to-edit" onClick={() => startEditImageTitle(selectedImage, selectedCard)}>
                      {selectedCard?.title ?? selectedImage.title}
                    </button>
                  )}
                </div>
                <div className="gallery-image-editor-field">
                  <small>Description</small>
                  {isEditingImageCaption ? (
                    <textarea
                      autoFocus
                      rows={4}
                      value={fieldDraft}
                      onChange={(event) => setFieldDraft(event.target.value)}
                      onBlur={() => void commitFieldEdit(selectedBoard.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) void commitFieldEdit(selectedBoard.id);
                        if (event.key === "Escape") cancelFieldEdit();
                      }}
                    />
                  ) : (
                    <button type="button" className="click-to-edit" onClick={() => startEditImageCaption(selectedImage, selectedCard)}>
                      {selectedCard?.caption || selectedImage.analysis}
                    </button>
                  )}
                </div>
                <div className="gallery-image-editor-field">
                  <small>Mood tags</small>
                  <input
                    value={moodDraft}
                    placeholder={(selectedCard?.moodTags ?? selectedImage.tags).join(", ")}
                    onChange={(event) => setMoodDraft(event.target.value)}
                    onBlur={() => void commitMoodTags(selectedBoard.id, selectedImage)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void commitMoodTags(selectedBoard.id, selectedImage);
                    }}
                  />
                </div>
                {selectedCard ? (
                  <small className="gallery-image-editor-source">
                    {selectedCard.userEdited ? "edited by you" : selectedCard.source === "vision-model" ? `captioned by ${selectedCard.model ?? "vision model"}` : "palette only"}
                  </small>
                ) : null}
                <div className="gallery-image-editor-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={!window.metisGallery || reanalyzingImageId === selectedImage.id}
                    title={!window.metisGallery ? "unavailable in preview" : "Regenerate this image's caption, tags, and palette"}
                    onClick={() => void reanalyzeSelectedImage(selectedBoard, selectedImage)}
                  >
                    {reanalyzingImageId === selectedImage.id ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />}
                    {reanalyzingImageId === selectedImage.id ? "Reanalysing…" : "Reanalyse"}
                  </button>
                  <button
                    type="button"
                    className={`danger ${deleteImageArmed ? "armed" : ""}`}
                    onClick={() => void deleteSelectedImage(selectedBoard)}
                  >
                    <Trash2 size={13} />
                    {deleteImageArmed ? "Confirm" : "Delete image"}
                  </button>
                  <button type="button" className="ghost" onClick={() => setSelectedImageId(null)}>
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <>
                {selectedBoard.coverImage ? <img alt="" src={selectedBoard.coverImage} /> : null}
                <textarea value={selectedBoard.description} onChange={(event) => updateBoard(selectedBoard.id, { description: event.target.value })} />
                <div className="tag-row">
                  {selectedBoard.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
                <button
                  type="button"
                  disabled={!window.metisGallery || isAnalyzing || selectedBoard.images.length === 0}
                  title={!window.metisGallery ? "unavailable in preview" : undefined}
                  onClick={() => void analyzeBoard(selectedBoard)}
                >
                  {isAnalyzing ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />}
                  {isAnalyzing ? "Analyzing…" : "Analyze board"}
                </button>
                <button type="button" disabled><Cable size={15} /> Sync Pinterest board soon</button>
              </>
            )}
          </aside>

          <div
            className="gallery-image-area"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              importFiles(event.dataTransfer.files, selectedBoard);
            }}
          >
            <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={(event) => event.target.files && importFiles(event.target.files, selectedBoard)} style={{ display: "none" }} />
            {selectedBoard.images.length === 0 ? (
              <p className="gallery-image-area-empty">Drop images here, or use "Add images" above.</p>
            ) : null}
            <div className="image-masonry">
              {selectedBoard.images.map((image) => {
                const card = cardFor(selectedBoard.id, image.id);
                const hovered = hoveredImageId === image.id;
                const isSelected = selectedImageId === image.id;
                return (
                  <article
                    key={image.id}
                    className={`image-card ${isSelected ? "selected" : ""}`}
                    onMouseEnter={() => setHoveredImageId(image.id)}
                    onMouseLeave={() => setHoveredImageId((current) => (current === image.id ? null : current))}
                  >
                    <div
                      className="image-card-media"
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedImageId((current) => (current === image.id ? null : image.id))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") setSelectedImageId(image.id);
                      }}
                    >
                      <img alt={image.title} src={image.src} />
                      {card && hovered && !isSelected ? (
                        <div className="image-card-overlay">
                          <span className="image-card-source-badge">
                            {card.userEdited ? "edited" : card.source === "vision-model" ? card.model ?? "vision model" : "palette"}
                          </span>
                          <p className="image-card-caption">{card.caption}</p>
                          <div className="tag-row">
                            {card.moodTags.map((tag) => <span key={tag}>{tag}</span>)}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    {card ? (
                      <div className="palette-strip" aria-label="Extracted palette">
                        {card.palette.map((hex, index) => (
                          <span key={`${hex}-${index}`} className="palette-swatch" style={{ background: hex }} title={hex} />
                        ))}
                      </div>
                    ) : null}
                    <small className="image-card-name">{card?.title ?? image.title}</small>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="product-workspace gallery-workspace" aria-label="Gallery">
      <section className="product-hero">
        <span className="hero-icon"><GalleryHorizontalEnd size={20} /></span>
        <div>
          <small>Reference Gallery</small>
          <h1>Boards for visual memory</h1>
          <p>Collect references, title them, analyse them, and link the board into orchestration as a frontend-design skill.</p>
        </div>
        <div className="hero-actions">
          <button className="ghost-action" type="button" disabled><Cable size={15} /> Sync Pinterest soon</button>
          <button className="primary-action" type="button" onClick={addBoard}><Plus size={16} /> New board</button>
        </div>
      </section>

      <section className="board-grid">
        {boards.map((board) => (
          <div
            key={board.id}
            className="board-card"
            role="button"
            tabIndex={0}
            onClick={() => setSelectedId(board.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelectedId(board.id);
              }
            }}
          >
            <button
              type="button"
              className={`board-card-delete${deleteBoardArmedId === board.id ? " armed" : ""}`}
              aria-label={deleteBoardArmedId === board.id ? `Confirm delete ${board.title}` : `Delete ${board.title}`}
              title={deleteBoardArmedId === board.id ? "Click again to delete" : "Delete board"}
              onClick={(event) => {
                event.stopPropagation();
                deleteBoard(board);
              }}
            >
              {deleteBoardArmedId === board.id ? <Trash2 size={13} /> : <X size={13} />}
            </button>
            <span className="board-collage">
              {[board.coverImage, ...board.images.slice(0, 3).map((image) => image.src)]
                .filter(Boolean)
                .slice(0, 4)
                .map((src, index) => <img alt="" key={`${src}-${index}`} src={src} />)}
            </span>
            <span className="board-card-copy">
              <strong>{board.title}</strong>
              <small>{board.images.length} references</small>
            </span>
            <span className="tag-row">
              {board.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
            </span>
          </div>
        ))}
      </section>
    </main>
  );
}

/** Parses a package `source_url` into `{owner, repo}` when it points at a GitHub source —
 *  either `github.com/<owner>/<repo>` or `raw.githubusercontent.com/<owner>/<repo>/...`.
 *  Returns null for anything else so the caller can just hide the GitHub stats row. */
function parseGithubRepoRef(sourceUrl: string): GithubRepoRef | null {
  try {
    const url = new URL(sourceUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    if ((url.hostname === "github.com" || url.hostname === "raw.githubusercontent.com") && segments.length >= 2) {
      return { owner: segments[0], repo: segments[1].replace(/\.git$/, "") };
    }
  } catch {
    /* not a valid URL */
  }
  return null;
}

/** Fetches live stats for a GitHub-hosted package via the public REST API. Guards network errors
 *  and rate-limiting (403/404) by returning null — the detail view simply hides the stats row. */
async function fetchGithubRepoStats(ref: GithubRepoRef): Promise<GithubRepoStats | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { stargazers_count?: number; forks_count?: number; pushed_at?: string; html_url?: string };
    return {
      stars: data.stargazers_count ?? 0,
      forks: data.forks_count ?? 0,
      pushedAt: data.pushed_at ?? "",
      htmlUrl: data.html_url ?? `https://github.com/${ref.owner}/${ref.repo}`
    };
  } catch {
    return null;
  }
}

function marketplaceCategoryIcon(category: RegistryPackageKind | "all", size = 18): JSX.Element {
  if (category === "mcp") return <Plug size={size} />;
  if (category === "skill") return <ClipboardList size={size} />;
  if (category === "preset" || category === "pipeline" || category === "template") return <Star size={size} />;
  return <Sparkles size={size} />;
}

const MARKETPLACE_GROUP_LABEL: Record<DisplayKind, string> = {
  skill: "Skills",
  mcp: "MCP Connections",
  preset: "Presets"
};

function MarketplaceWorkspace(): JSX.Element {
  const [state, setState] = useAppStoreState("marketplaceState", DEFAULT_MARKETPLACE_STATE);
  const [packages, setPackages] = useState<RegistryPackage[]>(FALLBACK_MARKETPLACE_PACKAGES);
  const [installedPackages, setInstalledPackages] = useState<RegistryPackage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  // In-app starring (docs/FABLE_PLANS.md section 18, "Marketplace trust + detail"): purely local
  // for now, sorts a package to the front of its group's grid. Community-wide star counts need a
  // backend aggregating everyone's toggles — TODO, see §18 in FABLE_PLANS for the sketch.
  const [starredPackages, setStarredPackages] = useAppStoreState("starredPackages", EMPTY_STARRED_PACKAGES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [githubStats, setGithubStats] = useState<Record<string, GithubRepoStats | null>>({});
  const [readmeCache, setReadmeCache] = useState<Record<string, string | null>>({});
  const [publishOpen, setPublishOpen] = useState(false);
  const installedIds = useMemo(() => new Set(installedPackages.map((item) => item.id)), [installedPackages]);
  const starredSet = useMemo(() => new Set(starredPackages), [starredPackages]);

  const refreshPackages = useCallback(async () => {
    if (!window.metisRegistry) {
      setPackages(FALLBACK_MARKETPLACE_PACKAGES);
      return;
    }
    setLoading(true);
    try {
      const [nextRegistry, nextInstalled] = await Promise.all([window.metisRegistry.list(), window.metisRegistry.listInstalled()]);
      setPackages(nextRegistry.packages);
      setInstalledPackages(nextInstalled);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshPackages();
  }, [refreshPackages]);

  async function handleRefreshButton(): Promise<void> {
    if (!window.metisRegistry) {
      await refreshPackages();
      return;
    }
    setLoading(true);
    try {
      const next = await window.metisRegistry.refresh();
      setPackages(next.packages);
    } finally {
      setLoading(false);
    }
  }

  async function toggleInstall(item: RegistryPackage): Promise<void> {
    if (!window.metisRegistry) return;
    const installed = installedIds.has(item.id);
    setBusy(item.id);
    setCardErrors((current) => {
      const { [item.id]: _drop, ...rest } = current;
      return rest;
    });
    try {
      const next = installed ? await window.metisRegistry.uninstall(item.id) : await window.metisRegistry.install(item.id);
      setInstalledPackages(next);
    } catch (error) {
      setCardErrors((current) => ({ ...current, [item.id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => {
    const query = state.query.toLowerCase();
    return packages.filter((item) => {
      if (state.category !== "all" && displayKind(item.kind) !== state.category) return false;
      if (!query) return true;
      const haystack = `${item.name} ${item.description} ${item.publisher} ${item.tags.join(" ")}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [packages, state.category, state.query]);

  const groups = useMemo(() => {
    return filtered.reduce<Partial<Record<DisplayKind, RegistryPackage[]>>>((acc, item) => {
      const kind = displayKind(item.kind);
      acc[kind] = [...(acc[kind] ?? []), item];
      return acc;
    }, {});
  }, [filtered]);

  // Starred packages sort first within each group (owner feedback: stars are "a show of what's
  // trustable", so they should surface at the top rather than just carry a badge).
  const sortedGroups = useMemo(() => {
    const next: Partial<Record<DisplayKind, RegistryPackage[]>> = {};
    for (const [kind, items] of Object.entries(groups) as Array<[DisplayKind, RegistryPackage[]]>) {
      next[kind] = [...items].sort((a, b) => Number(starredSet.has(b.id)) - Number(starredSet.has(a.id)));
    }
    return next;
  }, [groups, starredSet]);

  function updateMarketplace(patch: Partial<MarketplaceState>): void {
    setState((current) => ({ ...current, ...patch }));
  }

  function toggleStar(id: string): void {
    setStarredPackages((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }

  const selectedPackage = selectedId ? packages.find((item) => item.id === selectedId) ?? null : null;

  // Fetches GitHub stats + the package's raw source text on demand (detail open only, per the
  // owner's scope note), caching per package id so re-opening a detail view is instant.
  useEffect(() => {
    if (!selectedPackage) return;
    const id = selectedPackage.id;
    if (!(id in githubStats)) {
      const ref = parseGithubRepoRef(selectedPackage.source_url);
      if (ref) {
        void fetchGithubRepoStats(ref).then((stats) => setGithubStats((current) => ({ ...current, [id]: stats })));
      } else {
        setGithubStats((current) => ({ ...current, [id]: null }));
      }
    }
    if (!(id in readmeCache)) {
      if (selectedPackage.source_url) {
        fetch(selectedPackage.source_url)
          .then((response) => (response.ok ? response.text() : null))
          .then((text) => setReadmeCache((current) => ({ ...current, [id]: text })))
          .catch(() => setReadmeCache((current) => ({ ...current, [id]: null })));
      } else {
        setReadmeCache((current) => ({ ...current, [id]: null }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPackage]);

  if (selectedPackage) {
    return (
      <MarketplaceDetailView
        item={selectedPackage}
        installed={installedIds.has(selectedPackage.id)}
        busy={busy === selectedPackage.id}
        error={cardErrors[selectedPackage.id]}
        starred={starredSet.has(selectedPackage.id)}
        githubStats={githubStats[selectedPackage.id] ?? null}
        readme={readmeCache[selectedPackage.id] ?? null}
        onBack={() => setSelectedId(null)}
        onToggleInstall={() => void toggleInstall(selectedPackage)}
        onToggleStar={() => toggleStar(selectedPackage.id)}
      />
    );
  }

  return (
    <main className="product-workspace marketplace-workspace" aria-label="Marketplace">
      <section className="marketplace-hero">
        <div>
          <small>Marketplace</small>
          <h1>Find skills, MCPs, and presets</h1>
        </div>
        <div className="hero-actions">
          <button type="button" className="ghost-action publish-open-button" onClick={() => setPublishOpen(true)}>
            <Upload size={15} />
            Publish a package
          </button>
          <button type="button" className="ghost-action" onClick={() => void handleRefreshButton()} disabled={loading}>
            {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            Refresh
          </button>
        </div>
      </section>
      <p className="marketplace-framing-hint">
        Installing shares nothing — it only adds a skill, MCP, or preset to your own orchestration. <strong>Publishing</strong> shares it with everyone via a registry pull request.
      </p>
      {publishOpen ? <PublishWizard onClose={() => setPublishOpen(false)} /> : null}
      <section className="marketplace-hero marketplace-hero-search">
        <label className="marketplace-search">
          <Search size={18} />
          <input value={state.query} placeholder="Search frontend, security, browser, local-first..." onChange={(event) => updateMarketplace({ query: event.target.value })} />
        </label>
        <div className="marketplace-tabs" role="tablist">
          {MARKETPLACE_CATEGORIES.map((category) => (
            <button key={category.key} className={state.category === category.key ? "active" : ""} type="button" onClick={() => updateMarketplace({ category: category.key })}>
              <span className="marketplace-tab-icon">{category.icon}</span>
              <span>
                <strong>{category.label}</strong>
                <small>{category.detail}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="marketplace-feed">
        {filtered.length === 0 ? <p className="marketplace-empty">No packages match this search.</p> : null}
        {(Object.entries(sortedGroups) as Array<[DisplayKind, RegistryPackage[]]>).map(([kind, items]) => (
          <div key={kind} className="marketplace-group">
            <header>
              <h2>{MARKETPLACE_GROUP_LABEL[kind]}</h2>
              <span>{items.length} item{items.length === 1 ? "" : "s"}</span>
            </header>
            <div className="marketplace-grid">
              {items.map((item) => {
                const installed = installedIds.has(item.id);
                const error = cardErrors[item.id];
                const isBusy = busy === item.id;
                const isStarred = starredSet.has(item.id);
                const cachedStars = githubStats[item.id]?.stars;
                return (
                  <article
                    key={item.id}
                    className="marketplace-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setSelectedId(item.id);
                    }}
                  >
                    {item.ascii_art?.length ? (
                      <pre className="marketplace-card-ascii" aria-hidden="true">{item.ascii_art.join("\n")}</pre>
                    ) : item.images?.length ? (
                      <img className="marketplace-card-image" alt="" src={item.images[0]} />
                    ) : (
                      <div className="marketplace-card-placeholder" aria-hidden="true">{marketplaceCategoryIcon(item.kind, 26)}</div>
                    )}
                    <span className="marketplace-card-head">
                      <span className="marketplace-icon">{marketplaceCategoryIcon(item.kind)}</span>
                      <small>{displayKind(item.kind)}</small>
                      {isStarred || cachedStars !== undefined ? (
                        <small className="marketplace-card-star-count">
                          <Star size={11} fill={isStarred ? "currentColor" : "none"} /> {cachedStars ?? ""}
                        </small>
                      ) : null}
                    </span>
                    <strong>{item.name}</strong>
                    <small className="marketplace-card-publisher">{item.publisher} · v{item.version}</small>
                    <p>{item.description}</p>
                    {item.tags.length ? (
                      <span className="marketplace-card-tags">
                        {item.tags.map((tag) => (
                          <em key={tag}>{tag}</em>
                        ))}
                      </span>
                    ) : null}
                    {item.permissions_requested.length ? (
                      <small className="marketplace-card-permissions">
                        <Shield size={11} /> {item.permissions_requested.join(", ")}
                      </small>
                    ) : null}
                    {error ? <small className="marketplace-card-error">{error}</small> : null}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleInstall(item);
                      }}
                      disabled={isBusy || !window.metisRegistry}
                    >
                      {isBusy ? <Loader2 size={14} className="spin" /> : null}
                      {installed ? "Installed · Uninstall" : "Install"}
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}

/** GitHub-repo-style detail view for a marketplace package (docs/FABLE_PLANS.md section 18):
 *  replaces the grid within the marketplace area (not a modal), with a back button, big header,
 *  banner (ascii art or image), GitHub stats when the source resolves to a repo, and the raw
 *  package payload rendered through the shared Markdown component so a skill reads like a README. */
function MarketplaceDetailView({
  busy,
  error,
  githubStats,
  installed,
  item,
  onBack,
  onToggleInstall,
  onToggleStar,
  readme,
  starred
}: {
  busy: boolean;
  error?: string;
  githubStats: GithubRepoStats | null;
  installed: boolean;
  item: RegistryPackage;
  onBack: () => void;
  onToggleInstall: () => void;
  onToggleStar: () => void;
  readme: string | null;
  starred: boolean;
}): JSX.Element {
  return (
    <main className="product-workspace marketplace-workspace marketplace-detail" aria-label={`${item.name} details`}>
      <button type="button" className="marketplace-detail-back" onClick={onBack}>
        <ArrowLeft size={15} /> Back to marketplace
      </button>

      {item.ascii_art?.length ? (
        <pre className="marketplace-detail-banner marketplace-detail-banner-ascii" aria-hidden="true">{item.ascii_art.join("\n")}</pre>
      ) : item.images?.length ? (
        <img className="marketplace-detail-banner" alt="" src={item.images[0]} />
      ) : null}

      <header className="marketplace-detail-head">
        <span className="marketplace-icon">{marketplaceCategoryIcon(item.kind, 22)}</span>
        <div>
          <h1>{item.name}</h1>
          <small>
            {item.publisher} · v{item.version}
          </small>
        </div>
        <span className="marketplace-detail-kind-chip">{displayKind(item.kind)}</span>
        <div className="marketplace-detail-actions">
          <button type="button" className={`marketplace-star-toggle ${starred ? "active" : ""}`} onClick={onToggleStar} aria-pressed={starred}>
            <Star size={15} fill={starred ? "currentColor" : "none"} /> {starred ? "Starred" : "Star"}
          </button>
          <button type="button" onClick={onToggleInstall} disabled={busy || !window.metisRegistry}>
            {busy ? <Loader2 size={14} className="spin" /> : null}
            {installed ? "Installed · Uninstall" : "Install"}
          </button>
        </div>
      </header>

      {error ? <small className="marketplace-card-error">{error}</small> : null}

      {githubStats ? (
        <div className="marketplace-detail-github">
          <span>
            <Star size={13} /> {githubStats.stars} stars
          </span>
          <span>
            <GitFork size={13} /> {githubStats.forks} forks
          </span>
          <span>Last push {githubStats.pushedAt ? new Date(githubStats.pushedAt).toLocaleDateString() : "unknown"}</span>
          <button type="button" className="ghost-action" onClick={() => openExternal(githubStats.htmlUrl)}>
            <Github size={13} /> View on GitHub
          </button>
        </div>
      ) : null}

      <p className="marketplace-detail-description">{item.description}</p>

      {item.tags.length ? (
        <span className="marketplace-card-tags marketplace-detail-tags">
          {item.tags.map((tag) => (
            <em key={tag}>{tag}</em>
          ))}
        </span>
      ) : null}

      {item.permissions_requested.length ? (
        <small className="marketplace-card-permissions">
          <Shield size={11} /> {item.permissions_requested.join(", ")}
        </small>
      ) : null}

      <section className="marketplace-detail-readme">{readme ? <Markdown>{readme}</Markdown> : <p className="marketplace-empty">No README available for this package.</p>}</section>
    </main>
  );
}

/** Registry GitHub identity (docs: the marketplace registry is human-merged PRs, no backend —
 *  see METIS_REGISTRY_BASE_URL in electron/main.ts, which reads from the same repo). Publishing
 *  therefore means: generate a valid manifest.json + optional payload file, then hand the user a
 *  pre-filled GitHub "create new file" URL so committing it opens a PR. There is no upload API. */
const METIS_REGISTRY_OWNER = "lachydotmcg";
const METIS_REGISTRY_NAME = "metis-registry";
const METIS_REGISTRY_HTML_URL = `https://github.com/${METIS_REGISTRY_OWNER}/${METIS_REGISTRY_NAME}`;

type PublishKind = "skill" | "mcp" | "preset";

const PUBLISH_PERMISSION_SCOPES: PermissionScope[] = [
  "filesystem.read",
  "filesystem.write",
  "network.provider",
  "network.web",
  "process.spawn",
  "mcp.invoke",
  "notifications.send"
];

/** Same slug rule main.ts/the registry expects for a package id: lowercase letters, digits,
 *  dots and dashes only, no leading/trailing separator. `<publisher>.<slug-of-name>` is just a
 *  convention the wizard suggests, not enforced — the id field stays freely editable. */
function slugifyPublishToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function suggestPackageId(publisher: string, name: string): string {
  const pub = slugifyPublishToken(publisher);
  const slug = slugifyPublishToken(name);
  if (pub && slug) return `${pub}.${slug}`;
  return pub || slug;
}

const PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

type PublishDraft = {
  kind: PublishKind;
  id: string;
  idTouched: boolean;
  name: string;
  version: string;
  publisher: string;
  description: string;
  tagsInput: string;
  permissions: PermissionScope[];
  sourceUrl: string;
  pastedContent: string;
  usePastedContent: boolean;
  asciiArt: string;
};

function emptyPublishDraft(publisher: string): PublishDraft {
  return {
    kind: "skill",
    id: "",
    idTouched: false,
    name: "",
    version: "1.0.0",
    publisher,
    description: "",
    tagsInput: "",
    permissions: [],
    sourceUrl: "",
    pastedContent: "",
    usePastedContent: false,
    asciiArt: ""
  };
}

/** Registry-relative payload path for whatever accompanies the manifest (skill content, or the
 *  serialized preset graph) — mirrors packages/<id>/manifest.json's sibling-file convention. */
function publishPayloadPath(draft: PublishDraft): string {
  return draft.kind === "preset" ? `packages/${draft.id}/preset.json` : `packages/${draft.id}/SKILL.md`;
}

function buildPublishManifest(draft: PublishDraft, presetPayload: unknown | null): { manifest: Record<string, unknown>; payloadText: string | null } {
  const tags = draft.tagsInput
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const kind: RegistryPackageKind = draft.kind;
  const usesPayloadFile = draft.kind === "preset" ? presetPayload !== null : draft.usePastedContent && draft.pastedContent.trim().length > 0;
  const sourceUrl = usesPayloadFile
    ? `https://raw.githubusercontent.com/${METIS_REGISTRY_OWNER}/${METIS_REGISTRY_NAME}/main/${publishPayloadPath(draft)}`
    : draft.kind === "preset"
      ? ""
      : draft.sourceUrl.trim();
  const manifest: Record<string, unknown> = {
    schema_version: "0.1.0",
    id: draft.id.trim(),
    kind,
    name: draft.name.trim(),
    version: draft.version.trim(),
    publisher: draft.publisher.trim(),
    description: draft.description.trim(),
    tags,
    permissions_requested: draft.permissions,
    source_url: sourceUrl
  };
  if (draft.asciiArt.trim()) manifest.ascii_art = draft.asciiArt.replace(/\r\n/g, "\n").split("\n");
  const payloadText = draft.kind === "preset" ? (presetPayload !== null ? JSON.stringify(presetPayload, null, 2) : null) : draft.usePastedContent ? draft.pastedContent : null;
  return { manifest, payloadText };
}

function validatePublishDraft(draft: PublishDraft, presetPayload: unknown | null): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("Name is required.");
  if (!draft.publisher.trim()) errors.push("Publisher handle is required.");
  if (!draft.version.trim()) errors.push("Version is required.");
  else if (!/^\d+\.\d+\.\d+/.test(draft.version.trim())) errors.push("Version should look like 1.0.0 (semver).");
  if (!draft.id.trim()) errors.push("Package id is required.");
  else if (!PACKAGE_ID_PATTERN.test(draft.id.trim())) errors.push("Package id must be lowercase letters, digits, dots and dashes only (e.g. lachy.my-skill).");
  if (!draft.description.trim()) errors.push("A short description helps people trust the package.");
  if (draft.kind === "preset") {
    if (presetPayload === null) errors.push("No saved preset found — save one from the Orchestration graph first (Save preset), then reopen this wizard.");
  } else if (!draft.usePastedContent && !draft.sourceUrl.trim()) {
    errors.push("Add a source URL, or paste the skill content instead.");
  } else if (draft.usePastedContent && !draft.pastedContent.trim()) {
    errors.push("Paste the skill content, or switch back to a source URL.");
  }
  return errors;
}

/** GitHub's "create new file" page accepts filename + prefilled value as query params — this is
 *  the entire "publish" mechanism, since the registry has no upload API (see module comment above
 *  MarketplaceWorkspace / METIS_REGISTRY_BASE_URL in electron/main.ts). Committing on that page IS
 *  the first step of opening a PR. */
function githubNewFileUrl(path: string, content: string): string {
  return `${METIS_REGISTRY_HTML_URL}/new/main?filename=${encodeURIComponent(path)}&value=${encodeURIComponent(content)}`;
}

function githubEditFileUrl(path: string): string {
  return `${METIS_REGISTRY_HTML_URL}/edit/main/${path}`;
}

function PublishWizard({ onClose }: { onClose: () => void }): JSX.Element {
  const [publisherHandle, setPublisherHandle] = useAppStoreState("publisherHandle", "");
  const [draft, setDraft] = useState<PublishDraft>(() => emptyPublishDraft(publisherHandle));
  const [customSkills] = useAppStoreState("customSkills", EMPTY_CUSTOM_SKILLS);
  const [copied, setCopied] = useState(false);

  // Publisher handle only needs loading once the app-store value resolves — after that the wizard
  // owns it locally so retyping isn't fought by the async store round-trip.
  const publisherPrefilled = useRef(false);
  useEffect(() => {
    if (publisherPrefilled.current) return;
    if (publisherHandle) {
      setDraft((current) => (current.publisher ? current : { ...current, publisher: publisherHandle }));
      publisherPrefilled.current = true;
    }
  }, [publisherHandle]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function patch(next: Partial<PublishDraft>): void {
    setDraft((current) => {
      const merged = { ...current, ...next };
      if (!merged.idTouched && (next.name !== undefined || next.publisher !== undefined || next.kind !== undefined)) {
        merged.id = suggestPackageId(merged.publisher, merged.name);
      }
      return merged;
    });
  }

  const savedPreset = useMemo(() => {
    if (draft.kind !== "preset") return null;
    try {
      const raw = localStorage.getItem(PRESET_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      return null;
    }
  }, [draft.kind]);

  const { manifest, payloadText } = useMemo(() => buildPublishManifest(draft, savedPreset), [draft, savedPreset]);
  const errors = useMemo(() => validatePublishDraft(draft, savedPreset), [draft, savedPreset]);
  const manifestJson = useMemo(() => JSON.stringify(manifest, null, 2), [manifest]);
  const isValid = errors.length === 0;

  function togglePermission(scope: PermissionScope): void {
    setDraft((current) => ({
      ...current,
      permissions: current.permissions.includes(scope) ? current.permissions.filter((entry) => entry !== scope) : [...current.permissions, scope]
    }));
  }

  function copyManifest(): void {
    void navigator.clipboard?.writeText(manifestJson).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  function openManifestPr(): void {
    if (!isValid) return;
    setPublisherHandle(draft.publisher.trim());
    openExternal(githubNewFileUrl(`packages/${draft.id.trim()}/manifest.json`, manifestJson));
  }

  function openPayloadPr(): void {
    if (!isValid || !payloadText) return;
    openExternal(githubNewFileUrl(publishPayloadPath(draft), payloadText));
  }

  function fillFromCustomSkill(skillId: string): void {
    const skill = customSkills.find((entry) => entry.id === skillId);
    if (!skill) return;
    patch({ name: skill.name, description: skill.description ?? draft.description });
  }

  return (
    <>
      <button className="publish-backdrop" type="button" aria-label="Close publish wizard" onClick={onClose} />
      <div className="publish-modal" role="dialog" aria-label="Publish a package" aria-modal="true">
        <header className="publish-modal-head">
          <div>
            <h2>Publish to the marketplace</h2>
            <p className="publish-framing">
              Adding a skill or preset to your orchestration only lives on this machine — that stays personal. <strong>Publishing</strong> opens a pull request against{" "}
              <button type="button" className="publish-link-inline" onClick={() => openExternal(METIS_REGISTRY_HTML_URL)}>
                {METIS_REGISTRY_OWNER}/{METIS_REGISTRY_NAME}
              </button>{" "}
              so anyone can install it once it's merged.
            </p>
          </div>
          <button type="button" className="publish-modal-close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="publish-modal-body">
          <div className="publish-form">
            <div className="publish-kind-tabs" role="tablist" aria-label="Package kind">
              {(["skill", "mcp", "preset"] as PublishKind[]).map((kind) => (
                <button key={kind} type="button" role="tab" aria-selected={draft.kind === kind} className={draft.kind === kind ? "active" : ""} onClick={() => patch({ kind })}>
                  {kind === "mcp" ? "MCP" : kind[0].toUpperCase() + kind.slice(1)}
                </button>
              ))}
            </div>

            {draft.kind === "skill" && customSkills.length > 0 ? (
              <label className="publish-field">
                <span>Prefill from a custom skill (optional)</span>
                <select defaultValue="" onChange={(event) => event.target.value && fillFromCustomSkill(event.target.value)}>
                  <option value="">Choose a custom skill…</option>
                  {customSkills.map((skill) => (
                    <option key={skill.id} value={skill.id}>
                      {skill.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="publish-field">
              <span>Name</span>
              <input value={draft.name} placeholder="My Great Skill" onChange={(event) => patch({ name: event.target.value })} />
            </label>

            <div className="publish-field-row">
              <label className="publish-field">
                <span>Publisher handle</span>
                <input value={draft.publisher} placeholder="yourname" onChange={(event) => patch({ publisher: event.target.value })} />
              </label>
              <label className="publish-field">
                <span>Version</span>
                <input value={draft.version} placeholder="1.0.0" onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))} />
              </label>
            </div>

            <label className="publish-field">
              <span>Package id</span>
              <input
                value={draft.id}
                placeholder="yourname.my-great-skill"
                onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value, idTouched: true }))}
              />
              <small>Where the manifest will live: packages/{draft.id.trim() || "<id>"}/manifest.json</small>
            </label>

            <label className="publish-field">
              <span>Description</span>
              <textarea rows={2} value={draft.description} placeholder="What does this do, in one or two sentences?" onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
            </label>

            <label className="publish-field">
              <span>Tags (comma-separated)</span>
              <input value={draft.tagsInput} placeholder="frontend, local-first, security" onChange={(event) => setDraft((current) => ({ ...current, tagsInput: event.target.value }))} />
            </label>

            <div className="publish-field">
              <span>Permissions requested</span>
              <div className="publish-permission-grid">
                {PUBLISH_PERMISSION_SCOPES.map((scope) => (
                  <button key={scope} type="button" className={`publish-permission-chip ${draft.permissions.includes(scope) ? "active" : ""}`} onClick={() => togglePermission(scope)} aria-pressed={draft.permissions.includes(scope)}>
                    <Shield size={11} /> {scope}
                  </button>
                ))}
              </div>
            </div>

            {draft.kind === "preset" ? (
              <div className="publish-field">
                <span>Preset payload</span>
                {savedPreset ? (
                  <p className="publish-hint">
                    Using your saved preset from the Orchestration graph (saved {(savedPreset as { saved_at?: string })?.saved_at ? new Date((savedPreset as { saved_at?: string }).saved_at as string).toLocaleString() : "locally"}). It will be
                    committed as <code>{publishPayloadPath(draft)}</code>.
                  </p>
                ) : (
                  <p className="publish-hint publish-hint-warn">No saved preset yet — go to Orchestration and click "Save preset" first, then reopen this wizard.</p>
                )}
              </div>
            ) : (
              <>
                <label className="publish-toggle">
                  <input type="checkbox" checked={draft.usePastedContent} onChange={(event) => setDraft((current) => ({ ...current, usePastedContent: event.target.checked }))} />
                  <span>Paste the {draft.kind === "mcp" ? "MCP config" : "SKILL.md"} content instead of linking a source URL</span>
                </label>
                {draft.usePastedContent ? (
                  <label className="publish-field">
                    <span>Content</span>
                    <textarea
                      rows={8}
                      className="publish-monospace-input"
                      value={draft.pastedContent}
                      placeholder={draft.kind === "mcp" ? "MCP server config JSON…" : "# SKILL.md contents…"}
                      onChange={(event) => setDraft((current) => ({ ...current, pastedContent: event.target.value }))}
                    />
                    <small>Will be committed as <code>{publishPayloadPath(draft)}</code>; source_url points there automatically.</small>
                  </label>
                ) : (
                  <label className="publish-field">
                    <span>Source URL</span>
                    <input value={draft.sourceUrl} placeholder="https://raw.githubusercontent.com/you/repo/main/SKILL.md" onChange={(event) => setDraft((current) => ({ ...current, sourceUrl: event.target.value }))} />
                  </label>
                )}
              </>
            )}

            <label className="publish-field">
              <span>ASCII art preview (optional)</span>
              <textarea rows={4} className="publish-monospace-input" value={draft.asciiArt} placeholder={"  /\\_/\\ \n ( o.o )\n  > ^ <"} onChange={(event) => setDraft((current) => ({ ...current, asciiArt: event.target.value }))} />
            </label>
          </div>

          <div className="publish-preview">
            <div className="publish-preview-head">
              <span>manifest.json preview</span>
              <button type="button" className="ghost-action" onClick={copyManifest}>
                <Copy size={13} /> {copied ? "Copied" : "Copy manifest"}
              </button>
            </div>
            <pre className="publish-manifest-preview">{manifestJson}</pre>

            {draft.asciiArt.trim() ? <pre className="marketplace-card-ascii publish-ascii-preview">{draft.asciiArt}</pre> : null}

            {errors.length > 0 ? (
              <ul className="publish-errors">
                {errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : (
              <p className="publish-valid-note">
                <Check size={13} /> Manifest looks good.
              </p>
            )}

            <div className="publish-steps">
              <strong>To publish:</strong>
              <ol>
                <li>Open a pull request below — it opens GitHub's "create file" page pre-filled with your manifest (and payload, if any). Commit it.</li>
                <li>Add <code>{draft.id.trim() || "<id>"}</code> to <code>index.json</code> in the same PR.</li>
                <li>Open the pull request from GitHub — a human reviews and merges it.</li>
              </ol>
            </div>

            <div className="publish-actions">
              <button type="button" className="publish-primary" disabled={!isValid} onClick={openManifestPr}>
                <Github size={14} /> Open a pull request
              </button>
              {payloadText ? (
                <button type="button" className="ghost-action" disabled={!isValid} onClick={openPayloadPr}>
                  <Upload size={13} /> Open new-file for the payload
                </button>
              ) : null}
              <button type="button" className="ghost-action" onClick={() => openExternal(githubEditFileUrl("index.json"))}>
                <FileText size={13} /> Edit index.json
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

type TodoPriority = "high" | "medium" | "idea" | "none";
/** Who a to-do card is assigned to (docs/FABLE_PLANS.md — To-Do board as central feed):
 *  a fixed kind (unassigned/fable/manager) is self-describing; "conversation" and "agent"
 *  carry an id (+ a stored label as a fallback if the target no longer resolves). */
type TodoAssigneeKind = "unassigned" | "fable" | "manager" | "conversation" | "agent";
type TodoAssignee = { kind: TodoAssigneeKind; id?: string; label?: string };
type TodoCard = { id: string; title: string; priority: TodoPriority; done: boolean; assignee?: TodoAssignee };
type TodoColumn = { id: string; title: string; cards: TodoCard[] };
type TodoBoard = { columns: TodoColumn[] };

/** Managed-agent identities available as to-do assignees, forward-compatible with the
 *  auto-named agents from FABLE_PLANS section 3. Each gets a stable hue for its dot. */
const MANAGED_AGENT_IDENTITIES: { name: string; hue: number }[] = [
  { name: "Nyx", hue: 265 },
  { name: "Talos", hue: 200 },
  { name: "Echo", hue: 150 },
  { name: "Atlas", hue: 30 },
  { name: "Juno", hue: 330 }
];

/** Resolves a to-do assignee into what the card/filter UI renders: a label and a dot color.
 *  Missing `assignee` is treated as unassigned everywhere (persisted boards predate the field). */
function resolveTodoAssignee(assignee: TodoAssignee | undefined, storedConversations: ConversationRecord[]): { label: string; dotColor: string; muted?: boolean } {
  const kind = assignee?.kind ?? "unassigned";
  if (kind === "fable") return { label: "You", dotColor: "var(--accent)" };
  if (kind === "manager") return { label: "Manager", dotColor: "#56b6e0" };
  if (kind === "conversation") {
    const found = assignee?.id ? storedConversations.find((conversation) => conversation.id === assignee.id) : undefined;
    return { label: found?.title ?? assignee?.label ?? "Conversation", dotColor: "var(--muted)", muted: !found };
  }
  if (kind === "agent") {
    const identity = MANAGED_AGENT_IDENTITIES.find((agent) => agent.name === assignee?.id);
    return { label: assignee?.label ?? assignee?.id ?? "Agent", dotColor: identity ? `hsl(${identity.hue} 45% 62%)` : "var(--faint)" };
  }
  return { label: "Assign", dotColor: "var(--faint)", muted: true };
}

const TODO_PRIORITY_CYCLE: TodoPriority[] = ["none", "high", "medium", "idea"];
const TODO_PRIORITY_LABEL: Record<TodoPriority, string> = {
  high: "High priority",
  medium: "Medium priority",
  idea: "Idea",
  none: "No priority"
};
const TODO_PRIORITY_SHORT: Record<TodoPriority, string> = {
  high: "High",
  medium: "Med",
  idea: "Idea",
  none: ""
};

function todoId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const DEFAULT_TODO_BOARD: TodoBoard = {
  columns: [
    {
      id: "backlog",
      title: "Backlog",
      cards: [
        { id: todoId(), title: "Design the Manager window", priority: "high", done: false, assignee: { kind: "manager" } },
        { id: todoId(), title: "Newspaper / Home feed", priority: "idea", done: false },
        { id: todoId(), title: "Routines / Schedules surface", priority: "medium", done: false }
      ]
    },
    {
      id: "todo",
      title: "To do",
      cards: [{ id: todoId(), title: "Connect tasks to project conversations", priority: "medium", done: false, assignee: { kind: "fable" } }]
    },
    {
      id: "doing",
      title: "In progress",
      cards: [{ id: todoId(), title: "Metis-style task board", priority: "high", done: false }]
    },
    {
      id: "done",
      title: "Done",
      cards: [
        { id: todoId(), title: "DeepSeek API key entry", priority: "none", done: true },
        { id: todoId(), title: "Visualise route test as a packet", priority: "none", done: true }
      ]
    }
  ]
};

/** Board-level assignee filter (todo-head): "all" plus the fixed kinds, and a specific
 *  conversation id when kind is "conversation". Agents aren't filterable here yet — the
 *  per-card picker still assigns them, this just keeps the top filter row compact. */
type TodoFilter = { kind: TodoAssigneeKind | "all"; id?: string };

function TodoWorkspace({ storedConversations }: { storedConversations: ConversationRecord[] }): JSX.Element {
  const [board, setBoard] = useAppStoreState("todoBoard", DEFAULT_TODO_BOARD);
  const drag = useRef<{ colId: string; cardId: string } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [addingCol, setAddingCol] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [assigneeMenu, setAssigneeMenu] = useState<{ colId: string; cardId: string } | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [filter, setFilter] = useState<TodoFilter>({ kind: "all" });

  useEffect(() => {
    if (!assigneeMenu) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") setAssigneeMenu(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [assigneeMenu]);

  function mutate(fn: (cols: TodoColumn[]) => TodoColumn[]): void {
    setBoard((current) => ({ columns: fn(current.columns) }));
  }

  function matchesFilter(assignee: TodoAssignee | undefined): boolean {
    if (filter.kind === "all") return true;
    const kind = assignee?.kind ?? "unassigned";
    if (filter.kind === "conversation") return kind === "conversation" && assignee?.id === filter.id;
    return kind === filter.kind;
  }

  function setCardAssignee(colId: string, cardId: string, assignee: TodoAssignee): void {
    updateCard(colId, cardId, { assignee });
    setAssigneeMenu(null);
    setAssigneeSearch("");
  }

  function moveCard(toColId: string, beforeCardId?: string): void {
    const payload = drag.current;
    if (!payload) return;
    mutate((cols) => {
      let moved: TodoCard | undefined;
      const stripped = cols.map((col) =>
        col.id !== payload.colId
          ? col
          : {
              ...col,
              cards: col.cards.filter((card) => {
                if (card.id === payload.cardId) {
                  moved = card;
                  return false;
                }
                return true;
              })
            }
      );
      if (!moved) return cols;
      return stripped.map((col) => {
        if (col.id !== toColId) return col;
        const cards = [...col.cards];
        const idx = beforeCardId ? cards.findIndex((card) => card.id === beforeCardId) : -1;
        if (idx >= 0) cards.splice(idx, 0, moved!);
        else cards.push(moved!);
        return { ...col, cards };
      });
    });
    drag.current = null;
    setDragOverCol(null);
  }

  function addCard(colId: string): void {
    const title = draftTitle.trim();
    if (!title) {
      setAddingCol(null);
      return;
    }
    mutate((cols) => cols.map((col) => (col.id === colId ? { ...col, cards: [...col.cards, { id: todoId(), title, priority: "none", done: false }] } : col)));
    setDraftTitle("");
  }

  function updateCard(colId: string, cardId: string, patch: Partial<TodoCard>): void {
    mutate((cols) => cols.map((col) => (col.id === colId ? { ...col, cards: col.cards.map((card) => (card.id === cardId ? { ...card, ...patch } : card)) } : col)));
  }

  function deleteCard(colId: string, cardId: string): void {
    mutate((cols) => cols.map((col) => (col.id === colId ? { ...col, cards: col.cards.filter((card) => card.id !== cardId) } : col)));
  }

  function cyclePriority(colId: string, card: TodoCard): void {
    const next = TODO_PRIORITY_CYCLE[(TODO_PRIORITY_CYCLE.indexOf(card.priority) + 1) % TODO_PRIORITY_CYCLE.length];
    updateCard(colId, card.id, { priority: next });
  }

  return (
    <main className="product-workspace todo-board-page" aria-label="To Do List">
      <header className="todo-head">
        <div>
          <small>Shared with the Manager</small>
          <h1>To Do List</h1>
        </div>
        <div className="todo-head-actions">
          <div className="todo-filter-chips" role="group" aria-label="Filter by assignee">
            {(
              [
                { kind: "all" as const, label: "All" },
                { kind: "fable" as const, label: "You" },
                { kind: "manager" as const, label: "Manager" },
                { kind: "unassigned" as const, label: "Unassigned" }
              ]
            ).map((chip) => (
              <button
                key={chip.kind}
                type="button"
                className={`todo-filter-chip ${filter.kind === chip.kind ? "active" : ""}`}
                onClick={() => setFilter({ kind: chip.kind })}
              >
                {chip.label}
              </button>
            ))}
            {storedConversations.length ? (
              <CustomSelect
                className="todo-filter-conversation"
                ariaLabel="Filter by conversation"
                value={filter.kind === "conversation" ? filter.id ?? "" : ""}
                onChange={(value) => (value ? setFilter({ kind: "conversation", id: value }) : setFilter({ kind: "all" }))}
                options={[
                  { value: "", label: "By conversation…" },
                  ...storedConversations.map((conversation) => ({ value: conversation.id, label: conversation.title }))
                ]}
              />
            ) : null}
          </div>
          <button type="button" className="todo-add-col" onClick={() => mutate((cols) => [...cols, { id: todoId(), title: "New list", cards: [] }])}>
            <Plus size={15} /> Add list
          </button>
        </div>
      </header>

      <div className="todo-board">
        {board.columns.map((col) => {
          const visibleCards = col.cards.filter((card) => matchesFilter(card.assignee));
          return (
          <section
            key={col.id}
            className={`todo-column ${dragOverCol === col.id ? "drag-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              if (dragOverCol !== col.id) setDragOverCol(col.id);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOverCol((current) => (current === col.id ? null : current));
            }}
            onDrop={() => moveCard(col.id)}
          >
            <header className="todo-col-head">
              <input value={col.title} aria-label="List title" onChange={(event) => mutate((cols) => cols.map((c) => (c.id === col.id ? { ...c, title: event.target.value } : c)))} />
              <span className="todo-count">{visibleCards.length}</span>
              <button type="button" className="todo-col-del" aria-label="Delete list" onClick={() => mutate((cols) => cols.filter((c) => c.id !== col.id))}>
                <Trash2 size={13} />
              </button>
            </header>

            <div className="todo-col-body">
              {visibleCards.map((card) => {
                const assigneeMenuOpen = assigneeMenu?.colId === col.id && assigneeMenu.cardId === card.id;
                const resolvedAssignee = resolveTodoAssignee(card.assignee, storedConversations);
                const filteredConversations = assigneeSearch.trim()
                  ? storedConversations.filter((conversation) => conversation.title.toLowerCase().includes(assigneeSearch.trim().toLowerCase()))
                  : storedConversations;
                return (
                <article
                  key={card.id}
                  className={`todo-card p-${card.priority} ${card.done ? "done" : ""} ${draggingId === card.id ? "dragging" : ""}`}
                  draggable
                  onDragStart={() => {
                    drag.current = { colId: col.id, cardId: card.id };
                    setDraggingId(card.id);
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    drag.current = null;
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onDrop={(event) => {
                    event.stopPropagation();
                    moveCard(col.id, card.id);
                  }}
                >
                  <div className="todo-card-labels">
                    <button
                      type="button"
                      className={`todo-label ${card.priority === "none" ? "todo-label-empty" : `todo-label-${card.priority}`}`}
                      aria-label={TODO_PRIORITY_LABEL[card.priority]}
                      title={`${TODO_PRIORITY_LABEL[card.priority]} (click to change)`}
                      onClick={() => cyclePriority(col.id, card)}
                    >
                      {card.priority === "none" ? "+ Label" : TODO_PRIORITY_SHORT[card.priority]}
                    </button>
                  </div>
                  <div className="todo-card-main">
                    <button type="button" className="todo-check" aria-label={card.done ? "Mark not done" : "Mark done"} onClick={() => updateCard(col.id, card.id, { done: !card.done })}>
                      {card.done ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                    </button>
                    <span className="todo-card-title">{card.title}</span>
                  </div>
                  <div className="todo-card-footer">
                  <span className="todo-assignee-wrap">
                    <button
                      type="button"
                      className={`todo-assignee ${resolvedAssignee.muted ? "muted" : ""}`}
                      aria-label={`Assignee: ${resolvedAssignee.label}`}
                      title="Change assignee"
                      onClick={() => {
                        setAssigneeSearch("");
                        setAssigneeMenu(assigneeMenuOpen ? null : { colId: col.id, cardId: card.id });
                      }}
                    >
                      <span className="todo-assignee-dot" style={{ background: resolvedAssignee.dotColor }} />
                      <span className="todo-assignee-label">{resolvedAssignee.label}</span>
                    </button>
                    {assigneeMenuOpen ? (
                      <>
                        <div className="todo-assignee-backdrop" onPointerDown={() => setAssigneeMenu(null)} />
                        <div className="todo-assignee-popover" role="menu" aria-label="Assign task">
                          <button type="button" role="menuitem" onClick={() => setCardAssignee(col.id, card.id, { kind: "unassigned" })}>
                            <span className="todo-assignee-dot" style={{ background: "var(--faint)" }} />
                            <span>Unassigned</span>
                          </button>
                          <button type="button" role="menuitem" onClick={() => setCardAssignee(col.id, card.id, { kind: "fable" })}>
                            <span className="todo-assignee-dot" style={{ background: "var(--accent)" }} />
                            <span>You (Fable)</span>
                          </button>
                          <button type="button" role="menuitem" onClick={() => setCardAssignee(col.id, card.id, { kind: "manager" })}>
                            <span className="todo-assignee-dot" style={{ background: "#56b6e0" }} />
                            <span>Manager</span>
                          </button>
                          {storedConversations.length ? (
                            <>
                              <div className="todo-assignee-group-label">Conversations</div>
                              {storedConversations.length > 8 ? (
                                <div className="todo-assignee-search">
                                  <Search size={12} />
                                  <input autoFocus value={assigneeSearch} placeholder="Search conversations" onChange={(event) => setAssigneeSearch(event.target.value)} />
                                </div>
                              ) : null}
                              <div className="todo-assignee-scroll">
                                {filteredConversations.map((conversation) => (
                                  <button
                                    key={conversation.id}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => setCardAssignee(col.id, card.id, { kind: "conversation", id: conversation.id, label: conversation.title })}
                                  >
                                    <span className="todo-assignee-dot" style={{ background: "var(--muted)" }} />
                                    <span>{conversation.title}</span>
                                  </button>
                                ))}
                                {filteredConversations.length === 0 ? <p className="todo-assignee-empty">No matches</p> : null}
                              </div>
                            </>
                          ) : null}
                          <div className="todo-assignee-group-label">Agents</div>
                          {MANAGED_AGENT_IDENTITIES.map((agent) => (
                            <button
                              key={agent.name}
                              type="button"
                              role="menuitem"
                              onClick={() => setCardAssignee(col.id, card.id, { kind: "agent", id: agent.name, label: agent.name })}
                            >
                              <span className="todo-assignee-dot" style={{ background: `hsl(${agent.hue} 45% 62%)` }} />
                              <span>{agent.name}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </span>
                  <button type="button" className="todo-card-del" aria-label="Delete task" onClick={() => deleteCard(col.id, card.id)}>
                    <X size={13} />
                  </button>
                  </div>
                </article>
                );
              })}

              {addingCol === col.id ? (
                <div className="todo-add-card">
                  <textarea
                    autoFocus
                    rows={2}
                    value={draftTitle}
                    placeholder="Task title"
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        addCard(col.id);
                      }
                      if (event.key === "Escape") {
                        setAddingCol(null);
                        setDraftTitle("");
                      }
                    }}
                  />
                  <div className="todo-add-actions">
                    <button type="button" onClick={() => addCard(col.id)}>Add</button>
                    <button type="button" className="ghost" onClick={() => { setAddingCol(null); setDraftTitle(""); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="todo-add-trigger" onClick={() => { setAddingCol(col.id); setDraftTitle(""); }}>
                  <Plus size={14} /> Add task
                </button>
              )}
            </div>
          </section>
          );
        })}
      </div>
    </main>
  );
}

const ROUTINE_WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ROUTINE_INTERVAL_PRESETS = [
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 }
];

const DEMO_ROUTINES: Routine[] = [
  {
    id: "demo-1",
    name: "Daily project digest",
    prompt: "Summarise new conversations, changed files, and open tasks since yesterday.",
    schedule: { kind: "daily", hour: 7, minute: 30 },
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunStatus: "ok",
    lastRunAt: new Date(Date.now() - 86_400_000).toISOString(),
    nextRunAt: new Date(Date.now() + 3_600_000 * 8).toISOString()
  },
  {
    id: "demo-2",
    name: "Benchmark drift check",
    prompt: "Re-run quick Metis probes and flag any regression against the last baseline.",
    schedule: { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
    enabled: false,
    createdAt: new Date().toISOString(),
    lastRunStatus: "error",
    lastRunError: "Provider timed out after 30s.",
    lastRunAt: new Date(Date.now() - 3 * 86_400_000).toISOString()
  }
];

function formatRoutineTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function describeRoutineSchedule(schedule: Routine["schedule"]): { big: string; small: string } {
  if (schedule.kind === "interval") {
    const preset = ROUTINE_INTERVAL_PRESETS.find((item) => item.minutes === schedule.everyMinutes);
    const label = preset ? preset.label : schedule.everyMinutes >= 60 ? `${(schedule.everyMinutes / 60).toFixed(schedule.everyMinutes % 60 === 0 ? 0 : 1)}h` : `${schedule.everyMinutes}m`;
    return { big: `every ${label}`, small: "interval" };
  }
  if (schedule.kind === "daily") {
    return { big: formatRoutineTime(schedule.hour, schedule.minute), small: "daily" };
  }
  return { big: formatRoutineTime(schedule.hour, schedule.minute), small: ROUTINE_WEEKDAY_LABELS[schedule.weekday] ?? "weekly" };
}

function computeNextRunAt(schedule: Routine["schedule"], from: Date = new Date()): string {
  if (schedule.kind === "interval") {
    return new Date(from.getTime() + schedule.everyMinutes * 60_000).toISOString();
  }
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (schedule.kind === "daily") {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  const targetWeekday = schedule.weekday;
  while (next.getDay() !== targetWeekday || next <= from) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

function formatCountdown(targetIso: string | undefined, now: number): string {
  if (!targetIso) return "—";
  const diffMs = new Date(targetIso).getTime() - now;
  if (diffMs <= 0) return "due now";
  const totalMinutes = Math.round(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

type RoutineDraft = {
  id?: string;
  name: string;
  prompt: string;
  kind: "interval" | "daily" | "weekly";
  everyMinutes: number;
  hour: number;
  minute: number;
  meridiem: "AM" | "PM";
  weekday: number;
  useCurrentProject: boolean;
  projectPath?: string;
  runOnLaunchIfMissed: boolean;
};

function draftFromRoutine(routine?: Routine, currentProjectPath?: string): RoutineDraft {
  const schedule = routine?.schedule;
  const hour24 = schedule && schedule.kind !== "interval" ? schedule.hour : 9;
  return {
    id: routine?.id,
    name: routine?.name ?? "",
    prompt: routine?.prompt ?? "",
    kind: schedule?.kind ?? "daily",
    everyMinutes: schedule?.kind === "interval" ? schedule.everyMinutes : 30,
    hour: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minute: schedule && schedule.kind !== "interval" ? schedule.minute : 0,
    meridiem: hour24 >= 12 ? "PM" : "AM",
    weekday: schedule?.kind === "weekly" ? schedule.weekday : 1,
    useCurrentProject: Boolean(routine?.projectPath && routine.projectPath === currentProjectPath),
    projectPath: routine?.projectPath ?? (routine ? undefined : currentProjectPath),
    runOnLaunchIfMissed: routine?.runOnLaunchIfMissed ?? false
  };
}

function draftToHour24(draft: RoutineDraft): number {
  const base = draft.hour % 12;
  return draft.meridiem === "PM" ? base + 12 : base;
}

function draftToRoutine(draft: RoutineDraft): Routine {
  const hour = draftToHour24(draft);
  const schedule: Routine["schedule"] =
    draft.kind === "interval"
      ? { kind: "interval", everyMinutes: draft.everyMinutes }
      : draft.kind === "daily"
        ? { kind: "daily", hour, minute: draft.minute }
        : { kind: "weekly", weekday: draft.weekday, hour, minute: draft.minute };
  return {
    id: draft.id ?? `routine-${Date.now()}`,
    name: draft.name.trim() || "Untitled routine",
    prompt: draft.prompt,
    schedule,
    projectPath: draft.useCurrentProject ? draft.projectPath : undefined,
    enabled: true,
    createdAt: new Date().toISOString(),
    runOnLaunchIfMissed: draft.runOnLaunchIfMissed
  };
}

function HourDial({ hour, minute, meridiem, onChange }: { hour: number; minute: number; meridiem: "AM" | "PM"; onChange: (hour: number, minute: number) => void }): JSX.Element {
  const size = 140;
  const center = size / 2;
  const faceRadius = center - 14;
  const handleRadius = center - 26;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);

  const angleForHour = ((hour % 12) / 12) * 360 - 90;
  const handleX = center + handleRadius * Math.cos((angleForHour * Math.PI) / 180);
  const handleY = center + handleRadius * Math.sin((angleForHour * Math.PI) / 180);

  function angleToHour(clientX: number, clientY: number): number {
    const svg = svgRef.current;
    if (!svg) return hour;
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left - center;
    const y = clientY - rect.top - center;
    let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
    if (deg < 0) deg += 360;
    let h = Math.round(deg / 30) % 12;
    if (h === 0) h = 12;
    return h;
  }

  function handlePointer(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!dragging.current) return;
    onChange(angleToHour(event.clientX, event.clientY), minute);
  }

  const ticks = Array.from({ length: 12 }, (_, index) => {
    const deg = (index / 12) * 360 - 90;
    const rad = (deg * Math.PI) / 180;
    const x1 = center + (faceRadius - 6) * Math.cos(rad);
    const y1 = center + (faceRadius - 6) * Math.sin(rad);
    const x2 = center + faceRadius * Math.cos(rad);
    const y2 = center + faceRadius * Math.sin(rad);
    const labelX = center + (faceRadius - 18) * Math.cos(rad);
    const labelY = center + (faceRadius - 18) * Math.sin(rad);
    const label = index === 0 ? 12 : index;
    return (
      <g key={index}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--line)" strokeWidth={label % 3 === 0 ? 2 : 1} />
        <text x={labelX} y={labelY + 3} textAnchor="middle" fontSize="9" fill="var(--muted)">
          {label}
        </text>
      </g>
    );
  });

  return (
    <svg
      ref={svgRef}
      className="hour-dial"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      onPointerDown={(event) => {
        dragging.current = true;
        (event.target as Element).setPointerCapture?.(event.pointerId);
        onChange(angleToHour(event.clientX, event.clientY), minute);
      }}
      onPointerMove={handlePointer}
      onPointerUp={(event) => {
        dragging.current = false;
        (event.target as Element).releasePointerCapture?.(event.pointerId);
      }}
    >
      <circle cx={center} cy={center} r={faceRadius} fill="var(--node)" stroke="var(--line)" />
      {ticks}
      <line x1={center} y1={center} x2={handleX} y2={handleY} stroke="var(--accent)" strokeWidth={3} strokeLinecap="round" />
      <circle cx={center} cy={center} r={3} fill="var(--accent)" />
      <circle cx={handleX} cy={handleY} r={7} fill="var(--accent)" />
      <text x={center} y={center + faceRadius + 12} textAnchor="middle" fontSize="10" fill="var(--faint)">
        {meridiem}
      </text>
    </svg>
  );
}

function RoutineEditor({
  draft,
  currentProjectPath,
  onChange,
  onCancel,
  onSave
}: {
  draft: RoutineDraft;
  currentProjectPath?: string;
  onChange: (next: RoutineDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}): JSX.Element {
  function set<K extends keyof RoutineDraft>(key: K, value: RoutineDraft[K]): void {
    onChange({ ...draft, [key]: value });
  }

  return (
    <div className="routine-editor">
      <div className="routine-editor-field">
        <label>Name</label>
        <input
          type="text"
          value={draft.name}
          placeholder="Morning digest"
          onChange={(event: ChangeEvent<HTMLInputElement>) => set("name", event.target.value)}
        />
      </div>
      <div className="routine-editor-field">
        <label>Prompt</label>
        <textarea
          rows={3}
          value={draft.prompt}
          placeholder="What should this routine ask the agent to do?"
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => set("prompt", event.target.value)}
        />
      </div>
      <div className="routine-editor-field">
        <label>Schedule</label>
        <div className="segmented-control">
          {(["interval", "daily", "weekly"] as const).map((kind) => (
            <button key={kind} type="button" className={draft.kind === kind ? "active" : ""} onClick={() => set("kind", kind)}>
              {kind === "interval" ? "Interval" : kind === "daily" ? "Daily" : "Weekly"}
            </button>
          ))}
        </div>
      </div>

      {draft.kind === "interval" ? (
        <div className="routine-editor-field">
          <label>Every</label>
          <div className="chip-row">
            {ROUTINE_INTERVAL_PRESETS.map((preset) => (
              <button
                key={preset.minutes}
                type="button"
                className={`preset-chip ${draft.everyMinutes === preset.minutes ? "active" : ""}`}
                onClick={() => set("everyMinutes", preset.minutes)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="routine-stepper">
            <button type="button" onClick={() => set("everyMinutes", Math.max(5, draft.everyMinutes - 5))}>
              -
            </button>
            <span>{draft.everyMinutes}m</span>
            <button type="button" onClick={() => set("everyMinutes", draft.everyMinutes + 5)}>
              +
            </button>
          </div>
        </div>
      ) : null}

      {draft.kind === "weekly" ? (
        <div className="routine-editor-field">
          <label>Weekday</label>
          <div className="chip-row">
            {ROUTINE_WEEKDAY_LABELS.map((label, index) => (
              <button
                key={label}
                type="button"
                className={`preset-chip ${draft.weekday === index ? "active" : ""}`}
                onClick={() => set("weekday", index)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {draft.kind !== "interval" ? (
        <div className="routine-editor-field">
          <label>Time</label>
          <div className="routine-time-picker">
            <HourDial
              hour={draft.hour}
              minute={draft.minute}
              meridiem={draft.meridiem}
              onChange={(hour, minute) => onChange({ ...draft, hour, minute })}
            />
            <div className="routine-time-numeric">
              <input
                type="number"
                min={1}
                max={12}
                value={draft.hour}
                onChange={(event: ChangeEvent<HTMLInputElement>) => set("hour", Math.min(12, Math.max(1, Number(event.target.value) || 1)))}
              />
              <span>:</span>
              <input
                type="number"
                min={0}
                max={59}
                value={draft.minute}
                onChange={(event: ChangeEvent<HTMLInputElement>) => set("minute", Math.min(59, Math.max(0, Number(event.target.value) || 0)))}
              />
              <div className="segmented-control small">
                {(["AM", "PM"] as const).map((meridiem) => (
                  <button key={meridiem} type="button" className={draft.meridiem === meridiem ? "active" : ""} onClick={() => set("meridiem", meridiem)}>
                    {meridiem}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="routine-editor-field">
        <label className="routine-checkbox-row">
          <input
            type="checkbox"
            checked={draft.useCurrentProject}
            disabled={!currentProjectPath}
            onChange={(event: ChangeEvent<HTMLInputElement>) => set("useCurrentProject", event.target.checked)}
          />
          <span>
            Use current project{currentProjectPath ? ` (${currentProjectPath})` : " (none selected)"}
          </span>
        </label>
        <label className="routine-checkbox-row">
          <input
            type="checkbox"
            checked={draft.runOnLaunchIfMissed}
            onChange={(event: ChangeEvent<HTMLInputElement>) => set("runOnLaunchIfMissed", event.target.checked)}
          />
          <span>Run on launch if a run was missed while closed</span>
        </label>
      </div>

      <div className="routine-editor-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={onSave} disabled={!draft.name.trim() && !draft.prompt.trim()}>
          Save routine
        </button>
      </div>
    </div>
  );
}

function RoutineCard({
  routine,
  now,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
  onOpenConversation,
  readOnly
}: {
  routine: Routine;
  now: number;
  onToggle: () => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenConversation: () => void;
  readOnly?: boolean;
}): JSX.Element {
  const { big, small } = describeRoutineSchedule(routine.schedule);
  const nextRun = routine.nextRunAt ?? computeNextRunAt(routine.schedule);
  const statusClass = routine.lastRunStatus === "ok" ? "ok" : routine.lastRunStatus === "error" ? "error" : "never";
  const statusTitle = routine.lastRunStatus === "error" ? routine.lastRunError ?? "Last run failed" : routine.lastRunStatus === "ok" ? "Last run succeeded" : "Never run";

  return (
    <article className={`routine-card2 ${routine.enabled ? "" : "disabled"}`}>
      <div className="routine-card2-time">
        <strong>{big}</strong>
        <small>{small}</small>
      </div>
      <div className="routine-card2-body">
        <div className="routine-card2-heading">
          <span className={`routine-status-dot ${statusClass}`} title={statusTitle} />
          <strong>{routine.name}</strong>
        </div>
        <p className="routine-card2-prompt" title={routine.prompt}>
          {routine.prompt}
        </p>
        <span className="routine-card2-countdown">{formatCountdown(nextRun, now)}</span>
      </div>
      <div className="routine-card2-actions">
        {!readOnly ? (
          <button type="button" onClick={onRunNow} title="Run now">
            <Play size={14} />
          </button>
        ) : null}
        {!readOnly ? (
          <button type="button" onClick={onEdit} title="Edit">
            <Pencil size={14} />
          </button>
        ) : null}
        {!readOnly && routine.conversationId ? (
          <button type="button" onClick={onOpenConversation} title="Open conversation">
            <ExternalLink size={14} />
          </button>
        ) : null}
        {!readOnly ? (
          <button type="button" className="danger" onClick={onDelete} title="Delete">
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
      <label className="routine-toggle" title={routine.enabled ? "Enabled" : "Disabled"}>
        <input type="checkbox" checked={routine.enabled} disabled={readOnly} onChange={onToggle} />
        <span className="routine-toggle-track">
          <span className="routine-toggle-thumb" />
        </span>
      </label>
    </article>
  );
}

function RoutinesWorkspace({ onConversationOpen }: { onConversationOpen?: (id: string) => void }): JSX.Element {
  const hasBridge = typeof window !== "undefined" && Boolean(window.metisRoutines);
  const [routines, setRoutines] = useState<Routine[]>(hasBridge ? [] : DEMO_ROUTINES);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | undefined>(undefined);
  const [editingDraft, setEditingDraft] = useState<RoutineDraft | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasBridge) return;
    void window.metisRoutines?.list().then(setRoutines);
    if (window.metisProject) {
      void window.metisProject.getWorkspace().then((workspace) => setCurrentProjectPath(workspace?.path));
    }
  }, [hasBridge]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function refresh(): Promise<void> {
    if (!window.metisRoutines) return;
    setRoutines(await window.metisRoutines.list());
  }

  async function toggleRoutine(routine: Routine): Promise<void> {
    if (!window.metisRoutines) return;
    await window.metisRoutines.save({ ...routine, enabled: !routine.enabled });
    await refresh();
  }

  async function runNow(id: string): Promise<void> {
    if (!window.metisRoutines) return;
    await window.metisRoutines.runNow(id);
    await refresh();
  }

  async function deleteRoutine(id: string): Promise<void> {
    if (!window.metisRoutines) return;
    const confirmed = window.confirm("Delete this routine? This does not delete its conversation history.");
    if (!confirmed) return;
    const next = await window.metisRoutines.delete(id);
    setRoutines(next);
  }

  async function saveDraft(): Promise<void> {
    if (!editingDraft || !window.metisRoutines) return;
    await window.metisRoutines.save(draftToRoutine(editingDraft));
    setEditingDraft(null);
    await refresh();
  }

  return (
    <main className="product-workspace routines-workspace" aria-label="Routines">
      <section className="routines-shell">
        <header className="routines-header">
          <div>
            <small>Recurring prompts, one dedicated conversation per routine</small>
            <h1>Routines</h1>
          </div>
          {!editingDraft ? (
            <button
              type="button"
              className="primary"
              disabled={!hasBridge}
              onClick={() => setEditingDraft(draftFromRoutine(undefined, currentProjectPath))}
            >
              <Plus size={14} /> New routine
            </button>
          ) : null}
        </header>

        {!hasBridge ? (
          <p className="routines-demo-note">Preview mode — showing demo routines (read-only). Run inside the desktop app to create and manage real routines.</p>
        ) : null}

        {editingDraft ? (
          <RoutineEditor
            draft={editingDraft}
            currentProjectPath={currentProjectPath}
            onChange={setEditingDraft}
            onCancel={() => setEditingDraft(null)}
            onSave={saveDraft}
          />
        ) : null}

        {routines.length === 0 && !editingDraft ? (
          <div className="routines-empty">
            <p>No routines yet. Set one up to have Metis run a prompt automatically on a schedule.</p>
          </div>
        ) : (
          <div className="routines-list">
            {routines.map((routine) => (
              <RoutineCard
                key={routine.id}
                routine={routine}
                now={now}
                readOnly={!hasBridge}
                onToggle={() => void toggleRoutine(routine)}
                onRunNow={() => void runNow(routine.id)}
                onEdit={() => setEditingDraft(draftFromRoutine(routine, currentProjectPath))}
                onDelete={() => void deleteRoutine(routine.id)}
                onOpenConversation={() => {
                  if (routine.conversationId && onConversationOpen) onConversationOpen(routine.conversationId);
                }}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

/** A local, non-destructive suggestion the Manager surfaces for the user to approve or
 *  dismiss (docs/FABLE_PLANS.md §11). `id` is derived from the suggestion's subject
 *  (provider key, audit event id, or a single fixed id for the unowned-work rollup) so
 *  it stays stable across renders and dedupes correctly against the dismissed list. */
type ManagerSuggestion = { id: string; text: string; actionLabel: string; action: () => void; tone?: "info" | "warn" };

/** Cloud/keyable providers the "add a key" suggestion applies to — local providers
 *  (ollama) are never unkeyed in the sense this suggestion means. */
const MANAGER_KEYABLE_PROVIDERS: ProviderKey[] = ["anthropic", "openai", "gemini", "deepseek", "openrouter", "nvidia", "groq"];

const EMPTY_MANAGER_CHAT: ManagerChatMessage[] = [];

/** The Manager tab's primary surface: a real chat with "Metis Manager", backed
 *  by the metis-manager:chat IPC (main.ts builds live project/todo context and
 *  calls the same provider-invocation machinery the main chat uses). Kept as
 *  its own component — not inlined into ManagerWorkspace — so a future
 *  floating widget (a separate round of work) can mount this exact component
 *  instead of duplicating the chat logic. Persists to the shared `managerChat`
 *  store key so the conversation survives navigation and app restarts. */
function ManagerChat(): JSX.Element {
  const [messages, setMessages] = useAppStoreState<ManagerChatMessage[]>("managerChat", EMPTY_MANAGER_CHAT);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const available = Boolean(window.metisManager);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending]);

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || sending || !available) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setDraft("");
    setSending(true);
    setError(null);
    try {
      const result = await window.metisManager!.chat(next);
      if (result.reply) setMessages((current) => [...current, { role: "assistant" as const, content: result.reply }]);
      if (result.error) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  function clearChat(): void {
    setMessages([]);
    setError(null);
  }

  return (
    <div className="manager-chat">
      <div className="manager-chat-head">
        <span className="manager-chat-title">
          <Sparkles size={14} /> Chat with Manager
        </span>
        <button type="button" className="ghost manager-chat-clear" onClick={clearChat} disabled={messages.length === 0 && !error}>
          <RotateCcw size={12} /> New chat
        </button>
      </div>
      <div className="manager-chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <p className="manager-chat-empty">Ask about your projects, todos, or what to tackle next.</p>
        ) : (
          messages.map((message, index) => (
            <div key={index} className={`message-row ${message.role === "user" ? "user-message" : "assistant-message"}`}>
              {message.role === "user" ? (
                <div className="user-bubble">
                  <p>{message.content}</p>
                </div>
              ) : (
                <div className="manager-chat-reply">
                  <Markdown>{message.content}</Markdown>
                </div>
              )}
            </div>
          ))
        )}
        {sending ? (
          <div className="message-row assistant-message">
            <div className="manager-chat-reply">
              <span className="thinking-dots" aria-label="Manager is thinking">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        ) : null}
      </div>
      {error ? <p className="manager-chat-error">{error}</p> : null}
      <div className="manager-chat-composer">
        <textarea
          value={draft}
          rows={2}
          placeholder={available ? "Message the Manager…" : "Manager needs the desktop app."}
          disabled={!available || sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="manager-chat-send"
          aria-label="Send"
          disabled={!available || sending || !draft.trim()}
          onClick={() => void send()}
        >
          <ArrowUp size={16} />
        </button>
      </div>
      {!available ? <p className="manager-chat-note">Manager needs the desktop app to chat live — this preview can still show the composer.</p> : null}
    </div>
  );
}

/** Top-left position of the floating Manager widget, persisted so it survives
 *  navigation and app restarts (see `managerWidgetPos` in useAppStoreState). */
type ManagerWidgetPos = { x: number; y: number };

/** Width/height of the floating Manager widget while expanded, persisted so it survives
 *  navigation and app restarts (see `managerWidgetSize` in useAppStoreState). */
type ManagerWidgetSize = { width: number; height: number };

const MANAGER_WIDGET_WIDTH = 360;
const MANAGER_WIDGET_HEIGHT = 520;
const MANAGER_WIDGET_HEADER_HEIGHT = 44;
const MANAGER_WIDGET_MARGIN = 16;
const MANAGER_WIDGET_MIN_WIDTH = 300;
const MANAGER_WIDGET_MIN_HEIGHT = 360;

// Stable module-level fallback for useAppStoreState("managerWidgetSize", ...): an inline `{ width, height }`
// literal would be a new object identity every render, and useAppStoreState's load effect depends on that
// fallback reference, so it would re-fetch from the store (and could clobber an in-flight resize) on every
// re-render. Matches DEFAULT_GRAPH_PHYSICS's reasoning above.
const DEFAULT_MANAGER_WIDGET_SIZE: ManagerWidgetSize = { width: MANAGER_WIDGET_WIDTH, height: MANAGER_WIDGET_HEIGHT };

/** Keeps the widget fully on-screen (header always reachable) no matter what
 *  it was last dragged to — reused both while dragging and after a resize. */
function clampManagerWidgetPos(pos: ManagerWidgetPos, minimized: boolean, size: ManagerWidgetSize): ManagerWidgetPos {
  const height = minimized ? MANAGER_WIDGET_HEADER_HEIGHT : size.height;
  const maxX = Math.max(MANAGER_WIDGET_MARGIN, window.innerWidth - size.width - MANAGER_WIDGET_MARGIN);
  const maxY = Math.max(MANAGER_WIDGET_MARGIN, window.innerHeight - height - MANAGER_WIDGET_MARGIN);
  return {
    x: Math.min(Math.max(pos.x, MANAGER_WIDGET_MARGIN), maxX),
    y: Math.min(Math.max(pos.y, MANAGER_WIDGET_MARGIN), maxY)
  };
}

/** Sensible first-open anchor: bottom-right of the viewport, clamped like any other position. */
function defaultManagerWidgetPos(size: ManagerWidgetSize): ManagerWidgetPos {
  return clampManagerWidgetPos(
    { x: window.innerWidth - size.width - 24, y: window.innerHeight - size.height - 24 },
    false,
    size
  );
}

/** Keeps a resize within a sensible minimum and the viewport's available space. */
function clampManagerWidgetSize(size: ManagerWidgetSize): ManagerWidgetSize {
  const maxWidth = Math.max(MANAGER_WIDGET_MIN_WIDTH, window.innerWidth - MANAGER_WIDGET_MARGIN * 2);
  const maxHeight = Math.max(MANAGER_WIDGET_MIN_HEIGHT, window.innerHeight - MANAGER_WIDGET_MARGIN * 2);
  return {
    width: Math.min(Math.max(size.width, MANAGER_WIDGET_MIN_WIDTH), maxWidth),
    height: Math.min(Math.max(size.height, MANAGER_WIDGET_MIN_HEIGHT), maxHeight)
  };
}

/** App-level floating Manager chat: a draggable, minimizable widget that hosts the exact same
 *  <ManagerChat /> component the Manager tab uses, so both share the `managerChat` store key and
 *  history. Mounted once at the App root (outside the per-view <main> content) so it overlays every
 *  nav view. Its own open/minimized/position state persists via useAppStoreState so it survives
 *  navigation and app restarts (docs/FABLE_PLANS.md — floating widget round of work). */
function ManagerWidget(): JSX.Element {
  const [open, setOpen] = useAppStoreState<boolean>("managerWidgetOpen", false);
  const [minimized, setMinimized] = useAppStoreState<boolean>("managerWidgetMinimized", false);
  const [pos, setPos] = useAppStoreState<ManagerWidgetPos | null>("managerWidgetPos", null);
  const [size, setSize] = useAppStoreState<ManagerWidgetSize>("managerWidgetSize", DEFAULT_MANAGER_WIDGET_SIZE);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; startWidth: number; startHeight: number } | null>(null);

  const resolvedPos = pos ?? defaultManagerWidgetPos(size);

  // Re-clamp on window resize so the widget never ends up stranded off-screen (e.g. after
  // shrinking the window while it was parked near a since-vanished edge).
  useEffect(() => {
    function handleResize(): void {
      setPos((current) => (current ? clampManagerWidgetPos(current, minimized, size) : current));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [minimized, size, setPos]);

  // Re-clamp the position whenever the persisted size changes (e.g. right after a corner-drag
  // resize) so a widget that just grew can't spill off the right/bottom edge of the viewport.
  useEffect(() => {
    setPos((current) => (current ? clampManagerWidgetPos(current, minimized, size) : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  function handleHeaderPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    // Don't start a drag when the pointer lands on a header button (minimize/close).
    if ((event.target as HTMLElement).closest("button")) return;
    const startPos = pos ?? defaultManagerWidgetPos(size);
    if (!pos) setPos(startPos);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: startPos.x,
      originY: startPos.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  }

  function handleHeaderPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextX = drag.originX + (event.clientX - drag.startX);
    const nextY = drag.originY + (event.clientY - drag.startY);
    setPos(clampManagerWidgetPos({ x: nextX, y: nextY }, minimized, size));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: size.width,
      startHeight: size.height
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextWidth = drag.startWidth + (event.clientX - drag.startX);
    const nextHeight = drag.startHeight + (event.clientY - drag.startY);
    setSize(clampManagerWidgetSize({ width: nextWidth, height: nextHeight }));
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  if (!open) {
    return (
      <button type="button" className="manager-fab" aria-label="Open Manager chat" onClick={() => setOpen(true)}>
        <Bot size={20} />
      </button>
    );
  }

  return (
    <div
      className={`manager-widget ${minimized ? "minimized" : ""}`}
      style={{ left: resolvedPos.x, top: resolvedPos.y, width: size.width, height: minimized ? undefined : size.height }}
    >
      <div
        className={`manager-widget-head ${isDragging ? "dragging" : ""}`}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="manager-widget-title">
          <Bot size={14} /> Manager
        </span>
        <div className="manager-widget-actions">
          <button
            type="button"
            className="manager-widget-btn"
            aria-label={minimized ? "Expand Manager widget" : "Minimize Manager widget"}
            onClick={() => setMinimized((current) => !current)}
          >
            {minimized ? <Maximize2 size={13} /> : <Minus size={13} />}
          </button>
          <button type="button" className="manager-widget-btn" aria-label="Close Manager widget" onClick={() => setOpen(false)}>
            <X size={13} />
          </button>
        </div>
      </div>
      {!minimized ? (
        <div className="manager-widget-body">
          <ManagerChat />
        </div>
      ) : null}
      {!minimized ? (
        <div
          className={`manager-widget-resize ${isResizing ? "resizing" : ""}`}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}

function ManagerWorkspace({ onNavigate }: { onNavigate: (nav: NavKey) => void }): JSX.Element {
  const [board, setBoard] = useAppStoreState("todoBoard", DEFAULT_TODO_BOARD);
  const [dismissed, setDismissed] = useAppStoreState<string[]>("managerDismissedSuggestions", []);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [sidePanelOpen, setSidePanelOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      const [nextProviders, nextAudit] = await Promise.all([
        window.metisProviders?.list() ?? Promise.resolve<ProviderStatus[]>([]),
        window.metisAudit?.list(20) ?? Promise.resolve<AuditEvent[]>([])
      ]);
      if (cancelled) return;
      setProviders(nextProviders);
      setAuditEvents(nextAudit);
    }
    void refresh();
    return () => {
      cancelled = true;
    };
  }, []);

  const flatCards = useMemo(
    () => board.columns.flatMap((col) => col.cards.map((card) => ({ card, colId: col.id, colTitle: col.title }))),
    [board]
  );

  function mutateBoard(fn: (cols: TodoColumn[]) => TodoColumn[]): void {
    setBoard((current) => ({ columns: fn(current.columns) }));
  }

  function setCardAssignee(colId: string, cardId: string, assignee: TodoAssignee): void {
    mutateBoard((cols) => cols.map((col) => (col.id === colId ? { ...col, cards: col.cards.map((card) => (card.id === cardId ? { ...card, assignee } : card)) } : col)));
  }

  function toggleCardDone(colId: string, cardId: string): void {
    mutateBoard((cols) => cols.map((col) => (col.id === colId ? { ...col, cards: col.cards.map((card) => (card.id === cardId ? { ...card, done: !card.done } : card)) } : col)));
  }

  const suggestions = useMemo<ManagerSuggestion[]>(() => {
    const list: ManagerSuggestion[] = [];

    // (a) Unowned work: a single rollup suggestion so it stays one stable chip
    // no matter how the unowned count changes between renders.
    const unowned = flatCards.filter(({ card }) => !card.done && (!card.assignee || card.assignee.kind === "unassigned"));
    if (unowned.length) {
      list.push({
        id: "unowned-cards",
        text: `${unowned.length} task${unowned.length === 1 ? "" : "s"} ${unowned.length === 1 ? "has" : "have"} no owner.`,
        actionLabel: "Assign to me",
        tone: "info",
        action: () =>
          mutateBoard((cols) =>
            cols.map((col) => ({
              ...col,
              cards: col.cards.map((card) => (!card.done && (!card.assignee || card.assignee.kind === "unassigned") ? { ...card, assignee: { kind: "manager" } } : card))
            }))
          )
      });
    }

    // (b) Unkeyed providers, one chip per provider so each can be dismissed independently.
    for (const provider of providers) {
      if (provider.status === "not_configured" && MANAGER_KEYABLE_PROVIDERS.includes(provider.provider)) {
        list.push({
          id: `unkeyed:${provider.provider}`,
          text: `You haven't added a key for ${provider.label}.`,
          actionLabel: "Open Settings",
          tone: "info",
          action: () => onNavigate("settings")
        });
      }
    }

    // (c) Recent failures, most recent first, capped so the list can't run away.
    const errors = auditEvents.filter((event) => event.level === "error").slice(0, 5);
    for (const event of errors) {
      list.push({
        id: `error:${event.id}`,
        text: `A recent run reported an error: ${event.summary.slice(0, 140)}`,
        actionLabel: "Add a repair todo",
        tone: "warn",
        action: () =>
          mutateBoard((cols) => {
            if (!cols.length) return cols;
            const [first, ...rest] = cols;
            const repairCard: TodoCard = { id: todoId(), title: `Fix: ${event.summary.slice(0, 90)}`, priority: "high", done: false, assignee: { kind: "manager" } };
            return [{ ...first, cards: [...first.cards, repairCard] }, ...rest];
          })
      });
    }

    return list.filter((suggestion) => !dismissed.includes(suggestion.id));
  }, [flatCards, providers, auditEvents, dismissed, onNavigate]);

  function dismissSuggestion(id: string): void {
    setDismissed((current) => (current.includes(id) ? current : [...current, id]));
  }

  const myQueue = flatCards.filter(({ card }) => card.assignee?.kind === "manager");

  const glance = useMemo(() => {
    const counts = { you: 0, manager: 0, unassigned: 0, agents: 0 };
    for (const { card } of flatCards) {
      const kind = card.assignee?.kind ?? "unassigned";
      if (kind === "fable") counts.you += 1;
      else if (kind === "manager") counts.manager += 1;
      else if (kind === "agent") counts.agents += 1;
      else if (kind === "unassigned") counts.unassigned += 1;
    }
    return counts;
  }, [flatCards]);

  return (
    <main className="product-workspace manager-workspace" aria-label="Manager agent">
      <header className="manager-head">
        <small>Built-in assistant layer</small>
        <h1>Manager</h1>
        <p>A chat with Metis Manager — it knows your projects and to-do board, and helps you plan and prioritize. Anything it notices along the way (unowned work, missing keys, recent failures) shows up in the panel alongside.</p>
      </header>

      <div className="manager-body">
        <ManagerChat />

        <aside className={`manager-side ${sidePanelOpen ? "open" : "collapsed"}`} aria-label="What I noticed">
          <button type="button" className="manager-side-toggle" onClick={() => setSidePanelOpen((value) => !value)} aria-expanded={sidePanelOpen}>
            {sidePanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            <span>What I noticed{suggestions.length ? ` (${suggestions.length})` : ""}</span>
          </button>
          {sidePanelOpen ? (
            <div className="manager-side-body">
              <section className="manager-section">
                <h2>Suggestions</h2>
                {suggestions.length === 0 ? (
                  <p className="manager-empty">All clear — nothing needs your attention.</p>
                ) : (
                  <div className="manager-suggestions">
                    {suggestions.map((suggestion) => (
                      <div key={suggestion.id} className={`manager-suggestion ${suggestion.tone === "warn" ? "warn" : ""}`}>
                        <span className="manager-suggestion-text">{suggestion.text}</span>
                        <div className="manager-suggestion-actions">
                          <button type="button" className="ghost" onClick={suggestion.action}>
                            {suggestion.actionLabel}
                          </button>
                          <button type="button" className="manager-suggestion-dismiss" aria-label="Dismiss suggestion" title="Dismiss" onClick={() => dismissSuggestion(suggestion.id)}>
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="manager-section">
                <h2>My queue</h2>
                {myQueue.length === 0 ? (
                  <p className="manager-empty">Nothing assigned to the Manager right now.</p>
                ) : (
                  <div className="manager-queue">
                    {myQueue.map(({ card, colId, colTitle }) => (
                      <div key={card.id} className={`manager-queue-row p-${card.priority} ${card.done ? "done" : ""}`}>
                        <button type="button" className="todo-check" aria-label={card.done ? "Mark not done" : "Mark done"} onClick={() => toggleCardDone(colId, card.id)}>
                          {card.done ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                        </button>
                        <span className="manager-queue-title">{card.title}</span>
                        <span className="manager-queue-source">{colTitle}</span>
                        <span className="manager-queue-prio" title={TODO_PRIORITY_LABEL[card.priority]} />
                        <button type="button" className="ghost" onClick={() => setCardAssignee(colId, card.id, { kind: "fable" })}>
                          Hand to you
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="manager-section">
                <h2>Board at a glance</h2>
                <div className="manager-glance">
                  <button type="button" className="manager-glance-stat" onClick={() => onNavigate("todo")}>
                    <strong>{glance.you}</strong>
                    <span>You</span>
                  </button>
                  <button type="button" className="manager-glance-stat" onClick={() => onNavigate("todo")}>
                    <strong>{glance.manager}</strong>
                    <span>Manager</span>
                  </button>
                  <button type="button" className="manager-glance-stat" onClick={() => onNavigate("todo")}>
                    <strong>{glance.unassigned}</strong>
                    <span>Unassigned</span>
                  </button>
                  <button type="button" className="manager-glance-stat" onClick={() => onNavigate("todo")}>
                    <strong>{glance.agents}</strong>
                    <span>Agents</span>
                  </button>
                </div>
              </section>
            </div>
          ) : null}
        </aside>
      </div>
      {/* v1 Manager suggestion actions are all local: mutating the shared todoBoard store and
          in-app navigation, never a model or API call. The chat turn above is the first
          model-driven Manager action; deeper ones (auto-triage, drafting replies, running
          commands) must route through the existing permission ceremony (gatePermission /
          permission_request) so the assistant stays permission-gated by design, not just in
          this UI. */}
    </main>
  );
}

/** Settings left-rail section keys — Claude-Code-specific tabs with no
 *  backing bridge (Profile, Configuration, Personalization, Browser, Computer
 *  use, Hooks, Git, Worktrees) were dropped; every section below renders real
 *  content wired to an existing store key or window bridge. */
type SettingsSection = "general" | "providers" | "appearance" | "chat" | "mcp" | "privacy" | "about";

const SETTINGS_NAV: Array<{ group: string; icon: JSX.Element; label: string; section: SettingsSection }> = [
  { group: "Personal", icon: <ShieldCheck size={15} />, label: "General", section: "general" },
  { group: "Personal", icon: <Sparkles size={15} />, label: "Appearance", section: "appearance" },
  { group: "Personal", icon: <MessageCircle size={15} />, label: "Chat", section: "chat" },
  { group: "Integrations", icon: <Cable size={15} />, label: "Providers", section: "providers" },
  { group: "Integrations", icon: <Plug size={15} />, label: "MCP servers", section: "mcp" },
  { group: "System", icon: <Shield size={15} />, label: "Privacy & Data", section: "privacy" },
  { group: "System", icon: <HelpCircle size={15} />, label: "About", section: "about" }
];

const SETTINGS_SECTION_META: Record<SettingsSection, { subtitle: string; title: string }> = {
  general: { title: "General", subtitle: "Runtime defaults, policy bridge, permissions, marketplace registry, and audit trail." },
  providers: { title: "Providers", subtitle: "Provider-level API keys and health checks used by every route." },
  appearance: { title: "Appearance", subtitle: "Accent color, density, and text size — applied app-wide, not just here." },
  chat: { title: "Chat", subtitle: "Route ceremony verbosity, streaming, and self-verification for new runs." },
  mcp: { title: "MCP servers", subtitle: "Installed Model Context Protocol connections available to routes." },
  privacy: { title: "Privacy & Data", subtitle: "What gets stored locally, audit retention, and data controls." },
  about: { title: "About", subtitle: "App version, update check, and project links." }
};

function SettingsWorkspace({ onBack, onOpenMcpMarketplace }: { onBack: () => void; onOpenMcpMarketplace: () => void }): JSX.Element {
  const [section, setSection] = useState<SettingsSection>("general");
  const [navQuery, setNavQuery] = useState("");
  const [rawSettings, setSettings] = useAppStoreState("settings", DEFAULT_SETTINGS);
  // Backfills fields added to AppSettings after a store blob was already
  // persisted on disk (useAppStoreState replaces wholesale, it doesn't deep-
  // merge) — without this, an existing install upgrading to this build would
  // see chatVerbosity/streamingEnabled render as an empty "Select" control.
  const settings = useMemo(() => ({ ...DEFAULT_SETTINGS, ...rawSettings }), [rawSettings]);
  const [rawAppearance, setAppearance] = useAppStoreState("appearance", DEFAULT_APPEARANCE);
  const appearance = useMemo(() => ({ ...DEFAULT_APPEARANCE, ...rawAppearance }), [rawAppearance]);
  // "Is this done?" critic loop (docs/FABLE_PLANS.md §22) — a top-level store
  // key (not nested in AppSettings) since main.ts reads it directly by name.
  const [selfVerify, setSelfVerify] = useAppStoreState<"off" | "local" | "all">("selfVerify", "local");
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [policyStatus, setPolicyStatus] = useState<PolicyStatus>(FALLBACK_POLICY_STATUS);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [permissions, setPermissions] = useState<PermissionGrant[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [registry, setRegistry] = useState<RegistryState>(FALLBACK_REGISTRY);
  const [installedPackages, setInstalledPackages] = useState<RegistryPackage[]>([]);
  const [secretDrafts, setSecretDrafts] = useState<Partial<Record<ProviderKey, string>>>({});
  const [registryUrl, setRegistryUrl] = useState("");
  const [testPrompt, setTestPrompt] = useState("Summarise these notes into five bullets.");
  const [policyDecision, setPolicyDecision] = useState<PolicyDecisionResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const secretMap = useMemo(() => new Map(secrets.map((secret) => [secret.provider, secret])), [secrets]);
  const installedIds = useMemo(() => new Set(installedPackages.map((item) => item.id)), [installedPackages]);
  const mcpPackages = useMemo(() => installedPackages.filter((item) => item.kind === "mcp"), [installedPackages]);
  const filteredNav = useMemo(() => {
    const query = navQuery.trim().toLowerCase();
    return query ? SETTINGS_NAV.filter((item) => item.label.toLowerCase().includes(query)) : SETTINGS_NAV;
  }, [navQuery]);
  const navGroups = useMemo(() => Array.from(new Set(filteredNav.map((item) => item.group))), [filteredNav]);

  const refreshRuntime = useCallback(async () => {
    const [nextPolicy, nextProviders, nextSecrets, nextPermissions, nextAudit, nextRegistry, nextInstalled] = await Promise.all([
      window.metisPolicy?.getStatus() ?? Promise.resolve(FALLBACK_POLICY_STATUS),
      window.metisProviders?.list() ?? Promise.resolve<ProviderStatus[]>([]),
      window.metisSecrets?.list() ?? Promise.resolve<SecretStatus[]>([]),
      window.metisPermissions?.list() ?? Promise.resolve<PermissionGrant[]>([]),
      window.metisAudit?.list(30) ?? Promise.resolve<AuditEvent[]>([]),
      window.metisRegistry?.list() ?? Promise.resolve(FALLBACK_REGISTRY),
      window.metisRegistry?.listInstalled() ?? Promise.resolve<RegistryPackage[]>([])
    ]);
    setPolicyStatus(nextPolicy);
    setProviders(nextProviders);
    setSecrets(nextSecrets);
    setPermissions(nextPermissions);
    setAuditEvents(nextAudit);
    setRegistry(nextRegistry);
    setInstalledPackages(nextInstalled);
    setRegistryUrl(nextRegistry.sourceUrl.startsWith("http") ? nextRegistry.sourceUrl : "");
  }, []);

  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  async function runBusy(label: string, work: () => Promise<void>): Promise<void> {
    setBusy(label);
    try {
      await work();
      await refreshRuntime();
    } finally {
      setBusy(null);
    }
  }

  function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  // Re-apply live whenever the Appearance section changes anything (the App()
  // mount effect covers the initial app-wide apply on load — this keeps it in
  // sync while Settings stays open, e.g. after "Reset to default").
  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  function updateAppearance<K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]): void {
    setAppearance((current) => ({ ...current, [key]: value }));
  }

  function resetAppearance(): void {
    setAppearance(DEFAULT_APPEARANCE);
  }

  const checkForUpdates = useCallback(async () => {
    if (!window.metisUpdates) return;
    setUpdateBusy(true);
    try {
      const result = await window.metisUpdates.check();
      setUpdateCheck(result);
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  async function saveSecret(provider: ProviderKey): Promise<void> {
    const value = secretDrafts[provider]?.trim();
    if (!value || !window.metisSecrets) return;
    await runBusy(`secret-${provider}`, async () => {
      await window.metisSecrets?.set(provider, value);
      setSecretDrafts((current) => ({ ...current, [provider]: "" }));
    });
  }

  async function clearSecret(provider: ProviderKey): Promise<void> {
    if (!window.metisSecrets) return;
    await runBusy(`secret-${provider}`, async () => {
      await window.metisSecrets?.delete(provider);
    });
  }

  async function healthCheck(provider: ProviderKey): Promise<void> {
    if (!window.metisProviders) return;
    await runBusy(`health-${provider}`, async () => {
      const next = await window.metisProviders?.healthCheck(provider);
      if (!next) return;
      setProviders((current) => current.map((item) => (item.provider === provider ? next : item)));
    });
  }

  async function grantPermission(scope: PermissionScope, target: string, note: string): Promise<void> {
    if (!window.metisPermissions) return;
    await runBusy(`grant-${scope}`, async () => {
      await window.metisPermissions?.request({ scope, target, note });
    });
  }

  async function revokePermission(id: string): Promise<void> {
    if (!window.metisPermissions) return;
    await runBusy(`revoke-${id}`, async () => {
      await window.metisPermissions?.revoke(id);
    });
  }

  async function refreshRegistry(): Promise<void> {
    if (!window.metisRegistry) return;
    await runBusy("registry-refresh", async () => {
      const next = await window.metisRegistry?.refresh(registryUrl.trim() || undefined);
      if (next) setRegistry(next);
    });
  }

  async function installRegistryPackage(id: string): Promise<void> {
    if (!window.metisRegistry) return;
    await runBusy(`install-${id}`, async () => {
      await window.metisRegistry?.install(id);
    });
  }

  async function uninstallRegistryPackage(id: string): Promise<void> {
    if (!window.metisRegistry) return;
    await runBusy(`uninstall-${id}`, async () => {
      await window.metisRegistry?.uninstall(id);
    });
  }

  async function runPolicyTest(): Promise<void> {
    if (!window.metisPolicy || !testPrompt.trim()) return;
    await runBusy("policy-test", async () => {
      const result = await window.metisPolicy?.decide({
        prompt: testPrompt,
        preset: settings.defaultPreset
      });
      if (result) setPolicyDecision(result);
    });
  }

  return (
    <main className="product-workspace settings-workspace" aria-label="Settings">
      <aside className="settings-left">
        <button className="settings-back" type="button" onClick={onBack}>
          <ChevronLeft size={15} />
          <span>Back to app</span>
        </button>
        <label className="settings-search">
          <Search size={14} />
          <input placeholder="Search settings..." value={navQuery} onChange={(event) => setNavQuery(event.target.value)} />
        </label>
        {navGroups.map((group) => (
          <SettingsNavGroup
            key={group}
            title={group}
            items={filteredNav
              .filter((item) => item.group === group)
              .map((item) => ({
                label: item.label,
                icon: item.icon,
                active: item.section === section,
                onClick: () => setSection(item.section)
              }))}
          />
        ))}
        {filteredNav.length === 0 ? <p className="settings-nav-empty">No settings match "{navQuery}".</p> : null}
      </aside>

      <section className="settings-content">
        <header className="settings-title">
          <h1>{SETTINGS_SECTION_META[section].title}</h1>
          <p>{SETTINGS_SECTION_META[section].subtitle}</p>
        </header>

      {section === "general" ? (
      <section className="settings-grid">
        <article className="settings-panel policy-panel">
          <header>
            <span>
              <small>Policy bridge</small>
              <h2>{policyStatus.available ? "Ready" : "Needs setup"}</h2>
            </span>
            <span className={`status-pill ${policyStatus.available ? "ok" : "warn"}`}>{policyStatus.available ? "connected" : "fallback"}</span>
          </header>
          <p>{policyStatus.detail}</p>
          {policyStatus.cliPath ? <code>{policyStatus.cliPath}</code> : null}
          {policyStatus.profilePath ? <code>{policyStatus.profilePath}</code> : null}
          <label className="settings-field wide">
            <span>Test prompt</span>
            <textarea value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} />
          </label>
          <div className="settings-actions">
            <button type="button" onClick={runPolicyTest} disabled={busy === "policy-test"}>
              <Play size={15} />
              Test route
            </button>
            <button type="button" onClick={() => void refreshRuntime()}>
              <RotateCcw size={15} />
              Refresh
            </button>
          </div>
          {policyDecision ? (
            <div className="decision-strip">
              <strong>{policyDecision.decision.selected_route.kind} route</strong>
              <span>{policyDecision.decision.selected_route.provider ?? policyDecision.decision.selected_route.runtime ?? "manual"} / {policyDecision.decision.selected_route.model ?? "none"}</span>
              <small>{policyDecision.source === "sample" ? policyDecision.warnings[0] ?? "Sample fallback used." : policyDecision.decision.reason}</small>
            </div>
          ) : null}
        </article>

        <article className="settings-panel">
          <header>
            <span>
              <small>Defaults</small>
              <h2>Routing preferences</h2>
            </span>
          </header>
          <div className="settings-two">
            <label className="settings-field">
              <span>Router preset</span>
              <CustomSelect
                ariaLabel="Router preset"
                value={settings.defaultPreset}
                onChange={(value) => updateSetting("defaultPreset", value as AppSettings["defaultPreset"])}
                options={[
                  { value: "balanced", label: "Balanced", hint: "Speed and quality mix" },
                  { value: "local_first", label: "Local first", hint: "Prefer on-device models" },
                  { value: "best_quality", label: "Best quality", hint: "Escalate to strongest model" },
                  { value: "cheapest", label: "Cheapest", hint: "Lowest cost route" },
                  { value: "private", label: "Private", hint: "Keep prompts on-device" }
                ]}
              />
            </label>
            <label className="settings-field">
              <span>API access</span>
              <CustomSelect
                ariaLabel="API access"
                value={settings.subscriptionMode}
                onChange={(value) => updateSetting("subscriptionMode", value as AppSettings["subscriptionMode"])}
                options={[
                  { value: "bring-your-own-key", label: "Bring your own keys", hint: "Use your own provider keys" },
                  { value: "metis-subscription", label: "Metis subscription", hint: "Route through a Metis plan" }
                ]}
              />
            </label>
            <label className="settings-field">
              <span>Language</span>
              <input value={settings.language} onChange={(event) => updateSetting("language", event.target.value)} />
            </label>
          </div>
          <label className="settings-field wide">
            <span>Global instructions</span>
            <textarea value={settings.globalInstructions} placeholder="Optional instructions every route should know." onChange={(event) => updateSetting("globalInstructions", event.target.value)} />
          </label>
        </article>

        <article className="settings-panel permissions-panel">
          <header>
            <span>
              <small>Permissions</small>
              <h2>Scoped grants</h2>
            </span>
            <span className="status-pill">{permissions.length} active</span>
          </header>
          <div className="permission-presets">
            {PERMISSION_PRESETS.map((preset) => (
              <button key={`${preset.scope}-${preset.target}`} type="button" onClick={() => void grantPermission(preset.scope, preset.target, preset.note)}>
                <Shield size={15} />
                <span>
                  <strong>{preset.scope}</strong>
                  <small>{preset.note}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="grant-list">
            {permissions.length === 0 ? <p>No scoped grants yet.</p> : null}
            {permissions.map((grant) => (
              <div className="grant-row" key={grant.id}>
                <span>
                  <strong>{grant.scope}</strong>
                  <small>{grant.target} · {new Date(grant.grantedAt).toLocaleString()}</small>
                </span>
                <button type="button" aria-label={`Revoke ${grant.scope}`} onClick={() => void revokePermission(grant.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </article>

        <article className="settings-panel registry-panel">
          <header>
            <span>
              <small>Marketplace registry</small>
              <h2>{registry.status}</h2>
            </span>
            <span className="status-pill">{registry.packages.length} packages</span>
          </header>
          <label className="settings-field wide">
            <span>Static manifest URL</span>
            <input value={registryUrl} placeholder="https://.../metis-registry.json" onChange={(event) => setRegistryUrl(event.target.value)} />
          </label>
          <div className="settings-actions">
            <button type="button" onClick={refreshRegistry} disabled={busy === "registry-refresh"}>
              <Download size={15} />
              Refresh registry
            </button>
          </div>
          {registry.error ? <p className="settings-warning">{registry.error}</p> : null}
          <div className="registry-list">
            {registry.packages.map((item) => {
              const installed = installedIds.has(item.id);
              return (
                <div className="registry-row registry-row-detailed" key={item.id}>
                  {item.ascii_art?.length ? (
                    <pre className="registry-ascii" aria-hidden="true">{item.ascii_art.join("\n")}</pre>
                  ) : null}
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.kind} · {item.publisher} · v{item.version}</small>
                    {item.description ? <p className="registry-description">{item.description}</p> : null}
                    {item.tags.length ? (
                      <span className="registry-tags">
                        {item.tags.map((tag) => (
                          <em key={tag}>{tag}</em>
                        ))}
                      </span>
                    ) : null}
                    {item.permissions_requested.length ? (
                      <small className="registry-permissions">
                        Requests: {item.permissions_requested.join(", ")}
                      </small>
                    ) : null}
                  </span>
                  <button type="button" onClick={() => void (installed ? uninstallRegistryPackage(item.id) : installRegistryPackage(item.id))} disabled={busy === `install-${item.id}` || busy === `uninstall-${item.id}`}>
                    {installed ? "Remove" : "Install"}
                  </button>
                </div>
              );
            })}
          </div>
        </article>

        <article className="settings-panel audit-panel">
          <header>
            <span>
              <small>Audit trail</small>
              <h2>Recent events</h2>
            </span>
            <span className="status-pill">{auditEvents.length}</span>
          </header>
          <div className="audit-list">
            {auditEvents.length === 0 ? <p>No audit events recorded yet.</p> : null}
            {auditEvents.map((event) => (
              <div className={`audit-row ${event.level}`} key={event.id}>
                <span>
                  <strong>{event.kind}</strong>
                  <small>{event.summary}</small>
                </span>
                <em>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</em>
              </div>
            ))}
          </div>
        </article>
      </section>
      ) : null}

      {section === "providers" ? (
      <section className="settings-grid">
        <article className="settings-panel providers-panel">
          <header>
            <span>
              <small>Providers</small>
              <h2>Provider-level keys</h2>
            </span>
            <span className="status-pill">{providers.filter((provider) => provider.configured).length}/{PROVIDER_KEYS.length}</span>
          </header>
          <div className="provider-list">
            {PROVIDER_KEYS.map((provider) => {
              const status = providers.find((item) => item.provider === provider);
              const secret = secretMap.get(provider);
              return (
                <div className="provider-row" key={provider}>
                  <span>
                    <strong>{status?.label ?? PROVIDER_LABELS[provider]}</strong>
                    <small>{status?.detail ?? "Waiting for Electron runtime."}</small>
                  </span>
                  {provider !== "ollama" ? (
                    <input
                      type="password"
                      value={secretDrafts[provider] ?? ""}
                      placeholder={secret?.hasSecret ? "Key saved" : "Paste API key"}
                      onChange={(event) => setSecretDrafts((current) => ({ ...current, [provider]: event.target.value }))}
                    />
                  ) : null}
                  <div className="provider-actions">
                    <button type="button" onClick={() => void healthCheck(provider)} disabled={busy === `health-${provider}`}>Check</button>
                    {provider !== "ollama" ? (
                      <>
                        <button type="button" onClick={() => void saveSecret(provider)} disabled={!secretDrafts[provider]?.trim() || busy === `secret-${provider}`}>Save</button>
                        <button type="button" onClick={() => void clearSecret(provider)} disabled={!secret?.hasSecret || busy === `secret-${provider}`}>Clear</button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      </section>
      ) : null}

      {section === "appearance" ? (
      <section className="settings-grid">
        <article className="settings-panel">
          <header>
            <span>
              <small>Theme</small>
              <h2>Accent color</h2>
            </span>
          </header>
          <div className="settings-field wide">
            <div className="accent-swatches">
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`accent-swatch ${appearance.accent === preset.id ? "active" : ""}`}
                  style={{ background: preset.hex }}
                  aria-label={preset.label}
                  aria-pressed={appearance.accent === preset.id}
                  title={preset.label}
                  onClick={() => updateAppearance("accent", preset.id)}
                >
                  {appearance.accent === preset.id ? <Check size={14} color={preset.textHex} /> : null}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-two">
            <label className="settings-field">
              <span>Density</span>
              <CustomSelect
                ariaLabel="Density"
                value={appearance.density}
                onChange={(value) => updateAppearance("density", value as AppearanceSettings["density"])}
                options={[
                  { value: "comfortable", label: "Comfortable", hint: "More breathing room" },
                  { value: "compact", label: "Compact", hint: "Tighter rows and panels" }
                ]}
              />
            </label>
            <label className="settings-field">
              <span>Text size</span>
              <CustomSelect
                ariaLabel="Text size"
                value={appearance.fontSize}
                onChange={(value) => updateAppearance("fontSize", value as AppearanceSettings["fontSize"])}
                options={[
                  { value: "small", label: "Small" },
                  { value: "normal", label: "Normal" },
                  { value: "large", label: "Large" }
                ]}
              />
            </label>
          </div>
          <div className="settings-actions">
            <button type="button" onClick={resetAppearance}>
              <RotateCcw size={15} />
              Reset to default
            </button>
          </div>
        </article>
      </section>
      ) : null}

      {section === "chat" ? (
      <section className="settings-grid">
        <article className="settings-panel">
          <header>
            <span>
              <small>Ceremony</small>
              <h2>Route &amp; verification verbosity</h2>
            </span>
          </header>
          <div className="settings-two">
            <label className="settings-field">
              <span>Route ceremony</span>
              <CustomSelect
                ariaLabel="Route ceremony"
                value={settings.chatVerbosity}
                onChange={(value) => updateSetting("chatVerbosity", value as AppSettings["chatVerbosity"])}
                options={[
                  { value: "minimal", label: "Minimal", hint: "Just the final answer" },
                  { value: "normal", label: "Normal", hint: "Stage and operation cards" },
                  { value: "verbose", label: "Verbose", hint: "Every side-chat call, unfiltered" }
                ]}
              />
            </label>
            <label className="settings-field">
              <span>Self-verification</span>
              <CustomSelect
                ariaLabel="Self-verification"
                value={selfVerify}
                onChange={(value) => setSelfVerify(value as "off" | "local" | "all")}
                options={[
                  { value: "off", label: "Off", hint: "Never critique stage output" },
                  { value: "local", label: "Local models", hint: "Local tokens are free — critique those stages" },
                  { value: "all", label: "All models", hint: "Also critique cloud model stages" }
                ]}
              />
            </label>
          </div>
          <label className="settings-field toggle-field">
            <span>Streaming responses</span>
            <button
              type="button"
              className={`toggle-switch ${settings.streamingEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={settings.streamingEnabled}
              onClick={() => updateSetting("streamingEnabled", !settings.streamingEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">Prefers live `runStream` updates when the Electron bridge supports it; off falls back to a single non-streaming response per run.</p>
        </article>
      </section>
      ) : null}

      {section === "mcp" ? (
      <section className="settings-grid">
        <article className="settings-panel mcp-panel">
          <header>
            <span>
              <small>Connections</small>
              <h2>Installed MCP servers</h2>
            </span>
            <span className="status-pill">{mcpPackages.length} installed</span>
          </header>
          {mcpPackages.length === 0 ? (
            <p>No MCP servers installed — add one from the Marketplace.</p>
          ) : (
            <div className="registry-list">
              {mcpPackages.map((item) => (
                <div className="registry-row registry-row-detailed" key={item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.publisher} · v{item.version}</small>
                    {item.description ? <p className="registry-description">{item.description}</p> : null}
                    {item.source_url ? <code>{item.source_url}</code> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
          {!window.metisRegistry ? <p className="settings-warning">Electron registry bridge unavailable in this preview — showing local state only.</p> : null}
          <div className="settings-actions">
            <button type="button" onClick={onOpenMcpMarketplace}>
              <Plug size={15} />
              Add from Marketplace
            </button>
          </div>
        </article>
      </section>
      ) : null}

      {section === "privacy" ? (
      <section className="settings-grid">
        <article className="settings-panel">
          <header>
            <span>
              <small>Prompts</small>
              <h2>Local storage</h2>
            </span>
          </header>
          <label className="settings-field wide">
            <span>Prompt storage</span>
            <CustomSelect
              ariaLabel="Prompt storage"
              value={settings.rawPromptStorage}
              onChange={(value) => updateSetting("rawPromptStorage", value as AppSettings["rawPromptStorage"])}
              options={[
                { value: "local-only", label: "Local raw prompts", hint: "Stored only on this machine" },
                { value: "hash-only", label: "Hash only", hint: "Keep a fingerprint, drop the text" }
              ]}
            />
          </label>
        </article>

        <article className="settings-panel">
          <header>
            <span>
              <small>Audit</small>
              <h2>Retention</h2>
            </span>
          </header>
          <p>The audit trail keeps the most recent events emitted by the policy bridge, permissions, and marketplace actions — there's no separate retention window yet, events just age out as new ones arrive.</p>
          <div className="settings-actions">
            <button type="button" onClick={() => setSection("general")}>
              <ScrollText size={15} />
              View audit in General
            </button>
          </div>
        </article>

        <article className="settings-panel">
          <header>
            <span>
              <small>Data controls</small>
              <h2>Export &amp; wipe</h2>
            </span>
          </header>
          <p>No bridge exposes a bulk conversation export or full-data wipe yet — only per-conversation delete/archive (from each conversation's own menu). These stay disabled rather than fake a working action.</p>
          <div className="settings-actions">
            <button type="button" disabled title="No export bridge available yet">
              <Download size={15} />
              Export all data
            </button>
            <button type="button" disabled title="No wipe bridge available yet">
              <Trash2 size={15} />
              Wipe local data
            </button>
          </div>
        </article>
      </section>
      ) : null}

      {section === "about" ? (
      <section className="settings-grid">
        <article className="settings-panel">
          <header>
            <span>
              <small>Version</small>
              <h2>{updateCheck?.currentVersion ? `Metis Orchestrator v${updateCheck.currentVersion}` : "Metis Orchestrator"}</h2>
            </span>
          </header>
          {!window.metisUpdates ? <p>Update bridge unavailable in this preview build.</p> : null}
          {updateCheck?.updateAvailable ? (
            <p className="settings-warning">v{updateCheck.latestVersion ?? "a newer version"} is available.</p>
          ) : updateCheck ? (
            <p>You're on the latest version.</p>
          ) : null}
          <div className="settings-actions">
            <button type="button" onClick={() => void checkForUpdates()} disabled={updateBusy || !window.metisUpdates}>
              <RefreshCw size={15} />
              Check for updates
            </button>
            {updateCheck?.url ? (
              <button type="button" onClick={() => openExternal(updateCheck.url!)}>
                <ExternalLink size={15} />
                Release notes
              </button>
            ) : null}
          </div>
        </article>

        <article className="settings-panel">
          <header>
            <span>
              <small>Links</small>
              <h2>Project</h2>
            </span>
          </header>
          <div className="settings-actions">
            <button type="button" onClick={() => openExternal(METIS_REPO_URL)}>
              <Github size={15} />
              GitHub repository
            </button>
            <button type="button" onClick={onOpenMcpMarketplace}>
              <Plug size={15} />
              Marketplace / MCP registry
            </button>
          </div>
        </article>
      </section>
      ) : null}
      </section>
    </main>
  );
}

function SettingsNavGroup({
  items,
  title
}: {
  items: Array<{ active?: boolean; icon: JSX.Element; label: string; onClick?: () => void }>;
  title: string;
}): JSX.Element {
  return (
    <section className="settings-nav-group">
      <span>{title}</span>
      {items.map((item) => (
        <button className={item.active ? "active" : ""} key={item.label} type="button" onClick={item.onClick}>
          {item.icon}
          <strong>{item.label}</strong>
        </button>
      ))}
    </section>
  );
}

function RoutinesPanel(): JSX.Element {
  return (
    <aside className="palette utility-panel" aria-label="Routines">
      <header className="panel-head">
        <span>
          <small>Schedules</small>
          <h2>Routines</h2>
        </span>
        <CalendarClock size={18} />
      </header>
      <div className="library-panel">
        <PanelRow icon={<CalendarClock size={16} />} title="Daily benchmark refresh" detail="Re-check local models after driver, Ollama, or model updates." />
        <PanelRow icon={<Search size={16} />} title="Reference sync" detail="Pull new design references and update their graph descriptions." />
        <PanelRow icon={<GitBranch size={16} />} title="Policy audit" detail="Compare actual routes against the policy and flag expensive or low-quality decisions." />
      </div>
      <footer className="palette-foot">Routines are scheduled orchestration jobs, not a separate chat mode.</footer>
    </aside>
  );
}

function PanelRow({ detail, icon, meta, title }: { detail: string; icon: JSX.Element; meta?: string; title: string }): JSX.Element {
  return (
    <button className="panel-row" type="button">
      <span className="panel-row-icon">{icon}</span>
      <span className="panel-row-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      {meta ? <em>{meta}</em> : null}
    </button>
  );
}

function NodeInspector({
  node,
  nodes,
  onClose,
  onUpdate,
  onDelete,
  onDetachSkill,
  connectionStates,
  routeTest,
  onTest
}: {
  node: GraphNode;
  nodes: GraphNode[];
  onClose: () => void;
  onUpdate: (id: string, patch: Partial<GraphNode>) => void;
  onDelete: (id: string) => void;
  onDetachSkill: (id: string) => void;
  connectionStates: Partial<Record<ProviderKey, ProviderConnectionState>>;
  routeTest: RouteTestState | null;
  onTest: (agentId: string) => void;
}): JSX.Element {
  const provider = node.provider ? PROVIDERS[node.provider] : null;
  const connectionStatus = node.provider ? providerConnectionStatus(node.provider, connectionStates) : "unknown";
  const needsApiKey = node.kind !== "skill" && connectionStatus !== "local" && connectionStatus !== "connected";
  const fallbacks = node.fallbacks ?? [];
  const skillNodes = (node.skills ?? []).map((id) => nodes.find((n) => n.id === id)).filter((n): n is GraphNode => Boolean(n));

  // Gateway (docs/FABLE_PLANS.md section 25, renamed from "Access via") — the
  // model catalog knows every route (provider) a given model is reachable
  // through; fetched here so the inspector can offer only the routes that
  // actually apply to this node's selected model. Guarded for browser
  // preview / no catalog yet.
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  useEffect(() => {
    if (!window.metisCatalog) return;
    let alive = true;
    window.metisCatalog
      .models()
      .then((state) => {
        if (alive) setCatalogModels(state.models);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Distinct route providers for the node's current model: look up the
  // catalog entry whose name matches this node's model text, and map its
  // access routes' ProviderKeys onto the renderer's brand ids. When the model
  // isn't in the catalog (custom/hand-typed model), fall back to just the
  // node's own provider — there's no known alternate route to offer. When a
  // model has only one route, this list is empty and the Gateway control
  // shows just Auto + that one provider (harmless — every provider family,
  // including anthropic/gemini, is handled identically here).
  const gatewayOptions = useMemo((): ProviderId[] => {
    const catalogEntry = node.model ? catalogModels.find((entry) => entry.name.toLowerCase() === node.model!.toLowerCase()) : undefined;
    const routes = catalogEntry?.access ?? [];
    const brands = routes.map((route) => CATALOG_PROVIDER_TO_BRAND[route.provider]).filter((brand): brand is ProviderId => Boolean(brand));
    const distinct = Array.from(new Set(brands));
    if (distinct.length > 0) return distinct;
    return node.provider ? [node.provider] : [];
  }, [catalogModels, node.model, node.provider]);

  const gatewayFallbacks = node.gatewayFallbacks ?? [];
  // Gateway fallback picker offers the node's OTHER available route
  // providers — the current gateway (or Auto's implicit home provider) and
  // already-added fallbacks are excluded, same exclusion pattern as the model
  // fallback picker's `exists` check below.
  const gatewayFallbackChoices = gatewayOptions.filter((brand) => brand !== node.gateway);

  function setPrimary(event: ChangeEvent<HTMLSelectElement>): void {
    const [providerId, ...rest] = event.target.value.split("|");
    onUpdate(node.id, { provider: providerId as ProviderId, model: rest.join("|") });
  }

  function addFallbackModel(ref: ModelRef): void {
    if (fallbacks.some((f) => f.provider === ref.provider && f.model === ref.model)) return;
    onUpdate(node.id, { fallbacks: [...fallbacks, ref] });
  }

  function removeFallback(index: number): void {
    onUpdate(node.id, { fallbacks: fallbacks.filter((_, i) => i !== index) });
  }

  function promoteFallback(index: number): void {
    const ref = fallbacks[index];
    const demoted: ModelRef | null = provider && node.model ? { provider: node.provider as ProviderId, model: node.model } : null;
    const nextFallbacks = fallbacks.filter((_, i) => i !== index);
    onUpdate(node.id, { provider: ref.provider, model: ref.model, fallbacks: demoted ? [demoted, ...nextFallbacks] : nextFallbacks });
  }

  function setGateway(value: ProviderId | ""): void {
    const nextGateway = value || undefined;
    // Dropping the gateway back to a provider that's already in the fallback
    // list (or clearing it) keeps the fallback list as-is otherwise — it only
    // dedupes the new gateway value out of the fallback list, mirroring how
    // promoteFallback avoids duplicate entries for the model chain.
    onUpdate(node.id, {
      gateway: nextGateway,
      gatewayFallbacks: gatewayFallbacks.filter((brand) => brand !== nextGateway)
    });
  }

  function addGatewayFallback(brand: ProviderId): void {
    if (gatewayFallbacks.includes(brand)) return;
    onUpdate(node.id, { gatewayFallbacks: [...gatewayFallbacks, brand] });
  }

  function removeGatewayFallback(index: number): void {
    onUpdate(node.id, { gatewayFallbacks: gatewayFallbacks.filter((_, i) => i !== index) });
  }

  function promoteGatewayFallback(index: number): void {
    const brand = gatewayFallbacks[index];
    const demoted = node.gateway;
    const nextFallbacks = gatewayFallbacks.filter((_, i) => i !== index);
    onUpdate(node.id, { gateway: brand, gatewayFallbacks: demoted ? [demoted, ...nextFallbacks] : nextFallbacks });
  }

  return (
    <aside className="palette inspector" aria-label={`${node.label} settings`}>
      <header className="inspector-head">
        <button type="button" className="inspector-back" onClick={onClose}>
          <ChevronLeft size={15} /> Library
        </button>
      </header>

      <div className="inspector-title">
        <span className={node.kind === "skill" ? "node-icon skill compact" : "node-icon logo compact"}>
          {node.kind === "skill" ? <ClipboardList size={20} strokeWidth={1.8} /> : <img alt="" src={provider?.logo ?? PROVIDERS.qwen.logo} />}
        </span>
        <input className="inspector-name" value={node.label} onChange={(event) => onUpdate(node.id, { label: event.target.value })} aria-label="Name" />
      </div>

      <div className="inspector-body">
        {node.kind === "agent" ? (
          <label className="field">
            <span>Route intent</span>
            <input value={node.intent ?? ""} placeholder="e.g. frontend design" onChange={(event) => onUpdate(node.id, { intent: event.target.value })} />
          </label>
        ) : null}

        {node.kind !== "skill" ? (
          <>
            <label className="field">
              <span>Primary model</span>
              <select value={node.provider ? `${node.provider}|${node.model}` : ""} onChange={setPrimary}>
                {!node.provider ? <option value="">Unassigned</option> : null}
                {node.provider && !MODEL_LIBRARY.some((ref) => ref.provider === node.provider && ref.model === node.model) ? (
                  <option value={`${node.provider}|${node.model}`}>
                    {PROVIDERS[node.provider].label} · {node.model}
                  </option>
                ) : null}
                {MODEL_LIBRARY.map((ref) => (
                  <option key={`${ref.provider}|${ref.model}`} value={`${ref.provider}|${ref.model}`}>
                    {PROVIDERS[ref.provider].label} · {ref.model}
                    {PROVIDERS[ref.provider].tier === "local" ? " (local)" : ""}
                  </option>
                ))}
              </select>
            </label>

            {node.provider ? (
              <>
                <label className="field">
                  <span>Gateway</span>
                  <CustomSelect
                    ariaLabel="Gateway"
                    value={node.gateway ?? ""}
                    onChange={(value) => setGateway(value ? (value as ProviderId) : "")}
                    options={[
                      { value: "", label: "Auto", hint: "Best available route" },
                      ...gatewayOptions.map((brand) => ({ value: brand, label: PROVIDERS[brand].label }))
                    ]}
                  />
                </label>

                <div className="field">
                  <span>Gateway fallbacks · tries these routes, in order, before Auto</span>
                  <ol className="fallback-list">
                    {gatewayFallbacks.length === 0 ? <li className="fallback-empty">No gateway fallbacks yet</li> : null}
                    {gatewayFallbacks.map((brand, index) => (
                      <li className="fallback-row" key={`${brand}-${index}`}>
                        <span className="fallback-rank">{index + 1}</span>
                        <span className="palette-icon logo small">
                          <img alt="" src={PROVIDERS[brand].logo} />
                        </span>
                        <span className="fallback-name">{PROVIDERS[brand].label}</span>
                        <button type="button" aria-label="Promote to gateway" title="Make gateway" onClick={() => promoteGatewayFallback(index)}>
                          <ChevronUp size={14} />
                        </button>
                        <button type="button" aria-label="Remove gateway fallback" title="Remove" onClick={() => removeGatewayFallback(index)}>
                          <X size={14} />
                        </button>
                      </li>
                    ))}
                  </ol>
                  <div className="fallback-picker" aria-label="Add gateway fallback">
                    {gatewayFallbackChoices.map((brand) => {
                      const exists = gatewayFallbacks.includes(brand);
                      return (
                        <button key={brand} type="button" className={`fallback-option ${exists ? "active" : ""}`} disabled={exists} onClick={() => addGatewayFallback(brand)}>
                          <span className="palette-icon logo small">
                            <img alt="" src={PROVIDERS[brand].logo} />
                          </span>
                          <span>
                            <strong>{PROVIDERS[brand].label}</strong>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : null}

            {needsApiKey ? (
              <div className="node-api-warning">
                <Shield size={14} />
                <span>Connect this provider in Settings before running tests.</span>
              </div>
            ) : null}

            <label className="field">
              <span>Temperature · {(node.temperature ?? 0.4).toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.05} value={node.temperature ?? 0.4} onChange={(event) => onUpdate(node.id, { temperature: Number(event.target.value) })} />
            </label>

            <div className="field">
              <span>
                Fallback chain {node.kind === "router" ? "· tries these if the route model is busy" : "· cheaper / smaller backups"}
              </span>
              <ol className="fallback-list">
                {fallbacks.length === 0 ? <li className="fallback-empty">No fallbacks yet</li> : null}
                {fallbacks.map((ref, index) => (
                  <li className="fallback-row" key={`${ref.provider}-${ref.model}-${index}`}>
                    <span className="fallback-rank">{index + 1}</span>
                    <span className="palette-icon logo small">
                      <img alt="" src={PROVIDERS[ref.provider].logo} />
                    </span>
                    <span className="fallback-name">
                      {PROVIDERS[ref.provider].label} · {ref.model}
                    </span>
                    <button type="button" aria-label="Promote to primary" title="Make primary" onClick={() => promoteFallback(index)}>
                      <ChevronUp size={14} />
                    </button>
                    <button type="button" aria-label="Remove fallback" title="Remove" onClick={() => removeFallback(index)}>
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ol>
              <div className="fallback-picker" aria-label="Add fallback model">
                {MODEL_LIBRARY.map((ref) => {
                  const exists = fallbacks.some((fallback) => fallback.provider === ref.provider && fallback.model === ref.model);
                  return (
                    <button key={`${ref.provider}|${ref.model}`} type="button" className={`fallback-option ${exists ? "active" : ""}`} disabled={exists} onClick={() => addFallbackModel(ref)}>
                      <span className="palette-icon logo small">
                        <img alt="" src={PROVIDERS[ref.provider].logo} />
                      </span>
                      <span>
                        <strong>{PROVIDERS[ref.provider].label}</strong>
                        <small>{ref.model}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        ) : null}

        {node.kind === "agent" ? (
          <div className="field">
            <span>Skills loaded first</span>
            {skillNodes.length === 0 ? <p className="field-hint">Drag skills from the Library onto this agent.</p> : null}
            <ul className="skill-chips">
              {skillNodes.map((skill) => (
                <li key={skill.id} className="skill-chip">
                  <ClipboardList size={13} strokeWidth={1.9} />
                  <span>{skill.label}</span>
                  <button type="button" aria-label={`Detach ${skill.label}`} onClick={() => onDetachSkill(skill.id)}>
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {node.kind === "agent" && routeTest ? (
          <div className={`node-test-result ${routeTest.status}`}>
            <header>
              <small>Route test</small>
              <strong>{routeTest.status === "running" ? "Processing request" : routeTest.status === "error" ? "Route blocked" : "Route completed"}</strong>
            </header>
            <ol>
              <li className="complete">
                <span />
                Router received prompt
              </li>
              <li className={routeTest.status === "running" ? "active" : routeTest.status === "error" ? "" : "complete"}>
                <span />
                {node.intent ? `Matched ${node.intent}` : "Matched selected agent"}
              </li>
              <li className={routeTest.status === "complete" ? "complete" : ""}>
                <span />
                {node.provider ? `${PROVIDERS[node.provider].label} / ${node.model ?? "auto"}` : "No model assigned"}
              </li>
            </ol>
            <p>
              {routeTest.status === "error"
                ? routeTest.message
                : routeTest.status === "complete"
                  ? `Route reached ${node.provider ? PROVIDERS[node.provider].label : "the agent"} and came back clear.`
                  : "Sending a packet along the selected route…"}
            </p>
          </div>
        ) : null}

        {node.kind === "skill" ? <p className="field-hint">Drag this onto an agent to load it on that route, or delete it below.</p> : null}
      </div>

      <footer className="inspector-foot">
        {node.kind === "agent" ? (
          <button type="button" className="inspector-test" onClick={() => onTest(node.id)}>
            <Play size={14} /> Run test
          </button>
        ) : null}
        {node.kind !== "router" ? (
          <button type="button" className="inspector-delete" onClick={() => onDelete(node.id)}>
            <Trash2 size={14} /> Delete
          </button>
        ) : null}
      </footer>
    </aside>
  );
}

function routeSegments(routerPos: Vec, agent: GraphNode, skillIds: string[], resolve: (id: string) => Vec): RouteSegment[] {
  const skillPositions = skillIds.map(resolve);
  if (skillPositions.length === 0) return [{ from: routerPos, to: agent.pos }];
  if (skillPositions.length === 1) return [{ from: routerPos, to: skillPositions[0] }, { from: skillPositions[0], to: agent.pos }];

  const center = average(skillPositions);
  const split = lerp(routerPos, center, 0.55);
  const merge = lerp(agent.pos, center, 0.55);
  return [
    { from: routerPos, to: split },
    ...skillPositions.map((pos) => ({ from: split, to: pos })),
    ...skillPositions.map((pos) => ({ from: pos, to: merge })),
    { from: merge, to: agent.pos }
  ];
}

function average(points: Vec[]): Vec {
  const total = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

function distancePointToSegment(point: Vec, from: Vec, to: Vec): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}

function normalizeMemoryLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function extnameLower(path: string): string {
  const match = /\.[^./\\]+$/.exec(path);
  return match ? match[0].toLowerCase() : "";
}

function lerp(a: Vec, b: Vec, t: number): Vec {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function curve(a: Vec, b: Vec): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return `M ${a.x} ${a.y} C ${a.x + dx * 0.5} ${a.y} ${b.x - dx * 0.5} ${b.y} ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy * 0.5} ${b.x} ${b.y - dy * 0.5} ${b.x} ${b.y}`;
}
