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
      ? "max-h-[calc(100vh-32px)] w-[min(calc(100vw-32px),900px)]"
      : "w-[min(480px,90vw)]";

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <DialogPrimitive.Content
        className={`!fixed left-1/2 top-1/2 z-50 ${sizeClass} -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-default bg-bg-surface shadow-lg focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 ${className ?? ""}`}
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
