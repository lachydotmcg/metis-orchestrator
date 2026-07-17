// docs/DRILL_PLAN.md B12.4 — dedicated, minimal preload for the global
// quick-ask overlay window. Deliberately separate from preload.cts (the main
// window's preload) so the overlay's attack surface / exposed API stays tiny
// and the coordinator's concurrent edits to preload.cts never collide here.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("quickAsk", {
  ask: (prompt: string) => ipcRenderer.invoke("quickask:ask", prompt) as Promise<{ text: string; error?: string }>,
  openApp: () => ipcRenderer.send("quickask:open-app"),
  hide: () => ipcRenderer.send("quickask:hide")
});
