import { contextBridge, ipcRenderer } from "electron";
import type {
  ConversationExportResult,
  ConversationRecord,
  GatewayStatus,
  ManagerAction,
  ManagerActionResult,
  ManagerChatMessage,
  ManagerChatResult,
  ManagerChatStreamEvent,
  MetisFileReadResult,
  MetisFileWriteResult,
  McpProbeResult,
  ImageImportResult,
  OllamaPullProgress,
  PermissionRequest,
  PermissionVerdict,
  PolicyDecisionInput,
  ProviderInvokeInput,
  ProviderKey,
  Routine,
  SessionStreamEvent,
  SessionRunInput,
  StyleCard,
  UpdateCheckResult,
  UserProfile,
  UserQuestionAnswer
} from "../shared/runtime-contracts";

contextBridge.exposeInMainWorld("metisPolicy", {
  getSampleDecision: () => ipcRenderer.invoke("metis-policy:get-sample-decision"),
  getStatus: (profilePath?: string) => ipcRenderer.invoke("metis-policy:get-status", profilePath),
  decide: (input: PolicyDecisionInput) => ipcRenderer.invoke("metis-policy:decide", input)
});

contextBridge.exposeInMainWorld("metisStore", {
  get: <T,>(key: string, fallback: T) => ipcRenderer.invoke("metis-store:get", key, fallback) as Promise<T>,
  set: <T,>(key: string, value: T) => ipcRenderer.invoke("metis-store:set", key, value) as Promise<void>
});

contextBridge.exposeInMainWorld("metisWindow", {
  minimize: () => ipcRenderer.send("metis-window:minimize"),
  toggleMaximize: () => ipcRenderer.send("metis-window:toggle-maximize"),
  close: () => ipcRenderer.send("metis-window:close")
});

contextBridge.exposeInMainWorld("metisShell", {
  openExternal: (url: string) => ipcRenderer.invoke("metis-shell:open-external", url) as Promise<void>,
  openPath: (path: string) => ipcRenderer.invoke("metis-shell:open-path", path) as Promise<void>
});

contextBridge.exposeInMainWorld("metisSession", {
  run: (input: SessionRunInput) => ipcRenderer.invoke("metis-session:run", input),
  runStream: (input: SessionRunInput, onEvent: (event: SessionStreamEvent) => void) => {
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const listener = (_event: unknown, eventStreamId: string, payload: SessionStreamEvent) => {
      if (eventStreamId === streamId) onEvent(payload);
    };
    ipcRenderer.on("metis-session:stream-event", listener);
    return (ipcRenderer.invoke("metis-session:run-stream", streamId, input) as Promise<unknown>).finally(() => {
      ipcRenderer.removeListener("metis-session:stream-event", listener);
    });
  },
  list: () => ipcRenderer.invoke("metis-session:list"),
  cancel: (projectPath?: string) => ipcRenderer.send("metis-session:cancel", projectPath),
  // Widened to accept string[] additively (DRILL_PLAN B2.3a multi-question
  // form) — existing callers passing a single string are unaffected.
  answerQuestion: (id: string, answer: UserQuestionAnswer) => ipcRenderer.send("metis-session:answer-question", id, answer)
});

contextBridge.exposeInMainWorld("metisBus", {
  post: (input: { projectPath?: string; conversationId?: string; text: string }) => ipcRenderer.invoke("metis-bus:post", input),
  list: (projectPath?: string) => ipcRenderer.invoke("metis-bus:list", projectPath)
});

