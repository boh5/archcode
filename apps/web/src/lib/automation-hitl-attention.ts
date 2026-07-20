import type { Automation, AutomationInvocation } from "@archcode/protocol";
import type { ScopedHitlView } from "../store/hitl-store";

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
  invocations: readonly AutomationInvocation[],
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

  for (const invocation of invocations) {
    if (!invocation.sessionId || seenSessions.has(invocation.sessionId)) continue;
    const linked = entries.filter((entry) => (
      entry.projectSlug === automation.projectSlug
      && entry.rootSessionId === invocation.sessionId
    ));
    if (linked.length === 0) continue;
    seenSessions.add(invocation.sessionId);
    sessions.push({ invocationId: invocation.id, sessionId: invocation.sessionId, entries: linked });
  }

  return { kind: "start_session", sessions };
}

export function automationHitlSessionCount(attention: AutomationHitlAttention): number {
  if (attention.kind === "start_session") return attention.sessions.length;
  return attention.entries.length > 0 ? 1 : 0;
}
