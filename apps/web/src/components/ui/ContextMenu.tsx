import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";

const ContextMenuRoot = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

function ContextMenuContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={`z-50 min-w-[8rem] overflow-hidden rounded-lg border border-border-default bg-bg-overlay p-1 shadow-md data-[state=open]:animate-overlay-enter data-[state=closed]:animate-overlay-exit ${className ?? ""}`}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-[13px] text-text-primary outline-none transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus:bg-bg-hover data-[highlighted]:bg-bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${className ?? ""}`}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={`-mx-1 my-1 h-px bg-border-default ${className ?? ""}`}
      {...props}
    />
  );
}

export {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
};
