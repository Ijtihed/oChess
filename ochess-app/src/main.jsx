import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initMonitoring } from "./lib/monitoring";

// Boot monitoring before React mounts so Sentry catches errors that
// happen during the initial render. The init is async + opt-in: a
// no-op when neither VITE_SENTRY_DSN nor VITE_POSTHOG_KEY is set.
initMonitoring();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
