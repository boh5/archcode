import type { AutomationTrigger } from "../api/types";

export function formatAutomationTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "once") return `Once ${new Date(trigger.at).toLocaleString()}`;
  if (trigger.kind === "interval") return `Every ${trigger.everyMs} ms`;
  return `Cron ${trigger.expression} (${trigger.timezone})`;
}
