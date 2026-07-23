import { ToolOutputArtifactStore } from "../artifact-store";
import { createScopeBoundToolOutputAccess } from "../access-service";
import { createHermeticArtifactSearchRunner } from "./hermetic-search-runner";

const [rootDir, workspaceRoot, rootSessionId, outputRef, pattern] = Bun.argv.slice(2);

if (!rootDir || !workspaceRoot || !rootSessionId || !outputRef || !pattern) {
  throw new Error("Expected artifact root, workspace, root Session, outputRef, and pattern");
}

const store = new ToolOutputArtifactStore({
  rootDir,
  searchRunner: createHermeticArtifactSearchRunner(),
});

try {
  const access = createScopeBoundToolOutputAccess(store, { workspaceRoot, rootSessionId });
  let cursor: string | undefined;
  let canonical = "";
  let pages = 0;

  do {
    const page = await access.read({
      outputRef,
      ...(cursor === undefined ? {} : { cursor }),
      limit: 1_000,
      maxContentBytes: 42 * 1024,
    });
    canonical += page.records.map((record) => record.text).join("");
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== undefined);

  const familySearch = await access.search({
    pattern,
    limit: 10,
    maxContentBytes: 36 * 1024,
  });

  process.stdout.write(JSON.stringify({
    canonical,
    pages,
    familyMatches: familySearch.matches.map((match) => ({
      outputRef: match.outputRef,
      snippet: match.snippet,
    })),
  }));
} finally {
  await store.dispose();
}
