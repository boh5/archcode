export interface UserMessageEvent {
  type: "user-message";
  id: string;
  timestamp: number;
  step: number;
  content: string;
}

export interface TextDeltaEvent {
  type: "text-delta";
  id: string;
  timestamp: number;
  step: number;
  text: string;
}

export interface ToolCallEvent {
  type: "tool-call";
  id: string;
  timestamp: number;
  step: number;
  toolName: string;
  toolCallId: string;
  input: unknown;
}

export interface ToolResultEvent {
  type: "tool-result";
  id: string;
  timestamp: number;
  step: number;
  toolName: string;
  toolCallId: string;
  output: string;
  isError: boolean;
}

export interface LoopErrorEvent {
  type: "loop-error";
  id: string;
  timestamp: number;
  step: number;
  error: string;
}

export type TranscriptEvent =
  | UserMessageEvent
  | TextDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | LoopErrorEvent;

export interface SessionTranscriptState {
  sessionId: string;
  events: TranscriptEvent[];
  createdAt: number;
  append: (event: TranscriptEvent) => void;
}
