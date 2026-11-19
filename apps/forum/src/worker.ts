import { createRequestHandler } from "react-router";
import { makeDispatcher } from "./runtime/dispatch.js";

const render = createRequestHandler(
  async () => {
    const {
      basename,
      unstable_getCriticalCss,
      allowedActionOrigins,
      ...build
    } = await import("virtual:react-router/server-build");
    return {
      ...build,
      ...(basename !== undefined ? { basename } : {}),
      ...(unstable_getCriticalCss !== undefined
        ? { unstable_getCriticalCss }
        : {}),
      ...(allowedActionOrigins !== undefined ? { allowedActionOrigins } : {}),
    };
  },
  import.meta.env.MODE,
);
export default makeDispatcher((request, forum) => render(request, { forum }));
