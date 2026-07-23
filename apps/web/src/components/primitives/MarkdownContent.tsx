import {
  Streamdown,
  type AnimateOptions,
  type Components,
  type ControlsConfig,
  type PluginConfig,
} from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import "streamdown/styles.css";
import "./MarkdownContent.css";
import { MarkdownTable } from "./MarkdownTable";

type MarkdownContentVariant = "standard" | "compact";

interface MarkdownContentProps {
  children: string;
  isStreaming?: boolean;
  variant?: MarkdownContentVariant;
}

const MARKDOWN_ANIMATION = {
  animation: "fadeIn",
  duration: 120,
  easing: "var(--ease-enter)",
  stagger: 8,
} satisfies AnimateOptions;

const MARKDOWN_CODE_PLUGIN = createCodePlugin({
  themes: ["vitesse-light", "vitesse-dark"],
});

const MARKDOWN_PLUGINS = {
  code: MARKDOWN_CODE_PLUGIN,
} satisfies PluginConfig;

const MARKDOWN_CONTROLS = {
  code: {
    copy: true,
    download: true,
  },
  table: false,
} satisfies ControlsConfig;

const MARKDOWN_COMPONENTS = {
  table: MarkdownTable,
} satisfies Components;

const MARKDOWN_CLASS_NAME: Record<MarkdownContentVariant, string> = {
  standard: "markdown-content space-y-0",
  compact: "markdown-content markdown-content--compact space-y-0",
};

export function MarkdownContent({
  children,
  isStreaming = false,
  variant = "standard",
}: MarkdownContentProps) {
  return (
    <Streamdown
      animated={MARKDOWN_ANIMATION}
      className={MARKDOWN_CLASS_NAME[variant]}
      components={MARKDOWN_COMPONENTS}
      controls={MARKDOWN_CONTROLS}
      isAnimating={isStreaming}
      plugins={MARKDOWN_PLUGINS}
      lineNumbers
    >
      {children}
    </Streamdown>
  );
}
