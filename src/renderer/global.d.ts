import type { RouteDecision } from "../shared/policy-contract";
import type {
  AuditEvent,
  CatalogModel,
  ConversationRecord,
  LabExperimentResult,
  MetisFileReadResult,
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
  StyleCard
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
      answerQuestion: (id: string, answer: string) => void;
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
    };
    metisLab?: {
      runExperiment: (prompt?: string) => Promise<LabExperimentResult>;
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
    metisCatalog?: {
      models: () => Promise<ModelCatalogState>;
    };
    metisPulse?: {
      feed: () => Promise<PulseFeed>;
    };
    metisRoutines?: {
      list: () => Promise<Routine[]>;
      save: (routine: Routine) => Promise<Routine>;
      delete: (id: string) => Promise<Routine[]>;
      runNow: (id: string) => Promise<Routine | undefined>;
    };
    metisOllama?: {
      list(): Promise<OllamaListResult>;
      pull(model: string): Promise<{ ok: boolean; error?: string }>;
      onPullProgress(cb: (progress: OllamaPullProgress) => void): () => void;
    };
    metisGallery?: {
      analyzeBoard: (boardId: string) => Promise<StyleCard[]>;
      analyzeImage: (boardId: string, imageId: string) => Promise<StyleCard | null>;
      cards: () => Promise<StyleCard[]>;
      updateCard: (imageId: string, boardId: string, patch: { title?: string; caption?: string; moodTags?: string[] }) => Promise<StyleCard>;
      deleteCard: (imageId: string) => Promise<void>;
    };
  }
}
