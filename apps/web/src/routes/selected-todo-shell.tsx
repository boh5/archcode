import { Activity, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ProjectTodo } from "../api/types";
import { projectTodoDisplayLead } from "./project-todo-presentation";

export type SelectedTodoDestination = "todo" | "work";

export function SelectedTodoShell({
  slug,
  todo,
  active,
  workCount,
}: {
  slug: string;
  todo: ProjectTodo;
  active: SelectedTodoDestination;
  workCount: number;
}) {
  const detailHref = `/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(todo.id)}`;
  const status = selectedTodoStatus(todo);
  const lead = projectTodoDisplayLead(todo.content) || "Untitled Todo";

  return (
    <header
      data-selected-todo-shell
      className="flex min-h-[58px] shrink-0 items-center gap-4 border-b border-border-default bg-bg-surface py-[7px] pl-[18px] pr-4 [@media(min-width:721px)_and_(max-width:980px)]:pl-[68px] [@media(min-width:561px)_and_(max-width:720px)]:pl-[59px] [@media(min-width:561px)_and_(max-width:720px)]:pr-[9px] [@media(max-width:560px)]:min-h-[88px] [@media(max-width:560px)]:flex-wrap [@media(max-width:560px)]:content-center [@media(max-width:560px)]:gap-x-2 [@media(max-width:560px)]:gap-y-[3px] [@media(max-width:560px)]:pl-[9px] [@media(max-width:560px)]:pr-[9px]"
    >
      <div className="min-w-0 flex-1 [@media(max-width:560px)]:flex [@media(max-width:560px)]:min-h-[34px] [@media(max-width:560px)]:items-center [@media(max-width:560px)]:pl-[42px]">
        <div className="flex min-w-0 items-center gap-[9px]">
          <h1 className="truncate text-[17.5px] font-bold leading-[1.3] tracking-[-0.022em] text-text-primary [@media(max-width:720px)]:text-[14px]">
            {lead}
          </h1>
          <span className={`inline-flex min-h-[23px] shrink-0 items-center rounded-[5px] border px-2 text-[10.5px] font-semibold leading-none [@media(max-width:720px)]:hidden ${status.tone}`}>
            {status.label}
          </span>
        </div>
      </div>

      <nav
        aria-label="Todo sections"
        className="flex shrink-0 items-center gap-[3px] before:mr-[7px] before:h-6 before:w-px before:bg-border-default [@media(max-width:560px)]:w-full [@media(max-width:560px)]:pl-[42px] [@media(max-width:560px)]:before:hidden"
      >
        <SelectedTodoDestinationLink
          active={active === "todo"}
          href={detailHref}
          icon={<FileText size={13} aria-hidden="true" />}
          label="Todo"
        />
        <SelectedTodoDestinationLink
          active={active === "work"}
          href={`${detailHref}/work`}
          icon={<Activity size={13} aria-hidden="true" />}
          label="Work"
          count={workCount}
        />
      </nav>
    </header>
  );
}

function SelectedTodoDestinationLink({
  active,
  href,
  icon,
  label,
  count,
}: {
  active: boolean;
  href: string;
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <Link
      to={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex h-[31px] items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[11.5px] font-semibold transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(max-width:560px)]:min-h-[34px] [@media(max-width:560px)]:flex-1 [@media(max-width:560px)]:justify-center [@media(pointer:coarse)]:min-h-11 ${active ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary"}`}
    >
      {icon}
      <span>{label}</span>
      {count === undefined ? null : <b className="font-mono text-[9.5px] font-normal leading-none text-text-tertiary">{count}</b>}
    </Link>
  );
}

function selectedTodoStatus(todo: ProjectTodo): { label: string; tone: string } {
  if (todo.archivedAt !== undefined) {
    return { label: "Archived", tone: "border-border-default bg-bg-active text-text-tertiary" };
  }
  if (todo.status === "rejected") {
    return { label: "Rejected", tone: "border-warning/25 bg-attention-field text-warning" };
  }
  if (todo.status === "idea") {
    return { label: "Idea", tone: "border-border-default bg-bg-active text-text-tertiary" };
  }
  if (todo.status === "ready") {
    return { label: "Ready", tone: "border-brand/25 bg-brand-field text-brand" };
  }
  if (todo.status === "in_progress") {
    return { label: "In progress", tone: "border-border-default bg-bg-active text-text-primary" };
  }
  return { label: "Done", tone: "border-success/25 bg-success-field text-success" };
}
