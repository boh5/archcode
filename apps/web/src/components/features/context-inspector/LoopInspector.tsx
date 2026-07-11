import { Link, useParams } from "react-router-dom";
import { useLoop } from "../../../api/queries";
import type { LoopRunReport, LoopScheduleSpec } from "../../../api/types";
import { deriveLoopStatus } from "../../../lib/loop-status";
import { InspectorNotice, InspectorParagraph, InspectorRows, InspectorSection } from "./InspectorPrimitives";

export type LoopInspectorTab = "status" | "schedule" | "config";

export function LoopInspector({ activeTab }: { activeTab: LoopInspectorTab }) {
  const { slug = "", loopId = "" } = useParams<{ slug: string; loopId: string }>();
  const { data: loop, isLoading } = useLoop(slug, loopId);
  if (isLoading) return <InspectorNotice>Loading loop…</InspectorNotice>;
  if (!loop) return <InspectorNotice>Loop context unavailable</InspectorNotice>;

  if (activeTab === "status") {
    const status = deriveLoopStatus(loop);
    return (
      <div className="space-y-4">
        <InspectorRows rows={[
          ["Status", status.label],
          ["Activity", status.activity],
          ["Attention", loop.attentionStatus ?? "clear"],
          ["Runs", String(loop.runCount)],
        ]} />
        <LinkedRunResources slug={slug} label="Current resources" run={loop.currentRun} />
        <LinkedRunResources slug={slug} label="Last resources" run={loop.lastRun} />
        {loop.currentRun?.summary && <InspectorSection title="Current run"><InspectorParagraph>{loop.currentRun.summary}</InspectorParagraph></InspectorSection>}
        {loop.lastRun?.summary && <InspectorSection title="Last run"><InspectorParagraph>{loop.lastRun.summary}</InspectorParagraph></InspectorSection>}
        {loop.generatedStateSummary && <InspectorSection title="State"><InspectorParagraph>{loop.generatedStateSummary}</InspectorParagraph></InspectorSection>}
      </div>
    );
  }

  if (activeTab === "schedule") {
    const schedule = formatSchedule(loop.config.schedule);
    return <InspectorRows rows={[
      ["Mode", schedule],
      ["Next run", loop.nextRunAt ? new Date(loop.nextRunAt).toLocaleString() : "not scheduled"],
      ["Last scheduled", loop.lastScheduledAt ? new Date(loop.lastScheduledAt).toLocaleString() : "never"],
      ["Missed", String(loop.missedCount ?? 0)],
    ]} />;
  }

  if (activeTab === "config") {
    const limits = loop.config.limits;
    return (
      <div className="space-y-4">
        <InspectorRows rows={[
          ["Template", loop.config.templateId.replaceAll("_", " ")],
          ["Approval", loop.config.approvalPolicy],
          ["Worktree", loop.config.useWorktree ? "enabled" : "disabled"],
          ["Schedule", formatSchedule(loop.config.schedule)],
          ["Iterations / run", String(limits.maxIterationsPerRun)],
          ["Tokens / run", limits.maxTokensPerRun?.toLocaleString() ?? "not limited"],
          ["Estimated USD / run", limits.maxEstimatedUsdPerRun !== undefined ? `$${limits.maxEstimatedUsdPerRun.toLocaleString()}` : "not limited"],
          ["Max wall clock", limits.maxWallClockMsPerRun !== undefined ? `${limits.maxWallClockMsPerRun.toLocaleString()} ms` : "not limited"],
          ["Runs / day", limits.maxRunsPerDay?.toLocaleString() ?? "not limited"],
          ["Soft / hard threshold", `${limits.softThresholdRatio} / ${limits.hardThresholdRatio}`],
          ["Triggers", String(loop.config.triggers?.length ?? 0)],
        ]} />
        {loop.config.taskPrompt && <InspectorSection title="Task prompt"><InspectorParagraph>{loop.config.taskPrompt}</InspectorParagraph></InspectorSection>}
        {loop.config.goalTemplate && (
          <>
            {loop.config.goalTemplate.title && <InspectorSection title="Goal title"><InspectorParagraph>{loop.config.goalTemplate.title}</InspectorParagraph></InspectorSection>}
            <InspectorSection title="Goal objective"><InspectorParagraph>{loop.config.goalTemplate.objective}</InspectorParagraph></InspectorSection>
            <InspectorSection title="Goal criteria"><InspectorParagraph>{loop.config.goalTemplate.acceptanceCriteria}</InspectorParagraph></InspectorSection>
          </>
        )}
      </div>
    );
  }

  return assertNever(activeTab);
}

function LinkedRunResources({ slug, label, run }: { slug: string; label: string; run: LoopRunReport | undefined }) {
  return (
    <InspectorSection title={label}>
      {!run?.sessionId && !run?.goalId ? (
        <InspectorParagraph>None</InspectorParagraph>
      ) : (
        <div className="flex flex-wrap gap-2 text-xs">
          {run.sessionId && (
            <Link className="text-accent hover:underline" to={`/projects/${slug}/sessions/${run.sessionId}`}>
              session {run.sessionId}
            </Link>
          )}
          {run.goalId && (
            <Link className="text-accent hover:underline" to={`/projects/${slug}/goals/${run.goalId}`}>
              goal {run.goalId}
            </Link>
          )}
        </div>
      )}
    </InspectorSection>
  );
}

function formatSchedule(schedule: LoopScheduleSpec): string {
  if (schedule.kind === "manual") return "Manual";
  if (schedule.kind === "interval") return `Every ${schedule.everyMs} ms`;
  return `Cron UTC ${schedule.expression}`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Loop inspector tab: ${String(value)}`);
}
