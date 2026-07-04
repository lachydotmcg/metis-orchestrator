import { contextBridge, ipcRenderer } from "electron";
import type {
  ConversationRecord,
  MetisFileReadResult,
  PermissionRequest,
  PolicyDecisionInput,
  ProviderInvokeInput,
  ProviderKey,
  Routine,
  SessionStreamEvent,
  SessionRunInput,
  StyleCard
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
  cancel: (projectPath?: string) => ipcRenderer.send("metis-session:cancel", projectPath)
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
  archive: (id: string, archived: boolean) => ipcRenderer.invoke("metis-conversations:archive", id, archived) as Promise<ConversationRecord[]>
});

contextBridge.exposeInMainWorld("metisLab", {
  runExperiment: (prompt?: string) => ipcRenderer.invoke("metis-lab:run-experiment", prompt)
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
  read: (path: string) => ipcRenderer.invoke("metis-files:read", path) as Promise<MetisFileReadResult>
});

contextBridge.exposeInMainWorld("metisSecrets", {
  list: () => ipcRenderer.invoke("metis-secrets:list"),
  set: (provider: ProviderKey, value: string) => ipcRenderer.invoke("metis-secrets:set", provider, value),
  delete: (provider: ProviderKey) => ipcRenderer.invoke("metis-secrets:delete", provider)
});

contextBridge.exposeInMainWorld("metisPermissions", {
  list: () => ipcRenderer.invoke("metis-permissions:list"),
  request: (request: PermissionRequest) => ipcRenderer.invoke("metis-permissions:request", request),
  revoke: (id: string) => ipcRenderer.invoke("metis-permissions:revoke", id)
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

contextBridge.exposeInMainWorld("metisCatalog", {
  models: () => ipcRenderer.invoke("metis-catalog:models")
});

contextBridge.exposeInMainWorld("metisPulse", {
  feed: () => ipcRenderer.invoke("metis-pulse:feed")
});

contextBridge.exposeInMainWorld("metisRoutines", {
  list: () => ipcRenderer.invoke("metis-routines:list") as Promise<Routine[]>,
  save: (routine: Routine) => ipcRenderer.invoke("metis-routines:save", routine) as Promise<Routine>,
  delete: (id: string) => ipcRenderer.invoke("metis-routines:delete", id) as Promise<Routine[]>,
  runNow: (id: string) => ipcRenderer.invoke("metis-routines:run-now", id) as Promise<Routine | undefined>
});

contextBridge.exposeInMainWorld("metisGallery", {
  analyzeBoard: (boardId: string) => ipcRenderer.invoke("metis-gallery:analyze-board", boardId) as Promise<StyleCard[]>,
  cards: () => ipcRenderer.invoke("metis-gallery:cards") as Promise<StyleCard[]>
});
