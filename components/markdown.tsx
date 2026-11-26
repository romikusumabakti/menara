import { code } from "@streamdown/code";
import type { Element, ElementContent } from "hast";
import * as React from "react";
import rehypeSlug from "rehype-slug";
import remarkBreaks from "remark-breaks";
import {
  type Components,
  defaultComponents,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type ExtraProps,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { useTranslations } from "use-intl";
import { tableWrapperClass } from "@/components/ui/table";
import { UserName } from "@/components/user/user-name";
import { Link } from "@/i18n/navigation";
import { classifyLink } from "@/lib/markdown-links";
import { cn } from "@/lib/utils";

type Pluggable = NonNullable<StreamdownProps["rehypePlugins"]>[number];

// Streamdown's rehype-harden with a blocked link (javascript: and other
// non-web URLs) left as its plain text: the default marks it with a
// hard-coded English " [blocked]" and "Blocked URL" tooltip.
const [harden, hardenOptions] = defaultRehypePlugins.harden as [
  Extract<Pluggable, unknown[]>[0],
  Record<string, unknown>,
];
const hardenTextOnly: Pluggable = [
  harden,
  { ...hardenOptions, linkBlockPolicy: "text-only" },
];

// Streamdown's rehype chain without `raw`, and `skipHtml` on the renderer:
// HTML inside markdown is never parsed into elements; it is dropped from the
// output (not shown as text).
const REHYPE_PLUGINS: Pluggable[] = [
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.undoubleClobberPrefix,
  hardenTextOnly,
].filter((p): p is Pluggable => p !== undefined);

// rehype-slug after sanitize, so ids stay the plain github-slugger slugs
// (no `user-content-` prefix) the knowledge table of contents links to.
const REHYPE_PLUGINS_WITH_IDS: Pluggable[] = [...REHYPE_PLUGINS, rehypeSlug];

const REMARK_PLUGINS: Pluggable[] = Object.values(defaultRemarkPlugins);
// A single newline stays a line break (a chat box's text), as
// `whitespace-pre-wrap` showed it.
const REMARK_PLUGINS_WITH_BREAKS: Pluggable[] = [
  ...REMARK_PLUGINS,
  remarkBreaks,
];

const PLUGINS = { code };

// Copy on code blocks only; tables grow with the content rather than
// scrolling inside it.
const CONTROLS = {
  table: false,
  code: { copy: true, download: false },
  mermaid: false,
  image: false,
} as const;

// Our own links (below) instead of Streamdown's confirm-before-open dialog.
const LINK_SAFETY = { enabled: false };

type StyledTag = "thead" | "th" | "td";
type StyledProps = { className?: string } & ExtraProps;

/** Streamdown's own renderer for `tag`, with `extra` merged over its classes. */
function Restyled({
  tag,
  extra,
  ...props
}: StyledProps & { tag: StyledTag; extra: string }) {
  const Base = defaultComponents[tag] as React.ComponentType<StyledProps>;
  return <Base {...props} className={cn(extra, props.className)} />;
}

function textOf(nodes: ElementContent[] | undefined): string {
  let text = "";
  for (const n of nodes ?? []) {
    if (n.type === "text") text += n.value;
    else if (n.type === "element") text += textOf(n.children);
  }
  return text;
}

const linkClass = "text-primary underline underline-offset-4";

/**
 * A link by where it points: a profile on this instance is the person's
 * name with their hover card (built from the link text; the card loads on
 * hover), another path on this instance an in-app link in the same tab, and
 * anything else a new tab without access to this page.
 */
function MarkdownLink({
  href,
  children,
  node,
}: React.ComponentProps<"a"> & ExtraProps) {
  if (!href) return <span>{children}</span>;
  const target = classifyLink(href, window.location.origin);
  if (target.kind === "person") {
    const name = textOf((node as Element | undefined)?.children).trim();
    if (name)
      return (
        <UserName
          user={{ id: target.id, name, image: null }}
          avatar={false}
          className={cn("inline", linkClass)}
        />
      );
    return (
      <Link href={`/people/${target.id}`} className={linkClass}>
        {children}
      </Link>
    );
  }
  // Same page: no router, no new tab.
  if (target.kind === "anchor")
    return (
      <a href={target.hash} className={linkClass}>
        {children}
      </a>
    );
  if (target.kind === "app")
    return (
      <Link href={target.path} className={linkClass}>
        {children}
      </Link>
    );
  return (
    <a
      href={target.href}
      target="_blank"
      rel="noopener noreferrer"
      className={linkClass}
    >
      {children}
    </a>
  );
}

const listClass = (className: string | undefined, marker: string) =>
  cn(
    "my-3 space-y-1",
    // remark-gfm marks task lists with this class; the checkbox replaces
    // the marker.
    className?.includes("contains-task-list")
      ? "list-none ps-1"
      : `list-outside ps-5 ${marker}`
  );

/**
 * One element map for every caller: the app's type scale, paragraph and
 * list spacing on the elements themselves (blocks render one by one while
 * streaming, so spacing from the root would not hold), lists with their
 * markers outside the text so wrapped lines align, the single-border table
 * wrapper, a semantic <strong>, and links by destination.
 */
const COMPONENTS: Components = {
  h1: ({ node: _node, className, ...props }) => (
    <h1
      className={cn("mt-6 mb-3 text-xl font-semibold", className)}
      {...props}
    />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2
      className={cn("mt-5 mb-2 text-lg font-semibold", className)}
      {...props}
    />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3
      className={cn("mt-4 mb-2 text-base font-semibold", className)}
      {...props}
    />
  ),
  p: ({ node: _node, className, ...props }) => (
    <p className={cn("my-3 leading-relaxed", className)} {...props} />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul className={listClass(className, "list-disc")} {...props} />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol className={listClass(className, "list-decimal")} {...props} />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li className={cn("leading-relaxed", className)} {...props} />
  ),
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      className={cn(
        "my-3 border-s-2 ps-4 text-muted-foreground italic",
        className
      )}
      {...props}
    />
  ),
  hr: () => <hr className="my-6 border-border" />,
  table: ({ node: _node, className, ...props }) => (
    <div className={cn(tableWrapperClass, "my-4 overflow-x-auto")}>
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  ),
  thead: (props) => <Restyled tag="thead" extra="bg-muted" {...props} />,
  th: (props) => <Restyled tag="th" extra="px-3 py-2" {...props} />,
  td: (props) => <Restyled tag="td" extra="px-3 py-2" {...props} />,
  // A real <strong> (Streamdown's is a styled span), for assistive tech.
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  // Code blocks stay Streamdown's (highlighting, copy button); only inline
  // code gets the chip.
  inlineCode: ({ node: _node, className, ...props }) => (
    <code
      className={cn(
        "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]",
        className
      )}
      {...props}
    />
  ),
  a: MarkdownLink,
  // GFM task-list checkboxes, the only <input> remark-gfm emits (disabled).
  input: ({ node: _node, className, ...props }) => (
    <input
      {...props}
      className={cn("me-1.5 align-middle accent-primary", className)}
    />
  ),
};

