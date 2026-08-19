import { describe, expect, it } from "vitest";

import { stripLeadingTitleHeading } from "../src/conversion.ts";

describe("stripLeadingTitleHeading", () => {
  it("drops a leading ATX heading equal to the title", () => {
    expect(stripLeadingTitleHeading("# Great Work\n\nBody text.", "Great Work")).toBe(
      "Body text.",
    );
  });

  it("matches the title case-insensitively", () => {
    expect(stripLeadingTitleHeading("# GREAT WORK\n\nBody.", "Great Work")).toBe("Body.");
  });

  it("keeps a heading that differs from the title", () => {
    const markdown = "# Another Heading\n\nBody.";
    expect(stripLeadingTitleHeading(markdown, "Great Work")).toBe(markdown);
  });

  it("drops a leading title-alt image and keeps trailing text on the line", () => {
    expect(
      stripLeadingTitleHeading("![Great Work](https://x/y.gif)July 2023\n\nBody.", "Great Work"),
    ).toBe("July 2023\n\nBody.");
  });

  it("drops a title-alt image that occupies its own line", () => {
    expect(stripLeadingTitleHeading("![Great Work](https://x/y.gif)\n\nBody.", "Great Work")).toBe(
      "Body.",
    );
  });

  it("keeps images whose alt differs from the title", () => {
    const markdown = "![diagram](https://x/y.png)\n\nBody.";
    expect(stripLeadingTitleHeading(markdown, "Great Work")).toBe(markdown);
  });

  it("escapes regex metacharacters in titles", () => {
    expect(stripLeadingTitleHeading("![What? (a study)](https://x)\nBody.", "What? (a study)")).toBe(
      "Body.",
    );
  });

  it("returns the markdown untouched without a title", () => {
    const markdown = "# Anything\n\nBody.";
    expect(stripLeadingTitleHeading(markdown, null)).toBe(markdown);
  });
});