contextBridge.exposeInMainWorld("metisConversations", {
  list: () => ipcRenderer.invoke("metis-conversations:list") as Promise<ConversationRecord[]>,
  create: (projectPath?: string, firstPrompt?: string) => ipcRenderer.invoke("metis-conversations:create", projectPath, firstPrompt) as Promise<ConversationRecord>,
  delete: (id: string) => ipcRenderer.invoke("metis-conversations:delete", id) as Promise<ConversationRecord[]>,
  deleteProject: (projectPath?: string) => ipcRenderer.invoke("metis-conversations:delete-project", projectPath) as Promise<ConversationRecord[]>,
  rename: (id: string, title: string) => ipcRenderer.invoke("metis-conversations:rename", id, title) as Promise<ConversationRecord[]>,
  // DRILL_PLAN I9.5 — fork a conversation (all turns, or up to a run id).
  fork: (id: string, uptoRunId?: string) => ipcRenderer.invoke("metis-conversations:fork", id, uptoRunId) as Promise<ConversationRecord | null>,
  archive: (id: string, archived: boolean) => ipcRenderer.invoke("metis-conversations:archive", id, archived) as Promise<ConversationRecord[]>,
  exportMarkdown: (input?: { conversationId?: string }) => ipcRenderer.invoke("metis-conversations:export", input) as Promise<ConversationExportResult>
});

contextBridge.exposeInMainWorld("metisKnowledge", {
  searchConversations: (query: string, topK?: number) =>
    ipcRenderer.invoke("metis-knowledge:searchConversations", query, topK) as Promise<
      { conversationId: string; ordinal: number; text: string; score: number }[]
    >
});

contextBridge.exposeInMainWorld("metisLab", {
  runExperiment: (prompt?: string) => ipcRenderer.invoke("metis-lab:run-experiment", prompt)
});

contextBridge.exposeInMainWorld("metisProfile", {
  get: () => ipcRenderer.invoke("metis-profile:get") as Promise<UserProfile>,
  set: (patch: Partial<UserProfile>) => ipcRenderer.invoke("metis-profile:set", patch) as Promise<UserProfile>
});

contextBridge.exposeInMainWorld("metisProject", {
  getWorkspace: () => ipcRenderer.invoke("metis-project:get-workspace"),
  snapshot: () => ipcRenderer.invoke("metis-project:snapshot"),
  selectFolder: () => ipcRenderer.invoke("metis-project:select-folder"),
  clearWorkspace: () => ipcRenderer.invoke("metis-project:clear-workspace"),
  listResources: () => ipcRenderer.invoke("metis-project:list-resources"),
  addFiles: () => ipcRenderer.invoke("metis-project:add-files"),
  addFolder: () => ipcRenderer.invoke("metis-project:add-folder"),
  removeResource: (id: string) => ipcRenderer.invoke("metis-project:remove-resource", id)
});

contextBridge.exposeInMainWorld("metisFiles", {
  read: (path: string) => ipcRenderer.invoke("metis-files:read", path) as Promise<MetisFileReadResult>,
  write: (path: string, content: string) => ipcRenderer.invoke("metis-files:write", path, content) as Promise<MetisFileWriteResult>
});

contextBridge.exposeInMainWorld("metisSecrets", {
  list: () => ipcRenderer.invoke("metis-secrets:list"),
  set: (provider: ProviderKey, value: string) => ipcRenderer.invoke("metis-secrets:set", provider, value),
  delete: (provider: ProviderKey) => ipcRenderer.invoke("metis-secrets:delete", provider)
});

contextBridge.exposeInMainWorld("metisPermissions", {
  list: () => ipcRenderer.invoke("metis-permissions:list"),
  request: (request: PermissionRequest) => ipcRenderer.invoke("metis-permissions:request", request),
  revoke: (id: string) => ipcRenderer.invoke("metis-permissions:revoke", id),
  respond: (id: string, verdict: PermissionVerdict) => ipcRenderer.send("metis-permissions:respond", id, verdict)
});

contextBridge.exposeInMainWorld("metisAudit", {
  list: (limit?: number) => ipcRenderer.invoke("metis-audit:list", limit)
});

contextBridge.exposeInMainWorld("metisProviders", {
  list: () => ipcRenderer.invoke("metis-providers:list"),
  healthCheck: (provider: ProviderKey) => ipcRenderer.invoke("metis-providers:health-check", provider),
  invoke: (input: ProviderInvokeInput) => ipcRenderer.invoke("metis-providers:invoke", input)
});

