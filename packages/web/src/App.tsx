import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes } from "react-router";
import { Header } from "./components/Header";
import { normaliseCode } from "./lib/api";
import { useSession } from "./lib/session";
import { Lobby } from "./screens/Lobby";
import { SignIn } from "./screens/SignIn";
import { TablePlaceholder } from "./screens/TablePlaceholder";

/** A shared link, /?code=XXXXXX: kept for after sign-in, and taken off the URL so a refresh does not re-join. */
export function takeCodeFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("code");
  if (raw === null) return;
  const code = normaliseCode(raw);
  if (code.length === 6) useSession.getState().setPendingCode(code);
  params.delete("code");
  const rest = params.toString();
  window.history.replaceState(window.history.state, "", window.location.pathname + (rest === "" ? "" : `?${rest}`));
}

export function App() {
  const { t } = useTranslation();
  const status = useSession((s) => s.status);

  useEffect(() => {
    takeCodeFromUrl();
    void useSession.getState().load();
  }, []);

  return (
    <div className="min-h-dvh pb-[env(safe-area-inset-bottom)]">
      <Header />
      {status === "loading" ? (
        <p className="p-6 text-center text-stone-600" role="status">
          {t("lobby.busy")}
        </p>
      ) : status === "signedOut" ? (
        <Routes>
          <Route path="/" element={<SignIn />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      ) : (
        <Routes>
          <Route path="/" element={<Lobby />} />
          <Route path="/table/:tableId" element={<TablePlaceholder />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </div>
  );
}
