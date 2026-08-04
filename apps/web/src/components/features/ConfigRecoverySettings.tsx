import { useState } from "react";
import type { BootstrapStatus } from "@archcode/protocol";
import { SettingsSidebar } from "./SettingsDialog";
import { SettingsConfigRecoveryPanel } from "./SettingsConfigRecoveryPanel";
import { SettingsUpdatesPanel } from "./SettingsUpdatesPanel";
import type { SettingsSection } from "./settings-helpers";

export function ConfigRecoverySettings({
  grant,
  onTransition,
}: {
  grant: string;
  onTransition: (status: BootstrapStatus) => void;
}) {
  const [section, setSection] = useState<SettingsSection>("config-recovery");
  return <div className="min-h-dvh bg-bg-base p-0 text-text-primary sm:p-4">
    <section aria-label="Configuration recovery settings" className="mx-auto h-dvh min-h-0 w-full overflow-hidden border-border-strong bg-bg-overlay sm:h-[calc(100dvh-32px)] sm:max-w-[1120px] sm:rounded-md sm:border sm:shadow-lg">
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <SettingsSidebar section={section} onSelect={setSection} recoveryMode />
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg-base px-5 py-5 sm:px-6">
          {section === "updates"
            ? <SettingsUpdatesPanel authorizationToken={grant} />
            : <SettingsConfigRecoveryPanel grant={grant} onTransition={onTransition} />}
        </main>
      </div>
    </section>
  </div>;
}
