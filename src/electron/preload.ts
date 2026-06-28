import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("metisPolicy", {
  getSampleDecision: () => ipcRenderer.invoke("metis-policy:get-sample-decision")
});
