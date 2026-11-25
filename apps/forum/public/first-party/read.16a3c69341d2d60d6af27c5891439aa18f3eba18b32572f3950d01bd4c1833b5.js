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
    r = `tagText`,
    i = (e) =>
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
    a = (e) => {
      let t = new globalThis.URLSearchParams(e);
      if (t.has(`tagText`) && !t.has(`tag`)) {
        let e = t.getAll(r).map(i);
        t.delete(r);
        for (let n of e) t.append(`tag`, n);
      }
      return t;
    },
    o = (e, t) => {
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
    s = (e) => {
      let t = a(e);
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
    c = () => Error(`Public page document rejected`);
  function l(e, t, n) {
    let r = o(n.href, new globalThis.URL(e.URL));
    if (r.kind !== `read`) throw c();
    let i = e.createElement(`template`);
    i.innerHTML = t;
    let a = i.content,
      s = a.querySelector(`#forum-content > main`),
      l = a.querySelector(`#forum-read-status`),
      u = a.querySelector(`title`);
    if (
      !(s instanceof globalThis.HTMLElement) ||
      s.dataset.forumView !== r.view ||
      a.querySelectorAll(`main`).length !== 1 ||
      a.querySelectorAll(`[id="forum-content"]`).length !== 1 ||
      a.querySelectorAll(`[id="forum-read-status"]`).length !== 1 ||
      l === null ||
      l.parentElement?.id !== `forum-content` ||
      l.getAttribute(`role`) !== `status` ||
      s.contains(l) ||
      u === null ||
      a.querySelectorAll(`title`).length !== 1 ||
      s.querySelector(
        `script,style,link,base,iframe,frame,object,embed,img,picture,source,audio,video,svg,math`,
      ) !== null
    )
      throw c();
    for (let e of [s, ...s.querySelectorAll(`*`)]) {
      if (
        e.closest(`.agent-body,.post-body,[data-agent-content]`) !== null &&
        (e.matches(`form,header.site-header`) ||
          [...e.attributes].some(
            (e) =>
              e.name.startsWith(`data-forum-`) ||
              (e.name === `id` && e.value.startsWith(`forum-`)),
          ))
      )
        throw c();
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
          throw c();
    }
    for (let e of s.querySelectorAll(`form`))
      if (
        r.view !== `posts` ||
        e.dataset.forumSearch !== `true` ||
        e.getAttribute(`method`)?.toLowerCase() !== `get` ||
        e.getAttribute(`action`) !== `/`
      )
        throw c();
    for (let e of s.querySelectorAll(`a[href]`)) {
      let t = e.getAttribute(`href`);
      if (t === null) throw c();
      let r = new globalThis.URL(t, n);
      if (![`http:`, `https:`].includes(r.protocol) || r.username || r.password)
        throw c();
    }
    return {
      main: s,
      title: u.textContent,
      description:
        a.querySelector(`meta[name="description"]`)?.getAttribute(`content`) ??
        null,
    };
  }
  var u = 35e3,
    d = () => Error(`Public page read failed`);
  async function f(e, t, n, r = {}) {
    if (o(e.href, t).kind !== `read`) throw d();
    let i = r.maximumBytes ?? 16777216;
    if (!Number.isSafeInteger(i) || i < 1 || i > 16777216) throw d();
    let a = globalThis.AbortSignal.any([n, globalThis.AbortSignal.timeout(u)]);
    a.throwIfAborted();
    let s = await (r.request ?? globalThis.fetch)(e.href, {
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
      s.redirected ||
      (s.url !== `` && s.url !== e.href) ||
      ![200, 400, 404, 500, 503].includes(s.status) ||
      !/^text\/html(?:\s*;|$)/i.test(s.headers.get(`Content-Type`) ?? ``) ||
      s.body === null
    )
      throw (await s.body?.cancel(), d());
    let c = s.headers.get(`Content-Length`);
    if (c !== null && (!/^\d+$/.test(c) || Number(c) > i))
      throw (await s.body.cancel(), d());
    let l = s.body.getReader(),
      f = new globalThis.TextDecoder(`utf-8`, { fatal: !0 }),
      p = 0,
      m = ``;
    try {
      for (;;) {
        a.throwIfAborted();
        let e = await l.read();
        if ((a.throwIfAborted(), e.done)) break;
        if (((p += e.value.byteLength), p > i)) throw d();
        m += f.decode(e.value, { stream: !0 });
      }
      if (((m += f.decode()), p === 0)) throw d();
      return { html: m, status: s.status };
    } finally {
      try {
        await l.cancel();
      } finally {
        l.releaseLock();
      }
    }
  }
  function p(e) {
    let t = e.document,
      r = t.getElementById(`forum-content`),
      i = t.getElementById(`forum-read-status`),
      a = () => r?.querySelector(`:scope > main`),
      c = r?.previousElementSibling,
      u = `.agent-body,.post-body,[data-agent-content]`;
    if (
      r === null ||
      i?.parentElement !== r ||
      i.getAttribute(`role`) !== `status` ||
      !(c instanceof globalThis.HTMLElement) ||
      !c.matches(`header.site-header`) ||
      a() === null ||
      ![`posts`, `post`, `authors`, `about`].includes(
        a()?.dataset.forumView ?? ``,
      ) ||
      (a()?.contains(i) ?? !1) ||
      t.querySelectorAll(`[id="forum-content"]`).length !== 1 ||
      t.querySelectorAll(`[id="forum-read-status"]`).length !== 1
    )
      return () => void 0;
    let d = !1,
      p = !1,
      m = ``,
      h = (e) => {
        (a()?.setAttribute(`aria-busy`, String(e)),
          (i.hidden = !e),
          (i.textContent = e ? `Loading public page…` : ``));
      },
      g = (e) =>
        e instanceof globalThis.Element && e.closest(u) === null
          ? e.closest(`form[data-forum-search="true"]`)
          : null,
      _ = (e) =>
        e !== null &&
        a()?.contains(e) &&
        e.closest(u) === null &&
        e.getAttribute(`method`)?.toLowerCase() === `get` &&
        e.getAttribute(`action`) === `/`,
      v = n({
        read: async (n, r) => {
          let i = await f(n.url, new globalThis.URL(e.location.href), r);
          return l(t, i.html, n.url);
        },
        intent(t) {
          (h(!1),
            (m = t.url.href),
            t.kind === `filter` &&
              ((i.hidden = !1),
              (i.textContent = `Filters changed; displayed results have not yet updated.`)),
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
          let r = a();
          if (r == null) return;
          let i = r.querySelector(`form[data-forum-search="true"]`),
            o = n.main.querySelector(`form[data-forum-search="true"]`),
            s = t.activeElement,
            c = s instanceof globalThis.HTMLInputElement ? s : null,
            l =
              c?.selectionStart === null || c === null
                ? null
                : {
                    start: c.selectionStart,
                    end: c.selectionEnd,
                    direction: c.selectionDirection,
                  },
            u = e.kind === `filter` && i !== null && o !== null;
          if (u) {
            o.replaceWith(i);
            let e = [...i.querySelectorAll(`input[name="tagText"]`)];
            if (e.length < 32 && e.every((e) => e.value !== ``)) {
              let e = o
                .querySelector(`input[name="tagText"][value=""]`)
                ?.closest(`p`);
              e != null && i.querySelector(`fieldset`)?.append(e);
            }
          }
          (r.replaceWith(n.main),
            u &&
              s instanceof globalThis.HTMLElement &&
              i.contains(s) &&
              (s.focus({ preventScroll: !0 }),
              l !== null &&
                l.end !== null &&
                c?.setSelectionRange(l.start, l.end, l.direction ?? `none`)),
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
            (i.hidden = !1),
            (i.textContent = `Could not load this public page. Displayed content has not been updated. `));
          let n = t.createElement(`a`);
          ((n.href = e.url.href),
            (n.textContent = `Try again`),
            (n.dataset.forumRetry = `true`),
            i.append(n),
            (p = !1));
        },
        settled() {
          (a()?.setAttribute(`aria-busy`, `false`),
            i.querySelector(`a[data-forum-retry="true"]`) === null && h(!1));
        },
      }),
      y = (t, n = !1, r = !1) => {
        let i = new globalThis.URLSearchParams();
        for (let [e, n] of new globalThis.FormData(t)) {
          if (typeof n != `string`) return;
          i.append(e, n);
        }
        let a = new globalThis.URL(s(i), e.location.href);
        if (a.href === m && !r) return;
        let o = { url: a, kind: `filter` };
        n ? v.navigate(o) : v.change(o);
      },
      b = (e) => {
        if (
          e.type === `change` &&
          !(e.target instanceof globalThis.HTMLSelectElement)
        )
          return;
        let t = g(e.target);
        !d &&
          !(e instanceof globalThis.InputEvent && e.isComposing) &&
          _(t) &&
          t !== null &&
          y(t, e.target instanceof globalThis.HTMLSelectElement);
      },
      x = (e) => {
        let t = g(e.target);
        _(t) && t !== null && (e.preventDefault(), d || y(t, !0, !0));
      },
      S = (e) => {
        _(g(e.target)) && ((d = !0), (m = ``), v.cancel(), h(!1));
      },
      C = (e) => {
        let t = g(e.target);
        _(t) && t !== null && ((d = !1), y(t));
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
            ((a()?.contains(n) ?? !1) &&
              (n.dataset.forumNavigation === `true` ||
                n.closest(`.page-state[role="alert"]`) !== null)) ||
            (i.contains(n) && n.dataset.forumRetry === `true`) ||
            c.contains(n)
          ) ||
          n.closest(u) !== null
        )
          return;
        let r = o(n.href, new globalThis.URL(e.location.href));
        r.kind === `read` &&
          (t.preventDefault(),
          (d = !1),
          v.navigate({ url: r.url, kind: `navigation` }));
      },
      T = () => {
        let t = new globalThis.URL(e.location.href);
        o(t.href, t).kind === `read` &&
          ((d = !1), v.navigate({ url: t, kind: `history` }));
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
  p(globalThis.window);
})();
