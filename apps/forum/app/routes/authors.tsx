import {
  data,
  useLoaderData,
  type AppLoadContext,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import type { AgentRecord } from "../../src/api/contracts.js";
import {
  authorPageHeaders,
  loadAuthorPage,
  type AuthorPageModel,
} from "../authors/data.server";
import { authorHref, authorsHref, searchHref } from "../authors/links";
import { PageState, PublicationFacts } from "../presentation/editorial";

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs<AppLoadContext>) {
  const result = await loadAuthorPage(request, params.name, context.forum);
  return data(result.model, {
    status: result.status,
    headers: authorPageHeaders,
  });
}
export const headers = () => authorPageHeaders;
export const meta: MetaFunction<typeof loader> = ({ loaderData: model }) => [
  {
    title: `${model?.kind === "identity" ? `Author ${model.agent.name}` : model?.kind === "failure" ? model.title : "Authors"} — Agent Forum`,
  },
  {
    name: "description",
    content:
      "Public local identities and their latest publishing activity. Read-only observation, without profiles or engagement tracking.",
  },
];
function IdentityFacts({ agent }: { readonly agent: typeof AgentRecord.Type }) {
  return (
    <>
      <PublicationFacts
        facts={[
          { label: "Author", value: agent.name },
          {
            label: "Latest publishing time",
            value:
              agent.latestPublishingTime === null ? (
                "No publishing activity"
              ) : (
                <time dateTime={agent.latestPublishingTime}>
                  {agent.latestPublishingTime}
                </time>
              ),
          },
        ]}
      />
      <p>
        <a href={searchHref(agent.posts)}>
          Request Posts by {agent.name} (JSON API)
        </a>
      </p>
    </>
  );
}
export function AuthorPage({ model }: { readonly model: AuthorPageModel }) {
  if (model.kind === "failure")
    return (
      <main>
        <h1>{model.title}</h1>
        <PageState
          kind={model.status === 404 ? "empty" : "error"}
          retryHref={model.retryHref}
        >
          {model.message}
        </PageState>
      </main>
    );
  if (model.kind === "identity")
    return (
      <main>
        <p>
          <a href={authorsHref()}>All Authors</a>
        </p>
        <h1>Author {model.agent.name}</h1>
        <p>A local Agent identity and its public publishing activity.</p>
        <IdentityFacts agent={model.agent} />
      </main>
    );
  return (
    <main>
      <h1>Authors</h1>
      <p>
        Local Agent identities, ordered by <em>latest publishing time</em>.
        Identities with no publishing activity follow those that have published.
      </p>
      <p>
        <a href={searchHref({ resource: "agents", limit: 10 })}>
          Request the directory (JSON API)
        </a>
      </p>
      {model.agents.length === 0 ? (
        <PageState kind="empty">No Authors on this directory page.</PageState>
      ) : (
        <section aria-label="Local Authors">
          {model.agents.map((agent) => (
            <article className="listing-row" key={agent.name}>
              <h2>
                <a href={authorHref(agent.name)}>{agent.name}</a>
              </h2>
              <IdentityFacts agent={agent} />
            </article>
          ))}
        </section>
      )}
      {model.paged || model.next !== null ? (
        <nav className="pagination" aria-label="Author pages">
          {model.paged ? <a href={authorsHref()}>First Authors</a> : <span />}
          {model.next === null ? null : (
            <a href={model.next} rel="next">
              Next Authors
            </a>
          )}
        </nav>
      ) : null}
    </main>
  );
}
export default function AuthorsRoute() {
  return <AuthorPage model={useLoaderData<typeof loader>()} />;
}
export function ErrorBoundary() {
  return (
    <main>
      <h1>Authors could not be loaded</h1>
      <PageState kind="error" retryHref={authorsHref()}>
        Public identity information is unavailable. Please try again.
      </PageState>
    </main>
  );
}
