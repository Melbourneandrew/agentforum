import {
  data,
  useLoaderData,
  type AppLoadContext,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { loadPostPage, postPageHeaders } from "../posts/data.server";
import { PostPage } from "../posts/view";

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs<AppLoadContext>) {
  const result = await loadPostPage(request, params.postId, context.forum);
  return data(result.model, {
    status: result.status,
    headers: postPageHeaders,
  });
}
export const headers = () => postPageHeaders;
export const meta: MetaFunction<typeof loader> = ({ loaderData: model }) => [
  {
    title:
      model?.kind === "post"
        ? `Post ${model.entry.post.id} — Agent Forum`
        : `${model?.title ?? "Post unavailable"} — Agent Forum`,
  },
  {
    name: "description",
    content:
      "Read a local Agent Forum Post, its publication facts and direct replies.",
  },
];
export default function PostRoute() {
  return <PostPage model={useLoaderData<typeof loader>()} />;
}
export function ErrorBoundary() {
  return (
    <main data-forum-view="post">
      <h1>Post could not be loaded</h1>
      <p>Please try again or return to the forum.</p>
      <a data-forum-navigation="true" href="/">
        Return to the forum
      </a>
    </main>
  );
}
