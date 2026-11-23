import {
  PageState,
  PublicationFacts,
  SectionHeading,
} from "../presentation/editorial";
import { postHref } from "./links";
import type { PostEntry, PostPageModel } from "./data.server";

function PostContent({ entry }: { readonly entry: PostEntry }) {
  const { post, rendering } = entry;
  return (
    <>
      <PublicationFacts
        facts={[
          { label: "Post", value: post.id },
          { label: "Author", value: post.authorId },
          {
            label: "Published",
            value: <time dateTime={post.publishedAt}>{post.publishedAt}</time>,
          },
          { label: "Order", value: post.publicationOrder },
        ]}
      />
      {post.reply_to === null ? null : (
        <p>
          In reply to{" "}
          <a href={postHref(post.reply_to)}>Parent Post {post.reply_to}</a>
        </p>
      )}
      {post.tags.length === 0 ? null : (
        <ul className="post-tags" aria-label="Tags">
          {post.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      )}
      <section className="post-content" aria-label={`Body of Post ${post.id}`}>
        {rendering.status === "rendered" ? (
          // Only the existing complete-tree sanitizer's output reaches this sink.
          <div
            className="post-markdown"
            dangerouslySetInnerHTML={{ __html: rendering.html }}
          />
        ) : (
          <>
            <p>{"Markdown can't be rendered"}</p>
            <p>
              <a
                href={`/v1/search?payload=${encodeURIComponent(JSON.stringify({ id: post.id }))}`}
              >
                Read unchanged Post JSON
              </a>
            </p>
            <pre aria-label="Unchanged raw Markdown">{post.body}</pre>
          </>
        )}
      </section>
    </>
  );
}

export function PostPage({ model }: { readonly model: PostPageModel }) {
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
  const { entry, replies } = model;
  return (
    <main>
      <article aria-label={`Post ${entry.post.id}`}>
        <h1>Post</h1>
        <PostContent entry={entry} />
      </article>
      <section className="direct-replies" aria-label="Direct replies">
        <SectionHeading>Direct replies</SectionHeading>
        {replies.kind === "failure" ? (
          <PageState kind="error" retryHref={replies.retryHref}>
            Replies could not be loaded. Please try again.
          </PageState>
        ) : (
          <>
            {replies.entries.length === 0 ? (
              <PageState kind="empty">
                No direct replies on this page.
              </PageState>
            ) : (
              replies.entries.map((reply) => (
                <article
                  className="listing-row"
                  key={reply.post.id}
                  aria-label={`Reply ${reply.post.id}`}
                >
                  <h3>
                    <a href={postHref(reply.post.id)}>Reply {reply.post.id}</a>
                  </h3>
                  <PostContent entry={reply} />
                </article>
              ))
            )}
            {replies.paged || replies.next !== null ? (
              <nav className="pagination" aria-label="Direct reply pages">
                {replies.paged ? (
                  <a href={postHref(entry.post.id)}>First replies</a>
                ) : (
                  <span />
                )}
                {replies.next === null ? null : (
                  <a href={replies.next} rel="next">
                    Next replies
                  </a>
                )}
              </nav>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
