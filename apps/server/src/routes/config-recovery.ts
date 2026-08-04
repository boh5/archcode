import { Hono } from "hono";
import type {
  ConfigRecoveryActionResponse,
  ConfigRecoveryRemovableItem,
  ConfigRecoveryStatus,
  RemoveInvalidConfigItemsRequest,
  ResetInvalidConfigRequest,
  ServerConfigValidationIssue,
} from "@archcode/protocol";
import type { InvalidConfigRemovalPlan } from "@archcode/agent-core";
import { assertMutationOrigin } from "../auth-http";
import type { AuthSession } from "../server-auth-service";
import { writeSessionCookie } from "../auth-http";
import { BadRequestError } from "../errors";
import { readBoundedJsonBody } from "../request-body";

const RESET_BODY_MAX_BYTES = 256;
const REMOVE_ITEMS_BODY_MAX_BYTES = 4_096;

export interface ConfigRecoveryActionResult {
  response: ConfigRecoveryActionResponse;
  session?: AuthSession;
}

export interface ConfigRecoveryCoordinatorPort {
  getConfigRecoveryStatus(authorization: string | undefined): ConfigRecoveryStatus;
  retryConfigRecovery(authorization: string | undefined): Promise<ConfigRecoveryActionResult>;
  removeInvalidConfigItems(
    authorization: string | undefined,
    request: RemoveInvalidConfigItemsRequest,
  ): Promise<ConfigRecoveryActionResult>;
  resetInvalidConfig(
    authorization: string | undefined,
    request: ResetInvalidConfigRequest,
  ): Promise<ConfigRecoveryActionResult>;
}

export function createConfigRecoveryRoutes(
  coordinator: ConfigRecoveryCoordinatorPort,
  options: { readonly dev?: boolean } = {},
): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(
    coordinator.getConfigRecoveryStatus(c.req.header("Authorization")),
  ));

  app.post("/retry", async (c) => {
    assertMutationOrigin(c.req.raw, options);
    const result = await coordinator.retryConfigRecovery(
      c.req.header("Authorization"),
    );
    if (result.session !== undefined) writeSessionCookie(c, result.session);
    return c.json(result.response);
  });

  app.post("/reset", async (c) => {
    assertMutationOrigin(c.req.raw, options);
    const request = parseResetRequest(await readBoundedJsonBody(c.req.raw, {
      maxBytes: RESET_BODY_MAX_BYTES,
      label: "Config reset request",
    }));
    const result = await coordinator.resetInvalidConfig(
      c.req.header("Authorization"),
      request,
    );
    return c.json(result.response);
  });

  app.post("/remove-items", async (c) => {
    assertMutationOrigin(c.req.raw, options);
    const request = parseRemoveItemsRequest(await readBoundedJsonBody(c.req.raw, {
      maxBytes: REMOVE_ITEMS_BODY_MAX_BYTES,
      label: "Config item removal request",
    }));
    const result = await coordinator.removeInvalidConfigItems(
      c.req.header("Authorization"),
      request,
    );
    if (result.session !== undefined) writeSessionCookie(c, result.session);
    return c.json(result.response);
  });

  return app;
}

export function safeConfigRecoveryStatus(
  configPath: string,
  issues: readonly ServerConfigValidationIssue[],
  plan: InvalidConfigRemovalPlan = { items: [] },
): ConfigRecoveryStatus {
  return {
    configPath,
    issues: issues.map((issue) => ({
      path: safeIssuePath(issue.path, configPath),
      message: safeIssueMessage(issue.message),
    })),
    ...(plan.revision === undefined ? {} : { revision: plan.revision }),
    removableItems: safeRemovableItems(plan.items, configPath),
  };
}

