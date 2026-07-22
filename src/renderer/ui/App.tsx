import {
  type CSSProperties,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
  Cloud,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FilePlus,
  FileText,
  Folder,
  GalleryHorizontalEnd,
  Gauge,
  GitBranch,
  GitFork,
  Github,
  Globe,
  HardDrive,
  HelpCircle,
  ImageIcon,
  ImagePlus,
  KeyRound,
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
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  Volume2,
  Wand2,
  Waypoints,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type {
  AuditEvent,
  CatalogModel,
  ConversationExportResult,
  ConversationRecord,
  ConversationTurnRecord,
  GatewayStatus,
  GraphPipelineConfig,
  GraphPipelineStage,
  ManagerAction,
  ManagerChatMessage,
  McpProbeResult,
  ModelCatalogState,
  OllamaListResult,
  OllamaPullProgress,
  PermissionGrant,
  PermissionMode,
  PermissionScope,
  PermissionVerdict,
  PolicyDecisionResult,
  PolicyStatus,
  ProviderAccount,
  ProviderKey,
  ProviderStatus,
  ProjectSnapshot,
  ProjectWorkspace,
  ProjectWorkspaceResource,
  AgentOperation,
  MetisPlan,
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
  UpdateCheckResult,
  UserProfile,
  UserQuestionAnswer
} from "../../shared/runtime-contracts";
// Type-only, so nothing from the electron module is pulled into the renderer
// bundle. LoopRecord lives there rather than in shared/ because loops.ts owns
// the governance constants the record is validated against; global.d.ts
// imports it the same way.
import type { LoopRecord } from "../../electron/loops";
// The SAME parser main.ts uses, so the hint strip under the composer cannot
// promise something different from what the command will actually do.
import { describeLoopCommand, formatLoopDuration, parseLoopCommand, type LoopCommandParts } from "../../shared/loop-command";
import { DEFAULT_SOUND_SETTINGS, SOUND_CUES, type SoundSettings, sound } from "./sound";
import { installDecorativeSound } from "./soundRouter";

/** Narrows SessionStreamEvent down to the `stage_call` variant (docs/FABLE_PLANS.md
 *  §26) so ConversationTurn and the side-chat stack can reference its `call`
 *  shape without repeating the union. */
type StageCallEvent = Extract<SessionStreamEvent, { kind: "stage_call" }>;

type NavKey = "session" | "orchestration" | "routines" | "marketplace" | "gallery" | "graph" | "benchmark" | "todo" | "manager" | "settings" | "pulse";
type NodeKind = "router" | "agent" | "skill";

/** v1 ship scope (docs/SHIP_V1.md section A). v1 is chat plus orchestration done
 *  excellently, so everything that is peripheral, early, or a large trust
 *  surface is hidden rather than deleted: every component, IPC handler and
 *  store key below stays exactly as it is, and bringing a view back for a later
 *  release is deleting one string from this Set.
 *
 *  Reasons, one per key, so a future reader does not have to guess:
 *  manager    - a todo board with a chat window, not the autonomous worker the
 *               README sells; its own code comment says the actions are local-only.
 *  marketplace- installs arbitrary skills/MCP servers from an early registry.
 *  routines   - scheduled automation is explicitly a "later" feature.
 *  gallery    - already held back from the stack (DRILL_PLAN B8.1) and needs a
 *               vision model pulled, which is onboarding friction for a non-core view.
 *  graph      - peripheral; its knowledge-provenance value already shows inline
 *               in chat as the "Grounded on N chunks" row.
 *  todo       - a generic kanban that mostly exists to support Manager.
 *  pulse      - depends on a remote feed that is still mostly empty. */
const V1_HIDDEN_NAV = new Set<NavKey>(["manager", "marketplace", "routines", "gallery", "graph", "todo", "pulse"]);

function isNavVisible(key: NavKey): boolean {
  return !V1_HIDDEN_NAV.has(key);
}

/** The sidebar's collapsible "More" group. Listed here so the disclosure button
 *  can hide itself when every member is hidden, rather than expanding to reveal
 *  nothing - a control that opens onto emptiness is the dead-button problem the
 *  audit exists to remove. */
const MORE_GROUP_NAV: NavKey[] = ["routines", "todo", "gallery", "graph"];

/** Command palette (Ctrl/Cmd+K) "Views" group — nav destinations by label, matching the
 *  labels used elsewhere in the sidebar/titlebar so results feel consistent app-wide.
 *  Module-level so it's a stable identity across renders (docs convention for static lists). */
const PALETTE_VIEWS: Array<{ key: NavKey; label: string; icon: JSX.Element }> = [
  { key: "session", label: "New session", icon: <Plus size={14} /> },
  { key: "orchestration", label: "Orchestration", icon: <GitBranch size={14} /> },
  { key: "manager", label: "Manager", icon: <Bot size={14} /> },
  { key: "marketplace", label: "Marketplace", icon: <Cable size={14} /> },
  { key: "routines", label: "Routines", icon: <CalendarClock size={14} /> },
  { key: "todo", label: "To Do List", icon: <ListTodo size={14} /> },
  { key: "gallery", label: "Gallery", icon: <GalleryHorizontalEnd size={14} /> },
  { key: "graph", label: "Graph View", icon: <Network size={14} /> },
  { key: "benchmark", label: "Benchmark", icon: <Cpu size={14} /> },
  { key: "settings", label: "Settings", icon: <Settings size={14} /> },
  { key: "pulse", label: "Community", icon: <Newspaper size={14} /> }
];

type ProviderId =
  | "qwen"
  | "claude"
  | "openai"
  | "gemini"
  | "grok"
  | "deepseek"
  | "glm"
  | "nvidia"
  | "groq"
  | "openrouter";

type Vec = { x: number; y: number };
type ModelRef = { provider: ProviderId; model: string };
// A saved named model/route preset for the composer picker (DRILL_PLAN
// B5.1) — model: null means the preset captures "Auto router" itself (a
// named default), otherwise it's a direct shortcut onto a specific ModelRef.
type ModelPreset = { id: string; name: string; model: ModelRef | null };
// A saved reusable prompt snippet (DRILL_PLAN Phase 8) — inserted into the
// composer via the "/" popover, mirroring the ModelPreset pattern above.
type PromptTemplate = { id: string; name: string; text: string };
// The "/" popover's row union (DRILL_PLAN I9.9) — "builtin" is the pre-existing
// /orchestration row; "export" and "summarize" are the two new built-in slash
// commands added alongside it. Unlike "template", these three never carry
// deletable user data, they're fixed rows the popover always offers (subject
// to their own bridge/availability checks at render time).
type TemplateRow = { kind: "builtin" } | { kind: "export" } | { kind: "summarize" } | { kind: "handoff" } | { kind: "loop" } | { kind: "loopStarter"; starter: (typeof LOOP_STARTERS)[number] } | { kind: "newTemplate" } | { kind: "template"; template: PromptTemplate };
/** One-click /loop starters (docs/LOOPS.md phase 3). Selecting one INSERTS the
 *  full command for review — it never starts the loop itself. Goals are worded
 *  deliberately: read-mostly, no build/make/create verbs (see loops.ts's
 *  routing-hazard comments), and every one carries explicit --turns so the
 *  default cap is visible in the composer before send. */
const LOOP_STARTERS = [
  { id: "loop-docs", name: "Tidy the docs", insert: "/loop --turns 6 Review the project's README and docs for stale or wrong claims, correcting one file per turn", description: "One doc file per turn, six turns max" },
  { id: "loop-tests", name: "Watch the tests", insert: "/loop --every 15m --turns 8 Check whether the project's tests pass and summarise any failure briefly", description: "Checks every 15m, reports failures" },
  { id: "loop-comments", name: "Comment sweep", insert: "/loop --turns 5 Read the project's source files and add a brief clarifying comment to one confusing function per turn", description: "One function per turn, five turns max" }
] as const;
// Canned prompt /summarize submits verbatim through the normal onSubmit path
// (DRILL_PLAN I9.9) — no new backend, it just reuses the same pipeline a
// hand-typed message would use, so the reply lands as an ordinary assistant turn.
const SLASH_SUMMARIZE_PROMPT = "Summarize this conversation so far: key decisions, open questions, next steps. Be concise.";
// Canned prompt for /handoff (DRILL_PLAN I9.10) — same submit-through-the-
// normal-pipeline shape as /summarize, but produces a CONTINUE-FROM-HERE
// brief written for a fresh context (new session, different model, or
// another person). The chat path already injects recent conversation
// context, so the model has the material; the answer is ordinary markdown
// the existing per-turn copy button lifts out.
const SLASH_HANDOFF_PROMPT =
  "Write a compact handoff brief for continuing this work in a completely fresh session, in markdown: 1) What this is (project and goal, one line). 2) Key decisions made and why. 3) Current state - what is done, what is in flight. 4) Open threads and concrete next steps. Terse and specific, no fluff, no praise - written so someone with zero context can pick this up and continue.";
type ProjectFolder = { name: string; latest: string; age: string; path?: string };

/** One model slot inside a graph node's fallback chain (docs/DRILL_PLAN.md
 *  B11.3): gateways are per-MODEL now, not per-node, because a node holds
 *  several models (primary + fallback chain). Slot-level gateway fields are
 *  LEGACY carry-over from the first B11.3 pass - the editable home of a
 *  model's gateway config is now the global `modelGateways` store (edited by
 *  clicking a model in the Library tab); slot fields still apply when no
 *  global config exists for that model. */
type NodeModelSlot = ModelRef & { gateway?: ProviderId; gatewayFallbacks?: ProviderId[] };

/** A MODEL's own gateway config (docs/DRILL_PLAN.md B11.3 v2, Lachy's
 *  correction): the gateway belongs to the model itself, globally - you set
 *  it by CLICKING the model in the Library tab (a clean click; dragging past
 *  the threshold still assigns the model to a node like before). Persisted
 *  under the "modelGateways" app-store key as a map keyed by
 *  modelGatewayKey(ref), and baked into every graphPipeline projection so
 *  main.ts needs no extra lookup. */
type ModelGatewayConfig = {
  gateway?: ProviderId;
  gatewayFallbacks?: ProviderId[];
  /** Other MODELS to try when this one fails outright, in order. Distinct from
   *  gatewayFallbacks, which are other ROUTES to this same model: a gateway
   *  fallback answers "reach GPT-5.1 another way", a model fallback answers
   *  "GPT-5.1 is unreachable, use something else".
   *
   *  Per-MODEL for the same reason gateways became per-model (Lachy): a chain
   *  is a property of the model, not of wherever you happened to drop it. Set
   *  Claude's fallbacks once and every node using Claude inherits them, instead
   *  of re-picking the same chain on each node and having them silently drift.
   *  Node-level `fallbacks` stay as a legacy fallback so existing graphs route
   *  exactly as they did. */
  fallbacks?: ModelRef[];
};
const EMPTY_MODEL_GATEWAYS: Record<string, ModelGatewayConfig> = {};

function modelGatewayKey(ref: ModelRef): string {
  return `${ref.provider}|${ref.model}`;
}

/** THE one place the fallback-chain precedence is decided: a model's own
 *  configured chain wins, and the node's slot list is legacy carry-over used
 *  only when the model has none.
 *
 *  Shared rather than duplicated on purpose. The Depths rungs were written with
 *  their resolution logic merely ADJACENT to the projection's, on the reasoning
 *  that adjacency would keep them honest, and they diverged anyway: the node
 *  advertised rungs the engine never received. One function, two callers. */
function resolveModelFallbacks(
  primary: ModelRef,
  nodeFallbacks: NodeModelSlot[] | undefined,
  modelGateways: Record<string, ModelGatewayConfig>
): NodeModelSlot[] {
  if (!primary.provider || !primary.model?.trim()) return nodeFallbacks ?? [];
  const configured = modelGateways[modelGatewayKey(primary)]?.fallbacks;
  return configured?.length ? (configured as NodeModelSlot[]) : (nodeFallbacks ?? []);
}

type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  pos: Vec;
  provider?: ProviderId;
  model?: string;
  fallbacks?: NodeModelSlot[];
  intent?: string;
  skills?: string[];
  temperature?: number;
  /** @deprecated "Access via" override (docs/FABLE_PLANS.md section 21) —
   *  superseded by `gateway` (section 25 update). Kept only so loadNodes can
   *  migrate old persisted graphs: on load, an existing `accessVia` with no
   *  `gateway` set becomes the node's `gateway`. Not written by the
   *  NodeInspector anymore; do not read it directly elsewhere. */
  accessVia?: ProviderId;
  /** The PRIMARY model's gateway (docs/DRILL_PLAN.md B11.3 reinterpretation
   *  of the section-25 field): gateways are per-model now, and since the
   *  primary model lives directly on the node as `provider`/`model`, its
   *  gateway keeps living here too - which is also the migration story, old
   *  persisted graphs' node-level pin simply becomes the primary model's pin.
   *  Fallback-chain models carry their own gateway on their NodeModelSlot.
   *  Projected into GraphPipelineStage.gateway by projectGraphPipeline. */
  gateway?: ProviderId;
  /** The PRIMARY model's ordered gateway fallbacks (see `gateway` above):
   *  additional route providers to try, in order, after `gateway` and before
   *  falling through to the model's remaining routes by health. Mirrors the
   *  per-node model fallback chain's interaction pattern (add/remove/promote). */
  gatewayFallbacks?: ProviderId[];
  /** Depths (DRILL_PLAN B11.2): when enabled, this node routes by the
   *  router's judged depth. Each level can pin its own model; unset levels
   *  fall back to depth defaults (L1 local, L2 policy route, L3 strongest
   *  configured cloud). Edits also mirror into the global depthRoutes store
   *  so the shipped backend engine consumes them today; true per-node
   *  consumption in the pipeline is the noted follow-up. */
  depthsEnabled?: boolean;
  /** Per-level choice: a pinned model, or the literal "router" meaning the
   *  router model handles that level itself (no re-route at all - Lachy's
   *  "just the option of the router, not routing"). Unset = level default. */
  depthModels?: { l1?: ModelRef | "router"; l2?: ModelRef | "router"; l3?: ModelRef | "router" };
};

type DragPayload =
  | { kind: "skill"; name: string }
  | { kind: "model"; provider: ProviderId; model: string };

type RouteSegment = { from: Vec; to: Vec };

/** A user-authored local skill (text-based for now; file-based can follow later).
 *  Persisted under the `customSkills` app-store key (docs/FABLE_PLANS.md section 18). */
type CustomSkill = {
  id: string;
  name: string;
  description?: string;
  /** The skill's actual text, loaded from a .md file the user picked (or typed).
   *  This is what gets injected into a stage prompt when the skill is wired
   *  onto a node. A skill without content is a LABEL, and the canvas saying it
   *  "loads first" is only true when there is something to load. */
  content?: string;
};
// Stable empty-array fallbacks for useAppStoreState: an inline `[] as T[]` literal is a fresh
// reference every render, which re-fires the store's load effect and can stomp a just-written
// update before it's ever persisted. Module-level constants keep the reference stable.
const EMPTY_CUSTOM_SKILLS: CustomSkill[] = [];
const EMPTY_STARRED_PACKAGES: string[] = [];
// Stable module-level fallback for useAppStoreState("expandedProjects", ...) —
// see the EMPTY_CUSTOM_SKILLS comment: an inline [] literal is a fresh
// reference every render and would re-fire the load effect.
const EMPTY_EXPANDED_PROJECTS: string[] = [];
// Stable module-level fallback for useAppStoreState("providerAccounts", ...) — see comment above.
const DEFAULT_PROVIDER_ACCOUNTS: ProviderAccount[] = [];

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
  /** "stopped" is the user's own Stop: a distinct state from "error" on
   *  purpose. Both end the run, but a stop keeps whatever had already streamed
   *  and reads as neutral, while an error still surfaces red and honestly. */
  status: "running" | "complete" | "error" | "stopped";
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
   *  `resolved` is the single source of truth for both the floating chatbox
   *  popup (interactive) and the inline chat record (collapsed audit line):
   *  once set, the popup stops offering this request and the inline card
   *  shows the collapsed line permanently. */
  pendingPermission?: { id: string; scope: PermissionScope; target: string; detail: string; resolved?: { verdict: PermissionVerdict } };
  /** AskUserQuestion awaiting an answer (docs/FABLE_PLANS.md §24, multi-question
   *  popup docs/DRILL_PLAN.md B2.3a). `questions` carries the up-to-4-question
   *  form when present; `text`/`options` stay populated as the first entry's
   *  mirror for back-compat. `resolved.answer` mirrors what was sent to
   *  `metisSession.answerQuestion` (single string, or one string per question
   *  in order). */
  pendingQuestion?: {
    id: string;
    text: string;
    options: string[];
    questions?: Array<{ text: string; options: string[]; allowCustom?: boolean }>;
    resolved?: { answer: UserQuestionAnswer };
  };
};

const METIS_REPO_URL = "https://github.com/lachydotmcg/metis-orchestrator";
/** Fallback owner display name when no profile name is set yet (matches the
 *  pre-profile hardcoded placeholder so first paint never looks broken). */
const DEFAULT_PROFILE_NAME = "bro";
/** Human label for each MetisPlan value (docs/DRILL_PLAN.md B3.2b) — "byo" is
 *  the only plan today; this map exists so a future paid tier only needs a
 *  new entry here, not a new render branch. */
const PLAN_LABELS: Record<MetisPlan, string> = { byo: "BYO" };
/** Step labels for the first-run onboarding stepper (docs/DRILL_PLAN.md B3.2b/B3.3). */
const ONBOARDING_STEP_LABELS = ["Welcome", "Preference", "Hardware", "Install", "Keys"] as const;

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
    // A user Stop is not a failure. The spread already preserved
    // liveAssistantText (the streamed answer was never deleted, only hidden by
    // PendingRun's error branch), so flipping to "stopped" and leaving `error`
    // undefined is all it takes to keep what the user was reading on screen.
    if (event.cancelled) return { ...turn, status: "stopped", error: undefined };
    return { ...turn, status: "error", error: event.message };
  }
  if (event.kind === "permission_request") {
    return { ...turn, pendingPermission: { id: event.request.id, scope: event.request.scope, target: event.request.target, detail: event.request.detail } };
  }
  if (event.kind === "user_question") {
    return {
      ...turn,
      pendingQuestion: { id: event.question.id, text: event.question.text, options: event.question.options, questions: event.question.questions }
    };
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
  groq: { label: "Groq", logo: "assets/providers/autorouter.png", tier: "cloud" },
  openrouter: { label: "OpenRouter", logo: "assets/providers/autorouter.png", tier: "cloud" }
};
// nvidia/groq/openrouter are GATEWAYS (API-key route providers), never
// standalone model brands in the picker — a model reached through them is
// expressed as an access route (docs/FABLE_PLANS.md §21/§25b), surfaced on
// the model's Gateway panel, not as its own brand here. The openrouter brand
// exists ONLY so OpenRouter routes display as "OpenRouter" in gateway pickers
// instead of borrowing the Grok brand (Grok models happen to be REACHED via
// OpenRouter, which is a different fact entirely).
const GATEWAY_ONLY_BRANDS: ProviderId[] = ["nvidia", "groq", "openrouter"];
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
  groq: "groq",
  openrouter: "openrouter"
};

/** Key for the per-model latency map (DRILL_PLAN I9.8) — built once from real
 *  run.providerResult.provider + run.providerResult.model, and looked up the
 *  same way from a picker row's PROVIDER_CONNECTIONS[ref.provider] + (its
 *  localOllamaTagFor(ref) ollama tag, or ref.model for cloud rows). Keeping
 *  both sides funneled through this one function is what keeps the two ends
 *  of the lookup in sync. */
function modelLatencyKey(provider: ProviderKey, model: string): string {
  return `${provider}::${model}`;
}

/** Latency-dot tone for the model picker (DRILL_PLAN I9.8) — thresholds are in
 *  ms of measured time-to-first-token. Deliberately coarse (3 buckets) since
 *  this is a glance-level signal, not a precise benchmark. */
function latencyDotTone(ttftMs: number): "fast" | "medium" | "slow" {
  if (ttftMs < 800) return "fast";
  if (ttftMs < 2500) return "medium";
  return "slow";
}

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

/** Same mapping but for displaying ROUTE providers (gateway pickers, the
 *  via-Provider suffix): an OpenRouter route must read "OpenRouter", not
 *  "Grok". CATALOG_PROVIDER_TO_BRAND keeps openrouter->grok ONLY for model
 *  bucketing (openrouter-home catalog models like Grok land under the Grok
 *  brand in the picker); routes are a different concept - Claude via
 *  OpenRouter has nothing to do with Grok (Lachy's B11 catch). */
const ROUTE_PROVIDER_TO_BRAND: Record<ProviderKey, ProviderId> = {
  ...CATALOG_PROVIDER_TO_BRAND,
  openrouter: "openrouter"
};

/** Finds the registry catalog entry for a picker ModelRef (docs/DRILL_PLAN.md
 *  B11.1). The picker's library uses short brand-scoped names ("V4 Flash")
 *  while the catalog uses full names ("DeepSeek V4 Flash"), so an exact name
 *  match alone misses most library models - which is why the Gateway picker
 *  used to offer only the model's home provider. Match order: exact name
 *  (remote-catalog picks carry the full name), then a same-home-provider
 *  entry whose full name CONTAINS the short name, then any entry with an
 *  access route on that provider whose raw route id matches (covers custom
 *  hand-typed models entered as real API ids). */
function findCatalogModelEntry(catalog: CatalogModel[], ref: ModelRef): CatalogModel | undefined {
  const name = ref.model.trim().toLowerCase();
  if (!name) return undefined;
  const exact = catalog.find((entry) => entry.name.toLowerCase() === name);
  if (exact) return exact;
  const key = PROVIDER_CONNECTIONS[ref.provider];
  if (!key) return undefined;
  return (
    catalog.find((entry) => entry.provider === key && entry.name.toLowerCase().includes(name)) ??
    catalog.find((entry) => (entry.access ?? []).some((route) => route.provider === key && route.id.toLowerCase() === name))
  );
}

const MODEL_LIBRARY: ModelRef[] = [
  { provider: "claude", model: "Opus 4.8" },
  { provider: "claude", model: "Sonnet 5" },
  { provider: "claude", model: "Fable 5" },
  { provider: "claude", model: "Haiku 4.5" },
  { provider: "openai", model: "GPT-5.6 Sol" },
  { provider: "openai", model: "GPT-5.6 Terra" },
  { provider: "openai", model: "GPT-5.6 Luna" },
  { provider: "openai", model: "GPT-5.1" },
  { provider: "openai", model: "GPT-5 mini" },
  { provider: "gemini", model: "3.1 Pro" },
  { provider: "gemini", model: "3.5 Flash" },
  { provider: "gemini", model: "2.5 Pro" },
  { provider: "gemini", model: "2.5 Flash" },
  { provider: "grok", model: "Grok 4.5" },
  { provider: "grok", model: "Grok 4.3" },
  { provider: "deepseek", model: "V4 Pro" },
  { provider: "deepseek", model: "V4 Flash" },
  { provider: "deepseek", model: "V3" },
  { provider: "deepseek", model: "R1" },
  { provider: "qwen", model: "Qwen3.7 Max" },
  { provider: "qwen", model: "Qwen2.5 72B" },
  { provider: "qwen", model: "Qwen3 4B" },
  { provider: "glm", model: "GLM-5.2" },
  { provider: "glm", model: "GLM-4.6" }
];

// Persisted via useAppStoreState("modelPresets", ...) — empty until Lachy
// saves one from the composer picker; never seeded with demo entries.
const DEFAULT_MODEL_PRESETS: ModelPreset[] = [];
const MAX_MODEL_PRESETS = 12;

// Persisted via useAppStoreState("promptTemplates", ...) — empty until Lachy
// saves a draft as a template from the composer toolbar; never seeded with
// demo entries (DRILL_PLAN Phase 8).
const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [];
const MAX_PROMPT_TEMPLATES = 20;

// Persisted via useAppStoreState("conversationModels", ...) (DRILL_PLAN
// B7.1) — remembers which pinned model (or null = Auto Router) each real
// conversation was last using, so switching between conversations restores
// its own model instead of leaking whatever was last picked elsewhere.
// Capped at MAX_CONVERSATION_MODELS entries (oldest insertions dropped
// first) so a long-lived app's map never grows unbounded.
const DEFAULT_CONVERSATION_MODELS: Record<string, ModelRef | null> = {};
const MAX_CONVERSATION_MODELS = 50;

function pruneConversationModels(map: Record<string, ModelRef | null>): Record<string, ModelRef | null> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_CONVERSATION_MODELS) return map;
  const next: Record<string, ModelRef | null> = {};
  keys.slice(keys.length - MAX_CONVERSATION_MODELS).forEach((key) => {
    next[key] = map[key];
  });
  return next;
}

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

type LocalModel = {
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
const LOCAL_MODELS: LocalModel[] = [
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

/** Resolves a picker/composer ModelRef to its backing LOCAL_MODELS ollamaTag
 *  (matched by display name), for install-state lookups (DRILL_PLAN B5.2) and
 *  prewarm targeting. Returns null for cloud-tier refs and for local refs with
 *  no matching LOCAL_MODELS entry (e.g. a hosted-only local-brand model) —
 *  never guesses a tag. The single source of truth for that name<->tag
 *  pairing; callers should reuse this rather than re-deriving it. */
function localOllamaTagFor(ref: ModelRef): string | null {
  if (PROVIDERS[ref.provider].tier !== "local") return null;
  return LOCAL_MODELS.find((entry) => entry.name === ref.model)?.ollamaTag ?? null;
}

// Manager base-model picker (Manager tab, L12): null means the default
// Manager chain; otherwise this pins the Manager to a specific model, mirroring
// the shape SessionComposer's modelOverride builds from a picked ModelRef.
type ManagerModelChoice = { provider: ProviderKey; model: string } | null;
const DEFAULT_MANAGER_MODEL: ManagerModelChoice = null;
const MANAGER_MODEL_OPTIONS: SelectOption[] = [
  { value: "auto", label: "Auto" },
  ...MODEL_LIBRARY.map((ref) => ({
    value: `${ref.provider}:${ref.model}`,
    label: `${PROVIDERS[ref.provider].label} ${ref.model}`
  }))
];

/** Encodes a ManagerModelChoice into a MANAGER_MODEL_OPTIONS value string. */
function managerModelOptionValue(choice: ManagerModelChoice): string {
  if (!choice) return "auto";
  const brand = CATALOG_PROVIDER_TO_BRAND[choice.provider];
  return `${brand}:${choice.model}`;
}

/** Decodes a MANAGER_MODEL_OPTIONS value string back into a ManagerModelChoice. */
function managerModelFromOptionValue(value: string): ManagerModelChoice {
  if (value === "auto") return null;
  const idx = value.indexOf(":");
  if (idx < 0) return null;
  const brand = value.slice(0, idx) as ProviderId;
  const model = value.slice(idx + 1);
  const provider = PROVIDER_CONNECTIONS[brand];
  if (!provider || !model) return null;
  return { provider, model };
}

// Vision model picker (Orchestration workspace, L12b): "" means auto-detect
// (the backend picks a vision model itself); otherwise this is an Ollama tag.
// The gallery image-analysis path is Ollama-only and the backend resolver
// treats this value as an Ollama tag, so ONLY local vision models are offered —
// a cloud value would never be installed and would silently fall back to auto.
const DEFAULT_VISION_MODEL = "";
const VISION_MODEL_OPTIONS: SelectOption[] = [
  { value: "", label: "Auto-detect" },
  ...LOCAL_MODELS.filter((model) => model.roles?.includes("vision")).map((model) => ({
    value: model.ollamaTag ?? model.name,
    label: model.name,
    hint: model.role
  }))
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

// Benchmark role filter chips (docs/DRILL_PLAN.md Phase 1, L10/L17). "all" shows
// every model; the rest filter LOCAL_MODELS by its `roles` tag.
const BENCHMARK_ROLE_FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "router", label: "Router" },
  { key: "coding", label: "Coding" },
  { key: "planning", label: "Planning" },
  { key: "vision", label: "Vision" },
  { key: "embeddings", label: "Embeddings" }
];

// Stable module-level default for the "run local-first vs. cloud-heavy" toggle,
// persisted via useAppStoreState so it survives restarts.
const DEFAULT_BENCHMARK_LOCAL_FIRST = true;

// Stable module-level default for the prompt-prewarm experiment (docs/DRILL_PLAN.md
// E1 v0.1b) — read via useAppStoreState("prewarmEnabled", ...) by both the chat
// composer (to decide whether to fire the debounced warm call) and the Settings
// "Experiments" toggle (to flip it). OFF by default; main.ts's prewarmModel() also
// re-checks this same store key itself as defense-in-depth.
const DEFAULT_PREWARM_ENABLED = false;

// Stable module-level default for the model-driven routing experiment — read via
// useAppStoreState("modelDrivenRoutingEnabled", ...) by the Settings > Chat >
// Experiments toggle. The main process's router reads this same store key to
// decide whether to classify prompts with a local model instead of keyword
// rules, falling back to the rules on any failure. OFF by default.
const DEFAULT_MODEL_DRIVEN_ROUTING_ENABLED = false;

// Stable module-level default for "close to tray" — read via
// useAppStoreState("closeToTray", ...) by the Settings > General toggle. The
// main process reads this same store key to decide whether closing the window
// hides Metis in the tray instead of quitting. OFF by default.
const DEFAULT_CLOSE_TO_TRAY = false;

/** A single Oracle warm call the composer chip's expandable log remembers
 *  (docs/DRILL_PLAN.md B5.5) — in-memory only, capped to ORACLE_LOG_CAP
 *  entries, never persisted. `ms` is the renderer-timed round trip
 *  (Date.now() delta wrapping the window.metisPrewarm.warm() call), not a
 *  model-reported figure. */
interface OracleWarmEvent {
  model: string;
  ms: number;
  at: number;
}

/** The Oracle composer chip's current phase (docs/DRILL_PLAN.md B5.5). Set
 *  ONLY from a window.metisPrewarm.warm() call that actually fired — never a
 *  simulated or optimistic state. "warming" while that call is in flight,
 *  "warm" once it resolves with the renderer-timed round trip in `ms`. A
 *  rejected call reverts silently back to "idle" (fail quiet, honest UI). */
type OracleActivity = { phase: "idle" } | { phase: "warming"; model: string } | { phase: "warm"; model: string; ms: number };

const ORACLE_IDLE: OracleActivity = { phase: "idle" };
const ORACLE_LOG_CAP = 5;

/** A speculative "what would the model say" preview (docs/DRILL_PLAN.md O2b —
 *  "I do want to see a preview of what the ai is thinking"). Resolved from
 *  window.metisPrewarm.draft() on the slower 800ms debounce below; `thoughts`
 *  is only present when the backend surfaces a reasoning/thinking trace ahead
 *  of the final text. Shown ONLY in the Oracle popover — never inserted into
 *  the chat transcript or the composer, since it's a guess, not an answer. */
type OracleDraftResult = { text: string; thoughts?: string };

// Prerequisite skills recommended alongside the model install in onboarding.
// Matched case-insensitively against registry package names — see
// matchSkillPackage below (docs/DRILL_PLAN.md Phase 4 follow-up).
const RECOMMENDED_ONBOARDING_SKILLS: readonly string[] = ["Planning", "Agentic Tasks", "UI Design"];

/** Picks the strongest fitting model tagged with `role` for the given GPU —
 *  prefers a "great" fit over "tight", then the largest model that still fits.
 *  Returns undefined when nothing tagged for that role fits at all (caller
 *  should show "none fits this GPU" rather than fall back to a bad pick). */
function pickBestForRole(models: ScoredModel[], role: string): ScoredModel | undefined {
  const tagged = models.filter((model) => model.roles?.includes(role) && model.fit !== "over" && model.fit !== "cpu");
  if (tagged.length === 0) return undefined;
  const great = tagged.filter((model) => model.fit === "great");
  const pool = great.length ? great : tagged;
  return pool.reduce((best, model) => (model.vram > best.vram ? model : best), pool[0]);
}

/** Case-insensitive name match for a recommended onboarding skill against
 *  the registry's "skill" packages — used to wire the onboarding chips up
 *  to a real one-click install (docs/DRILL_PLAN.md Phase 4 follow-up). */
function matchSkillPackage(skillName: string, packages: RegistryPackage[]): RegistryPackage | undefined {
  const needle = skillName.trim().toLowerCase();
  return packages.find((pkg) => pkg.kind === "skill" && pkg.name.trim().toLowerCase() === needle);
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

/** One stage of a seeded-registry-shaped preset payload (`metis.preset-*`, docs/DRILL_PLAN.md
 *  Phase 4): {role, provider, model, fallback?}. Distinct from the in-app Publish wizard's
 *  {nodes, saved_at} payload shape — loadPreset() branches on which one is stored. */
type PresetStage = { role: string; provider: ProviderId; model: string; fallback?: ModelRef };

/** What a marketplace preset package's `source_url` payload can parse into: either the
 *  Publish-wizard shape ({nodes}) or the seeded-registry shape ({stages}), both optionally
 *  carrying `prerequisiteSkills` to auto-install. Anything else is treated as invalid. */
type MarketplacePresetPayload = {
  nodes?: GraphNode[];
  stages?: PresetStage[];
  prerequisiteSkills?: string[];
};

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

/** Sound is opt-in, so "reduce motion" never has to turn anything OFF - it only
 *  explains why the feature starts silent (docs/DRILL_PLAN.md B12.10). Tracked
 *  as its own store key because useAppStoreState cannot tell a stored
 *  `{ enabled: false }` from an untouched fallback, and the hint must stop
 *  appearing once the user has made a choice of their own. Deliberately NOT
 *  read anywhere inside sound.ts: once the user opts in, reduced motion has no
 *  further say at runtime. */
const SOUND_TOUCHED_KEY = "soundSettingsTouched";

/** main.ts throws this exact message for every Stop-button path (its
 *  CANCELLATION_MESSAGE). Electron's ipcRenderer.invoke re-wraps a rejected
 *  handler as "Error invoking remote method '<channel>': Error: <message>", so
 *  this has to be a substring test, never an equality one. Used to keep the
 *  runError cue off user cancellations: stopping a run on purpose is a thing
 *  the user did, not a failure worth sounding (docs/DRILL_PLAN.md B12.10). */
const CANCELLATION_MESSAGE = "Stopped by user.";

function isUserCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(CANCELLATION_MESSAGE);
}

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
  // Set the moment the USER writes through `update` - closes a race Lachy hit
  // live (quick-ask/headless toggles "not sticking"): a click landing before
  // the initial store read resolved was (a) dropped by the write effect's
  // !loaded guard and then (b) clobbered back to the stored value by the
  // read resolving. With the flag: user intent always wins the race and
  // always writes.
  const dirtyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void readAppStore(key, fallback).then((stored) => {
      if (!alive) return;
      if (!dirtyRef.current) setValue(stored);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [fallback, key]);

  useEffect(() => {
    // Never persist the untouched fallback over a stored value; DO persist a
    // user write even when it beat the initial load.
    if (!loaded && !dirtyRef.current) return;
    void writeAppStore(key, value);
  }, [key, loaded, value]);

  const update = useCallback((next: T | ((current: T) => T)) => {
    dirtyRef.current = true;
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
  // Sidebar expansion (Lachy: "I want them to stay expanded if you expand
  // them") - a SET of open project names, not a single active one, persisted
  // so the shape of your sidebar survives restarts. Opening one no longer
  // collapses another.
  const [expandedProjects, setExpandedProjects] = useAppStoreState("expandedProjects", EMPTY_EXPANDED_PROJECTS);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [storedConversations, setStoredConversations] = useState<ConversationRecord[]>([]);
  const [openConversation, setOpenConversation] = useState<ConversationRecord | null>(null);
  const initialNavResolved = useRef(false);

  // Owner profile (docs/DRILL_PLAN.md B3.2b/B3.3) — fetched once from the
  // metisProfile bridge (undefined in the preview, where onboarding never
  // shows). `profileChecked` gates the onboarding decision so a fresh app
  // never flashes the overlay before the real profile has loaded.
  const [ownerProfile, setOwnerProfile] = useState<UserProfile | null>(null);
  const [profileChecked, setProfileChecked] = useState(false);
  // Settings > Profile's "Add a key now" deep link (docs/DRILL_PLAN.md B3.2b
  // step 5) stages this so SettingsWorkspace opens straight on Providers;
  // SettingsWorkspace resets it back to "general" once consumed so a later
  // plain Settings visit doesn't stick on Providers.
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("general");
  // Ctrl/Cmd+K command palette (DRILL_PLAN Phase 8) — mounted at the App root so it overlays
  // every view. Global shortcut only opens; Escape/backdrop-click closes are handled inside
  // CommandPalette itself so the listener here never fights with the palette's own keydowns.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);
  const openSettingsSection = useCallback((section: SettingsSection) => {
    setSettingsInitialSection(section);
    setActiveNav("settings");
  }, []);

  useEffect(() => {
    if (!window.metisProfile) {
      setProfileChecked(true);
      return;
    }
    let alive = true;
    void window.metisProfile
      .get()
      .then((loaded) => {
        if (!alive) return;
        setOwnerProfile(loaded);
        setProfileChecked(true);
      })
      .catch(() => {
        if (alive) setProfileChecked(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const updateProfile = useCallback(async (patch: Partial<UserProfile>): Promise<void> => {
    if (!window.metisProfile) {
      // Preview / no bridge: honest local-only fallback so the Settings
      // profile field still reflects an edit instead of silently no-op'ing.
      setOwnerProfile((current) => (current ? { ...current, ...patch } : current));
      return;
    }
    const next = await window.metisProfile.set(patch);
    setOwnerProfile(next);
  }, []);

  const showOnboarding = profileChecked && Boolean(window.metisProfile) && Boolean(ownerProfile) && !ownerProfile?.onboardedAt;
  const profileDisplayName = ownerProfile?.name?.trim() || DEFAULT_PROFILE_NAME;
  const profilePlanLabel = ownerProfile ? PLAN_LABELS[ownerProfile.plan] : PLAN_LABELS.byo;

  function openBenchmarkFromOnboarding(): void {
    setActiveNav("benchmark");
  }

  function openProvidersFromOnboarding(): void {
    setSettingsInitialSection("providers");
    setActiveNav("settings");
  }

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
      setExpandedProjects((current) => current.filter((name) => name !== project.name));
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
    // Alongside the benchmark gate rather than instead of it: a persisted
    // activeNav from a previous build, or any caller that still names a hidden
    // view, must not be able to reach one now that it has no way back.
    if (!isNavVisible(key)) {
      setActiveNav("session");
      return;
    }
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
    setExpandedProjects((current) => (current.includes(project.name) ? current.filter((name) => name !== project.name) : [...current, project.name]));
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
      }),
      // Cues fire from all over the app, not just while Settings is open, so
      // the engine gets its settings once here at boot (docs/DRILL_PLAN.md
      // B12.10). The Sound panel pushes its own updates live on top of this.
      readAppStore("soundSettings", DEFAULT_SOUND_SETTINGS).then((value) => {
        sound.setSettings({ ...DEFAULT_SOUND_SETTINGS, ...value });
      })
    ]);
    if (window.metisConversations) {
      void window.metisConversations.list().then(setStoredConversations);
    }
  }, []);

  // The decorative tier routes itself off delegated listeners rather than
  // per-component handlers (docs/DRILL_PLAN.md B12.10 — see soundRouter.ts).
  // This subscribes the router to the sound settings for the life of the app;
  // the router then attaches and detaches its own document listeners as the
  // tier is switched on and off, so with sound off — the default — nothing is
  // listening for pointer events at all.
  useEffect(() => installDecorativeSound(), []);

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
      setExpandedProjects(EMPTY_EXPANDED_PROJECTS);
    }
  }, [benchmarkLoaded, benchmarkWizard.status]);

  return (
    <div className="app-root">
      <Titlebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
        onOpenPulse={() => setActiveNav("pulse")}
        onOpenSearch={() => setPaletteOpen(true)}
      />
      <div className={`metis-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${activeNav === "settings" ? "settings-mode" : ""}`}>
      {activeNav !== "settings" ? (
        <Sidebar
          activeNav={activeNav}
          activeConversationId={openConversation?.id}
          expandedProjects={expandedProjects}
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
            setExpandedProjects((current) => (current.includes(project.name) ? current : [...current, project.name]));
            startNewSession();
          }}
          onProjectDelete={deleteProjectByPath}
          onProjectSelect={selectProject}
          onSelect={selectNav}
          onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
          onTogglePinned={toggleConversationPinned}
          pinnedConversationIds={pinnedConversationIds}
          pinnedConversations={pinnedConversations}
          planLabel={profilePlanLabel}
          profileName={profileDisplayName}
          projects={sidebarProjects}
        />
      ) : null}
      {activeNav === "session" ? (
        <NewSessionWorkspace
          key={sessionKey}
          profileName={profileDisplayName}
          openConversation={openConversation}
          onConversationsChanged={refreshConversations}
          onNewSession={startNewSession}
          onNavigate={setActiveNav}
          onOpenConversationById={openConversationById}
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
      {activeNav === "marketplace" ? <MarketplaceWorkspace onNavigate={setActiveNav} /> : null}
      {activeNav === "routines" ? <RoutinesWorkspace onConversationOpen={openConversationById} /> : null}
      {activeNav === "todo" ? <TodoWorkspace storedConversations={storedConversations} /> : null}
      {activeNav === "manager" ? <ManagerWorkspace onNavigate={setActiveNav} /> : null}
      {activeNav === "pulse" ? <PulseWorkspace /> : null}
      {activeNav === "settings" ? (
        <SettingsWorkspace
          onBack={() => setActiveNav(benchmarkWizard.status === "complete" ? "orchestration" : "benchmark")}
          onOpenMcpMarketplace={openMcpMarketplace}
          initialSection={settingsInitialSection}
          onInitialSectionConsumed={() => setSettingsInitialSection("general")}
          profile={ownerProfile}
          onProfileChange={updateProfile}
        />
      ) : null}
      {activeNav !== "session" && activeNav !== "graph" && activeNav !== "benchmark" && activeNav !== "gallery" && activeNav !== "marketplace" && activeNav !== "routines" && activeNav !== "todo" && activeNav !== "manager" && activeNav !== "pulse" && activeNav !== "settings" ? (
        <GraphWorkspace activeNav={activeNav} gallerySkills={linkedGallerySkills} galleryVisuals={galleryVisuals} />
      ) : null}
      </div>
      <ManagerWidget onNavigate={setActiveNav} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        conversations={storedConversations}
        onNavigate={setActiveNav}
        onOpenConversation={openConversationById}
        onOpenSettingsSection={openSettingsSection}
      />
      {showOnboarding && ownerProfile ? (
        <FirstRunOnboarding
          profile={ownerProfile}
          onOpenBenchmark={openBenchmarkFromOnboarding}
          onOpenProviders={openProvidersFromOnboarding}
          onFinish={(patch) => void updateProfile(patch)}
        />
      ) : null}
    </div>
  );
}

