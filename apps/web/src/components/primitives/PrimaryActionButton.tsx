import { forwardRef, type ComponentPropsWithoutRef } from "react";

/** Narrow shared grammar for the one dominant creation action on an inventory surface. */
export const PrimaryActionButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(function PrimaryActionButton(
  { className = "", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`primary-action-button relative inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 overflow-hidden rounded-sm border border-brand bg-brand px-[13px] text-[12px] font-semibold leading-[1.55] tracking-[-0.01em] text-brand-ink transition-[background-color,border-color,box-shadow,transform] duration-[var(--motion-hover)] hover:-translate-y-px hover:border-brand-hover hover:bg-brand-hover active:translate-y-0 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:translate-y-0 disabled:scale-100 disabled:border-bg-active disabled:bg-bg-active disabled:text-text-tertiary disabled:shadow-none min-[761px]:h-8 [@media(pointer:coarse)]:h-11 [&_svg]:size-4 ${className}`}
      {...props}
    />
  );
});
