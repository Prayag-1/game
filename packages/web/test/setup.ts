import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { initI18n } from "../src/i18n";
import { useSession } from "../src/lib/session";
import { resetTableForTests } from "../src/lib/table";

beforeEach(() => {
  localStorage.clear();
  initI18n("ne");
  useSession.setState({ status: "signedOut", me: null, pendingCode: null, notice: null });
  resetTableForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.turnstile;
});
