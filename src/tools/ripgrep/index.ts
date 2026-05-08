export { createRipgrepService, RipgrepNotFoundError } from "./service";
export type { RipgrepService, DiscoverySeam } from "./service";
export {
  SearchArgsSchema,
  FileArgsSchema,
  parseRgJsonLine,
  parseRgOutput,
  formatSearchResult,
  buildSearchArgs,
  buildFileListArgs,
  buildCountArgs,
} from "./search";
export type {
  SearchArgs,
  FileArgs,
  MatchLine,
  MatchResult,
  SearchResult,
} from "./search";