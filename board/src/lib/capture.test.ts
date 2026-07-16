import { describe, it, expect } from "vitest";
import {
  buildAllowlist,
  summarizeAllowlist,
  DEFAULT_MAX_BYTES,
  type CaptureAllowlist,
} from "./capture";

describe("buildAllowlist", () => {
  it("returns an empty allowlist with the default max_bytes when nothing selected", () => {
    expect(buildAllowlist([])).toEqual({
      mime: [],
      ext: [],
      max_bytes: DEFAULT_MAX_BYTES,
    });
  });

  it("maps Google Docs to its mime type with no extension", () => {
    expect(buildAllowlist(["gdoc"])).toEqual({
      mime: ["application/vnd.google-apps.document"],
      ext: [],
      max_bytes: DEFAULT_MAX_BYTES,
    });
  });

  it("maps PDF to both a mime type and an extension", () => {
    expect(buildAllowlist(["pdf"])).toEqual({
      mime: ["application/pdf"],
      ext: ["pdf"],
      max_bytes: DEFAULT_MAX_BYTES,
    });
  });

  it("maps extension-only types (md, docx, txt) to ext fragments only", () => {
    expect(buildAllowlist(["md", "docx", "txt"])).toEqual({
      mime: [],
      ext: ["md", "docx", "txt"],
      max_bytes: DEFAULT_MAX_BYTES,
    });
  });

  it("merges multiple selections and preserves option order", () => {
    expect(buildAllowlist(["pdf", "gdoc"])).toEqual({
      mime: ["application/vnd.google-apps.document", "application/pdf"],
      ext: ["pdf"],
      max_bytes: DEFAULT_MAX_BYTES,
    });
  });

  it("respects a custom max_bytes", () => {
    expect(buildAllowlist(["md"], 2048).max_bytes).toBe(2048);
  });

  it("ignores unknown keys", () => {
    expect(buildAllowlist(["bogus", "pdf"]).mime).toEqual(["application/pdf"]);
  });

  it("accepts a Set as the selection source", () => {
    expect(buildAllowlist(new Set(["md"])).ext).toEqual(["md"]);
  });
});

describe("summarizeAllowlist", () => {
  it("renders a dash for null", () => {
    expect(summarizeAllowlist(null)).toBe("—");
  });

  it("renders 'any' for an empty allowlist", () => {
    const empty: CaptureAllowlist = { mime: [], ext: [], max_bytes: DEFAULT_MAX_BYTES };
    expect(summarizeAllowlist(empty)).toBe("any");
  });

  it("labels recognised file types", () => {
    expect(summarizeAllowlist(buildAllowlist(["gdoc", "pdf"]))).toBe("Google Docs, PDF");
  });

  it("falls back to a count for unrecognised fragments", () => {
    const exotic: CaptureAllowlist = {
      mime: ["application/x-custom"],
      ext: ["xyz"],
      max_bytes: DEFAULT_MAX_BYTES,
    };
    expect(summarizeAllowlist(exotic)).toBe("2 type(s)");
  });
});
