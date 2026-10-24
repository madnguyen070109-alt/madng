// ============================================================
// SyncStep — app.js
// Imported by script.js, so it runs on every page. Every section is
// guarded by the elements it needs, so it no-ops elsewhere.
//   1. Auth state + nav        5. Community feed + posting
//   2. Login / Signup / Google 6. Profile + progress dashboard
//   3. Bookmarks (library)     7. Home page (continue / trending)
//   4. Bookmarks page          8. Admin (write dances)
//                              9. Practice scoring + Record Session
// ============================================================

import { auth, db, storage, provider } from "/firebase-init.js";
import {
  onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updateProfile, signOut
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc,
  query, orderBy, limit, startAfter, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";

// UI-only admin check (real enforcement is in firestore.rules / storage.rules).
const ADMIN_EMAIL = "madisonnguyen430@gmail.com";

// ---- helpers ------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (v = "") => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (ts) => ts?.toDate ? ts.toDate().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "member";

// Shared stylesheet for everything added here (no HTML edits needed).
const css = document.createElement("link");
css.rel = "stylesheet";
css.href = "/app.css";
document.head.appendChild(css);

// ============================================================
// 1. AUTH STATE + NAV
// ============================================================
let currentUser = null;
let authResolved = false;
let authFlowBusy = false; // suppresses the auto-redirect while signup is still writing its profile
const subscribers = [];

export function onUser(cb) {
  subscribers.push(cb);
  if (authResolved) cb(currentUser);
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  authResolved = true;
  document.querySelectorAll("a.login-button, a.signup-button").forEach(a => a.classList.toggle("hidden", !!user));
  if (user && !authFlowBusy && (isLoginPage || isSignupPage)) location.replace("index.html");
  subscribers.forEach(cb => cb(user));
});

// ============================================================
// 2. LOGIN / SIGNUP / GOOGLE
// ============================================================
const authForm = $("login-form");
const isSignupPage = !!$("sign-up");
const isLoginPage = !!authForm && !isSignupPage;

function authErrorMessage(err) {
  const map = {
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/email-already-in-use": "An account with that email already exists.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Try again in a few minutes.",
    "auth/network-request-failed": "Network error. Check your connection."
  };
  return map[err?.code] || "Something went wrong. Please try again.";
}

function showAuthError(msg) {
  const box = document.querySelector(".login-box");
  if (!box) return;
  let p = box.querySelector(".form-error");
  if (!p) {
    p = document.createElement("p");
    p.className = "form-error";
    box.insertBefore(p, box.querySelector("h5"));
  }
  p.textContent = msg;
}
const clearAuthError = () => document.querySelector(".login-box .form-error")?.remove();

async function ensureUserDoc(user, extra = {}) {
  // merge:true so returning users never get their data overwritten
  await setDoc(doc(db, "users", user.uid), {
    displayName: user.displayName || "",
    email: user.email || "",
    photoURL: user.photoURL || "",
    ...extra
  }, { merge: true });
}

