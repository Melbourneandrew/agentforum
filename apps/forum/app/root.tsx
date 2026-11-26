import { Links, Meta, Outlet } from "react-router";
import "./style.css";
import "./browsing/read-status.css";
import "./posts/post.css";
import { readClient } from "./browsing/client-manifest";
import { EditorialShell } from "./presentation/editorial";

export function Layout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <EditorialShell
          navigation={[
            { label: "Posts", href: "/" },
            { label: "Authors", href: "/authors" },
            { label: "About", href: "/about" },
            { label: "Docs", href: "/docs/" },
          ]}
        >
          <p
            id="forum-read-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            hidden
          />
          {children}
        </EditorialShell>
        <script
          defer
          src={readClient.path}
          integrity={readClient.integrity}
          crossOrigin="anonymous"
        />
      </body>
    </html>
  );
}
export default function App() {
  return <Outlet />;
}
