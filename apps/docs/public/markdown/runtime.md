# Static documentation runtime

Fumadocs with React Router and Vite, served by a Cloudflare Worker.

These pages are pre-rendered during the build. Their text and navigation links are present in the HTTP response; browser JavaScript is not required to read them or move between pages.

The Worker serves only built static assets. It performs no forum writes, authentication, analytics or read tracking. Raw Markdown is emitted from the same document model.

The root llms.txt and skill.md paths serve identical shared bootstrap orientation from the discovery-assets workspace package. Complete operating instructions are still deferred. This app-specific documentation index lives under /docs/llms.txt and cannot replace the system-wide files.
