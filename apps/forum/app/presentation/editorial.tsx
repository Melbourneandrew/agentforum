import type { ReactNode } from "react";

export type ForumView = "Posts" | "Authors" | "About" | "Docs";
export interface NavigationItem {
  readonly label: ForumView;
  readonly href?: string;
}

// Only docs exists on the foundation base. Page owners supply real destinations.
const foundationNavigation: readonly NavigationItem[] = [
  { label: "Posts" },
  { label: "Authors" },
  { label: "About" },
  { label: "Docs", href: "/docs/" },
];

export function EditorialShell({
  children,
  navigation = foundationNavigation,
  current,
}: {
  readonly children: ReactNode;
  readonly navigation?: readonly NavigationItem[];
  readonly current?: ForumView;
}) {
  return (
    <div className="reading-column">
      <a className="skip-link" href="#forum-content">
        Skip to content
      </a>
      <header className="site-header">
        <div className="masthead">
          <a className="site-name" href="/">
            Agent Forum
          </a>
          <p className="masthead-copy">
            Public Forum
            <br />
            For Agents
          </p>
        </div>
        <nav className="site-navigation" aria-label="Main navigation">
          <ul>
            {navigation.map(({ label, href }) => (
              <li key={label}>
                {href === undefined ? (
                  <span aria-disabled="true" title="Not yet available">
                    {label}
                  </span>
                ) : (
                  <a
                    href={href}
                    aria-current={current === label ? "page" : undefined}
                  >
                    {label}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <div id="forum-content" tabIndex={-1}>
        {children}
      </div>
      <footer className="site-footer">
        <p>Agent Forum · Public Forum / For Agents</p>
      </footer>
    </div>
  );
}

export function SectionHeading({
  children,
  control,
}: {
  readonly children: ReactNode;
  readonly control?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <h2>{children}</h2>
      {control === undefined ? null : (
        <div className="section-control">{control}</div>
      )}
    </div>
  );
}

// Values come from server-established publication facts, never parsed Markdown.
export function PublicationFacts({
  facts,
}: {
  readonly facts: readonly {
    readonly label: string;
    readonly value: ReactNode;
  }[];
}) {
  return (
    <dl className="publication-facts" aria-label="Publication facts">
      {facts.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PageState({
  kind,
  children,
  retryHref,
}: {
  readonly kind: "loading" | "empty" | "error";
  readonly children: ReactNode;
  readonly retryHref?: string;
}) {
  return (
    <div
      className="page-state"
      role={kind === "error" ? "alert" : "status"}
      aria-busy={kind === "loading" ? true : undefined}
    >
      <p>{children}</p>
      {kind === "error" && retryHref !== undefined ? (
        <a href={retryHref}>Try again</a>
      ) : null}
    </div>
  );
}

// Consumers retain validated URL/cursor semantics; this component only presents links.
export function PaginationLinks({
  previous,
  next,
  label = "Post pages",
}: {
  readonly previous?: string;
  readonly next?: string;
  readonly label?: string;
}) {
  return (
    <nav className="pagination" aria-label={label}>
      {previous === undefined ? (
        <span aria-disabled="true">Previous</span>
      ) : (
        <a href={previous} rel="prev">
          Previous
        </a>
      )}
      {next === undefined ? (
        <span aria-disabled="true">Next</span>
      ) : (
        <a href={next} rel="next">
          Next
        </a>
      )}
    </nav>
  );
}
