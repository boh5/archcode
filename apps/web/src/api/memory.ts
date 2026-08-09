import type {
  MemoryCapacity,
  MemoryIndexStatus,
  MemoryPreferencesItem,
  MemorySnapshot,
  MemoryTopicItem,
  MemoryTopicSummary,
  MemoryWarningCode,
} from "@archcode/protocol";
import { apiFetch } from "./client";

/**
 * Memory is deliberately kept as a project-scoped resource in the Web API.
 * These DTOs are local to the Web client so the settings surface does not
 * couple itself to the server's file-manager/domain classes.
 */
export type {
  MemoryCapacity,
  MemoryIndexStatus,
  MemoryPreferencesItem,
  MemorySnapshot,
  MemoryTopicItem,
  MemoryTopicSummary,
  MemoryWarningCode,
};

export interface PutPreferencesInput {
  slug: string;
  content: string;
  expectedRevision: string | null;
}

export interface DeletePreferencesInput {
  slug: string;
  expectedRevision: string | null;
}

export interface PutTopicInput {
  slug: string;
  name: string;
  content: string;
  expectedRevision: string | null;
  type: "user" | "feedback" | "project" | "reference";
  title: string;
  description: string;
}

export interface DeleteTopicInput {
  slug: string;
  name: string;
  expectedRevision: string | null;
}

function memoryPath(slug: string, suffix = ""): string {
  return `/api/projects/${encodeURIComponent(slug)}/memory${suffix}`;
}

export function getMemorySnapshot(slug: string): Promise<MemorySnapshot> {
  return apiFetch<MemorySnapshot>(memoryPath(slug));
}

export function getMemoryPreferences(slug: string): Promise<MemoryPreferencesItem | null> {
  return apiFetch<MemoryPreferencesItem | null>(memoryPath(slug, "/preferences"));
}

export function putMemoryPreferences({ slug, content, expectedRevision }: PutPreferencesInput): Promise<MemoryPreferencesItem> {
  return apiFetch<MemoryPreferencesItem>(memoryPath(slug, "/preferences"), {
    method: "PUT",
    body: { content, expectedRevision },
  });
}

export function deleteMemoryPreferences({ slug, expectedRevision }: DeletePreferencesInput): Promise<void> {
  return apiFetch<void>(memoryPath(slug, "/preferences"), {
    method: "DELETE",
    body: { expectedRevision },
  });
}

export function getMemoryTopic(slug: string, name: string): Promise<MemoryTopicItem> {
  return apiFetch<MemoryTopicItem>(memoryPath(slug, `/topics/${encodeURIComponent(name)}`));
}

export function putMemoryTopic({ slug, name, content, expectedRevision, type, title, description }: PutTopicInput): Promise<MemoryTopicItem> {
  return apiFetch<MemoryTopicItem>(memoryPath(slug, `/topics/${encodeURIComponent(name)}`), {
    method: "PUT",
    body: { content, expectedRevision, type, title, description },
  });
}

export function deleteMemoryTopic({ slug, name, expectedRevision }: DeleteTopicInput): Promise<void> {
  return apiFetch<void>(memoryPath(slug, `/topics/${encodeURIComponent(name)}`), {
    method: "DELETE",
    body: { expectedRevision },
  });
}
