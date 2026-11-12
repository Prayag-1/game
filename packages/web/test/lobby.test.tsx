import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useSession } from "../src/lib/session";
import { Lobby } from "../src/screens/Lobby";
import { fakeFetch, renderAt } from "./helpers";

const me = { id: "acc1", name: "Sita", balance: 1000 };
const table = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  visibility: "public",
  preset: "default",
  humans: 1,
  bots: 3,
  chyakhe: 2,
  phase: "betting",
  stake: 10,
  room: 10,
  ...extra,
});
const withTables = (tables: unknown[], more: Parameters<typeof fakeFetch>[0] = {}) =>
  fakeFetch({
    "GET /session/me": () => ({ status: 200, json: me }),
    "GET /tables": () => ({ status: 200, json: { tables } }),
    ...more,
  });

describe("lobby table list", () => {
  it("lists the public tables from GET /tables, with a Join button or Full", async () => {
    useSession.setState({ status: "signedIn", me });
    withTables([table("abcdef123"), table("zzzzzz999", { room: 0, preset: "simple", phase: "throwing" })]);
    renderAt(<Lobby />);
    const rows = await screen.findAllByTestId("table-row");
    expect(rows).toHaveLength(2);
    const [open, full] = rows as [HTMLElement, HTMLElement];

    expect(within(open).getByText("टेबल abcdef")).toBeInTheDocument();
    expect(within(open).getByText(/पूरा नियम · बाजी राख्दै/)).toBeInTheDocument();
    expect(within(open).getByRole("button", { name: "हाते" })).toHaveAttribute("title", "Hate: the four players seated inside");
    expect(within(open).getByRole("button", { name: "च्याँखे" })).toBeInTheDocument();
    expect(within(open).getByRole("button", { name: "जोडिनुहोस्" })).toBeEnabled();

    expect(within(full).getByText(/सरल · कौडा फाल्दै/)).toBeInTheDocument();
    expect(within(full).getByRole("button", { name: "भरिएको" })).toBeDisabled();
  });

  it("says so when there are no public tables", async () => {
    useSession.setState({ status: "signedIn", me });
    withTables([]);
    renderAt(<Lobby />);
    expect(await screen.findByText(/अहिले कुनै सार्वजनिक टेबल छैन/)).toBeInTheDocument();
  });

  it("drops malformed rows instead of rendering them", async () => {
    useSession.setState({ status: "signedIn", me });
    withTables([table("good01"), { id: "<b>x</b>", humans: "lots" }]);
    renderAt(<Lobby />);
    await waitFor(() => expect(screen.getAllByTestId("table-row")).toHaveLength(1));
  });

  it("keeps the code to the code alphabet, and shows the server's refusal for a wrong one", async () => {
    useSession.setState({ status: "signedIn", me });
    const calls = withTables([], { "POST /tables/join": () => ({ status: 404, json: { error: "not-found" } }) });
    renderAt(<Lobby />);
    const input = screen.getByLabelText("टेबल कोड");
    await userEvent.type(input, "k7r-m2q0");
    expect(input).toHaveValue("K7RM2Q");
    await userEvent.click(screen.getByRole("button", { name: "जोडिनुहोस्" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("त्यो कोडको टेबल छैन।");
    expect(calls.find((c) => c.path === "/tables/join")?.body).toEqual({ code: "K7RM2Q" });
  });

  it("joins a shared link's code once, right after sign-in", async () => {
    useSession.setState({ status: "signedIn", me, pendingCode: "K7RM2Q" });
    const calls = withTables([], { "POST /tables/join": () => ({ status: 404, json: { error: "not-found" } }) });
    renderAt(<Lobby />);
    expect(await screen.findByRole("alert")).toHaveTextContent("त्यो कोडको टेबल छैन।");
    expect(calls.filter((c) => c.path === "/tables/join")).toEqual([{ method: "POST", path: "/tables/join", body: { code: "K7RM2Q" } }]);
    expect(useSession.getState().pendingCode).toBeNull();
  });
});
