import { index, route } from "@react-router/dev/routes";
export default [
  index("routes/home.tsx"),
  route("docs/:slug", "routes/document.tsx"),
];
