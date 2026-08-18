import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./ui/App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles.css";

// The boundary wraps App rather than sitting inside it: the crash that motivated
// it was in the TITLEBAR, which is shell rather than panel, so a boundary around
// each workspace would have caught nothing. Outside StrictMode for the same
// reason it is outside App — it has to survive whatever it is catching.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </ErrorBoundary>
);