// Never load an image (an injected `![](https://…?d=<data>)` would leak data
// without a click); only the alt text stays.
const NO_IMAGES: Components = {
  ...COMPONENTS,
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
};

// Images from trusted content (knowledge, issue descriptions): auth-gated
// `/api/knowledge/asset/<id>` attachments, lazy so many screenshots don't
// block the first paint.
const WITH_IMAGES: Components = {
  ...COMPONENTS,
  img: ({ node: _node, src, alt, className, ...props }) => (
    <img
      {...props}
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      className={cn("my-4 max-w-full rounded-md border", className)}
    />
  ),
};

// Spacing lives on the elements (margins collapse between blocks), not on
// the root's `space-y-*`: while streaming, and with dir="auto", Streamdown
// wraps each block in its own `display: contents` div, which takes no
// margin, so the root's spacing vanished and paragraphs ran together. For
// the same reason the first/last block's outer margin is trimmed here,
// through one wrapper level, not with `first:`/`last:` on each element.
const EDGE_MARGINS =
  "space-y-0 [&>:first-child]:mt-0 [&>:first-child>:first-child]:mt-0 [&>:last-child]:mb-0 [&>:last-child>:last-child]:mb-0";

/**
 * Read-only markdown with Streamdown, the same rendering everywhere: an
 * unfinished text renders while it streams (open emphasis, half a table or
 * code fence), code is highlighted (Shiki, JavaScript regex engine: no eval,
 * no remote fetch). Embedded HTML is never rendered; a link to a non-web URL
 * (javascript:) is kept as plain text. Images load only with `allowImages`;
 * `lineBreaks` keeps single newlines; `headingIds` gives headings
 * github-slugger ids. Each block takes the direction of its own text.
 */
export function Markdown({
  content,
  mode,
  animating = false,
  allowImages = false,
  lineBreaks = false,
  headingIds = false,
  className,
}: {
  content: string;
  mode: "static" | "streaming";
  /** Streamdown's `isAnimating`; only meaningful in streaming mode. */
  animating?: boolean;
  allowImages?: boolean;
  lineBreaks?: boolean;
  headingIds?: boolean;
  className?: string;
}) {
  const t = useTranslations("assistant");
  const tCommon = useTranslations("common");
  const translations = React.useMemo(
    () => ({ copyCode: t("copyCode"), copied: tCommon("copied") }),
    [t, tCommon]
  );
  return (
    <Streamdown
      data-markdown=""
      dir="auto"
      mode={mode}
      className={cn(EDGE_MARGINS, "break-words", className)}
      components={allowImages ? WITH_IMAGES : NO_IMAGES}
      remarkPlugins={lineBreaks ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS}
      rehypePlugins={headingIds ? REHYPE_PLUGINS_WITH_IDS : REHYPE_PLUGINS}
      skipHtml
      plugins={PLUGINS}
      controls={CONTROLS}
      linkSafety={LINK_SAFETY}
      tableMaxHeight={0}
      isAnimating={animating}
      translations={translations}
    >
      {content}
    </Streamdown>
  );
}
