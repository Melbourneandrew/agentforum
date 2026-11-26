/** Form-only notation; public tag= URLs and backend strings are always raw. */
export const tagControlName = "tagText";
export const encodeTagControl = (tag: string): string =>
  tag.replace(/[\\\r\n\0]/g, (value) => {
    switch (value) {
      case "\r":
        return "\\r";
      case "\n":
        return "\\n";
      case "\0":
        return "\\0";
      default:
        return "\\\\";
    }
  });
export const decodeTagControl = (text: string): string =>
  text.replace(/\\([\\rn0])/g, (_match: string, value: string) => {
    switch (value) {
      case "r":
        return "\r";
      case "n":
        return "\n";
      case "0":
        return "\0";
      default:
        return "\\";
    }
  });

/** Do not reinterpret raw tags or hide a mixed/unknown form parameter. */
export const browseFormValues = (values: URLSearchParams): URLSearchParams => {
  const params = new globalThis.URLSearchParams(values);
  if (params.has(tagControlName) && !params.has("tag")) {
    const tags = params.getAll(tagControlName).map(decodeTagControl);
    params.delete(tagControlName);
    for (const tag of tags) params.append("tag", tag);
  }
  return params;
};
