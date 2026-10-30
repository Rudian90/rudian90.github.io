/* Platehylla – skylagring med Google-innlogging (Firebase Auth + Cloud Firestore).
   Samlingen ligger alltid lokalt i appen. Når brukeren er logget inn, speiles den til
   users/{uid}/records i Firestore, og endringer fra andre enheter hentes automatisk. */
const SDK = "https://www.gstatic.com/firebasejs/13.1.0/";
const firebaseConfig = {
  apiKey: "AIzaSyCFRLeDxxINObu7GMeJ1Q5qvVLdjSNOtcc",
  authDomain: "platehylla-70b48.firebaseapp.com",
  projectId: "platehylla-70b48",
  storageBucket: "platehylla-70b48.firebasestorage.app",
  messagingSenderId: "225253742524",
  appId: "1:225253742524:web:9f92350816346834013db9",
};

const $ = (id) => document.getElementById(id);
const PH = () => window.PH;
const flagKey = (uid) => "platehylla.uploaded." + uid;
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

let A, F, auth, db, user = null, col = null, unsub = null, sdkState = "loading";
const pending = new Set();
let logoutArmed = false, deleteArmed = false, busy = false;

/* ---------------- UI ---------------- */
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function btn(text, cls, onclick) { const b = el("button", cls, text); b.type = "button"; b.onclick = onclick; return b; }

function renderCloud() {
  const box = $("cloudBox");
  if (!box) return;
  box.textContent = "";
  box.append(el("p", "cloud-title", "Skylagring"));
  if (sdkState === "error") {
    box.append(el("p", "menu-note", "Skylagring er ikke tilgjengelig akkurat nå. Sjekk nettet og åpne appen på nytt."));
  } else if (sdkState === "loading") {
    box.append(el("p", "menu-note", "Kobler til …"));
  } else if (!user) {
    box.append(el("p", "menu-note", "Samlingen ligger bare på denne telefonen. Logg inn for å sikre den i skyen og ha den på alle enhetene dine."));
    box.append(btn("Logg inn med Google", "btn primary", login));
  } else {
    box.append(el("p", "menu-note", `Lagret i skyen som ${user.email || user.displayName || "deg"}. Endringer synkroniseres automatisk.`));
    const row = el("div", "cloud-actions");
    row.append(btn(logoutArmed ? "Trykk igjen for å logge ut" : "Logg ut", "btn ghost small", logout));
    row.append(btn(deleteArmed ? "Trykk igjen: slett alt i skyen" : "Slett kontoen og skydata", "btn danger small", deleteAccount));
    box.append(row);
    if (logoutArmed) box.append(el("p", "menu-note", "Platene fjernes fra denne telefonen, men ligger trygt i skyen til du logger inn igjen."));
    if (deleteArmed) box.append(el("p", "menu-note", "Alle platene dine slettes fra skyen, og innloggingen fjernes. Platene på denne telefonen blir liggende."));
  }
  updateBanner();
}
function updateBanner() {
  const banner = $("cloudBanner"); if (!banner) return;
  const show = sdkState === "ready" && !user && ls.get("platehylla.bannerHidden") !== "1" && PH().records().length > 0;
  banner.hidden = !show;
}

/* ---------------- Bilder ---------------- */
async function thumbData(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(bmp.width, bmp.height), side = Math.min(360, s);
    const cv = document.createElement("canvas"); cv.width = cv.height = side;
    cv.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, side, side);
    return cv.toDataURL("image/jpeg", 0.72);
  } catch (e) { return null; }
}
async function dataToBlob(d) { try { return await (await fetch(d)).blob(); } catch (e) { return null; } }

/* ---------------- Synk ---------------- */
async function save(rec) {
  if (!user || !col) return;
  const data = {
    artist: String(rec.artist || ""), album: String(rec.album || ""),
    year: Number(rec.year) || null, format: rec.format === "CD" ? "CD" : "LP",
    addedAt: Number(rec.addedAt) || Date.now(), updatedAt: Number(rec.updatedAt) || Date.now(),
    coverUrl: rec.coverUrl || null, coverData: null,
  };
  if (rec.cover instanceof Blob) data.coverData = await thumbData(rec.cover);
  pending.add(rec.id);
  F.setDoc(F.doc(col, rec.id), data)
    .catch(() => PH().toast("Kunne ikke lagre i skyen. Prøver igjen senere."))
    .finally(() => pending.delete(rec.id));
}
function remove(id) {
  if (!user || !col) return;
  F.deleteDoc(F.doc(col, id)).catch(() => {});
}
async function toLocal(d) {
  const x = d.data();
  return {
    id: d.id, artist: x.artist || "", album: x.album || "", year: x.year || null,
    format: x.format === "CD" ? "CD" : "LP", addedAt: x.addedAt || Date.now(), updatedAt: x.updatedAt || 0,
    coverUrl: x.coverUrl || null, cover: x.coverData ? await dataToBlob(x.coverData) : null,
  };
}

