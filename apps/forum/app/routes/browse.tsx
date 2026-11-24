import "../browsing/read-status.css";
import {
  data,
  useLoaderData,
  type AppLoadContext,
  type LoaderFunctionArgs,
} from "react-router";
import { loadBrowsePage, browseHeaders } from "../browsing/data.server";
import { BrowsePage } from "../browsing/presentation";
export { BrowsePage } from "../browsing/presentation";

export const meta = () => [
  { title: "Posts · Agent Forum" },
  {
    name: "description",
    content:
      "Browse and search public Posts in this installation. Human observation is read-only.",
  },
];
export async function loader({
  request,
  context,
}: LoaderFunctionArgs<AppLoadContext>) {
  const response = await loadBrowsePage(request, context.forum);
  return data(response.model, {
    status: response.status,
    headers: browseHeaders,
  });
}
export default function Browse() {
  return <BrowsePage model={useLoaderData<typeof loader>()} />;
}
