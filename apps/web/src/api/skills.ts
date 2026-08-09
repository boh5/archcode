import { apiFetch } from "./client";
import type {
  ProjectSkillInventoryItem,
  ProjectSkillInventoryResponse,
  SkillPromptProjection,
} from "@archcode/protocol";

export type ProjectSkillPickerItem = ProjectSkillInventoryItem & { readonly promptOmitted: boolean };

export interface CompleteProjectSkillInventory {
  readonly items: readonly ProjectSkillPickerItem[];
  readonly promptProjection: SkillPromptProjection;
}

export function getProjectSkillInventoryPage(
  slug: string,
  cursor?: string,
  sessionId?: string,
): Promise<ProjectSkillInventoryResponse> {
  const query = new URLSearchParams();
  if (cursor !== undefined) query.set("cursor", cursor);
  if (sessionId !== undefined) query.set("sessionId", sessionId);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return apiFetch<ProjectSkillInventoryResponse>(`/api/projects/${encodeURIComponent(slug)}/skills${suffix}`);
}

export async function getCompleteProjectSkillInventoryView(
  slug: string,
  sessionId?: string,
): Promise<CompleteProjectSkillInventory> {
  const items: ProjectSkillInventoryItem[] = [];
  let includedNames = new Set<string>();
  let promptProjection: SkillPromptProjection | undefined;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await getProjectSkillInventoryPage(slug, cursor, sessionId);
    items.push(...page.items);
    promptProjection = page.promptProjection;
    includedNames = new Set(page.promptProjection.includedEntries.map((entry) => entry.name));
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) throw new Error("Skill inventory returned a repeated cursor");
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  if (promptProjection === undefined) throw new Error("Skill inventory returned no page");
  return {
    items: items.map((item) => ({
      ...item,
      promptOmitted: item.valid && item.winner && !item.shadowed && !includedNames.has(item.name),
    })),
    promptProjection,
  };
}

export async function getCompleteProjectSkillInventory(
  slug: string,
  sessionId?: string,
): Promise<ProjectSkillPickerItem[]> {
  return [...(await getCompleteProjectSkillInventoryView(slug, sessionId)).items];
}
