import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { BootSplash } from "./components/boot-splash";

// BootSplash sits ABOVE the router (a sibling of App), so only a genuine page
// load remounts it — in-app navigation never does. It's a fixed overlay, so
// App renders and starts fetching underneath it at the same time.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BootSplash />
    <App />
  </StrictMode>,
);
