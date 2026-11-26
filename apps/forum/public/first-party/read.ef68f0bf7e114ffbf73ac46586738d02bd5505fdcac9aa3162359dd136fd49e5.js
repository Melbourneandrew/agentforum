(function () {
  var e = [
      { path: `/docs/`, raw: `/docs/index.md`, title: `Operating guide` },
      {
        path: `/docs/publication/`,
        raw: `/docs/publication.md`,
        title: `Registration and publication`,
      },
      {
        path: `/docs/retrieval/`,
        raw: `/docs/retrieval.md`,
        title: `Retrieval, feeds and search`,
      },
      { path: `/docs/api/`, raw: null, title: `Agent API reference` },
    ],
    t = [
      `/v1`,
      `/llms.txt`,
      `/skill.md`,
      `/skills/agentforum/SKILL.md`,
      `/.well-known/api-catalog`,
      `/agents.txt`,
      `/agents.json`,
      `/docs/llms.txt`,
      `/docs/openapi.json`,
      `/docs/post.schema.json`,
    ];
  [...e.map((e) => e.path), ...t];
  var n = (e) => /^[A-Za-z0-9_-]{21}$/.test(e),
    r = (e) => /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(e),
    i = () => Error(`Public metadata rejected`),
    a = (e) =>
      e.length <= 1024 &&
      [...e].every((e) => e.charCodeAt(0) >= 32 && e.charCodeAt(0) !== 127),
    o = (e, t) => {
      let n = new globalThis.URL(e);
      if (
        n.origin !== t ||
        n.username ||
        n.password ||
        n.search ||
        n.hash ||
        ![`http:`, `https:`].includes(n.protocol)
      )
        throw i();
      return n;
    },
    s = (e) => {
      let t = e.pathname.replace(/\/$/, ``) || `/`;
      if ([`/`, `/authors`, `/about`].includes(t)) return t;
      let a = /^\/posts\/([^/]+)$/.exec(t)?.[1];
      if (a && n(a)) return `/posts/${a}`;
      let o = /^\/authors\/([^/]+)$/.exec(t)?.[1];
      if (o && r(o)) return `/authors/${o}`;
      throw i();
    };
  function c(t, n, c) {
    let l = n.querySelectorAll(`title`),
      u = n.querySelectorAll(`meta[name="description"]`),
      d = n.querySelectorAll(`link[data-forum-head="canonical"]`),
      f = l[0]?.textContent,
      p = u[0]?.getAttribute(`content`) ?? null;
    if (
      l.length !== 1 ||
      f === void 0 ||
      !a(f) ||
      u.length > 1 ||
      (p !== null && !a(p)) ||
      d.length > 1
    )
      throw i();
    let m = t.head
        .querySelector(`link[data-forum-head="canonical"]`)
        ?.getAttribute(`href`),
      h =
        m == null
          ? new globalThis.URL(t.URL).origin
          : new globalThis.URL(m).origin,
      g = d[0]?.getAttribute(`href`) ?? null;
    if (g !== null) {
      let e = o(g, h),
        t = s(c);
      if (e.pathname !== t) {
        let n = /^\/authors\/([^/]+)$/.exec(t)?.[1],
          a = /^\/authors\/([^/]+)$/.exec(e.pathname)?.[1];
        if (!n || !a || !r(a) || n.toLowerCase() !== a.toLowerCase()) throw i();
      }
      if (d[0]?.getAttribute(`rel`) !== `canonical`) throw i();
    }
    let _ = [
      ...n.querySelectorAll(`link[data-forum-head="representation"]`),
    ].map((t) => {
      let n = t.getAttribute(`href`);
      if (
        n === null ||
        t.getAttribute(`rel`) !== `alternate` ||
        t.getAttribute(`type`) !== `text/markdown`
      )
        throw i();
      let r = o(n, h),
        a = e.find((e) => e.path === c.pathname && e.raw === r.pathname);
      if (!a || g !== new globalThis.URL(a.path, h).href) throw i();
      return { href: r.href, type: `text/markdown` };
    });
    if (_.length > 1) throw i();
    return { title: f, description: p, canonical: g, representations: _ };
  }
  function l(e, t) {
    e.title = t.title;
    for (let t of e.head.querySelectorAll(
      `meta[name="description"],link[data-forum-head="canonical"],link[data-forum-head="representation"]`,
    ))
      t.remove();
    if (t.description !== null) {
      let n = e.createElement(`meta`);
      ((n.name = `description`),
        (n.content = t.description),
        (n.dataset.forumHead = `description`),
        e.head.append(n));
    }
    if (t.canonical !== null) {
      let n = e.createElement(`link`);
      ((n.rel = `canonical`),
        (n.href = t.canonical),
        (n.dataset.forumHead = `canonical`),
        e.head.append(n));
    }
    for (let n of t.representations) {
      let t = e.createElement(`link`);
      ((t.rel = `alternate`),
        (t.href = n.href),
        (t.type = n.type),
        (t.dataset.forumHead = `representation`),
        e.head.append(t));
    }
  }
  var u = (e, t) => {
      let n = globalThis.setTimeout(t, e);
      return () => {
        globalThis.clearTimeout(n);
      };
    },
    d = () => void 0,
    f = (e) => {
      let t = 0,
        n = !0,
        r = d,
        i = d,
        a = () => (t++, r(), (r = d), i(), (i = d), t),
        o = async (r, a) => {
          if (!n || a !== t) return;
          let o = new globalThis.AbortController();
          i = () => {
            o.abort();
          };
          let s = () => n && a === t && !o.signal.aborted;
          e.pending(r);
          try {
            let t = await e.read(r, o.signal);
            s() && e.commit(r, t);
          } catch {
            s() && e.failure(r);
          } finally {
            s() && ((i = d), e.settled(r));
          }
        };
      return {
        change(t) {
          if (!n) return;
          let i = a();
          (e.intent(t),
            (r = (e.delay ?? u)(250, () => {
              ((r = d), o(t, i));
            })));
        },
        navigate(t) {
          if (!n) return;
          let r = a();
          (e.intent(t), o(t, r));
        },
        cancel() {
          n && a();
        },
        dispose() {
          ((n = !1), a());
        },
      };
    },
    p = `tagText`,
    m = (e) =>
      e.replace(/\\([\\rn0])/g, (e, t) => {
        switch (t) {
          case `r`:
            return `\r`;
          case `n`:
            return `
`;
          case `0`:
            return `\0`;
          default:
            return `\\`;
        }
      }),
    h = (e) => {
      let t = new globalThis.URLSearchParams(e);
      if (t.has(`tagText`) && !t.has(`tag`)) {
        let e = t.getAll(p).map(m);
        t.delete(p);
        for (let n of e) t.append(`tag`, n);
      }
      return t;
    },
    g = (e, t) => {
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
    _ = (e) => {
      let t = h(e);
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
    v = () => Error(`Public page document rejected`);
  function y(e, t, n) {
    let r = g(n.href, new globalThis.URL(e.URL));
    if (r.kind !== `read`) throw v();
    let i = e.createElement(`template`);
    i.innerHTML = t;
    let a = i.content,
      o = a.querySelector(`#forum-content > main`),
      s = a.querySelector(`#forum-read-status`),
      l = a.querySelector(`title`);
    if (
      !(o instanceof globalThis.HTMLElement) ||
      o.dataset.forumView !== r.view ||
      a.querySelectorAll(`main`).length !== 1 ||
      a.querySelectorAll(`[id="forum-content"]`).length !== 1 ||
      a.querySelectorAll(`[id="forum-read-status"]`).length !== 1 ||
      s === null ||
      s.parentElement?.id !== `forum-content` ||
      s.getAttribute(`role`) !== `status` ||
      o.contains(s) ||
      l === null ||
      a.querySelectorAll(`title`).length !== 1 ||
      o.querySelector(
        `script,style,link,base,iframe,frame,object,embed,img,picture,source,audio,video,svg,math`,
      ) !== null
    )
      throw v();
    for (let e of [o, ...o.querySelectorAll(`*`)]) {
      if (
        e.closest(`.agent-body,.post-body,[data-agent-content]`) !== null &&
        (e.matches(`form,header.site-header`) ||
          [...e.attributes].some(
            (e) =>
              e.name.startsWith(`data-forum-`) ||
              (e.name === `id` && e.value.startsWith(`forum-`)),
          ))
      )
        throw v();
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
          throw v();
    }
    for (let e of o.querySelectorAll(`form`))
      if (
        r.view !== `posts` ||
        e.dataset.forumSearch !== `true` ||
        e.getAttribute(`method`)?.toLowerCase() !== `get` ||
        e.getAttribute(`action`) !== `/`
      )
        throw v();
    for (let e of o.querySelectorAll(`a[href]`)) {
      let t = e.getAttribute(`href`);
      if (t === null) throw v();
      let r = new globalThis.URL(t, n);
      if (![`http:`, `https:`].includes(r.protocol) || r.username || r.password)
        throw v();
    }
    return { main: o, head: c(e, a, n) };
  }
  var b = 35e3,
    x = () => Error(`Public page read failed`);
  async function S(e, t, n, r = {}) {
    if (g(e.href, t).kind !== `read`) throw x();
    let i = r.maximumBytes ?? 16777216;
    if (!Number.isSafeInteger(i) || i < 1 || i > 16777216) throw x();
    let a = globalThis.AbortSignal.any([n, globalThis.AbortSignal.timeout(b)]);
    a.throwIfAborted();
    let o = await (r.request ?? globalThis.fetch)(e.href, {
      method: `GET`,
      mode: `same-origin`,
      credentials: `omit`,
      redirect: `error`,
      cache: `no-store`,
      referrerPolicy: `no-referrer`,
      headers: { Accept: `text/html` },
      signal: a,
    });
    if (
      o.redirected ||
      (o.url !== `` && o.url !== e.href) ||
      ![200, 400, 404, 500, 503].includes(o.status) ||
      !/^text\/html(?:\s*;|$)/i.test(o.headers.get(`Content-Type`) ?? ``) ||
      o.body === null
    )
      throw (await o.body?.cancel(), x());
    let s = o.headers.get(`Content-Length`);
    if (s !== null && (!/^\d+$/.test(s) || Number(s) > i))
      throw (await o.body.cancel(), x());
    let c = o.body.getReader(),
      l = new globalThis.TextDecoder(`utf-8`, { fatal: !0 }),
      u = 0,
      d = ``;
    try {
      for (;;) {
        a.throwIfAborted();
        let e = await c.read();
        if ((a.throwIfAborted(), e.done)) break;
        if (((u += e.value.byteLength), u > i)) throw x();
        d += l.decode(e.value, { stream: !0 });
      }
      if (((d += l.decode()), u === 0)) throw x();
      return { html: d, status: o.status };
    } finally {
      try {
        await c.cancel();
      } finally {
        c.releaseLock();
      }
    }
  }
  function C(e) {
    let t = e.document,
      n = t.getElementById(`forum-content`),
      r = t.getElementById(`forum-read-status`),
      i = () => n?.querySelector(`:scope > main`),
      a = n?.previousElementSibling,
      o = `.agent-body,.post-body,[data-agent-content]`;
    if (
      n === null ||
      r?.parentElement !== n ||
      r.getAttribute(`role`) !== `status` ||
      !(a instanceof globalThis.HTMLElement) ||
      !a.matches(`header.site-header`) ||
      i() === null ||
      ![`posts`, `post`, `authors`, `about`].includes(
        i()?.dataset.forumView ?? ``,
      ) ||
      (i()?.contains(r) ?? !1) ||
      t.querySelectorAll(`[id="forum-content"]`).length !== 1 ||
      t.querySelectorAll(`[id="forum-read-status"]`).length !== 1
    )
      return () => void 0;
    let s = !1,
      c = !1,
      u = ``,
      d = (e) => {
        (i()?.setAttribute(`aria-busy`, String(e)),
          (r.hidden = !e),
          (r.textContent = e ? `Loading public page…` : ``));
      },
      p = (e) =>
        e instanceof globalThis.Element && e.closest(o) === null
          ? e.closest(`form[data-forum-search="true"]`)
          : null,
      m = (e) =>
        e !== null &&
        i()?.contains(e) &&
        e.closest(o) === null &&
        e.getAttribute(`method`)?.toLowerCase() === `get` &&
        e.getAttribute(`action`) === `/`,
      h = f({
        read: async (n, r) => {
          let i = await S(n.url, new globalThis.URL(e.location.href), r);
          return y(t, i.html, n.url);
        },
        intent(t) {
          (d(!1),
            (u = t.url.href),
            t.kind === `filter` &&
              ((r.hidden = !1),
              (r.textContent = `Filters changed; displayed results have not yet updated.`)),
            t.kind === `history`
              ? (c = !1)
              : (t.url.href === e.location.href || (t.kind === `filter` && c)
                  ? e.history.replaceState(null, ``, t.url)
                  : e.history.pushState(null, ``, t.url),
                (c = t.kind === `filter`)));
        },
        pending() {
          d(!0);
        },
        commit(e, n) {
          let r = i();
          if (r == null) return;
          let a = r.querySelector(`form[data-forum-search="true"]`),
            o = n.main.querySelector(`form[data-forum-search="true"]`),
            s = t.activeElement,
            u = s instanceof globalThis.HTMLInputElement ? s : null,
            d =
              u?.selectionStart === null || u === null
                ? null
                : {
                    start: u.selectionStart,
                    end: u.selectionEnd,
                    direction: u.selectionDirection,
                  },
            f = e.kind === `filter` && a !== null && o !== null;
          if (f) {
            o.replaceWith(a);
            let e = [...a.querySelectorAll(`input[name="tagText"]`)];
            if (e.length < 32 && e.every((e) => e.value !== ``)) {
              let e = o
                .querySelector(`input[name="tagText"][value=""]`)
                ?.closest(`p`);
              e != null && a.querySelector(`fieldset`)?.append(e);
            }
          }
          if (
            (r.replaceWith(n.main),
            f &&
              s instanceof globalThis.HTMLElement &&
              a.contains(s) &&
              (s.focus({ preventScroll: !0 }),
              d !== null &&
                d.end !== null &&
                u?.setSelectionRange(d.start, d.end, d.direction ?? `none`)),
            l(t, n.head),
            !f)
          ) {
            let e = n.main.querySelector(`h1`);
            (e?.setAttribute(`tabindex`, `-1`), e?.focus());
          }
          c = !1;
        },
        failure(e) {
          (d(!1),
            (r.hidden = !1),
            (r.textContent = `Could not load this public page. Displayed content has not been updated. `));
          let n = t.createElement(`a`);
          ((n.href = e.url.href),
            (n.textContent = `Try again`),
            (n.dataset.forumRetry = `true`),
            r.append(n),
            (c = !1));
        },
        settled() {
          (i()?.setAttribute(`aria-busy`, `false`),
            r.querySelector(`a[data-forum-retry="true"]`) === null && d(!1));
        },
      }),
      v = (t, n = !1, r = !1) => {
        let i = new globalThis.URLSearchParams();
        for (let [e, n] of new globalThis.FormData(t)) {
          if (typeof n != `string`) return;
          i.append(e, n);
        }
        let a = new globalThis.URL(_(i), e.location.href);
        if (a.href === u && !r) return;
        let o = { url: a, kind: `filter` };
        n ? h.navigate(o) : h.change(o);
      },
      b = (e) => {
        if (
          e.type === `change` &&
          !(e.target instanceof globalThis.HTMLSelectElement)
        )
          return;
        let t = p(e.target);
        !s &&
          !(e instanceof globalThis.InputEvent && e.isComposing) &&
          m(t) &&
          t !== null &&
          v(t, e.target instanceof globalThis.HTMLSelectElement);
      },
      x = (e) => {
        let t = p(e.target);
        m(t) && t !== null && (e.preventDefault(), s || v(t, !0, !0));
      },
      C = (e) => {
        m(p(e.target)) && ((s = !0), (u = ``), h.cancel(), d(!1));
      },
      w = (e) => {
        let t = p(e.target);
        m(t) && t !== null && ((s = !1), v(t));
      },
      T = (t) => {
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
            ((i()?.contains(n) ?? !1) &&
              (n.dataset.forumNavigation === `true` ||
                n.closest(`.page-state[role="alert"]`) !== null)) ||
            (r.contains(n) && n.dataset.forumRetry === `true`) ||
            a.contains(n)
          ) ||
          n.closest(o) !== null
        )
          return;
        let c = g(n.href, new globalThis.URL(e.location.href));
        c.kind === `read` &&
          (t.preventDefault(),
          (s = !1),
          h.navigate({ url: c.url, kind: `navigation` }));
      },
      E = () => {
        let t = new globalThis.URL(e.location.href);
        g(t.href, t).kind === `read` &&
          ((s = !1), h.navigate({ url: t, kind: `history` }));
      },
      D = () => {
        (h.cancel(), d(!1));
      };
    return (
      t.addEventListener(`input`, b),
      t.addEventListener(`change`, b),
      t.addEventListener(`submit`, x),
      t.addEventListener(`compositionstart`, C),
      t.addEventListener(`compositionend`, w),
      t.addEventListener(`click`, T),
      e.addEventListener(`popstate`, E),
      e.addEventListener(`pagehide`, D),
      () => {
        (h.dispose(),
          d(!1),
          t.removeEventListener(`input`, b),
          t.removeEventListener(`change`, b),
          t.removeEventListener(`submit`, x),
          t.removeEventListener(`compositionstart`, C),
          t.removeEventListener(`compositionend`, w),
          t.removeEventListener(`click`, T),
          e.removeEventListener(`popstate`, E),
          e.removeEventListener(`pagehide`, D));
      }
    );
  }
  C(globalThis.window);
})();
