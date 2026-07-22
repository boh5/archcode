import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

const DropdownMenuRoot = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        className={`z-50 min-w-[8rem] overflow-hidden rounded-lg border border-border-default bg-bg-overlay p-1 shadow-md data-[state=open]:animate-overlay-enter data-[state=closed]:animate-overlay-exit ${className ?? ""}`}
        sideOffset={sideOffset}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-[13px] text-text-primary outline-none transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus:bg-bg-hover data-[highlighted]:bg-bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${className ?? ""}`}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={`-mx-1 my-1 h-px bg-border-default ${className ?? ""}`}
      {...props}
    />
  );
}

export {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
};