contextBridge.exposeInMainWorld("metisRegistry", {
  list: () => ipcRenderer.invoke("metis-registry:list"),
  refresh: (sourceUrl?: string) => ipcRenderer.invoke("metis-registry:refresh", sourceUrl),
  listInstalled: () => ipcRenderer.invoke("metis-registry:list-installed"),
  install: (id: string) => ipcRenderer.invoke("metis-registry:install", id),
  uninstall: (id: string) => ipcRenderer.invoke("metis-registry:uninstall", id)
});

contextBridge.exposeInMainWorld("metisMcp", {
  probe: (id: string) => ipcRenderer.invoke("metis-mcp:probe", id) as Promise<McpProbeResult>
});

contextBridge.exposeInMainWorld("metisCatalog", {
  models: () => ipcRenderer.invoke("metis-catalog:models")
});

contextBridge.exposeInMainWorld("metisPulse", {
  feed: () => ipcRenderer.invoke("metis-pulse:feed")
});

// DRILL_PLAN B12.2/B12.7 — usage metering (Usage tab) + usage limits (the
// ring). summary() is read-only and cheap to poll; setLimits() is a partial
// patch of the usageLimits store key. Display-only in this pass — main.ts
// does not enforce these limits yet, see the comment on UsageLimits there.
contextBridge.exposeInMainWorld("metisUsage", {
  summary: () => ipcRenderer.invoke("metis-usage:summary"),
  setLimits: (patch: {
    fourHourTokens?: number;
    weeklyTokens?: number;
    walletTokens?: number;
  }) => ipcRenderer.invoke("metis-usage:set-limits", patch)
});

contextBridge.exposeInMainWorld("metisRoutines", {
  list: () => ipcRenderer.invoke("metis-routines:list") as Promise<Routine[]>,
  save: (routine: Routine) => ipcRenderer.invoke("metis-routines:save", routine) as Promise<Routine>,
  delete: (id: string) => ipcRenderer.invoke("metis-routines:delete", id) as Promise<Routine[]>,
  runNow: (id: string) => ipcRenderer.invoke("metis-routines:run-now", id) as Promise<Routine | undefined>,
  // DRILL_PLAN I9.4 — plan-only dry run; resolves the preview conversation id.
  dryRun: (id: string) => ipcRenderer.invoke("metis-routines:dry-run", id) as Promise<{ ok: boolean; conversationId?: string; error?: string }>
});

contextBridge.exposeInMainWorld("metisOllama", {
  list: () => ipcRenderer.invoke("metis-ollama:list"),
  pull: (model: string) => ipcRenderer.invoke("metis-ollama:pull", model),
  onPullProgress: (cb: (progress: OllamaPullProgress) => void) => {
    const listener = (_event: unknown, payload: OllamaPullProgress) => cb(payload);
    ipcRenderer.on("metis-ollama:pull-progress", listener);
    return () => ipcRenderer.removeListener("metis-ollama:pull-progress", listener);
  }
});

contextBridge.exposeInMainWorld("metisPrewarm", {
  // The optional context ({ conversationId, projectPath }) lets the backend
  // warm/draft with the SAME assembled prompt the real pinned run will send
  // (DRILL_PLAN O3), so send-time prefill prefix-matches Ollama's cache.
  warm: (model: string, draft: string, context?: { conversationId?: string; projectPath?: string }) =>
    ipcRenderer.invoke("metis-prewarm:warm", model, draft, context) as Promise<void>,
  // DRILL_PLAN O2a v0.1 — sibling to warm, resolves the drafted text (or null).
  draft: (model: string, draft: string, context?: { conversationId?: string; projectPath?: string }) =>
    ipcRenderer.invoke("metis-prewarm:draft", model, draft, context) as Promise<{ text: string; thoughts?: string } | null>,
  // DRILL_PLAN O5 — cloud Oracle draft (DeepSeek, explicit paid opt-in).
  // `model` is the picker display name; the backend resolves + double-gates.
  draftCloud: (model: string, draft: string, context?: { conversationId?: string; projectPath?: string }) =>
    ipcRenderer.invoke("metis-prewarm:draft-cloud", model, draft, context) as Promise<{ text: string; thoughts?: string } | null>,
  // DRILL_PLAN I9.2 — live deltas of the in-flight local draft. Same
  // subscribe/unsubscribe shape as metis-ollama:onPullProgress.
  onDraftDelta: (cb: (event: { kind: "text" | "thought"; delta: string; reset?: boolean }) => void) => {
    const listener = (_event: unknown, payload: { kind: "text" | "thought"; delta: string; reset?: boolean }) => cb(payload);
    ipcRenderer.on("metis-prewarm:draft-delta", listener);
    return () => ipcRenderer.removeListener("metis-prewarm:draft-delta", listener);
  },
  // DRILL_PLAN B8.2b v0.1 — sibling to warm/draft, but decides WHERE the
  // Auto Router would send the draft instead of touching a model. Resolves
  // to void like warm: the decision is consumed indirectly, by runSession's
  // own cache lookup at send time, not by the renderer directly.
  route: (draft: string, context?: { conversationId?: string; projectPath?: string }) =>
    ipcRenderer.invoke("metis-prewarm:route", draft, context) as Promise<void>
});