/** First-run onboarding overlay (docs/DRILL_PLAN.md B3.2b + B3.3) — shown once, above
 *  everything, only when the metisProfile bridge exists and the local profile has never
 *  finished onboarding (`onboardedAt` unset). Walks the owner through a name, a
 *  local-vs-cloud model preference, hardware picks and local-model install (both
 *  deep-linked into the existing BenchmarkWorkspace rather than reimplemented here — that
 *  workspace already owns GPU-based recommendation and one-click Ollama pulls), and a short
 *  BYO-keys explainer that can deep-link to Settings > Providers. Finishing OR skipping
 *  always stamps `onboardedAt` so the overlay never reappears once dismissed. */
function FirstRunOnboarding({
  profile,
  onOpenBenchmark,
  onOpenProviders,
  onFinish
}: {
  profile: UserProfile;
  onOpenBenchmark: () => void;
  onOpenProviders: () => void;
  onFinish: (patch: Partial<UserProfile>) => void;
}): JSX.Element {
  const [step, setStep] = useState(1);
  // Deep-linking into Benchmark (steps 3/4) hides the overlay so the owner can
  // actually use that page, replaced by a small floating pill to come back —
  // the wizard step itself stays intact underneath since this component never
  // unmounts while onboarding is incomplete.
  const [minimized, setMinimized] = useState(false);
  const [name, setName] = useState(profile.name ?? "");
  const [preference, setPreference] = useState<"local" | "cloud" | "hybrid" | null>(profile.modelPreference ?? null);

  function finish(): void {
    const trimmed = name.trim();
    onFinish({
      name: trimmed || undefined,
      modelPreference: preference ?? undefined,
      onboardedAt: new Date().toISOString()
    });
  }

  function addKeyNow(): void {
    finish();
    onOpenProviders();
  }

  function deepLinkBenchmark(): void {
    setMinimized(true);
    onOpenBenchmark();
  }

  // Enter-to-advance (docs/DRILL_PLAN.md B4.1) — a window-level listener rather than an
  // onKeyDown on the card, because each step's Continue button unmounts on transition and
  // takes focus with it (focus reverts to <body>, outside any element-level handler's
  // bubble path). Skips BUTTON targets so a focused button's own native Enter-click keeps
  // working untouched (Back, "Do this later", a preference card), and skips TEXTAREA so a
  // future multi-line field still gets a real newline. On step 2 it only advances once a
  // preference is picked, mirroring the disabled Continue button. Final step runs the same
  // `finish()` the "Skip for now" action uses, not the extra provider deep-link.
  useEffect(() => {
    if (minimized) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Enter" || event.shiftKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "BUTTON") return;
      event.preventDefault();
      if (step === 1) setStep(2);
      else if (step === 2) {
        if (preference) setStep(3);
      } else if (step === 3) setStep(4);
      else if (step === 4) setStep(5);
      else if (step === 5) finish();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [minimized, step, preference, name]);

  if (minimized) {
    return (
      <div className="onboarding-resume">
        <button type="button" className="onboarding-resume-btn" onClick={() => setMinimized(false)}>
          <Sparkles size={14} />
          Continue setup, step {step} of {ONBOARDING_STEP_LABELS.length}
          <ArrowRight size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card" role="dialog" aria-modal="true" aria-label="Welcome to Metis">
        <div className="onboarding-dots" aria-hidden="true">
          {ONBOARDING_STEP_LABELS.map((label, index) => {
            const stepNumber = index + 1;
            return (
              <span key={label} className={`onboarding-dot ${step === stepNumber ? "active" : step > stepNumber ? "done" : ""}`}>
                {step > stepNumber ? <Check size={11} /> : stepNumber}
              </span>
            );
          })}
        </div>

        {step === 1 ? (
          <section className="onboarding-step">
            <span className="hero-icon">
              <Sparkles size={20} />
            </span>
            <h1>Welcome to Metis</h1>
            <p>Let&rsquo;s get your workspace set up. It only takes a minute, and you can change any of this later in Settings.</p>
            <label className="settings-field">
              <span>Your name</span>
              <input autoFocus value={name} placeholder="What should we call you?" onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="onboarding-actions">
              <button type="button" className="onboarding-skip" onClick={finish}>
                Do this later
              </button>
              <button type="button" className="primary-action" onClick={() => setStep(2)}>
                Continue <ArrowRight size={15} />
              </button>
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="onboarding-step">
            <h1>How do you want to run models?</h1>
            <p>You can mix both later, this just sets a starting point.</p>
            <div className="onboarding-pref-grid">
              <button type="button" className={`onboarding-pref-card ${preference === "local" ? "selected" : ""}`} onClick={() => setPreference("local")}>
                <HardDrive size={18} />
                <strong>Local models</strong>
                <small>Keep it free and private. Runs on your own hardware through Ollama.</small>
              </button>
              <button type="button" className={`onboarding-pref-card ${preference === "cloud" ? "selected" : ""}`} onClick={() => setPreference("cloud")}>
                <Cloud size={18} />
                <strong>Cloud</strong>
                <small>Use hosted models instead. No local install needed.</small>
              </button>
              <button type="button" className={`onboarding-pref-card ${preference === "hybrid" ? "selected" : ""}`} onClick={() => setPreference("hybrid")}>
                <Shuffle size={18} />
                <strong>Hybrid</strong>
                <small>Let me choose. Use both local and cloud, whichever fits the task.</small>
              </button>
            </div>
            <div className="onboarding-actions">
              <button type="button" className="ghost-action" onClick={() => setStep(1)}>
                <ArrowLeft size={14} /> Back
              </button>
              <button type="button" className="primary-action" disabled={!preference} onClick={() => setStep(3)}>
                Continue <ArrowRight size={15} />
              </button>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="onboarding-step">
            <h1>{preference === "cloud" ? "Cloud needs no local install" : "Check your hardware"}</h1>
            {preference === "cloud" ? (
              <p>You picked cloud, so there&rsquo;s nothing to install locally. Metis routes prompts to whichever providers you connect in Settings. You can still add local models anytime from Benchmark.</p>
            ) : (
              <>
                <p>Metis already matches your hardware to a recommended local setup on the Benchmark page, no run required. Open it to check your hardware and see the picks, then come back here to continue.</p>
                <div className="onboarding-deeplink">
                  <button type="button" className="ghost-action" onClick={deepLinkBenchmark}>
                    <Cpu size={15} /> Open Benchmark
                  </button>
                </div>
              </>
            )}
            <div className="onboarding-actions">
              <button type="button" className="ghost-action" onClick={() => setStep(2)}>
                <ArrowLeft size={14} /> Back
              </button>
              <button type="button" className="primary-action" onClick={() => setStep(4)}>
                Continue <ArrowRight size={15} />
              </button>
            </div>
          </section>
        ) : null}

        {step === 4 ? (
          <section className="onboarding-step">
            <h1>{preference === "cloud" ? "Nothing to install" : "Install your recommended models"}</h1>
            {preference === "cloud" ? (
              <p>Cloud preference selected, so this step is skippable. You can install local models anytime from Benchmark if you change your mind.</p>
            ) : (
              <>
                <p>The Benchmark page has a one-click install for the models it just recommended, pulled straight from Ollama with live progress.</p>
                <div className="onboarding-deeplink">
                  <button type="button" className="ghost-action" onClick={deepLinkBenchmark}>
                    <Download size={15} /> Open Benchmark to install
                  </button>
                </div>
              </>
            )}
            <div className="onboarding-actions">
              <button type="button" className="ghost-action" onClick={() => setStep(3)}>
                <ArrowLeft size={14} /> Back
              </button>
              <button type="button" className="primary-action" onClick={() => setStep(5)}>
                Continue <ArrowRight size={15} />
              </button>
            </div>
          </section>
        ) : null}

        {step === 5 ? (
          <section className="onboarding-step">
            <h1>Bring your own keys</h1>
            <p>
              Metis is free to use, there&rsquo;s no subscription. You bring your own provider keys (Anthropic, OpenAI, Gemini, DeepSeek and more), or a
              single OpenRouter key covers most of them. Your plan is <strong>BYO</strong>, always.
            </p>
            <div className="onboarding-actions">
              <button type="button" className="ghost-action" onClick={() => setStep(4)}>
                <ArrowLeft size={14} /> Back
              </button>
              <div className="onboarding-actions-right">
                <button type="button" className="onboarding-skip" onClick={finish}>
                  Skip for now
                </button>
                <button type="button" className="primary-action" onClick={addKeyNow}>
                  <KeyRound size={15} /> Add a key now
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
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
  onOpenPulse,
  onOpenSearch
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenPulse: () => void;
  onOpenSearch: () => void;
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
        <button className="titlebar-icon" type="button" aria-label="Search" title="Search (Ctrl+K)" onClick={onOpenSearch}>
          <Search size={16} />
        </button>
        <button className="titlebar-icon" type="button" aria-label="Community" onClick={handleOpenPulse}>
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

type PaletteResult = {
  id: string;
  group: "Views" | "Conversations" | "Settings";
  label: string;
  sublabel?: string;
  icon: JSX.Element;
  onSelect: () => void;
};

/** Titlebar Search -> Ctrl/Cmd+K global command palette (DRILL_PLAN Phase 8). Mounted once at
 *  the App root so it overlays every view. Sources are deliberately limited to what's already
 *  reachable from here without a fresh fetch: nav destinations (PALETTE_VIEWS), open
 *  conversations (storedConversations, same list/open path the sidebar uses), and Settings
 *  sections (SETTINGS_NAV, deep-linked the same way Providers-from-onboarding does). Marketplace
 *  packages are intentionally NOT a source — the registry list lives inside MarketplaceWorkspace /
 *  SettingsWorkspace's own state, not up here, and re-fetching it just to power search would
 *  duplicate a bridge call for a feature that's supposed to be a quick nav shortcut. */
function CommandPalette({
  open,
  onClose,
  conversations,
  onNavigate,
  onOpenConversation,
  onOpenSettingsSection
}: {
  open: boolean;
  onClose: () => void;
  conversations: ConversationRecord[];
  onNavigate: (nav: NavKey) => void;
  onOpenConversation: (id: string) => void;
  onOpenSettingsSection: (section: SettingsSection) => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlighted(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const results = useMemo<PaletteResult[]>(() => {
    if (!open) return [];
    const q = query.trim().toLowerCase();
    const list: PaletteResult[] = [];

    const shippable = PALETTE_VIEWS.filter((view) => isNavVisible(view.key));
    const views = q ? shippable.filter((view) => view.label.toLowerCase().includes(q)) : shippable;
    for (const view of views.slice(0, 6)) {
      list.push({ id: `view-${view.key}`, group: "Views", label: view.label, icon: view.icon, onSelect: () => onNavigate(view.key) });
    }

    if (q) {
      const matchedConversations = conversations.filter((conversation) => conversation.title.toLowerCase().includes(q)).slice(0, 6);
      for (const conversation of matchedConversations) {
        list.push({
          id: `conversation-${conversation.id}`,
          group: "Conversations",
          label: conversation.title,
          icon: <MessageCircle size={14} />,
          onSelect: () => onOpenConversation(conversation.id)
        });
      }

      const matchedSettings = SETTINGS_NAV.filter((item) => isSettingsSectionVisible(item.section) && item.label.toLowerCase().includes(q)).slice(0, 6);
      for (const item of matchedSettings) {
        list.push({
          id: `settings-${item.section}`,
          group: "Settings",
          label: item.label,
          sublabel: item.group,
          icon: item.icon,
          onSelect: () => onOpenSettingsSection(item.section)
        });
      }
    }

    return list;
  }, [open, query, conversations, onNavigate, onOpenConversation, onOpenSettingsSection]);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  if (!open) return null;

  function select(index: number): void {
    const result = results[index];
    if (!result) return;
    result.onSelect();
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => (results.length ? (current + 1) % results.length : 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => (results.length ? (current - 1 + results.length) % results.length : 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      select(highlighted);
    }
  }

  let lastGroup: PaletteResult["group"] | null = null;

  return (
    <>
      <div className="command-palette-backdrop" onClick={onClose} />
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={handleKeyDown}>
        <div className="command-palette-input-row">
          <Search size={15} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search views, conversations, settings..."
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="command-palette-results">
          {results.length === 0 ? (
            <p className="command-palette-empty">No matches</p>
          ) : (
            results.map((result, index) => {
              const showHeader = result.group !== lastGroup;
              lastGroup = result.group;
              return (
                <div key={result.id} className="command-palette-item-wrap">
                  {showHeader ? <div className="command-palette-group">{result.group}</div> : null}
                  <button
                    type="button"
                    className={`command-palette-result ${index === highlighted ? "active" : ""}`}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => select(index)}
                  >
                    {result.icon}
                    <span className="command-palette-result-label">{result.label}</span>
                    {result.sublabel ? <span className="command-palette-result-sub">{result.sublabel}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

/** Community (internally still "pulse" — see NavKey / window.metisPulse), promoted from a
 *  titlebar popover to a full nav view (docs/FABLE_PLANS.md section 18) — a centered,
 *  generously-spaced feed: Changelog as a vertical timeline, Community projects as cards,
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
    <main className="product-workspace pulse-workspace" aria-label="Community">
      <div className="pulse-workspace-column">
        <header className="pulse-workspace-head">
          <h1>Community</h1>
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
  activeConversationId,
  expandedProjects,
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
  planLabel,
  profileName,
  projects
}: {
  activeNav: NavKey;
  /** The chat currently open in the session view — its sidebar row gets the
   *  active highlight (Lachy: highlight the chat you're on, not the folder). */
  activeConversationId?: string;
  expandedProjects: string[];
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
  /** Plan label from the owner profile (docs/DRILL_PLAN.md B3.2b) — "BYO" today. */
  planLabel: string;
  /** Owner display name from the profile, already falling back to the
   *  default placeholder when no name is set (see DEFAULT_PROFILE_NAME). */
  profileName: string;
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
        {isNavVisible("manager") ? <NavButton active={activeNav === "manager"} disabled={benchmarkLocked} icon={<Bot size={16} />} label="Manager" onClick={() => onSelect("manager")} /> : null}
        {isNavVisible("marketplace") ? <NavButton active={activeNav === "marketplace"} disabled={benchmarkLocked} icon={<Cable size={16} />} label="Marketplace" onClick={() => onSelect("marketplace")} /> : null}
        {/* Benchmark is the only member of the old More group that ships in v1
            (docs/SHIP_V1.md), so it sits inline rather than behind a disclosure
            that would expand to reveal a single item. */}
        <NavButton active={activeNav === "benchmark"} icon={<Cpu size={16} />} label="Benchmark" onClick={() => onSelect("benchmark")} />
        {moreOpen ? (
          <>
            {isNavVisible("routines") ? <NavButton active={activeNav === "routines"} disabled={benchmarkLocked} icon={<CalendarClock size={16} />} label="Routines" onClick={() => onSelect("routines")} /> : null}
            {isNavVisible("todo") ? <NavButton active={activeNav === "todo"} disabled={benchmarkLocked} icon={<ListTodo size={16} />} label="To Do List" onClick={() => onSelect("todo")} /> : null}
            {isNavVisible("gallery") ? <NavButton active={activeNav === "gallery"} disabled={benchmarkLocked} icon={<GalleryHorizontalEnd size={16} />} label="Gallery" onClick={() => onSelect("gallery")} /> : null}
            {isNavVisible("graph") ? <NavButton active={activeNav === "graph"} disabled={benchmarkLocked} icon={<Network size={16} />} label="Graph View" onClick={() => onSelect("graph")} /> : null}
          </>
        ) : null}
        {MORE_GROUP_NAV.some(isNavVisible) ? (
          <button className="nav-more" type="button" onClick={() => setMoreOpen((open) => !open)}>
            <ChevronDown className={moreOpen ? "open" : ""} size={14} />
            <span>{moreOpen ? "Less" : "More"}</span>
          </button>
        ) : null}
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
            const expanded = expandedProjects.includes(project.name);
            const conversations = conversationsByProject[project.name] ?? [];
            const projectMenuOpen = rowMenu?.kind === "project" && rowMenu.project.name === project.name;
            return (
              <div className={`project-group ${expanded ? "expanded" : ""}`} key={project.name}>
                <div className="project-row-wrap row-menu-wrap">
                  {/* Expansion is shown by the caret alone — the row tint is
                      reserved for the ACTIVE CHAT below (Lachy: highlight the
                      chat you're on, not the project folder it lives in). */}
                  <button
                    className="project-row"
                    type="button"
                    disabled={benchmarkLocked}
                    title={benchmarkLocked ? "Finish the benchmark wizard first" : undefined}
                    onClick={() => onProjectSelect(project)}
                  >
                    {/* B12 sidebar simplification (Lachy): just the project
                        name. The caret occupies reserved space and fades in on
                        hover (or stays while expanded) so nothing shifts. The
                        folder glyph and the latest-activity line are gone. */}
                    <ChevronRight className={`project-caret ${expanded ? "open" : ""}`} size={13} />
                    <strong>{project.name}</strong>
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
                            <button className={`project-conversation-row ${conversation.id === activeConversationId ? "active" : ""}`} type="button" onClick={() => onConversationOpen(conversation.id)} title={conversation.summary || conversation.title}>
                              {/* Title only (B12 sidebar simplification) - the
                                  summary moved to the tooltip rather than a
                                  second line under every row. */}
                              <strong>{conversation.title}</strong>
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
              <div className="account-menu-head">{profileName}</div>
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
          <span>{profileName}</span>
          <small>{planLabel}</small>
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

/** Short names for the compact composer mode pill (Claude-Code-style), keyed off PermissionMode. */
const PERMISSION_MODE_SHORT: Record<PermissionMode, string> = {
  ask: "Manual",
  edits: "Accept edits",
  plan: "Plan",
  auto: "Auto",
  bypass: "Bypass"
};

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

  }

  // CORE.1: the old guesses ("Add a second page", "Open the preview and
  // refine the design", "Continue the <noun>") are gone. They fired on any
  // successful run regardless of what was actually discussed, which is
  // exactly the fake-suggestion problem real follow-ups replace. What
  // survives above are the two cases grounded in real run STATE (a failed
  // verification, a failed repair), where the next step is genuinely known
  // without guessing. Everything else waits for the model's own follow-ups.
  return null;
}

function NewSessionWorkspace({
  profileName,
  onConversationsChanged,
  onNewSession,
  onNavigate,
  onOpenConversationById,
  openConversation,
  storedConversations = [],
  pendingByConversation,
  setPendingByConversation,
  busyKeys,
  setBusyKeys,
  draftToRealRef
}: {
  /** Owner display name from the profile (falls back to the default when
   *  unset) - the home greeting addresses the owner by name. */
  profileName: string;
  onConversationsChanged?: () => void;
  onNewSession?: () => void;
  /** Lets an approved open_view action on a run's proposed-actions card (see
   *  RunProposedActions) switch the app's active nav, same as the Manager tab. */
  onNavigate?: (nav: NavKey) => void;
  /** I9.5 fork: jump to a specific conversation (the fresh fork) by id. */
  onOpenConversationById?: (id: string) => void;
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

  // Per-model latest first-token latency (DRILL_PLAN I9.8) — read from real
  // telemetry only (run.providerResult.model + the top-level run.ttftMs
  // promoted from it), never simulated. Walks the same stored-conversation
  // turns + runtime session runs the usage telemetry above already holds;
  // keeps the most recent createdAt reading per model so a stale run never
  // outranks a fresh one. Passed down to the model picker as a plain
  // string -> ms map so a row with no reading renders no dot at all.
  const modelLatencyMs = useMemo(() => {
    const latest = new Map<string, { ttftMs: number; at: number }>();
    const consider = (run: SessionRun | undefined, at: number): void => {
      const model = run?.providerResult?.model;
      const provider = run?.providerResult?.provider;
      const ttftMs = run?.ttftMs;
      if (!model || !provider || typeof ttftMs !== "number") return;
      const key = modelLatencyKey(provider, model);
      const existing = latest.get(key);
      if (!existing || at > existing.at) latest.set(key, { ttftMs, at });
    };
    storedConversations.forEach((conversation) => {
      conversation.turns.forEach((turn) => {
        if (turn.role === "user") return;
        const created = new Date(turn.createdAt);
        consider(turn.run, Number.isNaN(created.getTime()) ? Date.now() : created.getTime());
      });
    });
    runtimeTelemetryRuns.forEach((run) => consider(run, new Date(run.createdAt).getTime()));
    const result = new Map<string, number>();
    latest.forEach((value, key) => result.set(key, value.ttftMs));
    return result;
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
  // Per-conversation model memory (DRILL_PLAN B7.1). `lastSelectedModel` is
  // the user's most recent explicit pick, independent of any conversation —
  // it's what a brand-new draft session seeds `selectedModel` from (see the
  // seed effect near activeConversationId below). `conversationModels` maps
  // each REAL conversation id to the model it was last using, so switching
  // back to it restores that choice instead of whatever's currently live.
  const [lastSelectedModel, setLastSelectedModel, lastSelectedModelLoaded] = useAppStoreState<ModelRef | null>("lastSelectedModel", null);
  const [conversationModels, setConversationModels] = useAppStoreState("conversationModels", DEFAULT_CONVERSATION_MODELS);
  const [routerFilter, setRouterFilter] = useState("");
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [draftModelName, setDraftModelName] = useState("");
  const [draftModelProvider, setDraftModelProvider] = useState<ProviderId>("claude");
  const [customModels, setCustomModels] = useAppStoreState("customModels", [] as ModelRef[]);
  const [modelPresets, setModelPresets] = useAppStoreState("modelPresets", DEFAULT_MODEL_PRESETS);
  // Saved prompt snippets (DRILL_PLAN Phase 8) — persisted here (the parent)
  // rather than inside SessionComposer so they survive its per-draft remount,
  // same reasoning as modelPresets above.
  const [promptTemplates, setPromptTemplates] = useAppStoreState("promptTemplates", DEFAULT_PROMPT_TEMPLATES);
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
      // Same brand-aware lookup as the Gateway picker (B11.1): short library
      // names like "V4 Flash" resolve to their full catalog entry, so the
      // "via <Provider>" suffix works for library picks too, not just
      // remote-catalog picks that carry the full name.
      const entry = findCatalogModelEntry(remoteModelCatalog, ref);
      const access = entry?.access;
      if (!entry || !access || access.length < 2) return null;

      const statusFor = (key: ProviderKey) => providerStatuses.find((status) => status.provider === key);
      const configuredNotCooling = access.find((route) => {
        const status = statusFor(route.provider);
        return status && status.status !== "not_configured" && status.status !== "unavailable";
      });
      const bestRoute = configuredNotCooling ?? access.find((route) => statusFor(route.provider)?.status !== "not_configured") ?? access[0];
      if (bestRoute.provider === entry.provider) return null;

      const brand = ROUTE_PROVIDER_TO_BRAND[bestRoute.provider];
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
    pickModel({ provider: draftModelProvider, model: name });
    setDraftModelName("");
    setAddModelOpen(false);
    setRouterOpen(false);
  }

  // Remembers `model` as the pinned model for real conversation `id` (DRILL_PLAN
  // B7.1), pruning down to MAX_CONVERSATION_MODELS entries so the persisted map
  // never grows unbounded across a long-lived app. Stale entries for since-
  // deleted conversations are harmless — they're just never looked up again,
  // and eventually age out via the same prune.
  function rememberConversationModel(id: string, model: ModelRef | null): void {
    void setConversationModels((current) => pruneConversationModels({ ...current, [id]: model }));
  }

  // Every explicit model pick (router menu, preset, or "add custom model")
  // routes through here: it updates the live selection, remembers it as the
  // user's last-used GLOBAL choice (what a brand-new draft session seeds
  // from — see the seed effect below), and — only when a REAL conversation
  // is open — remembers it as that conversation's own pinned model too. A
  // fresh/draft session (no real id yet) skips the per-conversation write;
  // its pick is copied over once the draft becomes real, in submitPrompt's
  // draft->real migration.
  function pickModel(model: ModelRef | null): void {
    // B12.1: switching away from a model mid-conversation is a preference
    // signal - record the model being ABANDONED (fire-and-forget, local).
    if (
      activeConversationId &&
      selectedModel &&
      (model === null || model.provider !== selectedModel.provider || model.model !== selectedModel.model)
    ) {
      void window.metisPreference?.signal({
        kind: "model_switch",
        provider: PROVIDER_CONNECTIONS[selectedModel.provider],
        model: selectedModel.model,
        conversationId: activeConversationId
      });
    }
    setSelectedModel(model);
    void setLastSelectedModel(model);
    if (activeConversationId) rememberConversationModel(activeConversationId, model);
  }

  // Named model/route presets (DRILL_PLAN B5.1) — a saved shortcut onto a
  // ModelRef (or null for a named "Auto router" default). Saving under a
  // name that already exists (case-insensitive) overwrites that preset in
  // place rather than creating a duplicate; otherwise capped at
  // MAX_MODEL_PRESETS so the group never grows unbounded.
  function deleteModelPreset(id: string): void {
    void setModelPresets((current) => current.filter((preset) => preset.id !== id));
  }

  // Saved prompt snippets (DRILL_PLAN Phase 8) — same overwrite-by-name +
  // cap behavior as deleteModelPreset/MAX_MODEL_PRESETS above: saving under a
  // name that already exists (case-insensitive) overwrites that template's
  // text in place, otherwise appends and drops the oldest entry once past
  // MAX_PROMPT_TEMPLATES so the list never grows unbounded.
  function savePromptTemplate(name: string, text: string): void {
    const trimmedName = name.trim();
    const trimmedText = text.trim();
    if (!trimmedName || !trimmedText) return;
    void setPromptTemplates((current) => {
      const existingIndex = current.findIndex((template) => template.name.toLowerCase() === trimmedName.toLowerCase());
      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = { ...next[existingIndex], text: trimmedText };
        return next;
      }
      const next = [...current, { id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: trimmedName, text: trimmedText }];
      return next.length > MAX_PROMPT_TEMPLATES ? next.slice(next.length - MAX_PROMPT_TEMPLATES) : next;
    });
  }

  function deletePromptTemplate(id: string): void {
    void setPromptTemplates((current) => current.filter((template) => template.id !== id));
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
  // The single active pending permission/question for the CURRENTLY VIEWED
  // conversation (docs/DRILL_PLAN.md B2.3/B2.4 chatbox popup) — scans back to
  // front so a later turn's ask wins if somehow more than one is open. A
  // background run in a conversation the user isn't looking at never surfaces
  // its popup here, matching the existing pendingByConversation/activeKey split.
  const activePendingPermission = useMemo(() => {
    for (let i = conversation.length - 1; i >= 0; i--) {
      const turn = conversation[i];
      if (turn.pendingPermission && !turn.pendingPermission.resolved) {
        return { turnId: turn.id, request: turn.pendingPermission };
      }
    }
    return null;
  }, [conversation]);
  const activePendingQuestion = useMemo(() => {
    if (activePendingPermission) return null; // permission takes priority when both are somehow pending
    for (let i = conversation.length - 1; i >= 0; i--) {
      const turn = conversation[i];
      if (turn.pendingQuestion && !turn.pendingQuestion.resolved) {
        return { turnId: turn.id, question: turn.pendingQuestion };
      }
    }
    return null;
  }, [conversation, activePendingPermission]);
  // A live-readable mirror of activeKey for long-lived closures (the
  // runStream event callback below persists for a run's whole lifetime, so it
  // can't rely on the `activeKey` const captured at submit time to know
  // whether the user is STILL looking at this conversation later on).
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  // Per-conversation model memory, part 2 (DRILL_PLAN B7.1): restores the
  // pinned model whenever activeConversationId actually CHANGES (switching
  // to a stored conversation via the sidebar, or the draft->real transition
  // in submitPrompt below) — including an explicit recorded `null` (Auto).
  // Guarded on the id CHANGING (not on every conversationModels write) so
  // picking a model in the CURRENT conversation — which also writes into
  // conversationModels — never loops back through here and clobbers itself.
  // No entry recorded yet for this id -> leave selectedModel exactly as-is
  // (never force back to Auto).
  const prevActiveConversationIdRef = useRef(activeConversationId);
  useEffect(() => {
    const previousId = prevActiveConversationIdRef.current;
    prevActiveConversationIdRef.current = activeConversationId;
    if (activeConversationId === previousId) return;
    if (!activeConversationId) return;
    if (Object.prototype.hasOwnProperty.call(conversationModels, activeConversationId)) {
      setSelectedModel(conversationModels[activeConversationId] ?? null);
    }
  }, [activeConversationId, conversationModels]);

  // Per-conversation model memory, part 3: a brand-new draft session (no
  // real conversation open yet) starts from the user's last-used GLOBAL
  // choice instead of hardcoded Auto. Seeded exactly once, only once
  // lastSelectedModel has actually loaded from disk, and only when this
  // mount ISN'T opening an existing stored conversation (that case is
  // already handled by the restore effect above, which takes priority).
  const seededGlobalModelRef = useRef(false);
  useEffect(() => {
    if (seededGlobalModelRef.current || !lastSelectedModelLoaded) return;
    seededGlobalModelRef.current = true;
    if (activeConversationId) return;
    setSelectedModel(lastSelectedModel);
  }, [lastSelectedModelLoaded, lastSelectedModel, activeConversationId]);

  const [history, setHistory] = useState<ConversationTurnRecord[]>([]);
  const hasConversation = conversation.length > 0 || history.length > 0;
  const homeScrollRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState(0);
  const [workspaceContextOpen, setWorkspaceContextOpen] = useState(false);
  const [previewRail, setPreviewRail] = useState<{ url: string; title: string } | null>(null);
  /** Result of the last "/loop" command. Dismissible and never auto-hidden:
   *  it names where the loop can be stopped, which is not something to flash
   *  past someone who has just started an unattended run. */
  const [loopNotice, setLoopNotice] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
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

  /** Slim per-conversation token line (DRILL_PLAN Phase 8): sums real
   *  providerResult.usage across every run in the active conversation's
   *  turns. Never estimates a total itself — only real recorded usage counts
   *  toward the sum, and the whole line is flagged "approximate" if any
   *  contributing run's usage was itself marked estimated (e.g. Ollama's
   *  char-count fallback in estimateUsage, main.ts). No pricing table exists
   *  in this codebase (the one $/token figure found, localSavedUsd below, is
   *  a rough savings guess, not a real rate), so this deliberately shows
   *  tokens only — never a fabricated cost. Returns null (renders nothing)
   *  when the active conversation has no run with usage yet. */
  const conversationUsage = useMemo(() => {
    if (!openConversation) return null;
    let inputTokens = 0;
    let outputTokens = 0;
    let runCount = 0;
    let estimated = false;
    let allLocal = true;
    openConversation.turns.forEach((turn) => {
      const usage = turn.run?.providerResult?.usage;
      if (!usage) return;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      runCount += 1;
      if (usage.estimated) estimated = true;
      if (turn.run?.providerResult?.provider !== "ollama") allLocal = false;
    });
    if (runCount === 0) return null;
    return { inputTokens, outputTokens, runCount, estimated, allLocal };
  }, [openConversation]);

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

  // Fork (docs/DRILL_PLAN.md I9.5): copy this conversation into a new one and
  // jump to it. The fork inherits the source's remembered model mapping so
  // "same context, different model" is one picker change away.
  async function forkOpenConversation(): Promise<void> {
    const forkFn = window.metisConversations?.fork;
    if (!openStoredConversation || !forkFn) return;
    const fork = await forkFn(openStoredConversation.id);
    if (!fork) return;
    if (Object.prototype.hasOwnProperty.call(conversationModels, openStoredConversation.id)) {
      rememberConversationModel(fork.id, conversationModels[openStoredConversation.id]);
    }
    onConversationsChanged?.();
    setWorkspaceContextOpen(false);
    onOpenConversationById?.(fork.id);
  }

  async function deleteOpenConversation(): Promise<void> {
    if (!openStoredConversation || !window.metisConversations) return;
    if (!contextDeleteArmed) {
      setContextDeleteArmed(true);
      sound.play("destructiveArm");
      window.setTimeout(() => setContextDeleteArmed(false), 3000);
      return;
    }
    sound.play("destructiveCommit");
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
  // Composer ghost suggestion (Lachy: suggestions should sit IN the prompt
  // bar as greyed-out typed-looking text, not as a chip row above it). The
  // run-state heuristic (a failed verify/repair has one obviously-right next
  // step) outranks the model-written follow-ups (docs/DRILL_PLAN.md CORE.1);
  // the first follow-up is the ghost otherwise. Tab or click adopts it into
  // the prompt — it is a draft the user finishes sending, never auto-sent.
  const composerSuggestion = useMemo(() => {
    const heuristic = suggestNextStep(lastRun, lastUserMessage);
    if (heuristic) return heuristic;
    if (sessionBusy) return null;
    return lastRun?.suggestions?.[0] ?? null;
  }, [lastRun, lastUserMessage, sessionBusy]);

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

  // Per-conversation folders (Lachy): the active workspace + resources FOLLOW
  // the open conversation. Switching conversations re-binds the workspace to
  // that conversation's own folder (or clears it); the new session page
  // starts folderless with the pending resource bucket. bindConversation is
  // optional-chained for older preloads/preview, falling back to a plain read.
  useEffect(() => {
    if (!window.metisProject) return;
    let alive = true;
    const bind = window.metisProject.bindConversation
      ? window.metisProject.bindConversation(activeConversationId ?? null)
      : window.metisProject.getWorkspace();
    void Promise.all([bind, window.metisProject.listResources(activeConversationId ?? undefined)]).then(([workspace, resources]) => {
      if (!alive) return;
      setProjectWorkspace(workspace);
      setWorkspaceResources(resources);
    });
    return () => {
      alive = false;
    };
  }, [activeConversationId]);

  async function chooseProjectFolder(): Promise<void> {
    if (!window.metisProject || projectPickerBusy) return;
    setProjectPickerBusy(true);
    try {
      const result = await window.metisProject.selectFolder();
      if (!result.canceled && result.workspace) {
        setProjectWorkspace(result.workspace);
        // Per-conversation folders (Lachy): choosing mid-conversation binds
        // the folder to THIS conversation; on the new session page the bind
        // happens at creation via the run's projectPath.
        if (activeConversationId) {
          await window.metisProject.setConversationProject?.(activeConversationId, result.workspace.path);
          onConversationsChanged?.();
        }
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
      // Per-conversation resources (Lachy): attach into this conversation's
      // bucket, or the pending bucket on the new session page.
      const resourceKey = activeConversationId ?? undefined;
      const next = kind === "file" ? await window.metisProject.addFiles(resourceKey) : await window.metisProject.addFolder(resourceKey);
      setWorkspaceResources(next);
      if (kind === "folder") {
        // PF1 (5c0c1a6): "+ Add folder" now also establishes the attached folder as the
        // writable project workspace on the backend. Re-fetch it so the "Choose/Change
        // folder" label and project-context popover reflect the newly-writable folder
        // right away instead of waiting for a remount. Bridge is undefined in preview,
        // so this optional-chains to a no-op there.
        const workspace = await window.metisProject?.getWorkspace();
        if (workspace !== undefined) setProjectWorkspace(workspace);
        if (workspace && activeConversationId) {
          await window.metisProject.setConversationProject?.(activeConversationId, workspace.path);
          onConversationsChanged?.();
        }
      }
    } finally {
      setProjectPickerBusy(false);
    }
  }

  async function removeWorkspaceResource(id: string): Promise<void> {
    if (!window.metisProject) return;
    const next = await window.metisProject.removeResource(id, activeConversationId ?? undefined);
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

  // Resolves the active pending permission/question from the floating chatbox
  // popup: fires the real bridge call (a no-op via optional chaining in the
  // no-bridge preview, matching the prior inline cards' behavior) and marks
  // `resolved` on the turn so the popup closes and the inline card's collapsed
  // audit line takes over (docs/DRILL_PLAN.md B2.3/B2.4).
  function resolvePermission(turnId: string, requestId: string, verdict: PermissionVerdict): void {
    window.metisPermissions?.respond(requestId, verdict);
    updatePendingTurns(activeKey, (current) =>
      current.map((turn) =>
        turn.id === turnId && turn.pendingPermission ? { ...turn, pendingPermission: { ...turn.pendingPermission, resolved: { verdict } } } : turn
      )
    );
  }

  function resolveQuestion(turnId: string, requestId: string, answer: UserQuestionAnswer): void {
    window.metisSession?.answerQuestion(requestId, answer);
    updatePendingTurns(activeKey, (current) =>
      current.map((turn) =>
        turn.id === turnId && turn.pendingQuestion ? { ...turn, pendingQuestion: { ...turn.pendingQuestion, resolved: { answer } } } : turn
      )
    );
  }

  /** Starts a background loop from "/loop". Deliberately NOT a session run:
   *  nothing streams into the conversation feed, because a loop's turns land in
   *  its own thread over the following minutes and pretending otherwise would
   *  leave a chat bubble that never fills in. The user gets a confirmation
   *  naming where to watch and stop it, which is the honest report of what just
   *  happened. */
  async function startLoopFromCommand(parts: LoopCommandParts): Promise<void> {
    if (!window.metisLoops) {
      setLoopNotice({ tone: "error", text: "Loops need the desktop app." });
      return;
    }
    try {
      const loop = await window.metisLoops.create({
        goal: parts.goal,
        projectPath: projectWorkspace?.path,
        maxIterations: parts.turns,
        fixedIntervalSeconds: parts.everySeconds,
        budgetTokens: parts.budgetTokens
      });
      const pace = loop.fixedIntervalSeconds ? `every ${formatLoopDuration(loop.fixedIntervalSeconds)}` : "at its own pace";
      const budget = loop.budgetTokens ? ` and a ${formatTokenCount(loop.budgetTokens)}-token budget` : "";
      const base = `Loop started, up to ${loop.maxIterations} turns ${pace}${budget}. It is working now. Watch or stop it in Settings > Privacy & Data.`;
      // A capability warning goes FIRST, before the reassurance. It is the part
      // that changes what you should expect to happen, and burying it under
      // "it is working now" would be the wrong order to read them in.
      // When the warning says nothing can run this, appending "It is working
      // now" contradicts it in the same sentence. Keep the warning and where to
      // stop it, drop the reassurance.
      const cannotRun = /cannot run/i.test(loop.capabilityWarning ?? "");
      setLoopNotice(
        loop.capabilityWarning
          ? {
              tone: "warn",
              text: cannotRun
                ? `${loop.capabilityWarning} The loop was created but will not get far. Stop it in Settings > Privacy & Data.`
                : `${loop.capabilityWarning} ${base}`
            }
          : { tone: "ok", text: base }
      );
    } catch (error) {
      setLoopNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
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
      // The send cue sits BELOW this guard on both paths: a send that drops on
      // the floor must not sound like one that landed (docs/DRILL_PLAN.md
      // B12.10). Posting a steering directive IS a send, so that one sounds.
      if (!text || !window.metisBus) return;
      sound.play("send");
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
    // Every prompt that actually starts a run funnels through here (composer,
    // slash commands), so this is the one send cue for the run path.
    sound.play("send");
    // Wall-clock start for the runComplete cue: a run that felt instant does
    // not get a chime (docs/DRILL_PLAN.md B12.10).
    const runStartedAt = Date.now();
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
        // Per-conversation model memory, part 4 (DRILL_PLAN B7.1): the draft
        // just became a real conversation, so copy whatever model it was
        // actually run with (this closure's `selectedModel`, the same value
        // sessionInput.modelOverride was built from above) into the map
        // under its new id, regardless of whether the user is still looking
        // at it. Restore effect above will then find this entry already
        // matches selectedModel if it fires from the activeConversationId
        // change below, so it's a harmless no-op there.
        rememberConversationModel(realConversationId, selectedModel);
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
      // Both the streaming and non-streaming branches above settle here, so
      // one cue covers both. The send figure, slowed.
      sound.play("runComplete", { runDurationMs: Date.now() - runStartedAt });
      const finalPreviewUrl = run.projectResult?.previewUrl ?? run.outputUrl;
      if (finalPreviewUrl && activeKeyRef.current === runKey) {
        const title = run.projectResult ? projectNameFromPath(run.projectResult.projectRoot) : "Preview";
        setPreviewRail({ url: finalPreviewUrl, title });
      }
      onConversationsChanged?.();
    } catch (error) {
      // The rejected invoke lands here as well as the stream's error event, so
      // this site MUST make the same stop-vs-failure distinction. If it did not,
      // it would overwrite the "stopped" status that applyStreamEventToTurn just
      // set and re-introduce Electron's wrapped "Error invoking remote
      // method..." string, undoing the fix a few milliseconds after it applied.
      const stopped = isUserCancellation(error);
      updatePendingTurns(runKey, (current) =>
        current.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status: stopped ? "stopped" : "error",
                // Keep the stream event's message when it already landed. It is
                // the provider's real words ("DeepSeek returned 503 Service
                // Unavailable"), while the rejected invoke only carries
                // Electron's wrapping of them ("Error invoking remote method
                // 'metis-session:run-stream': Error: ..."). Same clobber the
                // stopped case had, one layer over: the useful text arrives
                // first and the uglier duplicate overwrites it.
                error: stopped ? undefined : (turn.error ?? (error instanceof Error ? error.message : String(error)))
              }
            : turn
        )
      );
      // A failure is worth hearing however long it took, so there is no
      // short-run suppression on this one. A Stop click lands in this same
      // catch but is NOT a failure, so it stays silent - the user already
      // knows they stopped it, and scolding them for it is exactly the kind
      // of noise B12.10 exists to avoid.
      if (!isUserCancellation(error)) sound.play("runError");
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
        {/* B12 revisions (Lachy): the context 3-dots only exists once a
            conversation has actually started - pre-conversation, folder
            controls live in the row above the composer instead. */}
        {hasConversation ? (
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
                  {projectWorkspace ? (
                    <>
                      <em className="workspace-writable-tag">Writable</em>
                      <span className="workspace-context-path-text">{projectWorkspace.path}</span>
                    </>
                  ) : (
                    "No project folder selected yet."
                  )}
                </div>
                {workspaceResources.length > 0 ? (
                  <div className="workspace-context-resources">
                    {workspaceResources.map((resource) => (
                      <div className="workspace-context-resource" key={resource.id}>
                        <Folder size={12} />
                        <span title={resource.path}>{resource.name}</span>
                        {resource.path === projectWorkspace?.path ? <em className="workspace-writable-tag">Writable</em> : null}
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
                    <button type="button" onClick={() => void forkOpenConversation()} title="Copy this conversation into a new one - same context, pick a different model and compare">
                      <GitFork size={13} />
                      Fork
                    </button>
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
        ) : null}
      </div>
      <div className="home-scroll" ref={homeScrollRef}>
        {hasConversation ? (
          openConversation ? (
            <>
              <div className="conversation-title">{openConversation.title}</div>
              {conversationUsage ? (
                <div className="route-line conversation-usage-line">
                  <span>
                    {formatTokenCount(conversationUsage.inputTokens)} tokens in, {formatTokenCount(conversationUsage.outputTokens)} out across{" "}
                    {conversationUsage.runCount} run{conversationUsage.runCount === 1 ? "" : "s"}
                    {conversationUsage.estimated ? " (approximate)" : ""}
                    {conversationUsage.allLocal ? " — free, ran locally" : ""}
                  </span>
                </div>
              ) : null}
            </>
          ) : null
        ) : (
          <header className="home-greeting">
            <Sparkles size={22} />
            <h1>What&rsquo;s up next, {profileName}?</h1>
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
                  {turn.run ? <CompletedRun run={turn.run} onNavigate={onNavigate} /> : <Markdown>{turn.content}</Markdown>}
                </div>
              )
            )}
            {conversation.map((turn) => (
              <ConversationTurnCard
                key={turn.id}
                anchorId={`sec-c-${turn.id}`}
                turn={turn}
                onNavigate={onNavigate}
                onRegenerate={
                  turn.prompt && turn.run && !sessionBusy
                    ? () => {
                        // B12.1: a regenerate is the clearest "that answer
                        // wasn't it" signal - record which model produced it,
                        // then genuinely re-ask the same prompt.
                        void window.metisPreference?.signal({
                          kind: "regenerate",
                          provider: turn.run?.providerResult?.provider,
                          model: turn.run?.providerResult?.model,
                          conversationId: activeConversationId ?? undefined
                        });
                        void submitPrompt(turn.prompt);
                      }
                    : undefined
                }
              />
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
        {activePendingPermission ? (
          <ChatboxPopup label="Permission request">
            <PermissionPopupBody
              key={activePendingPermission.request.id}
              request={activePendingPermission.request}
              onRespond={(verdict) => resolvePermission(activePendingPermission.turnId, activePendingPermission.request.id, verdict)}
            />
          </ChatboxPopup>
        ) : activePendingQuestion ? (
          <ChatboxPopup label="Question">
            <QuestionPopupBody
              key={activePendingQuestion.question.id}
              question={activePendingQuestion.question}
              onRespond={(answer) => resolveQuestion(activePendingQuestion.turnId, activePendingQuestion.question.id, answer)}
            />
          </ChatboxPopup>
        ) : null}
        {loopNotice ? (
          <div className={loopNotice.tone === "ok" ? "loop-notice" : loopNotice.tone === "warn" ? "loop-notice warn" : "loop-notice error"} role="status">
            <span>{loopNotice.text}</span>
            <button type="button" onClick={() => setLoopNotice(null)} aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
        ) : null}
        <SessionComposer
          sessionBusy={sessionBusy}
          projectWorkspace={projectWorkspace}
          hasConversation={hasConversation}
          onChooseProjectFolder={chooseProjectFolder}
          activeConversationId={activeConversationId}
          suggestion={composerSuggestion}
          suggestionResetKey={`${lastRun?.id ?? "none"}::${activeConversationId ?? "none"}`}
          onSubmit={submitPrompt}
          onStartLoop={startLoopFromCommand}
          permissionMode={permissionMode}
          setPermissionMode={setPermissionMode}
          resourceMenuOpen={resourceMenuOpen}
          setResourceMenuOpen={setResourceMenuOpen}
          projectPickerBusy={projectPickerBusy}
          addWorkspaceResource={addWorkspaceResource}
          selectedModel={selectedModel}
          setSelectedModel={pickModel}
          modelGroups={modelGroups}
          modelLatencyMs={modelLatencyMs}
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
          modelPresets={modelPresets}
          deleteModelPreset={deleteModelPreset}
          promptTemplates={promptTemplates}
          savePromptTemplate={savePromptTemplate}
          deletePromptTemplate={deletePromptTemplate}
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
  hasConversation,
  onChooseProjectFolder,
  activeConversationId,
  suggestion,
  suggestionResetKey,
  onSubmit,
  onStartLoop,
  permissionMode,
  setPermissionMode,
  resourceMenuOpen,
  setResourceMenuOpen,
  projectPickerBusy,
  addWorkspaceResource,
  selectedModel,
  setSelectedModel,
  modelGroups,
  modelLatencyMs,
  routerFilter,
  setRouterFilter,
  addModelOpen,
  setAddModelOpen,
  draftModelName,
  setDraftModelName,
  draftModelProvider,
  setDraftModelProvider,
  addCustomModel,
  resolveRouteSuffix,
  modelPresets,
  deleteModelPreset,
  promptTemplates,
  savePromptTemplate,
  deletePromptTemplate
}: {
  sessionBusy: boolean;
  projectWorkspace: ProjectWorkspace | null;
  /** B12 revisions (Lachy): true once the conversation has turns - the
   *  pre-conversation folder row above the box only renders before that. */
  hasConversation: boolean;
  /** Opens the project-folder picker (same handler the context popover uses). */
  onChooseProjectFolder: () => void;
  /** Active conversation id, passed to Oracle warm/draft as context so the
   *  backend can assemble the same prompt the real run will send (O3). */
  activeConversationId?: string;
  /** Ghost text shown greyed-out inside the prompt bar (heuristic next step,
   *  else the model-written follow-up — CORE.1). Tab/click adopts it. */
  suggestion: string | null | undefined;
  suggestionResetKey: string;
  onSubmit: (text: string, attachments?: SessionAttachment[]) => void | Promise<void>;
  /** Starts a background loop from a parsed "/loop" command. */
  onStartLoop: (parts: LoopCommandParts) => void | Promise<void>;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode | ((current: PermissionMode) => PermissionMode)) => void;
  resourceMenuOpen: boolean;
  setResourceMenuOpen: (value: boolean | ((open: boolean) => boolean)) => void;
  projectPickerBusy: boolean;
  addWorkspaceResource: (kind: "file" | "folder") => void | Promise<void>;
  selectedModel: ModelRef | null;
  setSelectedModel: (ref: ModelRef | null) => void;
  modelGroups: SessionComposerModelGroups;
  /** Real-telemetry first-token latency per model (DRILL_PLAN I9.8), keyed via
   *  modelLatencyKey(providerResult.provider, providerResult.model). Built once
   *  in the parent workspace from stored conversations + runtime session runs;
   *  a model with no reading simply has no entry, so the picker shows no dot. */
  modelLatencyMs: Map<string, number>;
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
  /** Saved named model presets (DRILL_PLAN B5.1) — persisted in the parent so
   *  they survive SessionComposer's per-draft remount. Applied + deleted from
   *  the picker; saving lives in Orchestration now, not the model selector. */
  modelPresets: ModelPreset[];
  deleteModelPreset: (id: string) => void;
  /** Saved prompt snippets (DRILL_PLAN Phase 8) — persisted in the parent so
   *  they survive SessionComposer's per-draft remount, same reasoning as
   *  modelPresets above. Listed + inserted + deleted from the "/" popover;
   *  saving happens from the composer's own toolbar affordance. */
  promptTemplates: PromptTemplate[];
  savePromptTemplate: (name: string, text: string) => void;
  deletePromptTemplate: (id: string) => void;
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [permOpen, setPermOpen] = useState(false);
  const [routerOpen, setRouterOpen] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  // Prompt template "/" popover (DRILL_PLAN Phase 8). templateDismissed lets
  // Escape or a backdrop click hide the popover without touching the typed
  // "/query" text, same idiom as suggestionDismissed above; it's reset
  // whenever the composer leaves slash mode so re-entering it later (e.g.
  // after backspacing to just "/") shows the popover again.
  const [templateDismissed, setTemplateDismissed] = useState(false);
  const [templateActiveIndex, setTemplateActiveIndex] = useState(0);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [draftTemplateName, setDraftTemplateName] = useState("");
  // Template TEXT authored in the /-popover's New template form (B12
  // declutter - the toolbar save button is gone).
  const [draftTemplateText, setDraftTemplateText] = useState("");
  // /export built-in slash command result (DRILL_PLAN I9.9) — mirrors the
  // Settings > Privacy "Export all conversations" busy/result shape
  // (exportBusy/exportResult there) so the composer's inline note reads the
  // same way. Local to this component: it naturally clears on the next
  // conversation switch since SessionComposer remounts per draft.
  const [slashExportBusy, setSlashExportBusy] = useState(false);
  const [slashExportResult, setSlashExportResult] = useState<ConversationExportResult | null>(null);
  // Installed-Ollama-tags lookup for the picker's local-model install badges
  // (DRILL_PLAN B5.2) — reuses the same window.metisOllama.list() bridge the
  // Benchmark wizard already uses to show install state + drive its pull flow
  // (see the BenchmarkWizard component's ollamaInfo state). null means
  // "unknown" (bridge missing, e.g. browser preview, or not fetched yet) —
  // the picker renders that the same as "not installed" rather than crashing
  // or guessing. Refreshed on mount and again whenever the picker opens,
  // since the installed set can change between opens (a pull finishing
  // elsewhere, a manual `ollama rm`, etc.).
  const [installedOllamaTags, setInstalledOllamaTags] = useState<Set<string> | null>(null);
  const refreshInstalledOllamaTags = useCallback(() => {
    if (!window.metisOllama) return;
    void window.metisOllama
      .list()
      .then((info) => setInstalledOllamaTags(new Set(info.installed)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshInstalledOllamaTags();
  }, [refreshInstalledOllamaTags]);
  useEffect(() => {
    if (routerOpen) refreshInstalledOllamaTags();
  }, [routerOpen, refreshInstalledOllamaTags]);
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

  // Speculative prompt prewarm (docs/DRILL_PLAN.md E1 v0.1b) — INVISIBLE warm
  // only, never a speculative answer and never a change to visible chat
  // behavior. Reads the same "prewarmEnabled" store key the Settings >
  // Experiments toggle writes; OFF by default. See main.ts's prewarmModel()
  // for the backend half (already shipped, commit 8c2e31b).
  const [prewarmEnabled] = useAppStoreState("prewarmEnabled", DEFAULT_PREWARM_ENABLED);
  // Cloud Oracle opt-in (docs/DRILL_PLAN.md O5) — a SEPARATE paid flag on top
  // of prewarmEnabled; see the Experiments panel toggle. OFF by default.
  const [oracleCloudEnabled] = useAppStoreState("oracleCloudEnabled", false);
  // Resolves the composer's pinned model (if any) to the literal Ollama tag
  // Ollama's /api/generate expects (e.g. "qwen2.5:72b"), via the LOCAL_MODELS
  // catalog's `name` <-> `ollamaTag` pairing. Stays null — meaning "don't
  // warm" — whenever that resolution isn't confident: no model pinned ("Auto
  // router" may route to a cloud model), the pinned model's provider isn't
  // LOCAL_MODELS-tier "local", or the picker's display name has no matching
  // LOCAL_MODELS entry to pull a real tag from. Never guesses.
  const localPrewarmTarget = useMemo(() => (selectedModel ? localOllamaTagFor(selectedModel) : null), [selectedModel]);

  // Oracle activity chip state (docs/DRILL_PLAN.md B5.5) — the only visible
  // surface for the otherwise-invisible prewarm hook above. `oracleActivity`
  // and `oracleLog` are updated ONLY from inside the real warm call below;
  // nothing here simulates activity.
  const [oracleActivity, setOracleActivity] = useState<OracleActivity>(ORACLE_IDLE);
  const [oracleLog, setOracleLog] = useState<OracleWarmEvent[]>([]);
  const [oracleLogOpen, setOracleLogOpen] = useState(false);
  // Latest speculative draft (docs/DRILL_PLAN.md O2b) — set only from a real
  // metisPrewarm.draft() resolution below, never simulated. Deliberately NOT
  // cleared when `prompt` changes: a stale guess staying visible (labeled as
  // a guess) until a fresher one replaces it is acceptable per the spec.
  const [oracleDraft, setOracleDraft] = useState<OracleDraftResult | null>(null);
  // Monotonic id of the most recently *issued* draft request — lets a slow
  // older request's resolution recognize it's been superseded and discard
  // itself instead of clobbering a newer (possibly already-resolved) guess.
  const oracleDraftRequestId = useRef(0);

  // I9.2: live-stream the in-flight local draft into the same oracleDraft
  // state the popover renders, so the guess forms in real time instead of
  // appearing all at once. `reset` marks the first delta of a fresh
  // generation (clear the stale guess); the request's final resolution then
  // replaces the accumulation with the identical completed result.
  useEffect(() => {
    const subscribe = window.metisPrewarm?.onDraftDelta;
    if (!subscribe) return;
    return subscribe((event) => {
      setOracleDraft((current) => {
        const base = event.reset || !current ? { text: "", thoughts: "" } : { text: current.text ?? "", thoughts: current.thoughts ?? "" };
        return event.kind === "thought" ? { ...base, thoughts: `${base.thoughts}${event.delta}` } : { ...base, text: `${base.text}${event.delta}` };
      });
    });
  }, []);

  useEffect(() => {
    if (!prewarmEnabled || !window.metisPrewarm || !localPrewarmTarget || !prompt.trim()) return;
    const target = localPrewarmTarget;
    const draft = prompt;
    // ~400ms pause since the last keystroke before firing — cleared and
    // re-armed by this effect's own cleanup on every `prompt` change, and by
    // the same cleanup on unmount. Fire-and-forget: ignore the resolved
    // value, swallow any rejection, never block typing or surface an error.
    const timeoutId = window.setTimeout(() => {
      setOracleActivity({ phase: "warming", model: target });
      const startedAt = Date.now();
      void window.metisPrewarm
        // O3: pass conversation + project context so the backend warms with
        // the SAME assembled prompt the real run will send (prefix cache hit).
        ?.warm(target, draft, { conversationId: activeConversationId, projectPath: projectWorkspace?.path })
        .then(() => {
          const ms = Date.now() - startedAt;
          setOracleActivity({ phase: "warm", model: target, ms });
          setOracleLog((current) => [{ model: target, ms, at: Date.now() }, ...current].slice(0, ORACLE_LOG_CAP));
        })
        .catch(() => {
          // Fail quiet — only revert to idle if nothing newer has already
          // taken over the chip (e.g. a later keystroke's warm call).
          setOracleActivity((current) => (current.phase === "warming" && current.model === target ? ORACLE_IDLE : current));
        });
    }, 400);
    return () => window.clearTimeout(timeoutId);
  }, [prompt, prewarmEnabled, localPrewarmTarget, activeConversationId, projectWorkspace?.path]);

  // Prewarm-on-conversation-open (docs/DRILL_PLAN.md I9.1) — the moment a
  // conversation with a confidently-resolved local model becomes active, warm
  // that model once, so the FIRST keystroke of the visit never pays the
  // cold-load (the 400ms typing warm above only fires once there's a prompt).
  // Same guards, same honest chip/log surface, same fire-and-forget policy as
  // the typing warm. The ref dedupes per conversation+model pair so re-renders
  // (or the store flags settling) don't re-fire a warm that already went out;
  // keep_alive on the backend holds the model for ~5m anyway.
  const openWarmKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!prewarmEnabled || !window.metisPrewarm || !localPrewarmTarget || !activeConversationId) return;
    if (prompt.trim()) return; // a draft in progress - the typing warm owns it
    const target = localPrewarmTarget;
    const key = `${activeConversationId}|${target}`;
    if (openWarmKeyRef.current === key) return;
    // Small delay so flicking through conversations doesn't warm every stop.
    const timeoutId = window.setTimeout(() => {
      openWarmKeyRef.current = key;
      setOracleActivity({ phase: "warming", model: target });
      const startedAt = Date.now();
      void window.metisPrewarm
        ?.warm(target, "", { conversationId: activeConversationId, projectPath: projectWorkspace?.path })
        .then(() => {
          const ms = Date.now() - startedAt;
          setOracleActivity({ phase: "warm", model: target, ms });
          setOracleLog((current) => [{ model: target, ms, at: Date.now() }, ...current].slice(0, ORACLE_LOG_CAP));
        })
        .catch(() => {
          setOracleActivity((current) => (current.phase === "warming" && current.model === target ? ORACLE_IDLE : current));
        });
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [activeConversationId, prewarmEnabled, localPrewarmTarget, prompt, projectWorkspace?.path]);

  // Oracle "precognition" draft preview (docs/DRILL_PLAN.md O2b) — a SECOND,
  // harder debounce (~800ms pause, its own timer entirely separate from the
  // 400ms warm debounce above) that asks the backend for a full speculative
  // draft of what the model would likely say, shown only in the Oracle
  // popover (never the chat, never the composer — see OracleChip below).
  // Same firing guards as the warm effect: experiment flag on, a
  // confidently-resolved local target, and a non-trivial prompt.
  // window.metisPrewarm?.draft is optional-chained — a missing method or an
  // undefined/null resolution is treated as "no draft", never an error.
  useEffect(() => {
    if (!prewarmEnabled || !localPrewarmTarget || !prompt.trim()) return;
    const draftFn = window.metisPrewarm?.draft;
    if (!draftFn) return;
    const target = localPrewarmTarget;
    const draftPrompt = prompt;
    // ~800ms pause — deliberately slower than the 400ms warm debounce, since
    // a full speculative draft is a heavier ask than just loading the model.
    const timeoutId = window.setTimeout(() => {
      const requestId = ++oracleDraftRequestId.current;
      // O3: same assembled-prompt context as the warm call, so the guess is
      // contextual (sees the conversation) and shares the warmed prefix.
      void draftFn(target, draftPrompt, { conversationId: activeConversationId, projectPath: projectWorkspace?.path })
        .then((result) => {
          // Stale-result guard: only the most recently *issued* request gets
          // to update the popover. A slower older request that resolves
          // after a newer one was fired is silently discarded — latest wins.
          if (requestId !== oracleDraftRequestId.current) return;
          if (!result) return;
          setOracleDraft(result);
        })
        .catch(() => {
          // Fail quiet, same policy as the warm effect — any existing guess
          // just stays put rather than being cleared on a transient error.
        });
    }, 800);
    return () => window.clearTimeout(timeoutId);
  }, [prompt, prewarmEnabled, localPrewarmTarget, activeConversationId, projectWorkspace?.path]);

  // Cloud Oracle draft (docs/DRILL_PLAN.md O5) — the paid sibling of the local
  // draft effect above, for a pinned DEEPSEEK model with the explicit cloud
  // opt-in on. Much harder debounce (2s of real pause, not per keystroke):
  // every fire costs tokens, so this waits for genuine thinking pauses.
  // Shares the request-id stale guard with the local draft effect so the two
  // can never clobber each other's newer guess.
  useEffect(() => {
    if (!prewarmEnabled || !oracleCloudEnabled || !prompt.trim()) return;
    if (selectedModel?.provider !== "deepseek") return;
    const draftFn = window.metisPrewarm?.draftCloud;
    if (!draftFn) return;
    const target = selectedModel.model;
    const draftPrompt = prompt;
    const timeoutId = window.setTimeout(() => {
      const requestId = ++oracleDraftRequestId.current;
      void draftFn(target, draftPrompt, { conversationId: activeConversationId, projectPath: projectWorkspace?.path })
        .then((result) => {
          if (requestId !== oracleDraftRequestId.current) return;
          if (!result) return;
          setOracleDraft(result);
        })
        .catch(() => {
          // Fail quiet, same policy as the local draft effect.
        });
    }, 2000);
    return () => window.clearTimeout(timeoutId);
  }, [prompt, prewarmEnabled, oracleCloudEnabled, selectedModel?.provider, selectedModel?.model, activeConversationId, projectWorkspace?.path]);

  const showSuggestion = Boolean(suggestion) && !suggestionDismissed && !sessionBusy && prompt.trim().length === 0;
  // Mirrors main.ts's ORCHESTRATION_COMMAND_RE (/orchestration or /orch as the
  // leading token) purely for the composer nicety chip below — no autocomplete
  // menu, just a small heads-up that this prompt will force the build pipeline.
  const showOrchestrationChip = /^\s*\/(orchestration|orch)\b/i.test(prompt);

  // "/loop" gets a live breakdown rather than a fixed chip, because unlike
  // /orchestration it takes arguments and nobody can be expected to remember
  // them. Re-parsed every keystroke by the SAME parser main.ts runs, so what
  // the strip promises is what will actually happen. The "/" template popover
  // cannot host this: it closes the moment a space is typed, which is exactly
  // when the arguments start.
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const loopCommand = useMemo(() => parseLoopCommand(prompt), [prompt]);
  const loopHint = useMemo(() => describeLoopCommand(loopCommand), [loopCommand]);
  // Clears the moment they change the prompt or the attachments, so a refusal
  // never lingers as a stale accusation after it has been acted on.
  useEffect(() => setAttachmentNotice(null), [prompt, attachments.length]);

  // Prompt template "/" popover (DRILL_PLAN Phase 8): only while the ENTIRE
  // prompt is a slash followed by a single space-free query token — i.e. it
  // can only begin when "/" is the very first character typed into an empty
  // composer, and closes itself the moment a space is typed (same hand-off
  // point as /orchestration's own "command token, then remainder" shape —
  // once there's a space the rest is free-form text, not a filter query).
  // templateQuery is null outside slash mode.
  const templateSlashMatch = /^\/(\S{0,40})$/.exec(prompt);
  const templateQuery = templateSlashMatch ? templateSlashMatch[1] : null;
  const templateSlashMode = templateQuery !== null;
  useEffect(() => {
    if (!templateSlashMode) setTemplateDismissed(false);
  }, [templateSlashMode]);
  useEffect(() => {
    setTemplateActiveIndex(0);
  }, [templateQuery]);
  const templatePopoverVisible = templateSlashMode && !templateDismissed;
  const templateFilter = (templateQuery ?? "").trim().toLowerCase();
  const filteredTemplates = promptTemplates.filter((template) => !templateFilter || template.name.toLowerCase().includes(templateFilter));
  // Built-in /orchestration row (mirrors main.ts's ORCHESTRATION_COMMAND_RE
  // above) listed alongside saved templates purely for discoverability —
  // selecting it inserts the canonical command text, it never becomes a
  // saved/deletable PromptTemplate.
  const orchestrationRowMatches = !templateFilter || "orchestration".includes(templateFilter) || "orch".includes(templateFilter);
  // Built-in /export and /summarize rows (DRILL_PLAN I9.9) — listed alongside
  // /orchestration and saved templates for discoverability, same filter idiom.
  const exportRowMatches = !templateFilter || "export".includes(templateFilter);
  const summarizeRowMatches = !templateFilter || "summarize".includes(templateFilter) || "summary".includes(templateFilter);
  // Built-in /handoff row (DRILL_PLAN I9.10) — same discoverability idiom.
  const handoffRowMatches = !templateFilter || "handoff".includes(templateFilter) || "continue".includes(templateFilter);
  // Built-in /loop row — same discoverability idiom.
  const loopRowMatches = !templateFilter || "loop".includes(templateFilter);
  // New template row (B12 declutter - replaces the old toolbar save button).
  const newTemplateRowMatches = !templateFilter || "template".includes(templateFilter) || "new".includes(templateFilter) || "save".includes(templateFilter);
  const templateRows: TemplateRow[] = [
    ...(orchestrationRowMatches ? [{ kind: "builtin" as const }] : []),
    ...(exportRowMatches ? [{ kind: "export" as const }] : []),
    ...(summarizeRowMatches ? [{ kind: "summarize" as const }] : []),
    ...(handoffRowMatches ? [{ kind: "handoff" as const }] : []),
    ...(loopRowMatches ? [{ kind: "loop" as const }] : []),
    ...LOOP_STARTERS.filter((starter) => !templateFilter || "loop".includes(templateFilter) || starter.name.toLowerCase().includes(templateFilter)).map((starter) => ({ kind: "loopStarter" as const, starter })),
    ...filteredTemplates.map((template) => ({ kind: "template" as const, template })),
    ...(newTemplateRowMatches ? [{ kind: "newTemplate" as const }] : [])
  ];
  const templateActiveRow = templateRows.length ? templateRows[Math.min(templateActiveIndex, templateRows.length - 1)] : undefined;

  // /export: exports the OPEN conversation to Markdown, falling back to every
  // conversation when none is open — same bridge + result shape as Settings >
  // Privacy's "Export all conversations" (window.metisConversations.exportMarkdown).
  async function runSlashExport(): Promise<void> {
    if (!window.metisConversations) return;
    setSlashExportBusy(true);
    setSlashExportResult(null);
    try {
      const result = await window.metisConversations.exportMarkdown(
        activeConversationId ? { conversationId: activeConversationId } : {}
      );
      setSlashExportResult(result);
    } finally {
      setSlashExportBusy(false);
    }
  }

  // Selecting a "/" popover row (DRILL_PLAN I9.9). /orchestration and saved
  // templates INSERT their text into the composer (the user still reviews/edits
  // before sending); /export and /summarize instead ACT immediately and close
  // the popover — clearing prompt to "" both closes it (templateSlashMode goes
  // false) and leaves nothing typed behind. /export has no honest fallback
  // without window.metisConversations, so it's a no-op without that bridge
  // (the row itself renders disabled in that case, see below). /summarize has
  // no bridge of its own — it just calls the same onSubmit a hand-typed
  // message would use, which already degrades gracefully to a preview run.
  function selectTemplateRow(row: TemplateRow): void {
    if (row.kind === "export") {
      if (!window.metisConversations) return;
      setPrompt("");
      void runSlashExport();
      return;
    }
    if (row.kind === "summarize") {
      setPrompt("");
      void onSubmit(SLASH_SUMMARIZE_PROMPT);
      return;
    }
    if (row.kind === "handoff") {
      setPrompt("");
      void onSubmit(SLASH_HANDOFF_PROMPT);
      return;
    }
    if (row.kind === "loop") {
      setPrompt("/loop ");
      return;
    }
    if (row.kind === "loopStarter") {
      setPrompt(row.starter.insert);
      return;
    }
    if (row.kind === "newTemplate") {
      setPrompt("");
      setDraftTemplateName("");
      setDraftTemplateText("");
      setSaveTemplateOpen(true);
      return;
    }
    setPrompt(row.kind === "builtin" ? "/orchestration " : row.template.text);
  }

  function handleSaveTemplate(): void {
    // B12 declutter: templates are authored in the /-popover's New template
    // form now (name + text), not scraped from the composer draft.
    const name = draftTemplateName.trim();
    const text = draftTemplateText.trim();
    if (!name || !text) return;
    savePromptTemplate(name, text);
    setSaveTemplateOpen(false);
    setDraftTemplateName("");
    setDraftTemplateText("");
  }

  // Oracle chip visibility (docs/DRILL_PLAN.md B5.5) — every condition the
  // warm effect above itself needs before it could ever fire. Requiring the
  // bridge here too (not just prewarmEnabled + a resolved target) is what
  // keeps the chip honest in the preview harness, where window.metisPrewarm
  // is undefined: Oracle genuinely cannot act there, so nothing renders.
  const oracleVisible = prewarmEnabled && Boolean(localPrewarmTarget) && Boolean(window.metisPrewarm);

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

  // True only when the ref resolves to a real LOCAL_MODELS ollamaTag AND that
  // tag is confirmed present in the installed set — anything unresolved or
  // unconfirmed (including installedOllamaTags still null) reads as "not
  // installed" rather than a guess.
  function isLocalModelInstalled(ref: ModelRef): boolean {
    const tag = localOllamaTagFor(ref);
    return Boolean(tag && installedOllamaTags?.has(tag));
  }

  // Installed local models surface first within their brand group so the
  // model Lachy already has on disk is the obvious pick (DRILL_PLAN B5.2);
  // ties keep their existing catalog order (stable sort). Cloud brand groups
  // are never passed through this — they have no install concept.
  function sortLocalModelsFirst(models: ModelRef[]): ModelRef[] {
    if (!installedOllamaTags) return models;
    return [...models].sort((a, b) => Number(isLocalModelInstalled(b)) - Number(isLocalModelInstalled(a)));
  }

  // True when this preset's captured model (or Auto, for a null preset)
  // matches the current picker selection — used to show the active check.
  function isPresetActive(preset: ModelPreset): boolean {
    if (!preset.model) return !selectedModel;
    return selectedModel?.provider === preset.model.provider && selectedModel?.model === preset.model.model;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = prompt.trim();
    if (!text && !attachments.length) return;

    // "/loop" starts a background loop instead of running a chat turn. Handled
    // before the normal path and NOT cleared on refusal: a malformed command
    // leaves what you typed in the box so you can fix the flag rather than
    // retype the goal. The hint strip is already showing why it will not run.
    if (loopCommand.isLoopCommand) {
      if (loopCommand.error || !loopCommand.parts?.goal) return;
      // Attachments are NOT silently discarded. A loop has no path to carry
      // images today (createLoop takes no attachments), so quietly dropping a
      // file someone deliberately attached would lose their work with no sign
      // it happened. Refuse and say why; they can send it as a normal message.
      if (attachments.length) {
        setAttachmentNotice(
          `A loop cannot carry ${attachments.length === 1 ? "an attachment" : "attachments"} yet. Remove ${attachments.length === 1 ? "it" : "them"} to start the loop, or send this as an ordinary message instead.`
        );
        return;
      }
      setPrompt("");
      void onStartLoop(loopCommand.parts);
      return;
    }

    setPrompt("");
    const sentAttachments = attachments;
    setAttachments([]);
    void onSubmit(text, sentAttachments.length ? sentAttachments : undefined);
  }

  return (
    <>
    {!hasConversation ? (
      // B12 revisions (Lachy): on the NEW SESSION page only, the conversation
      // folder sits right above the prompt box, with a + to its right to add
      // the project folder when none exists yet. Once a conversation starts,
      // folder management moves to the context 3-dots.
      <div className="composer-folder-row">
        <span className="composer-folder-chip" title={projectWorkspace?.path ?? "No project folder yet - builds need one to write into"}>
          <Folder size={13} />
          {projectWorkspace ? projectWorkspace.path.split(/[\\/]/).pop() : "No project folder"}
        </span>
        {!projectWorkspace ? (
          <button
            type="button"
            className="composer-folder-add"
            aria-label="Add project folder"
            title="Choose the folder this conversation's builds and edits write into"
            disabled={projectPickerBusy || !window.metisProject}
            onClick={onChooseProjectFolder}
          >
            {projectPickerBusy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
          </button>
        ) : null}
      </div>
    ) : null}
    <form className="home-composer" onSubmit={handleSubmit}>
      {/* B12 declutter (Lachy): the BOX holds only the input + send; every
          other control lives on the bare row below it. */}
      <div className="composer-box">
      {showOrchestrationChip ? (
        <span className="composer-suggestion-chip composer-orchestration-chip">Build pipeline will run</span>
      ) : null}
      {loopCommand.isLoopCommand ? (
        <div className="composer-loop-hint" role="status">
          {attachmentNotice ? (
            <span className="composer-loop-error">{attachmentNotice}</span>
          ) : loopCommand.error ? (
            <span className="composer-loop-error">{loopCommand.error}</span>
          ) : (
            <>
              <span className="composer-loop-lede">Runs on its own until it decides to stop</span>
              {loopHint.map((segment) => (
                <span key={segment.meaning} className={segment.typed ? "composer-loop-seg typed" : "composer-loop-seg"}>
                  <b>{segment.label}</b>
                  <i>{segment.meaning}</i>
                </span>
              ))}
            </>
          )}
        </div>
      ) : null}
      {slashExportBusy || (slashExportResult && !slashExportResult.cancelled) ? (
        <div className="composer-slash-note" role="status">
          {slashExportBusy ? (
            <>
              <Loader2 size={12} className="spin" />
              Exporting…
            </>
          ) : slashExportResult?.ok ? (
            <span>Exported to {slashExportResult.path}</span>
          ) : (
            <span className="settings-warning">{slashExportResult?.error ?? "Export failed"}</span>
          )}
        </div>
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
          placeholder={showSuggestion ? "" : sessionBusy ? "Add a direction while it works" : "Describe a task or ask a question"}
          aria-label={showSuggestion ? `Prompt — suggestion: ${suggestion} — press Tab to accept` : "Prompt"}
          onChange={(event) => {
            setPrompt(event.target.value);
            if (event.target.value) setSuggestionDismissed(true);
          }}
          onKeyDown={(event) => {
            if (templatePopoverVisible) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setTemplateActiveIndex((index) => (templateRows.length ? (index + 1) % templateRows.length : 0));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setTemplateActiveIndex((index) => (templateRows.length ? (index - 1 + templateRows.length) % templateRows.length : 0));
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && templateActiveRow) {
                event.preventDefault();
                selectTemplateRow(templateActiveRow);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTemplateDismissed(true);
                return;
              }
            }
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
        {templatePopoverVisible ? (
          <>
            <div className="resource-backdrop" onClick={() => setTemplateDismissed(true)} />
            <div className="template-popover" role="listbox" aria-label="Prompt templates">
              <div className="router-tier-label">Templates</div>
              <div className="router-menu-scroll">
                {templateRows.length === 0 ? (
                  <p className="router-empty">No templates match “{templateQuery}”.</p>
                ) : (
                  templateRows.map((row, index) => {
                    const active = index === templateActiveIndex;
                    if (row.kind === "builtin") {
                      return (
                        <button
                          key="builtin-orchestration"
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`router-option ${active ? "active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setTemplateActiveIndex(index)}
                          onClick={() => selectTemplateRow(row)}
                        >
                          <span>
                            <strong>/orchestration</strong>
                            <small>Forces the build pipeline for this prompt · alias /orch</small>
                          </span>
                        </button>
                      );
                    }
                    if (row.kind === "export") {
                      const exportAvailable = Boolean(window.metisConversations);
                      return (
                        <button
                          key="builtin-export"
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`router-option ${active ? "active" : ""}`}
                          disabled={!exportAvailable}
                          title={exportAvailable ? undefined : "Requires the desktop app — unavailable in this preview"}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setTemplateActiveIndex(index)}
                          onClick={() => selectTemplateRow(row)}
                        >
                          <span>
                            <strong>/export</strong>
                            <small>
                              {exportAvailable
                                ? activeConversationId
                                  ? "Export this conversation to Markdown"
                                  : "No conversation open — exports every conversation"
                                : "Needs the desktop app"}
                            </small>
                          </span>
                        </button>
                      );
                    }
                    if (row.kind === "summarize") {
                      return (
                        <button
                          key="builtin-summarize"
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`router-option ${active ? "active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setTemplateActiveIndex(index)}
                          onClick={() => selectTemplateRow(row)}
                        >
                          <span>
                            <strong>/summarize</strong>
                            <small>Submits a recap prompt — key decisions, open questions, next steps</small>
                          </span>
                        </button>
                      );
                    }
                    if (row.kind === "newTemplate") {
                      return (
                        <button
                          key="builtin-new-template"
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`router-option ${active ? "active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setTemplateActiveIndex(index)}
                          onClick={() => selectTemplateRow(row)}
                        >
                          <span>
                            <strong>New template…</strong>
                            <small>Save a prompt you reuse often — it appears in this menu</small>
                          </span>
                        </button>
                      );
                    }
                    if (row.kind === "handoff") {
                      return (
                        <button
                          key="builtin-handoff"
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`router-option ${active ? "active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setTemplateActiveIndex(index)}
                          onClick={() => selectTemplateRow(row)}
                        >
                          <span>
                            <strong>/handoff</strong>
                            <small>Generates a continue-from-here brief for a fresh session or another model</small>
                          </span>
                        </button>
                      );
                    }
                    if (row.kind === "loop") {
                      return (
                        <button
                          key="builtin-loop"
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`router-option ${active ? "active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setTemplateActiveIndex(index)}
                          onClick={() => selectTemplateRow(row)}
                        >
                          <span>
                            <strong>/loop</strong>
                            <small>Starts a background goal it works on across turns · flags --turns, --every, --budget</small>
                          </span>
                        </button>
                      );
                    }
                    if (row.kind === "loopStarter") {
                      return (
                        <button
                          key={`starter-${row.starter.id}`}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`router-option ${active ? "active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setTemplateActiveIndex(index)}
                          onClick={() => selectTemplateRow(row)}
                        >
                          <span>
                            <strong>{row.starter.name}</strong>
                            <small>{row.starter.description} · inserts a /loop command to review</small>
                          </span>
                        </button>
                      );
                    }
                    const template = row.template;
                    return (
                      <div className="router-preset-row" key={template.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`router-option ${active ? "active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setTemplateActiveIndex(index)}
                          onClick={() => selectTemplateRow(row)}
                        >
                          <span>
                            <strong>{template.name}</strong>
                            <small>{template.text}</small>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="router-preset-remove"
                          aria-label={`Delete template ${template.name}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={(event) => { event.stopPropagation(); deletePromptTemplate(template.id); }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
              {promptTemplates.length === 0 ? <p className="router-presets-hint">Save a draft as a template to see it here.</p> : null}
            </div>
          </>
        ) : null}
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
      {saveTemplateOpen ? (
        <>
          <div className="resource-backdrop" onClick={() => setSaveTemplateOpen(false)} />
          <div className="template-save-popover floating" role="dialog" aria-label="New template">
            <input
              value={draftTemplateName}
              placeholder="Template name"
              autoFocus
              onChange={(event) => setDraftTemplateName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSaveTemplateOpen(false);
              }}
            />
            <textarea
              value={draftTemplateText}
              placeholder="The prompt this template inserts"
              rows={3}
              onChange={(event) => setDraftTemplateText(event.target.value)}
            />
            <div className="router-add-actions">
              <button type="button" disabled={!draftTemplateName.trim() || !draftTemplateText.trim()} onClick={handleSaveTemplate}>Save</button>
              <button type="button" className="ghost" onClick={() => setSaveTemplateOpen(false)}>Cancel</button>
            </div>
          </div>
        </>
      ) : null}
      {sessionBusy && !prompt.trim() ? (
        <button
          className="send-btn stop-btn"
          type="button"
          aria-label="Stop the run"
          title="Stop — the run halts at its next stage boundary"
          // NOTE (parallel sessions phase A): metisSession.cancel is
          // projectPath-scoped, not conversation-scoped — with two streaming
          // conversations in the same project folder this can stop the
          // sibling run too. Known limitation, backend change to fix.
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
      <div className="home-composer-bar below-box">
        <div className="composer-tools">
          <div className="perm-wrap">
            <button
              className={`perm-pill ${permOpen ? "active" : ""} ${permissionMode !== "auto" ? "accent" : ""} ${permissionMode === "bypass" ? "bypass" : ""}`}
              type="button"
              aria-label={`Permission mode: ${PERMISSION_MODE_SHORT[permissionMode]}`}
              aria-expanded={permOpen}
              onClick={() => setPermOpen((open) => !open)}
            >
              {PERMISSION_MODE_SHORT[permissionMode]}
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
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setResourceMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    <ImagePlus size={15} />
                    <span>
                      <strong>Attach images</strong>
                      <small>Add reference images to this message</small>
                    </span>
                  </button>
                </div>
              </>
            ) : null}
          </div>
          {/* B12 declutter (Lachy): the standalone image button was redundant
              (the + menu's Attach images does the same via this hidden input),
              voice-coming-soon is gone, and template saving moved into the
              "/" popover as a New template row. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="composer-file-input"
            onChange={handleAttachFiles}
          />
        </div>
        <div className="composer-send">
          <div className="router-wrap">
            <button className={`router-pill ${routerOpen ? "active" : ""}`} type="button" aria-haspopup="listbox" aria-expanded={routerOpen} onClick={() => setRouterOpen((open) => !open)}>
              {/* B12 polish (Lachy): a SELECTED model shows text only - the
                  logos stay on the rows inside the picker. Auto router keeps
                  its glyph since it has no text identity of its own. */}
              {!selectedModel ? <img src={AUTOROUTER_LOGO} alt="" /> : null}
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
                    {!routerFilter.trim() && modelPresets.length > 0 ? (
                      <div className="router-tier router-presets">
                        <div className="router-tier-label">Presets</div>
                        {modelPresets.map((preset) => {
                          const active = isPresetActive(preset);
                          return (
                            <div className="router-preset-row" key={preset.id}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={active}
                                className={`router-option ${active ? "active" : ""}`}
                                onClick={() => { setSelectedModel(preset.model); setRouterOpen(false); }}
                              >
                                <img src={preset.model ? PROVIDERS[preset.model.provider].logo : AUTOROUTER_LOGO} alt="" />
                                <span>
                                  <strong>{preset.name}</strong>
                                  <small>{preset.model ? preset.model.model : "Auto router"}</small>
                                </span>
                                {active ? <Check size={14} /> : null}
                              </button>
                              <button
                                type="button"
                                className="router-preset-remove"
                                aria-label={`Delete preset ${preset.name}`}
                                onClick={(event) => { event.stopPropagation(); deleteModelPreset(preset.id); }}
                              >
                                <X size={12} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
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
                            {(tier.tier === "local" ? sortLocalModelsFirst(brand.models) : brand.models).map((ref) => {
                              const active = selectedModel?.provider === ref.provider && selectedModel?.model === ref.model;
                              const routeSuffix = resolveRouteSuffix(ref);
                              // null for every cloud model (no install concept — they
                              // depend on an API key, not a local pull) and for local
                              // models with no resolvable LOCAL_MODELS tag.
                              const localTag = localOllamaTagFor(ref);
                              const localInstalled = localTag ? isLocalModelInstalled(ref) : false;
                              // Real-telemetry reading only (DRILL_PLAN I9.8) — local rows
                              // key off the resolved ollama tag (what providerResult.model
                              // actually holds for those runs), cloud rows off ref.model
                              // directly. No entry means no dot; never a simulated value.
                              const latencyMs = modelLatencyMs.get(modelLatencyKey(PROVIDER_CONNECTIONS[ref.provider], localTag ?? ref.model));
                              return (
                                <button key={`${ref.provider}-${ref.model}`} type="button" role="option" aria-selected={active} className={`router-option ${active ? "active" : ""}`} onClick={() => { setSelectedModel(ref); setRouterOpen(false); }}>
                                  <span className="router-option-name">
                                    {ref.model}
                                    {routeSuffix ? <small className="router-route-suffix">via {routeSuffix}</small> : null}
                                  </span>
                                  {typeof latencyMs === "number" ? (
                                    <span
                                      className={`router-latency-dot ${latencyDotTone(latencyMs)}`}
                                      title={`first token ${latencyMs}ms`}
                                    />
                                  ) : null}
                                  {localTag ? (
                                    <span className={`router-local-status ${localInstalled ? "installed" : ""}`}>
                                      <span className="router-local-dot" />
                                      {localInstalled ? "Installed" : "Not installed"}
                                    </span>
                                  ) : null}
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
          {oracleVisible ? (
            <>
              <UsageRing />
              <OracleChip
                activity={oracleActivity}
                log={oracleLog}
                draft={oracleDraft}
                open={oracleLogOpen}
                onToggle={() => setOracleLogOpen((open) => !open)}
                onClose={() => setOracleLogOpen(false)}
              />
            </>
          ) : null}
        </div>
      </div>
    </form>
    </>
  );
}

/** Renders how long ago an Oracle warm event happened, computed at render
 *  time (docs/DRILL_PLAN.md B5.5) — no interval ticker, so it only refreshes
 *  when the popover re-renders (e.g. on open). Fine for a "recent events"
 *  list that isn't meant to be a live clock. */
function secondsAgoLabel(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

/** Composer-adjacent status strip for the Oracle prewarm experiment
 *  (docs/DRILL_PLAN.md B5.5, extended O2b). Every state shown here comes from
 *  a call that actually fired: "warming" while window.metisPrewarm.warm() is
 *  in flight, "warm" once it resolves with the renderer-timed round trip.
 *  Click/tap expands a popover with a small in-memory log of the last few
 *  warm events (model, duration, how long ago), plus — when one exists — a
 *  clearly-labeled speculative preview of the latest draft() resolution
 *  ("Oracle's guess"). The chip itself grows a small dot when a fresh draft
 *  is available, so there's a reason to peek even while idle/warm. */
/** Usage ring (docs/DRILL_PLAN.md B12.7, Lachy's ask): a small ring beside
 *  the Oracle chip that FILLS WITH WHITE as the rolling 4-hour usage window
 *  is consumed. Only rendered when Oracle is enabled (pure BYO users never
 *  see it); with no 4-hour limit set it stays an empty track whose tooltip
 *  points at Settings > Usage. Polls the local ledger every 60s - display
 *  only, never throttles anything. */
function UsageRing(): JSX.Element | null {
  const [ring, setRing] = useState<{ used: number; limit: number | null } | null>(null);
  useEffect(() => {
    const usage = window.metisUsage;
    if (!usage) return;
    let alive = true;
    const poll = (): void => {
      void usage
        .summary()
        .then((summary) => {
          if (!alive) return;
          setRing({ used: summary.last4h.totalTokens, limit: summary.limits.fourHourTokens ?? null });
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  if (!ring) return null;
  const fraction = ring.limit ? Math.min(1, ring.used / ring.limit) : 0;
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const title = ring.limit
    ? `${formatTokenCount(ring.used)} of ${formatTokenCount(ring.limit)} tokens used in the last 4 hours (${Math.round(fraction * 100)}%)`
    : `${formatTokenCount(ring.used)} tokens in the last 4 hours — set a 4-hour limit in Settings > Usage to fill the ring`;
  return (
    <span className="usage-ring" title={title} role="img" aria-label={title}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle className="usage-ring-track" cx="9" cy="9" r={radius} fill="none" strokeWidth="2" />
        <circle
          className="usage-ring-fill"
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          transform="rotate(-90 9 9)"
        />
      </svg>
    </span>
  );
}

/** Oracle's own mark (B12 declutter, Lachy: give it an SVG logo of its own) —
 *  a small all-seeing compass star, drawn inline so it inherits currentColor
 *  and needs no asset. Used by the chip and the popover wordmark. */
function OracleMark({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg className="oracle-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.1" fill="currentColor" />
      <path d="M12 2v4.4M12 17.6V22M2 12h4.4M17.6 12H22" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M5.2 5.2l2.5 2.5M16.3 16.3l2.5 2.5M18.8 5.2l-2.5 2.5M7.7 16.3l-2.5 2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

function OracleChip({
  activity,
  log,
  draft,
  open,
  onToggle,
  onClose
}: {
  activity: OracleActivity;
  log: OracleWarmEvent[];
  draft: OracleDraftResult | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}): JSX.Element {
  const label =
    activity.phase === "warming"
      ? `Oracle: warming ${activity.model}`
      : activity.phase === "warm"
      ? `Oracle: ${activity.model} warm, ${activity.ms}ms`
      : "Oracle ready";
  // Popover status subline - a shipped-feature voice for the same honest
  // facts the chip label carries (docs/DRILL_PLAN.md B12 cosmetic pass).
  const statusLine =
    activity.phase === "warming"
      ? `Warming ${activity.model}…`
      : activity.phase === "warm"
      ? `${activity.model} · warm in ${activity.ms}ms`
      : "Idle · watching for your next pause";
  const hasDraft = Boolean(draft && (draft.text?.trim() || draft.thoughts?.trim()));
  return (
    <div className="oracle-chip-wrap">
      <button
        type="button"
        className={`composer-suggestion-chip oracle-chip ${activity.phase}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-label={hasDraft ? `${label} — a speculative guess is ready to preview` : `${label} — click for recent warm calls`}
        title={label}
      >
        <OracleMark size={12} />
        <span>Oracle</span>
        {hasDraft ? <span className="oracle-chip-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <>
          <div className="oracle-backdrop" onClick={onClose} />
          <div className={`oracle-log-popover ${activity.phase}`} role="dialog" aria-label="Oracle">
            <header className="oracle-popover-head">
              <span className="oracle-wordmark">
                <OracleMark size={13} />
                Oracle
              </span>
              <span className={`oracle-status ${activity.phase}`}>{statusLine}</span>
            </header>
            {hasDraft && draft ? (
              <div className="oracle-draft-block">
                <p className="oracle-draft-title">
                  Oracle&apos;s guess
                  {activity.phase === "warming" ? <span className="oracle-live-caret" aria-hidden="true" /> : null}
                </p>
                <div className="oracle-draft-body">
                  {draft.thoughts?.trim() ? <p className="oracle-draft-thinking">{draft.thoughts}</p> : null}
                  {draft.text?.trim() ? <p className="oracle-draft-text">{draft.text}</p> : null}
                </div>
                <p className="oracle-draft-hint">Speculative. Updates as you pause typing.</p>
              </div>
            ) : null}
            <p className="oracle-log-heading">Recent warms</p>
            {log.length === 0 ? (
              <p className="oracle-log-empty">No warm calls yet this session.</p>
            ) : (
              log.map((event, index) => (
                <div className="oracle-log-row" key={`${event.at}-${index}`}>
                  <strong>{event.model}</strong>
                  <span>{event.ms}ms</span>
                  <em>{secondsAgoLabel(event.at)}</em>
                </div>
              ))
            )}
            <footer className="oracle-popover-foot">Answers before you finish asking.</footer>
          </div>
        </>
      ) : null}
    </div>
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
/** Resolves a fan-out sub-agent's dot color by name, sharing the stable hue
 *  palette from MANAGED_AGENT_IDENTITIES (docs/DRILL_PLAN.md Phase 5, sub-round
 *  5c). Falls back to a neutral color for names outside the known roster —
 *  auto-named agents aren't guaranteed to line up with the fixed identities. */
function agentDotColor(name: string): string {
  const identity = MANAGED_AGENT_IDENTITIES.find((agent) => agent.name === name);
  return identity ? `hsl(${identity.hue} 45% 62%)` : "var(--faint)";
}

/** Small name + colour-dot badge for a fan-out sub-agent, reused on side-chat
 *  cards/groups and on the run's agent roster (5c). */
function AgentBadge({ name }: { name: string }): JSX.Element {
  return (
    <span className="agent-badge">
      <span className="agent-badge-dot" style={{ background: agentDotColor(name) }} aria-hidden="true" />
      {name}
    </span>
  );
}

/** Buckets side-chat calls by `agentName` for the fan-out grouped view (5c),
 *  preserving first-appearance order for both groups and calls within a
 *  group. Calls with no agentName land in a single unlabeled bucket. */
function groupSideChatCallsByAgent(calls: StageCallEvent["call"][]): { key: string; name?: string; calls: StageCallEvent["call"][] }[] {
  const order: string[] = [];
  const buckets = new Map<string, StageCallEvent["call"][]>();
  for (const call of calls) {
    const key = call.agentName ?? "";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(call);
  }
  return order.map((key) => ({ key: key || "unassigned", name: key || undefined, calls: buckets.get(key) ?? [] }));
}

function SideChatCard({ call, showAgentBadge = true }: { call: StageCallEvent["call"]; showAgentBadge?: boolean }): JSX.Element {
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
        {call.agentName && showAgentBadge ? <AgentBadge name={call.agentName} /> : null}
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
          ) : calls.some((call) => call.agentName) ? (
            groupSideChatCallsByAgent(calls).map((group) => (
              <div className="side-chat-agent-group" key={group.key}>
                {group.name ? (
                  <div className="side-chat-agent-group-head">
                    <AgentBadge name={group.name} />
                  </div>
                ) : null}
                {group.calls.map((call) => (
                  <SideChatCard key={call.id} call={call} showAgentBadge={!group.name} />
                ))}
              </div>
            ))
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

/** Thumbs signals (DRILL_PLAN B12.1): the two explicit preference kinds that
 *  had no UI. One vote per turn per session (local state only - the vote
 *  itself lands in the preference log via metisPreference.signal). Hidden
 *  entirely when the bridge is absent - never a dead control. */
function TurnThumbs({ run, conversationId }: { run: SessionRun; conversationId?: string }): JSX.Element | null {
  const [voted, setVoted] = useState<"up" | "down" | null>(null);
  if (!window.metisPreference || !run.providerResult) return null;
  function vote(kind: "thumbs_up" | "thumbs_down", direction: "up" | "down"): void {
    if (voted) return;
    setVoted(direction);
    void window.metisPreference?.signal({
      kind,
      provider: run.providerResult?.provider,
      model: run.providerResult?.model,
      conversationId
    });
  }
  return (
    <>
      <button
        type="button"
        className={`turn-copy ${voted === "up" ? "voted" : ""}`}
        title={voted ? "Recorded" : "Good answer (recorded as a routing signal)"}
        aria-label="Good answer"
        disabled={voted !== null}
        onClick={() => vote("thumbs_up", "up")}
      >
        <ThumbsUp size={13} />
      </button>
      <button
        type="button"
        className={`turn-copy ${voted === "down" ? "voted" : ""}`}
        title={voted ? "Recorded" : "Bad answer (recorded as a routing signal)"}
        aria-label="Bad answer"
        disabled={voted !== null}
        onClick={() => vote("thumbs_down", "down")}
      >
        <ThumbsDown size={13} />
      </button>
    </>
  );
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
    <button type="button" className="turn-copy" onClick={copy} aria-label={copied ? "Copied" : "Copy message"} title={copied ? "Copied" : "Copy message"}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

const ConversationTurnCard = memo(function ConversationTurnCard({
  anchorId,
  turn,
  onNavigate,
  onRegenerate
}: {
  anchorId?: string;
  turn: ConversationTurn;
  onNavigate?: (nav: NavKey) => void;
  /** Re-asks this turn's prompt AND records a regenerate preference signal
   *  (DRILL_PLAN B12.1 - the clearest dissatisfaction data we collect). */
  onRegenerate?: () => void;
}): JSX.Element {
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
            <CompletedRun run={turn.run} onNavigate={onNavigate} />
            {/* One horizontal row for all per-turn actions (Lachy: the
                buttons were stacking vertically) - copy, regenerate, thumbs. */}
            <div className="turn-actions">
              <TurnCopyButton run={turn.run} />
              {onRegenerate ? (
                <button type="button" className="turn-copy" title="Regenerate - ask this again (recorded as a routing signal)" aria-label="Regenerate" onClick={onRegenerate}>
                  <RotateCcw size={13} />
                </button>
              ) : null}
              <TurnThumbs run={turn.run} />
            </div>
          </>
        ) : (
          <PendingRun turn={turn} />
        )}
      </div>
      {turn.run?.oracleNearMatch && onRegenerate ? (
        // Oracle v0.4 escape hatch (DRILL_PLAN B12.3 follow-up): a near-match
        // serve always offers the real thing one click away. Same plumbing as
        // regenerate, so the redo is also recorded as a preference signal.
        <button type="button" className="near-match-exact" onClick={onRegenerate}>
          Answer my exact prompt instead
        </button>
      ) : null}
    </article>
  );
});

function PendingRun({ turn }: { turn: ConversationTurn }): JSX.Element {
  // Checked BEFORE the error branch. A stopped run keeps everything that had
  // already streamed and adds a neutral note, because the user asked it to
  // stop and throwing away the answer they were reading is a punishment for
  // clicking the button. The error branch below is deliberately untouched:
  // a genuine failure still replaces the bubble, since a half-answer from a
  // provider that died mid-stream looks identical to a finished one and
  // presenting it as the model's reply would be the dishonest version of this.
  if (turn.status === "stopped") {
    return (
      <>
        {turn.streamEvents?.length || turn.liveAssistantText || turn.liveThoughtText ? <LiveRunTimeline turn={turn} /> : null}
        <small className="session-stopped">Stopped. This is as far as it got.</small>
      </>
    );
  }
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
          // Pinned runs render no route/direct-call line at all
          // (docs/DRILL_PLAN.md PF5b) — this covers the old-run fallback
          // where the backend still emitted a "Calling {label} directly."
          // text event ahead of this one; new backend runs stop sending
          // that text event entirely, so turnHasPinnedModelSignal will
          // simply never be true for them and this branch is moot. No
          // first-token line renders here either — ttftMs isn't known until
          // the run completes, at which point CompletedRun takes over.
          if (turnHasPinnedModelSignal(turn)) return null;
          const label = event.label ?? "Metis";
          return (
            <details className="route-line-details" key={event.id}>
              <summary className="route-line">
                <ChevronRight className="stage-caret" size={14} />
                <Waypoints size={13} />
                <span>Routed via {label}</span>
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

/** Inline chat record for an in-run permission ask (docs/FABLE_PLANS.md §24,
 *  elevated per docs/DRILL_PLAN.md B2.4) — the interactive verdict buttons now
 *  live only in the floating ChatboxPopup; this renders nothing until
 *  `resolved` is set, then shows the same one-line audit record as before. */
function PermissionRequestCard({ request }: { request: NonNullable<ConversationTurn["pendingPermission"]> }): JSX.Element | null {
  if (!request.resolved) return null;
  const { verdict } = request.resolved;
  const label = verdict === "deny" ? "Denied" : verdict === "always" ? "Always allowed" : "Allowed once";
  return (
    <div className="permission-card resolved">
      <ShieldCheck size={13} />
      <span>
        {label} — {request.detail}
      </span>
    </div>
  );
}

/** Inline chat record for an AskUserQuestion (docs/FABLE_PLANS.md §24, elevated
 *  multi-question popup per docs/DRILL_PLAN.md B2.3) — the interactive option
 *  chips / free-text form now live only in the floating ChatboxPopup; this
 *  renders nothing until `resolved` is set, then shows the answer(s). */
function UserQuestionCard({ question }: { question: NonNullable<ConversationTurn["pendingQuestion"]> }): JSX.Element | null {
  if (!question.resolved) return null;
  const { answer } = question.resolved;
  const label = Array.isArray(answer) ? answer.join(" · ") : answer;
  return (
    <div className="permission-card resolved">
      <HelpCircle size={13} />
      <span>You answered: {label}</span>
    </div>
  );
}

/** Shared floating popup surface (docs/DRILL_PLAN.md B2.3/B2.4): rises from the
 *  composer (see .home-dock's position: relative + this component's
 *  .chatbox-popup-wrap anchored to its top edge) to host either the active
 *  in-run permission ask or AskUserQuestion set — one interactive surface, one
 *  shared grammar, so the two feel like a single system rather than two
 *  bolted-together features. Non-modal: the scrim is a faint visual cue only
 *  (pointer-events: none in CSS), never a full-screen block. */
function ChatboxPopup({ children, label }: { children: ReactNode; label: string }): JSX.Element {
  return (
    <div className="chatbox-popup-wrap">
      <div className="chatbox-popup-scrim" aria-hidden="true" />
      <div className="chatbox-popup" role="dialog" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** Interactive body for the permission half of ChatboxPopup — same
 *  detail + Allow once / Always allow / Deny grammar as the old inline card,
 *  gated behind window.metisPermissions exactly as before (shows the disabled
 *  note instead of dead buttons in the no-bridge preview). */
function PermissionPopupBody({
  request,
  onRespond
}: {
  request: { detail: string };
  onRespond: (verdict: PermissionVerdict) => void;
}): JSX.Element {
  return (
    <div className="chatbox-popup-body">
      <div className="permission-card-detail">
        <Shield size={14} />
        <span>{request.detail}</span>
      </div>
      {window.metisPermissions ? (
        <div className="permission-card-actions">
          <button type="button" onClick={() => onRespond("allow")}>
            Allow once
          </button>
          <button type="button" onClick={() => onRespond("always")}>
            Always allow
          </button>
          <button type="button" className="deny" onClick={() => onRespond("deny")}>
            Deny
          </button>
        </div>
      ) : (
        <small className="permission-card-disabled">Permission prompts need the desktop app — this is a preview.</small>
      )}
    </div>
  );
}

type PopupQuestionSpec = { text: string; options: string[]; allowCustom?: boolean };

/** Interactive body for the question half of ChatboxPopup — up to 4 questions
 *  (docs/DRILL_PLAN.md B2.3a). A single question keeps the original snappy
 *  UX (clicking an option or sending custom text answers immediately, as a
 *  plain string). Two or more questions switch to "fill every question, then
 *  submit together" since no single click can resolve a multi-question ask;
 *  each question's option chips and free-text field both write into the same
 *  per-question slot, and the shared Submit button stays disabled until every
 *  slot has something in it. Free-text stays gated behind window.metisSession
 *  (disabled note in the no-bridge preview); option chips stay clickable
 *  regardless, matching the original single-question card's behavior. */
function QuestionPopupBody({
  question,
  onRespond
}: {
  question: { text: string; options: string[]; questions?: PopupQuestionSpec[] };
  onRespond: (answer: UserQuestionAnswer) => void;
}): JSX.Element {
  const specs: PopupQuestionSpec[] = question.questions?.length ? question.questions.slice(0, 4) : [{ text: question.text, options: question.options }];
  const isMulti = specs.length > 1;
  const [values, setValues] = useState<string[]>(() => specs.map(() => ""));
  const [customDrafts, setCustomDrafts] = useState<string[]>(() => specs.map(() => ""));

  function chooseOption(index: number, option: string): void {
    if (!isMulti) {
      onRespond(option);
      return;
    }
    setValues((current) => current.map((value, i) => (i === index ? option : value)));
  }

  function submitCustom(index: number): void {
    const text = customDrafts[index].trim();
    if (!text) return;
    if (!isMulti) {
      onRespond(text);
      return;
    }
    setValues((current) => current.map((value, i) => (i === index ? text : value)));
  }

  const allAnswered = values.every((value) => value.trim().length > 0);

  return (
    <div className="chatbox-popup-body question-popup">
      {specs.map((spec, index) => (
        <div className={`question-popup-item ${isMulti && values[index] ? "answered" : ""}`} key={index}>
          <div className="permission-card-detail">
            <HelpCircle size={14} />
            <span>{spec.text}</span>
            {isMulti && values[index] ? <Check size={13} className="question-popup-answered-icon" /> : null}
          </div>
          {spec.options.length > 0 ? (
            <div className="question-card-options">
              {spec.options.map((option) => (
                <button key={option} type="button" className={isMulti && values[index] === option ? "selected" : ""} onClick={() => chooseOption(index, option)}>
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          {spec.allowCustom === false ? null : window.metisSession ? (
            <form
              className="question-card-freetext"
              onSubmit={(event) => {
                event.preventDefault();
                submitCustom(index);
              }}
            >
              <input
                value={customDrafts[index]}
                onChange={(event) => {
                  const text = event.target.value;
                  setCustomDrafts((current) => current.map((value, i) => (i === index ? text : value)));
                }}
                placeholder="Or type your own answer"
              />
              <button type="submit">{isMulti ? "Set" : "Send"}</button>
            </form>
          ) : (
            <small className="permission-card-disabled">Answering needs the desktop app — this is a preview.</small>
          )}
        </div>
      ))}
      {isMulti ? (
        <div className="question-popup-submit-row">
          <button type="button" className="question-popup-submit" disabled={!allAnswered} onClick={() => onRespond(values)}>
            Submit answers
          </button>
        </div>
      ) : null}
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

/** True when this run bypassed Metis Policy for a pinned model (main.ts's
 *  initialPipelineSteps sets the "route" step's label to "Calling {label}
 *  directly" only when SessionRunInput.modelOverride was set — "Route through
 *  Metis Policy" otherwise). Runs recorded before that wording existed (or the
 *  hardcoded build-pipeline stageSteps, which don't carry the override signal
 *  even when a pinned model forced every stage via /orchestration) fall back
 *  to false here and keep the old "Routed via" phrasing below — a deliberate
 *  gap, not a bug: there is no reliable pinned signal on that older/hardcoded
 *  shape, and guessing one risks calling a genuinely routed run "direct". */
function isPinnedRun(run: SessionRun): boolean {
  return Boolean(run.steps?.find((step) => step.id === "route")?.label?.startsWith("Calling "));
}

/** Route summary line text for a genuinely routed run: "Routed via {label}".
 *  Only ever called from the non-pinned branch of RouteLine below — a pinned
 *  run never reaches this text at all per docs/DRILL_PLAN.md PF5b (Lachy:
 *  seeing "Called Qwen Qwen3 8B directly" on a run he deliberately pinned is
 *  just noise; he pinned it, of course it was called directly). Still
 *  guarded with isPinnedRun here too, defensively, in case a future caller
 *  forgets to check first. */
function routeLineText(run: SessionRun): string {
  const label = routeDisplayName(run);
  return isPinnedRun(run) ? `Called ${label} directly` : `Routed via ${label}`;
}

/** Live-streaming counterpart of isPinnedRun, for turns still in flight
 *  (turn.run is undefined so routeLineText/run.steps aren't available yet).
 *  main.ts's plain-chat path (the common "pin a model, just chat" case)
 *  always emits a "Calling {label} directly. Skipping the router." text
 *  timeline event immediately before its "route" event when modelOverride is
 *  set — never on a genuinely routed run, and never with that exact
 *  "directly." sentence break on the build-pipeline path (which instead says
 *  "directly for every stage…", deliberately excluded so a /orchestration run
 *  with a pinned model doesn't flip wording between live and completed views,
 *  since the persisted build-pipeline steps don't carry the signal either —
 *  see isPinnedRun). */
function turnHasPinnedModelSignal(turn: ConversationTurn): boolean {
  return Boolean(turn.streamEvents?.some((event) => event.kind === "text" && /^Calling .+ directly\./.test(event.content)));
}

/** Slim time-to-first-token addition for a completed run's route line
 *  (docs/DRILL_PLAN.md B5.5) — undefined ttftMs (every provider call that
 *  wasn't a streaming Ollama call, today) renders nothing rather than a
 *  placeholder. */
function ttftSuffix(run: SessionRun): JSX.Element | null {
  // Oracle-served runs (v0.3, DRILL_PLAN O4) are labeled honestly: the answer
  // was pre-drafted while typing and served on an exact prompt match, so the
  // ms shown is the serve time, not a fresh generation's first token.
  if (run.oracleServed) {
    // v0.4 (DRILL_PLAN B12.3): near-match serves are labeled with their
    // similarity so a served near-miss is never disguised as an exact match.
    const nearMatch = typeof run.oracleNearMatch === "number" ? ` · near match ${(run.oracleNearMatch * 100).toFixed(0)}%` : "";
    return <em>{typeof run.ttftMs === "number" ? `Oracle answered instantly, ${run.ttftMs}ms${nearMatch}` : `Oracle answered instantly${nearMatch}`}</em>;
  }
  return typeof run.ttftMs === "number" ? <em>first token {run.ttftMs}ms</em> : null;
}

/** Completed-run route line (docs/DRILL_PLAN.md PF5b). A pinned run
 *  (isPinnedRun) shows NO route/direct-call line at all — "Called {label}
 *  directly" is gone entirely, not just reworded. The ONLY metadata that
 *  survives for a pinned run is the existing first-token time, rendered as a
 *  slim standalone line (no icon, no expand affordance — there's no "Routed
 *  via" to hide a trace behind); if ttftMs isn't set, nothing renders at
 *  all. A genuinely routed run is completely unchanged: the expandable
 *  "Routed via {label}" line with its pipeline-steps trace, ttft appended
 *  inline as before. `withCaret` matches the RunTimeline "route" event site,
 *  which prefixes a ChevronRight caret the other two completed-run sites
 *  don't have. */
function RouteLine({ run, withCaret }: { run: SessionRun; withCaret?: boolean }): JSX.Element | null {
  if (isPinnedRun(run)) {
    const ttft = ttftSuffix(run);
    return ttft ? <div className="route-line pinned-ttft">{ttft}</div> : null;
  }
  return (
    <details className="route-line-details">
      <summary className="route-line">
        {withCaret ? <ChevronRight className="stage-caret" size={14} /> : null}
        <Waypoints size={13} />
        <span>{routeLineText(run)}</span>
        {ttftSuffix(run)}
      </summary>
      <div className="route-trace-body">
        <PipelineSteps steps={run.steps} />
      </div>
    </details>
  );
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
  "claude-fable-5": "Claude Fable 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  "deepseek-chat": "DeepSeek V4 Flash",
  "deepseek-reasoner": "DeepSeek V4 Pro",
  "deepseek-ai/deepseek-v3.1": "DeepSeek V3.1 (NVIDIA)",
  "x-ai/grok-4.5": "Grok 4.5",
  "x-ai/grok-4.3": "Grok 4.3",
  "z-ai/glm-5.2": "GLM 5.2",
  "moonshotai/kimi-k2.6": "Kimi K2.6",
  "llama-3.3-70b-versatile": "Llama 3.3 70B (Groq)",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.1": "GPT-5.1",
  "gpt-5": "GPT-5",
  "gpt-4.1": "GPT-4.1",
  "gpt-4o": "GPT-4o",
  "qwen3:1.7b": "Qwen3 1.7B",
  "qwen3:4b": "Qwen3 4B",
  "qwen3:8b": "Qwen3 8B",
  "qwen3:14b": "Qwen3 14B",
  "qwen3:32b": "Qwen3 32B",
  "qwen3-vl:8b": "Qwen3-VL 8B",
  "qwen3-vl:32b": "Qwen3-VL 32B",
  "qwen3-embedding:0.6b": "Qwen3 Embedding 0.6B",
  "qwen3-embedding:4b": "Qwen3 Embedding 4B",
  "nomic-embed-text": "Nomic Embed Text",
  "mxbai-embed-large": "MxBai Embed Large",
  "moondream": "Moondream 2",
  "llava:13b": "LLaVA 13B",
  "phi4": "Phi-4 14B",
  "phi4-mini": "Phi-4 Mini 3.8B",
  "mistral-small:24b": "Mistral Small 24B",
  "gemma3:12b": "Gemma 3 12B",
  "gemma3:27b": "Gemma 3 27B",
  "deepseek-r1:14b": "DeepSeek R1 Distill 14B",
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

/** Approve/dismiss cards for actions a completed run proposed (docs/DRILL_PLAN.md
 *  Phase 3 L6 part 2 — the same `ManagerAction[]` protocol the Manager tab uses,
 *  now attached to `SessionRun.actions` on a general-chat turn). Reuses
 *  `ManagerActionCard` verbatim so approval, dismissal, and the execution path
 *  via `metisManager.runAction` are identical to the Manager tab — nothing here
 *  re-implements that logic. Renders once, directly under the run's assistant
 *  text, regardless of which CompletedRun branch produced that text. */
function RunProposedActions({ run, onNavigate }: { run: SessionRun; onNavigate: (nav: NavKey) => void }): JSX.Element | null {
  // While the To Do List surface is cut from v1 (V1_HIDDEN_NAV), an "Add
  // todo" card would offer to write to a board the user cannot open — so
  // those proposals are hidden here rather than shown-but-stranded. The
  // filter reads nav visibility (not action validity) so the cards come back
  // automatically the day the board ships. Same spirit as ManagerActionCard's
  // open_view refusal for hidden views.
  const visibleActions = (run.actions ?? []).filter((action) => action.kind !== "add_todo" || isNavVisible("todo"));
  if (!visibleActions.length) return null;
  return (
    <div className="manager-action-list">
      {visibleActions.map((action, actionIndex) => (
        <ManagerActionCard key={actionIndex} action={action} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

/** Compact roster row for a completed fan-out build (docs/DRILL_PLAN.md Phase
 *  5, sub-round 5c; collapsed-by-default summary added in §20): sits quietly
 *  above the run's normal output, collapsed under a "Ran N agents" header
 *  using the same slim-op-group caret grammar as GroupedOperationSummary, and
 *  expands into the per-agent chip list. Undefined `run.fanout` (every
 *  ordinary single-pipeline run) means the caller never mounts this at all —
 *  this is the only place a fan-out roster renders, so there is no separate
 *  "Ran N agents" chip duplicating it elsewhere. */
function FanoutRoster({ agents }: { agents: NonNullable<SessionRun["fanout"]>["agents"] }): JSX.Element {
  const multi = agents.length > 1;
  if (!multi) {
    return (
      <div className="fanout-roster" aria-label="Fan-out agents">
        <div className="fanout-roster-head">
          <Waypoints size={13} />
          <span>Split across {agents.length} agent{agents.length === 1 ? "" : "s"}</span>
        </div>
        <div className="fanout-roster-list">
          {agents.map((agent) => (
            <FanoutAgentChip key={agent.name} agent={agent} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <details className="slim-op-line-details slim-op-group fanout-roster-details">
      <summary className="slim-op-line fanout-roster-head">
        <ChevronRight className="stage-caret" size={12} />
        <Waypoints size={13} />
        <span>Ran {agents.length} agents</span>
      </summary>
      <div className="fanout-roster-list operation-detail-body">
        {agents.map((agent) => (
          <FanoutAgentChip key={agent.name} agent={agent} />
        ))}
      </div>
    </details>
  );
}

function FanoutAgentChip({ agent }: { agent: { name: string; task: string; claimedPaths: string[] } }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasPaths = agent.claimedPaths.length > 0;
  return (
    <div className={`fanout-chip ${expanded ? "open" : ""}`}>
      <button
        type="button"
        className="fanout-chip-head"
        onClick={() => hasPaths && setExpanded((value) => !value)}
        aria-expanded={hasPaths ? expanded : undefined}
      >
        <span className="fanout-chip-dot" style={{ background: agentDotColor(agent.name) }} aria-hidden="true" />
        <span className="fanout-chip-name">{agent.name}</span>
        <span className="fanout-chip-task">{agent.task}</span>
        <span className="fanout-chip-count">
          claimed {agent.claimedPaths.length} file{agent.claimedPaths.length === 1 ? "" : "s"}
        </span>
        {hasPaths ? <ChevronRight className={`stage-caret ${expanded ? "open" : ""}`} size={12} /> : null}
      </button>
      {expanded && hasPaths ? (
        <ul className="fanout-chip-paths">
          {agent.claimedPaths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const CompletedRun = memo(function CompletedRun({ run, onNavigate }: { run: SessionRun; onNavigate?: (nav: NavKey) => void }): JSX.Element {
  const warnings = visibleRunWarnings(run.warnings);
  const showRouteTrace = shouldShowRouteTrace(run, warnings);
  const navigate = onNavigate ?? (() => {});
  const fanoutAgents = run.fanout?.agents;
  const roster = fanoutAgents?.length ? <FanoutRoster agents={fanoutAgents} /> : null;

  if (run.timeline?.length) {
    return (
      <>
        {roster}
        <RunTimeline run={run} events={run.timeline} warnings={warnings} />
        <RunProposedActions run={run} onNavigate={navigate} />
      </>
    );
  }

  if (run.stages && run.stages.length > 0) {
    return (
      <>
        {roster}
        <Markdown>{run.assistantText}</Markdown>
        {run.stages.map((stage) => (
          <StageBlock stage={stage} key={stage.id} />
        ))}
        {run.projectResult ? <ProjectArtifacts run={run} /> : null}
        <RouteLine run={run} />
        {warnings.length > 0 ? <small className="session-warning">{warnings[0]}</small> : null}
        <RunProposedActions run={run} onNavigate={navigate} />
      </>
    );
  }

  const [opening, followUp] = splitAssistantTextForTimeline(run.assistantText);
  const source = responseSource(run);
  return (
    <>
      {roster}
      <AssistantResponse source={source}>{showRouteTrace ? opening : run.assistantText}</AssistantResponse>
      {run.modelThoughts ? <ModelThoughts text={run.modelThoughts} /> : null}
      {run.projectResult ? <ProjectArtifacts run={run} /> : null}
      {!run.projectResult && run.operations?.length ? <RunOperations operations={run.operations} /> : null}
      {showRouteTrace ? <RouteLine run={run} /> : null}
      {showRouteTrace && followUp ? <AssistantResponse source={source}>{followUp}</AssistantResponse> : null}
      {warnings.length > 0 ? <small className="session-warning">{warnings[0]}</small> : null}
      <RunProposedActions run={run} onNavigate={navigate} />
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
          return <RouteLine run={run} withCaret key={event.id} />;
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
      operation.consoleErrors?.length ||
      operation.sourcePaths?.length
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
        {operation.sourcePaths?.length ? (
          // Per-source provenance (DRILL_PLAN I9.7) - e.g. exactly which
          // knowledge chunks grounded a turn, one line each.
          <ul className="operation-source-list">
            {operation.sourcePaths.map((entry, index) => (
              <li key={`${entry}-${index}`}>{entry}</li>
            ))}
          </ul>
        ) : null}
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
  // `startClient` (docs/DRILL_PLAN.md B11.3): node drags only start once the
  // pointer clears NODE_DRAG_THRESHOLD_PX, so a plain click selects the node
  // without nudging it a pixel.
  | { type: "node"; id: string; offset: Vec; isSkill: boolean; moved: boolean; startClient: Vec }
  | null;

/** Client-space pixels a pointerdown may travel and still count as a click
 *  (same disambiguation trick as the Manager fab's drag fix). Used both for
 *  canvas node drags and for Library model rows, where a clean click opens
 *  the model's gateway panel and a real drag assigns the model to a node
 *  (docs/DRILL_PLAN.md B11.3 v2). */
const NODE_DRAG_THRESHOLD_PX = 5;

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
/** Maps a picker ModelRef (renderer brand ids) to the backend StageModelRef
 *  shape the depthRoutes store expects. Local-tier brands resolve to ollama
 *  + their real tag; cloud brands whose id IS a backend ProviderKey pass
 *  through; anything unmappable returns null and is simply not mirrored
 *  (the node keeps the setting, the engine keeps its level default). */
function depthStageRefFor(ref: ModelRef | "router"): { provider: string; model: string } | "router" | null {
  if (ref === "router") return "router";
  if (PROVIDERS[ref.provider]?.tier === "local") {
    const tag = localOllamaTagFor(ref);
    return tag ? { provider: "ollama", model: tag } : null;
  }
  // Map the renderer BRAND id to the backend ProviderKey before checking it.
  // This used to compare brand ids against backend keys directly, which happened
  // to work for openai/gemini/deepseek because those names coincide, and
  // silently returned null for "claude" and "grok" - so pinning Opus 4.8 to a
  // depth level wrote nothing to the store and the engine kept its own default.
  // The level looked configured and was not.
  const key = PROVIDER_CONNECTIONS[ref.provider];
  return key ? { provider: key, model: ref.model } : null;
}

/** Projects the depths-enabled node's level stack into the depthRoutes store
 *  shape (docs/DRILL_PLAN.md B11.2/B11.6). L3 DEFAULTS TO THE NODE'S OWN
 *  PRIMARY MODEL (Lachy: whatever model you drag and drop onto the node is by
 *  default your L3) - an explicit L3 pick still wins. Runs from the same
 *  debounced nodes effect as the pipeline projection, so a drag-and-drop
 *  primary swap re-mirrors L3 without the inspector even being open. Returns
 *  null when no node has depths enabled (nothing is written, the store keeps
 *  its last value and the depthRoutingEnabled flag governs whether it's used). */
/** One node's own depth stack, in the wire shape GraphPipelineStage.depths
 *  carries (roadmap "Per-node Depths"). Identical resolution to the global
 *  depthRoutes mirror below — same depthStageRefFor mapping, same
 *  "L3 defaults to the node's primary" rule — so the stack a node DISPLAYS,
 *  the stack the global mirror writes, and the stack each pipeline stage
 *  consumes can never disagree. Returns undefined for a node with depths
 *  disabled or nothing mappable. */
function projectNodeDepthStack(node: GraphNode): GraphPipelineStage["depths"] {
  if (!node.depthsEnabled) return undefined;
  const models = node.depthModels ?? {};
  const primary: ModelRef | undefined = node.provider && node.model ? { provider: node.provider, model: node.model } : undefined;
  const rung = (pick: ModelRef | "router" | undefined, implied?: ModelRef): NonNullable<GraphPipelineStage["depths"]>["deep"] => {
    const chosen = pick ?? implied;
    if (!chosen) return undefined;
    const mapped = chosen === "router" ? "router" : depthStageRefFor(chosen);
    // depthStageRefFor maps renderer brand ids to backend ProviderKeys, so the
    // cast only ever narrows a string it produced itself.
    return mapped === null ? undefined : (mapped as NonNullable<GraphPipelineStage["depths"]>["deep"]);
  };
  const shallow = rung(models.l1);
  const standard = rung(models.l2);
  const deep = rung(models.l3, primary);
  if (!shallow && !standard && !deep) return undefined;
  return {
    ...(shallow ? { shallow } : {}),
    ...(standard ? { standard } : {}),
    ...(deep ? { deep } : {})
  };
}

function projectDepthRoutes(nodes: GraphNode[]): Record<string, unknown> | null {
  const node = nodes.find((n) => n.depthsEnabled && (n.kind === "agent" || n.kind === "router"));
  if (!node) return null;
  // Same resolution as the per-stage projection above. This global mirror
  // remains what the CHAT path's depthRouteFor reads; pipeline stages now
  // carry their own stacks, so "first depths-enabled node wins" only ever
  // applies to single-model chat turns, where there is no per-node anything.
  return (projectNodeDepthStack(node) as Record<string, unknown> | undefined) ?? {};
}

/** One rung of a depths-enabled node, resolved for display.
 *  `implied` marks a rung the user did not pick explicitly, so the node can
 *  show it as inherited rather than chosen. */
type DepthRung = { level: "L1" | "L2" | "L3"; label: string; provider?: ProviderId; implied: boolean; unroutable?: boolean };

/** What a depths-enabled node will ACTUALLY reach for, resolved the same way
 *  projectDepthRoutes resolves it. Deliberately sitting next to that function:
 *  the L3-defaults-to-the-primary-model rule lives in both, and a node that
 *  displayed a different stack from the one it writes to the store would be
 *  the most confusing possible bug in this feature.
 *
 *  Levels the user has not pinned are shown as their real fallback wording
 *  rather than left blank, because blank reads as "nothing happens here" when
 *  in fact the depth engine has a default for it. */
function resolveNodeDepths(node: GraphNode): DepthRung[] {
  const models = node.depthModels ?? {};
  const primary: ModelRef | undefined = node.provider && node.model ? { provider: node.provider, model: node.model } : undefined;

  const describe = (level: DepthRung["level"], pick: ModelRef | "router" | undefined, fallback: string, impliedRef?: ModelRef): DepthRung => {
    if (pick === "router") return { level, label: "the router answers it", implied: false };
    // Resolved through the SAME function projectDepthRoutes writes with. Sitting
    // next to it was not enough: depthStageRefFor silently drops a model it
    // cannot map to a backend route, so the node cheerfully displayed rungs the
    // engine never received. A rung that will not be applied must say so rather
    // than look pinned.
    const chosen = pick ?? impliedRef;
    if (chosen) {
      if (depthStageRefFor(chosen) === null) {
        return { level, label: `${chosen.model} cannot be routed here, level default applies`, implied: true, unroutable: true };
      }
      return { level, label: chosen.model, provider: chosen.provider, implied: !pick };
    }
    return { level, label: fallback, implied: true };
  };

  return [
    describe("L1", models.l1, "your local model"),
    describe("L2", models.l2, "whatever the router picks"),
    // L3 inherits the node's own primary model when unset, matching
    // projectDepthRoutes: "whatever you drag onto the node is your L3".
    describe("L3", models.l3, "strongest configured cloud", primary)
  ];
}

function projectGraphPipeline(nodes: GraphNode[], modelGateways: Record<string, ModelGatewayConfig>, customSkills: CustomSkill[]): GraphPipelineConfig {
  // Per-MODEL gateways (docs/DRILL_PLAN.md B11.3 v2): a model's gateway
  // config lives in the global modelGateways store (set from the Library
  // tab). Legacy node/slot-level fields still apply when no global config
  // exists for that model, so old graphs keep routing the way they did.
  const gatewayConfigFor = (ref: ModelRef, legacy: ModelGatewayConfig): ModelGatewayConfig =>
    modelGateways[modelGatewayKey(ref)] ?? legacy;
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
    // Resolve this node's attached skills to their CONTENT, not just names.
    // The canvas has always drawn skills as "loads first"; nothing actually
    // loaded until this existed, because no skill text ever left the renderer.
    // Skills with no content (registry placeholders, plain labels) are skipped
    // rather than injected as empty blocks.
    const stageSkills = (node.skills ?? [])
      .map((skillId) => nodes.find((candidate) => candidate.id === skillId))
      .filter((skillNode): skillNode is GraphNode => Boolean(skillNode))
      .map((skillNode) => {
        const custom = customSkills.find((entry) => entry.name === skillNode.label);
        return custom?.content?.trim() ? { name: custom.name, content: custom.content.trim() } : null;
      })
      .filter((entry): entry is { name: string; content: string } => entry !== null);
    // Per-MODEL gateways: each model in the chain (primary + every fallback)
    // resolves its own gateway config and projects it alongside its model, so
    // main.ts routes every chain entry through that model's pinned gateways.
    // Per-MODEL fallbacks win over the node's own chain, same precedence rule
    // gateways already use: the model's config is the editable home, the node
    // slot is legacy carry-over. A node whose primary has a configured chain
    // therefore inherits it without the chain being re-picked per node.
    const chain: NodeModelSlot[] = resolveModelFallbacks({ provider: node.provider, model: node.model }, node.fallbacks, modelGateways);
    const fallback = chain
      .filter((ref) => ref.model?.trim() && PROVIDER_CONNECTIONS[ref.provider])
      .map((ref) => {
        const config = gatewayConfigFor(ref, { gateway: ref.gateway, gatewayFallbacks: ref.gatewayFallbacks });
        const refGateway = config.gateway ? PROVIDER_CONNECTIONS[config.gateway] : undefined;
        const refGatewayFallbacks = (config.gatewayFallbacks ?? [])
          .map((brand) => PROVIDER_CONNECTIONS[brand])
          .filter((key): key is ProviderKey => Boolean(key));
        return {
          provider: PROVIDER_CONNECTIONS[ref.provider],
          model: ref.model,
          gateway: refGateway,
          gatewayFallbacks: refGatewayFallbacks.length > 0 ? refGatewayFallbacks : undefined
        };
      });
    const primaryConfig = gatewayConfigFor(
      { provider: node.provider, model: node.model },
      { gateway: node.gateway, gatewayFallbacks: node.gatewayFallbacks }
    );
    const gatewayKey = primaryConfig.gateway ? PROVIDER_CONNECTIONS[primaryConfig.gateway] : undefined;
    const gatewayFallbackKeys = (primaryConfig.gatewayFallbacks ?? [])
      .map((brand) => PROVIDER_CONNECTIONS[brand])
      .filter((key): key is ProviderKey => Boolean(key));
    stages.push({
      id: node.id,
      label: node.label,
      skills: stageSkills.length ? stageSkills : undefined,
      // Per-node depth stack (roadmap "Per-node Depths") — each stage carries
      // its OWN L1-L3 picks so the pipeline can honour every depths-enabled
      // node instead of one global table.
      depths: projectNodeDepthStack(node),
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
  // Read here rather than inside NodeCard so every node on the canvas agrees
  // about whether depths are live, instead of each one reading the store
  // separately and briefly disagreeing while they load.
  const [depthRoutingActive, setDepthRoutingActive] = useAppStoreState("depthRoutingEnabled", false);
  const [installedSkills, setInstalledSkills] = useState<RegistryPackage[]>([]);
  const [customSkills, setCustomSkills] = useAppStoreState("customSkills", EMPTY_CUSTOM_SKILLS);
  const [pan, setPan] = useState<Vec>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [interaction, setInteraction] = useState<Interaction>(null);
  const [drag, setDrag] = useState<GhostDrag | null>(null);
  const [overTarget, setOverTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Per-MODEL gateways (docs/DRILL_PLAN.md B11.3 v2): the global map of every
  // model's own gateway config, persisted app-store side so it survives the
  // graph and bakes into each graphPipeline projection. Edited via a clean
  // CLICK on a model in the Library tab (dragging still assigns the model).
  const [modelGateways, setModelGateways] = useAppStoreState<Record<string, ModelGatewayConfig>>("modelGateways", EMPTY_MODEL_GATEWAYS);
  // The model whose gateway panel is open in the side panel (null = Library).
  const [modelInspect, setModelInspect] = useState<ModelRef | null>(null);
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
      const config = projectGraphPipeline(nodesRef.current, modelGateways, customSkills);
      void window.metisStore?.set("graphPipeline", config);
      // Depths mirror (B11.6): L3 defaults to the node's primary model, so a
      // drag-and-drop model swap on a depths-enabled node re-mirrors here too.
      const depthRoutes = projectDepthRoutes(nodesRef.current);
      if (depthRoutes) void window.metisStore?.set("depthRoutes", depthRoutes);
    }, 1000);
    return () => window.clearTimeout(handle);
  }, [nodes, modelGateways, customSkills]);

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
    setModelInspect(null);
    canvasRef.current?.setPointerCapture(event.pointerId);
    const world = toWorld(event.clientX, event.clientY);
    setInteraction({
      type: "node",
      id: node.id,
      offset: { x: world.x - node.pos.x, y: world.y - node.pos.y },
      isSkill: node.kind === "skill",
      moved: false,
      startClient: { x: event.clientX, y: event.clientY }
    });
  }

  function onCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!interaction) return;
    if (interaction.type === "pan") {
      setPan({ x: interaction.startPan.x + (event.clientX - interaction.startClient.x), y: interaction.startPan.y + (event.clientY - interaction.startClient.y) });
      return;
    }
    // Click-vs-drag disambiguation (docs/DRILL_PLAN.md B11.3): the node stays
    // put until the pointer clears a small client-space threshold, so a click
    // on a model tile doesn't nudge the node a pixel and can open that
    // model's gateway config on pointerup instead.
    if (!interaction.moved) {
      const travelled = Math.hypot(event.clientX - interaction.startClient.x, event.clientY - interaction.startClient.y);
      if (travelled < NODE_DRAG_THRESHOLD_PX) return;
      setInteraction({ ...interaction, moved: true });
    }
    const world = toWorld(event.clientX, event.clientY);
    const nextPos = { x: world.x - interaction.offset.x, y: world.y - interaction.offset.y };
    setNodes((current) => current.map((node) => (node.id === interaction.id ? { ...node, pos: nextPos } : node)));
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

  /** Applies a seeded-registry-shaped preset ({stages}) onto the CURRENT graph instead of
   *  replacing it wholesale — there's no full GraphNode layout to load, just {role, provider,
   *  model, fallback?} per stage, so match each stage onto the matching node (router stage ->
   *  router node; role/intent match -> the agent node) the same way applyPreset(key) maps a
   *  built-in preset's models onto the graph by intent. */
  function applyPresetStages(stages: PresetStage[]): void {
    const routerStage = stages.find((stage) => stage.role.toLowerCase().includes("router"));
    setNodes((list) =>
      list.map((node) => {
        if (node.kind === "router") {
          if (!routerStage) return node;
          return { ...node, provider: routerStage.provider, model: routerStage.model, fallbacks: routerStage.fallback ? [routerStage.fallback] : node.fallbacks };
        }
        if (node.kind === "agent") {
          const haystack = (node.intent ?? node.label).toLowerCase();
          const stage = stages.find((entry) => entry !== routerStage && (haystack.includes(entry.role.toLowerCase()) || entry.role.toLowerCase().includes(haystack)));
          if (!stage) return node;
          return { ...node, provider: stage.provider, model: stage.model, fallbacks: stage.fallback ? [stage.fallback] : node.fallbacks };
        }
        return node;
      })
    );
    setSelected(null);
  }

  function loadPreset(): void {
    try {
      const raw = localStorage.getItem(PRESET_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { nodes?: GraphNode[]; stages?: PresetStage[] };
      if (parsed.nodes?.length) {
        setNodes(parsed.nodes);
        setSelected(null);
        fitTo(parsed.nodes);
        return;
      }
      if (parsed.stages?.length) {
        applyPresetStages(parsed.stages);
      }
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
      onDepthRoutingChange={setDepthRoutingActive}
    />
  ) : modelInspect ? (
    <ModelGatewayInspector
      modelRef={modelInspect}
      config={modelGateways[modelGatewayKey(modelInspect)] ?? {}}
      onClose={() => setModelInspect(null)}
      onChange={(next) =>
        setModelGateways((current) => {
          const key = modelGatewayKey(modelInspect);
          // An all-Auto config is the same as no config - drop the key so the
          // store only holds models the user actually pinned. This MUST list
          // every field the config carries: it originally checked gateways
          // only, so adding a model fallback and nothing else looked "empty"
          // and the whole entry was deleted on save. The picker click appeared
          // to do nothing at all.
          const isEmpty =
            !next.gateway &&
            !(next.gatewayFallbacks && next.gatewayFallbacks.length > 0) &&
            !(next.fallbacks && next.fallbacks.length > 0);
          if (isEmpty) {
            const { [key]: _removed, ...rest } = current;
            return rest;
          }
          return { ...current, [key]: next };
        })
      }
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
      onModelClick={(ref) => {
        setSelected(null);
        setModelInspect(ref);
      }}
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
              depthRoutingActive={depthRoutingActive}
              modelGateways={modelGateways}
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
  depthRoutingActive,
  modelGateways,
  onPointerDown,
  onDelete
}: {
  node: GraphNode;
  selected: boolean;
  targetMode: DragPayload["kind"] | null;
  /** The GLOBAL depthRoutingEnabled flag. A node can carry a depth stack while
   *  the flag is off, in which case the stack is configured but inert. Showing
   *  it as live would be the same lie in the other direction as showing one
   *  model when three are in play. */
  depthRoutingActive: boolean;
  /** The per-model config map, so a node shows the chain that will actually
   *  run rather than only the one stored on the node itself. */
  modelGateways: Record<string, ModelGatewayConfig>;
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
  // Depths change what the node IS, not a detail of it. With a depth stack
  // configured, naming one model is describing something that will not happen:
  // the router picks a rung by judged difficulty, so a node labelled "Fable 5"
  // while L3 is pinned to Opus 4.8 tells you the opposite of the truth about
  // your hardest tasks. Agent and router nodes only; a skill node has no model.
  const depthRungs = node.depthsEnabled && node.kind !== "skill" ? resolveNodeDepths(node) : null;
  const sublabel = node.kind === "skill" ? (isMoodboard ? "Board · loads first" : "Skill · loads first") : `${provider?.label ?? "Unassigned"}${node.model ? ` · ${node.model}` : ""}`;
  // The stack is what it reaches for, so the accessible name should say so too
  // rather than announcing a single model the run may never touch.
  const accessibleSublabel = depthRungs ? `routes by depth: ${depthRungs.map((rung) => `${rung.level} ${rung.label}`).join(", ")}` : sublabel;
  // Resolved through the SAME function projectGraphPipeline uses, so a node
  // cannot advertise a chain the pipeline will not run.
  const fallbacks = resolveModelFallbacks({ provider: node.provider as ProviderId, model: node.model ?? "" }, node.fallbacks, modelGateways);
  const palette = galleryVisual?.palette ?? [];

  return (
    <article
      aria-label={`${node.label} ${accessibleSublabel}`}
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
        {depthRungs ? (
          <span className={depthRoutingActive ? "node-depths" : "node-depths inert"}>
            {depthRungs.map((rung) => (
              <span className={["node-depth-rung", rung.implied ? "implied" : "", rung.unroutable ? "unroutable" : ""].filter(Boolean).join(" ")} key={rung.level}>
                <b>{rung.level}</b>
                {rung.provider ? <img alt="" src={PROVIDERS[rung.provider].logo} /> : null}
                <i>{rung.label}</i>
              </span>
            ))}
            {!depthRoutingActive ? <em className="node-depths-off">depth routing is off, none of this applies yet</em> : null}
          </span>
        ) : (
          <small>{sublabel}</small>
        )}
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
  onModelClick,
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
  /** A clean CLICK on a Library model row (docs/DRILL_PLAN.md B11.3 v2) -
   *  opens that model's gateway panel. Dragging past the threshold still
   *  assigns the model to a node via onPick, exactly as before. */
  onModelClick: (ref: ModelRef) => void;
  onPreset: (key: PresetKey) => void;
  onSavePreset: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<"skills" | "models" | "presets">("skills");
  const [query, setQuery] = useState("");
  const [addingSkill, setAddingSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDescription, setNewSkillDescription] = useState("");
  const [newSkillContent, setNewSkillContent] = useState("");
  const [newSkillFileName, setNewSkillFileName] = useState("");
  const [visionModel, setVisionModel] = useAppStoreState<string>("visionModel", DEFAULT_VISION_MODEL);

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

  // Click-vs-drag on a model row (docs/DRILL_PLAN.md B11.3 v2, Lachy's
  // balancing act): pointerdown on a model used to start the ghost drag
  // immediately. Now the drag only starts once the pointer travels past the
  // threshold; releasing before that is a CLICK, which opens the model's
  // gateway panel instead. Window-level listeners so the gesture resolves
  // even if the pointer leaves the row.
  function pickOrInspectModel(event: ReactPointerEvent<HTMLDivElement>, ref: ModelRef): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const payload: DragPayload = { kind: "model", provider: ref.provider, model: ref.model };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cleanup);
    };
    const onMove = (move: PointerEvent): void => {
      if (Math.hypot(move.clientX - startX, move.clientY - startY) < NODE_DRAG_THRESHOLD_PX) return;
      cleanup();
      onPick(move.clientX, move.clientY, payload);
    };
    const onUp = (): void => {
      cleanup();
      onModelClick(ref);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cleanup);
  }

  function submitCustomSkill(): void {
    const name = newSkillName.trim();
    if (!name) return;
    onAddCustomSkill({
      id: `custom-skill-${Date.now().toString(36)}`,
      name,
      description: newSkillDescription.trim() || undefined,
      content: newSkillContent.trim() || undefined
    });
    setNewSkillName("");
    setNewSkillDescription("");
    setNewSkillContent("");
    setNewSkillFileName("");
    setAddingSkill(false);
  }

  return (
    <aside className="palette" aria-label="Pipeline library">
      <header className="palette-head">
        <h2>Library</h2>
        <p>Drag onto the pipeline to wire it up</p>
      </header>

      <label className="palette-option-select" title="Captions gallery images (local vision model).">
        Vision model
        <CustomSelect ariaLabel="Vision model" value={visionModel} onChange={setVisionModel} options={VISION_MODEL_OPTIONS} />
        <small>Captions gallery images (local vision model).</small>
      </label>

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
              <div
                key={`${entry.provider}-${entry.model}`}
                className="palette-item model"
                title={`${entry.model} · drag onto a node, or click for gateways`}
                onPointerDown={(event) => pickOrInspectModel(event, entry)}
              >
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
                {/* The content is the part that makes a skill real: it is what
                    gets injected into a stage prompt when the skill is wired
                    onto a node. Loaded from a .md file because that is where
                    people already keep this kind of instruction. */}
                <label className="palette-skill-file">
                  <input
                    type="file"
                    accept=".md,.markdown,.txt"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => {
                        setNewSkillContent(typeof reader.result === "string" ? reader.result : "");
                        setNewSkillFileName(file.name);
                        // A file named like a skill IS the name, until you type one.
                        if (!newSkillName.trim()) setNewSkillName(file.name.replace(/\.(md|markdown|txt)$/i, ""));
                      };
                      reader.readAsText(file);
                    }}
                  />
                  <span>{newSkillFileName ? `${newSkillFileName} (${newSkillContent.length.toLocaleString()} chars)` : "Load content from a .md file"}</span>
                </label>
                {!newSkillContent.trim() ? (
                  <small className="palette-skill-note">Without content this is only a label: nothing will load into the run.</small>
                ) : null}
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
  const [roleFilter, setRoleFilter] = useState("all");
  const [localFirst, setLocalFirst] = useAppStoreState("benchmarkLocalFirst", DEFAULT_BENCHMARK_LOCAL_FIRST);
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
  const visibleScored = useMemo(
    () => (roleFilter === "all" ? scored : scored.filter((model) => model.roles?.includes(roleFilter))),
    [scored, roleFilter]
  );

  // General-purpose pool excludes vision/embeddings specialists — those get
  // their own recommendation slots below, picked purely by role tag.
  const generalPool = scored.filter((model) => !model.roles || model.roles.some((role) => role !== "vision" && role !== "embeddings"));
  const greatGeneral = generalPool.filter((model) => model.fit === "great");
  const usableGeneral = generalPool.filter((model) => model.fit === "great" || model.fit === "tight");
  const router = greatGeneral.find((model) => model.roles?.includes("router")) ?? greatGeneral[0] ?? usableGeneral[0] ?? generalPool[0];
  // Local-first weights the workhorse toward the biggest great-fit general model
  // (more capability handled on-device); Cloud-heavy keeps the local footprint
  // to just the router and lets cloud handle everything past that.
  const workhorse = localFirst
    ? greatGeneral.slice().sort((a, b) => b.vram - a.vram)[0] ?? usableGeneral[usableGeneral.length - 1] ?? router
    : router;
  const visionPick = pickBestForRole(scored, "vision");
  const embeddingsPick = pickBestForRole(scored, "embeddings");

  const [ollamaInfo, setOllamaInfo] = useState<OllamaListResult | null>(null);
  const [pullProgress, setPullProgress] = useState<Record<string, OllamaPullProgress>>({});
  const [skillRegistry, setSkillRegistry] = useState<RegistryPackage[]>([]);
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(new Set());
  const [skillInstallState, setSkillInstallState] = useState<Record<string, "installing" | "installed" | "failed">>({});

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
    if (!window.metisRegistry) return;
    let alive = true;
    void Promise.all([window.metisRegistry.list(), window.metisRegistry.listInstalled()]).then(([reg, installed]) => {
      if (!alive) return;
      setSkillRegistry(reg.packages);
      setInstalledSkillIds(new Set(installed.map((item) => item.id)));
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

  // Cloud-heavy keeps the install list to router + embeddings (cloud handles
  // coding/planning/vision); Local-first also pulls the workhorse and a vision
  // model so Gallery + Knowledge Banks work fully offline.
  const recommendedModels = useMemo(() => {
    const picks = localFirst ? [router, workhorse, visionPick, embeddingsPick] : [router, embeddingsPick];
    return picks.filter((model): model is ScoredModel => Boolean(model));
  }, [localFirst, router, workhorse, visionPick, embeddingsPick]);

  const installTargets = useMemo(() => {
    const seen = new Set<string>();
    const targets: Array<{ tag: string; name: string }> = [];
    for (const model of recommendedModels) {
      if (!model.ollamaTag || seen.has(model.ollamaTag)) continue;
      seen.add(model.ollamaTag);
      targets.push({ tag: model.ollamaTag, name: model.name });
    }
    return targets;
  }, [recommendedModels]);

  const manualModels = useMemo(() => {
    const names = new Set<string>();
    for (const model of recommendedModels) {
      if (!model.ollamaTag) names.add(model.name);
    }
    return Array.from(names);
  }, [recommendedModels]);

  const recommendedSkillMatches = useMemo(
    () => RECOMMENDED_ONBOARDING_SKILLS.map((name) => ({ name, pkg: matchSkillPackage(name, skillRegistry) })),
    [skillRegistry]
  );

  function skillStatus(pkg: RegistryPackage): "installed" | "installing" | "failed" | "pending" {
    if (installedSkillIds.has(pkg.id)) return "installed";
    return skillInstallState[pkg.id] ?? "pending";
  }

  async function installSkillPackage(pkg: RegistryPackage): Promise<void> {
    if (!window.metisRegistry) return;
    setSkillInstallState((current) => ({ ...current, [pkg.id]: "installing" }));
    try {
      await window.metisRegistry.install(pkg.id);
      setInstalledSkillIds((current) => new Set(current).add(pkg.id));
      setSkillInstallState((current) => ({ ...current, [pkg.id]: "installed" }));
    } catch {
      setSkillInstallState((current) => ({ ...current, [pkg.id]: "failed" }));
    }
  }

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
    for (const match of recommendedSkillMatches) {
      if (match.pkg && skillStatus(match.pkg) === "pending") void installSkillPackage(match.pkg);
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
          <div className="chip-row bench-plan-toggle" role="group" aria-label="Local-first or cloud-heavy plan">
            <button
              type="button"
              className={localFirst ? "preset-chip active" : "preset-chip"}
              aria-pressed={localFirst}
              onClick={() => setLocalFirst(true)}
            >
              Local-first
            </button>
            <button
              type="button"
              className={!localFirst ? "preset-chip active" : "preset-chip"}
              aria-pressed={!localFirst}
              onClick={() => setLocalFirst(false)}
            >
              Cloud-heavy
            </button>
          </div>
          <div className="rec-chain">
            <RecSlot role="Router" model={router} />
            <ArrowRight className="rec-arrow" size={16} />
            {localFirst ? (
              <>
                <RecSlot role="Workhorse" model={workhorse} />
                <ArrowRight className="rec-arrow" size={16} />
              </>
            ) : null}
            <RecSlot role="Vision (for Gallery)" model={visionPick} />
            <ArrowRight className="rec-arrow" size={16} />
            <RecSlot role="Embeddings (for Knowledge Banks)" model={embeddingsPick} />
            <ArrowRight className="rec-arrow" size={16} />
            <RecSlot role="Fallback" cloud="Sonnet 5" provider="claude" />
          </div>
          <p className="bench-summary">
            {localFirst
              ? `Matched to your ${gpu.label}. Local models handle fast / private work, vision, and embeddings; hard prompts escalate to a cloud fallback.`
              : `Matched to your ${gpu.label}. Only a router and embeddings model run locally — cloud models handle coding, planning, and vision.`}
          </p>
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
          <em className="bench-count">{visibleScored.filter((model) => model.fit !== "over").length} run here</em>
        </header>
        <div className="chip-row bench-role-filter" role="group" aria-label="Filter local models by role">
          {BENCHMARK_ROLE_FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={roleFilter === filter.key ? "preset-chip active" : "preset-chip"}
              aria-pressed={roleFilter === filter.key}
              onClick={() => setRoleFilter(filter.key)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="model-table">
          {visibleScored.map((model) => (
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
          Pulls the recommended models above straight from Ollama, with live progress. &ldquo;Use this setup&rdquo; already completes setup either way &mdash; installing just gets the models onto disk.
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
          {window.metisRegistry ? (
            <div className="install-rows">
              {recommendedSkillMatches.map(({ name, pkg }) => {
                const status = pkg ? skillStatus(pkg) : "unmatched";
                return (
                  <div key={name} className={`install-row ${status === "unmatched" ? "manual" : status}`}>
                    <span className="install-model">
                      <strong>{name}</strong>
                      <small>{pkg ? `${pkg.publisher} · v${pkg.version}` : "no matching registry package"}</small>
                    </span>
                    <span className="install-state">
                      {!pkg ? (
                        <small className="install-pending">Not in registry</small>
                      ) : status === "installed" ? (
                        <span className="install-installed">
                          <CheckCircle2 size={14} /> Installed
                        </span>
                      ) : status === "installing" ? (
                        <span className="install-progress">
                          <Loader2 size={13} className="spin" /> <small>installing</small>
                        </span>
                      ) : status === "failed" ? (
                        <span className="install-error">
                          <ShieldAlert size={13} /> Install failed
                          <button type="button" className="ghost-action install-retry" onClick={() => void installSkillPackage(pkg)}>
                            <RefreshCw size={12} /> Retry
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="ghost-action" onClick={() => void installSkillPackage(pkg)}>
                          <Download size={13} /> Install
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="chip-row">
              {RECOMMENDED_ONBOARDING_SKILLS.map((skill) => (
                <span key={skill} className="preset-chip">
                  {skill}
                </span>
              ))}
            </div>
          )}
          <p className="bench-note">
            {window.metisRegistry
              ? "“Install recommended setup” above also installs any matched skills; unmatched ones can be added from the Marketplace."
              : "Electron registry bridge unavailable in this preview — manage skill installs in the Marketplace."}
          </p>
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
  const label = model ? model.name : (cloud ?? "None fits this GPU");
  return (
    <span className={model || cloud ? "rec-slot" : "rec-slot rec-slot-empty"}>
      <small>{role}</small>
      <span className="rec-slot-main">
        <span className="model-logo">{logoProvider ? <img alt="" src={PROVIDERS[logoProvider].logo} /> : <Cpu size={15} />}</span>
        <strong>{label}</strong>
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
  // Same "visionModel" store key as the Library panel's picker (Palette, L12b above) — surfaced
  // here too (docs/DRILL_PLAN.md B2.1) so the model Analyze/Reanalyse actually use is editable
  // right where those actions live, without duplicating the setting itself.
  const [visionModel, setVisionModel] = useAppStoreState<string>("visionModel", DEFAULT_VISION_MODEL);
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
      sound.play("destructiveArm");
      window.setTimeout(() => setDeleteImageArmed(false), 3000);
      return;
    }
    sound.play("destructiveCommit");
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
      sound.play("destructiveArm");
      window.setTimeout(() => setDeleteBoardArmedId((current) => (current === board.id ? null : current)), 3000);
      return;
    }
    sound.play("destructiveCommit");
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
                <label className="gallery-vision-picker" title="Vision model used by Analyze board and Reanalyse. Same setting as the Library panel in Orchestration — changing it here changes it there too.">
                  Vision model
                  <CustomSelect ariaLabel="Vision model" value={visionModel} onChange={setVisionModel} options={VISION_MODEL_OPTIONS} />
                  <small>Auto-detect lets the backend pick; otherwise a specific local model is used.</small>
                </label>
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

/** Result of applying a marketplace preset package to Orchestration (docs/DRILL_PLAN.md
 *  Phase 4, "Preset install applies the orchestration"): whether the preset payload itself
 *  was written to PRESET_STORAGE_KEY, plus which prerequisite skills installed vs weren't found
 *  in the registry — surfaced together in the confirmation toast. */
type PresetApplyResult = { ok: boolean; message: string; installedSkills: string[]; missingSkills: string[] };

/** Fetches a preset package's `source_url` payload, normalises it to the shape GraphWorkspace's
 *  loadPreset() understands ({nodes} or {stages}), writes it to PRESET_STORAGE_KEY, and
 *  best-effort installs any `prerequisiteSkills` by matching names against the registry's skill
 *  packages (case-insensitive). Never re-seeds the registry — only installs packages that already
 *  exist in `allPackages`. Guards: no metisRegistry bridge (preview), bad fetch, bad JSON, and a
 *  payload with neither nodes nor stages. */
async function applyMarketplacePreset(item: RegistryPackage, allPackages: RegistryPackage[]): Promise<PresetApplyResult> {
  if (!window.metisRegistry) {
    return { ok: false, message: "Applying presets needs the desktop app; this preview has no registry bridge.", installedSkills: [], missingSkills: [] };
  }
  let raw: string;
  try {
    const response = await fetch(item.source_url);
    if (!response.ok) throw new Error(`fetch failed (${response.status})`);
    raw = await response.text();
  } catch (error) {
    return { ok: false, message: `Could not fetch the preset payload: ${error instanceof Error ? error.message : String(error)}`, installedSkills: [], missingSkills: [] };
  }
  let payload: MarketplacePresetPayload;
  try {
    payload = JSON.parse(raw) as MarketplacePresetPayload;
  } catch {
    return { ok: false, message: "Preset payload is not valid JSON.", installedSkills: [], missingSkills: [] };
  }
  const hasNodes = Array.isArray(payload.nodes) && payload.nodes.length > 0;
  const hasStages = Array.isArray(payload.stages) && payload.stages.length > 0;
  if (!hasNodes && !hasStages) {
    return { ok: false, message: "Preset payload has neither nodes nor stages to apply.", installedSkills: [], missingSkills: [] };
  }
  try {
    const stored = hasNodes ? { nodes: payload.nodes, saved_at: new Date().toISOString() } : { stages: payload.stages, saved_at: new Date().toISOString() };
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    return { ok: false, message: "Could not write the preset to local storage.", installedSkills: [], missingSkills: [] };
  }

  const installedSkills: string[] = [];
  const missingSkills: string[] = [];
  const prerequisites = Array.isArray(payload.prerequisiteSkills) ? payload.prerequisiteSkills : [];
  for (const name of prerequisites) {
    const match = allPackages.find((pkg) => pkg.kind === "skill" && pkg.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      missingSkills.push(name);
      continue;
    }
    try {
      await window.metisRegistry.install(match.id);
      installedSkills.push(match.name);
    } catch {
      missingSkills.push(name);
    }
  }

  const parts = ["Preset ready, opening Orchestration. Click Load preset to apply."];
  if (installedSkills.length) parts.push(`Installed skills: ${installedSkills.join(", ")}.`);
  if (missingSkills.length) parts.push(`Not found in registry: ${missingSkills.join(", ")}.`);
  return { ok: true, message: parts.join(" "), installedSkills, missingSkills };
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

function MarketplaceWorkspace({ onNavigate }: { onNavigate: (nav: NavKey) => void }): JSX.Element {
  const [state, setState] = useAppStoreState("marketplaceState", DEFAULT_MARKETPLACE_STATE);
  const [packages, setPackages] = useState<RegistryPackage[]>(FALLBACK_MARKETPLACE_PACKAGES);
  const [installedPackages, setInstalledPackages] = useState<RegistryPackage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  // Preset "Apply to Orchestration" state (docs/DRILL_PLAN.md Phase 4): keyed by package id so
  // the detail view (and, once installed, a card) can show a busy spinner and a result toast
  // per package without a modal.
  const [applyBusyId, setApplyBusyId] = useState<string | null>(null);
  const [applyResults, setApplyResults] = useState<Record<string, PresetApplyResult>>({});
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

  async function handleApplyPreset(item: RegistryPackage): Promise<void> {
    setApplyBusyId(item.id);
    const result = await applyMarketplacePreset(item, packages);
    setApplyResults((current) => ({ ...current, [item.id]: result }));
    setApplyBusyId(null);
    if (result.ok) {
      if (window.metisRegistry) void window.metisRegistry.listInstalled().then(setInstalledPackages).catch(() => undefined);
      onNavigate("orchestration");
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
        applyBusy={applyBusyId === selectedPackage.id}
        applyResult={applyResults[selectedPackage.id]}
        onApplyPreset={() => void handleApplyPreset(selectedPackage)}
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
  applyBusy,
  applyResult,
  busy,
  error,
  githubStats,
  installed,
  item,
  onApplyPreset,
  onBack,
  onToggleInstall,
  onToggleStar,
  readme,
  starred
}: {
  applyBusy: boolean;
  applyResult?: PresetApplyResult;
  busy: boolean;
  error?: string;
  githubStats: GithubRepoStats | null;
  installed: boolean;
  item: RegistryPackage;
  onApplyPreset: () => void;
  onBack: () => void;
  onToggleInstall: () => void;
  onToggleStar: () => void;
  readme: string | null;
  starred: boolean;
}): JSX.Element {
  const isPreset = displayKind(item.kind) === "preset";
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
          {isPreset ? (
            <button type="button" className="ghost-action marketplace-apply-preset" onClick={onApplyPreset} disabled={applyBusy || !window.metisRegistry}>
              {applyBusy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              Apply to Orchestration
            </button>
          ) : null}
        </div>
      </header>

      {isPreset && !window.metisRegistry ? (
        <small className="marketplace-card-error">Applying presets needs the desktop app; this preview has no registry bridge.</small>
      ) : null}

      {error ? <small className="marketplace-card-error">{error}</small> : null}

      {applyResult ? (
        <small className={applyResult.ok ? "marketplace-apply-success" : "marketplace-card-error"}>{applyResult.message}</small>
      ) : null}

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

function providerAccountId(): string {
  return `acct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  onDryRun,
  dryRunning,
  onEdit,
  onDelete,
  onOpenConversation,
  readOnly
}: {
  routine: Routine;
  now: number;
  onToggle: () => void;
  onRunNow: () => void;
  /** I9.4 dry run - plan-only preview of what this routine would do. */
  onDryRun: () => void;
  dryRunning?: boolean;
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
          <button type="button" onClick={onDryRun} disabled={dryRunning} title="Dry run - preview what this routine would do, plan-only, nothing written">
            {dryRunning ? <Loader2 size={14} className="spin" /> : <Eye size={14} />}
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

  // I9.4 dry run: plan-only preview in a FRESH conversation, routine record
  // untouched. On success, jump straight to the preview conversation so the
  // "what would it have done" answer is one click total.
  const [dryRunningId, setDryRunningId] = useState<string | null>(null);
  const [dryRunNote, setDryRunNote] = useState<string | null>(null);
  async function dryRun(id: string): Promise<void> {
    const dryRunFn = window.metisRoutines?.dryRun;
    if (!dryRunFn || dryRunningId) return;
    setDryRunningId(id);
    setDryRunNote(null);
    try {
      const result = await dryRunFn(id);
      if (result.ok && result.conversationId && onConversationOpen) {
        onConversationOpen(result.conversationId);
      } else if (!result.ok) {
        setDryRunNote(result.error ?? "Dry run failed.");
      } else {
        setDryRunNote("Dry run complete - see the newest conversation for the preview.");
      }
    } catch {
      setDryRunNote("Dry run failed.");
    } finally {
      setDryRunningId(null);
    }
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
            {dryRunNote ? <p className="field-hint">{dryRunNote}</p> : null}
            {routines.map((routine) => (
              <RoutineCard
                key={routine.id}
                routine={routine}
                now={now}
                readOnly={!hasBridge}
                onToggle={() => void toggleRoutine(routine)}
                onRunNow={() => void runNow(routine.id)}
                onDryRun={() => void dryRun(routine.id)}
                dryRunning={dryRunningId === routine.id}
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

/** Local extension of the shared `ManagerChatMessage` that also carries any actions the
 *  Manager proposed on that turn (docs/DRILL_PLAN.md Phase 3 M3 part 2). The proposals
 *  themselves persist with the message under the shared `managerChat` store key — they're
 *  small and worth keeping across reloads — but the per-card approve/dismiss UI state
 *  (ManagerActionCard) stays local component state and is never persisted. */
type ManagerChatEntry = ManagerChatMessage & { actions?: ManagerAction[] };

const EMPTY_MANAGER_CHAT: ManagerChatEntry[] = [];

/** Human label for a proposed action's approval card. Mirrors the wording the Manager's
 *  system prompt (main.ts managerSystemPrompt) was told to justify with `reason`, so the
 *  label plus reason read as one sentence. */
function managerActionLabel(action: ManagerAction): string {
  if (action.kind === "add_todo") {
    return `Add todo: "${action.title ?? ""}"`;
  }
  if (action.kind === "run_in_project") {
    const project = action.projectPath ? projectNameFromPath(action.projectPath) : "current project";
    const prompt = (action.prompt ?? "").trim();
    const shortPrompt = prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
    return `Run in ${project}: "${shortPrompt}"`;
  }
  return `Open ${action.view ?? "view"}`;
}

type ManagerActionCardStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string }
  | { kind: "dismissed" };

/** One proposed-action approval card under a Manager reply (docs/DRILL_PLAN.md Phase 3 M3
 *  part 2). Mirrors PermissionRequestCard's grammar: a slim accent-bordered row while
 *  pending a verdict, collapsing to a one-line resolved record afterward. Approve calls
 *  `metisManager.runAction`, which re-validates server-side — this card never runs anything
 *  on its own, and never auto-resolves. */
function ManagerActionCard({ action, onNavigate }: { action: ManagerAction; onNavigate: (nav: NavKey) => void }): JSX.Element {
  const [status, setStatus] = useState<ManagerActionCardStatus>({ kind: "idle" });
  const available = Boolean(window.metisManager);

  async function approve(): Promise<void> {
    if (!available) return;
    setStatus({ kind: "pending" });
    try {
      const result = await window.metisManager!.runAction(action);
      if (!result.ok) {
        setStatus({ kind: "error", message: result.error ?? "Action failed." });
        return;
      }
      if (action.kind === "add_todo") {
        setStatus({ kind: "done", message: "Added to your board." });
      } else if (action.kind === "open_view") {
        // A model-proposed open_view can still name a view that V1_HIDDEN_NAV
        // hides, because MANAGER_ACTION_VIEWS in main.ts predates the v1 cut and
        // validates against the full NavKey set. Refuse here rather than
        // navigating: the alternative is stranding the user on a surface with no
        // sidebar entry to leave by, and reporting "Opened Routines" for a view
        // that v1 does not have is a lie the approval card would be telling.
        const target = result.view as NavKey | undefined;
        if (target && !isNavVisible(target)) {
          setStatus({ kind: "error", message: `${target} is not available in this version.` });
        } else if (target) {
          onNavigate(target);
          setStatus({ kind: "done", message: `Opened ${result.view ?? action.view ?? "view"}.` });
        }
      } else {
        setStatus({ kind: "done", message: "Started a run." });
      }
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function dismiss(): void {
    setStatus({ kind: "dismissed" });
  }

  if (status.kind === "done" || status.kind === "dismissed") {
    return (
      <div className="manager-action-card resolved">
        <Check size={12} />
        <span>{status.kind === "dismissed" ? "Dismissed" : status.message}</span>
      </div>
    );
  }

  return (
    <div className="manager-action-card" role="group" aria-label="Proposed action">
      <div className="manager-action-card-body">
        <span className="manager-action-card-label">{managerActionLabel(action)}</span>
        {action.reason ? <span className="manager-action-card-reason">{action.reason}</span> : null}
        {status.kind === "error" ? <span className="manager-action-card-error">{status.message}</span> : null}
      </div>
      {available ? (
        <div className="manager-action-card-actions">
          <button type="button" onClick={() => void approve()} disabled={status.kind === "pending"}>
            {status.kind === "pending" ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
            Approve
          </button>
          <button type="button" className="dismiss" onClick={dismiss} disabled={status.kind === "pending"}>
            <X size={12} /> Dismiss
          </button>
        </div>
      ) : (
        <small className="manager-action-card-disabled">Approving needs the desktop app.</small>
      )}
    </div>
  );
}

/** The Manager tab's primary surface: a real chat with "Metis Manager", backed
 *  by the metis-manager:chat IPC (main.ts builds live project/todo context and
 *  calls the same provider-invocation machinery the main chat uses). Kept as
 *  its own component — not inlined into ManagerWorkspace — so a future
 *  floating widget (a separate round of work) can mount this exact component
 *  instead of duplicating the chat logic. Persists to the shared `managerChat`
 *  store key so the conversation survives navigation and app restarts.
 *  `onNavigate` lets an approved open_view action switch the app's active nav — both callers
 *  (the Manager tab and the floating widget) thread through their own navigation setter. */
function ManagerChat({ onNavigate }: { onNavigate: (nav: NavKey) => void }): JSX.Element {
  const [messages, setMessages] = useAppStoreState<ManagerChatEntry[]>("managerChat", EMPTY_MANAGER_CHAT);
  const [managerModel, setManagerModel] = useAppStoreState<ManagerModelChoice>("managerModel", DEFAULT_MANAGER_MODEL);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live-streaming reply text for the turn currently in flight
  // (docs/DRILL_PLAN.md Phase 8) — deliberately kept as local, unpersisted
  // state, unlike `messages` (which useAppStoreState writes to disk on every
  // change): accumulating token-by-token straight into `messages` would
  // thrash the store on every delta. Only the finalized turn gets appended to
  // `messages` once the stream completes. Stays null on the non-streaming
  // fallback path below, so that path's rendering is untouched.
  const [liveReply, setLiveReply] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const available = Boolean(window.metisManager);
  // Active stream's unsubscribe fn, so unmounting mid-stream can't leak the
  // onChatStreamEvent listener.
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending, liveReply]);

  useEffect(
    () => () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    },
    []
  );

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || sending || !available) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setDraft("");
    setSending(true);
    setError(null);

    const bridge = window.metisManager!;
    const canStream = typeof bridge.chatStream === "function" && typeof bridge.onChatStreamEvent === "function";
    if (!canStream) {
      // Fallback (older preload / preview build without the streaming
      // bridge): the original non-streaming path, unchanged.
      try {
        const result = await bridge.chat(next);
        if (result.reply || result.actions?.length) {
          setMessages((current) => [...current, { role: "assistant" as const, content: result.reply, actions: result.actions }]);
        }
        if (result.error) setError(result.error);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
      return;
    }

    // Streaming path: subscribe before calling chatStream so no early deltas
    // are missed, accumulate message_delta straight into the live bubble
    // (thought_delta is ignored — this chat surface has no thoughts panel),
    // then finalize from the awaited ManagerChatResult. main.ts's
    // runManagerChatStream never throws and always resolves with the exact
    // same result its "complete" event carries, so that resolved value alone
    // is authoritative here — the event subscription exists purely to paint
    // the reply as it streams in, mirroring the session feed's
    // liveAssistantText accumulation pattern.
    const streamId = `manager-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setLiveReply("");
    const unsubscribe = bridge.onChatStreamEvent((eventStreamId, event) => {
      if (eventStreamId !== streamId || event.kind !== "message_delta") return;
      setLiveReply((current) => `${current ?? ""}${event.delta}`);
    });
    unsubscribeRef.current = unsubscribe;
    try {
      const result = await bridge.chatStream(streamId, next);
      if (result.reply || result.actions?.length) {
        setMessages((current) => [...current, { role: "assistant" as const, content: result.reply, actions: result.actions }]);
      }
      if (result.error) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      unsubscribe();
      if (unsubscribeRef.current === unsubscribe) unsubscribeRef.current = null;
      setLiveReply(null);
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
        <div className="manager-chat-head-actions">
          <CustomSelect
            ariaLabel="Manager base model"
            className="manager-model-select"
            value={managerModelOptionValue(managerModel)}
            onChange={(value) => setManagerModel(managerModelFromOptionValue(value))}
            options={MANAGER_MODEL_OPTIONS}
          />
          <button type="button" className="ghost manager-chat-clear" onClick={clearChat} disabled={messages.length === 0 && !error}>
            <RotateCcw size={12} /> New chat
          </button>
        </div>
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
                  {message.content ? <Markdown>{message.content}</Markdown> : null}
                  {message.actions?.length ? (
                    <div className="manager-action-list">
                      {message.actions.map((action, actionIndex) => (
                        <ManagerActionCard key={actionIndex} action={action} onNavigate={onNavigate} />
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))
        )}
        {liveReply !== null ? (
          <div className="message-row assistant-message">
            <div className="manager-chat-reply">
              {liveReply.trim() ? (
                <Markdown>{liveReply}</Markdown>
              ) : (
                <span className="thinking-dots" aria-label="Manager is thinking">
                  <span />
                  <span />
                  <span />
                </span>
              )}
            </div>
          </div>
        ) : sending ? (
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

/** Top-left position of the closed-state Manager launcher (the small circular fab), persisted so it
 *  survives navigation and app restarts (see `managerFabPos` in useAppStoreState). Kept separate from
 *  ManagerWidgetPos/clampManagerWidgetPos because the fab is a small fixed-size circle, not the big
 *  resizable widget — reusing the widget's clamp would size the drag bounds wrong. */
type ManagerFabPos = { x: number; y: number };

const MANAGER_FAB_SIZE = 52;
const MANAGER_FAB_MARGIN = 16;
// Matches the fab's original fixed CSS corner (right: 24px, bottom: 24px) so switching to
// left/top positioning doesn't move it until the user actually drags it.
const MANAGER_FAB_CORNER_OFFSET = 24;
// Total pointer travel (px) before a press-and-hold on the fab becomes a drag instead of a click.
const MANAGER_FAB_DRAG_THRESHOLD = 5;

/** Keeps the fab fully on-screen no matter where it was last dragged to. */
function clampManagerFabPos(pos: ManagerFabPos): ManagerFabPos {
  const maxX = Math.max(MANAGER_FAB_MARGIN, window.innerWidth - MANAGER_FAB_SIZE - MANAGER_FAB_MARGIN);
  const maxY = Math.max(MANAGER_FAB_MARGIN, window.innerHeight - MANAGER_FAB_SIZE - MANAGER_FAB_MARGIN);
  return {
    x: Math.min(Math.max(pos.x, MANAGER_FAB_MARGIN), maxX),
    y: Math.min(Math.max(pos.y, MANAGER_FAB_MARGIN), maxY)
  };
}

/** Sensible resting anchor: bottom-right of the viewport, same corner as the old fixed CSS. */
function defaultManagerFabPos(): ManagerFabPos {
  return clampManagerFabPos({
    x: window.innerWidth - MANAGER_FAB_SIZE - MANAGER_FAB_CORNER_OFFSET,
    y: window.innerHeight - MANAGER_FAB_SIZE - MANAGER_FAB_CORNER_OFFSET
  });
}

/** App-level floating Manager chat: a draggable, minimizable widget that hosts the exact same
 *  <ManagerChat /> component the Manager tab uses, so both share the `managerChat` store key and
 *  history. Mounted once at the App root (outside the per-view <main> content) so it overlays every
 *  nav view. Its own open/minimized/position state persists via useAppStoreState so it survives
 *  navigation and app restarts (docs/FABLE_PLANS.md — floating widget round of work). Note the closed
 *  state (the small circular fab) has its own independent draggable position — see `managerFabPos`
 *  below — since it's a different-shaped launcher, not the widget itself. */
function ManagerWidget({ onNavigate }: { onNavigate: (nav: NavKey) => void }): JSX.Element {
  const [open, setOpen] = useAppStoreState<boolean>("managerWidgetOpen", false);
  const [minimized, setMinimized] = useAppStoreState<boolean>("managerWidgetMinimized", false);
  const [pos, setPos] = useAppStoreState<ManagerWidgetPos | null>("managerWidgetPos", null);
  const [size, setSize] = useAppStoreState<ManagerWidgetSize>("managerWidgetSize", DEFAULT_MANAGER_WIDGET_SIZE);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [fabPos, setFabPos] = useAppStoreState<ManagerFabPos | null>("managerFabPos", null);
  const [isFabDragging, setIsFabDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; startWidth: number; startHeight: number } | null>(null);
  const fabDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; dragged: boolean } | null>(null);
  // Set right before a completed drag's trailing native `click` event (pointer capture keeps the
  // button as that click's target no matter where the pointer ended up) so handleFabClick can
  // swallow just that one click instead of re-opening the widget after a drag.
  const fabJustDraggedRef = useRef(false);

  const resolvedPos = pos ?? defaultManagerWidgetPos(size);
  const resolvedFabPos = fabPos ?? defaultManagerFabPos();

  // Re-clamp on window resize so the widget never ends up stranded off-screen (e.g. after
  // shrinking the window while it was parked near a since-vanished edge).
  useEffect(() => {
    function handleResize(): void {
      setPos((current) => (current ? clampManagerWidgetPos(current, minimized, size) : current));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [minimized, size, setPos]);

  // Same re-clamp for the closed-state fab, sized for its own small fixed footprint.
  useEffect(() => {
    function handleFabResize(): void {
      setFabPos((current) => (current ? clampManagerFabPos(current) : current));
    }
    window.addEventListener("resize", handleFabResize);
    return () => window.removeEventListener("resize", handleFabResize);
  }, [setFabPos]);

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

  // Click-vs-drag: pointer down never opens the widget by itself. Only once movement crosses
  // MANAGER_FAB_DRAG_THRESHOLD does it become a drag (mirrors handleHeaderPointerDown/Move/endDrag
  // above); short of that threshold, pointer up resolves it as a plain click that opens the widget.
  function handleFabPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    const startPos = fabPos ?? defaultManagerFabPos();
    if (!fabPos) setFabPos(startPos);
    fabDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: startPos.x,
      originY: startPos.y,
      dragged: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleFabPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = fabDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragged) {
      if (Math.hypot(dx, dy) < MANAGER_FAB_DRAG_THRESHOLD) return;
      drag.dragged = true;
      setIsFabDragging(true);
    }
    setFabPos(clampManagerFabPos({ x: drag.originX + dx, y: drag.originY + dy }));
  }

  function endFabDrag(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = fabDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    fabDragRef.current = null;
    setIsFabDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.dragged) fabJustDraggedRef.current = true;
  }

  function handleFabClick(): void {
    // Suppress the native click that trails a completed drag; a real click (mouse click that never
    // crossed the threshold, or a keyboard Enter/Space activation, which never touches fabDragRef
    // at all) opens the widget as normal.
    if (fabJustDraggedRef.current) {
      fabJustDraggedRef.current = false;
      return;
    }
    setOpen(true);
  }

  if (!open) {
    return (
      <button
        type="button"
        className={`manager-fab ${isFabDragging ? "dragging" : ""}`}
        aria-label="Open Manager chat"
        style={{ left: resolvedFabPos.x, top: resolvedFabPos.y }}
        onPointerDown={handleFabPointerDown}
        onPointerMove={handleFabPointerMove}
        onPointerUp={endFabDrag}
        onPointerCancel={endFabDrag}
        onClick={handleFabClick}
      >
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
          <ManagerChat onNavigate={onNavigate} />
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
        <ManagerChat onNavigate={onNavigate} />

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

/** Coarse relative-time label for audit rows ("just now", "5m ago", "3h ago",
 *  "2d ago") — audit events are recent-window by nature so this stays coarse
 *  on purpose rather than pulling in a date-formatting dependency. */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/** Settings left-rail section keys — Claude-Code-specific tabs with no
 *  backing bridge (Profile, Configuration, Personalization, Browser, Computer
 *  use, Hooks, Git, Worktrees) were dropped; every section below renders real
 *  content wired to an existing store key or window bridge. */
type SettingsSection = "general" | "providers" | "appearance" | "chat" | "mcp" | "usage" | "privacy" | "audit" | "about";

const SETTINGS_NAV: Array<{ group: string; icon: JSX.Element; label: string; section: SettingsSection }> = [
  { group: "Personal", icon: <ShieldCheck size={15} />, label: "General", section: "general" },
  { group: "Personal", icon: <Sparkles size={15} />, label: "Appearance", section: "appearance" },
  { group: "Personal", icon: <MessageCircle size={15} />, label: "Chat", section: "chat" },
  { group: "Integrations", icon: <Cable size={15} />, label: "Providers", section: "providers" },
  { group: "Integrations", icon: <Plug size={15} />, label: "MCP servers", section: "mcp" },
  { group: "System", icon: <Gauge size={15} />, label: "Usage", section: "usage" },
  { group: "System", icon: <Shield size={15} />, label: "Privacy & Data", section: "privacy" },
  { group: "System", icon: <ScrollText size={15} />, label: "Audit", section: "audit" },
  { group: "System", icon: <HelpCircle size={15} />, label: "About", section: "about" }
];

/** Same v1 mechanism as V1_HIDDEN_NAV, for settings sections.
 *  mcp   - spawns arbitrary local stdio processes for installed servers; the
 *          mcpToolsEnabled flag underneath it already defaults off.
 *  usage - well built and honestly labelled, but it is a read-only report over
 *          data already being collected, so it costs nothing sitting hidden
 *          until its ring has an actual live-test checkmark. */
const V1_HIDDEN_SETTINGS = new Set<SettingsSection>(["mcp", "usage"]);

function isSettingsSectionVisible(section: SettingsSection): boolean {
  return !V1_HIDDEN_SETTINGS.has(section);
}

const SETTINGS_SECTION_META: Record<SettingsSection, { subtitle: string; title: string }> = {
  general: { title: "General", subtitle: "Runtime defaults, policy bridge, permissions, and marketplace registry." },
  providers: { title: "Providers", subtitle: "Provider-level API keys and health checks used by every route." },
  appearance: { title: "Appearance", subtitle: "Accent color, density, and text size — applied app-wide, not just here." },
  chat: { title: "Chat", subtitle: "Route ceremony verbosity, streaming, and self-verification for new runs." },
  mcp: { title: "MCP servers", subtitle: "Installed Model Context Protocol connections available to routes." },
  usage: { title: "Usage", subtitle: "Tokens, runs, and costs per provider, model, and route — measured locally from your own runs." },
  privacy: { title: "Privacy & Data", subtitle: "What gets stored locally, audit retention, and data controls." },
  audit: { title: "Audit", subtitle: "Recent events emitted by the policy bridge, permissions, and marketplace actions." },
  about: { title: "About", subtitle: "App version, update check, and project links." }
};

// Masks a Gateway bearer token for display (DRILL_PLAN P10.1) — keeps the
// first/last 4 characters as a recognizability anchor (so a user can confirm
// "yes, that's the token I copied earlier" without the full secret sitting in
// plain view) and replaces the middle with bullets. Short tokens (<=8 chars)
// mask entirely rather than risk exposing most of the string.
function maskGatewayToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}${"•".repeat(Math.max(token.length - 8, 4))}${token.slice(-4)}`;
}

/** The metisUsage.summary() resolution type, derived from the bridge typing
 *  so the Usage tab and the ring never drift from what preload declares. */
type UsageSummaryData = Awaited<ReturnType<NonNullable<Window["metisUsage"]>["summary"]>>;

// Stable module-level fallback for useAppStoreState("localCostConfig", ...) —
// see the EMPTY_CUSTOM_SKILLS comment for why inline object literals reset
// persisted values. 350W is a typical gaming-GPU draw under load; 0.30 $/kWh
// a plausible retail tariff. Both editable in the Usage tab.
const DEFAULT_LOCAL_COST_CONFIG: { watts: number; perKwh: number } = { watts: 350, perKwh: 0.3 };

/** Finds the $/Mtok pricing of the catalog route matching the SERVING
 *  provider + model id recorded on a ledger row (docs/DRILL_PLAN.md B12.2).
 *  Null when unknown - unknown never renders as $0, it renders as a dash. */
function usageRoutePricing(catalog: CatalogModel[], provider: string, model: string): { in: number; out: number } | null {
  for (const entry of catalog) {
    const route = (entry.access ?? []).find((candidate) => candidate.provider === provider && candidate.id === model);
    if (route?.pricing) return route.pricing;
  }
  return null;
}

/** Display-only cost estimate for one usage rollup row. Local (ollama) rows
 *  are honestly "Free"; rows with no known route pricing get a dash rather
 *  than a fake zero; estimated token counts get a ~ prefix. */
function usageCostLabel(catalog: CatalogModel[], row: { provider: string; model: string; inputTokens: number; outputTokens: number; estimated: boolean }): string {
  if (row.provider === "ollama") return "Free";
  const pricing = usageRoutePricing(catalog, row.provider, row.model);
  if (!pricing) return "—";
  const cost = (row.inputTokens * pricing.in + row.outputTokens * pricing.out) / 1_000_000;
  const prefix = row.estimated ? "~" : "";
  return cost >= 0.01 ? `${prefix}$${cost.toFixed(2)}` : `${prefix}<$0.01`;
}

function SettingsWorkspace({
  onBack,
  onOpenMcpMarketplace,
  initialSection,
  onInitialSectionConsumed,
  profile,
  onProfileChange
}: {
  onBack: () => void;
  onOpenMcpMarketplace: () => void;
  /** Deep-link target set by the first-run onboarding overlay's "Add a key
   *  now" step (docs/DRILL_PLAN.md B3.2b) — read once on mount only. */
  initialSection?: SettingsSection;
  /** Fires once, right after `initialSection` is applied, so the caller can
   *  reset its staged value back to "general" without racing the mount that
   *  needs to read it first. */
  onInitialSectionConsumed?: () => void;
  profile: UserProfile | null;
  onProfileChange: (patch: Partial<UserProfile>) => Promise<void>;
}): JSX.Element {
  const [section, setSection] = useState<SettingsSection>("general");
  useEffect(() => {
    if (initialSection && initialSection !== "general") {
      setSection(initialSection);
      onInitialSectionConsumed?.();
    }
    // Deliberately mount-only: initialSection is a one-shot deep-link value,
    // not something this view should keep resyncing to on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Settings > Profile (docs/DRILL_PLAN.md B3.2b step 4) — local draft so
  // typing doesn't round-trip through the bridge on every keystroke; commits
  // on blur. Resyncs if the underlying profile changes from elsewhere (e.g.
  // onboarding finishing while Settings happens to already be open).
  const [profileNameDraft, setProfileNameDraft] = useState(profile?.name ?? "");
  useEffect(() => {
    setProfileNameDraft(profile?.name ?? "");
  }, [profile?.name]);
  function commitProfileName(): void {
    const trimmed = profileNameDraft.trim();
    if (trimmed === (profile?.name ?? "")) return;
    void onProfileChange({ name: trimmed || undefined });
  }
  const [navQuery, setNavQuery] = useState("");
  const [rawSettings, setSettings] = useAppStoreState("settings", DEFAULT_SETTINGS);
  // Backfills fields added to AppSettings after a store blob was already
  // persisted on disk (useAppStoreState replaces wholesale, it doesn't deep-
  // merge) — without this, an existing install upgrading to this build would
  // see chatVerbosity/streamingEnabled render as an empty "Select" control.
  const settings = useMemo(() => ({ ...DEFAULT_SETTINGS, ...rawSettings }), [rawSettings]);
  // Key-pool accounts (docs/DRILL_PLAN.md Phase 6 §19) — same "providerAccounts" store
  // key main.ts's effectiveAccountsForProvider reads, so an add/remove here takes effect
  // on the next run without any dedicated bridge round trip.
  const [providerAccounts, setProviderAccounts] = useAppStoreState("providerAccounts", DEFAULT_PROVIDER_ACCOUNTS);
  const [rawAppearance, setAppearance] = useAppStoreState("appearance", DEFAULT_APPEARANCE);
  const appearance = useMemo(() => ({ ...DEFAULT_APPEARANCE, ...rawAppearance }), [rawAppearance]);
  // Settings > Appearance > Sound (docs/DRILL_PLAN.md B12.10). Same backfill
  // reasoning as `settings` above: `decorative` lands in commit 2 and must not
  // read as undefined on an install that persisted this key today.
  const [rawSoundSettings, setSoundSettings, soundSettingsLoaded] = useAppStoreState("soundSettings", DEFAULT_SOUND_SETTINGS);
  const soundSettings = useMemo<SoundSettings>(() => ({ ...DEFAULT_SOUND_SETTINGS, ...rawSoundSettings }), [rawSoundSettings]);
  const [soundTouched, setSoundTouched] = useAppStoreState(SOUND_TOUCHED_KEY, false);
  // "Is this done?" critic loop (docs/FABLE_PLANS.md §22) — a top-level store
  // key (not nested in AppSettings) since main.ts reads it directly by name.
  const [selfVerify, setSelfVerify] = useAppStoreState<"off" | "local" | "all">("selfVerify", "local");
  // Prompt-prewarm experiment (docs/DRILL_PLAN.md E1 v0.1b) — same store key
  // the chat composer's debounced warm effect reads; see the Experiments panel
  // in the "chat" settings section below. OFF by default.
  const [prewarmEnabled, setPrewarmEnabled] = useAppStoreState("prewarmEnabled", DEFAULT_PREWARM_ENABLED);
  // Model-driven routing experiment — same store key the main-process router
  // reads to decide chat-vs-build classification; see the Experiments panel
  // in the "chat" settings section below. OFF by default.
  const [modelDrivenRoutingEnabled, setModelDrivenRoutingEnabled] = useAppStoreState(
    "modelDrivenRoutingEnabled",
    DEFAULT_MODEL_DRIVEN_ROUTING_ENABLED
  );
  // Cloud Oracle opt-in (docs/DRILL_PLAN.md O5) — the PAID sibling of the
  // prewarm flag; main.ts double-gates on both keys plus a saved DeepSeek
  // key, so this toggle alone never spends anything. OFF by default.
  const [oracleCloudEnabled, setOracleCloudEnabled] = useAppStoreState("oracleCloudEnabled", false);
  // Oracle v0.4 similarity serving opt-in (docs/DRILL_PLAN.md B12.3) — lets a
  // near-miss send (cosmetic last edit) serve the draft, honestly labeled
  // with its similarity. OFF by default; needs nomic-embed-text locally.
  const [oracleSimilarityEnabled, setOracleSimilarityEnabled] = useAppStoreState("oracleSimilarityEnabled", false);
  // Global custom instructions (docs/DRILL_PLAN.md B12.1 Phase C, Lachy's
  // "system prompts like Claude Code" ask) — main.ts injects this string
  // into every prompt assembly next to the per-project METIS.md block.
  // Draft/save split so the store isn't written per keystroke.
  const [globalInstructions, setGlobalInstructions] = useAppStoreState("globalInstructions", "");
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);
  // Close-to-tray — same store key main.ts reads to decide whether closing the
  // window hides Metis in the tray instead of quitting. OFF by default.
  const [closeToTray, setCloseToTray] = useAppStoreState("closeToTray", DEFAULT_CLOSE_TO_TRAY);
  // Headless/service start (docs/DRILL_PLAN.md P10.5) — same store key main.ts
  // reads at app-ready to start minimized to tray. OFF by default.
  const [headlessStart, setHeadlessStart] = useAppStoreState("headlessStart", false);
  // Global quick-ask (docs/DRILL_PLAN.md B12.4) — main.ts registers the OS
  // hotkey at app-ready when this is on; v1 needs a restart to apply.
  const [quickAskEnabled, setQuickAskEnabled] = useAppStoreState("quickAskEnabled", false);
  // MCP tools in the chat pipeline (docs/DRILL_PLAN.md P10.2) — main.ts reads
  // this to decide whether installed MCP servers' tools are exposed to runs.
  // OFF by default.
  const [mcpToolsEnabled, setMcpToolsEnabled] = useAppStoreState("mcpToolsEnabled", false);
  const [agentToolsEnabled, setAgentToolsEnabled] = useAppStoreState("agentToolsEnabled", false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  // CORE.5 safety net surface: what the last generated write backed up, and
  // the undo. Arm-then-confirm, same pattern as the destructive controls
  // elsewhere, because reverting is itself a destructive act on newer work.
  type LastSnapshot = Awaited<ReturnType<NonNullable<NonNullable<Window["metisProject"]>["lastSnapshot"]>>>;
  const [lastSnapshot, setLastSnapshot] = useState<LastSnapshot>(null);
  const [revertArmed, setRevertArmed] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertNote, setRevertNote] = useState<string | null>(null);
  useEffect(() => {
    if (section !== "privacy") return;
    let alive = true;
    void window.metisProject?.lastSnapshot?.().then((snapshot) => {
      if (alive) setLastSnapshot(snapshot);
    });
    return () => {
      alive = false;
    };
  }, [section]);
  async function revertLastSnapshot(): Promise<void> {
    if (!revertArmed) {
      setRevertArmed(true);
      setRevertNote("This overwrites those files with the backup. Click again to confirm.");
      window.setTimeout(() => setRevertArmed(false), 5000);
      return;
    }
    setRevertArmed(false);
    setRevertBusy(true);
    try {
      const result = await window.metisProject?.revertSnapshot?.();
      if (result?.ok) {
        const created = result.createdNotDeleted ?? [];
        setRevertNote(
          `Restored ${result.restored?.length ?? 0} file(s).${created.length > 0 ? ` ${created.length} file(s) the run created were left in place: ${created.join(", ")}.` : ""}`
        );
      } else {
        setRevertNote(result?.error ?? "Revert failed.");
      }
    } finally {
      setRevertBusy(false);
    }
  }
  // --- Usage tab (docs/DRILL_PLAN.md B12.2/B12.7) ---
  // Summary comes from the local usage ledger via metisUsage; catalog is only
  // for per-route $/Mtok rates. Cost figures are DISPLAY estimates from list
  // prices, clearly marked, never billing.
  const [usageSummary, setUsageSummary] = useState<UsageSummaryData | null>(null);
  const [usageCatalog, setUsageCatalog] = useState<CatalogModel[]>([]);
  // Learned-router data faucet readout (docs/DRILL_PLAN.md B12.1 Phase A) —
  // shows THAT the preference log is filling and with what, honestly framed
  // as raw material: no learning happens yet.
  const [preferenceSummary, setPreferenceSummary] = useState<{ total: number; byKind: Record<string, number>; since: string | null; observations?: string[] } | null>(null);
  const [usageLimitDrafts, setUsageLimitDrafts] = useState<{ fourHour: string; weekly: string; wallet: string }>({ fourHour: "", weekly: "", wallet: "" });
  // Local electricity estimate config (B12.2 follow-up, Lachy: "maybe cost
  // for local models even? of course power bills vary, baha"). Rough by
  // design and labeled as such: GPU draw x generation wall-clock x tariff.
  const [localCostConfig, setLocalCostConfig] = useAppStoreState<{ watts: number; perKwh: number }>("localCostConfig", DEFAULT_LOCAL_COST_CONFIG);
  useEffect(() => {
    if (section !== "usage" || !window.metisUsage) return;
    let alive = true;
    void window.metisUsage.summary().then((summary) => {
      if (!alive) return;
      setUsageSummary(summary);
      setUsageLimitDrafts({
        fourHour: summary.limits.fourHourTokens ? String(summary.limits.fourHourTokens) : "",
        weekly: summary.limits.weeklyTokens ? String(summary.limits.weeklyTokens) : "",
        wallet: summary.limits.walletTokens ? String(summary.limits.walletTokens) : ""
      });
    });
    void window.metisCatalog
      ?.models()
      .then((state) => {
        if (alive) setUsageCatalog(state.models);
      })
      .catch(() => undefined);
    void window.metisPreference
      ?.summary()
      .then((summary) => {
        if (alive) setPreferenceSummary(summary);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [section]);
  async function saveUsageLimits(): Promise<void> {
    if (!window.metisUsage) return;
    const parse = (raw: string): number | undefined => {
      const value = Number(raw.replace(/[,\s]/g, ""));
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
    };
    const limits = await window.metisUsage.setLimits({
      fourHourTokens: parse(usageLimitDrafts.fourHour),
      weeklyTokens: parse(usageLimitDrafts.weekly),
      walletTokens: parse(usageLimitDrafts.wallet)
    });
    setUsageSummary((current) => (current ? { ...current, limits } : current));
  }
  const [updateBusy, setUpdateBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportResult, setExportResult] = useState<ConversationExportResult | null>(null);
  // Metis Gateway (DRILL_PLAN P10.1) — null means "not fetched yet" or "no
  // bridge" (this preview harness has no window.metisGateway); never a
  // fabricated status. gatewayTokenRevealed/gatewayTokenCopied are purely
  // local display state, not persisted anywhere.
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [gatewayTokenRevealed, setGatewayTokenRevealed] = useState(false);
  const [gatewayTokenCopied, setGatewayTokenCopied] = useState(false);
  const [policyStatus, setPolicyStatus] = useState<PolicyStatus>(FALLBACK_POLICY_STATUS);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [permissions, setPermissions] = useState<PermissionGrant[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  // Errors panel (docs/DRILL_PLAN.md Phase 8) — a wider recent-events window
  // than the main audit list, filtered client-side to error/warning so Lachy
  // has an in-app crash/last-errors view instead of opening audit-log.jsonl.
  const [errorEvents, setErrorEvents] = useState<AuditEvent[]>([]);
  const [errorsBusy, setErrorsBusy] = useState(false);
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);
  const [registry, setRegistry] = useState<RegistryState>(FALLBACK_REGISTRY);
  const [installedPackages, setInstalledPackages] = useState<RegistryPackage[]>([]);
  const [secretDrafts, setSecretDrafts] = useState<Partial<Record<ProviderKey, string>>>({});
  const [registryUrl, setRegistryUrl] = useState("");
  const [testPrompt, setTestPrompt] = useState("Summarise these notes into five bullets.");
  const [policyDecision, setPolicyDecision] = useState<PolicyDecisionResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mcpProbes, setMcpProbes] = useState<Record<string, { status: "loading" | "done"; result?: McpProbeResult }>>({});
  const secretMap = useMemo(() => new Map(secrets.map((secret) => [secret.provider, secret])), [secrets]);
  const installedIds = useMemo(() => new Set(installedPackages.map((item) => item.id)), [installedPackages]);
  const mcpPackages = useMemo(() => installedPackages.filter((item) => item.kind === "mcp"), [installedPackages]);
  const filteredNav = useMemo(() => {
    const query = navQuery.trim().toLowerCase();
    const shippable = SETTINGS_NAV.filter((item) => isSettingsSectionVisible(item.section));
    return query ? shippable.filter((item) => item.label.toLowerCase().includes(query)) : shippable;
  }, [navQuery]);
  const navGroups = useMemo(() => Array.from(new Set(filteredNav.map((item) => item.group))), [filteredNav]);

  const refreshRuntime = useCallback(async () => {
    const [nextPolicy, nextProviders, nextSecrets, nextPermissions, nextAudit, nextRegistry, nextInstalled, nextGateway] = await Promise.all([
      window.metisPolicy?.getStatus() ?? Promise.resolve(FALLBACK_POLICY_STATUS),
      window.metisProviders?.list() ?? Promise.resolve<ProviderStatus[]>([]),
      window.metisSecrets?.list() ?? Promise.resolve<SecretStatus[]>([]),
      window.metisPermissions?.list() ?? Promise.resolve<PermissionGrant[]>([]),
      window.metisAudit?.list(30) ?? Promise.resolve<AuditEvent[]>([]),
      window.metisRegistry?.list() ?? Promise.resolve(FALLBACK_REGISTRY),
      window.metisRegistry?.listInstalled() ?? Promise.resolve<RegistryPackage[]>([]),
      window.metisGateway?.getStatus() ?? Promise.resolve<GatewayStatus | null>(null)
    ]);
    setPolicyStatus(nextPolicy);
    setProviders(nextProviders);
    setSecrets(nextSecrets);
    setPermissions(nextPermissions);
    setAuditEvents(nextAudit);
    setRegistry(nextRegistry);
    setInstalledPackages(nextInstalled);
    setRegistryUrl(nextRegistry.sourceUrl.startsWith("http") ? nextRegistry.sourceUrl : "");
    setGatewayStatus(nextGateway);
  }, []);

  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  const refreshErrors = useCallback(async () => {
    setErrorsBusy(true);
    try {
      const recent = await (window.metisAudit?.list(100) ?? Promise.resolve<AuditEvent[]>([]));
      setErrorEvents(recent.filter((event) => event.level === "error" || event.level === "warning"));
    } finally {
      setErrorsBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshErrors();
  }, [refreshErrors]);

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

  // Same live-sync reasoning as applyAppearance above: the App() mount effect
  // seeds the engine on load, this keeps it honest while Settings is open so
  // the Preview button plays at the volume the slider is currently showing.
  // Gated on `loaded`: this hook's first render hands back the DEFAULT (silent)
  // settings until its own store read resolves, and pushing that into the
  // engine would switch sound OFF for a frame every time Settings mounts, even
  // though App()'s boot effect already seeded the real values.
  useEffect(() => {
    if (!soundSettingsLoaded) return;
    sound.setSettings(soundSettings);
  }, [soundSettings, soundSettingsLoaded]);

  function updateSoundSetting<K extends keyof SoundSettings>(key: K, value: SoundSettings[K]): void {
    setSoundTouched(true);
    setSoundSettings((current) => ({ ...DEFAULT_SOUND_SETTINGS, ...current, [key]: value }));
    // Pushed into the engine HERE as well as from the effect above, and that is
    // not a redundancy. The click router resolves a cue in the capture phase and
    // plays it a microtask later; React flushes this component's passive effects
    // on its own schedule, which may land either side of that microtask. Without
    // this synchronous push, clicking a sound toggle would sound or not sound
    // depending on React's internal timing - the effect stays for the boot and
    // store-rehydration paths, this line makes the toggles deterministic
    // (docs/DRILL_PLAN.md B12.10).
    sound.setSettings({ [key]: value } as Partial<SoundSettings>);
  }

  /** Preview plays the pair that carries the whole idea: a send, and the same
   *  figure slowed into its answer half a second later. */
  function previewSound(): void {
    sound.play("send");
    window.setTimeout(() => sound.play("runComplete"), 500);
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

  // Key-pool accounts have no secret bridge of their own yet — main.ts owns
  // providerAccounts as a bookkeeping list (label, cooldown, usedToday) and a
  // separate per-account secret store keyed by account id, but no renderer
  // bridge exposes writing that secret store (only the classic per-provider
  // metisSecrets). Adding an account here reserves a pool slot the owner can
  // wire a key into once that bridge lands; it never touches localStorage.
  function addProviderAccount(provider: ProviderKey): void {
    setProviderAccounts((current) => {
      const existingCount = current.filter((account) => account.provider === provider).length;
      const id = providerAccountId();
      // keyRef mirrors id (docs/DRILL_PLAN.md Phase 6 §19 / ProviderAccount comment in
      // runtime-contracts.ts): this account resolves against the per-account secret
      // store keyed by its own id, never the "provider-default" sentinel.
      const next: ProviderAccount = { id, provider, label: `Account ${existingCount + 2}`, keyRef: id };
      return [...current, next];
    });
  }

  function removeProviderAccount(id: string): void {
    setProviderAccounts((current) => current.filter((account) => account.id !== id));
  }

  function renameProviderAccount(id: string, label: string): void {
    setProviderAccounts((current) => current.map((account) => (account.id === id ? { ...account, label } : account)));
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

  async function testMcpConnection(id: string): Promise<void> {
    if (!window.metisMcp) return;
    setMcpProbes((current) => ({ ...current, [id]: { status: "loading" } }));
    const result = await window.metisMcp.probe(id);
    setMcpProbes((current) => ({ ...current, [id]: { status: "done", result } }));
  }

  async function exportAllConversations(): Promise<void> {
    if (!window.metisConversations) return;
    setExportBusy(true);
    setExportResult(null);
    try {
      const result = await window.metisConversations.exportMarkdown({});
      setExportResult(result);
    } finally {
      setExportBusy(false);
    }
  }

  // Gateway on/off toggle (DRILL_PLAN P10.1) — setEnabled starts/stops the
  // loopback server live, then getStatus refetches so the panel reflects the
  // actually-bound port/running state (setEnabled's own return would do, but
  // an explicit follow-up getStatus matches how every other toggle here
  // re-syncs via runBusy -> refreshRuntime rather than trusting a mutation's
  // own response as gospel).
  async function toggleGateway(enabled: boolean): Promise<void> {
    if (!window.metisGateway) return;
    await runBusy("gateway-toggle", async () => {
      await window.metisGateway?.setEnabled(enabled);
    });
  }

  function copyGatewayToken(): void {
    if (!gatewayStatus?.token) return;
    void navigator.clipboard?.writeText(gatewayStatus.token);
    setGatewayTokenCopied(true);
    window.setTimeout(() => setGatewayTokenCopied(false), 1400);
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
        <article className="settings-panel">
          <header>
            <span>
              <small>Profile</small>
              <h2>{profile?.name?.trim() || DEFAULT_PROFILE_NAME}</h2>
            </span>
            <span className="status-pill">{profile ? PLAN_LABELS[profile.plan] : PLAN_LABELS.byo}</span>
          </header>
          <p>Your local Metis profile. This isn&rsquo;t a server account, just a per-install identity kept on this machine. Change your name here anytime without redoing onboarding.</p>
          <label className="settings-field">
            <span>Your name</span>
            <input
              value={profileNameDraft}
              placeholder={DEFAULT_PROFILE_NAME}
              disabled={!window.metisProfile}
              onChange={(event) => setProfileNameDraft(event.target.value)}
              onBlur={commitProfileName}
            />
          </label>
          {!window.metisProfile ? <p className="settings-warning">Profile editing needs the desktop app; this preview has no profile bridge.</p> : null}
        </article>

        <article className="settings-panel">
          <header>
            <span>
              <small>Window</small>
              <h2>Close to tray</h2>
            </span>
          </header>
          <label className="settings-field toggle-field">
            <span>Close to tray</span>
            <button
              type="button"
              className={`toggle-switch ${closeToTray ? "on" : ""}`}
              role="switch"
              aria-checked={closeToTray}
              onClick={() => setCloseToTray(!closeToTray)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">Closing the window hides Metis in the tray instead of quitting.</p>
          <label className="settings-field toggle-field">
            <span>Start minimized to tray</span>
            <button
              type="button"
              className={`toggle-switch ${headlessStart ? "on" : ""}`}
              role="switch"
              aria-checked={headlessStart}
              onClick={() => setHeadlessStart(!headlessStart)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">Metis launches hidden in the tray, with the Gateway serving if enabled. Click the tray icon to open the window. Also available as a --headless launch flag.</p>
          <label className="settings-field toggle-field">
            <span>Global quick-ask (Ctrl+Alt+M)</span>
            <button
              type="button"
              className={`toggle-switch ${quickAskEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={quickAskEnabled}
              onClick={() => setQuickAskEnabled(!quickAskEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">Summon a small Metis prompt bar from anywhere in Windows. The answer routes through Metis and lands in your history like any chat. Takes effect after a restart.</p>
        </article>

        <article className="settings-panel">
          <header>
            <span>
              <small>Local API</small>
              <h2>Metis Gateway</h2>
            </span>
            {window.metisGateway && gatewayStatus ? (
              <span className={`status-pill ${gatewayStatus.running ? "ok" : "warn"}`}>{gatewayStatus.running ? "running" : "stopped"}</span>
            ) : null}
          </header>
          <p>Point any OpenAI-compatible app at this URL with the token to route through Metis.</p>
          {window.metisGateway && gatewayStatus ? (
            <>
              <label className="settings-field toggle-field">
                <span>Enable gateway</span>
                <button
                  type="button"
                  className={`toggle-switch ${gatewayStatus.enabled ? "on" : ""}`}
                  role="switch"
                  aria-checked={gatewayStatus.enabled}
                  disabled={busy === "gateway-toggle"}
                  onClick={() => void toggleGateway(!gatewayStatus.enabled)}
                >
                  <span className="toggle-knob" />
                </button>
              </label>
              <div className="settings-field">
                <span>Base URL</span>
                <code>{`http://127.0.0.1:${gatewayStatus.port}/v1`}</code>
              </div>
              <div className="settings-field">
                <span>Bearer token</span>
                <div className="gateway-token-row">
                  <code>{gatewayTokenRevealed ? gatewayStatus.token : maskGatewayToken(gatewayStatus.token)}</code>
                  <div className="settings-actions inline">
                    <button type="button" onClick={() => setGatewayTokenRevealed((revealed) => !revealed)}>
                      {gatewayTokenRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                      {gatewayTokenRevealed ? "Hide" : "Reveal"}
                    </button>
                    <button type="button" onClick={copyGatewayToken}>
                      {gatewayTokenCopied ? <Check size={14} /> : <Copy size={14} />}
                      {gatewayTokenCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              </div>
              {gatewayStatus.enabled && !gatewayStatus.running ? (
                <p className="settings-warning">Enabled but not running yet — try toggling it off and back on.</p>
              ) : null}
            </>
          ) : (
            <p className="settings-warning">Gateway control needs the desktop app; this preview has no gateway bridge.</p>
          )}
        </article>

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
          <button type="button" className="registry-count-line" onClick={onOpenMcpMarketplace}>
            {registry.packages.length} packages available, {installedIds.size} installed
          </button>
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
              const pool = providerAccounts.filter((account) => account.provider === provider);
              return (
                <div className="provider-group" key={provider}>
                  <div className="provider-row">
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
                  {provider !== "ollama" ? (
                    <div className="provider-pool">
                      <div className="provider-pool-header">
                        <small>
                          {pool.length === 0
                            ? "No extra keys. The key above is the only account."
                            : `${pool.length} extra ${pool.length === 1 ? "key" : "keys"} in the pool.`}
                          {" "}Extra keys rotate in automatically when one hits its quota.
                        </small>
                        <button type="button" className="ghost-action" onClick={() => addProviderAccount(provider)}>
                          <Plus size={13} />
                          Add key
                        </button>
                      </div>
                      {pool.length > 0 ? (
                        <div className="provider-pool-list">
                          {pool.map((account) => {
                            const now = Date.now();
                            const cooling = account.cooldownUntil && account.cooldownUntil > now;
                            return (
                              <div className="provider-pool-row" key={account.id}>
                                <input
                                  type="text"
                                  value={account.label ?? ""}
                                  placeholder="Label"
                                  onChange={(event) => renameProviderAccount(account.id, event.target.value)}
                                />
                                <span className="pool-key-indicator" title="No per-account key bridge yet. This slot is reserved for a future desktop update.">
                                  Key not linked
                                </span>
                                <span className={`pool-status ${cooling ? "cooling" : "available"}`}>
                                  {cooling ? `Cooling until ${new Date(account.cooldownUntil as number).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Available"}
                                </span>
                                {typeof account.usedToday === "number" ? <span className="pool-used">{account.usedToday} used today</span> : null}
                                <button type="button" className="ghost-action" onClick={() => removeProviderAccount(account.id)} title="Remove this pool slot">
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
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
        {/* Sound (docs/DRILL_PLAN.md B12.10) — one instrument, struck
            differently. Off until asked for. */}
        <article className="settings-panel">
          <header>
            <span>
              <small>Sound</small>
              <h2>Interface sound</h2>
            </span>
          </header>
          <label className="settings-field toggle-field">
            <span>Play sound</span>
            <button
              type="button"
              className={`toggle-switch ${soundSettings.enabled ? "on" : ""}`}
              role="switch"
              aria-checked={soundSettings.enabled}
              onClick={() => updateSoundSetting("enabled", !soundSettings.enabled)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">
            {prefersReducedMotion && !soundTouched
              ? "Off to start because your system asks for reduced motion. Turn it on anyway if you want it, and that choice sticks."
              : "One struck tone, tuned once, used for everything. Sound never gates an action, it only tells you one happened."}
          </p>
          {/* Sub-toggle: the decorative tier only exists while the master
              switch above is on, so it disables with it rather than sitting
              there implying it still does something (B12.10). */}
          <label className="settings-field toggle-field settings-field-nested">
            <span>Interface clicks and hover</span>
            <button
              type="button"
              className={`toggle-switch ${soundSettings.decorative ? "on" : ""}`}
              role="switch"
              aria-checked={soundSettings.decorative}
              disabled={!soundSettings.enabled}
              onClick={() => updateSoundSetting("decorative", !soundSettings.decorative)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint settings-hint-nested">
            Buttons, toggles and menus get a short tick. Hovering a control gets the contact sound with no note at all, rate limited so
            running down a long list will not chatter. Fields stay silent: nothing sounds while you are typing or dragging a slider.
          </p>
          <label className="settings-field">
            <span>Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={soundSettings.volume}
              disabled={!soundSettings.enabled}
              aria-label="Sound volume"
              onChange={(event) => updateSoundSetting("volume", Number(event.target.value))}
            />
          </label>
          <p className="settings-hint">What makes a sound: {SOUND_CUES.map((cue) => cue.label.toLowerCase()).join(", ")}.</p>
          <div className="settings-actions">
            <button type="button" disabled={!soundSettings.enabled} onClick={previewSound}>
              <Volume2 size={15} />
              Preview
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
        <article className="settings-panel">
          <header>
            <span>
              <small>Experiments</small>
              <h2>Prewarm local models as you type</h2>
            </span>
          </header>
          <label className="settings-field toggle-field">
            <span>Prewarm local models as you type (experimental)</span>
            <button
              type="button"
              className={`toggle-switch ${prewarmEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={prewarmEnabled}
              onClick={() => setPrewarmEnabled(!prewarmEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">Warms the local model with your draft for a faster first response. Local models only, and off by default.</p>
          <label className="settings-field toggle-field">
            <span>Model-driven routing (experimental)</span>
            <button
              type="button"
              className={`toggle-switch ${modelDrivenRoutingEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={modelDrivenRoutingEnabled}
              onClick={() => setModelDrivenRoutingEnabled(!modelDrivenRoutingEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">A fast local model classifies each prompt as chat or build instead of keyword rules. Falls back to the rules on any failure.</p>
          <label className="settings-field toggle-field">
            <span>Let models read your files (experimental)</span>
            <button
              type="button"
              className={`toggle-switch ${agentToolsEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={agentToolsEnabled}
              onClick={() => setAgentToolsEnabled(!agentToolsEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">
            Gives the model three tools against your attached project: read a file, list files, and make one exact-match edit. It looks at the real
            code instead of guessing, which is the difference between a correct edit and a plausible invented one. Secret-shaped files like
            <code> .env</code> are refused outright, every path is contained inside the project folder, and every write still goes through the
            snapshot safety net. There is deliberately no run-command tool.
          </p>
          <label className="settings-field toggle-field">
            <span>Cloud Oracle via DeepSeek (paid, experimental)</span>
            <button
              type="button"
              className={`toggle-switch ${oracleCloudEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={oracleCloudEnabled}
              onClick={() => setOracleCloudEnabled(!oracleCloudEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">
            When a DeepSeek model is pinned, Oracle drafts your answer through your own DeepSeek key while you pause typing. This sends your in-progress prompt to DeepSeek and costs tokens on every draft. Needs the prewarm toggle on and a saved DeepSeek key.
          </p>
          <label className="settings-field toggle-field">
            <span>Oracle near-match serving (experimental)</span>
            <button
              type="button"
              className={`toggle-switch ${oracleSimilarityEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={oracleSimilarityEnabled}
              onClick={() => setOracleSimilarityEnabled(!oracleSimilarityEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">
            If your final edit before sending was cosmetic (a typo fix, a please), Oracle serves the already-drafted answer instantly, labeled with its match percentage. Edits that change meaning (negations, numbers) always fall back to a real call. Needs nomic-embed-text pulled locally.
          </p>
        </article>
        <article className="settings-panel">
          <header>
            <span>
              <small>Instructions</small>
              <h2>Custom instructions</h2>
            </span>
          </header>
          <p className="settings-hint">Applied to every conversation and build, alongside any per-project METIS.md. Tone, stack preferences, things Metis should always know about you.</p>
          <textarea
            className="instructions-editor"
            rows={6}
            placeholder="e.g. Prefer TypeScript. Terse answers. Never use em dashes in copy."
            value={instructionsDraft ?? globalInstructions}
            onChange={(event) => setInstructionsDraft(event.target.value)}
          />
          <div className="panel-actions">
            <button
              type="button"
              disabled={instructionsDraft === null || instructionsDraft === globalInstructions}
              onClick={() => {
                if (instructionsDraft === null) return;
                setGlobalInstructions(instructionsDraft);
                setInstructionsDraft(null);
              }}
            >
              Save instructions
            </button>
            {instructionsDraft !== null && instructionsDraft !== globalInstructions ? <small className="mcp-probe-note">Unsaved changes</small> : null}
          </div>
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
          <label className="settings-field toggle-field">
            <span>Let runs use MCP tools (experimental)</span>
            <button
              type="button"
              className={`toggle-switch ${mcpToolsEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={mcpToolsEnabled}
              onClick={() => setMcpToolsEnabled(!mcpToolsEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </label>
          <p className="settings-hint">Exposes installed servers' tools to chat runs; every tool call shows in the run timeline. Off by default.</p>
          {mcpPackages.length === 0 ? (
            <p>No MCP servers installed — add one from the Marketplace.</p>
          ) : (
            <div className="registry-list">
              {mcpPackages.map((item) => {
                const probe = mcpProbes[item.id];
                return (
                  <div className="registry-row registry-row-detailed mcp-probe-row" key={item.id}>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.publisher} · v{item.version}</small>
                      {item.description ? <p className="registry-description">{item.description}</p> : null}
                      {item.source_url ? <code>{item.source_url}</code> : null}
                    </span>
                    <div className="mcp-probe-actions">
                      <button
                        type="button"
                        className="ghost-action"
                        disabled={!window.metisMcp || probe?.status === "loading"}
                        onClick={() => void testMcpConnection(item.id)}
                        title={!window.metisMcp ? "Requires the desktop app — unavailable in this preview" : "Spawn the server and list its tools"}
                      >
                        {probe?.status === "loading" ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
                        Test connection
                      </button>
                      {!window.metisMcp ? <small className="mcp-probe-note">Needs the desktop app</small> : null}
                      {probe?.status === "done" && probe.result ? (
                        probe.result.ok ? (
                          <div className="mcp-probe-result mcp-probe-ok">
                            <Check size={13} />
                            <span>{probe.result.tools?.length ?? 0} tools</span>
                            {probe.result.tools && probe.result.tools.length > 0 ? (
                              <ul className="mcp-probe-tools">
                                {probe.result.tools.map((tool) => (
                                  <li key={tool.name} title={tool.description ?? tool.name}>
                                    {tool.name}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        ) : (
                          <p className="mcp-probe-result mcp-probe-error">
                            <X size={13} /> {probe.result.error ?? "Connection failed"}
                          </p>
                        )
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!window.metisRegistry ? <p className="settings-warning">Electron registry bridge unavailable in this preview — showing local state only.</p> : null}
          {mcpPackages.length > 0 ? <p className="settings-hint">Servers that need credentials will fail "Test connection" until placeholder tokens in their config are filled in.</p> : null}
          <div className="settings-actions">
            <button type="button" onClick={onOpenMcpMarketplace}>
              <Plug size={15} />
              Add from Marketplace
            </button>
          </div>
        </article>
      </section>
      ) : null}

      {section === "usage" ? (
      <section className="settings-grid">
        <article className="settings-panel">
          <header>
            <span>
              <small>Windows</small>
              <h2>Recent usage</h2>
            </span>
            {usageSummary?.since ? <span className="status-pill">since {new Date(usageSummary.since).toLocaleDateString()}</span> : null}
          </header>
          {!window.metisUsage ? (
            <p>Usage metering needs the desktop app.</p>
          ) : !usageSummary ? (
            <p>Loading…</p>
          ) : (
            <div className="usage-windows">
              <div className="usage-window-card">
                <strong>{formatTokenCount(usageSummary.last4h.totalTokens)}</strong>
                <small>tokens · last 4 hours · {usageSummary.last4h.runs} runs</small>
                {usageSummary.limits.fourHourTokens ? (
                  <em>{Math.min(100, Math.round((usageSummary.last4h.totalTokens / usageSummary.limits.fourHourTokens) * 100))}% of your 4-hour limit</em>
                ) : null}
              </div>
              <div className="usage-window-card">
                <strong>{formatTokenCount(usageSummary.last7d.totalTokens)}</strong>
                <small>tokens · last 7 days · {usageSummary.last7d.runs} runs</small>
                {usageSummary.limits.weeklyTokens ? (
                  <em>{Math.min(100, Math.round((usageSummary.last7d.totalTokens / usageSummary.limits.weeklyTokens) * 100))}% of your weekly limit</em>
                ) : null}
              </div>
            </div>
          )}
        </article>

        <article className="settings-panel">
          <header>
            <span>
              <small>Limits</small>
              <h2>Usage limits</h2>
            </span>
          </header>
          <p className="settings-hint">Display-only for now: the ring by the composer and the meters above track these. Nothing is throttled yet. Leave a field empty for no limit.</p>
          <label className="settings-field">
            <span>4-hour window (tokens)</span>
            <input type="text" inputMode="numeric" placeholder="e.g. 500000" value={usageLimitDrafts.fourHour} onChange={(event) => setUsageLimitDrafts((current) => ({ ...current, fourHour: event.target.value }))} />
          </label>
          <label className="settings-field">
            <span>Weekly (tokens)</span>
            <input type="text" inputMode="numeric" placeholder="e.g. 5000000" value={usageLimitDrafts.weekly} onChange={(event) => setUsageLimitDrafts((current) => ({ ...current, weekly: event.target.value }))} />
          </label>
          <label className="settings-field">
            <span>Wallet top-up (tokens)</span>
            <input type="text" inputMode="numeric" placeholder="extra headroom beyond the window" value={usageLimitDrafts.wallet} onChange={(event) => setUsageLimitDrafts((current) => ({ ...current, wallet: event.target.value }))} />
          </label>
          <div className="panel-actions">
            <button type="button" disabled={!window.metisUsage} onClick={() => void saveUsageLimits()}>
              Save limits
            </button>
          </div>
        </article>

        <article className="settings-panel usage-tables-panel">
          <header>
            <span>
              <small>Breakdown</small>
              <h2>By provider and model</h2>
            </span>
          </header>
          <p className="settings-hint">Provider here is the route that actually served the call (your exact gateway use). Costs are estimates from catalog list prices; ~ marks estimated token counts; local is free.</p>
          {usageSummary && usageSummary.byProvider.length > 0 ? (
            <>
              <table className="usage-table">
                <thead>
                  <tr><th>Provider</th><th>Runs</th><th>In</th><th>Out</th></tr>
                </thead>
                <tbody>
                  {usageSummary.byProvider.map((row) => (
                    <tr key={row.provider}>
                      <td>{row.provider}</td>
                      <td>{row.runs}</td>
                      <td>{row.estimated ? "~" : ""}{formatTokenCount(row.inputTokens)}</td>
                      <td>{row.estimated ? "~" : ""}{formatTokenCount(row.outputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="usage-table">
                <thead>
                  <tr><th>Model</th><th>Route</th><th>Runs</th><th>Tokens</th><th>Cost</th></tr>
                </thead>
                <tbody>
                  {usageSummary.byModel.map((row) => (
                    <tr key={`${row.provider}|${row.model}`}>
                      <td className="usage-model-cell" title={row.model}>{row.model}</td>
                      <td>{row.provider}</td>
                      <td>{row.runs}</td>
                      <td>{row.estimated ? "~" : ""}{formatTokenCount(row.inputTokens + row.outputTokens)}</td>
                      <td>{usageCostLabel(usageCatalog, row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p>No metered runs yet — usage appears here as you use Metis.</p>
          )}
        </article>

        <article className="settings-panel">
          <header>
            <span>
              <small>Local</small>
              <h2>Local inference cost</h2>
            </span>
          </header>
          {(() => {
            const local7dMs = usageSummary?.localRuntime?.last7dMs ?? 0;
            const hours = local7dMs / 3_600_000;
            const cost = hours * (localCostConfig.watts / 1000) * localCostConfig.perKwh;
            return (
              <div className="usage-windows">
                <div className="usage-window-card">
                  <strong>{cost >= 0.01 ? `$${cost.toFixed(2)}` : local7dMs > 0 ? "<$0.01" : "$0.00"}</strong>
                  <small>
                    estimated electricity · last 7 days · {hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(local7dMs / 60000)}min`} of local generation
                  </small>
                  <em>Rough by design: GPU draw × generation time × your tariff. Sits nicely next to a cloud bill.</em>
                </div>
              </div>
            );
          })()}
          <label className="settings-field">
            <span>GPU draw under load (watts)</span>
            <input
              type="text"
              inputMode="numeric"
              value={String(localCostConfig.watts)}
              onChange={(event) => {
                const watts = Number(event.target.value);
                if (Number.isFinite(watts) && watts >= 0) setLocalCostConfig({ ...localCostConfig, watts });
              }}
            />
          </label>
          <label className="settings-field">
            <span>Electricity price ($ per kWh)</span>
            <input
              type="text"
              inputMode="decimal"
              value={String(localCostConfig.perKwh)}
              onChange={(event) => {
                const perKwh = Number(event.target.value);
                if (Number.isFinite(perKwh) && perKwh >= 0) setLocalCostConfig({ ...localCostConfig, perKwh });
              }}
            />
          </label>
          <p className="settings-hint">Only runs from this build onward carry timing data, so this starts counting now.</p>
        </article>

        <article className="settings-panel">
          <header>
            <span>
              <small>Learning</small>
              <h2>What Metis is noticing</h2>
            </span>
            {preferenceSummary ? <span className="status-pill">{preferenceSummary.total} signals</span> : null}
          </header>
          <p className="settings-hint">
            The raw material for the learned router: every run's model and route, plus explicit signals as they arrive. Nothing is acted on yet — routing only changes when the learning phase ships, and this data never leaves your machine.
          </p>
          {preferenceSummary?.observations && preferenceSummary.observations.length > 0 ? (
            <ul className="usage-observations">
              {preferenceSummary.observations.map((observation, index) => (
                <li key={index}>{observation}</li>
              ))}
            </ul>
          ) : null}
          {preferenceSummary && preferenceSummary.total > 0 ? (
            <table className="usage-table">
              <thead>
                <tr><th>Signal</th><th>Count</th></tr>
              </thead>
              <tbody>
                {Object.entries(preferenceSummary.byKind)
                  .sort((a, b) => b[1] - a[1])
                  .map(([kind, count]) => (
                    <tr key={kind}>
                      <td>{kind}</td>
                      <td>{count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <p>No signals recorded yet — they accumulate as you chat.</p>
          )}
        </article>
      </section>
      ) : null}

      {section === "privacy" ? (
      <section className="settings-grid">
        {/* Loops live here in v1, not in Routines. Routines is hidden by
            V1_HIDDEN_NAV, and a loop is the one thing in Metis that keeps
            working while nobody is watching - leaving its only surface behind a
            hidden nav item would mean an autonomous run with no way to see or
            stop it. Privacy & Data is the honest home anyway: it already
            answers "what has Metis done to my files, and how do I undo it." */}
        <ActiveLoopsPanel />
        <article className="settings-panel">
          <header>
            <span>
              <small>Safety net</small>
              <h2>Undo the last AI write</h2>
            </span>
          </header>
          <p className="settings-hint">
            Before Metis writes into a project it backs up every file it is about to change. If an edit went wrong, put those files back exactly as they were.
          </p>
          {!window.metisProject?.lastSnapshot ? (
            <p>Needs the desktop app.</p>
          ) : !lastSnapshot ? (
            <p>No AI writes yet. Once Metis edits a project, the backup shows here.</p>
          ) : (
            <>
              <div className="usage-window-card">
                <strong>
                  {lastSnapshot.entries.filter((entry) => !entry.createdByRun).length} file
                  {lastSnapshot.entries.filter((entry) => !entry.createdByRun).length === 1 ? "" : "s"} backed up
                </strong>
                <small>
                  {lastSnapshot.projectRoot.split(/[\\/]/).pop()} · {new Date(lastSnapshot.createdAt).toLocaleString()}
                </small>
                <em>
                  {lastSnapshot.entries.filter((entry) => entry.createdByRun).length > 0
                    ? `${lastSnapshot.entries.filter((entry) => entry.createdByRun).length} new file(s) were created and will NOT be deleted by a revert.`
                    : "Every file this run touched already existed, so a revert restores all of them."}
                  {lastSnapshot.gitRef ? ` A git snapshot was also recorded at ${lastSnapshot.gitRef}.` : ""}
                </em>
              </div>
              <div className="panel-actions">
                <button type="button" disabled={revertBusy} onClick={() => void revertLastSnapshot()}>
                  {revertBusy ? "Reverting…" : revertArmed ? "Confirm revert" : "Revert those files"}
                </button>
                {revertNote ? <small className="mcp-probe-note">{revertNote}</small> : null}
              </div>
            </>
          )}
        </article>
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
            <button type="button" onClick={() => setSection("audit")}>
              <ScrollText size={15} />
              View audit
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
          <p>Export writes every conversation to a Markdown file you choose. There's still no bridge for a full-data wipe — only per-conversation delete/archive (from each conversation's own menu) — so that stays disabled rather than fake a working action.</p>
          <div className="settings-actions">
            <button
              type="button"
              disabled={!window.metisConversations || exportBusy}
              title={!window.metisConversations ? "Requires the desktop app — unavailable in this preview" : "Export every conversation to Markdown"}
              onClick={() => void exportAllConversations()}
            >
              {exportBusy ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
              Export all conversations
            </button>
            <button type="button" disabled title="No wipe bridge available yet">
              <Trash2 size={15} />
              Wipe local data
            </button>
          </div>
          {!window.metisConversations ? <small className="mcp-probe-note">Needs the desktop app</small> : null}
          {exportResult ? (
            exportResult.ok ? (
              <p className="settings-hint">Exported to {exportResult.path}</p>
            ) : exportResult.cancelled ? null : (
              <p className="settings-warning">{exportResult.error ?? "Export failed"}</p>
            )
          ) : null}
        </article>
      </section>
      ) : null}

      {section === "audit" ? (
      <section className="settings-grid">
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

        <article className="settings-panel audit-panel">
          <header>
            <span>
              <small>Crash log</small>
              <h2>Errors</h2>
            </span>
            <span className="settings-actions inline">
              <button type="button" onClick={() => void refreshErrors()} disabled={errorsBusy}>
                {errorsBusy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                Refresh
              </button>
            </span>
          </header>
          <p>Errors and warnings pulled from the same audit log — a quick way to spot recent failures without opening audit-log.jsonl.</p>
          {!window.metisAudit ? (
            <small className="mcp-probe-note">Needs the desktop app — unavailable in this preview</small>
          ) : (
            <div className="audit-list">
              {errorEvents.length === 0 ? <p>No errors recorded.</p> : null}
              {errorEvents.slice(0, 15).map((event) => {
                const expanded = expandedErrorId === event.id;
                const hasMetadata = !!event.metadata && Object.keys(event.metadata).length > 0;
                return (
                  <div className={`audit-row ${event.level}`} key={event.id}>
                    <span>
                      <strong>{event.kind}</strong>
                      <small
                        className={hasMetadata ? "audit-error-summary clickable" : "audit-error-summary"}
                        title={event.summary}
                        onClick={hasMetadata ? () => setExpandedErrorId(expanded ? null : event.id) : undefined}
                      >
                        {event.summary.length > 140 && !expanded ? `${event.summary.slice(0, 140)}…` : event.summary}
                      </small>
                      {expanded && hasMetadata ? (
                        <pre className="audit-error-metadata">{JSON.stringify(event.metadata, null, 2)}</pre>
                      ) : null}
                    </span>
                    <em>{formatRelativeTime(event.createdAt)}</em>
                  </div>
                );
              })}
            </div>
          )}
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

/** Active loops surface (docs/LOOPS.md "Visibility and control").
 *  A loop runs when nobody is watching, so the one rule that matters here is
 *  that it can always be SEEN and always be killed in one click. Renders an
 *  explanatory empty state rather than nothing: /loop is a typed command with
 *  no button anywhere, so this panel is the only place in the app that says
 *  loops exist, and it cannot be how you discover the feature if it hides until
 *  you have already discovered it. */
function ActiveLoopsPanel(): JSX.Element | null {
  const hasBridge = typeof window !== "undefined" && Boolean(window.metisLoops);
  const [loops, setLoops] = useState<LoopRecord[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBridge) return;
    let cancelled = false;
    const pull = () => {
      void window.metisLoops?.list().then((next) => {
        if (!cancelled) setLoops(next);
      });
    };
    pull();
    // Faster than the routines poll: a loop can change state every minute, and
    // a stale "running" badge is exactly the kind of dishonest UI to avoid.
    const timer = window.setInterval(() => {
      setNow(Date.now());
      pull();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hasBridge]);

  async function stopLoop(id: string): Promise<void> {
    if (!window.metisLoops) return;
    setBusyId(id);
    try {
      // stop() returns the single updated record; re-list so a loop that
      // settled on its own during the same beat is not left showing stale.
      await window.metisLoops.stop(id, "stopped from the Loops panel");
      setLoops(await window.metisLoops.list());
    } finally {
      setBusyId(null);
    }
  }

  async function clearFinished(): Promise<void> {
    if (!window.metisLoops) return;
    const finished = loops.filter((loop) => loop.status !== "sleeping" && loop.status !== "running");
    let next = loops;
    for (const loop of finished) next = await window.metisLoops.delete(loop.id);
    setLoops(next);
  }

  if (!hasBridge) return null;

  // Renders even with nothing to show, unlike before. This panel is now the
  // only place in the app that explains loops exist, and the confirmation shown
  // after starting one sends people here by name: arriving to find literally
  // nothing would read as the loop having vanished. It also has to be
  // discoverable at all, since the entry point is a typed command with no
  // button anywhere.
  if (loops.length === 0) {
    return (
      <section className="loops-panel loops-panel-empty" aria-label="Loops">
        <header className="loops-panel-header">
          <div>
            <small>Nothing running</small>
            <h2>Loops</h2>
          </div>
        </header>
        <p className="settings-hint">
          A loop is a goal Metis works on across several turns, deciding after each one whether to keep going. Start one by typing{" "}
          <code>/loop</code> followed by the goal in a new session. It stops itself when the goal is met, and anything running shows up here with a
          Stop button.
        </p>
      </section>
    );
  }

  const live = loops.filter((loop) => loop.status === "sleeping" || loop.status === "running");
  const finished = loops.filter((loop) => loop.status !== "sleeping" && loop.status !== "running");

  return (
    <section className="loops-panel" aria-label="Active loops">
      <header className="loops-panel-header">
        <div>
          <small>Goals Metis is working on by itself, deciding each turn whether to keep going</small>
          <h2>Loops {live.length ? <span className="loops-live-count">{live.length} active</span> : null}</h2>
        </div>
        {finished.length ? (
          <button type="button" className="ghost" onClick={() => void clearFinished()}>
            Clear {finished.length} finished
          </button>
        ) : null}
      </header>

      <ul className="loops-list">
        {loops.map((loop) => {
          const wakeMs = loop.nextWakeAt ? new Date(loop.nextWakeAt).getTime() - now : 0;
          const isLive = loop.status === "sleeping" || loop.status === "running";
          return (
            <li key={loop.id} className={`loop-row loop-${loop.status}`}>
              <div className="loop-main">
                <span className={`loop-badge loop-badge-${loop.status}`}>{LOOP_STATUS_LABEL[loop.status] ?? loop.status}</span>
                <p className="loop-goal">{loop.goal}</p>
              </div>
              <div className="loop-meta">
                <span>
                  Iteration {loop.iterations} of {loop.maxIterations}
                </span>
                {loop.status === "sleeping" && loop.nextWakeAt ? (
                  <span>{wakeMs > 0 ? `wakes in ${formatLoopDelay(Math.round(wakeMs / 1000))}` : "waking now"}</span>
                ) : null}
                <span title="Frozen when the loop was created and never re-read from Settings">{loop.permissionMode} mode</span>
                {loop.budgetTokens ? (
                  <span title="Token ceiling across every iteration together — the loop stops as exhausted once its ledger-attributed spend reaches it">
                    {formatTokenCount(loop.budgetTokens)}-token budget
                  </span>
                ) : null}
                {loop.projectPath ? <span className="loop-project">{loop.projectPath}</span> : null}
              </div>
              {loop.capabilityWarning ? <p className="loop-warning">{loop.capabilityWarning}</p> : null}
              {loop.spawnedAgents?.length ? (
                // Phase 2 helpers: what ran unattended must be listed, with
                // the task on hover and how it ended at a glance.
                <div className="loop-helpers" aria-label="Helpers this loop ran">
                  {loop.spawnedAgents.map((agent) => (
                    <span
                      key={`${agent.name}-${agent.startedAt}`}
                      className={`loop-helper loop-helper-${agent.status}`}
                      title={agent.summary ? `${agent.task} — ${agent.summary}` : agent.task}
                    >
                      {agent.status === "running" ? <Loader2 size={10} className="spin" /> : agent.status === "failed" ? <X size={10} /> : <Check size={10} />}
                      {agent.name}
                    </span>
                  ))}
                </div>
              ) : null}
              {loop.lastReason && isLive ? <p className="loop-reason">“{loop.lastReason}”</p> : null}
              {loop.stoppedReason && !isLive ? <p className="loop-reason loop-reason-final">{loop.stoppedReason}</p> : null}
              {/* What it ACTUALLY did, turn by turn. Collapsed by default so a
                  row stays scannable, but present at all because the safety
                  story for this feature is that you can see what ran while you
                  were not watching, and "it did 4 turns" is not seeing. The
                  summaries are already on the record: the loop replays them into
                  each next prompt, so showing them costs nothing. */}
              {loop.history.length ? (
                <details className="loop-history">
                  <summary>
                    {loop.history.length} turn{loop.history.length === 1 ? "" : "s"} so far
                  </summary>
                  <ol>
                    {loop.history.map((entry) => (
                      <li key={entry.index} className={entry.error ? "loop-turn failed" : "loop-turn"}>
                        <span className={`loop-turn-badge loop-turn-${entry.decision}`}>
                          {entry.error ? "failed" : entry.decision === "silent" ? "no answer" : entry.decision}
                        </span>
                        <span className="loop-turn-text">{entry.error ?? entry.summary}</span>
                        {entry.reason && !entry.error ? <em className="loop-turn-reason">{entry.reason}</em> : null}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              {isLive ? (
                <button type="button" className="ghost danger" disabled={busyId === loop.id} onClick={() => void stopLoop(loop.id)}>
                  {busyId === loop.id ? "Stopping…" : "Stop"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Honest labels. "Exhausted" in particular must not read as success: the loop
 *  ran out of iterations, it did not necessarily finish the job. */
const LOOP_STATUS_LABEL: Record<string, string> = {
  running: "Working now",
  sleeping: "Waiting",
  stopped: "Stopped",
  exhausted: "Hit its limit",
  failed: "Failed"
};

function formatLoopDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 6) / 10}h`;
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
  onTest,
  onDepthRoutingChange
}: {
  node: GraphNode;
  /** Sets the GLOBAL depthRoutingEnabled flag through the canvas's own state,
   *  so the canvas and this panel cannot disagree about whether depths are live. */
  onDepthRoutingChange: (enabled: boolean) => void;
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

  // Gateways no longer live in this inspector (docs/DRILL_PLAN.md B11.3 v2):
  // a model's gateway config is global to the MODEL and edited by clicking
  // that model in the Library tab. This panel keeps only node concerns
  // (intent, primary model, depths, temperature, fallback chain, skills).

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
    // Gateways travel WITH their model (B11.3): the promoted slot's gateway
    // config becomes the node-level (primary) config, and the demoted primary
    // keeps its own config on its new fallback slot.
    const demoted: NodeModelSlot | null =
      provider && node.model ? { provider: node.provider as ProviderId, model: node.model, gateway: node.gateway, gatewayFallbacks: node.gatewayFallbacks } : null;
    const nextFallbacks = fallbacks.filter((_, i) => i !== index);
    onUpdate(node.id, {
      provider: ref.provider,
      model: ref.model,
      gateway: ref.gateway,
      gatewayFallbacks: ref.gatewayFallbacks,
      fallbacks: demoted ? [demoted, ...nextFallbacks] : nextFallbacks
    });
  }

  // --- Depths (DRILL_PLAN B11.2) ---
  // Which level's mini model picker is open (Lachy's sketch: click a level's
  // tile and a mini copy of the model library appears in this panel).
  const [depthPicking, setDepthPicking] = useState<"l1" | "l2" | "l3" | null>(null);

  // Depth mirroring now lives in the workspace's debounced nodes effect
  // (projectDepthRoutes, B11.6) so it also catches drag-and-drop primary
  // swaps - this panel only edits node state.

  function setDepthsEnabled(enabled: boolean): void {
    onUpdate(node.id, { depthsEnabled: enabled });
    // Routed through the SAME setter the canvas reads from, rather than writing
    // the store key directly. useAppStoreState has no change subscription, so an
    // out-of-band write left the canvas holding a stale value and every node
    // kept saying "depth routing is off" immediately after it was switched on.
    onDepthRoutingChange(enabled);
  }

  function setDepthModel(level: "l1" | "l2" | "l3", value: ModelRef | "router" | null): void {
    const models = { ...(node.depthModels ?? {}) };
    if (!value) {
      delete models[level];
    } else {
      models[level] = value;
    }
    onUpdate(node.id, { depthModels: models });
    setDepthPicking(null);
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

            <div className="field">
              <span>Depths</span>
              <label className="depths-enable">
                <input type="checkbox" checked={Boolean(node.depthsEnabled)} onChange={(event) => setDepthsEnabled(event.target.checked)} />
                Enable depth routing
              </label>
              <small className="depths-hint">
                The router judges how heavy each turn is and sends it to the matching level: trivial work stays cheap, deep work goes straight to your strongest model.
              </small>
              {node.depthsEnabled ? (
                depthPicking ? (
                  <div className="depth-mini-picker">
                    <div className="depth-mini-head">
                      <button type="button" className="inspector-back" onClick={() => setDepthPicking(null)}>
                        <ChevronLeft size={14} /> Levels
                      </button>
                      <strong>{depthPicking.toUpperCase()} model</strong>
                    </div>
                    <div className="depth-mini-list">
                      <button type="button" className="depth-mini-row" onClick={() => setDepthModel(depthPicking, "router")}>
                        <span className="depth-level-tile">
                          <Waypoints size={18} />
                        </span>
                        <span className="depth-mini-text">
                          <strong>Router</strong>
                          <small>The router handles this level itself, no re-route</small>
                        </span>
                      </button>
                      <button type="button" className="depth-mini-row" onClick={() => setDepthModel(depthPicking, null)}>
                        <span className="depth-level-tile empty" />
                        <span className="depth-mini-text">
                          <strong>Default</strong>
                          <small>{depthPicking === "l3" ? "This node's own model (your base)" : "Use this level's built-in default"}</small>
                        </span>
                      </button>
                      {MODEL_LIBRARY.map((ref) => (
                        <button type="button" className="depth-mini-row" key={`${ref.provider}|${ref.model}`} onClick={() => setDepthModel(depthPicking, ref)}>
                          <span className="depth-level-tile">
                            <img alt="" src={PROVIDERS[ref.provider].logo} />
                          </span>
                          <span className="depth-mini-text">
                            <strong>{ref.model}</strong>
                            <small>
                              {PROVIDERS[ref.provider].label}
                              {PROVIDERS[ref.provider].tier === "local" ? " · local" : ""}
                            </small>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="depth-stack">
                    {([
                      { level: "l3" as const, badge: "L3", fallback: "Strongest cloud (default)" },
                      { level: "l2" as const, badge: "L2", fallback: "Auto (policy route)" },
                      { level: "l1" as const, badge: "L1", fallback: "Local model (default)" }
                    ]).map(({ level, badge, fallback }) => {
                      const chosen = node.depthModels?.[level];
                      // L3 defaults to the node's OWN model (B11.6, Lachy:
                      // whatever you drag and drop onto the node is your L3
                      // by default) - an explicit pick still wins.
                      const baseDefault = level === "l3" && !chosen && node.provider && node.model ? { provider: node.provider, model: node.model } : null;
                      const shown = chosen ?? baseDefault ?? null;
                      return (
                        <button type="button" className="depth-level-row" key={level} onClick={() => setDepthPicking(level)} aria-label={`Choose ${badge} model`}>
                          <span className="depth-level-badge">{badge}</span>
                          <span className={shown ? "depth-level-tile" : "depth-level-tile empty"}>
                            {shown === "router" ? <Waypoints size={18} /> : shown ? <img alt="" src={PROVIDERS[shown.provider].logo} /> : null}
                          </span>
                          <span className={chosen ? "depth-level-name" : "depth-level-name muted"}>
                            {shown === "router" ? "Router" : baseDefault ? `${baseDefault.model} · base` : shown ? shown.model : fallback}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )
              ) : null}
            </div>

            {node.provider ? (
              <p className="field-hint">Gateways are set per model now: click a model in the Library tab to choose where its calls route.</p>
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

/** Side-panel gateway editor for ONE model (docs/DRILL_PLAN.md B11.3 v2):
 *  opened by a clean CLICK on that model in the Library tab (dragging still
 *  assigns it to a node). Edits the global modelGateways store entry for the
 *  model, so the config applies wherever the model appears in the graph -
 *  gateways are a property of the model itself, not of any node. */
function ModelGatewayInspector({
  modelRef,
  config,
  onClose,
  onChange
}: {
  modelRef: ModelRef;
  config: ModelGatewayConfig;
  onClose: () => void;
  onChange: (next: ModelGatewayConfig) => void;
}): JSX.Element {
  const provider = PROVIDERS[modelRef.provider];

  // The model catalog knows every route (provider) this model is reachable
  // through; fetched here so the picker offers only routes that actually
  // apply. Guarded for browser preview / no catalog yet.
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

  // Every catalog access route for THIS model (B11.1's brand-aware lookup),
  // falling back to just its home provider for custom/unknown models.
  const gatewayOptions = useMemo((): ProviderId[] => {
    const catalogEntry = findCatalogModelEntry(catalogModels, modelRef);
    const routes = catalogEntry?.access ?? [];
    const brands = routes.map((route) => ROUTE_PROVIDER_TO_BRAND[route.provider]).filter((brand): brand is ProviderId => Boolean(brand));
    const distinct = Array.from(new Set(brands));
    if (distinct.length > 0) return distinct;
    return [modelRef.provider];
  }, [catalogModels, modelRef.provider, modelRef.model]);

  const gatewayFallbacks = config.gatewayFallbacks ?? [];

  const modelFallbacks = config.fallbacks ?? [];
  /** Every other model in the library, minus this one and anything already in
   *  the chain. Offering the model itself would let a chain loop back to the
   *  thing that just failed. */
  const modelFallbackChoices = MODEL_LIBRARY.filter(
    (entry) =>
      !(entry.provider === modelRef.provider && entry.model === modelRef.model) &&
      !modelFallbacks.some((ref) => ref.provider === entry.provider && ref.model === entry.model)
  ).map((entry) => ({ provider: entry.provider, model: entry.model }));

  function addModelFallback(ref: ModelRef): void {
    onChange({ ...config, fallbacks: [...modelFallbacks, ref] });
  }

  function removeModelFallback(index: number): void {
    onChange({ ...config, fallbacks: modelFallbacks.filter((_, i) => i !== index) });
  }

  /** Reorders within the chain rather than promoting to primary, unlike the
   *  gateway list above. A model fallback has nowhere to be promoted TO: the
   *  primary is whichever model you opened this panel for. */
  function moveModelFallback(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= modelFallbacks.length) return;
    const next = [...modelFallbacks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...config, fallbacks: next });
  }
  const gatewayFallbackChoices = gatewayOptions.filter((brand) => brand !== config.gateway);

  function setGateway(value: ProviderId | ""): void {
    const nextGateway = value || undefined;
    onChange({
      gateway: nextGateway,
      gatewayFallbacks: gatewayFallbacks.filter((brand) => brand !== nextGateway)
    });
  }

  function addGatewayFallback(brand: ProviderId): void {
    if (gatewayFallbacks.includes(brand)) return;
    onChange({ ...config, gatewayFallbacks: [...gatewayFallbacks, brand] });
  }

  function removeGatewayFallback(index: number): void {
    onChange({ ...config, gatewayFallbacks: gatewayFallbacks.filter((_, i) => i !== index) });
  }

  function promoteGatewayFallback(index: number): void {
    const brand = gatewayFallbacks[index];
    const demoted = config.gateway;
    const nextFallbacks = gatewayFallbacks.filter((_, i) => i !== index);
    onChange({ gateway: brand, gatewayFallbacks: demoted ? [demoted, ...nextFallbacks] : nextFallbacks });
  }

  return (
    <aside className="palette inspector" aria-label={`${modelRef.model} gateways`}>
      <header className="inspector-head">
        <button type="button" className="inspector-back" onClick={onClose}>
          <ChevronLeft size={15} /> Library
        </button>
      </header>

      <div className="inspector-title">
        <span className="node-icon logo compact">
          <img alt="" src={provider.logo} />
        </span>
        <span className="model-inspect-name">
          <strong>{modelRef.model}</strong>
          <small>
            {provider.label}
            {provider.tier === "local" ? " · local" : ""}
          </small>
        </span>
      </div>

      <div className="inspector-body">
        <p className="field-hint">This model routes through these gateways everywhere it appears in your orchestration.</p>

        <label className="field">
          <span>Gateway</span>
          <CustomSelect
            ariaLabel="Gateway"
            value={config.gateway ?? ""}
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

        <div className="field">
          <span>Model fallbacks · other models to try if this one is unreachable</span>
          <p className="field-hint">
            Different from gateway fallbacks above: those are other routes to <strong>{modelRef.model}</strong>, these are other models entirely.
            Set here rather than on a node, so every node using {modelRef.model} inherits the same chain.
          </p>
          <ol className="fallback-list">
            {modelFallbacks.length === 0 ? <li className="fallback-empty">No model fallbacks yet</li> : null}
            {modelFallbacks.map((ref, index) => (
              <li className="fallback-row" key={`${ref.provider}-${ref.model}-${index}`}>
                <span className="fallback-rank">{index + 1}</span>
                <span className="palette-icon logo small">
                  <img alt="" src={PROVIDERS[ref.provider].logo} />
                </span>
                <span className="fallback-name">{ref.model}</span>
                <button
                  type="button"
                  aria-label={`Move ${ref.model} earlier`}
                  title="Try this sooner"
                  disabled={index === 0}
                  onClick={() => moveModelFallback(index, -1)}
                >
                  <ChevronUp size={14} />
                </button>
                <button type="button" aria-label={`Remove ${ref.model}`} title="Remove" onClick={() => removeModelFallback(index)}>
                  <X size={14} />
                </button>
              </li>
            ))}
          </ol>
          <div className="fallback-picker" aria-label="Add model fallback">
            {modelFallbackChoices.map((ref) => (
              <button
                key={`${ref.provider}-${ref.model}`}
                type="button"
                className="fallback-option"
                onClick={() => addModelFallback(ref)}
              >
                <span className="palette-icon logo small">
                  <img alt="" src={PROVIDERS[ref.provider].logo} />
                </span>
                <span>
                  <strong>{ref.model}</strong>
                  <em>{PROVIDERS[ref.provider].label}</em>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
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
