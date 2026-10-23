import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { BootSplash } from "./components/boot-splash";
import { ErrorBoundary } from "./components/error-boundary";

// BootSplash sits ABOVE the router (a sibling of App), so only a genuine page
// load remounts it — in-app navigation never does. It's a fixed overlay, so
// App renders and starts fetching underneath it at the same time.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BootSplash />
    {/* the last line of defence: never a blank page */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
