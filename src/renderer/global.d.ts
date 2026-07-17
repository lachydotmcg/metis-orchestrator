import type { RouteDecision } from "../shared/policy-contract";
import type {
  AuditEvent,
  CatalogModel,
  ConversationExportResult,
  ConversationRecord,
  GatewayStatus,
  LabExperimentResult,
  ManagerAction,
  ManagerActionResult,
  ManagerChatMessage,
  ManagerChatResult,
  ManagerChatStreamEvent,
  MetisFileReadResult,
  MetisFileWriteResult,
  McpProbeResult,
  ImageImportResult,
  ModelCatalogState,
  OllamaListResult,
  OllamaPullProgress,
  PermissionGrant,
  PermissionRequest,
  PermissionVerdict,
  PolicyDecisionInput,
  PolicyDecisionResult,
  PolicyStatus,
  ProviderInvokeInput,
  ProviderInvokeResult,
  ProviderKey,
  ProviderStatus,
  ProjectSnapshot,
  ProjectWorkspace,
  ProjectWorkspaceResource,
  ProjectWorkspaceSelectionResult,
  PulseFeed,
  RegistryPackage,
  RegistryState,
  Routine,
  SessionDirective,
  SessionRun,
  SessionRunInput,
  SessionStreamEvent,
  SecretStatus,
  StyleCard,
  UpdateCheckResult,
  UserProfile,
  UserQuestionAnswer
} from "../shared/runtime-contracts";

