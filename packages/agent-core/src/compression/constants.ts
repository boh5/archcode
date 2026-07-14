export const SOFT_NUDGE_RATIO = 0.55;
export const STRONG_NUDGE_RATIO = 0.70;
export const HARD_COMPACT_RATIO = 0.85;

export const COMPRESSION_STRATEGIES = ["dynamic-range"] as const;

export const COMPRESSION_TRIGGERS = [
  "model_tool_call",
  "soft_nudge_response",
  "strong_nudge_response",
] as const;

export const COMPRESSION_BLOCK_STATUSES = ["active", "inactive", "superseded"] as const;

export const COMPRESSION_SUMMARY_SECTION_NAMES = [
  "Current Objective",
  "User Constraints",
  "Decisions Made",
  "Open Tasks",
  "Important Files",
  "Tool Results",
  "Errors/Unknown Results",
  "Protected Refs",
  "Child Block Refs",
  "Resume Instructions",
] as const;

export const PROTECTED_CONTENT_KINDS = [
  "latest_tail",
  "pending_tool",
  "running_tool",
  "active_permission",
  "active_question",
  "protect_tag",
  "unknown_result",
  "todo",
  "reminder",
  "subagent_link",
  "user_constraint",
] as const;

export const DCP_PARITY_ITEMS = [
  "stable_session_local_message_refs",
  "stable_session_local_block_refs",
  "range_compression_by_start_end_ref",
  "model_callable_compress_contract",
  "nested_blocks_with_placeholder_validation",
  "active_inactive_superseded_lifecycle",
  "protected_content_contracts",
  "user_messages_preserve_canonical_originals",
  "typed_tool_output_deduplication_contract",
  "typed_purge_error_contract",
  "soft_and_strong_nudges",
  "hard_compact_safety_boundary",
  "manual_compact_entry_contract",
  "ui_expandable_original_range_contract",
] as const;
