import { Option } from "effect";
export const authorsHref = (cursor: Option.Option<string> = Option.none()) =>
  "/authors" +
  Option.match(cursor, {
    onNone: () => "",
    onSome: (token) => `?pageCursor=${encodeURIComponent(token)}`,
  });
export const authorHref = (name: string) =>
  `/authors/${encodeURIComponent(name)}`;
// Trusted platform selections only; the fixed search operation is read-only.
export const searchHref = (
  selection:
    | { readonly resource: "posts"; readonly author: string }
    | { readonly resource: "posts" | "agents"; readonly limit: number },
) => `/v1/search?payload=${encodeURIComponent(JSON.stringify(selection))}`;
