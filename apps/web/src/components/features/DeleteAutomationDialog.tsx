import { useDeleteAutomation } from "../../api/mutations";
import type { Automation } from "../../api/types";
import { formatAutomationTrigger } from "../../lib/automation-trigger-presentation";
import { DestructiveActionDialog } from "./DestructiveActionDialog";

interface DeleteAutomationDialogProps {
  automation: Automation;
  open: boolean;
  slug: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteAutomationDialog({
  automation,
  open,
  slug,
  onClose,
  onDeleted,
}: DeleteAutomationDialogProps) {
  const remove = useDeleteAutomation();
  const error = remove.error instanceof Error
    ? remove.error.message
    : remove.error
      ? "Failed to delete Automation"
      : null;

  return (
    <DestructiveActionDialog
      open={open}
      title="Delete Automation?"
      description="This action cannot be undone."
      subject={automation.name}
      confirmLabel="Delete Automation"
      pendingLabel="Deleting…"
      consequences={[
        "The schedule and its configuration",
        "Pending runs and the complete invocation history",
      ]}
      note={(
        <p>
          Sessions already created or updated by this Automation will remain unchanged.
          Schedule: <span className="font-medium text-text-primary">{formatAutomationTrigger(automation.trigger)}</span>
        </p>
      )}
      error={error}
      pending={remove.isPending}
      onClose={onClose}
      onConfirm={() => remove.mutate(
        { slug, automationId: automation.id },
        { onSuccess: onDeleted },
      )}
    />
  );
}
