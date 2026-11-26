import { index, route, type RouteConfig } from "@react-router/dev/routes";
export default [
  index("routes/browse.tsx"),
  route("posts/:postId", "routes/post.tsx"),
  route("authors/:name?", "routes/authors.tsx"),
  route("about", "routes/about.tsx"),
] satisfies RouteConfig;