function safeRemovableItems(
  items: InvalidConfigRemovalPlan["items"],
  configPath: string,
): ConfigRecoveryRemovableItem[] {
  const baseLabels = items.map((item) => removableItemPresentation(item.path, configPath));
  const totals = new Map<string, number>();
  for (const item of baseLabels) totals.set(item.label, (totals.get(item.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const presentation = baseLabels[index]!;
    const ordinal = (seen.get(presentation.label) ?? 0) + 1;
    seen.set(presentation.label, ordinal);
    return {
      id: item.id,
      label: (totals.get(presentation.label) ?? 0) > 1
        ? `${presentation.label} ${ordinal}`
        : presentation.label,
      path: presentation.path,
      impact: presentation.impact,
    };
  });
}

function removableItemPresentation(
  rawPath: readonly string[],
  configPath: string,
): Omit<ConfigRecoveryRemovableItem, "id"> {
  const [root] = rawPath;
  if (root === "provider" && rawPath[2] === "models" && rawPath[4] === "variants") {
    return {
      label: "Invalid model variant",
      path: "provider.<provider>.models.<model>.variants.<variant>",
      impact: "Removes this invalid variant only. The provider and model remain configured.",
    };
  }
  if (root === "provider" && rawPath[2] === "models") {
    return {
      label: "Invalid model entry",
      path: "provider.<provider>.models.<model>",
      impact: "Removes this invalid model and its variants. Other models remain configured.",
    };
  }
  if (root === "provider" && rawPath[2] === "options") {
    return {
      label: "Invalid provider option",
      path: "provider.<provider>.options.<option>",
      impact: "Removes this invalid option only. The provider and its models remain configured.",
    };
  }
  if (root === "provider") {
    return {
      label: "Invalid provider entry",
      path: "provider.<provider>",
      impact: "Removes this provider and its models. Other providers remain configured.",
    };
  }
  if (root === "mcp" && rawPath[1] === "servers") {
    return {
      label: "Invalid MCP server",
      path: "mcp.servers.<server>",
      impact: "Removes this MCP server only. Other MCP servers remain configured.",
    };
  }
  if (root === "memory") {
    return {
      label: "Invalid memory settings",
      path: "memory",
      impact: "Removes the invalid global memory settings. Project Runtime data is not deleted.",
    };
  }
  if (root === "integrations" && rawPath[1] === "github") {
    return {
      label: "Invalid GitHub integration",
      path: "integrations.github",
      impact: "Removes the invalid GitHub integration settings only.",
    };
  }
  return {
    label: "Invalid configuration field",
    path: safeIssuePath(rawPath.join("."), configPath),
    impact: "Removes this invalid field only. Other valid settings remain configured.",
  };
}

function parseRemoveItemsRequest(value: unknown): RemoveInvalidConfigItemsRequest {
  if (!isRecord(value)) throw new BadRequestError("Config item removal request must be an object");
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== "confirmation" || keys[1] !== "expectedRevision" || keys[2] !== "itemIds") {
    throw new BadRequestError("Config item removal request has unexpected fields");
  }
  if (value.confirmation !== "REMOVE_SELECTED_INVALID_CONFIG_ITEMS") {
    throw new BadRequestError("Config item removal confirmation is invalid");
  }
  if (typeof value.expectedRevision !== "string" || value.expectedRevision.length < 16 || value.expectedRevision.length > 128) {
    throw new BadRequestError("Config item removal revision is invalid");
  }
  if (!Array.isArray(value.itemIds) || value.itemIds.length === 0 || value.itemIds.length > 64) {
    throw new BadRequestError("Select between 1 and 64 invalid Config items");
  }
  if (value.itemIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id))) {
    throw new BadRequestError("Config item removal identity is invalid");
  }
  if (new Set(value.itemIds).size !== value.itemIds.length) {
    throw new BadRequestError("Config item removal identities must be unique");
  }
  return {
    expectedRevision: value.expectedRevision,
    itemIds: value.itemIds as string[],
    confirmation: "REMOVE_SELECTED_INVALID_CONFIG_ITEMS",
  };
}

function parseResetRequest(value: unknown): ResetInvalidConfigRequest {
  if (!isRecord(value)) throw new BadRequestError("Config reset request must be an object");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "confirmation") {
    throw new BadRequestError("Config reset request must contain only confirmation");
  }
  if (value.confirmation !== "DELETE_INVALID_CONFIG") {
    throw new BadRequestError("Config reset confirmation is invalid");
  }
  return { confirmation: "DELETE_INVALID_CONFIG" };
}

function safeIssuePath(path: string, configPath: string): string {
  if (path === configPath || path === "") return "configuration";
  const segments = path.split(".");
  if (segments[0] === "provider") {
    const structural = segments[2];
    if (structural === "models") {
      const modelField = segments[4];
      if (modelField === "variants") {
        return "provider.<provider>.models.<model>.variants.<variant>";
      }
      const knownModelFields = new Set(["name", "limit", "modalities", "options"]);
      return knownModelFields.has(modelField ?? "")
        ? ["provider", "<provider>", "models", "<model>", modelField].join(".")
        : "provider.<provider>.models.<model>";
    }
    if (structural === "options") return "provider.<provider>.options.<option>";
    return structural === "npm" || structural === "name"
      ? `provider.<provider>.${structural}`
      : "provider.<provider>";
  }
  if (segments[0] === "mcp" && segments[1] === "servers") {
    const field = segments[3];
    const tail = field === "headers"
      ? ["headers", "<header>"]
      : field === "url" || field === "timeout" ? [field] : [];
    return ["mcp", "servers", "<server>", ...tail].join(".");
  }
  if (segments[0] === "profiles") {
    const profile = new Set(["principal", "deep", "fast"]).has(segments[1] ?? "")
      ? segments[1]!
      : "<profile>";
    const field = segments[2];
    if (field === "options") return `profiles.${profile}.options.<option>`;
    return field === "model" || field === "variant"
      ? `profiles.${profile}.${field}`
      : `profiles.${profile}`;
  }
  if (segments[0] === "memory") {
    const field = segments[1];
    return new Set(["enabled", "minMessages", "minContentLength", "cooldownMs"]).has(field ?? "")
      ? `memory.${field}`
      : "memory.<field>";
  }
  if (segments[0] === "integrations" && segments[1] === "github") {
    const field = segments[2];
    return new Set(["enabled", "tokenEnv", "defaultOwner", "defaultRepo"]).has(field ?? "")
      ? `integrations.github.${field}`
      : "integrations.github.<field>";
  }
  if (segments[0] === "auth") {
    return segments[1] === "passwordHash" ? "auth.passwordHash" : "auth.<field>";
  }
  return "configuration";
}

function safeIssueMessage(message: string): string {
  if (message.includes("Invalid JSON")) return "The file is not valid JSON.";
  if (message.includes("Failed to read")) return "The configuration file could not be read.";
  if (message.includes("Unsupported provider package")) {
    return "A configured provider package is not supported by this ArchCode release.";
  }
  if (message.includes("reserved for a built-in server")) {
    return "A configured MCP server name is reserved by ArchCode.";
  }
  return "This value does not match the current ArchCode configuration format.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
