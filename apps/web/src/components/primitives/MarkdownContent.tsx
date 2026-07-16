import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import "streamdown/styles.css";

interface MarkdownContentProps {
  children: string;
  isStreaming?: boolean;
}

export function MarkdownContent({ children, isStreaming }: MarkdownContentProps) {
  return (
    <Streamdown
      animated={{ animation: "blurIn" }}
      className="conversation-markdown-body"
      isAnimating={!!isStreaming}
      plugins={{ code }}
      shikiTheme={["github-light", "github-dark"]}
      lineNumbers
    >
      {children}
    </Streamdown>
  );
}