if (authForm) {
  const googleBtn = $("google-signup-button");
  if (googleBtn) {
    googleBtn.addEventListener("click", async () => {
      clearAuthError();
      authFlowBusy = true;
      try {
        const result = await signInWithPopup(auth, provider);
        await ensureUserDoc(result.user, { lastLoginAt: serverTimestamp() });
        location.href = "index.html";
      } catch (err) {
        authFlowBusy = false;
        if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
          showAuthError(authErrorMessage(err));
        }
      }
    });
  }

  if (isLoginPage) {
    authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearAuthError();
      authFlowBusy = true;
      try {
        const cred = await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
        await ensureUserDoc(cred.user, { lastLoginAt: serverTimestamp() });
        location.href = "index.html";
      } catch (err) {
        authFlowBusy = false;
        showAuthError(authErrorMessage(err));
      }
    });
  }

  if (isSignupPage) {
    let step = 1;
    const nextBtn = $("next");

    const goStep2 = () => {
      if (!$("fname").value.trim() || !$("lname").value.trim()) {
        showAuthError("Please enter your first and last name.");
        return;
      }
      clearAuthError();
      ["fname-group", "lname-group"].forEach(id => $(id).classList.add("hidden"));
      ["email-group", "password-group", "confirm-password-group"].forEach(id => $(id).classList.remove("hidden"));
      nextBtn.classList.add("hidden");
      $("sign-up").classList.remove("hidden");
      step = 2;
      $("email").focus();
    };
    nextBtn.addEventListener("click", goStep2);
    // Enter on step 1 would trip native validation on the hidden step-2 fields
    authForm.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && step === 1) { e.preventDefault(); goStep2(); }
    });

    authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearAuthError();
      const first = $("fname").value.trim();
      const last = $("lname").value.trim();
      const pw = $("password").value;
      if (pw !== $("confirm-password").value) return showAuthError("Passwords don't match.");
      if (pw.length < 6) return showAuthError("Password must be at least 6 characters.");

      authFlowBusy = true;
      try {
        const cred = await createUserWithEmailAndPassword(auth, $("email").value.trim(), pw);
        await updateProfile(cred.user, { displayName: `${first} ${last}` });
        await ensureUserDoc(cred.user, { firstName: first, lastName: last, displayName: `${first} ${last}`, createdAt: serverTimestamp() });
        location.href = "index.html";
      } catch (err) {
        authFlowBusy = false;
        showAuthError(authErrorMessage(err));
      }
    });
  }
}

// ============================================================
// 3. BOOKMARKS — toggle buttons (library + bookmarks page)
// ============================================================
let bookmarkIds = new Set();
let bookmarksLoaded = false;

async function loadBookmarkIds(uid) {
  const snap = await getDocs(collection(db, "users", uid, "bookmarks"));
  bookmarkIds = new Set(snap.docs.map(d => d.id));
  bookmarksLoaded = true;
}

function refreshBookmarkButtons() {
  document.querySelectorAll(".bookmark-btn[data-dance-id]").forEach(btn => {
    const on = bookmarkIds.has(btn.dataset.danceId);
    btn.classList.toggle("active", on);
    btn.textContent = on ? "★" : "☆";
    btn.setAttribute("aria-pressed", on);
  });
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".bookmark-btn");
  if (!btn) return;
  e.preventDefault();
  if (!currentUser) {
    if (confirm("Log in to save bookmarks. Go to the login page?")) location.href = "login.html";
    return;
  }
  const id = btn.dataset.danceId;
  const bmRef = doc(db, "users", currentUser.uid, "bookmarks", id);
  try {
    if (bookmarkIds.has(id)) {
      bookmarkIds.delete(id);
      refreshBookmarkButtons();
      await deleteDoc(bmRef);
      if ($("bookmarks-grid")) { bmDances = bmDances.filter(d => d.id !== id); renderBookmarks(); }
    } else {
      bookmarkIds.add(id);
      refreshBookmarkButtons();
      await setDoc(bmRef, { danceId: id, createdAt: serverTimestamp() });
    }
  } catch (err) {
    console.error("Bookmark update failed:", err);
    await loadBookmarkIds(currentUser.uid);
    refreshBookmarkButtons();
  }
});

// Cards are rendered asynchronously — re-apply the filled state whenever they change.
["library-grid", "bookmarks-grid"].forEach(id => {
  const grid = $(id);
  if (grid) new MutationObserver(() => refreshBookmarkButtons()).observe(grid, { childList: true });
});

onUser(async (user) => {
  if (user) { try { await loadBookmarkIds(user.uid); } catch (e) { console.error(e); } }
  else { bookmarkIds = new Set(); bookmarksLoaded = true; }
  refreshBookmarkButtons();
});

// ============================================================
// 4. BOOKMARKS PAGE
// ============================================================
let bmDances = [];
let bmArtist = null;

