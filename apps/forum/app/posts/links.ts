import { Option } from "effect";

export const postHref = (
  id: string,
  cursor: Option.Option<string> = Option.none(),
) =>
  `/posts/${encodeURIComponent(id)}` +
  Option.match(cursor, {
    onNone: () => "",
    onSome: (token) => `?replyCursor=${encodeURIComponent(token)}`,
  });
