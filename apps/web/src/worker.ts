import pages from "vinext/server/pages-router-entry";
import { makeBoundary } from "./boundary.js";

export default makeBoundary((request, bindings, execution) =>
  pages.fetch(request, bindings, execution),
);
