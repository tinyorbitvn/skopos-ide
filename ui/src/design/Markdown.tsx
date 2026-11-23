import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import styles from "./Markdown.module.css";
import { type Block, type Inline, parseMarkdown } from "./parseMarkdown";

/** What opens a link; null renders links as text, as chart READMEs and release notes want. */
const LinkOpener = createContext<((url: string) => void) | null>(null);

const WEB_LINK = /^https?:\/\//i;

/** The host of a web address, or null when it does not parse to one. */
function webHost(url: string): string | null {
  if (!WEB_LINK.test(url)) return null;
  try {
    const host = new URL(url).host;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * A link: a button that opens a web address when the page passed `onLink`, else text. The
 * button names the address's host after its text, so the text cannot hide where it goes.
 */
function LinkText(props: { url: string; children?: ReactNode }) {
  const open = useContext(LinkOpener);
  const host = open === null ? null : webHost(props.url);
  if (open === null || host === null) {
    return createElement(
      "span",
      null,
      props.children,
      createElement("span", { className: styles.url }, ` (${props.url})`),
    );
  }
  return createElement(
    "button",
    {
      type: "button",
      className: styles.link,
      title: props.url,
      onClick: () => open(props.url),
    },
    props.children,
    // The space stays outside the span, or the accessible name runs the two together.
    " ",
    createElement("span", { className: styles.url }, `(${host})`),
  );
}

// Children are spread into `createElement`, so the lists of a tree need no keys.

function inlineNode(node: Inline): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "code":
      return createElement("code", { className: styles.code }, node.text);
    case "strong":
      return createElement("strong", null, ...inline(node.children));
    case "em":
      return createElement("em", null, ...inline(node.children));
    case "link":
      return createElement(
        LinkText,
        { url: node.url },
        ...inline(node.children),
      );
    case "break":
      return createElement("br");
  }
}

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map(inlineNode);
}

function listItem(blocks: Block[]): ReactNode {
  const only = blocks[0];
  if (blocks.length === 1 && only?.type === "paragraph") {
    return createElement("li", null, ...inline(only.children));
  }
  return createElement("li", null, ...blocks.map(block));
}

function block(node: Block): ReactNode {
  switch (node.type) {
    case "heading":
      // Two levels down, so a README's headings nest under the drawer's own.
      return createElement(
        `h${Math.min(6, node.level + 2)}`,
        { className: styles.heading },
        ...inline(node.children),
      );
    case "paragraph":
      return createElement("p", null, ...inline(node.children));
    case "rule":
      return createElement("hr");
    case "code":
      return createElement(
        "pre",
        { className: styles.pre },
        createElement(
          "code",
          { "data-lang": node.lang === "" ? undefined : node.lang },
          node.text,
        ),
      );
    case "quote":
      return createElement("blockquote", null, ...node.children.map(block));
    case "list":
      return createElement(
        node.ordered ? "ol" : "ul",
        node.ordered && node.start !== 1 ? { start: node.start } : null,
        ...node.items.map(listItem),
      );
    case "table":
      return createElement(
        "div",
        { className: styles.tableWrap },
        createElement(
          "table",
          null,
          createElement(
            "thead",
            null,
            createElement(
              "tr",
              null,
              ...node.head.map((cell) =>
                createElement("th", null, ...inline(cell)),
              ),
            ),
          ),
          createElement(
            "tbody",
            null,
            ...node.rows.map((row) =>
              createElement(
                "tr",
                null,
                ...row.map((cell) =>
                  createElement("td", null, ...inline(cell)),
                ),
              ),
            ),
          ),
        ),
      );
  }
}

/**
 * Markdown as React elements (spec D1 §13). Raw HTML and entities show as the text they
 * are; images load nothing. Links open only through `onLink`, and only http and https ones.
 */
export function Markdown(props: {
  text: string;
  testId?: string;
  onLink?: (url: string) => void;
}) {
  const blocks = useMemo(() => parseMarkdown(props.text), [props.text]);
  return createElement(
    LinkOpener.Provider,
    { value: props.onLink ?? null },
    createElement(
      "div",
      { className: styles.markdown, "data-testid": props.testId },
      ...blocks.map(block),
    ),
  );
}