function renderBookmarks() {
  const grid = $("bookmarks-grid");
  const chipsEl = $("filter-chips");
  const q = ($("search-bar")?.value || "").trim().toLowerCase();

  if (chipsEl) {
    const artists = [...new Set(bmDances.map(d => d.artist))].sort();
    chipsEl.innerHTML = "";
    [["All", null], ...artists.map(a => [a, a])].forEach(([label, val]) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "filter-chip" + (bmArtist === val ? " active" : "");
      chip.textContent = label;
      chip.addEventListener("click", () => { bmArtist = val; renderBookmarks(); });
      chipsEl.appendChild(chip);
    });
  }

  const list = bmDances.filter(d =>
    (!bmArtist || d.artist === bmArtist) && (!q || d.songTitle?.toLowerCase().includes(q)));

  grid.innerHTML = list.length ? "" : `<p class="empty-note">${bmDances.length ? "No bookmarks match your search." : "No bookmarks yet — tap the ☆ on a dance in the Library to save it here."}</p>`;
  list.forEach(d => {
    const card = document.createElement("div");
    card.className = "dance-card";
    card.innerHTML = `
      <div class="dance-card-thumb-wrap">
        <img class="dance-card-thumb" src="${esc(d.thumbnailUrl || "")}" alt="${esc(d.songTitle)}">
        <button type="button" class="bookmark-btn" data-dance-id="${esc(d.id)}" aria-label="Bookmark">★</button>
      </div>
      <div class="dance-card-info">
        <p class="dance-card-title">${esc(d.songTitle)}</p>
        <p class="dance-card-artist">${esc(d.artist)}</p>
      </div>
      <select class="dance-member-select" data-dance-id="${esc(d.id)}">
        <option value="">Select a member</option>
        ${(d.members || []).map(m => `<option value="${esc(m.youtubeVideoId)}">${esc(m.Name)}</option>`).join("")}
      </select>`;
    grid.appendChild(card);
  });
  refreshBookmarkButtons();
}

if ($("bookmarks-grid")) {
  $("bookmarks-grid").addEventListener("change", (e) => {
    const sel = e.target.closest(".dance-member-select");
    if (sel?.value) location.href = `practice.html?dance=${sel.dataset.danceId}&video=${encodeURIComponent(sel.value)}`;
  });
  $("search-bar")?.addEventListener("input", renderBookmarks);

  onUser(async (user) => {
    const grid = $("bookmarks-grid");
    if (!user) {
      grid.innerHTML = `<p class="empty-note">Log in to see your saved dances. <a href="login.html">Login</a></p>`;
      return;
    }
    grid.innerHTML = `<p class="empty-note">Loading…</p>`;
    try {
      await loadBookmarkIds(user.uid);
      const docs = await Promise.all([...bookmarkIds].map(id => getDoc(doc(db, "dances", id))));
      bmDances = docs.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }));
      renderBookmarks();
    } catch (err) {
      console.error(err);
      grid.innerHTML = `<p class="empty-note">Could not load your bookmarks. Please try again later.</p>`;
    }
  });
}

// ============================================================
// 5. COMMUNITY — feed + posting
// ============================================================
const postForm = document.querySelector(".update-form");
const feedEl = $("feed");

function postHtml(id, p) {
  return `
    <article class="post-card" data-id="${esc(id)}" data-uid="${esc(p.uid)}">
      <div class="post-head"><strong>${esc(p.authorName || "Dancer")}</strong><span>${fmtDate(p.createdAt)}</span></div>
      ${p.songTitle ? `<div class="post-song">♪ ${esc(p.songTitle)}${p.artist ? ` — ${esc(p.artist)}` : ""}</div>` : ""}
      ${p.caption ? `<p class="post-caption">${esc(p.caption)}</p>` : ""}
      ${p.imageUrl ? `<img class="post-image" src="${esc(p.imageUrl)}" alt="Practice photo">` : ""}
      <button type="button" class="post-delete hidden">Delete</button>
    </article>`;
}

function applyPostOwnership() {
  document.querySelectorAll(".post-card").forEach(card => {
    const mine = currentUser && card.dataset.uid === currentUser.uid;
    card.querySelector(".post-delete")?.classList.toggle("hidden", !mine);
  });
}

