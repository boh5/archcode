import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { USER_DATA_DIR_NAME } from "@archcode/protocol";
import { z } from "zod/v4";

import { atomicWrite } from "../utils/safe-file";
import { ProjectInfoSchema, type ProjectInfo } from "./types";
import type { Logger } from "../logger";

export interface ProjectRegistryOptions {
  homeDir?: string;
  logger: Logger;
}

export class ProjectRegistryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ProjectRegistryError";
  }
}

const RegistryFileSchema = z.strictObject({
  version: z.literal(1),
  projects: z.array(ProjectInfoSchema),
}).superRefine((file, ctx) => {
  const slugs = new Set<string>();
  const workspaceRoots = new Set<string>();
  file.projects.forEach((project, index) => {
    if (slugs.has(project.slug)) {
      ctx.addIssue({
        code: "custom",
        path: ["projects", index, "slug"],
        message: `Duplicate project slug: ${project.slug}`,
      });
    }
    slugs.add(project.slug);

    const workspaceRoot = resolve(project.workspaceRoot);
    if (workspaceRoots.has(workspaceRoot)) {
      ctx.addIssue({
        code: "custom",
        path: ["projects", index, "workspaceRoot"],
        message: `Duplicate project workspaceRoot: ${workspaceRoot}`,
      });
    }
    workspaceRoots.add(workspaceRoot);
  });
});

const MAX_PROJECT_NAME_LENGTH = 80;

type MutationResult<T> = {
  result: T;
  updated: ProjectInfo[];
};

function cloneProject(project: ProjectInfo): ProjectInfo {
  return { ...project };
}

function cloneProjects(projects: ProjectInfo[]): ProjectInfo[] {
  return projects.map(cloneProject);
}

function sortProjects(projects: ProjectInfo[]): ProjectInfo[] {
  return cloneProjects(projects).sort((left, right) => {
    const leftOpened = Date.parse(left.lastOpenedAt ?? left.addedAt);
    const rightOpened = Date.parse(right.lastOpenedAt ?? right.addedAt);
    if (rightOpened !== leftOpened) return rightOpened - leftOpened;

    return Date.parse(right.addedAt) - Date.parse(left.addedAt);
  });
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug === "" ? "project" : slug;
}

