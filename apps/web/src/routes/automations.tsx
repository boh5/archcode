import { Link, useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { useAutomations } from "../api/queries";
import { useCreateSession, usePostMessage } from "../api/mutations";
import type { Automation, AutomationTrigger } from "../api/types";

export function AutomationsRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useAutomations(slug);
  const createSession = useCreateSession();
  const postMessage = usePostMessage();
  const startAutomationSession = () => {
    createSession.mutate({ slug }, {
      onSuccess: (session) => {
        navigate(`/projects/${slug}/sessions/${session.sessionId}`);
        postMessage.mutate({
          slug,
          sessionId: session.sessionId,
          content: "/skill use automation-create",
        });
      },
    });
  };
  return <div className="flex h-full flex-col"><header className="flex h-12 items-center justify-between border-b border-border-subtle px-4"><h1 className="font-semibold">Automations</h1><button onClick={startAutomationSession} disabled={createSession.isPending} className="inline-flex items-center gap-1 rounded-sm bg-accent px-3 py-1.5 text-sm text-bg-base disabled:opacity-50"><Plus size={14} /> New Automation</button></header>
    <main className="flex-1 overflow-y-auto">{isLoading ? <p className="p-4 text-text-tertiary">Loading automations…</p> : error ? <p className="p-4 text-error">Failed to load automations</p> : !data?.length ? <div className="flex h-full flex-col items-center justify-center gap-3"><h2 className="text-lg">No automations yet</h2><p className="max-w-sm text-center text-sm text-text-tertiary">Schedule a normal Session message for later or on a recurring cadence.</p><button onClick={startAutomationSession} disabled={createSession.isPending} className="inline-flex items-center gap-1 rounded-sm bg-accent px-3 py-1.5 text-sm text-bg-base disabled:opacity-50"><Plus size={14} /> New Automation</button></div> : data.map((automation) => <AutomationRow key={automation.id} slug={slug} automation={automation} />)}</main>
  </div>;
}

function AutomationRow({ slug, automation }: { slug: string; automation: Automation }) {
  return <Link to={`/projects/${slug}/automations/${automation.id}`} className="block border-b border-border-subtle px-4 py-3 hover:bg-bg-hover"><div className="flex items-center justify-between gap-3"><span className="font-medium">{automation.name}</span><span className="text-xs text-text-tertiary">{automation.status}</span></div><div className="mt-1 text-xs text-text-muted">{formatTrigger(automation.trigger)} · {automation.action.kind === "start_session" ? "Start Session" : "Send message"}{automation.nextFireAt ? ` · next ${new Date(automation.nextFireAt).toLocaleString()}` : ""}</div></Link>;
}

export function formatTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "once") return `Once ${new Date(trigger.at).toLocaleString()}`;
  if (trigger.kind === "interval") return `Every ${trigger.everyMs} ms`;
  return `Cron ${trigger.expression} (${trigger.timezone})`;
}
