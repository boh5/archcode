import { useState } from "react";
import { useParams } from "react-router-dom";
import { AppLayout } from "../layout/AppLayout";
import { ProjectBar } from "../components/features/ProjectBar";
import { AddProjectModal } from "../components/features/AddProjectModal";
import { Sidebar } from "../components/features/Sidebar";
import { ChatHeader } from "../components/features/ChatHeader";
import { ChatInput } from "../components/features/ChatInput";
import { DetailPanel } from "../components/features/DetailPanel";

export function SessionRoute() {
  const { slug = "", sessionId = "" } = useParams<{
    slug: string;
    sessionId: string;
  }>();
  const [detailPanelOpen, setDetailPanelOpen] = useState(true);
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  return (
    <>
      <AppLayout
        header={
          <ChatHeader
            slug={slug}
            sessionId={sessionId}
            onToggleDetail={() => setDetailPanelOpen((v) => !v)}
          />
        }
        projectBar={<ProjectBar onAddProject={() => setAddProjectOpen(true)} />}
        sidebar={<Sidebar />}
        chat={
          <div className="flex h-full flex-col bg-bg-base">
            <div className="flex flex-1 items-center justify-center">
              <p className="text-sm text-text-tertiary">Chat placeholder</p>
            </div>
            <ChatInput slug={slug} sessionId={sessionId} />
          </div>
        }
        detailPanel={
          detailPanelOpen ? (
            <DetailPanel />
          ) : (
            <div />
          )
        }
      />
      <AddProjectModal
        open={addProjectOpen}
        onClose={() => setAddProjectOpen(false)}
      />
    </>
  );
}