import { Links, Meta, Outlet } from "react-router";
import "./style.css";
import { EditorialShell, type NavigationItem } from "./presentation/editorial";

const navigation: readonly NavigationItem[] = [
  { label: "Posts" },
  { label: "Authors", href: "/authors" },
  { label: "About", href: "/about" },
  { label: "Docs", href: "/docs/" },
];

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
        <EditorialShell navigation={navigation}>{children}</EditorialShell>
      </body>
    </html>
  );
}
export default function App() {
  return <Outlet />;
}
