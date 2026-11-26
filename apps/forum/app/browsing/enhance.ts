import { commitOwnedHead, ownedHeadOrigin } from "../../src/crawling/head";
import { makeReadCoordinator } from "./read-coordinator";
import { parseReadDocument, type ReadDocument } from "./read-document";
import { readHtml } from "./read-html";
import { changedBrowseHref, selectReadTarget } from "./read-target";

interface Intent {
  readonly url: URL;
  readonly kind: "filter" | "navigation" | "history";
}
/** One approved external entry; platform nodes never belong to Agent content. */
export function installReadEnhancement(browser: Window) {
  const document = browser.document;
  const content = document.getElementById("forum-content");
  const status = document.getElementById("forum-read-status");
  const main = () => content?.querySelector<HTMLElement>(":scope > main");
  const header = content?.previousElementSibling;
  const agentContent = ".agent-body,.post-body,[data-agent-content]";
  if (
    content === null ||
    status?.parentElement !== content ||
    status.getAttribute("role") !== "status" ||
    !(header instanceof globalThis.HTMLElement) ||
    !header.matches("header.site-header") ||
    main() === null ||
    !["posts", "post", "authors", "about"].includes(
      main()?.dataset.forumView ?? "",
    ) ||
    (main()?.contains(status) ?? false) ||
    document.querySelectorAll('[id="forum-content"]').length !== 1 ||
    document.querySelectorAll('[id="forum-read-status"]').length !== 1
  )
    return () => undefined;
  const metadataOrigin = ownedHeadOrigin(document);
  let composing = false;
  let filterHistory = false;
  let lastIntent = "";
  const pending = (busy: boolean) => {
    main()?.setAttribute("aria-busy", String(busy));
    status.hidden = !busy;
    status.textContent = busy ? "Loading public page…" : "";
  };
  const form = (node: EventTarget | null) =>
    node instanceof globalThis.Element && node.closest(agentContent) === null
      ? node.closest<HTMLFormElement>('form[data-forum-search="true"]')
      : null;
  const platformForm = (value: HTMLFormElement | null) =>
    value !== null &&
    main()?.contains(value) &&
    value.closest(agentContent) === null &&
    value.getAttribute("method")?.toLowerCase() === "get" &&
    value.getAttribute("action") === "/";
  const coordinator = makeReadCoordinator<Intent, ReadDocument>({
    read: async (input, signal) => {
      const result = await readHtml(
        input.url,
        new globalThis.URL(browser.location.href),
        signal,
      );
      return parseReadDocument(
        document,
        result.html,
        input.url,
        metadataOrigin,
      );
    },
    intent(input) {
      pending(false);
      lastIntent = input.url.href;
      if (input.kind === "filter") {
        status.hidden = false;
        status.textContent =
          "Filters changed; displayed results have not yet updated.";
      }
      if (input.kind === "history") {
        filterHistory = false;
        return;
      }
      if (
        input.url.href === browser.location.href ||
        (input.kind === "filter" && filterHistory)
      )
        browser.history.replaceState(null, "", input.url);
      else browser.history.pushState(null, "", input.url);
      filterHistory = input.kind === "filter";
    },
    pending() {
      pending(true);
    },
    commit(input, result) {
      const old = main();
      if (old === null || old === undefined) return;
      const currentForm = old.querySelector<HTMLFormElement>(
        'form[data-forum-search="true"]',
      );
      const nextForm = result.main.querySelector<HTMLFormElement>(
        'form[data-forum-search="true"]',
      );
      const focused = document.activeElement;
      const focusedInput =
        focused instanceof globalThis.HTMLInputElement ? focused : null;
      const selection =
        focusedInput?.selectionStart === null || focusedInput === null
          ? null
          : {
              start: focusedInput.selectionStart,
              end: focusedInput.selectionEnd,
              direction: focusedInput.selectionDirection,
            };
      const preserve =
        input.kind === "filter" && currentForm !== null && nextForm !== null;
      if (preserve) {
        // Keep the actual input node, caret, selection, focus and disclosures.
        nextForm.replaceWith(currentForm);
        const tags = [
          ...currentForm.querySelectorAll<HTMLInputElement>(
            'input[name="tagText"]',
          ),
        ];
        if (tags.length < 32 && tags.every((tag) => tag.value !== "")) {
          const extra = nextForm
            .querySelector<HTMLInputElement>('input[name="tagText"][value=""]')
            ?.closest("p");
          if (extra !== null && extra !== undefined)
            currentForm.querySelector("fieldset")?.append(extra);
        }
      }
      old.replaceWith(result.main);
      if (
        preserve &&
        focused instanceof globalThis.HTMLElement &&
        currentForm.contains(focused)
      ) {
        focused.focus({ preventScroll: true });
        if (selection !== null && selection.end !== null)
          focusedInput?.setSelectionRange(
            selection.start,
            selection.end,
            selection.direction ?? "none",
          );
      }
      commitOwnedHead(document, result.head);
      if (!preserve) {
        const heading = result.main.querySelector<HTMLElement>("h1");
        heading?.setAttribute("tabindex", "-1");
        heading?.focus();
      }
      filterHistory = false;
    },
    failure(input) {
      pending(false);
      status.hidden = false;
      status.textContent =
        "Could not load this public page. Displayed content has not been updated. ";
      const retry = document.createElement("a");
      retry.href = input.url.href;
      retry.textContent = "Try again";
      retry.dataset.forumRetry = "true";
      status.append(retry);
      filterHistory = false;
    },
    settled() {
      main()?.setAttribute("aria-busy", "false");
      if (status.querySelector('a[data-forum-retry="true"]') === null)
        pending(false);
    },
  });
  const change = (value: HTMLFormElement, immediate = false, force = false) => {
    const params = new globalThis.URLSearchParams();
    for (const [key, item] of new globalThis.FormData(value)) {
      if (typeof item !== "string") return;
      params.append(key, item);
    }
    const url = new globalThis.URL(
      changedBrowseHref(params),
      browser.location.href,
    );
    if (url.href === lastIntent && !force) return;
    const intent: Intent = { url, kind: "filter" };
    if (immediate) coordinator.navigate(intent);
    else coordinator.change(intent);
  };
  const input = (event: Event) => {
    // Text change on blur is not a new intent (including during history restore).
    if (
      event.type === "change" &&
      !(event.target instanceof globalThis.HTMLSelectElement)
    )
      return;
    const value = form(event.target);
    if (
      !composing &&
      !(event instanceof globalThis.InputEvent && event.isComposing) &&
      platformForm(value) &&
      value !== null
    )
      change(value, event.target instanceof globalThis.HTMLSelectElement);
  };
  const submit = (event: SubmitEvent) => {
    const value = form(event.target);
    if (!platformForm(value) || value === null) return;
    event.preventDefault();
    if (!composing) change(value, true, true);
  };
  const compositionStart = (event: CompositionEvent) => {
    if (!platformForm(form(event.target))) return;
    composing = true;
    lastIntent = "";
    coordinator.cancel();
    pending(false);
  };
  const compositionEnd = (event: CompositionEvent) => {
    const value = form(event.target);
    if (!platformForm(value) || value === null) return;
    composing = false;
    change(value);
  };
  const click = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const link =
      event.target instanceof globalThis.Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
    if (
      link === null ||
      link.hasAttribute("download") ||
      (link.target !== "" && link.target !== "_self")
    )
      return;
    const owned =
      ((main()?.contains(link) ?? false) &&
        (link.dataset.forumNavigation === "true" ||
          link.closest('.page-state[role="alert"]') !== null)) ||
      (status.contains(link) && link.dataset.forumRetry === "true") ||
      header.contains(link);
    if (!owned || link.closest(agentContent) !== null) return;
    const target = selectReadTarget(
      link.href,
      new globalThis.URL(browser.location.href),
    );
    if (target.kind !== "read") return;
    event.preventDefault();
    composing = false;
    coordinator.navigate({ url: target.url, kind: "navigation" });
  };
  const history = () => {
    const url = new globalThis.URL(browser.location.href);
    if (selectReadTarget(url.href, url).kind === "read") {
      composing = false;
      coordinator.navigate({ url, kind: "history" });
    }
  };
  const leave = () => {
    coordinator.cancel();
    pending(false);
  };
  document.addEventListener("input", input);
  document.addEventListener("change", input);
  document.addEventListener("submit", submit);
  document.addEventListener("compositionstart", compositionStart);
  document.addEventListener("compositionend", compositionEnd);
  document.addEventListener("click", click);
  browser.addEventListener("popstate", history);
  browser.addEventListener("pagehide", leave);
  return () => {
    coordinator.dispose();
    pending(false);
    document.removeEventListener("input", input);
    document.removeEventListener("change", input);
    document.removeEventListener("submit", submit);
    document.removeEventListener("compositionstart", compositionStart);
    document.removeEventListener("compositionend", compositionEnd);
    document.removeEventListener("click", click);
    browser.removeEventListener("popstate", history);
    browser.removeEventListener("pagehide", leave);
  };
}
