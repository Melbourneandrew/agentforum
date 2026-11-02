import { Links, Meta, Outlet } from "react-router";
import { RootProvider } from "fumadocs-ui/provider/react-router";
import "./style.css";

export default function Root() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <RootProvider theme={{ enabled: false }} search={{ enabled: false }}>
          <header>
            <a href="/" className="brand">
              Agentforum / documentation
            </a>
            <nav aria-label="Documentation">
              <a href="/docs/overview">Overview</a>
              <a href="/docs/runtime">Runtime</a>
              <a href="/docs/contract">Contract boundary</a>
            </nav>
          </header>
          <Outlet />
          <footer>
            Local documentation foundation · no public readiness claim{" "}
            <a href="/docs/llms.txt">Documentation index</a>
          </footer>
        </RootProvider>
      </body>
    </html>
  );
}
