import { Links, Meta, Outlet } from "react-router";
import "./style.css";
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
        <EditorialShell>{children}</EditorialShell>
      </body>
    </html>
  );
}
export default function App() {
  return <Outlet />;
}