let lastPostDoc = null;
async function loadFeed(more = false) {
  const moreBtn = $("feed-more");
  try {
    const constraints = [orderBy("createdAt", "desc")];
    if (more && lastPostDoc) constraints.push(startAfter(lastPostDoc));
    constraints.push(limit(10));
    const snap = await getDocs(query(collection(db, "posts"), ...constraints));
    if (!more) feedEl.innerHTML = "";
    if (snap.empty && !more) feedEl.innerHTML = `<p class="empty-note">No posts yet — be the first to share a practice update!</p>`;
    snap.docs.forEach(d => feedEl.insertAdjacentHTML("beforeend", postHtml(d.id, d.data())));
    lastPostDoc = snap.docs[snap.docs.length - 1] || lastPostDoc;
    moreBtn?.classList.toggle("hidden", snap.docs.length < 10);
    applyPostOwnership();
  } catch (err) {
    console.error("Feed load failed:", err);
    feedEl.innerHTML = `<p class="empty-note">Could not load the feed. Please try again later.</p>`;
  }
}

if (postForm && feedEl) {
  const songSelect = $("songs-list");
  const fileInput = postForm.querySelector('input[type="file"]');
  const fileLabel = postForm.querySelector(".btn-photo span");
  const caption = postForm.querySelector(".input-caption");
  const postBtn = postForm.querySelector('button[type="submit"]');
  let dancesById = {};

  getDocs(collection(db, "dances")).then(snap => {
    snap.docs.forEach(d => {
      dancesById[d.id] = d.data();
      songSelect.insertAdjacentHTML("beforeend", `<option value="${esc(d.id)}">${esc(d.data().songTitle)} — ${esc(d.data().artist)}</option>`);
    });
  }).catch(err => console.error("Could not load songs:", err));

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (f && f.size > 5 * 1024 * 1024) { alert("Photos must be under 5 MB."); fileInput.value = ""; }
    fileLabel.textContent = fileInput.files[0] ? fileInput.files[0].name.slice(0, 14) : "+ Photo";
  });

  postForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUser) {
      if (confirm("Log in to post. Go to the login page?")) location.href = "login.html";
      return;
    }
    const text = caption.value.trim();
    const file = fileInput.files[0];
    if (!text && !file) return alert("Add a caption or a photo first.");

    postBtn.disabled = true;
    postBtn.textContent = "Posting…";
    try {
      let imageUrl = "";
      if (file) {
        const imgRef = ref(storage, `posts/${currentUser.uid}/${Date.now()}_${slug(file.name)}`);
        await uploadBytes(imgRef, file, { contentType: file.type });
        imageUrl = await getDownloadURL(imgRef);
      }
      const dance = dancesById[songSelect.value];
      const data = {
        uid: currentUser.uid,
        authorName: currentUser.displayName || "Dancer",
        caption: text,
        imageUrl,
        danceId: songSelect.value || "",
        songTitle: dance?.songTitle || "",
        artist: dance?.artist || "",
        createdAt: serverTimestamp()
      };
      const created = await addDoc(collection(db, "posts"), data);
      feedEl.querySelector(".empty-note")?.remove();
      feedEl.insertAdjacentHTML("afterbegin", postHtml(created.id, { ...data, createdAt: { toDate: () => new Date() } }));
      applyPostOwnership();
      postForm.reset();
      fileLabel.textContent = "+ Photo";
    } catch (err) {
      console.error("Post failed:", err);
      alert("Could not post. Please try again.");
    } finally {
      postBtn.disabled = false;
      postBtn.textContent = "Post";
    }
  });

  feedEl.addEventListener("click", async (e) => {
    const del = e.target.closest(".post-delete");
    if (!del || !confirm("Delete this post?")) return;
    const card = del.closest(".post-card");
    try { await deleteDoc(doc(db, "posts", card.dataset.id)); card.remove(); }
    catch (err) { console.error(err); alert("Could not delete that post."); }
  });

  $("feed-more")?.addEventListener("click", () => loadFeed(true));
  loadFeed();
  onUser(applyPostOwnership);
}

