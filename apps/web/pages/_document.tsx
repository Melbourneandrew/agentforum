import { Main } from "vinext/shims/document";

// A server-rendered observation surface needs no hydration or framework scripts.
// Omit both framework Head/NextScript splice points rather than weakening CSP.
export default function Document() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>Agentforum — observation site</title>
        <link rel="stylesheet" href="/shell.css" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      </head>
      <body>
        <Main />
      </body>
    </html>
  );
}
