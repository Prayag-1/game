import { create } from "zustand";
import { api, type Me } from "./api";

/** A message to show once, as an i18n key, so it follows a language switch. */
export interface Notice {
  readonly key: string;
  readonly params?: Readonly<Record<string, string>>;
}

export type SessionStatus = "loading" | "signedOut" | "signedIn";

interface SessionState {
  readonly status: SessionStatus;
  readonly me: Me | null;
  /** A ?code= from a shared link, used once after sign-in. */
  readonly pendingCode: string | null;
  readonly notice: Notice | null;
  /** Asks the server who we are, from the session cookie. */
  load(): Promise<void>;
  /** Creates a guest. Returns the server's error code, or null on success. */
  signIn(name: string, turnstileToken: string): Promise<string | null>;
  /** Revokes the session on the server. Leave the table first (see table.ts). */
  logout(): Promise<void>;
  /** The session is gone (logged out elsewhere, or expired). */
  signedOut(notice?: Notice): void;
  setPendingCode(code: string | null): void;
  takePendingCode(): string | null;
  setNotice(notice: Notice | null): void;
}

export const useSession = create<SessionState>()((set, get) => ({
  status: "loading",
  me: null,
  pendingCode: null,
  notice: null,

  async load() {
    const res = await api.me();
    if (res.ok) set({ status: "signedIn", me: res.value });
    else if (res.status === 401) set({ status: "signedOut", me: null });
    // A network failure while signed in keeps what we had; with nothing yet, show sign-in.
    else if (get().me === null) set({ status: "signedOut" });
  },

  async signIn(name, turnstileToken) {
    const res = await api.createGuest(name, turnstileToken);
    if (!res.ok) return res.error;
    set({ status: "signedIn", me: res.value, notice: null });
    return null;
  },

  async logout() {
    await api.logout();
    set({ status: "signedOut", me: null, notice: { key: "notices.loggedOut" } });
  },

  signedOut(notice) {
    set({ status: "signedOut", me: null, notice: notice ?? { key: "errors.no-session" } });
  },

  setPendingCode(code) {
    set({ pendingCode: code });
  },

  takePendingCode() {
    const code = get().pendingCode;
    set({ pendingCode: null });
    return code;
  },

  setNotice(notice) {
    set({ notice });
  },
}));
