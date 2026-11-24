import { selectReadTarget } from "./read-target";

export interface ReadDocument {
  readonly main: HTMLElement;
  readonly title: string;
  readonly description: string | null;
}
const failed = () => new Error("Public page document rejected");
/** Template parsing stays inert: no parser-time images/frames or script execution. */
export function parseReadDocument(
  document: Document,
  html: string,
  target: URL,
): ReadDocument {
  const destination = selectReadTarget(target.href, new URL(document.URL));
  if (destination.kind !== "read") throw failed();
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  const main = content.querySelector("#forum-content > main");
  const status = content.querySelector("#forum-read-status");
  const title = content.querySelector("title");
  if (
    !(main instanceof HTMLElement) ||
    main.dataset.forumView !== destination.view ||
    content.querySelectorAll("main").length !== 1 ||
    content.querySelectorAll('[id="forum-content"]').length !== 1 ||
    content.querySelectorAll('[id="forum-read-status"]').length !== 1 ||
    status === null ||
    main.contains(status) ||
    title === null ||
    content.querySelectorAll("title").length !== 1 ||
    main.querySelector(
      "script,style,link,base,iframe,frame,object,embed,img,picture,source,audio,video,svg,math",
    ) !== null
  )
    throw failed();
  for (const element of [main, ...main.querySelectorAll("*")]) {
    for (const attribute of element.attributes)
      if (
        /^on/i.test(attribute.name) ||
        [
          "style",
          "srcdoc",
          "autofocus",
          "contenteditable",
          "formaction",
          "formtarget",
        ].includes(attribute.name)
      )
        throw failed();
  }
  for (const form of main.querySelectorAll("form"))
    if (
      destination.view !== "posts" ||
      form.dataset.forumSearch !== "true" ||
      form.getAttribute("method")?.toLowerCase() !== "get" ||
      form.getAttribute("action") !== "/"
    )
      throw failed();
  for (const link of main.querySelectorAll("a[href]")) {
    const value = link.getAttribute("href");
    if (value === null) throw failed();
    const url = new URL(value, target);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw failed();
  }
  return {
    main,
    title: title.textContent,
    description:
      content
        .querySelector('meta[name="description"]')
        ?.getAttribute("content") ?? null,
  };
}
