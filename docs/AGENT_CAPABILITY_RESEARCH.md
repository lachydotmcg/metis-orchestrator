# Agent Capability Research

Date: 2026-06-30

Purpose: track the coding-agent features Metis Orchestrator should eventually
cover or exceed. This is product guidance, not implementation proof.

## What Current Agents Expose

### Claude Code

Official docs describe Claude Code as combining model reasoning with built-in
tools for file operations, search, execution, and web access, with extension
layers for skills/subagents/hooks/MCP/plugins.

Important features to mirror:

- File operations and search as first-class tool calls.
- Terminal execution with user-visible lifecycle.
- Hooks that run at specific lifecycle points, including formatting after edits,
  blocking risky commands, notifications, context injection, and MCP tool hooks.
- Subagents for specialized work and parallel delegation.
- MCP as the external integration layer.
- Browser/computer interaction should be treated as an explicit capability with
  permissions and audit logs, not hidden inside chat prose.

Sources:

- https://code.claude.com/docs/en/features-overview
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks-guide
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously

### OpenAI Codex

Current public surfaces include local Codex CLI, Codex app/web, GitHub code
review, and GitHub Actions integration. The important product lesson is that
work is not just a text reply: Codex can operate in a repo, review diffs,
prepare/fix PRs, and run in controlled environments.

Important features to mirror:

- Local coding agent that reads, edits, and runs code in a working tree.
- GitHub PR review that comments on diffs and follows repo instructions.
- Action/workflow integration with scoped privileges and explicit secrets.
- Parallel or isolated work environments are a differentiator to plan for later:
  separate worktrees/tasks, not just multiple chat tabs.

Sources:

- https://github.com/openai/codex
- https://developers.openai.com/codex/integrations/github
- https://github.com/openai/codex-action

### Gemini CLI

Gemini CLI documentation describes tools for local environment interaction,
including file system operations, shell commands, web fetching/search, MCP,
memory, sessions/history, and confirmation flows for risky actions.

Important features to mirror:

- File read/write/edit tools.
- Shell command execution.
- Web fetch and web search.
- MCP support.
- Session/history and memory management.
- Safety/confirmation for file modification and command execution.

Sources:

- https://google-gemini.github.io/gemini-cli/docs/
- https://google-gemini.github.io/gemini-cli/docs/tools/
- https://geminicli.com/docs/reference/tools/
- https://docs.cloud.google.com/gemini/docs/codeassist/gemini-cli

## Metis Orchestrator Product Requirements

### Operation Timeline

Conversation output needs an operation timeline below or between assistant
messages. It should feel like a compact merge request/check log:

- Pencil: `Edited <file>` with `+00` and `-00`.
- File/folder: `Created <path>` or `Added <directory>`.
- Terminal: `Ran <command>` with exit code, duration, and expandable output.
- Browser: `Opened/checked <url>` with page status, console errors, screenshot
  state, and visual verification result.
- Computer use: visible screenshots/actions with permission scope and target.
- GitHub: `Prepared PR`, `Reviewed diff`, `Staged files`, `Pushed branch`.
- MCP: `Called <server>/<tool>` with permission, input summary, and result.

The route trace answers "why this path?" The operation timeline answers "what
actually happened?"

Long-running work needs incremental timeline delivery, not a final dump after
completion. The app now has an initial Electron-to-renderer stream for visible
work/status events: assistant text, route decisions, completed model stages,
file/edit operations, project evidence, and final summaries. It still needs
cancel/resume semantics, question events, goal updates, and lower-level provider
token streaming where providers support it.

Goals should be first-class runtime state: a session can keep iterating until a
goal is complete, blocked, canceled, or out of budget. Questions should also be
first-class events that pause/resume a run instead of becoming ad hoc chat text.

### Message Authorship

Authorship belongs on the message body, not inside route metadata.

- If displayed words are raw provider output, show that on the message surface:
  for example `DeepSeek output`, `Sonnet output`, `Local output`.
- If Metis rewrote, combined, or summarized model output, show `Metis synthesis`.
- If a manager agent quotes another model, render it as quote/source-aware
  content rather than making users ask "who said that?"

### Permissions

Every operation class needs explicit permission semantics:

- filesystem read
- filesystem write
- shell command
- browser control
- computer control
- network/web
- provider/API call
- MCP tool call
- GitHub write action

These should be visible in Settings and surfaced at the point of action when
needed.

### Near-Term Implementation Order

1. [x] Expand `SessionRun` with a real `operations` array instead of deriving rows
   from project artifacts.
2. [x] Record file write/edit operations with path, bytes, added lines, removed
   lines, and whether the write happened in app-managed or selected project
   workspace.
   - [x] Model-returned source is now extracted into real files. Raw HTML
     documents, fenced code blocks with path hints, and common language-only
     blocks become project artifacts; code is no longer echoed as the assistant
     answer when project tools handled it.
3. [ ] Record command operations with command, cwd, exit code, duration, stdout/stderr
   snippets, and whether the user approved it.
   - [x] Generated frontend projects now record a real `node --check script.js`
     syntax-check command in the conversation operation timeline.
   - [x] Chat runs can run safe detected `npm run test/build/lint --if-present`
     commands in the selected project when the user asks for them and the
     session is not restricted.
   - [ ] General-purpose user-approved terminal execution is still future work.
4. [x] Record browser verification operations with URL, title, status,
   duration, and verification result.
5. [x] Add expandable operation rows in the conversation UI.
6. [x] Add operation filters in the conversation UI.
7. [x] Add console error capture and screenshot paths to browser verification
   operations.
8. [x] Feed completed operation nodes into Graph View as linked memory.
