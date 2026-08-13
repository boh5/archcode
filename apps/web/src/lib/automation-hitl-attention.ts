import type { Automation, ProjectSessionInventoryItem } from "@archcode/protocol";
import type { ScopedHitlView } from "../store/hitl-store";

export interface AutomationSessionLink {
  readonly invocationId: string;
  readonly sessionId: string;
  readonly latestExecution: ProjectSessionInventoryItem["latestExecution"];
}

export type AutomationHitlAttention =
  | {
      readonly kind: "start_session";
      readonly sessions: readonly {
        readonly invocationId: string;
        readonly sessionId: string;
        readonly entries: readonly ScopedHitlView[];
      }[];
    }
  | {
      readonly kind: "send_message";
      readonly targetSessionId: string;
      readonly entries: readonly ScopedHitlView[];
    };

/**
 * Derives Automation attention only from its linked ordinary Session families.
 * It never assigns HITL ownership to an Automation or infers Invocation
 * causality for send_message actions.
 */
export function deriveAutomationHitlAttention(
  automation: Automation,
  sessionLinks: readonly AutomationSessionLink[],
  entries: readonly ScopedHitlView[],
): AutomationHitlAttention {
  if (automation.action.kind === "send_message") {
    const targetSessionId = automation.action.sessionId;
    return {
      kind: "send_message",
      targetSessionId,
      entries: entries.filter((entry) => (
        entry.projectSlug === automation.projectSlug
        && (entry.rootSessionId === targetSessionId || entry.ownerSessionId === targetSessionId)
      )),
    };
  }

  const seenSessions = new Set<string>();
  const sessions: Array<{
    invocationId: string;
    sessionId: string;
    entries: readonly ScopedHitlView[];
  }> = [];

  for (const link of sessionLinks) {
    if (seenSessions.has(link.sessionId)) continue;
    const linked = entries.filter((entry) => (
      entry.projectSlug === automation.projectSlug
      && entry.rootSessionId === link.sessionId
    ));
    if (linked.length === 0) continue;
    seenSessions.add(link.sessionId);
    sessions.push({ invocationId: link.invocationId, sessionId: link.sessionId, entries: linked });
  }

  return { kind: "start_session", sessions };
}

/**
 * Builds the exact Automation -> root Session relationship from the one
 * project-level Session inventory. This keeps Automation list presentation
 * free of per-row Invocation or Session requests.
 */
export function indexAutomationSessionLinks(
  items: readonly ProjectSessionInventoryItem[],
): ReadonlyMap<string, readonly AutomationSessionLink[]> {
  const mutable = new Map<string, AutomationSessionLink[]>();
  for (const item of items) {
    const source = item.session.source;
    if (source.kind !== "automation") continue;
    const links = mutable.get(source.automationId) ?? [];
    links.push({
      invocationId: source.invocationId,
      sessionId: item.session.sessionId,
      latestExecution: item.latestExecution,
    });
    mutable.set(source.automationId, links);
  }
  return mutable;
}

export function automationHitlSessionCount(attention: AutomationHitlAttention): number {
  if (attention.kind === "start_session") return attention.sessions.length;
  return attention.entries.length > 0 ? 1 : 0;
}