declare global {
  interface Window {
    metisPolicy?: {
      getSampleDecision: () => Promise<RouteDecision>;
      getStatus: (profilePath?: string) => Promise<PolicyStatus>;
      decide: (input: PolicyDecisionInput) => Promise<PolicyDecisionResult>;
    };
    metisStore?: {
      get: <T>(key: string, fallback: T) => Promise<T>;
      set: <T>(key: string, value: T) => Promise<void>;
    };
    metisShell?: {
      openExternal: (url: string) => Promise<void>;
      openPath: (path: string) => Promise<void>;
    };
    metisWindow?: {
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
    };
    metisSession?: {
      run: (input: SessionRunInput) => Promise<SessionRun>;
      runStream: (input: SessionRunInput, onEvent: (event: SessionStreamEvent) => void) => Promise<SessionRun>;
      list: () => Promise<SessionRun[]>;
      cancel: (projectPath?: string) => void;
      // Widened to accept string[] additively (DRILL_PLAN B2.3a multi-question
      // popup follow-up) — passing a single string still works unchanged.
      answerQuestion: (id: string, answer: UserQuestionAnswer) => void;
    };
    metisBus?: {
      post: (input: { projectPath?: string; conversationId?: string; text: string }) => Promise<SessionDirective>;
      list: (projectPath?: string) => Promise<SessionDirective[]>;
    };
    metisConversations?: {
      list: () => Promise<ConversationRecord[]>;
      create: (projectPath?: string, firstPrompt?: string) => Promise<ConversationRecord>;
      delete: (id: string) => Promise<ConversationRecord[]>;
      deleteProject: (projectPath?: string) => Promise<ConversationRecord[]>;
      rename: (id: string, title: string) => Promise<ConversationRecord[]>;
      archive: (id: string, archived: boolean) => Promise<ConversationRecord[]>;
      exportMarkdown: (input?: { conversationId?: string }) => Promise<ConversationExportResult>;
      // DRILL_PLAN I9.5 — fork a conversation (all turns, or up to and
      // including the turn carrying uptoRunId). Optional: older preloads.
      fork?: (id: string, uptoRunId?: string) => Promise<ConversationRecord | null>;
    };
    metisLab?: {
      runExperiment: (prompt?: string) => Promise<LabExperimentResult>;
    };
    metisProfile?: {
      get: () => Promise<UserProfile>;
      set: (patch: Partial<UserProfile>) => Promise<UserProfile>;
    };
    metisProject?: {
      getWorkspace: () => Promise<ProjectWorkspace | null>;
      snapshot: () => Promise<ProjectSnapshot | null>;
      selectFolder: () => Promise<ProjectWorkspaceSelectionResult>;
      clearWorkspace: () => Promise<void>;
      listResources: () => Promise<ProjectWorkspaceResource[]>;
      addFiles: () => Promise<ProjectWorkspaceResource[]>;
      addFolder: () => Promise<ProjectWorkspaceResource[]>;
      removeResource: (id: string) => Promise<ProjectWorkspaceResource[]>;
    };
    metisFiles?: {
      read: (path: string) => Promise<MetisFileReadResult>;
      write: (path: string, content: string) => Promise<MetisFileWriteResult>;
    };
    metisSecrets?: {
      list: () => Promise<SecretStatus[]>;
      set: (provider: ProviderKey, value: string) => Promise<SecretStatus>;
      delete: (provider: ProviderKey) => Promise<void>;
    };
    metisPermissions?: {
      list: () => Promise<PermissionGrant[]>;
      request: (request: PermissionRequest) => Promise<PermissionGrant>;
      revoke: (id: string) => Promise<void>;
      respond: (id: string, verdict: PermissionVerdict) => void;
    };
    metisAudit?: {
      list: (limit?: number) => Promise<AuditEvent[]>;
    };
    metisProviders?: {
      list: () => Promise<ProviderStatus[]>;
      healthCheck: (provider: ProviderKey) => Promise<ProviderStatus>;
      invoke: (input: ProviderInvokeInput) => Promise<ProviderInvokeResult>;
    };
    metisRegistry?: {
      list: () => Promise<RegistryState>;
      refresh: (sourceUrl?: string) => Promise<RegistryState>;
      listInstalled: () => Promise<RegistryPackage[]>;
      install: (id: string) => Promise<RegistryPackage[]>;
      uninstall: (id: string) => Promise<RegistryPackage[]>;
    };
    metisMcp?: {
      probe: (id: string) => Promise<McpProbeResult>;
    };
    metisCatalog?: {
      models: () => Promise<ModelCatalogState>;
    };
    metisPulse?: {
      feed: () => Promise<PulseFeed>;
    };
    // DRILL_PLAN B12.2/B12.7 — usage metering (Usage tab in Settings) +
    // usage limits (the ring). Shapes are declared inline here rather than
    // in shared/runtime-contracts.ts since this bridge is metering-only and
    // has no SessionRun-side counterpart to share a type with. Display-only
    // in this pass: setLimits persists the numbers, main.ts does not yet
    // throttle or warn against them.
    metisUsage?: {
      summary: () => Promise<{
        byProvider: Array<{
          provider: string;
          runs: number;
          inputTokens: number;
          outputTokens: number;
          estimated: boolean;
        }>;
        byModel: Array<{
          provider: string;
          model: string;
          runs: number;
          inputTokens: number;
          outputTokens: number;
          estimated: boolean;
        }>;
        last4h: { runs: number; totalTokens: number };
        last7d: { runs: number; totalTokens: number };
        limits: { fourHourTokens?: number; weeklyTokens?: number; walletTokens?: number };
        since: string | null;
      }>;
      setLimits: (patch: {
        fourHourTokens?: number;
        weeklyTokens?: number;
        walletTokens?: number;
      }) => Promise<{ fourHourTokens?: number; weeklyTokens?: number; walletTokens?: number }>;
    };
    // DRILL_PLAN B12.1 Phase A — learned-router preference log. Raw signal
    // capture only in this pass: no learning/routing changes read this data
    // yet. Shapes are declared inline here (no SessionRun-side counterpart to
    // share a type with), same as metisUsage above. Optional: older preloads
    // lack it.
    metisPreference?: {
      signal: (input: {
        kind: "regenerate" | "model_switch" | "ab_pick" | "thumbs_up" | "thumbs_down";
        at?: string;
        provider?: string;
        model?: string;
        conversationId?: string;
        detail?: string;
      }) => Promise<void>;
      summary: () => Promise<{
        total: number;
        byKind: Record<string, number>;
        since: string | null;
        // Phase B v1 (DRILL_PLAN B12.1): plain-sentence usage observations,
        // display-only. Optional so older preloads stay compatible.
        observations?: string[];
      }>;
    };
    metisRoutines?: {
      list: () => Promise<Routine[]>;
      save: (routine: Routine) => Promise<Routine>;
      delete: (id: string) => Promise<Routine[]>;
      runNow: (id: string) => Promise<Routine | undefined>;
      // DRILL_PLAN I9.4 — plan-only dry run: fires the routine's prompt under
      // permissionMode "plan" into a fresh conversation and resolves its id,
      // never mutating the routine record. Optional: older preloads lack it.
      dryRun?: (id: string) => Promise<{ ok: boolean; conversationId?: string; error?: string }>;
    };
    metisOllama?: {
      list(): Promise<OllamaListResult>;
      pull(model: string): Promise<{ ok: boolean; error?: string }>;
      onPullProgress(cb: (progress: OllamaPullProgress) => void): () => void;
    };
    metisPrewarm?: {
      // The optional context ({ conversationId, projectPath }) makes the
      // backend warm/draft with the SAME assembled prompt the real pinned
      // run sends (DRILL_PLAN O3), so Ollama's prompt cache prefix-matches
      // at send time. Without it, warming only keeps the model resident.
      warm: (model: string, draft: string, context?: { conversationId?: string; projectPath?: string }) => Promise<void>;
      // DRILL_PLAN O2a v0.1 — sibling to warm, but resolves the actual
      // speculative draft text (null on any failure/guard/off-flag).
      // `thoughts` is only present when the model emitted a <think> block
      // that was stripped from `text`.
      draft: (
        model: string,
        draft: string,
        context?: { conversationId?: string; projectPath?: string }
      ) => Promise<{ text: string; thoughts?: string } | null>;
      // DRILL_PLAN O5 — cloud Oracle draft (DeepSeek first): the paid,
      // explicitly opted-in sibling of `draft`. `model` is the picker
      // display name; the backend resolves it and enforces BOTH flags
      // (prewarmEnabled and oracleCloudEnabled) plus the saved key.
      draftCloud?: (
        model: string,
        draft: string,
        context?: { conversationId?: string; projectPath?: string }
      ) => Promise<{ text: string; thoughts?: string } | null>;
      // DRILL_PLAN I9.2 — subscribe to live deltas of the in-flight local
      // draft; returns the unsubscribe function. `reset` marks the first
      // delta of a fresh generation (clear the previous partial guess).
      onDraftDelta?: (cb: (event: { kind: "text" | "thought"; delta: string; reset?: boolean }) => void) => () => void;
      // DRILL_PLAN B8.2b v0.1 — sibling to warm/draft, but decides WHERE the
      // Auto Router would send the draft instead of touching a model at all.
      // Resolves to void like warm: the decision is consumed indirectly, by
      // the backend's own cache lookup when the real send happens, not by
      // the renderer directly.
      route: (draft: string, context?: { conversationId?: string; projectPath?: string }) => Promise<void>;
    };
    metisManager?: {
      chat: (history: ManagerChatMessage[]) => Promise<ManagerChatResult>;
      // Streaming sibling of `chat` (docs/DRILL_PLAN.md Phase 8) — the
      // renderer opts in by generating its own streamId, subscribing via
      // onChatStreamEvent, then calling chatStream with that same id.
      // `chat` above is unchanged for callers that don't opt in.
      chatStream: (streamId: string, history: ManagerChatMessage[]) => Promise<ManagerChatResult>;
      onChatStreamEvent: (cb: (streamId: string, event: ManagerChatStreamEvent) => void) => () => void;
      runAction: (action: ManagerAction) => Promise<ManagerActionResult>;
    };
    metisUpdates?: {
      check: () => Promise<UpdateCheckResult>;
    };
    metisGateway?: {
      getStatus: () => Promise<GatewayStatus>;
      setEnabled: (enabled: boolean) => Promise<GatewayStatus>;
    };
    metisGallery?: {
      analyzeBoard: (boardId: string) => Promise<StyleCard[]>;
      analyzeImage: (boardId: string, imageId: string) => Promise<StyleCard | null>;
      cards: () => Promise<StyleCard[]>;
      updateCard: (imageId: string, boardId: string, patch: { title?: string; caption?: string; moodTags?: string[] }) => Promise<StyleCard>;
      deleteCard: (imageId: string) => Promise<void>;
      importUrls: (urls: string[]) => Promise<ImageImportResult>;
      importPinterest: (boardUrl: string) => Promise<ImageImportResult>;
    };
  }
}
