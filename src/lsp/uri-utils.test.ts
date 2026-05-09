import { describe, it, expect } from "bun:test";
import { pathToFileUri, fileUriToPath, normalizeFilePath } from "./uri-utils";
import path from "node:path";

describe("pathToFileUri", () => {
  it("converts a simple absolute path", () => {
    const uri = pathToFileUri("/home/user/file.ts");
    expect(uri).toBe("file:///home/user/file.ts");
  });

  it("encodes spaces as %20", () => {
    const uri = pathToFileUri("/home/user/my file.ts");
    expect(uri).toBe("file:///home/user/my%20file.ts");
  });

  it("encodes unicode characters", () => {
    const uri = pathToFileUri("/home/user/文件.ts");
    expect(uri).toContain("%E6%96%87%E4%BB%B6");
  });

  it("encodes special characters", () => {
    const uri = pathToFileUri("/home/user/file#name.ts");
    expect(uri).toContain("file%23name.ts");
  });

  it("normalizes backslashes to forward slashes (Windows compat)", () => {
    const uri = pathToFileUri("C:\\Users\\test\\file.ts");
    expect(uri).not.toContain("\\");
    expect(uri).toContain("C%3A/Users/test/file.ts");
  });
});

describe("fileUriToPath", () => {
  it("converts a simple file URI to a path", () => {
    const p = fileUriToPath("file:///home/user/file.ts");
    expect(p).toBe("/home/user/file.ts");
  });

  it("decodes percent-encoded characters", () => {
    const p = fileUriToPath("file:///home/user/my%20file.ts");
    expect(p).toBe("/home/user/my file.ts");
  });

  it("decodes percent-encoded unicode", () => {
    const p = fileUriToPath("file:///home/user/%E6%96%87%E4%BB%B6.ts");
    expect(p).toBe("/home/user/文件.ts");
  });

  it("decodes %23 back to #", () => {
    const p = fileUriToPath("file:///home/user/file%23name.ts");
    expect(p).toBe("/home/user/file#name.ts");
  });

  it("throws for non-file URI", () => {
    expect(() => fileUriToPath("https://example.com/file.ts")).toThrow(
      "Not a file:// URI",
    );
  });
});

describe("round-trip path ↔ URI", () => {
  it("preserves paths through encode + decode", () => {
    const paths = [
      "/home/user/file.ts",
      "/home/user/my file.ts",
      "/home/user/文件.ts",
      "/home/user/file#name.ts",
      "/home/user/special chars+溢价.ts",
    ];

    for (const originalPath of paths) {
      const uri = pathToFileUri(originalPath);
      const decoded = fileUriToPath(uri);
      expect(decoded).toBe(originalPath);
    }
  });
});

describe("normalizeFilePath", () => {
  const workspace = "/home/user/project";

  it("resolves a relative path against workspace", () => {
    const result = normalizeFilePath("src/main.ts", workspace);
    expect(result).toBe(`${workspace}/src/main.ts`);
  });

  it("resolves ./ prefix", () => {
    const result = normalizeFilePath("./src/main.ts", workspace);
    expect(result).toBe(`${workspace}/src/main.ts`);
  });

  it("normalizes ../ traversal", () => {
    const result = normalizeFilePath("src/../lib/helper.ts", workspace);
    expect(result).toBe(`${workspace}/lib/helper.ts`);
  });

  it("throws when path traverses outside workspace", () => {
    expect(() => normalizeFilePath("../outside.ts", workspace)).toThrow(
      "outside the workspace",
    );
  });

  it("normalizes backslashes to forward slashes", () => {
    const result = normalizeFilePath("src\\main.ts", workspace);
    expect(result).toBe(`${workspace}/src/main.ts`);
    expect(result).not.toContain("\\");
  });

  it("accepts an already-absolute path within workspace", () => {
    const result = normalizeFilePath(`${workspace}/src/main.ts`, workspace);
    expect(result).toBe(`${workspace}/src/main.ts`);
  });
});
