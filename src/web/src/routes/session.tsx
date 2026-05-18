import { useState } from "react";
import { useParams } from "react-router-dom";
import { AppLayout } from "../layout/AppLayout";
import { ProjectBar } from "../components/features/ProjectBar";
import { Sidebar } from "../components/features/Sidebar";
import { ChatHeader } from "../components/features/ChatHeader";

export function SessionRoute() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();
  const [detailPanelOpen, setDetailPanelOpen] = useState(true);

  return (
    <AppLayout
      header={
        <ChatHeader
          slug={slug}
          sessionId={sessionId}
          onToggleDetail={() => setDetailPanelOpen((v) => !v)}
        />
      }
      projectBar={<ProjectBar />}
      sidebar={<Sidebar />}
      chat={
        <div className="flex h-full flex-col bg-bg-base">
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-text-tertiary">Chat placeholder</p>
          </div>
        </div>
      }
      detailPanel={
        detailPanelOpen ? (
          <div className="flex h-full flex-col border-l border-border-subtle bg-bg-surface">
            <div className="flex h-10 items-center border-b border-border-subtle px-3">
              <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                Details
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              <div className="rounded-md px-3 py-2 text-sm text-text-tertiary">
                Details placeholder
              </div>
            </div>
          </div>
        ) : (
          <div />
        )
      }
    />
  );
}