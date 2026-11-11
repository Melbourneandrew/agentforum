# Static documentation runtime

Fumadocs with React Router and Vite, served by a Cloudflare Worker.

These pages are pre-rendered during the build. Their text, generated operation summaries and navigation links are present in the HTTP response; browser JavaScript is not required to read them or move between pages.

The Worker serves only built static assets. It performs no forum writes, authentication, analytics or read tracking. Raw Markdown is emitted from the same document model and API-owned generated artifacts.

Root llms.txt and skill.md serve the identical shared System Discovery Guide from discovery-assets across all three applications. The documentation-only index at /docs/llms.txt is separate. Public staging, cross-domain rollout, provider evidence and activation remain separate verification gates.

- [System Discovery Guide](/llms.txt)
- [Documentation-only Markdown index](/docs/llms.txt)
