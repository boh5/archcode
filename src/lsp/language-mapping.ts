/**
 * Mapping from file extension to LSP language id.
 *
 * This is used to determine which language server to spawn for a given file.
 * Extensions are stored **without** a leading dot in the key space for
 * consistency of lookups via `getLanguageIdFromExtension()`.
 */

// ─── Mapping ───

const EXTENSION_TO_LANGUAGE_ID: Record<string, string> = {
  // TypeScript / JavaScript
  ts: "typescript",
  tsx: "typescriptreact",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",

  // Python
  py: "python",
  pyw: "python",

  // Go
  go: "go",

  // Rust
  rs: "rust",

  // C
  c: "c",
  h: "c",

  // C++
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",

  // Java
  java: "java",

  // C#
  cs: "csharp",

  // Ruby
  rb: "ruby",

  // PHP
  php: "php",

  // Swift
  swift: "swift",

  // Kotlin
  kt: "kotlin",
  kts: "kotlin",

  // Dart
  dart: "dart",

  // Lua
  lua: "lua",

  // YAML
  yaml: "yaml",
  yml: "yaml",

  // JSON
  json: "json",
  jsonc: "jsonc",

  // CSS / SCSS / Less
  css: "css",
  scss: "scss",
  less: "less",

  // HTML
  html: "html",
  htm: "html",

  // Dockerfile
  dockerfile: "dockerfile",

  // GraphQL
  graphql: "graphql",
  gql: "graphql",

  // Shell
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",

  // Markdown
  md: "markdown",
  mdx: "markdown",

  // SQL
  sql: "sql",

  // TOML
  toml: "toml",

  // Makefile
  mk: "makefile",
  mak: "makefile",

  // CMake
  cmake: "cmake",

  // Protocol Buffers
  proto: "proto",

  // Terraform
  tf: "terraform",
  tfvars: "terraform",

  // PowerShell
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",

  // Perl
  pl: "perl",
  pm: "perl",

  // R
  r: "r",
  rmd: "rmarkdown",

  // Haskell
  hs: "haskell",
  lhs: "haskell",

  // Scala
  scala: "scala",
  sc: "scala",

  // Elixir
  ex: "elixir",
  exs: "elixir",

  // Erlang
  erl: "erlang",
  hrl: "erlang",

  // Clojure
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",

  // F#
  fs: "fsharp",
  fsx: "fsharp",

  // Objective-C
  m: "objective-c",
  mm: "objective-cpp",

  // Vue
  vue: "vue",

  // Svelte
  svelte: "svelte",

  // Reason / OCaml
  re: "reason",
  ml: "ocaml",
  mli: "ocaml",

  // Nim
  nim: "nim",

  // Zig
  zig: "zig",

  // Crystal
  cr: "crystal",

  // Gleam
  gleam: "gleam",
};

// ─── Lookup ───

/**
 * Return the LSP language id for a file extension.
 *
 * The extension may be provided with or without a leading dot.
 * Returns `undefined` for unknown extensions.
 *
 * @example
 *   getLanguageIdFromExtension(".ts")     // "typescript"
 *   getLanguageIdFromExtension("ts")       // "typescript"
 *   getLanguageIdFromExtension(".xyz")     // undefined
 */
export function getLanguageIdFromExtension(ext: string): string | undefined {
  const normalized = ext.startsWith(".") ? ext.slice(1) : ext;
  return EXTENSION_TO_LANGUAGE_ID[normalized];
}

/**
 * Convenience: for a full filename, extract the extension and look up the
 * language id.
 *
 * @example
 *   getLanguageIdFromFilename("main.ts")    // "typescript"
 *   getLanguageIdFromFilename("main.jsx")   // "javascriptreact"
 */
export function getLanguageIdFromFilename(filename: string): string | undefined {
  // Handle .dockerfile as a whole-filename extension
  const base = filename.split("/").pop() ?? filename;
  if (base === "Dockerfile" || base === "dockerfile") {
    return "dockerfile";
  }

  const dotIndex = base.lastIndexOf(".");
  if (dotIndex < 0) return undefined;

  const ext = base.slice(dotIndex);
  return getLanguageIdFromExtension(ext);
}

export { EXTENSION_TO_LANGUAGE_ID };
