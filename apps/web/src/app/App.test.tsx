import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the translator title", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Live Translator" }),
    ).toBeInTheDocument();
  });
});
