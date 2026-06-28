import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  BrainCircuit,
  ChevronDown,
  CircleGauge,
  GitBranch,
  KeyRound,
  Lock,
  MessageSquareText,
  Network,
  PanelLeft,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Zap
} from "lucide-react";
import type { Route, RouteDecision, RouterPreset, RouteScore, TaskType } from "../../shared/policy-contract";
import { sampleDecision } from "../../shared/sample-decision";

const presets: Array<{ id: RouterPreset; label: string; detail: string }> = [
  { id: "balanced", label: "Balanced", detail: "Quality, privacy, speed, and cost" },
  { id: "local_first", label: "Local first", detail: "Prefer measured local routes" },
  { id: "best_quality", label: "Best quality", detail: "Favor frontier routes" },
  { id: "cheapest", label: "Cheapest", detail: "Minimize configured cost" },
  { id: "private", label: "Private", detail: "Keep sensitive prompts local" }
];

const taskNodes: Array<{
  type: TaskType;
  label: string;
  route: string;
  confidence: string;
  status: "local" | "cloud" | "review";
}> = [
  { type: "summarisation", label: "Summarisation", route: "qwen3:8b", confidence: "High", status: "local" },
  { type: "coding", label: "Coding", route: "Claude Sonnet 4.6", confidence: "Medium", status: "cloud" },
  { type: "frontend_design", label: "Frontend design", route: "Claude Sonnet 4.6", confidence: "Needs review", status: "review" },
  { type: "long_context", label: "Long context", route: "Cloud frontier", confidence: "High", status: "cloud" },
  { type: "private_sensitive", label: "Private prompts", route: "Local only", confidence: "Strict", status: "local" },
  { type: "general_chat", label: "General chat", route: "Balanced router", confidence: "Medium", status: "local" }
];

const routeOptions = [
  "Router: Balanced",
  "Router: Local first",
  "Router: Best quality",
  "qwen3:8b",
  "Ornith local",
  "Claude Sonnet 4.6",
  "OpenRouter frontier"
];

