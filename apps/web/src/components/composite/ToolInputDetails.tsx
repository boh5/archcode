import { buildToolInputTree, type ToolInputNode } from "../../lib/tool-input-presentation";

export function ToolInputDetails({ input }: { readonly input: unknown }) {
  const tree = buildToolInputTree(input);

  return (
    <section className="border-t border-border-subtle px-3 py-2" aria-label="Tool input" data-testid="tool-input-details">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Input</div>
      <div className="flex flex-col gap-1 font-mono text-[11px]">
        <ToolInputNodeView node={tree} root depth={0} />
      </div>
    </section>
  );
}

function ToolInputNodeView({
  node,
  root = false,
  depth,
}: {
  readonly node: ToolInputNode;
  readonly root?: boolean;
  readonly depth: number;
}) {
  if (node.kind === "value") {
    return (
      <div className={root ? "text-text-secondary" : "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2"}>
        {!root && <span className="text-text-tertiary">{node.key}:</span>}
        <span className="min-w-0 whitespace-pre-wrap break-all text-text-secondary">{node.value}</span>
      </div>
    );
  }

  const children = node.children ?? [];
  if (root) {
    return (
      <>
        {children.map((child) => <ToolInputNodeView key={child.key} node={child} depth={0} />)}
        {node.omittedChildren ? <OmittedChildren count={node.omittedChildren} /> : null}
        {children.length === 0 && !node.omittedChildren && (
          <span className="text-text-secondary">{node.value}</span>
        )}
      </>
    );
  }

  return (
    <details className="min-w-0" open={depth === 0}>
      <summary className="cursor-pointer select-none text-text-tertiary marker:text-text-tertiary">
        <span>{node.key}:</span>
        <span className="ml-2 text-text-secondary">{node.value}</span>
      </summary>
      {(children.length > 0 || node.omittedChildren) && (
        <div className="ml-3 mt-1 flex flex-col gap-1 border-l border-border-subtle pl-3">
          {children.map((child) => <ToolInputNodeView key={child.key} node={child} depth={depth + 1} />)}
          {node.omittedChildren ? <OmittedChildren count={node.omittedChildren} /> : null}
        </div>
      )}
    </details>
  );
}

function OmittedChildren({ count }: { readonly count: number }) {
  return (
    <span className="text-warning">
      … {count} {count === 1 ? "entry" : "entries"} omitted
    </span>
  );
}
