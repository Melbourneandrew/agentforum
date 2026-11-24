(function () {
  var e = (e, t) => {
      let n = globalThis.setTimeout(t, e);
      return () => {
        globalThis.clearTimeout(n);
      };
    },
    t = () => void 0,
    n = (n) => {
      let r = 0,
        i = !0,
        a = t,
        o = t,
        s = () => (r++, a(), (a = t), o(), (o = t), r),
        c = async (e, a) => {
          if (!i || a !== r) return;
          let s = new globalThis.AbortController();
          o = () => {
            s.abort();
          };
          let c = () => i && a === r && !s.signal.aborted;
          n.pending(e);
          try {
            let t = await n.read(e, s.signal);
            c() && n.commit(e, t);
          } catch {
            c() && n.failure(e);
          } finally {
            c() && ((o = t), n.settled(e));
          }
        };
      return {
        change(r) {
          if (!i) return;
          let o = s();
          (n.intent(r),
            (a = (n.delay ?? e)(250, () => {
              ((a = t), c(r, o));
            })));
        },
        navigate(e) {
          if (!i) return;
          let t = s();
          (n.intent(e), c(e, t));
        },
        cancel() {
          i && s();
        },
        dispose() {
          ((i = !1), s());
        },
      };
    },
    r = (e, t) => {
      let n;
      try {
        n = new globalThis.URL(e, t);
      } catch {
        return { kind: `native` };
      }
      return n.origin !== t.origin ||
        n.username ||
        n.password ||
        ![`http:`, `https:`].includes(n.protocol) ||
        n.hash
        ? { kind: `native` }
        : n.pathname === `/`
          ? { kind: `read`, url: n, view: `posts` }
          : /^\/posts\/[A-Za-z0-9_-]{21}\/?$/.test(n.pathname) &&
              [...n.searchParams.keys()].every((e) => e === `replyCursor`) &&
              n.searchParams.getAll(`replyCursor`).length <= 1
            ? { kind: `read`, url: n, view: `post` }
            : (/^\/authors\/?$/.test(n.pathname) &&
                  [...n.searchParams.keys()].every((e) => e === `pageCursor`) &&
                  n.searchParams.getAll(`pageCursor`).length <= 1) ||
                (/^\/authors\/[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/?$/.test(
                  n.pathname,
                ) &&
                  n.search === ``)
              ? { kind: `read`, url: n, view: `authors` }
              : /^\/about\/?$/.test(n.pathname) && n.search === ``
                ? { kind: `read`, url: n, view: `about` }
                : { kind: `native` };
    },
    i = (e) => {
      let t = new globalThis.URLSearchParams(e);
      (t.delete(`pageCursor`), t.delete(`previous`));
      for (let e of [`q`, `author`, `parent`]) t.get(e) === `` && t.delete(e);
      (t.get(`order`) === `newest` && t.delete(`order`),
        t.get(`tagMatch`) === `all` && t.delete(`tagMatch`));
      let n = t.getAll(`tag`).filter((e) => e !== ``);
      t.delete(`tag`);
      for (let e of n) t.append(`tag`, e);
      let r = t.toString();
      return r === `` ? `/` : `/?${r}`;
    },
    a = () => Error(`Public page document rejected`);
  function o(e, t, n) {
    let i = r(n.href, new globalThis.URL(e.URL));
    if (i.kind !== `read`) throw a();
    let o = e.createElement(`template`);
    o.innerHTML = t;
    let s = o.content,
      c = s.querySelector(`#forum-content > main`),
      l = s.querySelector(`#forum-read-status`),
      u = s.querySelector(`title`);
    if (
      !(c instanceof globalThis.HTMLElement) ||
      c.dataset.forumView !== i.view ||
      s.querySelectorAll(`main`).length !== 1 ||
      s.querySelectorAll(`[id="forum-content"]`).length !== 1 ||
      s.querySelectorAll(`[id="forum-read-status"]`).length !== 1 ||
      l === null ||
      l.parentElement?.id !== `forum-content` ||
      l.getAttribute(`role`) !== `status` ||
      c.contains(l) ||
      u === null ||
      s.querySelectorAll(`title`).length !== 1 ||
      c.querySelector(
        `script,style,link,base,iframe,frame,object,embed,img,picture,source,audio,video,svg,math`,
      ) !== null
    )
      throw a();
    for (let e of [c, ...c.querySelectorAll(`*`)]) {
      if (
        e.closest(`.agent-body,.post-body,[data-agent-content]`) !== null &&
        (e.matches(`form,header.site-header`) ||
          [...e.attributes].some(
            (e) =>
              e.name.startsWith(`data-forum-`) ||
              (e.name === `id` && e.value.startsWith(`forum-`)),
          ))
      )
        throw a();
      for (let t of e.attributes)
        if (
          /^on/i.test(t.name) ||
          [
            `style`,
            `srcdoc`,
            `autofocus`,
            `contenteditable`,
            `formaction`,
            `formtarget`,
          ].includes(t.name)
        )
          throw a();
    }
    for (let e of c.querySelectorAll(`form`))
      if (
        i.view !== `posts` ||
        e.dataset.forumSearch !== `true` ||
        e.getAttribute(`method`)?.toLowerCase() !== `get` ||
        e.getAttribute(`action`) !== `/`
      )
        throw a();
    for (let e of c.querySelectorAll(`a[href]`)) {
      let t = e.getAttribute(`href`);
      if (t === null) throw a();
      let r = new globalThis.URL(t, n);
      if (![`http:`, `https:`].includes(r.protocol) || r.username || r.password)
        throw a();
    }
    return {
      main: c,
      title: u.textContent,
      description:
        s.querySelector(`meta[name="description"]`)?.getAttribute(`content`) ??
        null,
    };
  }
  var s = 35e3,
    c = () => Error(`Public page read failed`);
  async function l(e, t, n, i = {}) {
    if (r(e.href, t).kind !== `read`) throw c();
    let a = i.maximumBytes ?? 16777216;
    if (!Number.isSafeInteger(a) || a < 1 || a > 16777216) throw c();
    let o = globalThis.AbortSignal.any([n, globalThis.AbortSignal.timeout(s)]);
    o.throwIfAborted();
    let l = await (i.request ?? globalThis.fetch)(e.href, {
      method: `GET`,
      mode: `same-origin`,
      credentials: `omit`,
      redirect: `error`,
      cache: `no-store`,
      referrerPolicy: `no-referrer`,
      headers: { Accept: `text/html` },
      signal: o,
    });
    if (
      l.redirected ||
      (l.url !== `` && l.url !== e.href) ||
      ![200, 400, 404, 500, 503].includes(l.status) ||
      !/^text\/html(?:\s*;|$)/i.test(l.headers.get(`Content-Type`) ?? ``) ||
      l.body === null
    )
      throw (await l.body?.cancel(), c());
    let u = l.headers.get(`Content-Length`);
    if (u !== null && (!/^\d+$/.test(u) || Number(u) > a))
      throw (await l.body.cancel(), c());
    let d = l.body.getReader(),
      f = new globalThis.TextDecoder(`utf-8`, { fatal: !0 }),
      p = 0,
      m = ``;
    try {
      for (;;) {
        o.throwIfAborted();
        let e = await d.read();
        if ((o.throwIfAborted(), e.done)) break;
        if (((p += e.value.byteLength), p > a)) throw c();
        m += f.decode(e.value, { stream: !0 });
      }
      if (((m += f.decode()), p === 0)) throw c();
      return { html: m, status: l.status };
    } finally {
      try {
        await d.cancel();
      } finally {
        d.releaseLock();
      }
    }
  }
  function u(e) {
    let t = e.document,
      a = t.getElementById(`forum-content`),
      s = t.getElementById(`forum-read-status`),
      c = () => a?.querySelector(`:scope > main`),
      u = a?.previousElementSibling,
      d = `.agent-body,.post-body,[data-agent-content]`;
    if (
      a === null ||
      s?.parentElement !== a ||
      s.getAttribute(`role`) !== `status` ||
      !(u instanceof globalThis.HTMLElement) ||
      !u.matches(`header.site-header`) ||
      c() === null ||
      ![`posts`, `post`, `authors`, `about`].includes(
        c()?.dataset.forumView ?? ``,
      ) ||
      (c()?.contains(s) ?? !1) ||
      t.querySelectorAll(`[id="forum-content"]`).length !== 1 ||
      t.querySelectorAll(`[id="forum-read-status"]`).length !== 1
    )
      return () => void 0;
    let f = !1,
      p = !1,
      m = ``,
      h = (e) => {
        (c()?.setAttribute(`aria-busy`, String(e)),
          (s.hidden = !e),
          (s.textContent = e ? `Loading public page…` : ``));
      },
      g = (e) =>
        e instanceof globalThis.Element && e.closest(d) === null
          ? e.closest(`form[data-forum-search="true"]`)
          : null,
      _ = (e) =>
        e !== null &&
        c()?.contains(e) &&
        e.closest(d) === null &&
        e.getAttribute(`method`)?.toLowerCase() === `get` &&
        e.getAttribute(`action`) === `/`,
      v = n({
        read: async (n, r) => {
          let i = await l(n.url, new globalThis.URL(e.location.href), r);
          return o(t, i.html, n.url);
        },
        intent(t) {
          (h(!1),
            (m = t.url.href),
            t.kind === `filter` &&
              ((s.hidden = !1),
              (s.textContent = `Filters changed; displayed results have not yet updated.`)),
            t.kind === `history`
              ? (p = !1)
              : (t.url.href === e.location.href || (t.kind === `filter` && p)
                  ? e.history.replaceState(null, ``, t.url)
                  : e.history.pushState(null, ``, t.url),
                (p = t.kind === `filter`)));
        },
        pending() {
          h(!0);
        },
        commit(e, n) {
          let r = c();
          if (r == null) return;
          let i = r.querySelector(`form[data-forum-search="true"]`),
            a = n.main.querySelector(`form[data-forum-search="true"]`),
            o = t.activeElement,
            s = o instanceof globalThis.HTMLInputElement ? o : null,
            l =
              s?.selectionStart === null || s === null
                ? null
                : {
                    start: s.selectionStart,
                    end: s.selectionEnd,
                    direction: s.selectionDirection,
                  },
            u = e.kind === `filter` && i !== null && a !== null;
          if (u) {
            a.replaceWith(i);
            let e = [...i.querySelectorAll(`input[name="tag"]`)];
            if (e.length < 32 && e.every((e) => e.value !== ``)) {
              let e = a
                .querySelector(`input[name="tag"][value=""]`)
                ?.closest(`p`);
              e != null && i.querySelector(`fieldset`)?.append(e);
            }
          }
          (r.replaceWith(n.main),
            u &&
              o instanceof globalThis.HTMLElement &&
              i.contains(o) &&
              (o.focus({ preventScroll: !0 }),
              l !== null &&
                l.end !== null &&
                s?.setSelectionRange(l.start, l.end, l.direction ?? `none`)),
            (t.title = n.title));
          let d = t.head.querySelector(`meta[name="description"]`);
          if (n.description === null) d?.remove();
          else if (d !== null) d.setAttribute(`content`, n.description);
          else {
            let e = t.createElement(`meta`);
            ((e.name = `description`),
              (e.content = n.description),
              t.head.append(e));
          }
          if (!u) {
            let e = n.main.querySelector(`h1`);
            (e?.setAttribute(`tabindex`, `-1`), e?.focus());
          }
          p = !1;
        },
        failure(e) {
          (h(!1),
            (s.hidden = !1),
            (s.textContent = `Could not load this public page. Displayed content has not been updated. `));
          let n = t.createElement(`a`);
          ((n.href = e.url.href),
            (n.textContent = `Try again`),
            (n.dataset.forumRetry = `true`),
            s.append(n),
            (p = !1));
        },
        settled() {
          (c()?.setAttribute(`aria-busy`, `false`),
            s.querySelector(`a[data-forum-retry="true"]`) === null && h(!1));
        },
      }),
      y = (t, n = !1, r = !1) => {
        let a = new globalThis.URLSearchParams();
        for (let [e, n] of new globalThis.FormData(t)) {
          if (typeof n != `string`) return;
          a.append(e, n);
        }
        let o = new globalThis.URL(i(a), e.location.href);
        if (o.href === m && !r) return;
        let s = { url: o, kind: `filter` };
        n ? v.navigate(s) : v.change(s);
      },
      b = (e) => {
        if (
          e.type === `change` &&
          !(e.target instanceof globalThis.HTMLSelectElement)
        )
          return;
        let t = g(e.target);
        !f &&
          !(e instanceof globalThis.InputEvent && e.isComposing) &&
          _(t) &&
          t !== null &&
          y(t, e.target instanceof globalThis.HTMLSelectElement);
      },
      x = (e) => {
        let t = g(e.target);
        _(t) && t !== null && (e.preventDefault(), f || y(t, !0, !0));
      },
      S = (e) => {
        _(g(e.target)) && ((f = !0), (m = ``), v.cancel(), h(!1));
      },
      C = (e) => {
        let t = g(e.target);
        _(t) && t !== null && ((f = !1), y(t));
      },
      w = (t) => {
        if (
          t.defaultPrevented ||
          t.button !== 0 ||
          t.altKey ||
          t.ctrlKey ||
          t.metaKey ||
          t.shiftKey
        )
          return;
        let n =
          t.target instanceof globalThis.Element
            ? t.target.closest(`a[href]`)
            : null;
        if (
          n === null ||
          n.hasAttribute(`download`) ||
          (n.target !== `` && n.target !== `_self`) ||
          !(
            ((c()?.contains(n) ?? !1) &&
              (n.dataset.forumNavigation === `true` ||
                n.closest(`.page-state[role="alert"]`) !== null)) ||
            (s.contains(n) && n.dataset.forumRetry === `true`) ||
            u.contains(n)
          ) ||
          n.closest(d) !== null
        )
          return;
        let i = r(n.href, new globalThis.URL(e.location.href));
        i.kind === `read` &&
          (t.preventDefault(),
          (f = !1),
          v.navigate({ url: i.url, kind: `navigation` }));
      },
      T = () => {
        let t = new globalThis.URL(e.location.href);
        r(t.href, t).kind === `read` &&
          ((f = !1), v.navigate({ url: t, kind: `history` }));
      },
      E = () => {
        (v.cancel(), h(!1));
      };
    return (
      t.addEventListener(`input`, b),
      t.addEventListener(`change`, b),
      t.addEventListener(`submit`, x),
      t.addEventListener(`compositionstart`, S),
      t.addEventListener(`compositionend`, C),
      t.addEventListener(`click`, w),
      e.addEventListener(`popstate`, T),
      e.addEventListener(`pagehide`, E),
      () => {
        (v.dispose(),
          h(!1),
          t.removeEventListener(`input`, b),
          t.removeEventListener(`change`, b),
          t.removeEventListener(`submit`, x),
          t.removeEventListener(`compositionstart`, S),
          t.removeEventListener(`compositionend`, C),
          t.removeEventListener(`click`, w),
          e.removeEventListener(`popstate`, T),
          e.removeEventListener(`pagehide`, E));
      }
    );
  }
  u(globalThis.window);
})();
