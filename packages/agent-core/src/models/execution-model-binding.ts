import type {
  ExecutionModelBindingSummary,
} from "@archcode/protocol";
import type { ModelCallOptions } from "../config";
import type { ModelInfo } from "../provider";

/** Executable model state fixed for the full lifetime of one Execution. */
export interface ExecutionModelBinding {
  readonly modelInfo: ModelInfo;
  readonly options: Readonly<ModelCallOptions> | undefined;
  readonly summary: ExecutionModelBindingSummary;
}
