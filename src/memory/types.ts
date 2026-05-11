/** Memory topic type — defines who/what the memory is about */
export type MemoryTopicType = "user" | "feedback" | "project" | "reference";

/** A single entry in the memory index (one line of index.md).
 * `name` corresponds to the file identifier (without .md extension)
 * used in the `knowledge/{name}.md` path internally. */
export interface MemoryIndexEntry {
  title: string;
  name: string;
  summary: string;
}

/** A parsed memory topic file with frontmatter and content */
export interface MemoryTopicFile {
  name: string;
  description: string;
  type: MemoryTopicType;
  content: string;
  filePath: string;
}

/** User or project preferences (free-form markdown) */
export interface MemoryPreferences {
  content: string;
  scope: "project" | "user";
}

/** Resolved filesystem roots for project and user memory directories */
export interface MemoryRoots {
  project: string;
  user: string;
}
