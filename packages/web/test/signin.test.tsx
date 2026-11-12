import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useSession } from "../src/lib/session";
import { SignIn } from "../src/screens/SignIn";
import { fakeFetch, fakeTurnstile, renderAt } from "./helpers";

const SUBMIT = "खेल्न जानुहोस्";
const NAME = "तपाईंको नाम";

describe("sign-in form", () => {
  it("stays disabled until there is a name and a Turnstile token, then posts both", async () => {
    const turnstile = fakeTurnstile("tok-123");
    const calls = fakeFetch({
      "POST /session/guest": () => ({ status: 201, json: { id: "acc1", name: "Sita", balance: 1000 } }),
    });
    renderAt(<SignIn siteKey="site-key-x" />);
    const submit = screen.getByRole("button", { name: SUBMIT });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(NAME), "Sita");
    await waitFor(() => expect(submit).toBeEnabled());
    expect(turnstile.render).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ sitekey: "site-key-x" }));

    await userEvent.click(submit);
    await waitFor(() => expect(useSession.getState().status).toBe("signedIn"));
    expect(calls).toEqual([{ method: "POST", path: "/session/guest", body: { name: "Sita", turnstileToken: "tok-123" } }]);
    expect(useSession.getState().me).toEqual({ id: "acc1", name: "Sita", balance: 1000 });
  });

  it("does not submit a name shorter than 3 characters", async () => {
    fakeTurnstile();
    fakeFetch({});
    renderAt(<SignIn siteKey="k" />);
    await userEvent.type(screen.getByLabelText(NAME), "ab");
    expect(screen.getByRole("button", { name: SUBMIT })).toBeDisabled();
  });

  it("shows the server's refusal in Nepali and asks Turnstile for a fresh token", async () => {
    const turnstile = fakeTurnstile();
    fakeFetch({ "POST /session/guest": () => ({ status: 400, json: { error: "bad-name" } }) });
    renderAt(<SignIn siteKey="k" />);
    await userEvent.type(screen.getByLabelText(NAME), "Sita");
    const submit = screen.getByRole("button", { name: SUBMIT });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("यो नाम मिलेन");
    expect(turnstile.reset).toHaveBeenCalledWith("widget-1");
    expect(useSession.getState().status).toBe("signedOut");
  });

  it("never renders a server error as markup", async () => {
    fakeTurnstile();
    fakeFetch({ "POST /session/guest": () => ({ status: 500, json: { error: "<img src=x onerror=alert(1)>" } }) });
    const { container } = renderAt(<SignIn siteKey="k" />);
    await userEvent.type(screen.getByLabelText(NAME), "Sita");
    const submit = screen.getByRole("button", { name: SUBMIT });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    // An odd code is not even passed through: api.ts keeps only [a-z0-9-] codes.
    expect(await screen.findByRole("alert")).toHaveTextContent("http-500");
    expect(container.querySelector("img")).toBeNull();
  });
});