async function startSync(u) {
  await PH().ready;
  col = F.collection(db, "users", u.uid, "records");
  // Første gang denne enheten logger inn: last opp plater som bare finnes her.
  if (ls.get(flagKey(u.uid)) !== "1") {
    try {
      const snap = await F.getDocs(col);
      const have = new Set(snap.docs.map((d) => d.id));
      const local = PH().records().filter((r) => !have.has(r.id));
      for (const r of local) await save(r);
      ls.set(flagKey(u.uid), "1");
      if (local.length) PH().toast(`${local.length} plater lagret i skyen`);
    } catch (e) {
      PH().toast("Fikk ikke kontakt med skyen. Prøver igjen neste gang du åpner appen.");
      return;
    }
  }
  let pruned = false;
  unsub = F.onSnapshot(col, async (snap) => {
    if (!pruned && !snap.metadata.fromCache) {
      pruned = true;
      const ids = new Set(snap.docs.map((d) => d.id));
      for (const r of PH().records()) if (!ids.has(r.id) && !pending.has(r.id)) await PH().removeRemote(r.id);
    }
    const byId = new Map(PH().records().map((r) => [r.id, r]));
    for (const ch of snap.docChanges()) {
      if (ch.doc.metadata.hasPendingWrites) continue;
      if (ch.type === "removed") { await PH().removeRemote(ch.doc.id); continue; }
      const mine = byId.get(ch.doc.id);
      if (mine && (mine.updatedAt || 0) >= (ch.doc.data().updatedAt || 0)) continue;
      await PH().applyRemote(await toLocal(ch.doc));
    }
  }, () => PH().toast("Mistet kontakten med skyen. Platene lagres på telefonen så lenge."));
}
function stopSync() { if (unsub) unsub(); unsub = null; col = null; }

/* ---------------- Innlogging ---------------- */
async function login() {
  if (busy) return; busy = true;
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await A.signInWithPopup(auth, provider);
    PH().closeMenu();
  } catch (e) {
    const code = (e && e.code) || "";
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/web-storage-unsupported"].includes(code)) {
      try { await A.signInWithRedirect(auth, provider); return; } catch (e2) { PH().toast(loginErr(e2)); }
    } else if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
      PH().toast(loginErr(e));
    }
  } finally { busy = false; }
}
function loginErr(e) {
  const code = (e && e.code) || "";
  if (code === "auth/network-request-failed") return "Ingen nettforbindelse. Prøv igjen når du er på nett.";
  if (code === "auth/unauthorized-domain") return "Innlogging er ikke slått på for denne adressen ennå.";
  return "Innloggingen mislyktes. Prøv igjen.";
}
async function logout() {
  if (!logoutArmed) { logoutArmed = true; deleteArmed = false; renderCloud(); return; }
  logoutArmed = false;
  const uid = user && user.uid;
  stopSync();
  await A.signOut(auth).catch(() => {});
  if (uid) ls.del(flagKey(uid));
  await PH().clearLocal();
  PH().closeMenu(); PH().toast("Logget ut");
}
async function deleteAccount() {
  if (!deleteArmed) { deleteArmed = true; logoutArmed = false; renderCloud(); return; }
  deleteArmed = false;
  if (!user || busy) return; busy = true;
  const u = user;
  try {
    PH().toast("Sletter data i skyen …");
    stopSync();
    const c = F.collection(db, "users", u.uid, "records");
    const snap = await F.getDocs(c);
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = F.writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
      await b.commit();
    }
    try { await A.deleteUser(u); }
    catch (e) {
      if (e && e.code === "auth/requires-recent-login") { await A.reauthenticateWithPopup(u, new A.GoogleAuthProvider()); await A.deleteUser(u); }
      else throw e;
    }
    ls.del(flagKey(u.uid));
    PH().closeMenu(); PH().toast("Kontoen og alle data i skyen er slettet");
  } catch (e) {
    PH().toast("Kunne ikke slette alt. Prøv igjen, eller send e-post til rudian90@hotmail.com.");
    if (user) startSync(user);
  } finally { busy = false; renderCloud(); }
}

/* ---------------- Oppstart ---------------- */
async function init() {
  const bannerBtn = $("cloudBannerLogin"), bannerX = $("cloudBannerClose");
  if (bannerBtn) bannerBtn.onclick = () => login();
  if (bannerX) bannerX.onclick = () => { ls.set("platehylla.bannerHidden", "1"); updateBanner(); };
  renderCloud();
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js"), import(SDK + "firebase-firestore.js"),
    ]);
    A = authMod; F = fsMod;
    const app = appMod.initializeApp(firebaseConfig);
    auth = A.getAuth(app);
    try {
      db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
    } catch (e) { db = F.getFirestore(app); }
    sdkState = "ready";
  } catch (e) {
    sdkState = "error"; renderCloud(); return;
  }
  A.getRedirectResult(auth).catch((e) => PH().toast(loginErr(e)));
  window.PH.cloud = { save, remove };
  A.onAuthStateChanged(auth, (u) => {
    const changed = (u && u.uid) !== (user && user.uid);
    user = u || null; logoutArmed = false; deleteArmed = false;
    renderCloud();
    if (changed) { stopSync(); if (user) startSync(user); }
  });
}
// Vis/skjul banneret når samlingen endrer seg
setInterval(updateBanner, 3000);
init();