function routeLabel(route: Route): string {
  if (route.kind === "none") return "No route";
  return [route.kind, route.provider, route.runtime, route.model].filter(Boolean).join(" / ");
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function scoreLabel(score: RouteScore): string {
  const label = routeLabel(score.route);
  return `${label} - ${score.total.toFixed(3)}`;
}

function loadSampleDecision(): Promise<RouteDecision> {
  return window.metisPolicy?.getSampleDecision() ?? Promise.resolve(sampleDecision);
}

export function App(): JSX.Element {
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [preset, setPreset] = useState<RouterPreset>("balanced");
  const [routeChoice, setRouteChoice] = useState(routeOptions[0]);
  const [graphOpen, setGraphOpen] = useState(false);
  const [prompt, setPrompt] = useState("Summarise these notes into five bullets.");

  useEffect(() => {
    void loadSampleDecision().then(setDecision);
  }, []);

  const selectedPreset = presets.find((item) => item.id === preset) ?? presets[0];
  const selectedRoute = decision?.selected_route;
  const fallback = decision?.fallback_routes[0];
  const selectedScore = decision?.scores[0];
  const scoreRows = useMemo(() => decision?.scores ?? [], [decision]);

  return (
    <div className="app-shell">
      <aside className="rail">
        <button className="rail-button active" type="button" onClick={() => setGraphOpen((value) => !value)}>
          <GitBranch size={18} />
          <span>{graphOpen ? "Chat" : "Graph"}</span>
        </button>
        <button className="rail-icon" type="button" aria-label="Chats">
          <MessageSquareText size={18} />
        </button>
        <button className="rail-icon" type="button" aria-label="Provider keys">
          <KeyRound size={18} />
        </button>
        <button className="rail-icon bottom" type="button" aria-label="Settings">
          <Settings2 size={18} />
        </button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="kicker">Metis Orchestrator</p>
            <h1>{graphOpen ? "Policy graph" : "Evidence-backed chat routing"}</h1>
          </div>
          <div className="topbar-actions">
            <span className="status-pill"><ShieldCheck size={15} /> Local policy contract</span>
            <span className="status-pill muted"><CircleGauge size={15} /> {decision ? percent(decision.confidence) : "Loading"}</span>
          </div>
        </header>

        {graphOpen ? (
          <PolicyGraph preset={selectedPreset.label} />
        ) : (
          <section className="chat-layout">
            <div className="conversation-panel">
              <div className="message-row user">
                <div className="avatar">Y</div>
                <div className="message-bubble">
                  <span className="message-label">User prompt</span>
                  <p>{prompt}</p>
                </div>
              </div>

              <div className="message-row system">
                <div className="avatar route"><Network size={17} /></div>
                <div className="message-bubble route-card">
                  <span className="message-label">Router decision</span>
                  <h2>{selectedRoute ? routeLabel(selectedRoute) : "Loading policy decision"}</h2>
                  <p>{decision?.reason ?? "Waiting for Metis Policy sample decision."}</p>
                  <div className="decision-strip">
                    <div>
                      <span>Task</span>
                      <strong>{decision?.task_type.replace("_", " ") ?? "unknown"}</strong>
                    </div>
                    <div>
                      <span>Fallback</span>
                      <strong>{fallback ? routeLabel(fallback) : "None"}</strong>
                    </div>
                    <div>
                      <span>Raw prompt stored</span>
                      <strong>{decision?.prompt_profile.raw_prompt_stored ? "Yes" : "No"}</strong>
                    </div>
                  </div>
                </div>
              </div>

              <div className="composer">
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  aria-label="Prompt"
                />
                <div className="composer-bar">
                  <label className="select-shell">
                    <Bot size={16} />
                    <select value={routeChoice} onChange={(event) => setRouteChoice(event.target.value)}>
                      {routeOptions.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                    <ChevronDown size={16} />
                  </label>

                  <label className="select-shell">
                    <Sparkles size={16} />
                    <select value={preset} onChange={(event) => setPreset(event.target.value as RouterPreset)}>
                      {presets.map((item) => (
                        <option key={item.id} value={item.id}>{item.label}</option>
                      ))}
                    </select>
                    <ChevronDown size={16} />
                  </label>

                  <button className="send-button" type="button" aria-label="Send prompt">
                    <Send size={18} />
                  </button>
                </div>
              </div>
            </div>

            <aside className="inspector">
              <section className="inspector-section">
                <div className="section-heading">
                  <BrainCircuit size={18} />
                  <div>
                    <h2>Why this route?</h2>
                    <p>{selectedPreset.detail}</p>
                  </div>
                </div>
                <div className="route-hero">
                  <span>Selected</span>
                  <strong>{selectedRoute ? routeLabel(selectedRoute) : "Loading"}</strong>
                  <div className="confidence-track">
                    <span style={{ width: decision ? `${decision.confidence * 100}%` : "12%" }} />
                  </div>
                </div>
              </section>

              <section className="inspector-section">
                <h3>Evidence</h3>
                <ul className="evidence-list">
                  {(decision?.evidence ?? []).slice(0, 5).map((item) => (
                    <li key={item.id}>
                      <span>{item.metric ?? item.source_type}</span>
                      <p>{item.summary}</p>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="inspector-section">
                <h3>Route scores</h3>
                <div className="score-list">
                  {scoreRows.map((score) => (
                    <div className="score-row" key={scoreLabel(score)}>
                      <div>
                        <strong>{routeLabel(score.route)}</strong>
                        <span>{score.total.toFixed(3)}</span>
                      </div>
                      <ScoreBars score={score} />
                    </div>
                  ))}
                </div>
              </section>

              <section className="inspector-section compact">
                <h3>Next integration</h3>
                <p>Connect this surface to `metis-policy decide`, then wire the selected route to Ollama or a configured provider.</p>
              </section>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}

function ScoreBars({ score }: { score: RouteScore }): JSX.Element {
  const items = [
    ["Quality", score.components.quality],
    ["Speed", score.components.speed],
    ["Cost", score.components.cost],
    ["Privacy", score.components.privacy]
  ] as const;

  return (
    <div className="mini-bars">
      {items.map(([label, value]) => (
        <div className="mini-bar" key={label}>
          <span>{label}</span>
          <div><i style={{ width: `${value * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function PolicyGraph({ preset }: { preset: string }): JSX.Element {
  const [selected, setSelected] = useState<TaskType>("summarisation");
  const active = taskNodes.find((node) => node.type === selected) ?? taskNodes[0];

  return (
    <section className="graph-layout">
      <div className="graph-canvas">
        <div className="graph-root">
          <Network size={24} />
          <div>
            <strong>Router: {preset}</strong>
            <span>Default policy for this hardware</span>
          </div>
        </div>
        <div className="graph-grid">
          {taskNodes.map((node) => (
            <button
              className={`graph-node ${node.status} ${node.type === selected ? "selected" : ""}`}
              key={node.type}
              type="button"
              onClick={() => setSelected(node.type)}
            >
              <span>{node.label}</span>
              <strong>{node.route}</strong>
              <small>{node.confidence}</small>
            </button>
          ))}
        </div>
      </div>

      <aside className="graph-detail">
        <div className="section-heading">
          <PanelLeft size={18} />
          <div>
            <h2>{active.label}</h2>
            <p>Branch override preview</p>
          </div>
        </div>
        <label className="field-label">
          Preferred route
          <select value={active.route} onChange={() => undefined}>
            <option>{active.route}</option>
            <option>qwen3:8b</option>
            <option>Ornith local</option>
            <option>Claude Sonnet 4.6</option>
            <option>OpenRouter frontier</option>
          </select>
        </label>
        <div className="policy-note">
          <Lock size={17} />
          <p>Edits are visual only in this scaffold. Persistence should land as user overrides in Metis Policy.</p>
        </div>
        <div className="graph-summary">
          <div><Zap size={18} /><span>Local when measured strong enough</span></div>
          <div><BrainCircuit size={18} /><span>Cloud when frontier judgement is needed</span></div>
          <div><ShieldCheck size={18} /><span>Private prompts stay local by default</span></div>
        </div>
      </aside>
    </section>
  );
}
