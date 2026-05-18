import { useMemo, useState } from "react";
import { useDiff } from "../../api/queries";
import type { DiffFile, DiffHunk, DiffLine } from "../../api/types";

interface DiffTabProps {
  slug: string;
}

const STATUS_STYLES: Record<string, string> = {
  modified: "bg-warning-muted text-warning",
  created: "bg-success-muted text-success",
  deleted: "bg-error-muted text-error",
};

const STATUS_LABELS: Record<string, string> = {
  modified: "M",
  created: "A",
  deleted: "D",
};

export function DiffTab({ slug }: DiffTabProps) {
  const { data: files, isLoading, error } = useDiff(slug);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const activeFile = useMemo(() => {
    if (!files || files.length === 0) return null;
    if (selectedFile) {
      return files.find((f) => f.path === selectedFile) ?? files[0];
    }
    return files[0];
  }, [files, selectedFile]);

  const toggleCollapse = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-muted">Loading diff…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-error">Failed to load diff</p>
      </div>
    );
  }

  if (!files || files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-tertiary">No changes</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      <FileList
        files={files}
        activePath={activeFile?.path ?? null}
        onSelect={setSelectedFile}
      />
      <DiffContent
        file={activeFile}
        collapsed={collapsedFiles}
        onToggleCollapse={toggleCollapse}
      />
    </div>
  );
}

function FileList({
  files,
  activePath,
  onSelect,
}: {
  files: DiffFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="w-full md:w-[220px] shrink-0 border-b md:border-b-0 md:border-r border-border-subtle overflow-y-auto">
      {files.map((file) => {
        const status = file.status ?? "modified";
        return (
          <button
            key={file.path}
            className={`flex w-full items-center gap-2 px-3 py-[6px] cursor-pointer text-left transition-colors duration-150 font-mono text-[12.5px] ${
              activePath === file.path
                ? "bg-bg-active"
                : "hover:bg-bg-hover"
            }`}
            onClick={() => onSelect(file.path)}
          >
            <span
              className={`shrink-0 rounded-[3px] px-[6px] py-px text-[10px] font-semibold ${STATUS_STYLES[status] ?? "bg-bg-elevated text-text-muted"}`}
            >
              {STATUS_LABELS[status] ?? "?"}
            </span>
            <span className="truncate text-text-primary">{shortPath(file.path)}</span>
          </button>
        );
      })}
    </div>
  );
}

function DiffContent({
  file,
  collapsed,
  onToggleCollapse,
}: {
  file: DiffFile | null;
  collapsed: Set<string>;
  onToggleCollapse: (path: string) => void;
}) {
  if (!file) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-text-tertiary">Select a file</p>
      </div>
    );
  }

  const isCollapsed = collapsed.has(file.path);

  return (
    <div className="flex-1 overflow-y-auto font-mono text-[12px] leading-[1.65]">
      <DiffFileHeader
        path={file.path}
        status={file.status ?? "modified"}
        additions={file.additions}
        deletions={file.deletions}
        collapsed={isCollapsed}
        onToggle={() => onToggleCollapse(file.path)}
      />
      {!isCollapsed &&
        file.hunks.map((hunk, i) => (
          <HunkBlock key={`${file.path}-hunk-${i}`} hunk={hunk} />
        ))}
    </div>
  );
}

function DiffFileHeader({
  path,
  status,
  additions,
  deletions,
  collapsed,
  onToggle,
}: {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-[6px] cursor-pointer select-none bg-bg-elevated hover:bg-bg-hover transition-colors duration-150"
      onClick={onToggle}
    >
      <span className="text-[10px] text-text-muted">{collapsed ? "▶" : "▼"}</span>
      <span className="font-mono text-[12px] font-medium text-text-primary truncate">
        {path}
      </span>
      <span
        className={`shrink-0 rounded-[3px] px-[6px] py-px text-[10px] font-semibold ${STATUS_STYLES[status] ?? "bg-bg-elevated text-text-muted"}`}
      >
        {STATUS_LABELS[status] ?? "?"}
      </span>
      {(additions !== undefined || deletions !== undefined) && (
        <span className="ml-auto shrink-0 text-[10px] text-text-muted">
          {additions !== undefined && (
            <span className="text-success">+{additions}</span>
          )}
          {additions !== undefined && deletions !== undefined && " "}
          {deletions !== undefined && (
            <span className="text-error">-{deletions}</span>
          )}
        </span>
      )}
    </div>
  );
}

function HunkBlock({ hunk }: { hunk: DiffHunk }) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  return (
    <div className="border border-border-subtle rounded-sm overflow-hidden mb-px">
      <div className="bg-bg-elevated px-3 py-1 text-[11px] text-text-muted cursor-default">
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => {
        const rendered = renderDiffLine(line, oldLine, newLine);
        oldLine = rendered.nextLine.old;
        newLine = rendered.nextLine.new;
        return <DiffLineRow key={i} line={line} oldLine={rendered.oldLine} newLine={rendered.newLine} />;
      })}
    </div>
  );
}

function renderDiffLine(line: DiffLine, oldLine: number, newLine: number) {
  if (line.type === "add") {
    return { oldLine: "", newLine: String(newLine), nextLine: { old: oldLine, new: newLine + 1 } };
  }
  if (line.type === "delete") {
    return { oldLine: String(oldLine), newLine: "", nextLine: { old: oldLine + 1, new: newLine } };
  }
  return { oldLine: String(oldLine), newLine: String(newLine), nextLine: { old: oldLine + 1, new: newLine + 1 } };
}

function DiffLineRow({
  line,
  oldLine,
  newLine,
}: {
  line: DiffLine;
  oldLine: string;
  newLine: string;
}) {
  const bgClass =
    line.type === "add"
      ? "bg-success-muted text-success"
      : line.type === "delete"
        ? "bg-error-muted text-error"
        : "";

  const marker = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";

  return (
    <div className={`flex ${bgClass}`}>
      <span className="w-[48px] shrink-0 text-right pr-3 text-[10px] text-text-muted select-none">
        {oldLine}
      </span>
      <span className="w-[48px] shrink-0 text-right pr-3 text-[10px] text-text-muted select-none">
        {newLine}
      </span>
      <span className="shrink-0 w-[16px] text-[11px] select-none">{marker}</span>
      <span className="whitespace-pre flex-1">{line.content}</span>
    </div>
  );
}

function shortPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}