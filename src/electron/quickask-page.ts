// docs/DRILL_PLAN.md B12.4 — Global quick-ask overlay page.
//
// This is a self-contained HTML document (no bundler, no Vite dev server
// dependency) loaded into the overlay BrowserWindow via a data: URL. It talks
// to main.ts exclusively through the tiny `quickAsk` bridge exposed by
// quickask-preload.cts (ask/openApp/hide) — no Node integration, no access to
// anything else in the app. Kept in its own module (rather than an inline
// template literal in main.ts) so the coordinator's concurrent edits to
// main.ts/App.tsx never collide with this file.
export const QUICKASK_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Metis Quick Ask</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #202020;
    color: #ededed;
    font-family: -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
    overflow: hidden;
    user-select: none;
  }
  #frame {
    display: flex;
    flex-direction: column;
    height: 100%;
    border: 1px solid #2c2c2c;
    border-radius: 10px;
    overflow: hidden;
  }
  #titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #8a8a8a;
    -webkit-app-region: drag;
  }
  #openApp {
    -webkit-app-region: no-drag;
    background: none;
    border: none;
    color: #aeb7c6;
    font-size: 11px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }
  #openApp:hover { background: #2a2a2a; color: #ededed; }
  #prompt {
    margin: 0 12px;
    background: #1b1b1b;
    border: 1px solid #2c2c2c;
    border-radius: 8px;
    color: #ededed;
    font-size: 14px;
    padding: 8px 10px;
    outline: none;
    user-select: text;
  }
  #prompt:focus { border-color: #aeb7c6; }
  #status {
    margin: 6px 12px 0 12px;
    font-size: 11px;
    color: #6f6f6f;
    min-height: 14px;
    user-select: text;
  }
  #answer {
    margin: 6px 12px 10px 12px;
    padding: 8px 10px;
    background: #1e1e1e;
    border: 1px solid #262626;
    border-radius: 8px;
    font-size: 12.5px;
    line-height: 1.45;
    color: #c2c2c2;
    white-space: pre-wrap;
    overflow-y: auto;
    flex: 1;
    user-select: text;
  }
  #answer.error { color: #d99a9a; }
  #answer:empty { display: none; }
</style>
</head>
<body>
  <div id="frame">
    <div id="titlebar">
      <span>Metis · Quick Ask</span>
      <button id="openApp" type="button">Open Metis</button>
    </div>
    <input id="prompt" type="text" placeholder="Ask Metis anything… (Enter to send, Esc to dismiss)" autofocus />
    <div id="status"></div>
    <div id="answer"></div>
  </div>
  <script>
    const promptEl = document.getElementById("prompt");
    const statusEl = document.getElementById("status");
    const answerEl = document.getElementById("answer");
    const openAppBtn = document.getElementById("openApp");

    function focusPrompt() {
      promptEl.focus();
      promptEl.select();
    }
    // Focus as soon as the page paints; the main process also calls
    // focus()/show() on the BrowserWindow itself when it summons this window.
    window.addEventListener("DOMContentLoaded", focusPrompt);

    async function submit() {
      const text = promptEl.value.trim();
      if (!text || !window.quickAsk) return;
      statusEl.textContent = "Asking Metis…";
      answerEl.className = "";
      answerEl.textContent = "";
      try {
        const result = await window.quickAsk.ask(text);
        if (result && result.error) {
          statusEl.textContent = "Error";
          answerEl.className = "error";
          answerEl.textContent = result.error;
        } else {
          statusEl.textContent = "Answered";
          answerEl.textContent = (result && result.text) || "(no response)";
        }
      } catch (err) {
        statusEl.textContent = "Error";
        answerEl.className = "error";
        answerEl.textContent = err && err.message ? err.message : String(err);
      }
    }

    promptEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        window.quickAsk && window.quickAsk.hide();
      }
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        window.quickAsk && window.quickAsk.hide();
      }
    });

    openAppBtn.addEventListener("click", () => {
      window.quickAsk && window.quickAsk.openApp();
    });
  </script>
</body>
</html>`;