// ============================================================
// 6. PROFILE + PROGRESS DASHBOARD
// ============================================================
async function fetchScores(uid, n) {
  const snap = await getDocs(query(collection(db, "users", uid, "scores"), orderBy("createdAt", "desc"), limit(n)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

if ($("profile-info")) {
  $("logout-button").addEventListener("click", async () => { await signOut(auth); location.href = "index.html"; });

  onUser(async (user) => {
    $("profile-info").classList.toggle("hidden", !user);
    $("profile-logged-out").classList.toggle("hidden", !!user);
    if (!user) return;
    $("profile-name").textContent = user.displayName || "Dancer";
    $("profile-email").textContent = user.email || "";

    const prog = $("progress");
    if (!prog) return;
    try {
      const scores = await fetchScores(user.uid, 50);
      if (!scores.length) {
        prog.innerHTML = `<p class="empty-note">No sessions yet. Open a dance from the Library, start your camera, and press Record Session.</p>`;
        return;
      }
      const vals = scores.map(s => s.score);
      const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      const best = Math.max(...vals);
      const bars = scores.slice(0, 10).reverse().map(s =>
        `<div class="bar" style="height:${Math.max(s.score, 4)}%" title="${esc(s.songTitle)}: ${s.score}%"></div>`).join("");
      prog.innerHTML = `
        <div class="stat-row">
          <div class="stat"><span class="stat-num">${scores.length}</span><span class="stat-label">Sessions</span></div>
          <div class="stat"><span class="stat-num">${avg}%</span><span class="stat-label">Average</span></div>
          <div class="stat"><span class="stat-num good">${best}%</span><span class="stat-label">Best</span></div>
        </div>
        <h4>Last ${Math.min(scores.length, 10)} sessions</h4>
        <div class="score-bars">${bars}</div>
        <h4>Recent practice</h4>
        <ul class="session-list">
          ${scores.slice(0, 8).map(s => `<li><span>${esc(s.songTitle || "Dance")}${s.member ? ` · ${esc(s.member)}` : ""}</span><span>${fmtDate(s.createdAt)}</span><strong class="${s.score >= 80 ? "good" : ""}">${s.score}%</strong></li>`).join("")}
        </ul>`;
    } catch (err) {
      console.error(err);
      prog.innerHTML = `<p class="empty-note">Could not load your progress.</p>`;
    }
  });
}

// ============================================================
// 7. HOME PAGE — continue practicing + trending
// ============================================================
const contRect = document.querySelector(".contRect");
const trendingEl = document.querySelector(".trending");

if (contRect && trendingEl) {
  fetchHome();
}
async function fetchHome() {
  try {
    const posts = await getDocs(query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(3)));
    if (!posts.empty) {
      trendingEl.querySelector("h4").classList.remove("hidden");
      trendingEl.insertAdjacentHTML("beforeend", `<div class="home-posts">${posts.docs.map(d => postHtml(d.id, d.data()).replace(/<button[^>]*post-delete[^>]*>.*?<\/button>/, "")).join("")}</div>`);
    }
  } catch (err) { console.error(err); }

  onUser(async (user) => {
    contRect.querySelector(".continue-list")?.remove();
    if (!user) return;
    try {
      const scores = await fetchScores(user.uid, 20);
      const seen = new Set();
      const recent = scores.filter(s => {
        const k = `${s.danceId}|${s.youtubeVideoId}`;
        if (!s.danceId || !s.youtubeVideoId || seen.has(k)) return false;
        seen.add(k); return true;
      }).slice(0, 3);
      if (!recent.length) return;
      contRect.querySelector("h4").classList.remove("hidden");
      contRect.insertAdjacentHTML("beforeend", `<div class="continue-list">${recent.map(s =>
        `<a class="continue-card" href="practice.html?dance=${encodeURIComponent(s.danceId)}&video=${encodeURIComponent(s.youtubeVideoId)}">
           <strong>${esc(s.songTitle)}</strong><span>${esc(s.member || "")}</span><em>Last: ${s.score}%</em></a>`).join("")}</div>`);
    } catch (err) { console.error(err); }
  });
}

// ============================================================
// 8. ADMIN — write dances to Firestore + upload skeleton JSON
// ============================================================
const adminForm = $("add-dance-form");
if (adminForm) {
  const status = document.createElement("p");
  status.className = "admin-status";
  adminForm.appendChild(status);

  onUser((user) => {
    const ok = !!user && user.email === ADMIN_EMAIL;
    adminForm.classList.toggle("hidden", !ok);
    $("admin-gate")?.remove();
    if (!ok) adminForm.insertAdjacentHTML("beforebegin", `<p id="admin-gate" class="empty-note">Admins only. ${user ? "This account doesn't have access." : '<a href="login.html">Log in</a> with the admin account.'}</p>`);
  });

  adminForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.textContent = "Saving…";
    status.className = "admin-status";
    try {
      for (const en of document.querySelectorAll(".dance-entry")) {
        const id = en.querySelector(".document-id").value.trim();
        const songTitle = en.querySelector(".song-title").value.trim();
        const artist = en.querySelector(".artist").value.trim();
        const thumbnailUrl = en.querySelector(".thumbnail-url").value.trim();
        if (!id || !songTitle || !artist) throw new Error("Each dance needs a document ID, song title, and artist.");

        const loopSections = [...en.querySelectorAll(".loop-sections-list .section-row")].map(r => ({
          Label: r.querySelector(".section-label").value.trim(),
          Start: Number(r.querySelector(".section-start").value),
          End: Number(r.querySelector(".section-end").value)
        })).filter(s => s.Label && s.End > s.Start);

        // Keep an existing member's skeletonUrl if no new file is chosen
        const existing = await getDoc(doc(db, "dances", id));
        const oldMembers = existing.exists() ? (existing.data().members || []) : [];

        const members = [];
        for (const r of en.querySelectorAll(".members-list .section-row")) {
          const Name = r.querySelector(".member-name").value.trim();
          const youtubeVideoId = r.querySelector(".member-youtube-id").value.trim();
          if (!Name || !youtubeVideoId) continue;
          let skeletonUrl = oldMembers.find(m => m.Name === Name)?.skeletonUrl || "";
          const file = r.querySelector(".member-skeleton").files[0];
          if (file) {
            const sRef = ref(storage, `skeletons/${id}/${slug(Name)}.json`);
            await uploadBytes(sRef, file, { contentType: "application/json" });
            skeletonUrl = await getDownloadURL(sRef);
          }
          members.push({ Name, youtubeVideoId, skeletonUrl });
        }

        const data = { songTitle, artist, thumbnailUrl, loopSections, members };
        if (!existing.exists()) data.createdAt = serverTimestamp();
        await setDoc(doc(db, "dances", id), data, { merge: true });
      }
      status.textContent = "Saved to the library ✓";
      status.classList.add("ok");
    } catch (err) {
      console.error(err);
      status.textContent = err.message || "Could not save. Check the console.";
      status.classList.add("bad");
    }
  });
}

