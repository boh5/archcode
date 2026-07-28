import type { Automation, Project, SessionSummaryWithGoal } from "../../api/types";
import { useDeleteSession } from "../../api/mutations";
import { useSessionTree } from "../../api/queries";
import type { SessionTreeNode } from "@archcode/protocol";
import { DestructiveActionDialog } from "./DestructiveActionDialog";

interface DeleteSessionDialogProps {
  automations: readonly Automation[];
  open: boolean;
  project: Project;
  session: SessionSummaryWithGoal;
  onClose: () => void;
  onDeleted: (session: SessionSummaryWithGoal) => void;
}

export function DeleteSessionDialog({
  automations,
  open,
  project,
  session,
  onClose,
  onDeleted,
}: DeleteSessionDialogProps) {
  const tree = useSessionTree(project.slug, session.rootSessionId);
  const remove = useDeleteSession();
  const sessionIds = tree.data ? flattenSessionTreeIds(tree.data.root) : [session.sessionId];
  const descendantCount = Math.max(0, sessionIds.length - 1);
  const targetingAutomations = automations.filter((automation) => (
    automation.action.kind === "send_message"
    && sessionIds.includes(automation.action.sessionId)
  ));
  const worktreeRetained = session.cwd !== project.workspaceRoot;
  const error = tree.error instanceof Error
    ? `Unable to inspect the Session family: ${tree.error.message}`
    : remove.error instanceof Error
      ? remove.error.message
      : remove.error
        ? "Failed to delete Session"
        : null;

  return (
    <DestructiveActionDialog
      open={open}
      title="Delete Session?"
      description="The Session and its complete Agent workstream will be removed."
      subject={session.title || "Untitled Session"}
      confirmLabel="Delete Session"
      pendingLabel="Deleting…"
      consequences={[
        `Conversation history, Goal, and ${descendantCount === 0 ? "all delegated Agent records" : `${descendantCount} delegated Agent Session${descendantCount === 1 ? "" : "s"}`}`,
        "Pending approvals, questions, tool output, and uploaded attachments",
      ]}
      note={(
        <div className="space-y-1">
          <p>Running work will be stopped before deletion. Project files and Git history are never rolled back.</p>
          {worktreeRetained ? (
            <p>
              The Session working directory will be preserved at{" "}
              <span className="break-all font-mono text-[11px] text-text-primary">{session.cwd}</span>.
            </p>
          ) : null}
        </div>
      )}
      blocked={tree.isLoading || tree.error !== null || targetingAutomations.length > 0}
      blockedMessage={targetingAutomations.length > 0 ? (
        <p>
          This Session is targeted by{" "}
          <span className="font-semibold">
            {targetingAutomations.map((automation) => automation.name).join(", ")}
          </span>
          . Update or delete {targetingAutomations.length === 1 ? "that Automation" : "those Automations"} first.
        </p>
      ) : tree.isLoading ? (
        <p>Inspecting delegated Agent Sessions before deletion…</p>
      ) : undefined}
      error={error}
      pending={remove.isPending}
      onClose={onClose}
      onConfirm={() => remove.mutate(
        {
          slug: project.slug,
          sessionId: session.sessionId,
          rootSessionId: session.rootSessionId,
          sessionIds,
        },
        { onSuccess: () => onDeleted(session) },
      )}
    />
  );
}

function flattenSessionTreeIds(node: SessionTreeNode): string[] {
  return [
    node.session.sessionId,
    ...node.children.flatMap(flattenSessionTreeIds),
  ];
}
