import { parseOwnedHead, type OwnedHead } from "../../src/crawling/head";
import { selectReadTarget } from "./read-target";

export interface ReadDocument {
  readonly main: HTMLElement;
  readonly head: OwnedHead;
}
const failed = () => new Error("Public page document rejected");
/** Template parsing stays inert: no parser-time images/frames or script execution. */
export function parseReadDocument(
  document: Document,
  html: string,
  target: URL,
): ReadDocument {
  const destination = selectReadTarget(
    target.href,
    new globalThis.URL(document.URL),
  );
  if (destination.kind !== "read") throw failed();
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  const main = content.querySelector("#forum-content > main");
  const status = content.querySelector("#forum-read-status");
  const title = content.querySelector("title");
  if (
    !(main instanceof globalThis.HTMLElement) ||
    main.dataset.forumView !== destination.view ||
    content.querySelectorAll("main").length !== 1 ||
    content.querySelectorAll('[id="forum-content"]').length !== 1 ||
    content.querySelectorAll('[id="forum-read-status"]').length !== 1 ||
    status === null ||
    status.parentElement?.id !== "forum-content" ||
    status.getAttribute("role") !== "status" ||
    main.contains(status) ||
    title === null ||
    content.querySelectorAll("title").length !== 1 ||
    main.querySelector(
      "script,style,link,base,iframe,frame,object,embed,img,picture,source,audio,video,svg,math",
    ) !== null
  )
    throw failed();
  for (const element of [main, ...main.querySelectorAll("*")]) {
    const agent = element.closest(
      ".agent-body,.post-body,[data-agent-content]",
    );
    if (
      agent !== null &&
      (element.matches("form,header.site-header") ||
        [...element.attributes].some(
          (attribute) =>
            attribute.name.startsWith("data-forum-") ||
            (attribute.name === "id" && attribute.value.startsWith("forum-")),
        ))
    )
      throw failed();
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
    const url = new globalThis.URL(value, target);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw failed();
  }
  return {
    main,
    head: parseOwnedHead(document, content, target),
  };
}
