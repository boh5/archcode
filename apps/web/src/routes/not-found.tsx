export function NotFoundRoute() {
  return (
    <div className="flex h-screen items-center justify-center bg-bg-base">
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-[16px] font-semibold leading-[22px] text-text-primary">404</h1>
        <p className="text-sm text-text-secondary">Page Not Found</p>
      </div>
    </div>
  );
}
