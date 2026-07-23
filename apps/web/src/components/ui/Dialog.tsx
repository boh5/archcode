import * as DialogPrimitive from "@radix-ui/react-dialog";

const DialogRoot = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;

type DialogSize = "default" | "large" | "x-large";

function DialogContent({
  children,
  className,
  size = "default",
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { size?: DialogSize }) {
  const sizeClass = size === "x-large"
    ? "h-[min(calc(100vh-32px),600px)] w-[min(calc(100vw-32px),960px)]"
    : size === "large"
      ? "h-fit max-h-[calc(100vh-32px)] w-[min(calc(100vw-32px),900px)]"
      : "h-fit w-[min(480px,90vw)]";

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 opacity-0 transition-opacity duration-[var(--motion-overlay)] ease-[var(--ease-enter)] data-[state=open]:opacity-100 data-[state=closed]:ease-[var(--ease-exit)]" />
      <DialogPrimitive.Content
        className={`!fixed inset-0 z-50 m-auto ${sizeClass} rounded-lg border border-border-strong bg-bg-overlay shadow-lg focus:outline-none data-[state=open]:animate-overlay-enter data-[state=closed]:animate-overlay-exit ${className ?? ""}`}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export {
  DialogRoot,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
