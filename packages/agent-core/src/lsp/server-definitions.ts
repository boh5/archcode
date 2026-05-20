/**
 * Built-in LSP server definitions.
 *
 * Each entry describes a language server that can be spawned as a subprocess.
 * Servers with `npmPackage` can be auto-installed; servers without it must be
 * available on PATH.
 */

// ─── Types ───

export interface LspServerDefinition {
  /** Unique identifier, e.g. "typescript" */
  id: string;
  /** LSP language IDs this server can handle, e.g. ["typescript", "typescriptreact"] */
  languageIds: string[];
  /** File extensions this server can handle, e.g. [".ts", ".tsx"] */
  extensions: string[];
  /** Command + arguments to spawn, e.g. ["typescript-language-server", "--stdio"] */
  command: string[];
  /** npm package for auto-install (optional — servers without it must be on PATH) */
  npmPackage?: string;
  /** Additional initialization options passed in the initialize request */
  initializationOptions?: Record<string, unknown>;
}

// ─── Built-in definitions ───

export const BUILTIN_SERVER_DEFINITIONS: LspServerDefinition[] = [
  // ── TypeScript / JavaScript ──
  {
    id: "typescript",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"],
    command: ["typescript-language-server", "--stdio"],
    npmPackage: "typescript-language-server",
  },

  // ── Python ──
  {
    id: "python",
    languageIds: ["python"],
    extensions: [".py", ".pyw"],
    command: ["pyright-langserver", "--stdio"],
    npmPackage: "pyright",
  },

  // ── Go ──
  {
    id: "go",
    languageIds: ["go"],
    extensions: [".go"],
    command: ["gopls"],
  },

  // ── Rust ──
  {
    id: "rust",
    languageIds: ["rust"],
    extensions: [".rs"],
    command: ["rust-analyzer"],
  },

  // ── C / C++ ──
  {
    id: "c",
    languageIds: ["c"],
    extensions: [".c", ".h"],
    command: ["clangd"],
  },
  {
    id: "cpp",
    languageIds: ["cpp"],
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    command: ["clangd"],
  },

  // ── Java ──
  {
    id: "java",
    languageIds: ["java"],
    extensions: [".java"],
    command: ["jdtls"],
  },

  // ── C# ──
  {
    id: "csharp",
    languageIds: ["csharp"],
    extensions: [".cs"],
    command: ["omnisharp"],
  },

  // ── Ruby ──
  {
    id: "ruby",
    languageIds: ["ruby"],
    extensions: [".rb"],
    command: ["solargraph", "stdio"],
  },

  // ── PHP ──
  {
    id: "php",
    languageIds: ["php"],
    extensions: [".php"],
    command: ["intelephense", "--stdio"],
    npmPackage: "intelephense",
  },

  // ── Swift ──
  {
    id: "swift",
    languageIds: ["swift"],
    extensions: [".swift"],
    command: ["sourcekit-lsp"],
  },

  // ── Kotlin ──
  {
    id: "kotlin",
    languageIds: ["kotlin"],
    extensions: [".kt", ".kts"],
    command: ["kotlin-language-server"],
  },

  // ── Dart ──
  {
    id: "dart",
    languageIds: ["dart"],
    extensions: [".dart"],
    command: ["dart", "language-server", "--protocol=lsp"],
  },

  // ── Lua ──
  {
    id: "lua",
    languageIds: ["lua"],
    extensions: [".lua"],
    command: ["lua-language-server"],
    npmPackage: "lua-language-server",
  },

  // ── YAML ──
  {
    id: "yaml",
    languageIds: ["yaml"],
    extensions: [".yaml", ".yml"],
    command: ["yaml-language-server", "--stdio"],
    npmPackage: "yaml-language-server",
  },

  // ── JSON ──
  {
    id: "json",
    languageIds: ["json", "jsonc"],
    extensions: [".json", ".jsonc"],
    command: ["vscode-json-languageserver", "--stdio"],
    npmPackage: "vscode-json-languageserver",
  },

  // ── CSS / SCSS / Less ──
  {
    id: "css",
    languageIds: ["css", "scss", "less"],
    extensions: [".css", ".scss", ".less"],
    command: ["vscode-css-languageserver", "--stdio"],
    npmPackage: "vscode-css-languageserver",
  },

  // ── HTML ──
  {
    id: "html",
    languageIds: ["html"],
    extensions: [".html", ".htm"],
    command: ["vscode-html-languageserver", "--stdio"],
    npmPackage: "vscode-html-languageserver",
  },

  // ── Dockerfile ──
  {
    id: "dockerfile",
    languageIds: ["dockerfile"],
    extensions: [".dockerfile"],
    command: ["dockerfile-language-server-nodejs", "--stdio"],
    npmPackage: "dockerfile-language-server-nodejs",
  },

  // ── GraphQL ──
  {
    id: "graphql",
    languageIds: ["graphql"],
    extensions: [".graphql", ".gql"],
    command: ["graphql-language-service"],
    npmPackage: "graphql-language-service",
  },

  // ── Shell ──
  {
    id: "shell",
    languageIds: ["shellscript"],
    extensions: [".sh", ".bash", ".zsh"],
    command: ["bash-language-server", "start"],
    npmPackage: "bash-language-server",
  },
];

// ─── Lookup functions ───

/** Look up a server definition by its unique id. */
export function getServerDefinitionById(id: string): LspServerDefinition | undefined {
  return BUILTIN_SERVER_DEFINITIONS.find((def) => def.id === id);
}

/** Return all server definitions that support the given LSP language id. */
export function getServerDefinitionsForLanguage(
  languageId: string,
): LspServerDefinition[] {
  return BUILTIN_SERVER_DEFINITIONS.filter((def) =>
    def.languageIds.includes(languageId),
  );
}