function uniqueSlug(baseSlug: string, projects: ProjectInfo[]): string {
  const usedSlugs = new Set(projects.map((project) => project.slug));
  if (!usedSlugs.has(baseSlug)) return baseSlug;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseSlug}-${suffix}`;
    if (!usedSlugs.has(candidate)) return candidate;
  }
}

function serializeRegistry(projects: ProjectInfo[]): string {
  return `${JSON.stringify(RegistryFileSchema.parse({ version: 1, projects }), null, 2)}\n`;
}

export class ProjectRegistry {
  #indexFile: string;
  #cache: ProjectInfo[] | null = null;
  #writeQueue: Promise<void> = Promise.resolve();
  #logger: Logger;

  constructor(options: ProjectRegistryOptions) {
    this.#indexFile = join(options.homeDir ?? homedir(), USER_DATA_DIR_NAME, "projects", "index.json");
    this.#logger = options.logger;
  }

  async list(): Promise<ProjectInfo[]> {
    return sortProjects(await this.#load());
  }

  async get(slug: string): Promise<ProjectInfo | undefined> {
    const project = (await this.#load()).find((item) => item.slug === slug);
    return project ? cloneProject(project) : undefined;
  }

  async getByWorkspace(workspaceRoot: string): Promise<ProjectInfo | undefined> {
    const normalizedWorkspace = resolve(workspaceRoot);
    const project = (await this.#load()).find(
      (item) => resolve(item.workspaceRoot) === normalizedWorkspace,
    );

    return project ? cloneProject(project) : undefined;
  }

  async add(input: { workspaceRoot: string; name?: string }): Promise<ProjectInfo> {
    const workspaceRoot = resolve(input.workspaceRoot);
    if (workspaceRoot !== input.workspaceRoot) {
      throw new ProjectRegistryError("Project workspaceRoot must be an absolute path");
    }

    try {
      const workspaceStat = await stat(workspaceRoot);
      if (!workspaceStat.isDirectory()) {
        throw new ProjectRegistryError("Project workspaceRoot must be an existing directory");
      }
    } catch (error) {
      if (error instanceof ProjectRegistryError) throw error;
      throw new ProjectRegistryError("Project workspaceRoot must be an existing directory", error);
    }

    return await this.#mutate((current) => {
      const existing = current.find((project) => resolve(project.workspaceRoot) === workspaceRoot);
      if (existing) {
        return { result: cloneProject(existing), updated: current };
      }

      const name = input.name ?? basename(workspaceRoot);
      if (name.trim().length === 0) {
        throw new ProjectRegistryError("Project name must not be empty");
      }
      if (name.length > MAX_PROJECT_NAME_LENGTH) {
        throw new ProjectRegistryError("Project name must be 80 characters or fewer");
      }
      const project: ProjectInfo = {
        slug: uniqueSlug(slugify(name), current),
        name,
        workspaceRoot,
        addedAt: new Date().toISOString(),
      };

      return {
        result: cloneProject(project),
        updated: [...current, project],
      };
    });
  }

  async remove(slug: string): Promise<void> {
    await this.#mutate((current) => ({
      result: undefined,
      updated: current.filter((project) => project.slug !== slug),
    }));
  }

  async updateName(slug: string, name: string): Promise<ProjectInfo> {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new ProjectRegistryError("Project name must not be empty");
    }
    if (trimmedName.length > MAX_PROJECT_NAME_LENGTH) {
      throw new ProjectRegistryError("Project name must be 80 characters or fewer");
    }

    return await this.#mutate((current) => {
      const index = current.findIndex((project) => project.slug === slug);
      if (index === -1) {
        throw new ProjectRegistryError(`Project not found: ${slug}`);
      }

      const updatedProject: ProjectInfo = {
        ...current[index],
        name: trimmedName,
      };
      const updated = [...current];
      updated[index] = updatedProject;

      return {
        result: cloneProject(updatedProject),
        updated,
      };
    });
  }

  async touch(slug: string): Promise<ProjectInfo | undefined> {
    return await this.#mutate((current) => {
      const index = current.findIndex((project) => project.slug === slug);
      if (index === -1) {
        return { result: undefined, updated: current };
      }

      const updatedProject: ProjectInfo = {
        ...current[index],
        lastOpenedAt: new Date().toISOString(),
      };
      const updated = [...current];
      updated[index] = updatedProject;

      return {
        result: cloneProject(updatedProject),
        updated,
      };
    });
  }

  async #load(): Promise<ProjectInfo[]> {
    if (this.#cache !== null) return this.#cache;

    const file = Bun.file(this.#indexFile);
    if (!(await file.exists())) {
      this.#cache = [];
      return this.#cache;
    }

    try {
      const parsed = RegistryFileSchema.parse(await file.json());
      this.#cache = cloneProjects(parsed.projects);
      return this.#cache;
    } catch (error) {
      throw new ProjectRegistryError(`Invalid project registry at ${this.#indexFile}`, error);
    }
  }

  async #persist(projects: ProjectInfo[]): Promise<void> {
    const updated = cloneProjects(projects);
    let serialized: string;
    try {
      serialized = serializeRegistry(updated);
    } catch (error) {
      throw new ProjectRegistryError("Invalid project registry update", error);
    }
    await atomicWrite(this.#indexFile, serialized);
    this.#cache = updated;
  }

  async #mutate<T>(
    fn: (current: ProjectInfo[]) => Promise<MutationResult<T>> | MutationResult<T>,
  ): Promise<T> {
    let result: T | undefined;
    const operation = this.#writeQueue.then(async () => {
      const current = cloneProjects(await this.#load());
      const mutation = await fn(current);
      await this.#persist(mutation.updated);
      result = mutation.result;
    });

    this.#writeQueue = operation.catch((error) => {
      this.#logger.error("project.registry.persist.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await operation;
    return result as T;
  }
}
