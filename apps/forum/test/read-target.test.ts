import { describe, expect, it } from "vitest";
import {
  changedBrowseHref,
  selectReadTarget,
} from "../app/browsing/read-target";
const current = new URL("https://forum.owner.workers.dev/?q=old");
describe("first-party read-target policy before DOM integration", () => {
  it("admits only local read-only page shapes, not arbitrary same-origin paths", () => {
    for (const href of [
      "/",
      "/?q=new",
      "/posts/" + "a".repeat(21),
      "/authors",
      "/authors?pageCursor=x",
      "/authors/Canonical-Name",
      "/about",
    ])
      expect(selectReadTarget(href, current).kind).toBe("read");
    for (const href of [
      "/v1/register?payload=x",
      "/v1/publish",
      "/v1/search",
      "/docs/",
      "/llms.txt",
      "/robots.txt",
      "/posts/" + "a".repeat(21) + "/raw",
      "/posts/bad",
      "/authors/name?private=1",
      "/about?x=1",
      "//elsewhere.invalid/",
      "javascript:alert(1)",
      "data:text/html,attack",
      "/posts/../v1/register",
      "/authors/%2Fv1%2Fpublish",
      "/posts/" + "a".repeat(21) + "?replyCursor=a&replyCursor=b",
      "https://user:pass@forum.owner.workers.dev/",
    ])
      expect(selectReadTarget(href, current).kind).toBe("native");
  });
  it("leaves fragments native but allows an explicit same-URL retry read", () => {
    expect(selectReadTarget("#forum-content", current).kind).toBe("native");
    expect(selectReadTarget(current.href, current).kind).toBe("read");
  });
  it("clears both cursor modes on control changes and preserves exact opaque Tags", () => {
    const params = new URLSearchParams(
      "q=next&author=&parent=&tagMatch=all&order=oldest&pageCursor=old&previous=first&previous=second",
    );
    params.append("tag", " C++ ");
    params.append("tag", "x.y&z#");
    params.append("tag", "");
    const href = changedBrowseHref(params);
    const url = new URL(href, current);
    expect(url.searchParams.has("pageCursor")).toBe(false);
    expect(url.searchParams.has("previous")).toBe(false);
    expect(url.searchParams.getAll("tag")).toEqual([" C++ ", "x.y&z#"]);
    expect(url.searchParams.get("order")).toBe("oldest");
    expect(params.get("pageCursor")).toBe("old");
    expect(
      changedBrowseHref(
        new URLSearchParams(
          "q=&author=&parent=&tag=&tagMatch=all&order=newest",
        ),
      ),
    ).toBe("/");
  });
});
