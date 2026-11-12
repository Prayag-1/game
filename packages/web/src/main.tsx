import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { initI18n } from "./i18n";
import "./index.css";

initI18n();

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