contextBridge.exposeInMainWorld("metisManager", {
  chat: (history: ManagerChatMessage[]) => ipcRenderer.invoke("metis-manager:chat", history) as Promise<ManagerChatResult>,
  // Streaming sibling of `chat` above (docs/DRILL_PLAN.md Phase 8). Unlike
  // metisSession.runStream (which generates its own streamId internally and
  // takes a callback directly), this mirrors the metis-ollama:onPullProgress
  // shape instead: the caller supplies its own streamId and subscribes
  // separately via onChatStreamEvent, so a renderer can wire up the listener
  // before the turn's history is even known. `chat` above is completely
  // unchanged and keeps working for callers that don't opt into streaming.
  chatStream: (streamId: string, history: ManagerChatMessage[]) =>
    ipcRenderer.invoke("metis-manager:chat-stream", streamId, history) as Promise<ManagerChatResult>,
  onChatStreamEvent: (cb: (streamId: string, event: ManagerChatStreamEvent) => void) => {
    const listener = (_event: unknown, streamId: string, payload: ManagerChatStreamEvent) => cb(streamId, payload);
    ipcRenderer.on("metis-manager:chat-stream-event", listener);
    return () => ipcRenderer.removeListener("metis-manager:chat-stream-event", listener);
  },
  runAction: (action: ManagerAction) => ipcRenderer.invoke("metis-manager:action", action) as Promise<ManagerActionResult>
});

contextBridge.exposeInMainWorld("metisUpdates", {
  check: () => ipcRenderer.invoke("metis-updates:check") as Promise<UpdateCheckResult>
});

contextBridge.exposeInMainWorld("metisGateway", {
  getStatus: () => ipcRenderer.invoke("metis-gateway:get-status") as Promise<GatewayStatus>,
  setEnabled: (enabled: boolean) => ipcRenderer.invoke("metis-gateway:set-enabled", enabled) as Promise<GatewayStatus>
});

contextBridge.exposeInMainWorld("metisGallery", {
  analyzeBoard: (boardId: string) => ipcRenderer.invoke("metis-gallery:analyze-board", boardId) as Promise<StyleCard[]>,
  analyzeImage: (boardId: string, imageId: string) => ipcRenderer.invoke("metis-gallery:analyze-image", boardId, imageId) as Promise<StyleCard | null>,
  cards: () => ipcRenderer.invoke("metis-gallery:cards") as Promise<StyleCard[]>,
  updateCard: (imageId: string, boardId: string, patch: { title?: string; caption?: string; moodTags?: string[] }) =>
    ipcRenderer.invoke("metis-gallery:update-card", imageId, boardId, patch) as Promise<StyleCard>,
  deleteCard: (imageId: string) => ipcRenderer.invoke("metis-gallery:delete-card", imageId) as Promise<void>,
  importUrls: (urls: string[]) => ipcRenderer.invoke("metis-gallery:import-urls", urls) as Promise<ImageImportResult>,
  importPinterest: (boardUrl: string) => ipcRenderer.invoke("metis-gallery:import-pinterest", boardUrl) as Promise<ImageImportResult>
});
