/* Platehylla — personlig CD/LP-samling. All data lagres lokalt i IndexedDB. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const MB = "https://musicbrainz.org/ws/2";
  const CAA = "https://coverartarchive.org";

  const state = {
    records: [], sort: "artist", fmt: "all", q: "",
    editing: null, coverBlob: null, coverUrl: null, coverChanged: false,
  };
  try {
    const v = JSON.parse(localStorage.getItem("platehylla.view") || "{}");
    if (v.sort) state.sort = v.sort;
    if (v.fmt) state.fmt = v.fmt;
  } catch (e) {}

  /* ---------------- IndexedDB ---------------- */
  let dbp = null;
  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("platehylla", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("records", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const t = db.transaction("records", mode);
      const store = t.objectStore("records");
      let out;
      Promise.resolve(fn(store)).then((v) => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("Lagring avbrutt"));
    });
  }
  const getAll = () => tx("readonly", (s) => new Promise((res) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); }));
  const putRec = (rec) => tx("readwrite", (s) => { s.put(rec); });
  const delRec = (id) => tx("readwrite", (s) => { s.delete(id); });

  async function load() {
    try { state.records = await getAll(); }
    catch (e) { state.records = []; toast("Kunne ikke åpne samlingen på denne enheten."); }
    render();
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ---------------- Cover object URLs ---------------- */
  const urlCache = new Map();
  function coverSrc(r) {
    if (r.cover instanceof Blob) {
      let u = urlCache.get(r.id);
      if (!u || u.blob !== r.cover) {
        if (u) URL.revokeObjectURL(u.url);
        u = { blob: r.cover, url: URL.createObjectURL(r.cover) };
        urlCache.set(r.id, u);
      }
      return u.url;
    }
    return r.coverUrl || "";
  }

  /* ---------------- Sorting ---------------- */
  const sortKey = (s) => (s || "").trim().replace(/^(the|de|die|les|la)\s+/i, "").toLocaleLowerCase("nb");
  const coll = new Intl.Collator("nb", { sensitivity: "base", numeric: true });
  const yr = (r) => Number(r.year) || 9999;
  function visible() {
    const q = state.q.trim().toLocaleLowerCase("nb");
    return state.records.filter((r) =>
      (state.fmt === "all" || r.format === state.fmt) &&
      (!q || (r.artist || "").toLocaleLowerCase("nb").includes(q) || (r.album || "").toLocaleLowerCase("nb").includes(q)));
  }
  function groups(list) {
    if (state.sort === "new") return [{ label: null, items: list.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)) }];
    if (state.sort === "year") {
      list = list.slice().sort((a, b) => yr(a) - yr(b) || coll.compare(sortKey(a.artist), sortKey(b.artist)));
      const m = new Map();
      for (const r of list) {
        const y = Number(r.year);
        const k = y ? Math.floor(y / 10) * 10 + "-tallet" : "Ukjent år";
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return [...m].map(([label, items]) => ({ label, items }));
    }
    list = list.slice().sort((a, b) => coll.compare(sortKey(a.artist), sortKey(b.artist)) || yr(a) - yr(b) || coll.compare(a.album || "", b.album || ""));
    const m = new Map();
    for (const r of list) {
      let c = sortKey(r.artist).charAt(0).toLocaleUpperCase("nb");
      if (!/\p{L}/u.test(c)) c = "#";
      if (!m.has(c)) m.set(c, []);
      m.get(c).push(r);
    }
    return [...m].map(([label, items]) => ({ label, items, byArtist: true }));
  }
  const initials = (s) => (s || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  /* ---------------- Render ---------------- */
  function render() {
    const all = state.records;
    const lp = all.filter((r) => r.format === "LP").length;
    const cd = all.filter((r) => r.format === "CD").length;
    const artists = new Set(all.map((r) => sortKey(r.artist))).size;
    const st = $("stats"); st.textContent = "";
    [[all.length, "plater"], [lp, "LP"], [cd, "CD"], [artists, "artister"]].forEach(([n, t]) => {
      const s = el("span"); const b = el("b", null, String(n)); s.append(b, " " + t); st.append(s);
    });
    document.querySelectorAll("#sortSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === state.sort)));
    document.querySelectorAll("#fmtSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fmt === state.fmt)));

    const list = $("list"); list.textContent = "";
    if (!all.length) {
      const e = el("div", "empty");
      e.append(el("h2", null, "Hylla er tom"),
        el("p", null, "Trykk «Legg til plate» og skann strekkoden på baksiden. Artist, album, år og cover hentes automatisk."));
      const b = el("button", "btn primary", "+ Legg til første plate"); b.type = "button"; b.onclick = () => openForm(null);
      e.append(b); list.append(e); return;
    }
    const v = visible();
    if (!v.length) {
      const e = el("div", "empty"); e.append(el("h2", null, "Ingen treff"), el("p", null, "Prøv et annet søk eller format.")); list.append(e); return;
    }
    for (const g of groups(v)) {
      const bin = el("section", "bin");
      if (g.label) { const t = el("div", "tab", g.label); t.append(el("small", null, String(g.items.length))); bin.append(t); }
      if (g.byArtist) {
        const by = new Map();
        for (const r of g.items) { const k = sortKey(r.artist); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
        for (const items of by.values()) { bin.append(el("div", "artist-row", items[0].artist || "Ukjent artist"), grid(items)); }
      } else bin.append(grid(g.items));
      list.append(bin);
    }
  }
  function grid(items) {
    const g = el("div", "grid");
    for (const r of items) {
      const b = el("button", "card"); b.type = "button";
      const c = el("div", "cover");
      const src = coverSrc(r);
      if (src) { const i = el("img"); i.loading = "lazy"; i.alt = ""; i.src = src; c.append(i); }
      else { const p = el("div", "ph"); p.append(el("span", null, initials(r.artist))); c.append(p); }
      c.append(el("span", "pill", r.format || "LP"));
      const m = el("div", "meta");
      m.append(el("div", "al", r.album || "Uten tittel"), el("div", "ar", r.artist || ""), el("div", "yr", r.year ? String(r.year) : "—"));
      b.append(c, m);
      b.setAttribute("aria-label", `${r.artist} – ${r.album}, ${r.year || "ukjent år"}, ${r.format}`);
      b.onclick = () => openForm(r);
      g.append(b);
    }
    return g;
  }

  /* ---------------- MusicBrainz ---------------- */
  let lastCall = 0;
  async function mb(path) {
    const wait = lastCall + 1100 - Date.now(); // MusicBrainz tillater ca. 1 forespørsel i sekundet
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(MB + path + (path.includes("?") ? "&" : "?") + "fmt=json", { headers: { Accept: "application/json" } });
    if (res.status === 503) throw new Error("busy");
    if (!res.ok) throw new Error("http " + res.status);
    return res.json();
  }
  const credit = (ac) => (ac || []).map((a) => (a.name || (a.artist && a.artist.name) || "") + (a.joinphrase || "")).join("").trim();
  const yearOf = (d) => { const y = parseInt(String(d || "").slice(0, 4), 10); return y > 1800 ? y : null; };
  function fmtOf(media) {
    const f = ((media || [])[0] || {}).format || "";
    if (/vinyl/i.test(f)) return "LP";
    if (/cd/i.test(f)) return "CD";
    return null;
  }
  const luceneEsc = (s) => s.replace(/([+\-!(){}\[\]^"~*?:\\\/]|&&|\|\|)/g, "\\$1");

  /* iTunes-søk brukes som reserve når MusicBrainz ikke har plata */
  // iTunes og Deezer svarer ikke på vanlige fetch-kall fra nettlesere (CORS), så vi bruker JSONP.
  let jsonpN = 0;
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cb = "__ph_cb" + (++jsonpN);
      const sc = document.createElement("script");
      const done = (fn, v) => { clearTimeout(t); try { delete window[cb]; } catch (e) { window[cb] = undefined; } sc.remove(); fn(v); };
      const t = setTimeout(() => done(reject, new Error("tidsavbrudd")), 10000);
      window[cb] = (data) => done(resolve, data);
      sc.onerror = () => done(reject, new Error("blokkert"));
      sc.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
      document.head.appendChild(sc);
    });
  }
  const itunes = (path) => jsonp("https://itunes.apple.com/" + path + "&country=no");
  const deezer = (path) => jsonp("https://api.deezer.com/" + path + (path.includes("?") ? "&" : "?") + "output=jsonp");
  function fromDeezer(a) {
    return {
      artist: (a.artist && a.artist.name) || "", album: a.title || "", year: null, format: null,
      rgid: null, relid: null, dzid: a.id, type: a.record_type === "compile" ? "Samling" : "",
      thumb: a.cover_medium || null, art: a.cover_xl || a.cover_big || null,
    };
  }
  let searchLog = [];
  function fromItunes(r) {
    const art = r.artworkUrl100 || "";
    return {
      artist: r.artistName || "", album: (r.collectionName || "").replace(/ - (Single|EP)$/i, ""),
      year: yearOf(r.releaseDate), format: null, rgid: null, relid: null,
      type: r.collectionType === "Compilation" ? "Samling" : "",
      thumb: art || null, art: art ? art.replace(/\d+x\d+bb/, "600x600bb") : null,
    };
  }
  const keyOf = (o) => (o.artist + "|" + o.album).toLocaleLowerCase("nb").replace(/[^\p{L}\p{N}|]/gu, "");
  function merge(...lists) {
    const seen = new Set(), out = [];
    for (const l of lists) for (const o of l || []) { const k = keyOf(o); if (!seen.has(k)) { seen.add(k); out.push(o); } }
    return out;
  }

  async function lookupBarcode(code) {
    let out = [];
    try {
      const data = await mb(`/release/?query=barcode:${encodeURIComponent(code)}&limit=10`);
      const rels = (data.releases || []).filter((r) => r.barcode === code);
      const seen = new Map();
      for (const r of rels) {
        const rg = r["release-group"] || {};
        const key = rg.id || r.id;
        if (seen.has(key)) continue;
        seen.set(key, {
          artist: credit(r["artist-credit"]), album: rg.title || r.title,
          year: null, releaseYear: yearOf(r.date), format: fmtOf(r.media),
          rgid: rg.id || null, relid: r.id,
        });
      }
      out = [...seen.values()];
      // Hent original utgivelsesår for albumet (første utgivelse)
      for (const o of out.slice(0, 3)) {
        if (!o.rgid) { o.year = o.releaseYear; continue; }
        try { const rg = await mb(`/release-group/${o.rgid}`); o.year = yearOf(rg["first-release-date"]) || o.releaseYear; }
        catch (e) { o.year = o.releaseYear; }
      }
    } catch (e) { if (e.message === "busy") throw e; }
    if (!out.length) {
      try {
        const d = await itunes(`lookup?upc=${encodeURIComponent(code)}&entity=album`);
        out = (d.results || []).filter((r) => r.wrapperType === "collection").map(fromItunes);
      } catch (e) {}
    }
    if (!out.length) {
      try {
        const d = await deezer(`album/upc:${encodeURIComponent(code)}`);
        if (d && d.id && !d.error) { const o = fromDeezer(d); o.year = yearOf(d.release_date); out = [o]; }
      } catch (e) {}
    }
    return out;
  }
  async function searchAlbum(artist, album) {
    const mapRg = (min) => (data) => (data["release-groups"] || [])
      .filter((g) => (g.score || 0) >= min)
      .map((g) => ({
        artist: credit(g["artist-credit"]), album: g.title, year: yearOf(g["first-release-date"]),
        format: null, rgid: g.id, relid: null,
        type: ((g["secondary-types"] || []).includes("Compilation") ? "Samling" : g["primary-type"] || ""),
      }));
    let strict = [], loose = [], apple = [], dz = [];
    searchLog = [];
    // 1) Nøyaktig søk
    const parts = [];
    if (album) parts.push(`releasegroup:"${luceneEsc(album)}"`);
    if (artist) parts.push(`artist:"${luceneEsc(artist)}"`);
    try { strict = mapRg(60)(await mb(`/release-group/?query=${encodeURIComponent(parts.join(" AND "))}&limit=12`)); }
    catch (e) { if (e.message === "busy") throw e; searchLog.push("MusicBrainz: feil"); }
    // 2) Løsere søk: ordene hver for seg, tåler skrivefeil
    if (strict.length < 3) {
      const words = (s) => s.split(/\s+/).filter(Boolean).map((w) => luceneEsc(w) + (w.length > 4 ? "~" : "")).join(" ");
      const lp = [];
      if (album) lp.push(`releasegroup:(${words(album)})`);
      if (artist) lp.push(`artist:(${words(artist)})`);
      try { loose = mapRg(50)(await mb(`/release-group/?query=${encodeURIComponent(lp.join(" AND "))}&limit=12`)); } catch (e) {}
    }
    searchLog.push(`MusicBrainz: ${strict.length + loose.length}`);
    // 3) Reserve: iTunes
    if (strict.length + loose.length < 3) {
      try {
        const d = await itunes(`search?term=${encodeURIComponent([artist, album].filter(Boolean).join(" "))}&entity=album&limit=10`);
        apple = (d.results || []).map(fromItunes);
        searchLog.push(`iTunes: ${apple.length}`);
      } catch (e) { searchLog.push(`iTunes: ${e.message}`); }
      try {
        const q = [artist ? `artist:"${artist}"` : "", album ? `album:"${album}"` : ""].filter(Boolean).join(" ");
        let d = await deezer(`search/album?q=${encodeURIComponent(q)}&limit=10`);
        if (!(d.data || []).length) d = await deezer(`search/album?q=${encodeURIComponent([artist, album].filter(Boolean).join(" "))}&limit=10`);
        dz = (d.data || []).map(fromDeezer);
        searchLog.push(`Deezer: ${dz.length}`);
      } catch (e) { searchLog.push(`Deezer: ${e.message}`); }
    }
    return merge(strict, loose, apple, dz).slice(0, 15);
  }
  function caaThumb(o) {
    if (o.thumb) return o.thumb;
    return o.relid ? `${CAA}/release/${o.relid}/front-250` : o.rgid ? `${CAA}/release-group/${o.rgid}/front-250` : "";
  }
  async function fetchCover(o) {
    const urls = [];
    if (o.art) urls.push(o.art);
    if (o.relid) urls.push(`${CAA}/release/${o.relid}/front-500`);
    if (o.rgid) urls.push(`${CAA}/release-group/${o.rgid}/front-500`);
    for (const u of urls) {
      try {
        const res = await fetch(u);
        if (res.ok) { const b = await res.blob(); if (b.size > 0 && /^image\//.test(b.type)) return { blob: b, url: null }; }
      } catch (e) {
        // Nedlasting blokkert: bruk lenken direkte som bildekilde
        return { blob: null, url: u };
      }
    }
    return null;
  }

  /* ---------------- Finder UI ---------------- */
  function setFind(msg, err) { const s = $("findStatus"); s.textContent = msg || ""; s.className = "status" + (err ? " err" : ""); }
  function netErr(e) {
    if (!navigator.onLine) return "Du er ikke på nett. Fyll inn feltene selv, eller prøv igjen senere.";
    if (e && e.message === "busy") return "Musikkdatabasen er travel akkurat nå. Prøv igjen om litt.";
    return "Fikk ikke kontakt med musikkdatabasen. Prøv igjen, eller fyll inn selv.";
  }
  function showResults(list) {
    const ul = $("results"); ul.textContent = "";
    for (const o of list) {
      const li = el("li"); const b = el("button"); b.type = "button";
      const th = el("div", "th"); const src = caaThumb(o);
      if (src) { const i = el("img"); i.alt = ""; i.loading = "lazy"; i.src = src; i.onerror = () => i.remove(); th.append(i); }
      const txt = el("div");
      txt.append(el("div", "t", o.album), el("div", "s", [o.artist, o.year, o.type && o.type !== "Album" ? o.type : "", o.format].filter(Boolean).join(" · ")));
      b.append(th, txt); b.onclick = () => choose(o);
      li.append(b); ul.append(li);
    }
  }
  async function choose(o) {
    $("fArtist").value = o.artist || "";
    $("fAlbum").value = o.album || "";
    if (o.year) $("fYear").value = o.year;
    if (o.format) $("fFmt").value = o.format;
    $("results").textContent = "";
    if (!o.year && o.dzid) {
      try { const d = await deezer(`album/${o.dzid}`); const y = yearOf(d.release_date); if (y) $("fYear").value = y; } catch (e) {}
    }
    if (!o.year && o.rgid) {
      try { const rg = await mb(`/release-group/${o.rgid}`); const y = yearOf(rg["first-release-date"]); if (y) $("fYear").value = y; } catch (e) {}
    }
    setFind("Henter cover …");
    const c = await fetchCover(o).catch(() => null);
    const dupes = findDupes($("fArtist").value, $("fAlbum").value, state.editing && state.editing.id);
    const dupNote = dupes.length ? " Obs: " + dupText(dupes) : "";
    if (c) { state.coverBlob = c.blob; state.coverUrl = c.url; state.coverChanged = true; showPhoto(c.blob ? URL.createObjectURL(c.blob) : c.url); setFind("Fylt ut. Sjekk og trykk Lagre." + dupNote, !!dupes.length); }
    else setFind("Fylt ut. Fant ikke cover, så ta gjerne et eget bilde." + dupNote, !!dupes.length);
  }
  async function doBarcode(code) {
    code = String(code || "").replace(/\D/g, "");
    if (code.length < 8) { setFind("Strekkoden må ha minst 8 siffer.", true); return; }
    setFind(`Slår opp ${code} …`); $("results").textContent = "";
    try {
      const list = await lookupBarcode(code);
      if (!list.length) {
        setFind("Fant ikke strekkoden i databasen. Skriv artist og album og trykk Søk.", true);
        $("manualCode").hidden = true; $("searchBox").hidden = false; $("sArtist").focus(); return;
      }
      if (list.length === 1) await choose(list[0]);
      else { setFind("Flere treff. Velg riktig album:"); showResults(list); }
    } catch (e) { setFind(netErr(e), true); }
  }
  async function doSearch() {
    const a = $("sArtist").value.trim(), al = $("sAlbum").value.trim();
    if (!a && !al) { setFind("Skriv artist, album eller begge.", true); return; }
    setFind("Søker …"); $("results").textContent = "";
    try {
      const list = await searchAlbum(a, al);
      if (!list.length) setFind(`Ingen treff. Prøv bare artistnavnet, eller fyll inn feltene under selv. (${searchLog.join(", ")})`, true);
      else { setFind(`${list.length} treff. Velg riktig album:`); showResults(list); }
    } catch (e) { setFind(netErr(e), true); }
  }

  /* ---------------- Barcode scanner ---------------- */
  let stream = null, scanTimer = null, detector = null;
  async function startScan() {
    $("searchBox").hidden = true; $("results").textContent = "";
    if (!("BarcodeDetector" in window)) {
      $("manualCode").hidden = false; $("codeInput").focus();
      setFind("Denne enheten kan ikke lese strekkoder med kameraet. Skriv inn tallene under strekkoden.");
      return;
    }
    try {
      detector = detector || new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
    } catch (e) {
      $("manualCode").hidden = false;
      setFind("Fikk ikke tilgang til kameraet. Gi appen tilgang i innstillingene, eller skriv inn tallene under strekkoden.", true);
      return;
    }
    const v = $("video"); v.srcObject = stream; await v.play().catch(() => {});
    $("scanner").hidden = false; $("manualCode").hidden = false;
    setFind("Hold strekkoden på baksiden av plata foran kameraet.");
    const tick = async () => {
      if (!stream) return;
      try {
        const codes = await detector.detect(v);
        if (codes && codes.length) {
          const code = codes[0].rawValue;
          if (navigator.vibrate) navigator.vibrate(60);
          stopScan(); $("codeInput").value = code; doBarcode(code); return;
        }
      } catch (e) {}
      scanTimer = setTimeout(tick, 250);
    };
    tick();
  }
  function stopScan() {
    clearTimeout(scanTimer);
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    $("video").srcObject = null; $("scanner").hidden = true;
  }

  /* ---------------- Photo ---------------- */
  function showPhoto(src) {
    const box = $("photoBox"); box.textContent = "";
    if (src) { const i = el("img"); i.alt = "Cover"; i.src = src; box.append(i); }
    else { const p = el("div", "ph"); p.append(el("span", null, "+")); box.append(p); }
  }
  function shrink(file, max, q) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => {
        const s = Math.min(img.width, img.height); const side = Math.min(max, s);
        const cv = document.createElement("canvas"); cv.width = cv.height = side;
        cv.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, side, side);
        URL.revokeObjectURL(url);
        cv.toBlob((b) => (b ? res(b) : rej(new Error("Bildet kunne ikke leses"))), "image/jpeg", q);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Bildet kunne ikke leses")); };
      img.src = url;
    });
  }
  $("photo").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try {
      const b = await shrink(f, 700, 0.82);
      state.coverBlob = b; state.coverUrl = null; state.coverChanged = true;
      showPhoto(URL.createObjectURL(b));
    } catch (err) { setFind(err.message, true); }
  });

  /* ---------------- Form ---------------- */
  let delArmed = false, dupArmed = false;
  const norm = (x) => sortKey(x).replace(/[^\p{L}\p{N}]/gu, "");
  function findDupes(artist, album, exceptId) {
    const a = norm(artist), b = norm(album);
    if (!a || !b) return [];
    return state.records.filter((r) => r.id !== exceptId && norm(r.artist) === a && norm(r.album) === b);
  }
  function dupText(d) {
    const fm = [...new Set(d.map((r) => r.format))];
    const n = d.length;
    return `Du har allerede ${n === 1 ? "denne" : n + " eksemplarer av denne"} i samlingen (${fm.join(" og ")}).`;
  }
  function resetDup() { if (dupArmed) { dupArmed = false; $("saveBtn").textContent = "Lagre"; const st = $("saveStatus"); st.textContent = ""; st.className = "status"; } }
  ["fArtist", "fAlbum"].forEach((id) => $(id).addEventListener("input", resetDup));
  function openForm(r) {
    state.editing = r; state.coverBlob = null; state.coverUrl = null; state.coverChanged = false;
    $("formTitle").textContent = r ? "Rediger plate" : "Ny plate";
    $("finder").hidden = !!r;
    $("fArtist").value = (r && r.artist) || ""; $("fAlbum").value = (r && r.album) || "";
    $("fYear").value = (r && r.year) || ""; $("fFmt").value = (r && r.format) || "LP";
    $("sArtist").value = ""; $("sAlbum").value = ""; $("codeInput").value = "";
    $("searchBox").hidden = true; $("manualCode").hidden = true; $("results").textContent = "";
    $("delBtn").hidden = !r; delArmed = false; $("delBtn").textContent = "Slett";
    dupArmed = false; $("saveBtn").textContent = "Lagre";
    setFind(""); const ss = $("saveStatus"); ss.textContent = ""; ss.className = "status";
    showPhoto(r ? coverSrc(r) : ""); $("photo").value = "";
    $("ov").hidden = false;
  }
  function closeForm() { stopScan(); $("ov").hidden = true; state.editing = null; render(); }

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const st = $("saveStatus");
    const artist = $("fArtist").value.trim(), album = $("fAlbum").value.trim();
    const yRaw = $("fYear").value.trim(); const year = yRaw ? Number(yRaw) : null;
    if (!artist || !album) { st.className = "status err"; st.textContent = "Fyll inn både artist og album."; return; }
    if (yRaw && (!Number.isInteger(year) || year < 1900 || year > 2100)) { st.className = "status err"; st.textContent = "Året må være fire siffer, f.eks. 1979."; return; }
    const isEdit = !!state.editing;
    const dupes = findDupes(artist, album, state.editing && state.editing.id);
    if (dupes.length && !dupArmed) {
      dupArmed = true;
      st.className = "status err";
      st.textContent = dupText(dupes) + " Trykk «Lagre likevel» hvis du vil legge den inn en gang til.";
      $("saveBtn").textContent = "Lagre likevel";
      return;
    }
    const base = state.editing || { id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), addedAt: Date.now(), cover: null, coverUrl: null };
    const rec = Object.assign({}, base, { artist, album, year, format: $("fFmt").value, updatedAt: Date.now() });
    if (state.coverChanged) { rec.cover = state.coverBlob || null; rec.coverUrl = state.coverUrl || null; }
    $("saveBtn").disabled = true;
    try {
      await putRec(rec);
      cloudSave(rec);
      const i = state.records.findIndex((x) => x.id === rec.id);
      if (i >= 0) state.records[i] = rec; else state.records.push(rec);
      render(); closeForm(); toast(isEdit ? "Endringer lagret" : "Lagt i hylla");
    } catch (err) {
      st.className = "status err";
      st.textContent = "Kunne ikke lagre. Telefonen kan være full. Frigjør plass og prøv igjen.";
    } finally { $("saveBtn").disabled = false; }
  });
  $("delBtn").onclick = async () => {
    if (!state.editing) return;
    if (!delArmed) { delArmed = true; $("delBtn").textContent = "Trykk igjen for å slette"; return; }
    const id = state.editing.id;
    try {
      await delRec(id);
      cloudDel(id);
      state.records = state.records.filter((x) => x.id !== id);
      const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u.url); urlCache.delete(id); }
      render(); closeForm(); toast("Plata er slettet");
    } catch (err) { const s = $("saveStatus"); s.className = "status err"; s.textContent = "Kunne ikke slette. Prøv igjen."; }
  };

  /* ---------------- Backup ---------------- */
  const blobToData = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(b); });
  async function dataToBlob(d) { try { return await (await fetch(d)).blob(); } catch (e) { return null; } }
  async function exportAll() {
    toggleMenu(false);
    if (!state.records.length) { toast("Samlingen er tom, ingenting å eksportere."); return; }
    toast("Lager backup …");
    const out = [];
    for (const r of state.records) {
      const o = Object.assign({}, r); delete o.cover;
      if (r.cover instanceof Blob) o.coverData = await blobToData(r.cover);
      out.push(o);
    }
    const blob = new Blob([JSON.stringify({ app: "platehylla", version: 1, exported: new Date().toISOString(), records: out })], { type: "application/json" });
    const name = `platehylla-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Platehylla backup" }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Backup lagret i Nedlastinger");
  }
  $("importFile").addEventListener("change", async (e) => {
    toggleMenu(false);
    const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || data.app !== "platehylla" || !Array.isArray(data.records)) throw new Error("fmt");
      let n = 0;
      for (const o of data.records) {
        if (!o || !o.id || !o.artist) continue;
        const rec = { id: String(o.id), artist: String(o.artist), album: String(o.album || ""), year: Number(o.year) || null,
          format: o.format === "CD" ? "CD" : "LP", addedAt: Number(o.addedAt) || Date.now(), coverUrl: o.coverUrl || null, cover: null };
        if (o.coverData) rec.cover = await dataToBlob(o.coverData);
        rec.updatedAt = Date.now();
        await putRec(rec); cloudSave(rec); n++;
      }
      await load(); toast(`${n} plater hentet inn`);
    } catch (err) { toast("Filen er ikke en Platehylla-backup."); }
  });

  /* ---------------- Controls ---------------- */
  function saveView() { try { localStorage.setItem("platehylla.view", JSON.stringify({ sort: state.sort, fmt: state.fmt })); } catch (e) {} }
  function toggleMenu(open) { const m = $("menu"); m.hidden = open == null ? !m.hidden : !open; $("menuBtn").setAttribute("aria-expanded", String(!m.hidden)); }
  $("sortSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.sort = b.dataset.sort; saveView(); render(); };
  $("fmtSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.fmt = b.dataset.fmt; saveView(); render(); };
  $("q").oninput = (e) => { state.q = e.target.value; render(); };
  $("addBtn").onclick = () => openForm(null);
  $("menuBtn").onclick = () => toggleMenu();
  $("exportBtn").onclick = exportAll;
  $("closeBtn").onclick = closeForm; $("cancelBtn").onclick = closeForm;
  $("ov").addEventListener("click", (e) => { if (e.target === $("ov")) closeForm(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("ov").hidden) closeForm(); });
  $("scanBtn").onclick = startScan;
  $("stopScan").onclick = stopScan;
  $("searchToggle").onclick = () => {
    stopScan(); $("manualCode").hidden = true; const sb = $("searchBox"); sb.hidden = !sb.hidden;
    if (!sb.hidden) { $("sArtist").value = $("fArtist").value; $("sAlbum").value = $("fAlbum").value; $("sArtist").focus(); }
  };
  $("searchBtn").onclick = doSearch;
  ["sArtist", "sAlbum"].forEach((id) => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSearch(); } }));
  $("codeBtn").onclick = () => doBarcode($("codeInput").value);
  $("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doBarcode($("codeInput").value); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopScan(); });
  let tt; function toast(t) { const e = $("toast"); e.textContent = t; e.hidden = false; clearTimeout(tt); tt = setTimeout(() => (e.hidden = true), 2600); }

  /* ---------------- Skylagring (cloud.js) ---------------- */
  function cloudSave(rec) { try { if (window.PH.cloud) window.PH.cloud.save(rec); } catch (e) {} }
  function cloudDel(id) { try { if (window.PH.cloud) window.PH.cloud.remove(id); } catch (e) {} }
  window.PH = {
    cloud: null,
    records: () => state.records.slice(),
    async applyRemote(rec) {
      await putRec(rec);
      const i = state.records.findIndex((x) => x.id === rec.id);
      if (i >= 0) state.records[i] = rec; else state.records.push(rec);
      scheduleRender();
    },
    async removeRemote(id) {
      await delRec(id);
      state.records = state.records.filter((x) => x.id !== id);
      const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u.url); urlCache.delete(id); }
      scheduleRender();
    },
    async clearLocal() {
      for (const r of state.records) await delRec(r.id);
      state.records = []; render();
    },
    toast: (t) => toast(t),
    closeMenu: () => toggleMenu(false),
  };
  let rq = 0;
  function scheduleRender() { cancelAnimationFrame(rq); rq = requestAnimationFrame(() => { if ($("ov").hidden) render(); else rq = 0; }); }

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  render(); window.PH.ready = load();
})();
