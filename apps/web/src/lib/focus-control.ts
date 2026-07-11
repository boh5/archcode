export function focusElementAfterLayoutChange(selector: string, frames = 1): void {
  const schedule = (callback: () => void) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
    else window.setTimeout(callback, 0);
  };
  const focus = () => document.querySelector<HTMLElement>(selector)?.focus();
  const wait = (remaining: number) => {
    if (remaining <= 0) focus();
    else schedule(() => wait(remaining - 1));
  };
  wait(frames);
}
