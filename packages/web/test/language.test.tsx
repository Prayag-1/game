import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTranslation } from "react-i18next";
import { describe, expect, it } from "vitest";
import { LanguageToggle } from "../src/components/LanguageToggle";
import { initI18n, savedLanguage } from "../src/i18n";

function Title() {
  const { t } = useTranslation();
  return <h1>{t("app.title")}</h1>;
}

describe("language toggle", () => {
  it("defaults to Nepali", () => {
    render(<Title />);
    expect(screen.getByRole("heading")).toHaveTextContent("कौडा");
    expect(document.documentElement.lang).toBe("ne");
    expect(savedLanguage()).toBe("ne");
  });

  it("switches to English and back, and saves the choice", async () => {
    render(
      <>
        <Title />
        <LanguageToggle />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "भाषा बदल्नुहोस्: English" }));
    expect(screen.getByRole("heading")).toHaveTextContent("Kauda");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("kauda.lang")).toBe("en");

    await userEvent.click(screen.getByRole("button", { name: "Change language: नेपाली" }));
    expect(screen.getByRole("heading")).toHaveTextContent("कौडा");
    expect(localStorage.getItem("kauda.lang")).toBe("ne");
  });

  it("starts in the saved language after a reload", () => {
    localStorage.setItem("kauda.lang", "en");
    initI18n();
    render(<Title />);
    expect(screen.getByRole("heading")).toHaveTextContent("Kauda");
  });

  it("ignores a saved value that is not a supported language", () => {
    localStorage.setItem("kauda.lang", "fr");
    expect(savedLanguage()).toBe("ne");
  });
});
