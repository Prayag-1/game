import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type { TurnstileApi } from "../src/components/Turnstile";

type Reply = { status: number; json?: unknown };

/** A fake fetch: answers by "METHOD /path", records every call. */
export function fakeFetch(routes: Record<string, (body: unknown) => Reply>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: input, body });
    const route = routes[`${method} ${input}`];
    const reply: Reply = route === undefined ? { status: 404, json: { error: "not-found" } } : route(body);
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

/** A Turnstile that hands over `token` as soon as it renders. */
export function fakeTurnstile(token = "test-token") {
  const api: TurnstileApi = {
    render: vi.fn((_el: HTMLElement, opts: Parameters<TurnstileApi["render"]>[1]) => {
      queueMicrotask(() => opts.callback(token));
      return "widget-1";
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = api;
  return api;
}

export function renderAt(ui: ReactElement, path = "/") {
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
}