// ============================================================
// 9. PRACTICE SCORING + RECORD SESSION
// ============================================================
// Compares joint ANGLES (not positions), so the score doesn't depend on how
// far you stand from the camera, your height, or where you stand in frame.
// Left/right are NOT swapped — this matches the Phantom Overlay, which
// draws both skeletons through the same mirrored canvas.
if ($("score-value")) initScoring();

function initScoring() {
  const AR = 16 / 9;                       // both video boxes are 16:9
  const TOLERANCE_DEG = 50;                // angle error that scores 0 for that joint
  const MAX_TIME_GAP = 0.5;                // ignore reference frames farther than this from "now"
  // [a, vertex, c] landmark indices (MediaPipe Pose)
  const ANGLES = [
    [11, 13, 15], [12, 14, 16],            // elbows
    [13, 11, 23], [14, 12, 24],            // shoulders
    [11, 23, 25], [12, 24, 26],            // hips
    [23, 25, 27], [24, 26, 28]             // knees
  ];

  const valueEl = $("score-value");
  const detailEl = $("score-detail");
  const recordBtn = $("record");
  const params = new URLSearchParams(location.search);

  let smooth = null, sum = 0, count = 0, lastPaint = 0;
  let recording = false, recStart = 0;

  const ok = (p) => p && (p.visibility === undefined || p.visibility > 0.5);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function angle(a, b, c) {
    const v1x = (a.x - b.x) * AR, v1y = a.y - b.y;
    const v2x = (c.x - b.x) * AR, v2y = c.y - b.y;
    const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!m) return null;
    return Math.acos(clamp((v1x * v2x + v1y * v2y) / m, -1, 1)) * 180 / Math.PI;
  }

  function frameScore(live, ref) {
    let total = 0, used = 0;
    for (const [i, j, k] of ANGLES) {
      if (!ok(live[i]) || !ok(live[j]) || !ok(live[k]) || !ok(ref[i]) || !ok(ref[j]) || !ok(ref[k])) continue;
      const a = angle(live[i], live[j], live[k]);
      const b = angle(ref[i], ref[j], ref[k]);
      if (a === null || b === null) continue;
      total += Math.max(0, 1 - Math.abs(a - b) / TOLERANCE_DEG);
      used++;
    }
    return used >= 4 ? (total / used) * 100 : null; // need enough visible joints to judge
  }

  function paint(force = false) {
    const now = performance.now();
    if (!force && now - lastPaint < 100) return;
    lastPaint = now;
    if (smooth === null) return;
    const s = Math.round(smooth);
    valueEl.textContent = s + "%";
    valueEl.classList.toggle("good", s >= 80);
    detailEl.textContent = recording
      ? `Recording · avg ${count ? Math.round(sum / count) : 0}%`
      : (s >= 80 ? "Great match!" : s >= 55 ? "Getting there" : "Keep following the ghost");
  }

  window.addEventListener("syncstep:pose", (e) => {
    const api = window.__syncstep;
    const player = api?.getPlayer?.();
    const live = e.detail;
    if (!player || !live || player.getPlayerState?.() !== 1) return; // 1 = playing
    const t = player.getCurrentTime();
    const kf = api.getKeyframe(t);
    if (!kf?.joints || Math.abs(kf.t - t) > MAX_TIME_GAP) return;

    const s = frameScore(live, kf.joints);
    if (s === null) return;
    smooth = smooth === null ? s : smooth * 0.85 + s * 0.15;
    if (recording) { sum += s; count++; }
    paint();
  });

  const cameraOn = () => !!$("webcam-feed")?.srcObject;

  async function finishRecording(reason = "") {
    if (!recording) return;
    recording = false;
    recordBtn.textContent = "Record Session";
    recordBtn.classList.remove("recording");
    const avg = count ? Math.round(sum / count) : 0;
    const durationSec = Math.round((Date.now() - recStart) / 1000);

    if (count < 30) {
      detailEl.textContent = "Not enough data to score — play the video with your camera on.";
    } else if (!currentUser) {
      valueEl.textContent = avg + "%";
      detailEl.innerHTML = `Session average ${avg}% — <a href="login.html">log in</a> to save it.`;
    } else {
      valueEl.textContent = avg + "%";
      valueEl.classList.toggle("good", avg >= 80);
      detailEl.textContent = `Session average ${avg}%${reason} — saving…`;
      try {
        const api = window.__syncstep;
        await addDoc(collection(db, "users", currentUser.uid, "scores"), {
          danceId: params.get("dance") || "",
          youtubeVideoId: params.get("video") || "",
          songTitle: api?.getDance?.()?.songTitle || "",
          artist: api?.getDance?.()?.artist || "",
          member: api?.getMember?.()?.Name || "",
          score: avg,
          durationSec,
          createdAt: serverTimestamp()
        });
        detailEl.textContent = `Session average ${avg}% — saved to your profile ✓`;
      } catch (err) {
        console.error("Saving score failed:", err);
        detailEl.textContent = `Session average ${avg}% — couldn't save it.`;
      }
    }
    sum = 0; count = 0;
  }

  recordBtn?.addEventListener("click", () => {
    if (recording) return finishRecording();
    if (!cameraOn()) { detailEl.textContent = "Start your camera first."; return; }
    recording = true; sum = 0; count = 0; recStart = Date.now();
    recordBtn.textContent = "Stop Recording";
    recordBtn.classList.add("recording");
    paint(true);
    detailEl.textContent = "Recording · press play on the video";
  });

  $("stop-camera-btn")?.addEventListener("click", () => finishRecording(""));

  // Auto-finish when the video ends
  setInterval(() => {
    const p = window.__syncstep?.getPlayer?.();
    if (recording && p?.getPlayerState?.() === 0) finishRecording(" (video ended)");
  }, 1000);
}
