// =========================================================================
// CONFIG
// =========================================================================
const TMDB_API_KEY = "ebc17fdd2c491ffd1d0cbac7000be592";
// YouTube Data API v3 key — get one free at console.cloud.google.com
// (APIs & Services > Library > enable "YouTube Data API v3" > Credentials).
// Leave "" to disable the YouTube rows entirely.
const YOUTUBE_API_KEY = "AIzaSyAKKU-KovcZzcvcXtUhuoUEsYBndxAOfjU";
// Each entry pulls from that channel's "uploads" playlist (its full upload
// history) unless an explicit playlistId is given, in which case that exact
// playlist is used instead (e.g. a specific show/podcast playlist rather
// than everything the channel posts).
const YOUTUBE_CHANNELS = [
  { key: "flagrant", label: "Flagrant", handle: "OfficialFlagrant", playlistId: "PL1JULMhsLAypfSsBputK5dah9WKASIo-v" }, // "Flagrant Full Episodes"
  { key: "mssp", label: "MSSP", handle: "MSsecretpod" },
  { key: "igr", label: "IGR Podcasts", handle: "IndiaGlobalReview", playlistId: "PLa0gskjtcZLw" }, // "The Palki Sharma Show"
];
const PLAYER_COLOR = "D9A441";
// Optional: deploy the Cloudflare Worker in /worker and put its URL here to
// route the player through a popup-shielding proxy. Leave "" to disable.
const PROXY_PLAYER_BASE = "";

// ---- Player provider ----
// All free embed providers monetize via popup ads. Try a few and pick the
// least aggressive at the moment. Swap this single value.
//   "videasy"  – default, supports postMessage progress + many params
//   "vidlink"  – often cleaner; supports postMessage progress
//   "vidsrc"   – different URL scheme, fewer params
//   "embedsu"  – minimal, bare embed
const PLAYER_PROVIDER = "videasy";
// If the default provider never signals a single timeupdate within this
// long (some devices/networks get stuck on the provider's own loading
// screen — e.g. a caption fetch that silently hangs), automatically swap
// to this fallback provider once and retry, rather than leaving the user
// stuck on an infinite spinner.
const PLAYER_FALLBACK_PROVIDER = "vidlink";
const PLAYER_WATCHDOG_MS = 14000;
// =========================================================================

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const PLAYER_BASES = {
  // .net 301-redirects to .to — pointing here directly avoids the extra hop,
  // and matters more than that: postMessage's event.origin reflects the
  // final redirected document (.to), so PLAYER_ORIGIN (derived from this
  // constant) must match .to or the progress-tracking listener silently
  // rejects every message from the real player.
  videasy: "https://player.videasy.to",
  vidlink: "https://vidlink.pro",
  vidsrc:  "https://vidsrc.cc/v2/embed",
  embedsu: "https://embed.su/embed",
};
const PLAYER_BASE = PROXY_PLAYER_BASE || PLAYER_BASES[PLAYER_PROVIDER] || PLAYER_BASES.videasy;
const PLAYER_ORIGIN = new URL(PLAYER_BASE).origin;
// Named YT_EMBED (not YT) because the real YouTube IFrame Player API script
// declares a global `YT` object — a `const YT` here would collide with it
// and throw "Identifier 'YT' has already been declared".
const YT_EMBED = "https://www.youtube.com/embed/";
// Toggling mute by tearing down and recreating the iframe re-triggers the
// browser's autoplay-with-sound gate — mobile Safari/Chrome only allow that
// on a synchronous tap, and rebuilding involves an async trailer-key fetch,
// so the new iframe's unmuted autoplay silently gets blocked. Instead we keep
// the same already-playing iframe alive and just send it a mute/unMute
// command (requires enablejsapi=1 on the src), which is always allowed since
// no new playback is being started.
function postYTCommand(iframe, func) {
  try { iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args: [] }), "https://www.youtube.com"); } catch {}
}

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// ---------- Auth / cloud account ----------
firebase.initializeApp(FIREBASE_CONFIG);
const fbAuth = firebase.auth();
const fbDb = firebase.firestore();
let currentUser = null; // firebase.User once signed in

const GENRES_MOVIE = [
  { id: 28,    name: "Action" },
  { id: 35,    name: "Comedy" },
  { id: 27,    name: "Horror" },
  { id: 878,   name: "Sci-Fi" },
  { id: 10749, name: "Romance" },
  { id: 99,    name: "Documentaries" },
  { id: 53,    name: "Thrillers" },
  { id: 16,    name: "Animated Films" },
];

// ---------- Storage ----------
const STORAGE = {
  sidebarCollapsed: "movietube:sidebarCollapsed",
  progress: "movietube:progress",
  list: "movietube:mylist",
  onboarded: "movietube:onboarded",
  ratings: "movietube:ratings",
  dismissed: "movietube:dismissed",
  recapShown: "movietube:recap",
  hidden: "movietube:hidden",         // "not interested" titles
  tags: "movietube:tags",             // { "movie:550": ["favorite", "rewatch"] }
  journal: "movietube:journal",       // { "movie:550": "best twist ever" }
  rewatch: "movietube:rewatch",       // { "movie:550": 2 }
  sessions: "movietube:sessions",     // [{ start, end }] for time-of-day
  goal: "movietube:goal",             // monthly hours goal { hours, month }
  region: "movietube:region",         // user country preference
  privacy: "movietube:privacy",       // { pauseProgress, pauseSession, pauseHistory }
  achievements: "movietube:ach",      // { id: unlockedAt }
  affinityActors: "movietube:actors", // { actorId: { name, count, profile_path, lastSeen } }
  affinityDirectors: "movietube:directors",
  status: "movietube:status",         // explicit status overrides { itemKey: "dropped" | "plan" }
};
const loadJSON = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) || f; } catch { return f; } };
const saveJSON = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); scheduleCloudSync(); };
let progressMap = {};
let myList = [];
let ratingsMap = {};
let dismissedMap = {};
let hiddenMap = {};
let tagsMap = {};
let journalMap = {};
let rewatchMap = {};
let sessionsList = [];
let monthlyGoal = null;
let userRegion = "US";
let currentSession = null;       // { start, itemKey } for active playback
let bedtimeOn = false;
let multiSelectMode = false;
let selectedListIds = new Set();
let privacy = { pauseProgress: false, pauseSession: false, pauseHistory: false };
let achievements = {};
let affinityActors = {};
let affinityDirectors = {};
let statusOverrides = {};

// Per-account storage keys (namespaced by the signed-in Firebase user's uid)
function profileStorageKey(base) {
  return currentUser?.uid ? `${base}:${currentUser.uid}` : base;
}

// ===== Cloud sync (Firestore) — cross-device continuity =====
// localStorage stays the fast, synchronous source of truth for the UI;
// Firestore is a debounced mirror of it so other signed-in devices catch up.
// A short debounce keeps this well under Firestore's free-tier write quota
// even during active playback (progress saves fire every few seconds).
let cloudSyncTimer = null;
let cloudSyncDirty = false;
let cloudApplyingRemote = false; // true while writing a remote snapshot locally, to avoid re-uploading it
let cloudUnsubscribe = null;

function scheduleCloudSync() {
  if (!currentUser || cloudApplyingRemote) return;
  cloudSyncDirty = true;
  if (cloudSyncTimer) return;
  cloudSyncTimer = setTimeout(() => { cloudSyncTimer = null; flushCloudSync(); }, 8000);
}
function collectUserLocalData() {
  const suffix = `:${currentUser.uid}`;
  const data = {};
  for (const key of Object.keys(localStorage)) {
    if (key.endsWith(suffix)) data[key] = localStorage.getItem(key);
  }
  return data;
}
async function flushCloudSync() {
  if (!currentUser || !cloudSyncDirty) return;
  cloudSyncDirty = false;
  try {
    await fbDb.collection("users").doc(currentUser.uid).set(
      { data: collectUserLocalData(), updatedAt: Date.now() },
      { merge: true }
    );
  } catch (e) { console.warn("Cloud sync failed:", e.message); }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) flushCloudSync(); });
window.addEventListener("beforeunload", flushCloudSync);

async function pullCloudDataOnce() {
  try {
    const doc = await fbDb.collection("users").doc(currentUser.uid).get();
    applyRemoteData(doc.data()?.data);
  } catch (e) { console.warn("Cloud pull failed:", e.message); }
}
function applyRemoteData(data) {
  if (!data) return;
  cloudApplyingRemote = true;
  for (const [key, value] of Object.entries(data)) localStorage.setItem(key, value);
  cloudApplyingRemote = false;
}
function startCloudListener() {
  cloudUnsubscribe?.();
  // onSnapshot always fires once immediately with the current doc — skip that
  // first firing since enterApp() already loaded this data via
  // pullCloudDataOnce() and rendered the page; only react to snapshots after
  // that (a genuine remote change from this device's own confirmed write, or
  // another device's update).
  let firstSnapshot = true;
  cloudUnsubscribe = fbDb.collection("users").doc(currentUser.uid)
    .onSnapshot(doc => {
      if (firstSnapshot) { firstSnapshot = false; return; }
      // Ignore the instant local echo of our own pending write — only react
      // to changes actually confirmed by the server (our own, or another device's).
      if (doc.metadata.hasPendingWrites) return;
      applyRemoteData(doc.data()?.data);
      loadProfileData();
      migrateEpisodeProgress();
      route();
    }, e => console.warn("Cloud listener error:", e.message));
}
function stopCloudListener() {
  cloudUnsubscribe?.();
  cloudUnsubscribe = null;
}

function loadProfileData() {
  progressMap = loadJSON(profileStorageKey(STORAGE.progress), {});
  myList = loadJSON(profileStorageKey(STORAGE.list), []);
  ratingsMap = loadJSON(profileStorageKey(STORAGE.ratings), {});
  dismissedMap = loadJSON(profileStorageKey(STORAGE.dismissed), {});
  hiddenMap = loadJSON(profileStorageKey(STORAGE.hidden), {});
  tagsMap = loadJSON(profileStorageKey(STORAGE.tags), {});
  journalMap = loadJSON(profileStorageKey(STORAGE.journal), {});
  rewatchMap = loadJSON(profileStorageKey(STORAGE.rewatch), {});
  sessionsList = loadJSON(profileStorageKey(STORAGE.sessions), []);
  monthlyGoal = loadJSON(profileStorageKey(STORAGE.goal), null);
  userRegion = localStorage.getItem(STORAGE.region) || "US";
  privacy = loadJSON(profileStorageKey(STORAGE.privacy), { pauseProgress: false, pauseSession: false, pauseHistory: false });
  achievements = loadJSON(profileStorageKey(STORAGE.achievements), {});
  affinityActors = loadJSON(profileStorageKey(STORAGE.affinityActors), {});
  affinityDirectors = loadJSON(profileStorageKey(STORAGE.affinityDirectors), {});
  statusOverrides = loadJSON(profileStorageKey(STORAGE.status), {});
  // Auto-cleanup: dismiss items not touched in 30+ days
  const thirtyDaysAgo = Date.now() - (30 * 24 * 3600 * 1000);
  for (const [k, v] of Object.entries(progressMap)) {
    if (!v.isEpisode && v.updatedAt && v.updatedAt < thirtyDaysAgo && v.progress < 95) {
      dismissedMap[k] = true;
    }
  }
}
function saveProgress() { saveJSON(profileStorageKey(STORAGE.progress), progressMap); }
function saveMyList() { saveJSON(profileStorageKey(STORAGE.list), myList); }
function saveRatings() { saveJSON(profileStorageKey(STORAGE.ratings), ratingsMap); }
function saveDismissed() { saveJSON(profileStorageKey(STORAGE.dismissed), dismissedMap); }
function saveHidden() { saveJSON(profileStorageKey(STORAGE.hidden), hiddenMap); }
function saveTags() { saveJSON(profileStorageKey(STORAGE.tags), tagsMap); }
function saveJournal() { saveJSON(profileStorageKey(STORAGE.journal), journalMap); }
function saveRewatch() { saveJSON(profileStorageKey(STORAGE.rewatch), rewatchMap); }
function saveSessions() { saveJSON(profileStorageKey(STORAGE.sessions), sessionsList); }
function saveGoal() { saveJSON(profileStorageKey(STORAGE.goal), monthlyGoal); }
function savePrivacy() { saveJSON(profileStorageKey(STORAGE.privacy), privacy); }
function saveAchievements() { saveJSON(profileStorageKey(STORAGE.achievements), achievements); }
function saveAffinityActors() { saveJSON(profileStorageKey(STORAGE.affinityActors), affinityActors); }
function saveAffinityDirectors() { saveJSON(profileStorageKey(STORAGE.affinityDirectors), affinityDirectors); }
function saveStatusOverrides() { saveJSON(profileStorageKey(STORAGE.status), statusOverrides); }

// ===== Smart status engine =====
// Returns: "completed" | "watching" | "rewatching" | "dropped" | "plan" | "none"
function computeStatus(item) {
  const k = itemKey(item);
  // Manual override wins
  if (statusOverrides[k]) return statusOverrides[k];
  const v = progressMap[k];
  const inList = myList.some(m => itemKey(m) === k);
  const rwCount = rewatchMap[k] || 0;
  if (!v || !v.progress) return inList ? "plan" : "none";
  if (v.progress >= 95) {
    if (rwCount >= 2 && (Date.now() - (v.updatedAt || 0)) < 30 * 86400000) return "rewatching";
    return "completed";
  }
  // In progress
  const daysSince = (Date.now() - (v.updatedAt || 0)) / 86400000;
  if (daysSince > 14 && v.progress < 60) return "dropped";
  return "watching";
}
function setStatusOverride(item, status) {
  const k = itemKey(item);
  if (!status || status === "none") delete statusOverrides[k];
  else statusOverrides[k] = status;
  saveStatusOverrides();
}

// ===== Achievements catalog =====
const ACHIEVEMENTS = [
  { id: "h100",   icon: "C",  title: "Century Club",       desc: "100 hours watched",            check: (s) => s.totalHours >= 100 },
  { id: "h500",   icon: "CI", title: "Cinephile",          desc: "500 hours watched",            check: (s) => s.totalHours >= 500 },
  { id: "h1000",  icon: "MW", title: "Master Watcher",     desc: "1000 hours watched",           check: (s) => s.totalHours >= 1000 },
  { id: "fin5",   icon: "✓",  title: "Finisher",           desc: "5 titles finished",            check: (s) => s.finished >= 5 },
  { id: "fin25",  icon: "CL", title: "Closer",             desc: "25 titles finished",           check: (s) => s.finished >= 25 },
  { id: "fin100", icon: "MA", title: "Marathon",           desc: "100 titles finished",          check: (s) => s.finished >= 100 },
  { id: "ser5",   icon: "SV", title: "Series Veteran",     desc: "5 series finished",            check: (s) => s.finishedShows >= 5 },
  { id: "ser20",  icon: "SR", title: "Showrunner",         desc: "20 series finished",           check: (s) => s.finishedShows >= 20 },
  { id: "mov50",  icon: "MB", title: "Movie Buff",         desc: "50 movies watched",            check: (s) => s.finishedMovies >= 50 },
  { id: "ep100",  icon: "EE", title: "Episode Eater",      desc: "100 episodes watched",         check: (s) => s.totalEpisodes >= 100 },
  { id: "ep500",  icon: "EC", title: "Episode Champion",   desc: "500 episodes watched",         check: (s) => s.totalEpisodes >= 500 },
  { id: "str7",   icon: "7",  title: "Week Streak",        desc: "Watched 7 days in a row",      check: (s) => s.streak >= 7 },
  { id: "str30",  icon: "30", title: "Month Streak",       desc: "Watched 30 days in a row",     check: (s) => s.streak >= 30 },
  { id: "rw1",    icon: "↻",  title: "First Rewatch",      desc: "Rewatched a title",            check: (s) => s.rewatches >= 1 },
  { id: "rw10",   icon: "∞",  title: "Comfort Watcher",    desc: "Rewatched 10 titles",          check: (s) => s.rewatches >= 10 },
  { id: "gen5",   icon: "GE", title: "Genre Explorer",     desc: "Watched 5 different genres",   check: (s) => s.genreCount >= 5 },
  { id: "gen10",  icon: "GC", title: "Genre Connoisseur",  desc: "Watched 10 different genres",  check: (s) => s.genreCount >= 10 },
  { id: "rate10", icon: "★",  title: "Critic",             desc: "Rated 10 titles",              check: (s) => s.ratingsCount >= 10 },
  { id: "rate50", icon: "★★", title: "Reviewer",           desc: "Rated 50 titles",              check: (s) => s.ratingsCount >= 50 },
  { id: "tag5",   icon: "OR", title: "Organizer",          desc: "Used 5 different tags",        check: (s) => s.tagCount >= 5 },
  { id: "binge",  icon: "BM", title: "Binge Master",       desc: "4+ episodes in one session",   check: (s) => s.maxBinge >= 4 },
  { id: "night",  icon: "NO", title: "Night Owl",          desc: "10 late-night sessions",       check: (s) => s.nightSessions >= 10 },
  { id: "morn",   icon: "EB", title: "Early Bird",         desc: "10 morning sessions",          check: (s) => s.morningSessions >= 10 },
];

function computeAchievementStats() {
  const entries = Object.entries(progressMap).filter(([, v]) => v.title);
  const eps = Object.values(progressMap).filter(v => v.isEpisode);
  const totalSecs = entries.reduce((a, [, v]) => a + (v.timestamp || 0), 0)
                  + eps.reduce((a, v) => a + (v.timestamp || 0), 0);
  const finished = entries.filter(([, v]) => v.progress >= 95).length;
  const finishedMovies = entries.filter(([, v]) => v.itemType === "movie" && v.progress >= 95).length;
  const finishedShows = entries.filter(([, v]) => v.itemType === "tv" && v.progress >= 95).length;
  const totalEpisodes = eps.filter(v => v.progress >= 95).length;
  const rewatches = Object.keys(rewatchMap).filter(k => rewatchMap[k] >= 2).length;
  // Streak
  const dayKey = (ts) => { const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); };
  const dayBucket = new Set(Object.values(progressMap).map(v => v.updatedAt).filter(Boolean).map(dayKey));
  let streak = 0; let cur = new Date(); cur.setHours(0,0,0,0);
  if (!dayBucket.has(cur.getTime())) cur.setDate(cur.getDate() - 1);
  while (dayBucket.has(cur.getTime())) { streak++; cur.setDate(cur.getDate() - 1); }
  // Genres count — real TMDB genre IDs captured while watching (see genreIds
  // on the progress entry), not just a proxy based on watch count
  const genres = new Set();
  entries.forEach(([, v]) => (v.genreIds || []).forEach(g => genres.add(g)));
  return {
    totalHours: totalSecs / 3600,
    finished, finishedMovies, finishedShows,
    totalEpisodes, rewatches, streak,
    genreCount: genres.size,
    ratingsCount: Object.keys(ratingsMap).length,
    tagCount: new Set(Object.values(tagsMap).flat()).size,
    maxBinge: computeMaxBinge(),
    nightSessions: sessionsList.filter(s => { const h = new Date(s.start).getHours(); return h >= 22 || h < 5; }).length,
    morningSessions: sessionsList.filter(s => { const h = new Date(s.start).getHours(); return h >= 5 && h < 11; }).length,
  };
}

function computeMaxBinge() {
  // Count consecutive episode plays of same show within 4 hours
  if (!sessionsList.length) return 0;
  const sorted = [...sessionsList].sort((a, b) => a.start - b.start);
  let max = 1, cur = 1, lastKey = null, lastEnd = 0;
  for (const s of sorted) {
    if (s.itemKey === lastKey && s.start - lastEnd < 4 * 3600000) {
      cur++; if (cur > max) max = cur;
    } else { cur = 1; }
    lastKey = s.itemKey; lastEnd = s.end || s.start;
  }
  return max;
}

function checkAchievements() {
  const stats = computeAchievementStats();
  const newly = [];
  ACHIEVEMENTS.forEach(a => {
    if (!achievements[a.id] && a.check(stats)) {
      achievements[a.id] = Date.now();
      newly.push(a);
    }
  });
  if (newly.length) {
    saveAchievements();
    newly.forEach((a, i) => setTimeout(() => showAchievementToast(a), i * 1500));
  }
}

function showAchievementToast(a) {
  const t = document.createElement("div");
  t.className = "achievement-toast";
  t.innerHTML = `
    <div class="ach-icon">${a.icon}</div>
    <div class="ach-text">
      <div class="ach-eyebrow">Achievement Unlocked</div>
      <div class="ach-title">${escapeHTML(a.title)}</div>
      <div class="ach-desc">${escapeHTML(a.desc)}</div>
    </div>`;
  document.body.appendChild(t);
  // Sparkles
  setTimeout(() => sparkleAt(t), 200);
  setTimeout(() => { t.classList.add("fade-out"); setTimeout(() => t.remove(), 400); }, 5000);
}

// ===== Actor/Director affinity =====
async function trackAffinityForItem(item) {
  if (privacy.pauseProgress) return;
  try {
    const credits = await tmdb(`/${item.type}/${item.id}/credits`).catch(() => null);
    if (!credits) return;
    // Top 3 cast
    (credits.cast || []).slice(0, 3).forEach(c => {
      affinityActors[c.id] = affinityActors[c.id] || { name: c.name, count: 0, profile_path: c.profile_path };
      affinityActors[c.id].count++;
      affinityActors[c.id].lastSeen = Date.now();
    });
    // Director(s)
    const directors = (credits.crew || []).filter(c => c.job === "Director" || c.department === "Directing");
    directors.slice(0, 2).forEach(d => {
      affinityDirectors[d.id] = affinityDirectors[d.id] || { name: d.name, count: 0, profile_path: d.profile_path };
      affinityDirectors[d.id].count++;
      affinityDirectors[d.id].lastSeen = Date.now();
    });
    saveAffinityActors();
    saveAffinityDirectors();
  } catch {}
}
function itemKey(item) { return `${item.type}:${item.id}`; }
function typeLabel(item) {
  return item.type === "tv" ? "Series" : item.type === "youtube" ? "Video" : "Movie";
}
function getTags(item) { return tagsMap[itemKey(item)] || []; }
function setTags(item, tags) {
  if (!tags || !tags.length) delete tagsMap[itemKey(item)];
  else tagsMap[itemKey(item)] = tags;
  saveTags();
}
function getJournal(item) { return journalMap[itemKey(item)] || ""; }
function setJournal(item, text) {
  if (!text) delete journalMap[itemKey(item)];
  else journalMap[itemKey(item)] = text;
  saveJournal();
}
function isHidden(item) { return !!hiddenMap[itemKey(item)]; }
function hideItem(item) { hiddenMap[itemKey(item)] = true; saveHidden(); }
function unhideItem(item) { delete hiddenMap[itemKey(item)]; saveHidden(); }

// ===== Bedtime mode (auto after 11pm or manual) =====
function checkBedtime() {
  const h = new Date().getHours();
  const auto = (h >= 23 || h < 5);
  $("#app").classList.toggle("bedtime", bedtimeOn || auto);
}
setInterval(checkBedtime, 60000);
function getRating(item) { return ratingsMap[`${item.type}:${item.id}`] || null; }
function setRating(item, rating) {
  const k = `${item.type}:${item.id}`;
  if (ratingsMap[k] === rating) delete ratingsMap[k];  // toggle off
  else ratingsMap[k] = rating;
  saveRatings();
}

// Migrate old show-level progress into per-episode entries (one time)
function migrateEpisodeProgress() {
  let changed = false;
  for (const [k, v] of Object.entries(progressMap)) {
    if (!v || v.isEpisode) continue;
    if (v.itemType === "tv" && v.episode) {
      const epKey = `${v.itemType}:${v.itemId}:s${v.season || 1}:e${v.episode}`;
      if (!progressMap[epKey]) {
        progressMap[epKey] = {
          progress: v.progress, timestamp: v.timestamp, duration: v.duration,
          season: v.season || 1, episode: v.episode,
          updatedAt: v.updatedAt || Date.now(), isEpisode: true,
        };
        changed = true;
      }
    }
  }
  if (changed) saveProgress();
}

// ---------- TMDB ----------
const tmdbCache = new Map();
async function tmdb(path, params = {}) {
  const key = path + JSON.stringify(params);
  if (tmdbCache.has(key)) return tmdbCache.get(key);
  const url = new URL(TMDB + path);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "en-US");
  url.searchParams.set("include_image_language", "en,null");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  const json = await r.json();
  tmdbCache.set(key, json);
  return json;
}

// ---------- YouTube channel rows ----------
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
async function youtubeFetch(path, params = {}) {
  const url = new URL(`${YOUTUBE_API}/${path}`);
  url.searchParams.set("key", YOUTUBE_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`YouTube API ${r.status}`);
  return r.json();
}
// Every channel has an auto-generated "uploads" playlist holding its full
// upload history — resolve it once per handle and cache it for the session.
const uploadsPlaylistCache = {};
async function resolveUploadsPlaylistId(handle) {
  if (uploadsPlaylistCache[handle]) return uploadsPlaylistCache[handle];
  const data = await youtubeFetch("channels", { forHandle: handle, part: "contentDetails" });
  const id = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (id) uploadsPlaylistCache[handle] = id;
  return id;
}
function normalizeYouTubeVideo(playlistItem) {
  const sn = playlistItem.snippet;
  const videoId = playlistItem.contentDetails?.videoId || sn?.resourceId?.videoId;
  return {
    id: videoId,
    type: "youtube",
    title: sn.title,
    channelTitle: sn.videoOwnerChannelTitle || sn.channelTitle,
    poster: sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url,
    publishedAt: sn.publishedAt,
  };
}
async function fetchYouTubeChannelRow(cfg, maxResults = 12) {
  const playlistId = cfg.playlistId || await resolveUploadsPlaylistId(cfg.handle);
  if (!playlistId) return { label: cfg.label, items: [] };
  const data = await youtubeFetch("playlistItems", { playlistId, part: "snippet,contentDetails", maxResults });
  const items = (data.items || [])
    .filter(it => it.contentDetails?.videoId && it.snippet?.title && it.snippet.title !== "Private video" && it.snippet.title !== "Deleted video")
    .map(normalizeYouTubeVideo)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return { label: cfg.label, items };
}

// ---------- Normalizers ----------
function normalizeTMDB(item, forcedType) {
  const type = forcedType || (item.media_type === "tv" ? "tv" : item.media_type === "movie" ? "movie" : "movie");
  return {
    id: item.id,
    type,
    title: item.title || item.name,
    poster: item.poster_path ? `${IMG}/w500${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `${IMG}/original${item.backdrop_path}` : null,
    backdropMd: item.backdrop_path ? `${IMG}/w780${item.backdrop_path}` : null,
    overview: item.overview,
    year: (item.release_date || item.first_air_date || "").slice(0, 4),
    rating: item.vote_average ? item.vote_average.toFixed(1) : null,
    voteCount: item.vote_count,
  };
}

function pseudoMatch(item) {
  const r = parseFloat(item.rating || 0);
  return Math.min(98, Math.max(60, Math.round(r * 10)));
}

function pseudoAge(item) {
  const r = parseFloat(item.rating || 0);
  if (r >= 8) return "16+";
  if (r >= 7) return "13+";
  if (r >= 6) return "PG";
  return "All";
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
// Maps a raw fetch/API error into something worth showing someone who
// isn't going to know what "TMDB 429" means.
function friendlyErrorMessage(e) {
  const msg = e?.message || "";
  if (/429/.test(msg)) return "Too many requests right now — please wait a moment and try again.";
  if (/40[13]/.test(msg)) return "Couldn't load this — there's a problem with the data source.";
  if (/TMDB|YouTube API/.test(msg)) return "Couldn't load this right now. Please try again.";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "You appear to be offline. Check your connection and try again.";
  return "Something went wrong loading this page.";
}

// ---------- Dominant-color extraction ----------
const colorCache = new Map();
function extractDominantColor(url) {
  if (!url) return Promise.resolve(null);
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
  return new Promise((resolve) => {
    // Note: TMDB's image CDN does not send CORS headers, so requesting the
    // image as crossOrigin="anonymous" makes it fail to load at all. Loading
    // it without crossOrigin still lets it render normally; the canvas read
    // below just throws (caught) and we fall back to no tint.
    const img = new Image();
    img.onload = () => {
      try {
        const W = 64, H = 64;
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, W, H);
        const data = ctx.getImageData(0, 0, W, H).data;
        // Quantize into 4-bit-per-channel buckets, pick the most-vibrant common bucket
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 200) continue;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max - min;
          // Skip near-black, near-white, and grayscale pixels
          if (max < 50 || min > 220 || sat < 35) continue;
          const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
          let bucket = buckets.get(key);
          if (!bucket) { bucket = { r: 0, g: 0, b: 0, n: 0, score: 0 }; buckets.set(key, bucket); }
          bucket.r += r; bucket.g += g; bucket.b += b; bucket.n++;
          // Score favors saturation + count
          bucket.score += sat;
        }
        if (!buckets.size) { colorCache.set(url, null); return resolve(null); }
        let best = null;
        for (const b of buckets.values()) if (!best || b.score > best.score) best = b;
        const color = {
          r: Math.round(best.r / best.n),
          g: Math.round(best.g / best.n),
          b: Math.round(best.b / best.n),
        };
        // Boost saturation a bit & cap luminance so it always reads as a tint
        const tweaked = clampForTint(color);
        colorCache.set(url, tweaked);
        resolve(tweaked);
      } catch (e) {
        colorCache.set(url, null);
        resolve(null);
      }
    };
    img.onerror = () => { colorCache.set(url, null); resolve(null); };
    img.src = url;
  });
}
function clampForTint({ r, g, b }) {
  // Darken the tint heavily so it acts as a subtle ambient hint, never dominant
  const max = Math.max(r, g, b);
  const scale = max > 0 ? 130 / max : 1;
  return { r: Math.round(r * scale), g: Math.round(g * scale), b: Math.round(b * scale) };
}
function applyHeroTint(color) {
  const rgb = color ? `${color.r}, ${color.g}, ${color.b}` : "22, 20, 17";
  document.documentElement.style.setProperty("--hero-tint-rgb", rgb);
}
function applyModalTint(color) {
  const rgb = color ? `${color.r}, ${color.g}, ${color.b}` : "30, 27, 23";
  document.documentElement.style.setProperty("--modal-tint-rgb", rgb);
}

// ---------- Lazy image loader ----------
const lazyImageObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting && e.target.dataset.bg) {
      const url = e.target.dataset.bg;
      const target = e.target;
      const img = new Image();
      img.onload = img.onerror = () => {
        target.style.backgroundImage = `url("${url}")`;
        target.classList.add("img-loaded");
      };
      img.src = url;
      target.removeAttribute("data-bg");
      lazyImageObserver.unobserve(target);
    }
  });
}, { rootMargin: "200px 100px" });

function preloadImage(url) {
  if (!url) return;
  const existing = document.querySelector(`link[rel="preload"][href="${url}"]`);
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "preload"; link.as = "image"; link.href = url;
  document.head.appendChild(link);
}

// ---------- Cards & Rows ----------
// Makes a non-native clickable element (div-based card) reachable and
// operable by keyboard: focusable, announced as a button with a real name,
// and activatable with Enter/Space — none of which a bare click handler gives you.
function makeFocusableActivatable(el, label, onActivate) {
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", label);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
  });
}

function makeCard(item, opts = {}) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.itemId = item.id;
  card.dataset.itemType = item.type;
  const thumb = document.createElement("div");
  thumb.className = "card-thumb";
  const bg = item.backdropMd || item.backdrop || item.poster;
  if (bg) { thumb.dataset.bg = bg; lazyImageObserver.observe(thumb); }
  const key = progressKey(item);
  const p = progressMap[key];
  let progressBar = "", cwMeta = "", watchedBadge = "", rewatchBadge = "";
  if (p && p.progress >= 95) watchedBadge = `<div class="watched-badge">Watched</div>`;
  const rwCount = rewatchMap[itemKey(item)] || 0;
  if (rwCount >= 2) rewatchBadge = `<div class="rewatch-badge">↻ ${rwCount}×</div>`;
  // Always show a thin progress bar if there's any progress (Netflix style)
  if (p?.progress && p.progress > 1 && p.progress < 95) {
    progressBar = `<div class="progress-bar"><div style="width:${Math.min(100, Math.round(p.progress))}%"></div></div>`;
  }
  // Continue Watching row gets richer meta (S/E + time left)
  if (opts.showProgress && p?.progress) {
    let epLabel = "";
    if (item.type === "tv" && p.season && p.episode) epLabel = `S${p.season}:E${p.episode}`;
    let leftLabel = "";
    if (p.duration && p.timestamp) {
      const min = Math.max(1, Math.ceil((p.duration - p.timestamp) / 60));
      leftLabel = `${min}m left`;
    }
    if (epLabel || leftLabel)
      cwMeta = `<div class="cw-meta"><span class="ep">${epLabel}</span><span class="left">${leftLabel}</span></div>`;
  }
  // Dismiss-X (only on Continue Watching) and progress ring on hover
  const dismissBtn = opts.showProgress
    ? `<button class="cw-dismiss" title="Remove from Continue Watching" aria-label="Dismiss">×</button>`
    : "";
  let progressRing = "";
  if (p?.progress && p.progress > 1 && p.progress < 95 && p.duration && p.timestamp) {
    const pct = Math.min(100, Math.round(p.progress));
    const min = Math.max(1, Math.ceil((p.duration - p.timestamp) / 60));
    const circumference = 2 * Math.PI * 18;
    const offset = circumference - (pct / 100) * circumference;
    progressRing = `<div class="progress-ring" aria-hidden="true">
      <svg viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="18" class="ring-bg"/>
        <circle cx="22" cy="22" r="18" class="ring-fg" style="stroke-dasharray:${circumference};stroke-dashoffset:${offset}"/>
      </svg>
      <span class="ring-label">${min}m</span>
    </div>`;
  }
  thumb.innerHTML = `
    ${watchedBadge}
    ${rewatchBadge}
    ${dismissBtn}
    ${progressRing}
    ${cwMeta}
    ${progressBar}
    <div class="thumb-title-overlay">${escapeHTML(item.title || "")}</div>
    <div class="thumb-actions">
      <button type="button" class="play-mini" aria-label="Play ${escapeHTML(item.title || "")}">▶</button>
      <button type="button" class="add-mini" aria-label="Add ${escapeHTML(item.title || "")} to My List">+</button>
    </div>`;
  const avatarBg = item.poster || item.backdropMd || item.backdrop || "";
  card.innerHTML = `
    <div class="card-info">
      <div class="card-avatar" style="${avatarBg ? `background-image:url('${avatarBg}')` : ""}"></div>
      <div class="card-text">
        <div class="title">${escapeHTML(item.title || "")}</div>
        <div class="row2">
          <span class="match">${pseudoMatch(item)}% match</span>
          <span class="dot">•</span>
          <span class="age-mini">${pseudoAge(item)}</span>
          <span class="dot">•</span>
          <span>${item.year || ""}</span>
        </div>
      </div>
    </div>`;
  card.prepend(thumb);
  makeFocusableActivatable(card, item.title || "Untitled", () => openModal(item));
  if (dismissBtn) {
    card.querySelector(".cw-dismiss").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      dismissedMap[progressKey(item)] = true;
      saveDismissed();
      card.style.transition = "opacity 200ms, transform 200ms";
      card.style.opacity = "0";
      card.style.transform = "scale(0.85)";
      setTimeout(() => card.remove(), 220);
    });
  }
  // Right-click "Not interested"
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (confirm(`Hide "${item.title}" from your home rows?`)) {
      hideItem(item);
      card.style.transition = "opacity 200ms, transform 200ms";
      card.style.opacity = "0";
      card.style.transform = "scale(0.85)";
      setTimeout(() => card.remove(), 220);
      showToast("Hidden");
    }
  });
  card.addEventListener("click", () => openModal(item));
  card.querySelector(".play-mini")?.addEventListener("click", (e) => { e.stopPropagation(); openTitle(item); });
  card.querySelector(".add-mini")?.addEventListener("click", (e) => { e.stopPropagation(); toggleList(item); });

  let hoverTimer;
  card.addEventListener("mouseenter", () => {
    hoverTimer = setTimeout(async () => {
      try {
        const key = await fetchTrailerKey(item);
        if (!key || !card.matches(":hover")) return;
        if (thumb.querySelector(".card-trailer")) return;
        const wrap = document.createElement("div");
        wrap.className = "card-trailer";
        const renderTrailer = () => {
          wrap.innerHTML = `
            <iframe src="${YT_EMBED}${key}?autoplay=1&mute=${cardMuted ? 1 : 0}&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${key}&disablekb=1&vq=hd1080&hd=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}" allow="autoplay; encrypted-media" sandbox="allow-scripts allow-same-origin allow-presentation"></iframe>
            <button type="button" class="card-mute" title="${cardMuted ? "Unmute" : "Mute"}" aria-label="${cardMuted ? "Unmute" : "Mute"}">${cardMuted ? "✕" : "♪"}</button>`;
          const muteBtn = wrap.querySelector(".card-mute");
          muteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            cardMuted = !cardMuted;
            postYTCommand(wrap.querySelector("iframe"), cardMuted ? "mute" : "unMute");
            muteBtn.textContent = cardMuted ? "✕" : "♪";
            muteBtn.title = cardMuted ? "Unmute" : "Mute";
            muteBtn.setAttribute("aria-label", cardMuted ? "Unmute" : "Mute");
          });
        };
        renderTrailer();
        thumb.appendChild(wrap);
      } catch {}
    }, 600);
  });
  card.addEventListener("mouseleave", () => {
    clearTimeout(hoverTimer);
    thumb.querySelector(".card-trailer")?.remove();
  });
  return card;
}

function timeAgo(iso) {
  if (!iso) return "";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d ago`;
  return `${Math.floor(secs / 2592000)}mo ago`;
}
function makeYouTubeCard(item, opts = {}) {
  const card = document.createElement("div");
  card.className = "yt-card";
  if (item.poster) { card.dataset.bg = item.poster; lazyImageObserver.observe(card); }
  const key = progressKey(item);
  const p = progressMap[key];
  let progressBar = "", cwMeta = "", dismissBtn = "";
  if (p?.progress && p.progress > 1 && p.progress < 95) {
    progressBar = `<div class="progress-bar"><div style="width:${Math.min(100, Math.round(p.progress))}%"></div></div>`;
  }
  if (opts.showProgress && p?.progress) {
    let leftLabel = "";
    if (p.duration && p.timestamp) {
      const min = Math.max(1, Math.ceil((p.duration - p.timestamp) / 60));
      leftLabel = `${min}m left`;
    }
    if (leftLabel) cwMeta = `<div class="cw-meta"><span class="ep"></span><span class="left">${leftLabel}</span></div>`;
    dismissBtn = `<button class="cw-dismiss" title="Remove from Continue Watching" aria-label="Dismiss">×</button>`;
  }
  card.innerHTML = `
    ${dismissBtn}
    <div class="yt-play-badge">▶</div>
    ${cwMeta}
    ${progressBar}
    <div class="card-info">
      <div class="row2">${escapeHTML(item.channelTitle || "")} ${item.publishedAt ? `<span class="dot">•</span> ${timeAgo(item.publishedAt)}` : ""}</div>
      <div class="title">${escapeHTML(item.title || "")}</div>
    </div>`;
  card.addEventListener("click", () => openYouTubeLightbox(item));
  makeFocusableActivatable(card, item.title || "Video", () => openYouTubeLightbox(item));
  if (dismissBtn) {
    card.querySelector(".cw-dismiss").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      dismissedMap[key] = true;
      saveDismissed();
      card.style.transition = "opacity 200ms, transform 200ms";
      card.style.opacity = "0";
      card.style.transform = "scale(0.85)";
      setTimeout(() => card.remove(), 220);
    });
  }
  return card;
}

function makeChannelTile(cfg, previewItem) {
  const tile = document.createElement("div");
  tile.className = "yt-channel-tile";
  if (previewItem?.poster) { tile.dataset.bg = previewItem.poster; lazyImageObserver.observe(tile); }
  tile.innerHTML = `
    <div class="yt-channel-tile-overlay">
      <div class="yt-channel-tile-name">${escapeHTML(cfg.label)}</div>
      <div class="yt-channel-tile-cta">Browse & Search →</div>
    </div>`;
  const go = () => navTo(`#/youtube/${cfg.key}`);
  tile.addEventListener("click", go);
  makeFocusableActivatable(tile, `Browse ${cfg.label}`, go);
  return tile;
}
function renderYouTubeChannelTiles(entries) {
  const section = document.createElement("section");
  section.className = "row";
  const head = document.createElement("div");
  head.className = "row-head";
  head.innerHTML = `<h2>Browse by Channel</h2>`;
  section.appendChild(head);
  const wrap = document.createElement("div");
  wrap.className = "yt-channels-grid";
  entries.forEach(({ cfg, items }) => {
    if (!items.length) return;
    wrap.appendChild(makeChannelTile(cfg, items[0]));
  });
  section.appendChild(wrap);
  return section;
}
async function showYouTubeChannelPage(key) {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const cfg = YOUTUBE_CHANNELS.find(c => c.key === key);
  const rows = $("#rows");
  if (!cfg) { rows.innerHTML = `<div class="empty">Unknown channel.</div>`; return; }
  rows.innerHTML = `
    <div class="page-header"><h1>${escapeHTML(cfg.label)}</h1>
      <div class="page-header-actions"><a href="#/" class="page-action-btn">← Home</a></div></div>
    <div class="yt-search-bar">
      <input type="text" id="yt-channel-search" class="yt-search-input" placeholder="Search ${escapeHTML(cfg.label)} videos…" autocomplete="off" />
    </div>
    <div id="yt-channel-grid" class="yt-grid"><div class="empty">Loading…</div></div>`;
  const grid = $("#yt-channel-grid");
  let allVideos = [];
  try {
    const { items } = await fetchYouTubeChannelRow(cfg, 50);
    allVideos = items;
  } catch (e) {
    grid.innerHTML = `<div class="empty">Couldn't load videos: ${escapeHTML(friendlyErrorMessage(e))}</div>`;
    return;
  }
  function renderGrid(list) {
    grid.innerHTML = "";
    if (!list.length) { grid.innerHTML = `<div class="empty">No videos found.</div>`; return; }
    list.forEach(v => grid.appendChild(makeYouTubeCard(v)));
  }
  renderGrid(allVideos);
  $("#yt-channel-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    renderGrid(q ? allVideos.filter(v => (v.title || "").toLowerCase().includes(q)) : allVideos);
  });
}

// ---------- YouTube playback progress tracking ----------
// Loads the real YouTube IFrame Player API (not just a raw <iframe>) so we
// can poll getCurrentTime()/getDuration() the same way the movie/TV player
// reports progress via postMessage, and feed it into the same progressMap
// that powers Continue Watching.
let ytApiPromise = null;
function loadYouTubeIframeAPI() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prevCallback?.();
      resolve(window.YT);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}
let ytLightboxPlayer = null;
let ytLightboxItem = null;
let ytProgressInterval = null;
function saveYouTubeProgress(progress, timestamp, duration) {
  const item = ytLightboxItem;
  if (!item || privacy.pauseProgress) return;
  progressMap[progressKey(item)] = {
    progress, timestamp: timestamp || 0, duration: duration || 0,
    updatedAt: Date.now(),
    title: item.title, poster: item.poster, backdrop: item.poster, backdropMd: item.poster,
    itemType: "youtube", itemId: item.id, channelTitle: item.channelTitle, publishedAt: item.publishedAt,
  };
  saveProgress();
}
function saveYouTubeProgressTick() {
  if (!ytLightboxPlayer || !ytLightboxItem || privacy.pauseProgress) return;
  try {
    const timestamp = ytLightboxPlayer.getCurrentTime();
    const duration = ytLightboxPlayer.getDuration();
    if (!duration) return;
    saveYouTubeProgress(Math.min(100, (timestamp / duration) * 100), timestamp, duration);
  } catch {}
}
function startYouTubeProgressTracking() {
  stopYouTubeProgressTracking();
  ytProgressInterval = setInterval(saveYouTubeProgressTick, 5000);
}
function stopYouTubeProgressTracking() {
  if (ytProgressInterval) { clearInterval(ytProgressInterval); ytProgressInterval = null; }
}
async function openYouTubeLightbox(item) {
  ytLightboxItem = item;
  $("#yt-lightbox-title").textContent = item.title || "";
  $("#yt-lightbox-channel").textContent = item.channelTitle || "";
  $("#yt-lightbox").classList.remove("hidden");
  document.body.style.overflow = "hidden";

  const playerEl = document.createElement("div");
  playerEl.id = "yt-lightbox-player-el";
  const container = $("#yt-lightbox-player");
  container.innerHTML = "";
  container.appendChild(playerEl);

  const last = progressMap[progressKey(item)];
  const startSeconds = last && last.progress < 95 ? Math.floor(last.timestamp || 0) : 0;

  const YTApi = await loadYouTubeIframeAPI();
  if (ytLightboxItem !== item) return; // closed before the API finished loading
  ytLightboxPlayer = new YTApi.Player("yt-lightbox-player-el", {
    videoId: item.id,
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, start: startSeconds },
    events: {
      onStateChange: (e) => {
        if (e.data === YTApi.PlayerState.PLAYING) startYouTubeProgressTracking();
        else stopYouTubeProgressTracking();
        if (e.data === YTApi.PlayerState.ENDED) saveYouTubeProgressTick();
      },
    },
  });
}
function closeYouTubeLightbox() {
  stopYouTubeProgressTracking();
  if (ytLightboxPlayer) {
    try {
      const timestamp = ytLightboxPlayer.getCurrentTime();
      const duration = ytLightboxPlayer.getDuration();
      if (duration) saveYouTubeProgress(Math.min(100, (timestamp / duration) * 100), timestamp, duration);
    } catch {}
    try { ytLightboxPlayer.destroy(); } catch {}
    ytLightboxPlayer = null;
  }
  ytLightboxItem = null;
  $("#yt-lightbox").classList.add("hidden");
  $("#yt-lightbox-player").innerHTML = "";
  document.body.style.overflow = "";
}
$(".yt-lightbox-close").addEventListener("click", closeYouTubeLightbox);
$("#yt-lightbox").addEventListener("click", (e) => { if (e.target.id === "yt-lightbox") closeYouTubeLightbox(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#yt-lightbox").classList.contains("hidden")) closeYouTubeLightbox();
});

function makeTop10Card(item, rank) {
  const card = document.createElement("div");
  card.className = "top10-card";
  const bg = item.poster || item.backdrop;
  card.innerHTML = `
    <div class="top10-number">${rank}</div>
    <div class="top10-poster" style="background-image:url('${bg}')"></div>`;
  card.addEventListener("click", () => openModal(item));
  makeFocusableActivatable(card, `#${rank}: ${item.title || "Untitled"}`, () => openModal(item));
  return card;
}

function renderRow(title, items, opts = {}) {
  const row = document.createElement("section");
  row.className = "row" + (opts.top10 ? " top10" : "");
  // Filter out hidden items unless explicitly showing all
  if (items && !opts.showHidden) {
    items = items.filter(it => it && !isHidden(it));
  }
  row.innerHTML = `<div class="row-head"><h2>${escapeHTML(title)}${opts.subtitle ? ` <span class="row-subtitle">${escapeHTML(opts.subtitle)}</span>` : ""}</h2><div class="row-progress"></div></div><div class="row-wrap"></div>`;
  const wrap = $(".row-wrap", row);
  const progress = $(".row-progress", row);
  if (!items || items.length === 0) {
    wrap.innerHTML = `<div class="empty">Nothing here yet.</div>`;
    return row;
  }
  const scroll = document.createElement("div");
  scroll.className = "row-scroll";
  items.forEach((it, i) => {
    if (!it) return;
    if (opts.top10) {
      const card = makeTop10Card(it, i + 1);
      // Add #1 trending badge
      if (i === 0 && opts.top10Badge) {
        const badge = document.createElement("div");
        badge.className = "top10-badge";
        badge.textContent = `#1 ${opts.top10Badge}`;
        card.appendChild(badge);
      }
      scroll.appendChild(card);
    }
    else if (it.type === "youtube") scroll.appendChild(makeYouTubeCard(it, opts));
    else if (it.poster || it.backdrop) scroll.appendChild(makeCard(it, opts));
  });
  wrap.appendChild(scroll);

  const left = document.createElement("button"); left.className = "row-arrow left"; left.innerHTML = "‹"; left.setAttribute("aria-label", "Scroll left");
  const right = document.createElement("button"); right.className = "row-arrow right"; right.innerHTML = "›"; right.setAttribute("aria-label", "Scroll right");
  left.addEventListener("click", () => scroll.scrollBy({ left: -scroll.clientWidth * 0.85, behavior: "smooth" }));
  right.addEventListener("click", () => scroll.scrollBy({ left: scroll.clientWidth * 0.85, behavior: "smooth" }));
  wrap.appendChild(left); wrap.appendChild(right);

  // Netflix-style row scroll-position dots next to the title
  function updateRowProgress() {
    const dotsCount = Math.min(6, Math.max(1, Math.ceil(scroll.scrollWidth / Math.max(1, scroll.clientWidth))));
    if (dotsCount <= 1) { progress.innerHTML = ""; return; }
    if (progress.children.length !== dotsCount) {
      progress.innerHTML = Array.from({ length: dotsCount }, () => `<span class="row-dot"></span>`).join("");
    }
    const maxScroll = scroll.scrollWidth - scroll.clientWidth;
    const ratio = maxScroll > 0 ? scroll.scrollLeft / maxScroll : 0;
    const active = Math.min(dotsCount - 1, Math.round(ratio * (dotsCount - 1)));
    [...progress.children].forEach((d, i) => d.classList.toggle("active", i === active));
  }
  scroll.addEventListener("scroll", updateRowProgress, { passive: true });
  requestAnimationFrame(updateRowProgress);
  return row;
}

function skeletonRow() {
  const div = document.createElement("div");
  div.className = "skeleton-row";
  div.innerHTML = `<div class="sk-title"></div><div class="sk-cards">${"<div class='sk-card'></div>".repeat(7)}</div>`;
  return div;
}

// ---------- Hero (with auto-trailer) ----------
let heroMuted = true;
let heroItem = null;
let heroFadeTimer = null;
let cardMuted = true;

async function renderHero(item) {
  heroItem = item;
  const bg = $("#hero-bg");
  const trailerEl = $("#hero-trailer");
  if (item.backdrop) preloadImage(item.backdrop);
  bg.style.backgroundImage = item.backdrop ? `url("${item.backdrop}")` : "";
  // Reset then extract dominant color for ambient tint
  applyHeroTint(null);
  if (item.poster) extractDominantColor(item.poster).then(c => { if (heroItem === item) applyHeroTint(c); });
  else if (item.backdrop) extractDominantColor(item.backdrop).then(c => { if (heroItem === item) applyHeroTint(c); });
  trailerEl.innerHTML = "";

  const match = pseudoMatch(item);
  const age = pseudoAge(item);
  $("#hero-age").textContent = age;
  $("#hero-content").innerHTML = `
    <div class="hero-title-slot"><h1>${escapeHTML(item.title)}</h1></div>
    <div class="badges">
      <span class="match">${match}% Match</span>
      ${item.rating ? `<span class="rating-star">★ ${item.rating}</span>` : ""}
      <span>${item.year || ""}</span>
    </div>
    <div class="hero-meta-line" id="hero-meta-line"></div>
    <p>${escapeHTML(item.overview || "")}</p>
    <div class="hero-buttons">
      <button class="btn" id="hero-play">▶ Play</button>
      <button class="btn-secondary" id="hero-info">ⓘ More Info</button>
    </div>`;
  $("#hero-play").addEventListener("click", () => openModal(item));
  $("#hero-info").addEventListener("click", () => openModal(item));

  // Replace H1 with title logo art if available
  fetchTitleLogo(item).then(logo => {
    if (logo && heroItem === item) {
      $("#hero-content .hero-title-slot").innerHTML = `<img class="title-logo" src="${logo}" alt="${escapeHTML(item.title)}" />`;
    }
  });

  // Compact "Type • Genre • Year • Runtime/Seasons • Age" line, Netflix-style
  fetchHeroMetaLine(item).then(parts => {
    if (parts.length && heroItem === item) {
      $("#hero-meta-line").innerHTML = parts.map(escapeHTML).join(' <span class="dot">•</span> ');
    }
  });

  // Try to fetch trailer
  try {
    const key = await fetchTrailerKey(item);
    if (key) {
      const muteParam = heroMuted ? 1 : 0;
      trailerEl.innerHTML = `<iframe src="${YT_EMBED}${key}?autoplay=1&mute=${muteParam}&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${key}&disablekb=1&vq=hd1080&hd=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}" allow="autoplay; encrypted-media" sandbox="allow-scripts allow-same-origin allow-presentation"></iframe>`;
      // The hero trailer is a passive background, not something to click/hover
      // into — this also stops the browser's own hover media controls from
      // ever appearing, since those only show up on actual pointer interaction.
      trailerEl.style.pointerEvents = "none";
      // Let the trailer play a few seconds before easing the title/description
      // out of the way, Netflix-style.
      clearTimeout(heroFadeTimer);
      heroFadeTimer = setTimeout(() => {
        if (heroItem === item) $("#hero-content").classList.add("trailer-active");
      }, 4000);
    }
  } catch {}
}

// "Show • Action • 2026 • 2 Seasons • TV-PG" style compact hero metadata line.
async function fetchHeroMetaLine(item) {
  const typeLabel = item.type === "movie" ? "Movie" : "Show";
  const parts = [typeLabel];
  try {
    const details = await tmdb(`/${item.type}/${item.id}`);
    if (details.genres?.[0]?.name) parts.push(details.genres[0].name);
    if (item.year) parts.push(String(item.year));
    if (item.type === "movie" && details.runtime) parts.push(`${details.runtime}m`);
    else if (item.type === "tv" && details.number_of_seasons) parts.push(`${details.number_of_seasons} Season${details.number_of_seasons > 1 ? "s" : ""}`);
    parts.push(pseudoAge(item));
    return parts;
  } catch { return []; }
}

async function fetchTitleLogo(item) {
  try {
    const path = item.type === "tv" ? `/tv/${item.id}/images` : `/movie/${item.id}/images`;
    // override include_image_language so we actually get logos
    const url = new URL(TMDB + path);
    url.searchParams.set("api_key", TMDB_API_KEY);
    url.searchParams.set("include_image_language", "en,null");
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const logos = (data.logos || []).filter(l => l.iso_639_1 === "en" || l.iso_639_1 === null);
    if (!logos.length) return null;
    // Prefer PNG, then highest voted
    logos.sort((a, b) => {
      const af = a.file_path.endsWith(".png") ? 1 : 0;
      const bf = b.file_path.endsWith(".png") ? 1 : 0;
      if (af !== bf) return bf - af;
      return (b.vote_average || 0) - (a.vote_average || 0);
    });
    return `${IMG}/w500${logos[0].file_path}`;
  } catch { return null; }
}

async function fetchTrailerKey(item) {
  const path = item.type === "tv" ? `/tv/${item.id}/videos` : `/movie/${item.id}/videos`;
  const data = await tmdb(path);
  const trailer = data.results.find(v => v.site === "YouTube" && v.type === "Trailer") ||
                  data.results.find(v => v.site === "YouTube");
  return trailer?.key;
}

$("#mute-btn").addEventListener("click", () => {
  heroMuted = !heroMuted;
  $("#mute-btn").textContent = heroMuted ? "✕" : "♪";
  $("#mute-btn").setAttribute("aria-label", heroMuted ? "Unmute" : "Mute");
  postYTCommand($("#hero-trailer iframe"), heroMuted ? "mute" : "unMute");
});

function stopHeroTrailer() {
  $("#hero-trailer").innerHTML = "";
  heroItem = null;
  clearTimeout(heroFadeTimer);
}

// Pause hero audio when scrolled out of view
const heroObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!heroItem) return;
    const iframe = $("#hero-trailer iframe");
    if (!iframe) return;
    if (!e.isIntersecting) {
      iframe.dataset.src = iframe.src;
      iframe.src = "";
    } else if (iframe.dataset.src && !iframe.src) {
      iframe.src = iframe.dataset.src;
    }
  });
}, { threshold: 0.2 });
heroObserver.observe($("#hero"));

// ---------- Chip feed (YouTube-style: filter chips over one flat grid) ----------
// Reused by the Home, Movies/TV, and New & Popular pages so each one gets
// the same "sticky chips + wrapping video grid" structure instead of
// Netflix-style horizontal shelves.
function makeChipFeed(rowsEl) {
  let categories = [];
  let activeChip = "all";
  function render() {
    if (!rowsEl.querySelector(".home-grid")) {
      rowsEl.innerHTML = `<div class="home-chips"></div><div class="home-grid"></div>`;
    }
    const chipsEl = rowsEl.querySelector(".home-chips");
    chipsEl.innerHTML = `<button class="chip ${activeChip === "all" ? "active" : ""}" data-chip="all">All</button>` +
      categories.map(c => `<button class="chip ${activeChip === c.key ? "active" : ""}" data-chip="${c.key}">${escapeHTML(c.label)}</button>`).join("");
    chipsEl.querySelectorAll(".chip").forEach(btn => {
      btn.addEventListener("click", () => { activeChip = btn.dataset.chip; render(); });
    });
    let items;
    if (activeChip === "all") {
      const seen = new Set();
      items = [];
      categories.forEach(c => c.items.forEach(it => {
        const k = (it.type || "youtube") + ":" + it.id;
        if (seen.has(k)) return;
        seen.add(k);
        items.push(it);
      }));
    } else {
      items = categories.find(c => c.key === activeChip)?.items || [];
    }
    const grid = rowsEl.querySelector(".home-grid");
    grid.innerHTML = "";
    if (!items.length) { grid.innerHTML = `<div class="empty">Nothing here yet.</div>`; return; }
    items.forEach(it => {
      grid.appendChild(it.type === "youtube" ? makeYouTubeCard(it) : makeCard(it, { showProgress: it.__cw }));
    });
  }
  return {
    add(key, label, items, cwFlag) {
      if (!items || !items.length) return;
      if (cwFlag) items.forEach(it => { it.__cw = true; });
      categories.push({ key, label, items });
      render();
    },
  };
}
async function showHome() {
  setActive("home");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="home-chips"></div><div class="home-grid"></div>`;
  rows.querySelector(".home-grid").innerHTML = Array.from({ length: 8 }, () => `<div class="grid-sk"></div>`).join("");
  const feed = makeChipFeed(rows);
  try {
    const regionParam = { region: userRegion };
    const [trending, popMovies, popTV, topMovies, trendingDay] = await Promise.all([
      tmdb("/trending/all/week"),
      tmdb("/movie/popular", regionParam),
      tmdb("/tv/popular"),
      tmdb("/movie/top_rated"),
      tmdb("/trending/all/day"),
    ]);
    const trendingItems = trending.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r));
    const heroPick = trendingItems.find(t => t.backdrop && t.overview) || trendingItems[0];
    renderHero(heroPick);

    feed.add("continue", "Continue Watching", getContinueWatching(), true);
    feed.add("mylist", "My List", myList);
    feed.add("trending", "Trending Now", trendingItems);
    feed.add("top10", `Top 10 in ${userRegion}`, trendingDay.results.slice(0, 10).map(r => normalizeTMDB(r)));
    feed.add("popmovies", "Popular Movies", popMovies.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie")));
    feed.add("poptv", "Popular TV Shows", popTV.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "tv")));
    feed.add("acclaimed", "Critically Acclaimed", topMovies.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie")));

    // Recommended for You: one blended, scored set from all your seeds
    getRecommendedForYou().then(items => feed.add("recommended", "Recommended for You", items)).catch(() => {});

    // Then the named "Because you watched X" breakdowns per seed
    getNamedRecommendations().then(namedRows => {
      namedRows.forEach(({ label, items }, i) => feed.add(`rec_${i}`, label, items));
    }).catch(() => {});

    // YouTube channel content (fire-and-forget, same pattern as the recommendation rows above)
    if (YOUTUBE_API_KEY) {
      Promise.all(YOUTUBE_CHANNELS.map(cfg => fetchYouTubeChannelRow(cfg).catch(() => ({ label: cfg.label, items: [] }))))
        .then(results => {
          results.forEach(({ label, items }, i) => feed.add(`yt_${YOUTUBE_CHANNELS[i].key}`, label, items));
        }).catch(() => {});
    }

    // Genre categories (lazy after main content)
    for (const g of GENRES_MOVIE.slice(0, 5)) {
      const data = await tmdb("/discover/movie", { with_genres: g.id, sort_by: "popularity.desc" });
      feed.add(`genre_${g.id}`, g.name, data.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie")));
    }
  } catch (e) {
    rows.innerHTML = `<div class="empty">${escapeHTML(friendlyErrorMessage(e))}</div>`;
  }
}

// ===== "Because you watched X" - named recommendation rows =====
async function getNamedRecommendations() {
  // Get top 2 most-recent watched/finished show + 1 from My List as seeds
  const seeds = [];
  const seenSeed = new Set();
  const cw = getContinueWatching().slice(0, 2);
  cw.forEach(it => {
    const k = itemKey(it);
    if (!seenSeed.has(k) && it.type !== "youtube") { seenSeed.add(k); seeds.push(it); }
  });
  // Add one from My List
  const fromList = myList.find(it => !seenSeed.has(itemKey(it)) && it.type !== "youtube");
  if (fromList) { seenSeed.add(itemKey(fromList)); seeds.push(fromList); }
  if (!seeds.length) return [];

  const out = [];
  for (const s of seeds.slice(0, 3)) {
    try {
      const data = await tmdb(`/${s.type}/${s.id}/recommendations`);
      const items = data.results.filter(r => r.backdrop_path && r.poster_path && !seenSeed.has(`${s.type}:${r.id}`))
        .slice(0, 18).map(r => normalizeTMDB(r, s.type));
      if (items.length) out.push({
        label: `Because you watched ${s.title}`,
        items,
      });
    } catch {}
  }
  return out;
}

let currentCategoryType = null;
let currentGenreId = null;

async function showCategory(type, genreId = null) {
  setActive(type);
  stopHeroTrailer();
  currentCategoryType = type;
  currentGenreId = genreId;
  const rows = $("#rows");
  rows.innerHTML = ""; for (let i = 0; i < 3; i++) rows.appendChild(skeletonRow());
  try {
    // Genre filter mode: show grid of that genre only
    if (genreId) {
      const data = await tmdb(`/discover/${type}`, { with_genres: genreId, sort_by: "popularity.desc" });
      const items = data.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type));
      renderHero(items.find(i => i.backdrop) || items[0]);
      rows.innerHTML = "";
      rows.appendChild(renderGenreChips(type, genreId));
      const grid = document.createElement("div");
      grid.className = "home-grid";
      items.forEach(it => grid.appendChild(makeCard(it)));
      rows.appendChild(grid);
      return;
    }
    const [popular, topRated, nowOrAir, trending] = await Promise.all([
      tmdb(`/${type}/popular`),
      tmdb(`/${type}/top_rated`),
      tmdb(type === "movie" ? "/movie/now_playing" : "/tv/on_the_air"),
      tmdb(`/trending/${type}/week`),
    ]);
    const trendItems = trending.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type));
    renderHero(trendItems.find(i => i.backdrop) || trendItems[0]);
    rows.innerHTML = "";
    rows.appendChild(renderGenreChips(type, null));
    const feedWrap = document.createElement("div");
    rows.appendChild(feedWrap);
    const feed = makeChipFeed(feedWrap);
    feed.add("trending", "Trending This Week", trendItems);
    feed.add("top10", "Top 10 in " + (type === "tv" ? "TV" : "Movies"), trendItems.slice(0, 10));
    feed.add("nowplaying", type === "movie" ? "Now Playing" : "Currently Airing", nowOrAir.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type)));
    feed.add("popular", "Popular", popular.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type)));
    feed.add("toprated", "Top Rated", topRated.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type)));
  } catch (e) {
    rows.innerHTML = `<div class="empty">${escapeHTML(friendlyErrorMessage(e))}</div>`;
  }
}

async function showNewPopular() {
  setActive("new");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = ""; for (let i = 0; i < 3; i++) rows.appendChild(skeletonRow());
  try {
    const [upMovies, upTV, trending, latestMovies] = await Promise.all([
      tmdb("/movie/upcoming"),
      tmdb("/tv/airing_today"),
      tmdb("/trending/all/day"),
      tmdb("/discover/movie", { sort_by: "primary_release_date.desc", "primary_release_date.lte": new Date().toISOString().slice(0,10), "vote_count.gte": 50 }),
    ]);
    const trendItems = trending.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r));
    renderHero(trendItems.find(i => i.backdrop) || trendItems[0]);
    rows.innerHTML = `<div class="home-chips"></div><div class="home-grid"></div>`;
    const feed = makeChipFeed(rows);
    feed.add("trending", "Trending Today", trendItems);
    feed.add("top10", "Top 10 Today", trendItems.slice(0, 10));
    feed.add("comingsoon", "Coming Soon (Movies)", upMovies.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie")));
    feed.add("airing", "Airing Today (TV)", upTV.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "tv")));
    feed.add("newlyreleased", "Newly Released", latestMovies.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie")));
  } catch (e) { rows.innerHTML = `<div class="empty">${escapeHTML(friendlyErrorMessage(e))}</div>`; }
}

async function showPerson(personId) {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const [person, credits] = await Promise.all([
      tmdb(`/person/${personId}`),
      tmdb(`/person/${personId}/combined_credits`),
    ]);
    const photo = person.profile_path ? `${IMG}/w300${person.profile_path}` : "";
    const works = (credits.cast || [])
      .filter(c =>
        c.poster_path && c.backdrop_path &&
        (c.media_type === "movie" || c.media_type === "tv") &&
        (c.vote_count || 0) >= 50
      )
      // De-dup: same person can appear multiple times in a TV series
      .filter((c, i, arr) => arr.findIndex(x => x.id === c.id && x.media_type === c.media_type) === i)
      .map(c => ({
        ...normalizeTMDB({
          id: c.id, media_type: c.media_type,
          title: c.title, name: c.name,
          poster_path: c.poster_path, backdrop_path: c.backdrop_path,
          overview: c.overview,
          release_date: c.release_date, first_air_date: c.first_air_date,
          vote_average: c.vote_average, vote_count: c.vote_count,
        }, c.media_type),
        character: c.character,
        popularity: c.popularity || 0,
        voteCount: c.vote_count || 0,
      }))
      .sort((a, b) => b.popularity - a.popularity);

    rows.innerHTML = "";
    const header = document.createElement("div");
    header.className = "person-header";
    const dob = person.birthday ? new Date(person.birthday).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
    const age = person.birthday && !person.deathday
      ? Math.floor((Date.now() - new Date(person.birthday)) / (365.25 * 24 * 3600 * 1000))
      : null;
    header.innerHTML = `
      <div class="person-photo" style="background-image:url('${photo}')"></div>
      <div class="person-info">
        <div class="person-eyebrow">${escapeHTML(person.known_for_department || "Cast")}</div>
        <h1>${escapeHTML(person.name)}</h1>
        <div class="person-meta">
          ${dob ? `<span>${dob}${age ? ` (age ${age})` : ""}</span>` : ""}
          ${person.place_of_birth ? `<span>${escapeHTML(person.place_of_birth)}</span>` : ""}
          <span>${works.length} title${works.length === 1 ? "" : "s"}</span>
        </div>
        ${person.biography ? `<p class="person-bio">${escapeHTML(person.biography)}</p>` : ""}
      </div>`;
    rows.appendChild(header);

    if (!works.length) {
      rows.innerHTML += `<div class="empty">No titles found.</div>`;
      return;
    }
    const sub = document.createElement("div");
    sub.className = "page-subheader";
    sub.innerHTML = `<h2>Known For</h2>`;
    rows.appendChild(sub);

    const grid = document.createElement("div");
    grid.className = "search-grid";
    works.forEach(it => {
      const cell = document.createElement("div"); cell.className = "search-cell";
      cell.appendChild(makeCard(it));
      const meta = document.createElement("div"); meta.className = "search-meta";
      meta.innerHTML = `<span class="type-pill">${typeLabel(it)}</span>${it.rating ? `<span class="rating-star">★ ${it.rating}</span>` : ""}<span>${it.year || ""}</span>`;
      const title = document.createElement("div"); title.className = "search-title";
      title.textContent = it.title;
      cell.appendChild(title); cell.appendChild(meta);
      if (it.character) {
        const chr = document.createElement("div");
        chr.className = "search-character";
        chr.textContent = `as ${it.character}`;
        cell.appendChild(chr);
      }
      grid.appendChild(cell);
    });
    rows.appendChild(grid);
  } catch (e) {
    rows.innerHTML = `<div class="empty">${escapeHTML(friendlyErrorMessage(e))}</div>`;
  }
}

function showHistory() {
  setActive("history");
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  const entries = Object.entries(progressMap)
    .filter(([, v]) => v.title)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  rows.innerHTML = `<div class="page-header"><h1>Viewing Activity</h1></div>`;
  if (!entries.length) {
    rows.innerHTML += `
      <div class="empty-state">
        <div class="empty-icon">—</div>
        <h2>No history yet</h2>
        <p>Anything you watch will be tracked here so you can pick up where you left off.</p>
      </div>`;
    return;
  }
  // Stats
  const totalSeconds = entries.reduce((acc, [, v]) => acc + (hasEpisodeTracking(v) ? 0 : (v.timestamp || 0)), 0) +
    Object.values(progressMap).filter(v => v.isEpisode).reduce((a, v) => a + (v.timestamp || 0), 0);
  const totalMinutes = Math.round(totalSeconds / 60);
  const inProgress = entries.filter(([, v]) => v.progress > 1 && v.progress < 95).length;
  const finished = entries.filter(([, v]) => v.progress >= 95).length;
  const stats = document.createElement("div");
  stats.className = "history-stats";
  stats.innerHTML = `
    <div class="history-stat"><div class="stat-num">${entries.length}</div><div class="stat-label">Titles</div></div>
    <div class="history-stat"><div class="stat-num">${inProgress}</div><div class="stat-label">In Progress</div></div>
    <div class="history-stat"><div class="stat-num">${finished}</div><div class="stat-label">Finished</div></div>
    <div class="history-stat"><div class="stat-num">${totalMinutes < 60 ? totalMinutes + "m" : Math.round(totalMinutes / 60) + "h"}</div><div class="stat-label">Watched</div></div>`;
  rows.appendChild(stats);

  // Group by time bucket
  const now = Date.now();
  const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
  const startOfYesterday = startOfToday.getTime() - 86400000;
  const sevenDaysAgo = now - 7 * 86400000;
  const thirtyDaysAgo = now - 30 * 86400000;
  const buckets = { "Today": [], "Yesterday": [], "This Week": [], "This Month": [], "Older": [] };
  entries.forEach(e => {
    const ts = e[1].updatedAt || 0;
    if (ts >= startOfToday.getTime()) buckets["Today"].push(e);
    else if (ts >= startOfYesterday) buckets["Yesterday"].push(e);
    else if (ts >= sevenDaysAgo) buckets["This Week"].push(e);
    else if (ts >= thirtyDaysAgo) buckets["This Month"].push(e);
    else buckets["Older"].push(e);
  });

  Object.entries(buckets).forEach(([label, items]) => {
    if (!items.length) return;
    const groupLabel = document.createElement("div");
    groupLabel.className = "history-group-label";
    groupLabel.innerHTML = `<h2>${label}</h2><span class="group-count">${items.length} ${items.length === 1 ? "title" : "titles"}</span>`;
    rows.appendChild(groupLabel);
    const grid = document.createElement("div");
    grid.className = "history-grid";
    renderHistoryGroup(grid, items);
    rows.appendChild(grid);
  });
}

function renderHistoryGroup(grid, entries) {
  entries.forEach(([key, v]) => {
    const item = {
      id: v.itemId, type: v.itemType, title: v.title,
      poster: v.poster, backdrop: v.backdrop, backdropMd: v.backdropMd,
      overview: v.overview, year: v.year, rating: v.rating,
      isMovie: v.isMovie, episodes: v.episodes,
    };
    const row = document.createElement("div");
    row.className = "history-row";
    const thumbBg = v.backdropMd || v.backdrop || v.poster || "";
    const pct = Math.min(100, Math.round(v.progress || 0));
    const finishedLabel = v.progress >= 95 ? "Finished" : (pct + "% watched");
    let epLabel = "";
    if (v.itemType === "tv" && v.season && v.episode) epLabel = `S${v.season} · E${v.episode}`;
    else if (v.itemType === "movie") epLabel = "Movie";
    let leftLabel = "";
    if (v.duration && v.timestamp && v.progress < 95) {
      const min = Math.max(1, Math.ceil((v.duration - v.timestamp) / 60));
      leftLabel = ` · ${min}m left`;
    }
    const when = v.updatedAt ? humanWhen(v.updatedAt) : "";
    row.innerHTML = `
      <div class="history-thumb" style="background-image:url('${thumbBg}')">
        <div class="play-glyph">▶</div>
        <div class="ep-progress"><div style="width:${pct}%"></div></div>
      </div>
      <div class="history-info">
        <h3>${escapeHTML(v.title)}</h3>
        <div class="h-sub">${epLabel}${leftLabel} · ${finishedLabel}</div>
        <div class="h-when">${when}</div>
        <div class="h-actions">
          <button class="resume">${v.progress >= 95 ? "▶ Watch Again" : "▶ Resume"}</button>
          <button class="info">Details</button>
          <button class="markwatched">${v.progress >= 95 ? "Unmark" : "Mark Watched"}</button>
          <button class="remove">Remove</button>
        </div>
      </div>`;
    row.querySelector(".history-thumb").addEventListener("click", () => openTitle(item));
    row.querySelector(".resume").addEventListener("click", () => openTitle(item));
    row.querySelector(".info").addEventListener("click", () => openTitle(item));
    row.querySelector(".markwatched").addEventListener("click", () => {
      if (progressMap[key].progress >= 95) {
        progressMap[key].progress = 5; progressMap[key].timestamp = 30;
      } else {
        progressMap[key].progress = 100;
        progressMap[key].timestamp = progressMap[key].duration || 0;
      }
      progressMap[key].updatedAt = Date.now();
      saveProgress();
      showHistory();
    });
    row.querySelector(".remove").addEventListener("click", () => {
      delete progressMap[key];
      saveProgress();
      showToast("Removed from history");
      showHistory();
    });
    grid.appendChild(row);
  });
}

// ============== MOOD PAGE ==============
// ============== HIDDEN TITLES PAGE ==============
function showHiddenTitles() {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="page-header"><h1>Hidden Titles</h1>
    <div class="page-header-actions"><a href="#/" class="page-action-btn">← Home</a></div></div>`;
  const keys = Object.keys(hiddenMap);
  if (!keys.length) {
    rows.innerHTML += `<div class="empty-state"><div class="empty-icon">—</div><h2>Nothing hidden</h2><p>Use "Not interested" on cards to hide titles from your home rows.</p></div>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "search-grid";
  keys.forEach(k => {
    const [type, id] = k.split(":");
    const v = progressMap[k];
    const item = v ? { id: +id, type, title: v.title, poster: v.poster, backdrop: v.backdrop, backdropMd: v.backdropMd, year: v.year, rating: v.rating } : { id: +id, type, title: "(Hidden title)" };
    const cell = document.createElement("div"); cell.className = "search-cell";
    cell.appendChild(makeCard(item, { showHidden: true }));
    const title = document.createElement("div"); title.className = "search-title";
    title.textContent = item.title;
    const unhideBtn = document.createElement("button");
    unhideBtn.className = "btn-secondary"; unhideBtn.textContent = "Unhide";
    unhideBtn.style.marginTop = "8px"; unhideBtn.style.fontSize = "12px"; unhideBtn.style.padding = "4px 12px";
    unhideBtn.addEventListener("click", () => { unhideItem(item); showHiddenTitles(); });
    cell.appendChild(title); cell.appendChild(unhideBtn);
    grid.appendChild(cell);
  });
  rows.appendChild(grid);
}

// ============== TAG PAGE ==============
async function showByTag(tag) {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="page-header"><h1>${escapeHTML(tag)}</h1>
    <div class="page-header-actions"><a href="#/" class="page-action-btn">← Home</a></div></div>`;
  const keys = Object.keys(tagsMap).filter(k => (tagsMap[k] || []).includes(tag));
  if (!keys.length) {
    rows.innerHTML += `<div class="empty-state"><div class="empty-icon">—</div><h2>No titles tagged "${escapeHTML(tag)}"</h2></div>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "search-grid";
  keys.forEach(k => {
    const [type, id] = k.split(":");
    const v = progressMap[k] || myList.find(m => itemKey(m) === k);
    if (!v) return;
    const item = v.title ? { id: v.itemId || v.id || +id, type: v.itemType || type, title: v.title, poster: v.poster, backdrop: v.backdrop, backdropMd: v.backdropMd, year: v.year, rating: v.rating } : v;
    const cell = document.createElement("div"); cell.className = "search-cell";
    cell.appendChild(makeCard(item));
    const title = document.createElement("div"); title.className = "search-title";
    title.textContent = item.title;
    cell.appendChild(title);
    grid.appendChild(cell);
  });
  rows.appendChild(grid);
}

// ============== BUDGET GAUGE ==============
function renderBudgetGauge() {
  document.querySelectorAll(".budget-gauge-fab").forEach(n => n.remove());
  if (!monthlyGoal) return;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const secs = Object.values(progressMap).filter(v => (v.updatedAt || 0) >= monthStart.getTime()).reduce((a, v) => a + (v.timestamp || 0), 0);
  const hours = secs / 3600;
  const pct = Math.min(100, Math.round((hours / monthlyGoal.hours) * 100));
  const fab = document.createElement("div");
  fab.className = "budget-gauge-fab";
  fab.innerHTML = `
    <div class="bg-ring">
      <svg viewBox="0 0 60 60">
        <circle cx="30" cy="30" r="26" class="bg-ring-bg"/>
        <circle cx="30" cy="30" r="26" class="bg-ring-fg" style="stroke-dasharray:${2*Math.PI*26};stroke-dashoffset:${(2*Math.PI*26) - ((pct/100)*(2*Math.PI*26))}"/>
      </svg>
      <div class="bg-pct">${pct}%</div>
    </div>
    <div class="bg-text">
      <div class="bg-num">${hours.toFixed(1)}h / ${monthlyGoal.hours}h</div>
      <div class="bg-label">${pct >= 100 ? "Goal reached!" : "this month"}</div>
    </div>`;
  fab.addEventListener("click", () => navTo("#/stats"));
  document.body.appendChild(fab);
}

// ============== LIBRARY (smart status tabs) ==============
function showLibrary(tab) {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  // Bucket every known item by computed status
  const buckets = { watching: [], completed: [], plan: [], dropped: [], rewatching: [] };
  const seen = new Set();
  // From progressMap
  Object.entries(progressMap).filter(([, v]) => v.title).forEach(([k, v]) => {
    seen.add(k);
    const item = { id: v.itemId, type: v.itemType, title: v.title, poster: v.poster, backdrop: v.backdrop, backdropMd: v.backdropMd, year: v.year, rating: v.rating, isMovie: v.isMovie, episodes: v.episodes };
    const status = computeStatus(item);
    if (buckets[status]) buckets[status].push({ item, v });
  });
  // From myList that aren't in progress
  myList.forEach(item => {
    const k = itemKey(item);
    if (seen.has(k)) return;
    const status = computeStatus(item);
    if (buckets[status]) buckets[status].push({ item, v: null });
  });

  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  const tabs = [
    { id: "watching",   icon: "▶",  label: "Currently Watching", count: counts.watching },
    { id: "rewatching", icon: "↻",  label: "Rewatching",         count: counts.rewatching },
    { id: "plan",       icon: "▷",  label: "Plan to Watch",       count: counts.plan },
    { id: "completed",  icon: "✓",  label: "Completed",           count: counts.completed },
    { id: "dropped",    icon: "✕",  label: "Dropped",             count: counts.dropped },
  ];
  rows.innerHTML = `<div class="page-header"><h1>Your Library</h1>
    <div class="page-header-actions">
      <a href="#/achievements" class="page-action-btn">Achievements</a>
      <a href="#/stats" class="page-action-btn">Stats</a>
      <a href="#/privacy" class="page-action-btn">Privacy</a>
    </div></div>
    <div class="library-tabs">
      ${tabs.map(t => `<a href="#/library/${t.id}" class="lib-tab${t.id === tab ? " active" : ""}">
        <span class="lib-tab-icon">${t.icon}</span>
        <span class="lib-tab-label">${t.label}</span>
        <span class="lib-tab-count">${t.count}</span>
      </a>`).join("")}
    </div>`;
  const list = buckets[tab] || [];
  if (!list.length) {
    const emptyMsg = {
      watching:   { icon: "▶",  msg: "Nothing in progress. Start a movie or show to see it here." },
      rewatching: { icon: "↻",  msg: "No rewatches yet. Restart a finished title to track it." },
      plan:       { icon: "▷",  msg: "Your plan-to-watch list is empty. Add titles via My List." },
      completed:  { icon: "✓",  msg: "No completed titles yet. Finish something to see it here." },
      dropped:    { icon: "✕",  msg: "Nothing dropped. Titles abandoned for 14+ days appear here." },
    }[tab] || { icon: "?", msg: "Empty." };
    rows.innerHTML += `<div class="empty-state"><div class="empty-icon">${emptyMsg.icon}</div><h2>Nothing here</h2><p>${escapeHTML(emptyMsg.msg)}</p></div>`;
    return;
  }
  // Sort by recency
  list.sort((a, b) => (b.v?.updatedAt || 0) - (a.v?.updatedAt || 0));
  const grid = document.createElement("div");
  grid.className = "search-grid";
  list.forEach(({ item, v }) => {
    const cell = document.createElement("div");
    cell.className = "search-cell library-cell";
    cell.appendChild(makeCard(item, { showProgress: tab === "watching" }));
    const meta = document.createElement("div");
    meta.className = "search-meta";
    let label = typeLabel(item);
    if (v?.season && v?.episode) label += ` · S${v.season}E${v.episode}`;
    meta.innerHTML = `<span class="type-pill">${label}</span><span>${item.year || ""}</span>`;
    const title = document.createElement("div");
    title.className = "search-title";
    title.textContent = item.title;
    cell.appendChild(title); cell.appendChild(meta);
    // Quick actions row
    const actions = document.createElement("div");
    actions.className = "lib-actions";
    if (tab === "watching") {
      actions.innerHTML = `<button class="lib-act drop">Mark Dropped</button><button class="lib-act done">Mark Done</button>`;
      actions.querySelector(".drop").addEventListener("click", (e) => { e.stopPropagation(); setStatusOverride(item, "dropped"); showLibrary(tab); showToast("Marked as dropped"); });
      actions.querySelector(".done").addEventListener("click", (e) => { e.stopPropagation(); markFinished(item); showLibrary(tab); });
    } else if (tab === "dropped") {
      actions.innerHTML = `<button class="lib-act resume">Resume</button><button class="lib-act remove">Remove</button>`;
      actions.querySelector(".resume").addEventListener("click", (e) => { e.stopPropagation(); setStatusOverride(item, null); navTo(`#/title/${item.type}/${item.id}`); });
      actions.querySelector(".remove").addEventListener("click", (e) => { e.stopPropagation(); delete progressMap[itemKey(item)]; saveProgress(); showLibrary(tab); });
    } else if (tab === "plan") {
      actions.innerHTML = `<button class="lib-act resume">Watch Now</button><button class="lib-act remove">Remove</button>`;
      actions.querySelector(".resume").addEventListener("click", (e) => { e.stopPropagation(); navTo(`#/title/${item.type}/${item.id}`); });
      actions.querySelector(".remove").addEventListener("click", (e) => { e.stopPropagation(); myList = myList.filter(m => itemKey(m) !== itemKey(item)); saveMyList(); showLibrary(tab); });
    } else if (tab === "completed") {
      actions.innerHTML = `<button class="lib-act resume">Rewatch</button><button class="lib-act unmark">Unmark</button>`;
      actions.querySelector(".resume").addEventListener("click", (e) => { e.stopPropagation(); navTo(`#/title/${item.type}/${item.id}`); });
      actions.querySelector(".unmark").addEventListener("click", (e) => { e.stopPropagation();
        if (progressMap[itemKey(item)]) { progressMap[itemKey(item)].progress = 50; saveProgress(); }
        showLibrary(tab);
      });
    } else if (tab === "rewatching") {
      actions.innerHTML = `<button class="lib-act resume">Continue</button>`;
      actions.querySelector(".resume").addEventListener("click", (e) => { e.stopPropagation(); navTo(`#/title/${item.type}/${item.id}`); });
    }
    cell.appendChild(actions);
    grid.appendChild(cell);
  });
  rows.appendChild(grid);
}

function markFinished(item) {
  const k = itemKey(item);
  if (!progressMap[k]) {
    progressMap[k] = {
      itemId: item.id, itemType: item.type, title: item.title,
      poster: item.poster, backdrop: item.backdrop, backdropMd: item.backdropMd,
      year: item.year, rating: item.rating,
    };
  }
  progressMap[k].progress = 100;
  progressMap[k].timestamp = progressMap[k].duration || 0;
  progressMap[k].updatedAt = Date.now();
  saveProgress();
  setStatusOverride(item, null);
  showToast("Marked complete");
  checkAchievements();
}

// ============== ACHIEVEMENTS PAGE ==============
function showAchievements() {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  const stats = computeAchievementStats();
  const unlocked = ACHIEVEMENTS.filter(a => achievements[a.id]);
  const locked = ACHIEVEMENTS.filter(a => !achievements[a.id]);
  rows.innerHTML = `<div class="page-header"><h1>Achievements</h1>
    <div class="page-header-actions"><a href="#/library/watching" class="page-action-btn">← Library</a></div></div>
    <div class="ach-summary">
      <div class="ach-summary-num">${unlocked.length}<span>/${ACHIEVEMENTS.length}</span></div>
      <div class="ach-summary-label">unlocked</div>
      <div class="ach-summary-bar"><div style="width:${(unlocked.length / ACHIEVEMENTS.length) * 100}%"></div></div>
    </div>`;
  const grid = document.createElement("div");
  grid.className = "ach-grid";
  // Unlocked first
  [...unlocked, ...locked].forEach(a => {
    const card = document.createElement("div");
    const isLocked = !achievements[a.id];
    card.className = "ach-card" + (isLocked ? " locked" : "");
    const unlockedDate = achievements[a.id] ? humanWhen(achievements[a.id]) : "";
    card.innerHTML = `
      <div class="ach-card-icon">${isLocked ? "—" : a.icon}</div>
      <div class="ach-card-title">${escapeHTML(a.title)}</div>
      <div class="ach-card-desc">${escapeHTML(a.desc)}</div>
      ${isLocked ? "" : `<div class="ach-card-date">Unlocked ${unlockedDate}</div>`}`;
    grid.appendChild(card);
  });
  rows.appendChild(grid);
}

// ============== PRIVACY PAGE ==============
function showPrivacy() {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="page-header"><h1>Privacy & Data</h1>
    <div class="page-header-actions"><a href="#/library/watching" class="page-action-btn">← Library</a></div></div>
    <div class="privacy-section">
      <h2>Tracking Controls</h2>
      <p class="privacy-help">Pause any tracker. Past data is preserved; new data won't be recorded while paused.</p>
      <div class="privacy-toggle">
        <div>
          <div class="pt-title">Progress tracking</div>
          <div class="pt-desc">Save where you left off in titles you watch</div>
        </div>
        <label class="toggle"><input type="checkbox" id="t-progress" ${!privacy.pauseProgress ? "checked" : ""}/><span class="toggle-slider"></span></label>
      </div>
      <div class="privacy-toggle">
        <div>
          <div class="pt-title">Session tracking</div>
          <div class="pt-desc">Record viewing sessions for time-of-day insights</div>
        </div>
        <label class="toggle"><input type="checkbox" id="t-session" ${!privacy.pauseSession ? "checked" : ""}/><span class="toggle-slider"></span></label>
      </div>
      <div class="privacy-toggle">
        <div>
          <div class="pt-title">History entries</div>
          <div class="pt-desc">Add new titles to your watch history</div>
        </div>
        <label class="toggle"><input type="checkbox" id="t-history" ${!privacy.pauseHistory ? "checked" : ""}/><span class="toggle-slider"></span></label>
      </div>
    </div>
    <div class="privacy-section">
      <h2>Edit History</h2>
      <p class="privacy-help">Remove individual titles or fully forget them (clears progress + tags + journal + ratings).</p>
      <div id="privacy-history-list" class="privacy-history"></div>
    </div>
    <div class="privacy-section">
      <h2>Bulk Actions</h2>
      <div class="privacy-bulk">
        <button class="btn-secondary" id="p-export">Export All Data</button>
        <button class="btn-secondary" id="p-wipe-history">Clear History Only</button>
        <button class="btn-secondary danger" id="p-wipe-all">Wipe Everything</button>
      </div>
    </div>`;
  // Wire toggles
  $("#t-progress").addEventListener("change", (e) => { privacy.pauseProgress = !e.target.checked; savePrivacy(); showToast(privacy.pauseProgress ? "Progress tracking paused" : "Progress tracking on"); });
  $("#t-session").addEventListener("change", (e) => { privacy.pauseSession = !e.target.checked; savePrivacy(); showToast(privacy.pauseSession ? "Session tracking paused" : "Session tracking on"); });
  $("#t-history").addEventListener("change", (e) => { privacy.pauseHistory = !e.target.checked; savePrivacy(); showToast(privacy.pauseHistory ? "History paused" : "History on"); });
  // Render history list (top 30)
  const historyList = $("#privacy-history-list");
  const entries = Object.entries(progressMap).filter(([, v]) => v.title)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, 30);
  if (!entries.length) {
    historyList.innerHTML = `<div class="empty">No history to edit.</div>`;
  } else {
    entries.forEach(([k, v]) => {
      const row = document.createElement("div");
      row.className = "privacy-row";
      row.innerHTML = `
        <div class="pr-thumb" style="background-image:url('${v.poster || v.backdropMd || ""}')"></div>
        <div class="pr-info">
          <div class="pr-title">${escapeHTML(v.title)}</div>
          <div class="pr-sub">${Math.round(v.progress || 0)}% · ${humanWhen(v.updatedAt || 0)}</div>
        </div>
        <button class="pr-btn">Remove</button>
        <button class="pr-btn danger">Forget</button>`;
      const [removeBtn, forgetBtn] = row.querySelectorAll(".pr-btn");
      removeBtn.addEventListener("click", () => {
        delete progressMap[k]; saveProgress(); row.remove();
      });
      forgetBtn.addEventListener("click", () => {
        if (!confirm(`Forget "${v.title}" entirely? Removes progress, tags, journal, rating.`)) return;
        delete progressMap[k];
        delete tagsMap[k]; delete journalMap[k]; delete ratingsMap[k]; delete rewatchMap[k];
        delete dismissedMap[k]; delete hiddenMap[k]; delete statusOverrides[k];
        // Also delete per-episode entries
        Object.keys(progressMap).forEach(ek => { if (ek.startsWith(k + ":")) delete progressMap[ek]; });
        saveProgress(); saveTags(); saveJournal(); saveRatings(); saveRewatch(); saveDismissed(); saveHidden(); saveStatusOverrides();
        row.remove();
        showToast("Forgotten");
      });
      historyList.appendChild(row);
    });
  }
  // Bulk
  $("#p-export").addEventListener("click", exportJSON);
  $("#p-wipe-history").addEventListener("click", () => {
    if (!confirm("Clear all watch history? My List, ratings, tags will stay.")) return;
    progressMap = {}; rewatchMap = {}; sessionsList = [];
    saveProgress(); saveRewatch(); saveSessions();
    showToast("History cleared");
    showPrivacy();
  });
  $("#p-wipe-all").addEventListener("click", () => {
    if (!confirm("WIPE EVERYTHING for this profile? Cannot be undone.")) return;
    if (!confirm("Really sure? All progress, lists, ratings, tags, journal, achievements gone.")) return;
    [STORAGE.progress, STORAGE.list, STORAGE.ratings, STORAGE.dismissed, STORAGE.hidden, STORAGE.tags, STORAGE.journal, STORAGE.rewatch, STORAGE.sessions, STORAGE.goal, STORAGE.achievements, STORAGE.affinityActors, STORAGE.affinityDirectors, STORAGE.status]
      .forEach(k => localStorage.removeItem(profileStorageKey(k)));
    loadProfileData();
    showToast("All data wiped");
    navTo("#/");
  });
}

// ============== STATS PAGE ==============
async function showStats() {
  setActive("stats");
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="page-header"><h1>Your Stats</h1>
    <div class="page-header-actions">
      <a href="#/library/watching" class="page-action-btn">Library</a>
      <a href="#/achievements" class="page-action-btn">Achievements</a>
      <a href="#/recap" class="page-action-btn">${new Date().getFullYear()} Recap</a>
      <a href="#/privacy" class="page-action-btn">Privacy</a>
    </div></div>`;

  const entries = Object.entries(progressMap).filter(([, v]) => v.title);
  if (!entries.length) {
    rows.innerHTML += `<div class="empty-state"><div class="empty-icon">—</div><h2>No stats yet</h2><p>Watch something to see your stats.</p></div>`;
    return;
  }

  // Compute stats
  const totalSeconds = entries.reduce((acc, [, v]) => acc + (hasEpisodeTracking(v) ? 0 : (v.timestamp || 0)), 0) +
    Object.values(progressMap).filter(v => v.isEpisode).reduce((a, v) => a + (v.timestamp || 0), 0);
  const totalHours = Math.round(totalSeconds / 3600);
  const totalMinutes = Math.round(totalSeconds / 60);
  const finished = entries.filter(([, v]) => v.progress >= 95).length;
  const inProgress = entries.filter(([, v]) => v.progress > 1 && v.progress < 95).length;
  const finishRate = entries.length ? Math.round((finished / entries.length) * 100) : 0;

  // Streak calculation: count consecutive days back from today with any activity
  const allTs = Object.values(progressMap).map(v => v.updatedAt).filter(Boolean);
  const dayKey = (ts) => { const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); };
  const dayBucket = new Set(allTs.map(dayKey));
  let streak = 0;
  let cur = new Date(); cur.setHours(0,0,0,0);
  // If no activity today, allow yesterday as start
  if (!dayBucket.has(cur.getTime())) cur.setDate(cur.getDate() - 1);
  while (dayBucket.has(cur.getTime())) { streak++; cur.setDate(cur.getDate() - 1); }

  // This month minutes
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const monthSecs = entries.filter(([, v]) => (v.updatedAt || 0) >= monthStart.getTime())
    .reduce((a, [, v]) => a + (hasEpisodeTracking(v) ? 0 : (v.timestamp || 0)), 0) +
    Object.values(progressMap).filter(v => v.isEpisode && (v.updatedAt || 0) >= monthStart.getTime())
    .reduce((a, v) => a + (v.timestamp || 0), 0);
  const monthHours = Math.round(monthSecs / 3600);

  // Type breakdown
  const movies = entries.filter(([, v]) => v.itemType === "movie").length;
  const shows = entries.filter(([, v]) => v.itemType === "tv").length;

  // Most watched (by accumulated timestamp)
  const accBy = {};
  entries.forEach(([k, v]) => { accBy[k] = { item: v, secs: v.timestamp || 0 }; });
  Object.values(progressMap).filter(v => v.isEpisode).forEach(v => {
    const showKey = `${v.itemType || "tv"}:${v.itemId || ""}`;
    // Find parent
    const parent = entries.find(([k]) => k === showKey || k.startsWith(`${v.itemType || "tv"}:`));
    if (parent) accBy[parent[0]].secs += v.timestamp || 0;
  });
  const topShow = Object.values(accBy).sort((a, b) => b.secs - a.secs)[0];

  rows.innerHTML += `
    <div class="stats-hero">
      <div class="stats-hero-num">${totalHours}</div>
      <div class="stats-hero-label">hours watched all-time</div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-card-num">${streak}</div><div class="stat-card-label">Day Streak</div></div>
      <div class="stat-card"><div class="stat-card-num">${monthHours}h</div><div class="stat-card-label">This Month</div></div>
      <div class="stat-card"><div class="stat-card-num">${finished}</div><div class="stat-card-label">Finished</div></div>
      <div class="stat-card"><div class="stat-card-num">${inProgress}</div><div class="stat-card-label">In Progress</div></div>
      <div class="stat-card"><div class="stat-card-num">${movies}</div><div class="stat-card-label">Movies</div></div>
      <div class="stat-card"><div class="stat-card-num">${shows}</div><div class="stat-card-label">TV Shows</div></div>
      <div class="stat-card"><div class="stat-card-num">${finishRate}%</div><div class="stat-card-label">Finish Rate</div></div>
    </div>
    ${topShow ? `
    <div class="stats-section">
      <h2>Most Watched</h2>
      <div class="stats-feature-card" data-id="${topShow.item.itemId}" data-type="${topShow.item.itemType}">
        <div class="stats-feature-bg" style="background-image:url('${topShow.item.backdrop || topShow.item.backdropMd || topShow.item.poster || ""}')"></div>
        <div class="stats-feature-fade"></div>
        <div class="stats-feature-info">
          <div class="stats-feature-eyebrow">Your top title</div>
          <h3>${escapeHTML(topShow.item.title)}</h3>
          <div class="stats-feature-meta">${Math.round(topShow.secs / 3600)}h ${Math.round((topShow.secs % 3600) / 60)}m watched</div>
        </div>
      </div>
    </div>` : ""}
    <div class="stats-section">
      <h2>Your Ratings</h2>
      <div class="ratings-summary">
        <div class="rating-pill">${Object.values(ratingsMap).filter(r => r === "up").length} liked</div>
        <div class="rating-pill">${Object.values(ratingsMap).filter(r => r === "love").length} loved</div>
        <div class="rating-pill">${Object.values(ratingsMap).filter(r => r === "down").length} disliked</div>
      </div>
    </div>`;

  // Wire feature card
  const featCard = $(".stats-feature-card");
  if (featCard) {
    featCard.addEventListener("click", () => {
      navTo(`#/title/${featCard.dataset.type}/${featCard.dataset.id}`);
    });
  }

  // ===== Compare to last month =====
  const lastMonthStart = new Date(); lastMonthStart.setMonth(lastMonthStart.getMonth() - 1); lastMonthStart.setDate(1); lastMonthStart.setHours(0,0,0,0);
  const lastMonthEnd = new Date(monthStart);
  const lastMonthSecs = entries.filter(([, v]) => (v.updatedAt || 0) >= lastMonthStart.getTime() && (v.updatedAt || 0) < lastMonthEnd.getTime())
    .reduce((a, [, v]) => a + (v.timestamp || 0), 0) +
    Object.values(progressMap).filter(v => v.isEpisode && (v.updatedAt || 0) >= lastMonthStart.getTime() && (v.updatedAt || 0) < lastMonthEnd.getTime())
    .reduce((a, v) => a + (v.timestamp || 0), 0);
  const lastMonthHours = Math.round(lastMonthSecs / 3600);
  const diffPct = lastMonthHours ? Math.round(((monthHours - lastMonthHours) / lastMonthHours) * 100) : 0;
  const diffArrow = monthHours > lastMonthHours ? "↑" : monthHours < lastMonthHours ? "↓" : "→";
  const diffColor = monthHours > lastMonthHours ? "up" : monthHours < lastMonthHours ? "down" : "flat";
  const compareSection = document.createElement("div");
  compareSection.className = "stats-section";
  compareSection.innerHTML = `
    <h2>This Month vs. Last Month</h2>
    <div class="compare-grid">
      <div class="compare-cell">
        <div class="compare-num">${lastMonthHours}h</div>
        <div class="compare-label">Last month</div>
      </div>
      <div class="compare-arrow ${diffColor}">${diffArrow}</div>
      <div class="compare-cell">
        <div class="compare-num">${monthHours}h</div>
        <div class="compare-label">This month</div>
      </div>
      <div class="compare-pct ${diffColor}">${diffPct >= 0 ? "+" : ""}${diffPct}%</div>
    </div>`;
  rows.appendChild(compareSection);

  // ===== Genre breakdown pie =====
  const genreSecs = await computeGenreBreakdown(entries);
  if (genreSecs.length) {
    const genreSection = document.createElement("div");
    genreSection.className = "stats-section";
    const total = genreSecs.reduce((a, [, s]) => a + s, 0);
    const colors = ["#e50914", "#0080ff", "#f5c518", "#46d369", "#9333ea", "#ec4899", "#06b6d4", "#f97316"];
    let cumulative = 0;
    const segs = genreSecs.slice(0, 8).map(([name, secs], i) => {
      const pct = (secs / total) * 100;
      const start = cumulative;
      cumulative += pct;
      const startA = (start / 100) * 360 - 90;
      const endA = (cumulative / 100) * 360 - 90;
      const large = pct > 50 ? 1 : 0;
      const r = 80, cx = 100, cy = 100;
      const x1 = cx + r * Math.cos(startA * Math.PI / 180);
      const y1 = cy + r * Math.sin(startA * Math.PI / 180);
      const x2 = cx + r * Math.cos(endA * Math.PI / 180);
      const y2 = cy + r * Math.sin(endA * Math.PI / 180);
      return { name, pct: Math.round(pct), color: colors[i % colors.length], path: `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z` };
    });
    genreSection.innerHTML = `
      <h2>Genre Breakdown</h2>
      <div class="genre-pie-wrap">
        <svg class="genre-pie" viewBox="0 0 200 200">
          ${segs.map(s => `<path d="${s.path}" fill="${s.color}"/>`).join("")}
          <circle cx="100" cy="100" r="42" fill="#1a1815"/>
          <text x="100" y="95" text-anchor="middle" fill="#fff" font-size="20" font-weight="800">${segs.length}</text>
          <text x="100" y="115" text-anchor="middle" fill="#999" font-size="11">genres</text>
        </svg>
        <div class="genre-legend">
          ${segs.map(s => `<div class="genre-legend-row"><span class="genre-dot" style="background:${s.color}"></span><span class="genre-name">${escapeHTML(s.name)}</span><span class="genre-pct">${s.pct}%</span></div>`).join("")}
        </div>
      </div>`;
    rows.appendChild(genreSection);
  }

  // ===== Watch heatmap (GitHub-style) =====
  const heatmapSection = document.createElement("div");
  heatmapSection.className = "stats-section";
  heatmapSection.innerHTML = `<h2>Activity (last 12 weeks)</h2>${renderHeatmap()}`;
  rows.appendChild(heatmapSection);

  // ===== Time-of-day insight =====
  const todInsight = computeTimeOfDayInsight();
  if (todInsight) {
    const todSection = document.createElement("div");
    todSection.className = "stats-section";
    todSection.innerHTML = `<h2>When You Watch</h2>
      <div class="insight-card">
        <div class="insight-text">
          <div class="insight-headline">${escapeHTML(todInsight.headline)}</div>
          <div class="insight-sub">${escapeHTML(todInsight.sub)}</div>
        </div>
      </div>`;
    rows.appendChild(todSection);
  }

  // ===== Behavior insights (binge / abandon / drop-off) =====
  const insights = computeBehaviorInsights();
  if (insights.length) {
    const bSec = document.createElement("div");
    bSec.className = "stats-section";
    bSec.innerHTML = `<h2>Your Habits</h2><div class="behavior-grid">
      ${insights.map(i => `<div class="behavior-card">
        <div class="bh-text">
          <div class="bh-headline">${escapeHTML(i.headline)}</div>
          <div class="bh-sub">${escapeHTML(i.sub)}</div>
        </div>
      </div>`).join("")}
    </div>`;
    rows.appendChild(bSec);
  }

  // ===== Top actors / directors =====
  const topActors = Object.entries(affinityActors).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  const topDirectors = Object.entries(affinityDirectors).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  if (topActors.length) {
    const aSec = document.createElement("div");
    aSec.className = "stats-section";
    aSec.innerHTML = `<h2>Your Top Actors</h2><div class="affinity-grid">
      ${topActors.map(([id, a]) => `<a href="#/person/${id}" class="affinity-card">
        <div class="af-photo" style="background-image:url('${a.profile_path ? IMG + "/w185" + a.profile_path : ""}')"></div>
        <div class="af-name">${escapeHTML(a.name)}</div>
        <div class="af-count">${a.count} title${a.count > 1 ? "s" : ""}</div>
      </a>`).join("")}
    </div>`;
    rows.appendChild(aSec);
  }
  if (topDirectors.length) {
    const dSec = document.createElement("div");
    dSec.className = "stats-section";
    dSec.innerHTML = `<h2>Your Top Directors</h2><div class="affinity-grid">
      ${topDirectors.map(([id, d]) => `<a href="#/person/${id}" class="affinity-card">
        <div class="af-photo" style="background-image:url('${d.profile_path ? IMG + "/w185" + d.profile_path : ""}')"></div>
        <div class="af-name">${escapeHTML(d.name)}</div>
        <div class="af-count">${d.count} title${d.count > 1 ? "s" : ""}</div>
      </a>`).join("")}
    </div>`;
    rows.appendChild(dSec);
  }

  // ===== Goal setter + Export buttons =====
  const goalSection = document.createElement("div");
  goalSection.className = "stats-section";
  const curGoal = monthlyGoal?.hours || "";
  goalSection.innerHTML = `
    <h2>Monthly Goal</h2>
    <div class="goal-setter">
      <label>Watch <input id="goal-input" type="number" min="0" max="500" value="${curGoal}" placeholder="0"/> hours per month</label>
      <button class="btn" id="goal-save">Save Goal</button>
      ${monthlyGoal ? `<button class="btn-secondary" id="goal-clear">Clear</button>` : ""}
    </div>
    ${monthlyGoal ? `<div class="goal-progress">
      <div class="goal-bar"><div style="width:${Math.min(100, Math.round((monthHours / monthlyGoal.hours) * 100))}%"></div></div>
      <div class="goal-text">${monthHours}h / ${monthlyGoal.hours}h ${monthHours >= monthlyGoal.hours ? "Reached!" : ""}</div>
    </div>` : ""}
    <div style="margin-top:16px; display:flex; gap:8px; flex-wrap:wrap;">
      <button class="btn-secondary" id="export-csv">Export CSV</button>
      <button class="btn-secondary" id="export-json">Export JSON</button>
      <a href="#/hidden" class="btn-secondary" style="text-decoration:none;">Hidden Titles (${Object.keys(hiddenMap).length})</a>
    </div>`;
  rows.appendChild(goalSection);
  $("#goal-save").addEventListener("click", () => {
    const h = parseInt($("#goal-input").value);
    if (!h || h <= 0) { showToast("Enter a valid number"); return; }
    monthlyGoal = { hours: h, month: new Date().getMonth() };
    saveGoal();
    showToast("Goal saved");
    showStats();
    renderBudgetGauge();
  });
  $("#goal-clear")?.addEventListener("click", () => { monthlyGoal = null; saveGoal(); showStats(); renderBudgetGauge(); });
  $("#export-csv").addEventListener("click", exportCSV);
  $("#export-json").addEventListener("click", exportJSON);

  // ===== Tags overview =====
  const allTags = new Set();
  Object.values(tagsMap).forEach(arr => arr.forEach(t => allTags.add(t)));
  if (allTags.size) {
    const tagsSection = document.createElement("div");
    tagsSection.className = "stats-section";
    tagsSection.innerHTML = `<h2>Your Tags</h2>
      <div class="tags-cloud">
        ${[...allTags].map(t => `<a href="#/tag/${encodeURIComponent(t)}" class="tag-chip">${escapeHTML(t)}</a>`).join("")}
      </div>`;
    rows.appendChild(tagsSection);
  }

  // ===== Watch journal entries =====
  const journalEntries = Object.entries(journalMap);
  if (journalEntries.length) {
    const jSection = document.createElement("div");
    jSection.className = "stats-section";
    jSection.innerHTML = `<h2>Your Watch Journal</h2><div class="journal-list">
      ${journalEntries.slice(-10).reverse().map(([k, note]) => {
        const v = progressMap[k];
        const title = v?.title || "Unknown title";
        return `<div class="journal-row"><div class="journal-title">${escapeHTML(title)}</div><div class="journal-text">${escapeHTML(note)}</div></div>`;
      }).join("")}
    </div>`;
    rows.appendChild(jSection);
  }
}

async function computeGenreBreakdown(entries) {
  const acc = {}; // genreName -> seconds
  for (const [k, v] of entries) {
    const episodeSecs = Object.entries(progressMap).filter(([ek, ev]) => ev.isEpisode && ek.startsWith(k + ":s")).reduce((a, [, ev]) => a + (ev.timestamp || 0), 0);
    const secs = (episodeSecs > 0 ? 0 : (v.timestamp || 0)) + episodeSecs;
    if (!secs) continue;
    try {
      const detail = await tmdb(`/${v.itemType}/${v.itemId}`).catch(() => null);
      const genres = (detail?.genres || []).slice(0, 2).map(g => g.name);
      genres.forEach(g => { acc[g] = (acc[g] || 0) + secs / Math.max(1, genres.length); });
    } catch {}
  }
  return Object.entries(acc).sort((a, b) => b[1] - a[1]);
}

function renderHeatmap() {
  const weeks = 12;
  const cells = [];
  const today = new Date(); today.setHours(0,0,0,0);
  // Build per-day seconds
  const perDay = {};
  Object.values(progressMap).forEach(v => {
    if (!v.updatedAt) return;
    const d = new Date(v.updatedAt); d.setHours(0,0,0,0);
    perDay[d.getTime()] = (perDay[d.getTime()] || 0) + (v.timestamp || 0);
  });
  // Find max for scaling
  const max = Math.max(1, ...Object.values(perDay));
  const startDay = new Date(today); startDay.setDate(today.getDate() - (weeks * 7) + 1);
  let html = `<div class="heatmap">`;
  for (let w = 0; w < weeks; w++) {
    html += `<div class="hm-week">`;
    for (let d = 0; d < 7; d++) {
      const day = new Date(startDay); day.setDate(startDay.getDate() + (w * 7) + d);
      const secs = perDay[day.getTime()] || 0;
      const lvl = secs === 0 ? 0 : secs < max * 0.25 ? 1 : secs < max * 0.5 ? 2 : secs < max * 0.75 ? 3 : 4;
      const mins = Math.round(secs / 60);
      html += `<div class="hm-cell hm-${lvl}" title="${day.toLocaleDateString()}: ${mins}m"></div>`;
    }
    html += `</div>`;
  }
  html += `</div><div class="heatmap-legend">Less <span class="hm-cell hm-0"></span><span class="hm-cell hm-1"></span><span class="hm-cell hm-2"></span><span class="hm-cell hm-3"></span><span class="hm-cell hm-4"></span> More</div>`;
  return html;
}

function computeTimeOfDayInsight() {
  if (!sessionsList.length) return null;
  const buckets = [0, 0, 0, 0]; // morning, afternoon, evening, night
  sessionsList.forEach(s => {
    const h = new Date(s.start).getHours();
    if (h < 12) buckets[0]++;
    else if (h < 17) buckets[1]++;
    else if (h < 22) buckets[2]++;
    else buckets[3]++;
  });
  const labels = ["Morning watcher", "Afternoon viewer", "Evening watcher", "Late-night binger"];
  const subs = [
    "You usually watch before noon — early bird energy.",
    "You catch up after lunch most days.",
    "Your prime time is 5pm–10pm.",
    "You watch late into the night."
  ];
  let max = 0, idx = 0;
  buckets.forEach((c, i) => { if (c > max) { max = c; idx = i; } });
  // Weekend vs weekday
  const wkdays = [0, 0, 0, 0, 0, 0, 0];
  sessionsList.forEach(s => { wkdays[new Date(s.start).getDay()]++; });
  const weekend = wkdays[0] + wkdays[6];
  const weekday = wkdays.slice(1, 6).reduce((a, b) => a + b, 0);
  let extraSub = "";
  if (weekend > weekday * 0.4) extraSub = " You're also a weekend binger.";
  return { headline: labels[idx], sub: subs[idx] + extraSub };
}

function computeBehaviorInsights() {
  const insights = [];
  // Binge detection
  const maxBinge = computeMaxBinge();
  if (maxBinge >= 3) insights.push({
    headline: `${maxBinge} episodes in one binge`,
    sub: maxBinge >= 5 ? "You're a serious binge-watcher." : "You like a good back-to-back run.",
  });
  // Abandon count
  const dropped = Object.entries(progressMap).filter(([, v]) => {
    if (!v.title || v.isEpisode) return false;
    const days = (Date.now() - (v.updatedAt || 0)) / 86400000;
    return days > 14 && v.progress > 1 && v.progress < 60;
  }).length;
  if (dropped > 0) insights.push({
    headline: `${dropped} title${dropped > 1 ? "s" : ""} waiting`,
    sub: `Started but untouched for 2+ weeks. Pick one back up?`,
  });
  // Drop-off pattern (TV shows: avg episode where dropped)
  const tvDropped = Object.values(progressMap).filter(v => v.isEpisode === undefined && v.itemType === "tv" && v.episode && v.progress < 60 && (Date.now() - (v.updatedAt || 0)) > 14 * 86400000);
  if (tvDropped.length >= 3) {
    const avgEp = Math.round(tvDropped.reduce((a, v) => a + (v.episode || 1), 0) / tvDropped.length);
    insights.push({
      headline: `Drops shows around episode ${avgEp}`,
      sub: "If you make it past this point, you usually finish.",
    });
  }
  // Completion rate by type
  const movieEntries = Object.values(progressMap).filter(v => v.itemType === "movie" && v.title);
  const movieFinish = movieEntries.length ? Math.round(movieEntries.filter(v => v.progress >= 95).length / movieEntries.length * 100) : 0;
  const tvEntries = Object.values(progressMap).filter(v => v.itemType === "tv" && v.title);
  const tvFinish = tvEntries.length ? Math.round(tvEntries.filter(v => v.progress >= 95).length / tvEntries.length * 100) : 0;
  if (movieEntries.length >= 3 && tvEntries.length >= 3 && Math.abs(movieFinish - tvFinish) > 15) {
    insights.push({
      headline: movieFinish > tvFinish ? "You finish movies more than shows" : "You finish shows more than movies",
      sub: `${movieFinish}% movies vs ${tvFinish}% shows completion rate.`,
    });
  }
  // Weekend binger
  const weekendSecs = sessionsList.filter(s => { const d = new Date(s.start).getDay(); return d === 0 || d === 6; })
    .reduce((a, s) => a + ((s.end || s.start) - s.start) / 1000, 0);
  const weekdaySecs = sessionsList.filter(s => { const d = new Date(s.start).getDay(); return d > 0 && d < 6; })
    .reduce((a, s) => a + ((s.end || s.start) - s.start) / 1000, 0);
  if (weekendSecs > weekdaySecs * 0.6 && (weekendSecs + weekdaySecs) > 7200) {
    insights.push({
      headline: "Weekend binger",
      sub: `Most of your watching happens Saturday/Sunday.`,
    });
  }
  // Most-watched genre call-out (rough)
  return insights;
}

function exportCSV() {
  const rows = [["Title", "Type", "Season", "Episode", "Progress%", "Watched(min)", "Updated"]];
  Object.values(progressMap).forEach(v => {
    if (!v.title) return;
    rows.push([
      v.title.replace(/"/g, '""'),
      v.itemType,
      v.season || "",
      v.episode || "",
      Math.round(v.progress || 0),
      Math.round((v.timestamp || 0) / 60),
      v.updatedAt ? new Date(v.updatedAt).toISOString() : ""
    ]);
  });
  const csv = rows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
  downloadFile(`movietube-history-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
}

function exportJSON() {
  const data = {
    account: currentUser?.email,
    progress: progressMap,
    myList,
    ratings: ratingsMap,
    tags: tagsMap,
    journal: journalMap,
    rewatch: rewatchMap,
    sessions: sessionsList,
    exportedAt: new Date().toISOString(),
  };
  downloadFile(`movietube-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${name}`);
}

// ============ YEAR RECAP ============
function showYearRecap() {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  const year = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();
  const yearEntries = Object.entries(progressMap).filter(([, v]) => v.title && (v.updatedAt || 0) >= yearStart);
  const yearEpisodes = Object.values(progressMap).filter(v => v.isEpisode && (v.updatedAt || 0) >= yearStart);
  const yearSeconds = yearEntries.reduce((a, [, v]) => a + (v.timestamp || 0), 0)
    + yearEpisodes.reduce((a, v) => a + (v.timestamp || 0), 0);
  const yearHours = Math.round(yearSeconds / 3600);
  const yearFinished = yearEntries.filter(([, v]) => v.progress >= 95).length;
  const yearMovies = yearEntries.filter(([, v]) => v.itemType === "movie").length;
  const yearShows = yearEntries.filter(([, v]) => v.itemType === "tv").length;
  const allEpsFinished = yearEpisodes.filter(v => v.progress >= 95).length;

  // Top title by accumulated time this year
  const accBy = {};
  yearEntries.forEach(([k, v]) => { accBy[k] = { item: v, secs: v.timestamp || 0 }; });
  yearEpisodes.forEach(v => {
    const showKey = `${v.itemType || "tv"}:${v.itemId || ""}`;
    if (accBy[showKey]) accBy[showKey].secs += v.timestamp || 0;
  });
  const topTitle = Object.values(accBy).sort((a, b) => b.secs - a.secs)[0];

  rows.innerHTML = `
    <div class="recap-screen">
      <div class="recap-card">
        <div class="recap-eyebrow">Your ${year} in MovieTube</div>
        <div class="recap-hero-num">${yearHours}</div>
        <div class="recap-hero-label">hours of watching</div>
        <div class="recap-divider"></div>
        <div class="recap-stats-grid">
          <div><div class="rs-num">${yearFinished}</div><div class="rs-label">titles finished</div></div>
          <div><div class="rs-num">${allEpsFinished}</div><div class="rs-label">episodes watched</div></div>
          <div><div class="rs-num">${yearMovies}</div><div class="rs-label">movies</div></div>
          <div><div class="rs-num">${yearShows}</div><div class="rs-label">shows</div></div>
        </div>
        ${topTitle ? `
          <div class="recap-divider"></div>
          <div class="recap-top">
            <div class="recap-top-eyebrow">Your most-watched of ${year}</div>
            <div class="recap-top-card" data-id="${topTitle.item.itemId}" data-type="${topTitle.item.itemType}">
              <div class="recap-top-bg" style="background-image:url('${topTitle.item.backdrop || topTitle.item.backdropMd || topTitle.item.poster || ""}')"></div>
              <div class="recap-top-fade"></div>
              <div class="recap-top-info">
                <h3>${escapeHTML(topTitle.item.title)}</h3>
                <div>${Math.round(topTitle.secs / 3600)}h ${Math.round((topTitle.secs % 3600) / 60)}m watched</div>
              </div>
            </div>
          </div>` : ""}
        <div class="recap-actions">
          <a href="#/stats" class="btn">View Full Stats</a>
          <a href="#/" class="btn-secondary">Back Home</a>
        </div>
      </div>
    </div>`;
  const t = $(".recap-top-card");
  if (t) t.addEventListener("click", () => navTo(`#/title/${t.dataset.type}/${t.dataset.id}`));
}

function humanWhen(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 4) return `${w}w ago`;
  return new Date(ts).toLocaleDateString();
}

// Resume prompt (shown ~2s after profile select if there's something to resume)
let resumeShown = false;
function maybeShowResumePrompt() {
  if (resumeShown) return;
  const cw = getContinueWatching();
  if (!cw.length) return;
  const top = cw[0];
  const key = `${top.type}:${top.id}`;
  const v = progressMap[key];
  if (!v) return;
  // Only prompt if last watched within 14 days and not finished
  if (Date.now() - (v.updatedAt || 0) > 14 * 24 * 3600 * 1000) return;
  if (v.progress >= 95) return;
  resumeShown = true;
  // Don't show on top of an already-open modal
  if (!$("#modal").classList.contains("hidden")) return;

  const prompt = document.createElement("div");
  prompt.className = "resume-prompt";
  let ep = "";
  if (v.itemType === "tv" && v.season && v.episode) ep = `S${v.season} · E${v.episode}`;
  let left = "";
  if (v.duration && v.timestamp) {
    const mins = Math.max(1, Math.ceil((v.duration - v.timestamp) / 60));
    left = `${mins}m left`;
  }
  prompt.innerHTML = `
    <button class="rp-close" aria-label="Dismiss">×</button>
    <div class="rp-thumb" style="background-image:url('${top.backdropMd || top.backdrop || top.poster || ""}')"></div>
    <div class="rp-info">
      <div class="rp-eyebrow">Pick up where you left off</div>
      <div class="rp-title">${escapeHTML(top.title)}</div>
      <div class="rp-sub">${[ep, left].filter(Boolean).join(" · ")}</div>
      <div class="rp-buttons">
        <button class="rp-resume">▶ Resume</button>
        <button class="rp-dismiss">Not now</button>
      </div>
    </div>`;
  document.body.appendChild(prompt);
  const remove = () => { prompt.remove(); };
  prompt.querySelector(".rp-close").addEventListener("click", remove);
  prompt.querySelector(".rp-dismiss").addEventListener("click", remove);
  prompt.querySelector(".rp-resume").addEventListener("click", () => { remove(); openTitle(top); });
  // Auto-dismiss after 12s
  setTimeout(() => prompt.parentNode && prompt.remove(), 12000);
}

function showMyList() {
  setActive("mylist");
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="page-header"><h1>My List</h1>
    <div class="page-header-actions">
      <button class="page-action-btn" id="multi-select-toggle">${multiSelectMode ? "Done" : "Select"}</button>
      ${multiSelectMode && selectedListIds.size ? `<button class="page-action-btn" id="multi-remove">Remove (${selectedListIds.size})</button>` : ""}
    </div></div>
    <div class="page-subhead-text">Drag titles to reorder · Right-click for "Not Interested"</div>`;
  if (!myList.length) {
    rows.innerHTML += `
      <div class="empty-state">
        <div class="empty-icon">+</div>
        <h2>Your list is empty</h2>
        <p>Tap the + button on any title to save it here for later.</p>
        <button class="btn" id="empty-browse">Browse Titles</button>
      </div>`;
    $("#empty-browse")?.addEventListener("click", () => {
      document.body.classList.remove("no-hero");
      showHome();
    });
    return;
  }
  $("#multi-select-toggle")?.addEventListener("click", () => {
    multiSelectMode = !multiSelectMode;
    selectedListIds.clear();
    showMyList();
  });
  $("#multi-remove")?.addEventListener("click", () => {
    if (!confirm(`Remove ${selectedListIds.size} titles from My List?`)) return;
    myList = myList.filter(it => !selectedListIds.has(itemKey(it)));
    saveMyList();
    selectedListIds.clear();
    multiSelectMode = false;
    showMyList();
  });

  const grid = document.createElement("div");
  grid.className = "search-grid mylist-grid" + (multiSelectMode ? " multi-mode" : "");
  myList.forEach((it, idx) => {
    const cell = document.createElement("div");
    cell.className = "search-cell mylist-cell";
    cell.draggable = !multiSelectMode;
    cell.dataset.idx = idx;
    cell.dataset.key = itemKey(it);
    if (multiSelectMode && selectedListIds.has(itemKey(it))) cell.classList.add("selected");
    if (multiSelectMode) {
      const checkbox = document.createElement("div");
      checkbox.className = "mylist-checkbox";
      checkbox.innerHTML = selectedListIds.has(itemKey(it)) ? "✓" : "";
      cell.appendChild(checkbox);
      cell.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const k = itemKey(it);
        if (selectedListIds.has(k)) selectedListIds.delete(k);
        else selectedListIds.add(k);
        showMyList();
      });
    }
    cell.appendChild(makeCard(it));
    const meta = document.createElement("div");
    meta.className = "search-meta";
    meta.innerHTML = `<span class="type-pill">${typeLabel(it)}</span><span>${it.year || ""}</span>`;
    const title = document.createElement("div");
    title.className = "search-title";
    title.textContent = it.title;
    cell.appendChild(title);
    cell.appendChild(meta);
    // Drag handlers
    if (!multiSelectMode) {
      cell.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", idx);
        cell.classList.add("dragging");
      });
      cell.addEventListener("dragend", () => cell.classList.remove("dragging"));
      cell.addEventListener("dragover", (e) => {
        e.preventDefault();
        cell.classList.add("drag-over");
      });
      cell.addEventListener("dragleave", () => cell.classList.remove("drag-over"));
      cell.addEventListener("drop", (e) => {
        e.preventDefault();
        cell.classList.remove("drag-over");
        const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
        const toIdx = idx;
        if (fromIdx === toIdx || isNaN(fromIdx)) return;
        const moved = myList.splice(fromIdx, 1)[0];
        myList.splice(toIdx, 0, moved);
        saveMyList();
        showMyList();
      });
    }
    grid.appendChild(cell);
  });
  rows.appendChild(grid);
  const c = getContinueWatching();
  if (c.length) {
    const continueHeader = document.createElement("div");
    continueHeader.className = "page-subheader";
    continueHeader.innerHTML = `<h2>Continue Watching</h2>`;
    rows.appendChild(continueHeader);
    rows.appendChild(renderRow("", c, { showProgress: true }));
  }
}

async function searchAll(query) {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="search-header">Searching for <strong>"${escapeHTML(query)}"</strong>…</div>`;
  try {
    const data = await tmdb("/search/multi", { query });
    const items = data.results
      .filter(r => (r.media_type === "movie" || r.media_type === "tv") && r.backdrop_path && r.poster_path)
      .map(r => normalizeTMDB(r));
    rows.innerHTML = "";
    if (!items.length) {
      rows.innerHTML = `
        <div class="search-header">Your search for <strong>"${escapeHTML(query)}"</strong> did not have any matches.</div>
        <div class="empty" style="text-align:center; padding:40px 4%;">Suggestions:<br><br>· Try different keywords<br>· Look for a movie, TV show or person<br>· Try a more general keyword</div>`;
      return;
    }
    rows.innerHTML = `<div class="search-header">Top results for <strong>"${escapeHTML(query)}"</strong></div>`;
    const grid = document.createElement("div");
    grid.className = "search-grid";
    items.forEach(it => {
      const cell = document.createElement("div");
      cell.className = "search-cell";
      cell.appendChild(makeCard(it));
      const meta = document.createElement("div");
      meta.className = "search-meta";
      meta.innerHTML = `<span class="type-pill">${typeLabel(it)}</span>${it.rating ? `<span class="rating-star">★ ${it.rating}</span>` : ""}<span>${it.year || ""}</span>`;
      const title = document.createElement("div");
      title.className = "search-title";
      title.textContent = it.title;
      cell.appendChild(title);
      cell.appendChild(meta);
      grid.appendChild(cell);
    });
    rows.appendChild(grid);
  } catch (e) { rows.innerHTML = `<div class="empty">${escapeHTML(friendlyErrorMessage(e))}</div>`; }
}

// TMDB genre lists (movie + tv)
const GENRES_TV = [
  { id: 10759, name: "Action & Adventure" },
  { id: 16,    name: "Animation" },
  { id: 35,    name: "Comedy" },
  { id: 80,    name: "Crime" },
  { id: 99,    name: "Documentary" },
  { id: 18,    name: "Drama" },
  { id: 10765, name: "Sci-Fi & Fantasy" },
  { id: 9648,  name: "Mystery" },
];

function renderGenreChips(type, activeId) {
  const wrap = document.createElement("div");
  wrap.className = "chips";
  const list = type === "tv" ? GENRES_TV : GENRES_MOVIE;
  const all = document.createElement("button");
  all.className = "chip" + (!activeId ? " active" : "");
  all.textContent = "All";
  all.addEventListener("click", () => { location.hash = `#/${type === "movie" ? "movies" : "tv"}`; });
  wrap.appendChild(all);
  list.forEach(g => {
    const b = document.createElement("button");
    b.className = "chip" + (activeId == g.id ? " active" : "");
    b.textContent = g.name;
    b.addEventListener("click", () => {
      location.hash = `#/${type === "movie" ? "movies" : "tv"}/genre/${g.id}`;
    });
    wrap.appendChild(b);
  });
  return wrap;
}

function setActive(nav) {
  $$("#navbar-nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === nav));
}

// ---------- Modal ----------
let currentItem = null;
let modalMuted = true;
let currentSeason = null;
let modalDetails = null;
// Bumped on every open/close so a close's deferred cleanup (see closeModal's
// fade-out) can tell whether it's still the modal's current "session" —
// otherwise closing one title then immediately opening another within the
// fade window would let the stale timeout hide/clear the new one.
let modalSessionToken = 0;
// The hash to restore when the modal is closed via our own UI (× / backdrop /
// Escape) — set once per "session" of opening a title, not overwritten by
// navigating between titles while a modal is already open.
let modalPreviousHash = null;

function renderTagsAndJournal(item) {
  const container = $(".modal-info-main");
  if (!container) return;
  container.querySelectorAll(".tags-journal-block").forEach(n => n.remove());
  const wrap = document.createElement("div");
  wrap.className = "tags-journal-block";
  const tags = getTags(item);
  const note = getJournal(item);
  wrap.innerHTML = `
    <div class="tj-row">
      <div class="tj-label">Tags:</div>
      <div class="tj-tags" id="tj-tags">${tags.map(t => `<span class="tj-tag">${escapeHTML(t)}<button class="tj-x" data-tag="${escapeHTML(t)}">×</button></span>`).join("")}</div>
      <input type="text" class="tj-input" id="tj-add" placeholder="Add tag (e.g. favorite)" maxlength="20"/>
    </div>
    <div class="tj-row">
      <div class="tj-label">Note:</div>
      <textarea class="tj-textarea" id="tj-note" placeholder="A line about this title…" maxlength="280">${escapeHTML(note)}</textarea>
    </div>
    <div class="tj-row tj-actions">
      <button class="tj-not-interested btn-secondary" id="tj-hide">${isHidden(item) ? "Restore" : "Not Interested"}</button>
    </div>`;
  container.appendChild(wrap);
  // Tag add
  const addInput = wrap.querySelector("#tj-add");
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && addInput.value.trim()) {
      const t = addInput.value.trim();
      const cur = getTags(item);
      if (!cur.includes(t)) setTags(item, [...cur, t]);
      addInput.value = "";
      renderTagsAndJournal(item);
      sparkleAt(addInput);
    }
  });
  // Tag remove
  wrap.querySelectorAll(".tj-x").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.tag;
      setTags(item, getTags(item).filter(x => x !== t));
      renderTagsAndJournal(item);
    });
  });
  // Journal save (on blur)
  const ta = wrap.querySelector("#tj-note");
  ta.addEventListener("blur", () => {
    setJournal(item, ta.value.trim());
  });
  // Hide
  wrap.querySelector("#tj-hide").addEventListener("click", () => {
    if (isHidden(item)) { unhideItem(item); showToast("Restored"); }
    else { hideItem(item); showToast("Hidden — won't appear in your home rows"); }
    renderTagsAndJournal(item);
  });
}

function sparkleAt(el) {
  const r = el.getBoundingClientRect();
  for (let i = 0; i < 6; i++) {
    const s = document.createElement("div");
    s.className = "sparkle";
    s.style.left = (r.left + r.width / 2) + "px";
    s.style.top = (r.top + r.height / 2) + "px";
    s.style.setProperty("--dx", (Math.random() * 80 - 40) + "px");
    s.style.setProperty("--dy", (Math.random() * 80 - 40) + "px");
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 700);
  }
}

function renderRatingButtons(item) {
  const buttonsRow = $(".modal-channel-row");
  if (!buttonsRow) return;
  // Remove any existing rating UI
  buttonsRow.querySelectorAll(".rating-btn").forEach(n => n.remove());
  const cur = getRating(item);
  const opts = [
    { val: "down", icon: "−", title: "Not for me" },
    { val: "up", icon: "+", title: "I like this" },
    { val: "love", icon: "♥", title: "Love this!" },
  ];
  opts.forEach(o => {
    const b = document.createElement("button");
    b.className = "icon-btn rating-btn" + (cur === o.val ? " rated" : "");
    b.title = o.title;
    b.textContent = o.icon;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      setRating(item, o.val);
      renderRatingButtons(item);
      const verb = ratingsMap[`${item.type}:${item.id}`] === o.val
        ? (o.val === "love" ? "Loved" : o.val === "up" ? "Liked" : "Marked as not for me")
        : "Rating cleared";
      showToast(verb);
      if (ratingsMap[`${item.type}:${item.id}`]) sparkleAt(b);
    });
    buttonsRow.appendChild(b);
  });
}

function renderNewEpisodeBadge(item) {
  const titleEl = $("#modal-title");
  document.querySelectorAll(".new-episode-badge").forEach(n => n.remove());
  if (item.type !== "tv") return;
  const last = progressMap[progressKey(item)];
  if (!last) return;
  setTimeout(async () => {
    try {
      const details = modalDetails || (await tmdb(`/tv/${item.id}`));
      if (currentItem !== item) return;
      const lastAir = details.last_air_date ? new Date(details.last_air_date).getTime() : 0;
      // Show "New Episode" badge if airdate is after last watched and within 30 days
      if (lastAir && last.updatedAt && lastAir > last.updatedAt && (Date.now() - lastAir) < 30 * 86400000) {
        const badge = document.createElement("div");
        badge.className = "new-episode-badge";
        badge.textContent = "● NEW EPISODE";
        const meta = $(".modal-meta");
        if (meta) meta.parentNode.insertBefore(badge, meta);
      }
    } catch {}
  }, 0);
}

async function openModal(item, opts = {}) {
  // Push a real history entry for this title so the browser Back button
  // closes the modal instead of leaving the site — every entry point
  // (card click, hero, search result, etc.) funnels through here.
  const titleHash = `#/title/${item.type}/${item.id}`;
  if (location.hash !== titleHash) {
    if (!location.hash.startsWith("#/title/")) modalPreviousHash = location.hash;
    history.pushState(null, "", titleHash);
  }
  currentItem = item;
  modalDetails = null;
  modalSessionToken++;
  $("#modal").classList.remove("closing");
  $("#modal").classList.remove("hidden");
  $("#modal").scrollTop = 0;
  document.body.style.overflow = "hidden";
  // Pause hero audio so it doesn't fight the modal trailer
  const heroIframe = $("#hero-trailer iframe");
  if (heroIframe) { heroIframe.dataset.src = heroIframe.src; heroIframe.src = ""; }

  const bg = item.backdrop || item.poster;
  $("#modal-bg").style.backgroundImage = bg ? `url("${bg}")` : "";
  applyModalTint(null);
  if (item.poster) extractDominantColor(item.poster).then(c => { if (currentItem === item) applyModalTint(c); });
  else if (bg) extractDominantColor(bg).then(c => { if (currentItem === item) applyModalTint(c); });
  $("#modal-trailer").innerHTML = "";
  $("#player-wrap").innerHTML = ""; $("#player-wrap").classList.remove("active");
  $(".modal-body").classList.remove("playing");
  $("#modal-title").textContent = item.title;
  const avatarBg = item.poster || item.backdrop || "";
  $("#modal-channel-avatar").style.backgroundImage = avatarBg ? `url("${avatarBg}")` : "";
  $("#modal-match").textContent = `${pseudoMatch(item)}% Match`;
  $("#modal-year").textContent = item.year || "";
  $("#modal-age").textContent = pseudoAge(item);
  $("#modal-runtime").textContent = "";
  $("#modal-overview").textContent = item.overview || "";
  $("#modal-cast").textContent = (item.genres || []).join(", ");
  $("#modal-genres").textContent = "MovieTube";
  $("#episode-section").classList.add("hidden");
  $("#similar-section").classList.add("hidden");
  $("#cast-section").classList.add("hidden"); $("#cast-row").innerHTML = "";
  $("#similar-grid").innerHTML = "";
  updateListButton();
  renderRatingButtons(item);
  renderNewEpisodeBadge(item);
  renderTagsAndJournal(item);

  // Trailer in modal hero
  try {
    const key = await fetchTrailerKey(item);
    if (key) {
      $("#modal-trailer").innerHTML = `<iframe src="${YT_EMBED}${key}?autoplay=1&mute=${modalMuted ? 1 : 0}&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${key}&disablekb=1&vq=hd1080&hd=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}" allow="autoplay; encrypted-media" sandbox="allow-scripts allow-same-origin allow-presentation"></iframe>`;
    }
  } catch {}

  // Details: cast, runtime, genres, similar
  if (item.type === "movie" || item.type === "tv") {
    try {
      const detailsPath = item.type === "movie" ? `/movie/${item.id}` : `/tv/${item.id}`;
      const [details, credits, similar] = await Promise.all([
        tmdb(detailsPath),
        tmdb(detailsPath + "/credits").catch(() => ({ cast: [] })),
        tmdb(detailsPath + "/similar").catch(() => ({ results: [] })),
      ]);
      modalDetails = details;
      if (details.runtime) $("#modal-runtime").textContent = `${details.runtime} min`;
      else if (details.episode_run_time?.[0]) $("#modal-runtime").textContent = `${details.episode_run_time[0]} min`;
      else if (details.number_of_seasons) $("#modal-runtime").textContent = `${details.number_of_seasons} Season${details.number_of_seasons > 1 ? "s" : ""}`;
      const genreNames = (details.genres || []).map(g => g.name);
      const castNames = credits.cast.slice(0, 4).map(c => c.name);
      $("#modal-cast").textContent = [genreNames.join(", "), castNames.join(", ")].filter(Boolean).join(" · ") || "—";
      const studio = (details.production_companies || [])[0]?.name;
      $("#modal-genres").textContent = studio || genreNames.slice(0, 2).join(", ") || "MovieTube";

      // Crew: director, writers — shown as a line under the description
      const infoMain = $(".modal-info-main");
      infoMain.querySelectorAll(".info-line.dynamic").forEach(n => n.remove());
      const crew = credits.crew || [];
      const directors = item.type === "movie"
        ? crew.filter(c => c.job === "Director").map(c => c.name)
        : (details.created_by || []).map(c => c.name);
      const writers = [...new Set(crew.filter(c => c.department === "Writing" || c.job === "Writer" || c.job === "Screenplay").map(c => c.name))];
      const directorLabel = item.type === "movie" ? "Director" : "Creator";
      const addLine = (label, val) => {
        if (!val) return;
        const d = document.createElement("div");
        d.className = "info-line dynamic";
        d.innerHTML = `<span class="label">${label}:</span> <span>${escapeHTML(val)}</span>`;
        infoMain.appendChild(d);
      };
      if (directors.length) addLine(directors.length > 1 ? directorLabel + "s" : directorLabel, directors.slice(0, 2).join(", "));
      if (writers.length) addLine(writers.length > 1 ? "Writers" : "Writer", writers.slice(0, 3).join(", "));

      // Cast row with images
      const castRow = $("#cast-row");
      castRow.innerHTML = "";
      const cast = (credits.cast || []).slice(0, 12);
      if (cast.length) {
        $("#cast-section").classList.remove("hidden");
        cast.forEach(c => {
          const card = document.createElement("div");
          card.className = "cast-card";
          const img = c.profile_path ? `${IMG}/w185${c.profile_path}` : "";
          card.innerHTML = `
            <div class="cast-img"></div>
            <div class="cast-name">${escapeHTML(c.name)}</div>
            ${c.character ? `<div class="cast-char">${escapeHTML(c.character)}</div>` : ""}`;
          if (img) {
            const castImgEl = card.querySelector(".cast-img");
            castImgEl.dataset.bg = img;
            lazyImageObserver.observe(castImgEl);
          }
          card.addEventListener("click", () => {
            const pid = c.id;
            closeModalNav();
            setTimeout(() => navTo(`#/person/${pid}`), 50);
          });
          castRow.appendChild(card);
        });
      } else {
        $("#cast-section").classList.add("hidden");
      }

      // Similar
      const simItems = similar.results.slice(0, 9).map(r => normalizeTMDB(r, item.type));
      if (simItems.length) {
        $("#similar-section").classList.remove("hidden");
        const grid = $("#similar-grid"); grid.innerHTML = "";
        simItems.forEach(s => grid.appendChild(makeSimilarCard(s)));
      }

      // Episodes for TV
      if (item.type === "tv") {
        $("#episode-section").classList.remove("hidden");
        const seasons = details.seasons.filter(s => s.season_number > 0 && s.episode_count > 0);
        const sel = $("#season-select");
        sel.innerHTML = seasons.map(s => `<option value="${s.season_number}">Season ${s.season_number}</option>`).join("");
        const last = progressMap[progressKey(item)];
        if (last?.season) sel.value = last.season;
        sel.onchange = () => loadEpisodes(item.id, +sel.value);
        await loadEpisodes(item.id, +sel.value);
      }
    } catch {}
  }

  if (opts.autoplay) startPlayer(item);
}

let currentSeasonEpisodes = [];
async function loadEpisodes(tvId, seasonNum) {
  currentSeason = seasonNum;
  const list = $("#episode-list");
  list.innerHTML = `<div class="empty" style="padding:24px 0">Loading episodes…</div>`;
  try {
    const sd = await tmdb(`/tv/${tvId}/season/${seasonNum}`);
    currentSeasonEpisodes = sd.episodes || [];
    list.innerHTML = "";
    const last = progressMap[progressKey(currentItem)];
    sd.episodes.forEach(ep => {
      const isCurrent = last?.season === seasonNum && last.episode === ep.episode_number;
      // Per-episode progress (every watched episode keeps its own bar)
      const epProg = progressMap[episodeProgressKey(currentItem, seasonNum, ep.episode_number)];
      const epPct = epProg?.progress || (isCurrent ? last?.progress : 0) || 0;
      const isFinished = epPct >= 95;
      const div = document.createElement("div");
      div.className = "episode-item" + (isFinished ? " ep-finished" : "") + (isCurrent ? " ep-current" : "");
      const thumb = ep.still_path ? `${IMG}/w300${ep.still_path}` : (currentItem.backdrop || "");
      let barHTML = "";
      if (isFinished) {
        barHTML = `<div class="ep-progress ep-progress-done"><div style="width:100%"></div></div><div class="ep-watched-tick">✓</div>`;
      } else if (epPct > 1) {
        barHTML = `<div class="ep-progress"><div style="width:${Math.min(100, Math.round(epPct))}%"></div></div>`;
      }
      div.innerHTML = `
        <div class="episode-num">${ep.episode_number}</div>
        <div class="episode-thumb">${barHTML}</div>
        <div class="episode-info">
          <div class="ep-head">
            <span class="ep-title">${escapeHTML(ep.name || "Episode " + ep.episode_number)}</span>
            <span class="ep-runtime">${ep.runtime ? ep.runtime + "m" : ""}</span>
          </div>
          <div class="ep-overview">${escapeHTML(ep.overview || "")}</div>
        </div>`;
      if (thumb) {
        const thumbEl = div.querySelector(".episode-thumb");
        thumbEl.dataset.bg = thumb;
        lazyImageObserver.observe(thumbEl);
      }
      div.addEventListener("click", () => startPlayer(currentItem, { season: seasonNum, episode: ep.episode_number }));
      list.appendChild(div);
    });
  } catch {
    list.innerHTML = `<div class="empty">Could not load episodes.</div>`;
  }
}

function makeSimilarCard(item) {
  const div = document.createElement("div");
  div.className = "similar-card";
  const bg = item.backdropMd || item.backdrop || item.poster;
  div.innerHTML = `
    <div class="sim-img"></div>
    <div class="sim-body">
      <div class="sim-title">${escapeHTML(item.title || "")}</div>
      <div class="sim-meta">
        <span class="match">${pseudoMatch(item)}% match</span>
        <span class="dot">•</span>
        <span>${item.year || ""}</span>
      </div>
    </div>
    <button type="button" class="sim-add" aria-label="Add ${escapeHTML(item.title || "")} to My List">+</button>`;
  if (bg) {
    const imgEl = div.querySelector(".sim-img");
    imgEl.dataset.bg = bg;
    lazyImageObserver.observe(imgEl);
  }
  div.addEventListener("click", () => openModal(item));
  div.querySelector(".sim-add").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleList(item);
  });
  makeFocusableActivatable(div, item.title || "Untitled", () => openModal(item));
  return div;
}

let playingItem = null;
let playingCtx = {};
let nextEpContext = null;
let skipIntroShown = false;
let upNextShown = false;
let upNextTimer = null;
let lastSkipSeek = 0;

function computeNextEpisode(item, ctx) {
  if (item.type === "tv" && currentSeasonEpisodes && currentSeasonEpisodes.length) {
    const idx = currentSeasonEpisodes.findIndex(ep => ep.episode_number === ctx.episode);
    if (idx >= 0 && idx < currentSeasonEpisodes.length - 1) {
      const ep = currentSeasonEpisodes[idx + 1];
      return {
        item, ctx: { season: ctx.season, episode: ep.episode_number },
        label: `S${ctx.season} E${ep.episode_number}${ep.name ? " · " + ep.name : ""}`,
        epName: ep.name || `Episode ${ep.episode_number}`,
        epOverview: ep.overview || "",
        epThumb: ep.still_path ? `${IMG}/w300${ep.still_path}` : (item.backdrop || ""),
        epRuntime: ep.runtime,
        seasonEp: `S${ctx.season} · E${ep.episode_number}`,
      };
    }
    // Try next season (use modalDetails.seasons)
    if (modalDetails?.seasons) {
      const next = modalDetails.seasons.find(s => s.season_number === (ctx.season + 1) && s.episode_count > 0);
      if (next) return {
        item, ctx: { season: next.season_number, episode: 1 },
        label: `S${next.season_number} E1 · Season Premiere`,
        epName: "Season Premiere",
        epOverview: "Start of a new season",
        epThumb: item.backdrop || "",
        seasonEp: `S${next.season_number} · E1`,
        nextSeason: true,
      };
    }
  }
  return null;
}

let playerAttemptToken = 0;
let playerWatchdogTimer = null;
function launchPlayerAttempt(item, ctx, seek, provider, token, armWatchdog) {
  const url = buildPlayerURL(item, ctx, seek, provider);
  $("#player-wrap").classList.add("active");
  $("#player-wrap").innerHTML = `<iframe src="${url}"
    allow="encrypted-media; autoplay; fullscreen; picture-in-picture"
    allowfullscreen referrerpolicy="origin"></iframe>
    <button class="player-fs-btn" id="player-fs-btn" title="Fullscreen" aria-label="Fullscreen">⛶</button>`;
  clearTimeout(playerWatchdogTimer);
  // Only the initial attempt (on the default provider) gets watchdogged —
  // once we've already fallen back once, the postMessage listener can't
  // verify a different provider's liveness anyway (it only understands
  // videasy's message shape, gated by origin), so there's nothing more to
  // watch for.
  if (armWatchdog && provider !== PLAYER_FALLBACK_PROVIDER) {
    playerWatchdogTimer = setTimeout(() => {
      if (token !== playerAttemptToken) return; // superseded — user closed or replayed
      showToast("Having trouble loading — trying another server…");
      launchPlayerAttempt(item, ctx, seek, PLAYER_FALLBACK_PROVIDER, token, false);
    }, PLAYER_WATCHDOG_MS);
  }
}
function startPlayer(item, ctx = {}, seekOffsetSec = null) {
  // Smart resume: if user pressed main Play (no ctx) on TV and last episode was finished, jump to next
  const last = progressMap[progressKey(item)];
  if (item.type === "tv" && !ctx.episode && last) {
    if (last.progress >= 95) {
      // Find next episode after last watched (s/e+1)
      // TV: try same season +1, fallback to s+1 e1
      ctx = { season: last.season || 1, episode: (last.episode || 0) + 1 };
      seekOffsetSec = 0; // start fresh
    } else if (last.season && last.episode) {
      // Resume same episode
      ctx = { season: last.season, episode: last.episode };
    }
  }
  // Smart resume: if user is <30s in, restart from 0
  const epLast = item.type === "tv" && ctx.episode
    ? progressMap[episodeProgressKey(item, ctx.season || 1, ctx.episode)]
    : last;
  if (epLast && epLast.timestamp && epLast.timestamp < 30 && seekOffsetSec == null) {
    seekOffsetSec = 0;
  }
  // Smart resume: movie finished -> restart
  if (item.type === "movie" && last?.progress >= 95 && seekOffsetSec == null) {
    seekOffsetSec = 0;
  }
  $("#modal-trailer").innerHTML = "";
  $(".modal-body").classList.add("playing");
  playerAttemptToken++;
  launchPlayerAttempt(item, ctx, seekOffsetSec, PROXY_PLAYER_BASE ? "videasy" : PLAYER_PROVIDER, playerAttemptToken, true);
  $("#modal").scrollTop = 0;

  playingItem = item;
  playingCtx = ctx;
  skipIntroShown = false;
  upNextShown = false;
  // Re-watch detection: starting a finished movie/show again increments count
  const lastP = progressMap[progressKey(item)];
  if (lastP?.progress >= 95) {
    rewatchMap[itemKey(item)] = (rewatchMap[itemKey(item)] || 1) + 1;
    saveRewatch();
  }
  // Start session (unless paused by privacy)
  if (!privacy.pauseSession) {
    currentSession = { start: Date.now(), itemKey: itemKey(item) };
  }
  // Track affinity in background
  trackAffinityForItem(item);
  if (upNextTimer) { clearInterval(upNextTimer); upNextTimer = null; }
  removeSkipIntro(); removeUpNext();
  nextEpContext = computeNextEpisode(item, ctx);
}

function removeSkipIntro() { document.querySelector(".player-overlay-skip")?.remove(); skipIntroShown = false; }
function removeUpNext() { document.querySelector(".player-overlay-upnext")?.remove(); upNextShown = false; if (upNextTimer) { clearInterval(upNextTimer); upNextTimer = null; } }

function showSkipIntro() {
  if (skipIntroShown) return;
  skipIntroShown = true;
  const btn = document.createElement("button");
  btn.className = "player-overlay-skip";
  btn.textContent = "Skip Intro »";
  btn.addEventListener("click", () => {
    if (!playingItem) return;
    // Avoid spamming reloads
    if (Date.now() - lastSkipSeek < 2000) return;
    lastSkipSeek = Date.now();
    const target = (lastTimestamp || 0) + 80;
    startPlayer(playingItem, playingCtx, target);
  });
  $("#player-wrap").appendChild(btn);
}

function showUpNext() {
  if (upNextShown || !nextEpContext) return;
  upNextShown = true;
  let count = 10;
  const ne = nextEpContext;
  const overlay = document.createElement("div");
  overlay.className = "player-overlay-upnext rich";
  overlay.innerHTML = `
    <div class="upnext-rich">
      ${ne.epThumb ? `<div class="upnext-thumb" style="background-image:url('${ne.epThumb}')"></div>` : ""}
      <div class="upnext-text">
        <div class="upnext-label">Up Next${ne.nextSeason ? " · NEW SEASON" : ""}</div>
        <div class="upnext-title">${escapeHTML(ne.epName || ne.label)}</div>
        <div class="upnext-sub">${escapeHTML(ne.seasonEp || "")}${ne.epRuntime ? ` · ${ne.epRuntime}m` : ""}</div>
        ${ne.epOverview ? `<div class="upnext-overview">${escapeHTML(ne.epOverview).slice(0, 180)}${ne.epOverview.length > 180 ? "…" : ""}</div>` : ""}
        <div class="upnext-countdown">Playing in <span class="upnext-count">${count}</span>s
          <span class="upnext-progress"><div style="width:0%"></div></span>
        </div>
        <div class="upnext-buttons">
          <button class="upnext-play">▶ Play Now</button>
          <button class="upnext-cancel">Cancel</button>
        </div>
      </div>
    </div>`;
  $("#player-wrap").appendChild(overlay);

  const updateProgress = () => {
    const pct = Math.round(((10 - count) / 10) * 100);
    overlay.querySelector(".upnext-progress > div").style.width = pct + "%";
    overlay.querySelector(".upnext-count").textContent = count;
  };
  updateProgress();
  upNextTimer = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(upNextTimer); upNextTimer = null;
      const next = nextEpContext;
      removeUpNext();
      if (next) startPlayer(next.item, next.ctx);
    } else {
      updateProgress();
    }
  }, 1000);
  overlay.querySelector(".upnext-play").addEventListener("click", () => {
    const next = nextEpContext;
    removeUpNext();
    if (next) startPlayer(next.item, next.ctx);
  });
  overlay.querySelector(".upnext-cancel").addEventListener("click", () => {
    removeUpNext();
  });
}

let lastTimestamp = 0;

function buildPlayerURL(item, ctx = {}, overrideSeek = null, providerOverride = null) {
  // Per-episode seek if applicable, else show-level
  let last;
  if (item.type === "tv" && ctx.episode) {
    last = progressMap[episodeProgressKey(item, ctx.season || 1, ctx.episode)] || progressMap[progressKey(item)];
  } else {
    last = progressMap[progressKey(item)];
  }
  let seek = overrideSeek != null ? Math.floor(overrideSeek) : (last?.timestamp ? Math.floor(last.timestamp) : null);
  // Don't seek if at the very end (would cause auto-finish loop)
  if (seek != null && last?.duration && seek > last.duration - 30) seek = null;

  // Provider-specific URL builders
  const provider = providerOverride || (PROXY_PLAYER_BASE ? "videasy" : PLAYER_PROVIDER);
  const base = providerOverride ? PLAYER_BASES[providerOverride] : PLAYER_BASE;

  if (provider === "vidlink") {
    // vidlink.pro - same path scheme as videasy
    const params = new URLSearchParams();
    params.set("primaryColor", PLAYER_COLOR);
    params.set("autoplay", "true");
    params.set("nextbutton", "true");
    let path;
    if (item.type === "movie") path = `/movie/${item.id}`;
    else path = `/tv/${item.id}/${ctx.season || 1}/${ctx.episode || 1}`;
    return `${base}${path}?${params.toString()}`;
  }

  if (provider === "vidsrc") {
    let path;
    if (item.type === "movie") path = `/movie/${item.id}`;
    else path = `/tv/${item.id}/${ctx.season || 1}/${ctx.episode || 1}`;
    return `${base}${path}`;
  }

  if (provider === "embedsu") {
    let path;
    if (item.type === "movie") path = `/movie/${item.id}`;
    else path = `/tv/${item.id}/${ctx.season || 1}/${ctx.episode || 1}`;
    return `${base}${path}`;
  }

  // Default: videasy
  const params = new URLSearchParams();
  params.set("color", PLAYER_COLOR);
  params.set("nextEpisode", "true");
  params.set("episodeSelector", "true");
  params.set("autoplayNextEpisode", "true");
  params.set("overlay", "true");
  if (seek != null) params.set("progress", seek);

  let path;
  if (item.type === "movie") path = `/movie/${item.id}`;
  else path = `/tv/${item.id}/${ctx.season || 1}/${ctx.episode || 1}`;
  return `${base}${path}?${params.toString()}`;
}

function closeModal() {
  clearTimeout(playerWatchdogTimer);
  document.body.style.overflow = "";
  currentItem = null;
  // End session
  if (currentSession) {
    const dur = Date.now() - currentSession.start;
    if (dur > 30000) { // only count sessions over 30s
      sessionsList.push({ start: currentSession.start, end: Date.now(), itemKey: currentSession.itemKey });
      // Trim to last 500 sessions
      if (sessionsList.length > 500) sessionsList = sessionsList.slice(-500);
      saveSessions();
    }
    currentSession = null;
  }
  playingItem = null; nextEpContext = null;
  removeSkipIntro(); removeUpNext();
  // Restore hero trailer if it was paused
  const heroIframe = $("#hero-trailer iframe");
  if (heroIframe && heroIframe.dataset.src && !heroIframe.src) heroIframe.src = heroIframe.dataset.src;
  // Fade out before hiding, rather than snapping away instantly — keep the
  // trailer/player visible underneath the fade so it doesn't flash blank.
  modalSessionToken++;
  const token = modalSessionToken;
  $("#modal").classList.add("closing");
  setTimeout(() => {
    if (token !== modalSessionToken) return; // a new title was opened during the fade
    $("#modal").classList.remove("closing");
    $("#modal").classList.add("hidden");
    $("#modal-trailer").innerHTML = "";
    $("#player-wrap").innerHTML = ""; $("#player-wrap").classList.remove("active");
    $(".modal-body").classList.remove("playing");
  }, 220);
}
function closeModalNav() {
  // Close immediately rather than relying on history.back() to do it —
  // that API has proven unreliable across browsers (sometimes needing two
  // calls, sometimes not firing at all in standalone/PWA contexts on iOS).
  // Our own close controls must not depend on it succeeding.
  closeModal();
  if (location.hash.startsWith("#/title/")) {
    history.replaceState(null, "", modalPreviousHash || "#/");
  }
  modalPreviousHash = null;
}
$(".modal-close").addEventListener("click", closeModalNav);
$(".modal-backdrop").addEventListener("click", closeModalNav);
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || $("#modal").classList.contains("hidden")) return;
  if (document.fullscreenElement) return;  // let the browser exit fullscreen; don't also close the modal
  closeModalNav();
});

$("#hero-play-btn").addEventListener("click", () => {
  if (!currentItem) return;
  if (currentItem.type === "tv") {
    const last = progressMap[progressKey(currentItem)];
    startPlayer(currentItem, { season: last?.season || 1, episode: last?.episode || 1 });
  } else startPlayer(currentItem);
});

$("#modal-mute-btn").addEventListener("click", () => {
  modalMuted = !modalMuted;
  $("#modal-mute-btn").textContent = modalMuted ? "✕" : "♪";
  $("#modal-mute-btn").setAttribute("aria-label", modalMuted ? "Unmute" : "Mute");
  postYTCommand($("#modal-trailer iframe"), modalMuted ? "mute" : "unMute");
});

// ---------- My List ----------
function toggleList(item) {
  const idx = myList.findIndex(x => x.id === item.id && x.type === item.type);
  if (idx >= 0) {
    myList.splice(idx, 1);
    showToast(`Removed "${item.title}" from My List`);
  } else {
    myList.push({
      id: item.id, type: item.type, title: item.title,
      poster: item.poster, backdrop: item.backdrop, backdropMd: item.backdropMd,
      overview: item.overview, year: item.year, rating: item.rating,
      isMovie: item.isMovie, episodes: item.episodes,
    });
    showToast(`Added "${item.title}" to My List`);
  }
  saveMyList();
  updateListButton();
}

// ---------- Toast ----------
let toastTimer;
function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.classList.add("hidden"), 300);
  }, 2500);
}
function updateListButton() {
  if (!currentItem) return;
  const inList = myList.some(x => x.id === currentItem.id && x.type === currentItem.type);
  $("#add-list").textContent = inList ? "✓" : "+";
  $("#add-list").title = inList ? "Remove from My List" : "Add to My List";
  $("#add-list").setAttribute("aria-label", inList ? "Remove from My List" : "Add to My List");
}
$("#add-list").addEventListener("click", (e) => { if (currentItem) { toggleList(currentItem); sparkleAt(e.currentTarget); } });

// ---------- Watch Progress ----------
window.addEventListener("message", (event) => {
  if (event.origin !== PLAYER_ORIGIN) return;  // only trust the embedded player iframe
  let data = event.data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { return; } }
  // The player wraps every event as {type:"PLAYER_EVENT", data:{event:"timeupdate", currentTime, duration, id, mediaType, season, episode}}
  // — it does NOT send a pre-computed percentage or flat top-level fields.
  if (!data || typeof data !== "object" || data.type !== "PLAYER_EVENT") return;
  const d = data.data;
  if (!d || d.event !== "timeupdate" || d.id == null) return;
  if (!currentItem) return;
  if (String(d.id) !== String(currentItem.id) || d.mediaType !== currentItem.type) return; // stale event from a previous title
  clearTimeout(playerWatchdogTimer); // the player is alive — no need for the fallback watchdog
  if (privacy.pauseProgress) return;  // privacy: skip progress saves

  const timestamp = d.currentTime || 0;
  const duration = d.duration || 0;
  const progress = duration > 0 ? Math.min(100, (timestamp / duration) * 100) : 0;
  const season = Number.isFinite(d.season) ? d.season : undefined;
  const episode = Number.isFinite(d.episode) ? d.episode : undefined;

  progressMap[progressKey(currentItem)] = {
    progress, timestamp, duration,
    season, episode, updatedAt: Date.now(),
    title: currentItem.title, poster: currentItem.poster, backdrop: currentItem.backdrop, backdropMd: currentItem.backdropMd,
    overview: currentItem.overview, year: currentItem.year, rating: currentItem.rating,
    itemType: currentItem.type, itemId: currentItem.id,
    isMovie: currentItem.isMovie, episodes: currentItem.episodes,
    genreIds: modalDetails?.genres?.map(g => g.id) || progressMap[progressKey(currentItem)]?.genreIds,
  };
  // Per-episode progress tracking (Netflix-style: every watched episode keeps its own bar)
  if (currentItem.type === "tv" && episode) {
    const epKey = episodeProgressKey(currentItem, season || 1, episode);
    progressMap[epKey] = {
      progress, timestamp, duration,
      season: season || 1,
      episode,
      updatedAt: Date.now(),
      isEpisode: true,
    };
  }
  saveProgress();

  // ----- Skip Intro & Up Next overlays -----
  lastTimestamp = timestamp;
  const isEpisodeContent = playingItem && playingItem.type === "tv";
  // Skip Intro: show during 5s..120s of episode runtime (and only briefly)
  if (isEpisodeContent) {
    if (timestamp >= 5 && timestamp <= 120) {
      if (!skipIntroShown) showSkipIntro();
    } else if (skipIntroShown && timestamp > 130) {
      removeSkipIntro();
    }
  }
  // Up Next: in last ~25 seconds, with a known next episode
  if (nextEpContext && duration > 60) {
    const remaining = duration - timestamp;
    if (remaining > 0 && remaining <= 25 && !upNextShown) showUpNext();
  }
});

// Our own fullscreen control for the player: third-party embeds (videasy in
// particular) often ship a fullscreen button whose click handler silently
// fails — e.g. blocked by browser ad/tracker shields since the embed is a
// known ad-monetized domain — leaving the icon toggling with no visible
// effect. Fullscreening the wrapper div ourselves (same-origin, always
// trusted) sidesteps that entirely; the iframe already fills the wrapper.
document.addEventListener("click", (e) => {
  if (!e.target.closest("#player-fs-btn")) return;
  const wrap = $("#player-wrap");
  if (document.fullscreenElement === wrap) document.exitFullscreen();
  else wrap.requestFullscreen?.().catch(() => {});
});
document.addEventListener("fullscreenchange", () => {
  const btn = document.getElementById("player-fs-btn");
  if (!btn) return;
  const isFs = document.fullscreenElement === $("#player-wrap");
  btn.textContent = isFs ? "⤡" : "⛶";
  btn.title = isFs ? "Exit Fullscreen" : "Fullscreen";
  btn.setAttribute("aria-label", btn.title);
});

function progressKey(item) { return `${item.type}:${item.id}`; }
function episodeProgressKey(item, season, episode) { return `${item.type}:${item.id}:s${season}:e${episode}`; }
// A show-level progress entry's `timestamp` is just the playback position of
// the last-watched episode. For TV with per-episode tracking, that same
// position is already represented by an `.isEpisode` entry, so summing both
// double-counts it. Movies never get per-episode entries, so their own
// timestamp remains the only source for them.
function hasEpisodeTracking(v) {
  // Per-episode entries don't carry itemType/itemId of their own — the show
  // they belong to is only encoded in their progressMap key (see
  // episodeProgressKey), so match on the key prefix instead.
  const prefix = `${v.itemType}:${v.itemId}:s`;
  return Object.entries(progressMap).some(([k, ev]) => ev.isEpisode && k.startsWith(prefix));
}
async function getRecommendedForYou() {
  // Seed from My List + most recent Continue Watching
  const seeds = [];
  const seen = new Set();
  const cw = getContinueWatching().slice(0, 3);
  cw.forEach(it => { const k = `${it.type}:${it.id}`; if (!seen.has(k) && it.type !== "youtube") { seen.add(k); seeds.push(it); } });
  myList.slice(-3).forEach(it => { const k = `${it.type}:${it.id}`; if (!seen.has(k) && it.type !== "youtube") { seen.add(k); seeds.push(it); } });
  if (!seeds.length) return [];

  const recs = new Map(); // key -> { item, score }
  await Promise.all(seeds.slice(0, 5).map(async (s, i) => {
    try {
      const data = await tmdb(`/${s.type}/${s.id}/recommendations`);
      data.results.forEach((r, j) => {
        if (!r.backdrop_path || !r.poster_path) return;
        const key = `${s.type}:${r.id}`;
        if (seen.has(key)) return;
        const item = normalizeTMDB(r, s.type);
        // Score: higher for earlier seeds and earlier results
        const score = (5 - i) * 10 + (20 - j) + (parseFloat(item.rating) || 0);
        const existing = recs.get(key);
        if (!existing || score > existing.score) recs.set(key, { item, score });
      });
    } catch {}
  }));
  return [...recs.values()].sort((a, b) => b.score - a.score).slice(0, 20).map(x => x.item);
}

function getContinueWatching() {
  return Object.entries(progressMap)
    .filter(([k, v]) => !v.isEpisode && v.progress > 1 && v.progress < 95 && !dismissedMap[k] && !hiddenMap[k])
    .sort((a, b) => {
      // Sort by "almost finished" first (>75%), then by recency
      const aAlmost = a[1].progress > 75;
      const bAlmost = b[1].progress > 75;
      if (aAlmost !== bAlmost) return bAlmost - aAlmost;
      return (b[1].updatedAt || 0) - (a[1].updatedAt || 0);
    })
    .slice(0, 20)
    .map(([, v]) => ({
      id: v.itemId, type: v.itemType, title: v.title,
      poster: v.poster, backdrop: v.backdrop, backdropMd: v.backdropMd,
      overview: v.overview, year: v.year, rating: v.rating,
      isMovie: v.isMovie, episodes: v.episodes,
      channelTitle: v.channelTitle, publishedAt: v.publishedAt,
    }));
}

// ---------- URL routing ----------
function navTo(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
let lastNonModalHash = "#/";
async function route() {
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/?(.*)$/);
  const path = (m?.[1] || "").split("?")[0];
  const queryStr = hash.split("?")[1] || "";
  const params = new URLSearchParams(queryStr);
  const parts = path.split("/").filter(Boolean);

  // Modal route: #/title/{type}/{id} (?back=<encoded-prev-hash>)
  if (parts[0] === "title" && parts[1] && parts[2]) {
    // Re-render even if a modal is already open, so back/forward between two
    // different titles (e.g. navigated via "More Like This") shows the right one.
    const isSameTitle = currentItem && currentItem.type === parts[1] && String(currentItem.id) === parts[2];
    if ($("#modal").classList.contains("hidden") || !isSameTitle) await openTitleByRoute(parts[1], parts[2]);
    return;
  }
  // Otherwise close any open modal silently
  if (!$("#modal").classList.contains("hidden")) closeModalSilent();

  // Smooth cross-fade between non-modal pages (skip on first paint)
  const c = $("#content");
  if (lastNonModalHash !== hash) {
    c.classList.add("transitioning");
    await new Promise(r => setTimeout(r, 180));
  }
  lastNonModalHash = hash;
  // Run page render synchronously then fade back in next frame
  const finish = () => requestAnimationFrame(() => c.classList.remove("transitioning"));

  $("#search").value = "";
  document.body.classList.remove("no-hero");

  let p;
  if (!parts.length) p = showHome();
  else if (parts[0] === "movies") {
    if (parts[1] === "genre" && parts[2]) p = showCategory("movie", +parts[2]);
    else p = showCategory("movie");
  }
  else if (parts[0] === "tv") {
    if (parts[1] === "genre" && parts[2]) p = showCategory("tv", +parts[2]);
    else p = showCategory("tv");
  }
  else if (parts[0] === "new") p = showNewPopular();
  else if (parts[0] === "list") { showMyList(); p = Promise.resolve(); }
  else if (parts[0] === "stats") { p = showStats(); }
  else if (parts[0] === "history") { showHistory(); p = Promise.resolve(); }
  else if (parts[0] === "recap") { showYearRecap(); p = Promise.resolve(); }
  else if (parts[0] === "hidden") { showHiddenTitles(); p = Promise.resolve(); }
  else if (parts[0] === "tag" && parts[1]) { p = showByTag(decodeURIComponent(parts[1])); }
  else if (parts[0] === "library") { showLibrary(parts[1] || "watching"); p = Promise.resolve(); }
  else if (parts[0] === "achievements") { showAchievements(); p = Promise.resolve(); }
  else if (parts[0] === "privacy") { showPrivacy(); p = Promise.resolve(); }
  else if (parts[0] === "person" && parts[1]) p = showPerson(parts[1]);
  else if (parts[0] === "youtube" && parts[1]) p = showYouTubeChannelPage(parts[1]);
  else if (parts[0] === "search") {
    const q = params.get("q") || "";
    $("#search").value = q;
    p = q ? searchAll(q) : showHome();
  }
  else p = showHome();
  Promise.resolve(p).finally(finish);
}

async function openTitleByRoute(type, id) {
  try {
    const data = await tmdb(`/${type}/${id}`);
    const item = normalizeTMDB({
      id: data.id, media_type: type,
      title: data.title, name: data.name,
      poster_path: data.poster_path, backdrop_path: data.backdrop_path,
      overview: data.overview,
      release_date: data.release_date, first_air_date: data.first_air_date,
      vote_average: data.vote_average, vote_count: data.vote_count,
    }, type);
    openModal(item);
  } catch (e) { console.warn("Failed to load title", e); showHome(); }
}

function openTitle(item) {
  navTo(`#/title/${item.type}/${item.id}`);
}

function closeModalSilent() {
  clearTimeout(playerWatchdogTimer);
  $("#modal").classList.add("hidden");
  $("#modal-trailer").innerHTML = "";
  $("#player-wrap").innerHTML = ""; $("#player-wrap").classList.remove("active");
  $(".modal-body").classList.remove("playing");
  document.body.style.overflow = "";
  currentItem = null;
  modalPreviousHash = null;
  // End session
  if (currentSession) {
    const dur = Date.now() - currentSession.start;
    if (dur > 30000) { // only count sessions over 30s
      sessionsList.push({ start: currentSession.start, end: Date.now(), itemKey: currentSession.itemKey });
      // Trim to last 500 sessions
      if (sessionsList.length > 500) sessionsList = sessionsList.slice(-500);
      saveSessions();
    }
    currentSession = null;
  }
  playingItem = null; nextEpContext = null;
  removeSkipIntro(); removeUpNext();
  const heroIframe = $("#hero-trailer iframe");
  if (heroIframe && heroIframe.dataset.src && !heroIframe.src) heroIframe.src = heroIframe.dataset.src;
}

window.addEventListener("hashchange", route);
// Belt-and-suspenders: popstate is the more direct signal that history
// navigation happened (back/forward). route() is idempotent against the
// current hash, so a redundant call alongside hashchange is harmless.
window.addEventListener("popstate", route);

// ---------- Nav ----------
// One class drives two different behaviors depending on viewport: on
// desktop it collapses the sidebar to icons-only; on narrow screens the
// sidebar starts off-canvas and this toggles it open as an overlay.
const MOBILE_NAV_BREAKPOINT = 900;
function setMobileNavOpen(open) {
  $("#app").classList.toggle("sidebar-toggled", open);
  $("#nav-hamburger").setAttribute("aria-expanded", open ? "true" : "false");
  if (window.innerWidth > MOBILE_NAV_BREAKPOINT) {
    localStorage.setItem(STORAGE.sidebarCollapsed, open ? "1" : "0");
  }
}
if (window.innerWidth > MOBILE_NAV_BREAKPOINT && localStorage.getItem(STORAGE.sidebarCollapsed) === "1") {
  $("#app").classList.add("sidebar-toggled");
}
$("#nav-hamburger").addEventListener("click", () => {
  setMobileNavOpen(!$("#app").classList.contains("sidebar-toggled"));
});
document.addEventListener("click", e => {
  if (window.innerWidth > MOBILE_NAV_BREAKPOINT) return; // desktop collapse persists until re-toggled
  if (!e.target.closest("#sidebar") && !e.target.closest("#nav-hamburger")) setMobileNavOpen(false);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && window.innerWidth <= MOBILE_NAV_BREAKPOINT) setMobileNavOpen(false);
});

$$("#navbar-nav [data-nav]").forEach(a => {
  a.addEventListener("click", e => {
    setMobileNavOpen(false);
    const nav = a.dataset.nav;
    if (nav === "home") { e.preventDefault(); navTo("#/"); }
    else if (nav === "movies") { e.preventDefault(); navTo("#/movies"); }
    else if (nav === "tv") { e.preventDefault(); navTo("#/tv"); }
    else if (nav === "new") { e.preventDefault(); navTo("#/new"); }
    else if (nav === "mylist") { e.preventDefault(); navTo("#/list"); }
    else if (nav === "history") { e.preventDefault(); setProfileMenuOpen(false); navTo("#/history"); }
    // Everything else (stats, yt-*) has a real href — let the natural hash navigation happen.
  });
});

let searchTimer;
let suggestItems = [];
let suggestFocusIdx = -1;

async function showSuggestions(q) {
  const box = $("#search-suggest");
  try {
    const data = await tmdb("/search/multi", { query: q });
    suggestItems = data.results
      .filter(r => (r.media_type === "movie" || r.media_type === "tv") && r.poster_path)
      .slice(0, 7)
      .map(r => normalizeTMDB(r));
    if (!suggestItems.length) {
      box.innerHTML = `<div class="suggest-empty">No matches for "${escapeHTML(q)}"</div>`;
      box.classList.remove("hidden");
      return;
    }
    box.innerHTML = suggestItems.map((it, i) => `
      <div class="suggest-item" data-idx="${i}">
        <div class="sug-thumb" style="background-image:url('${it.poster}')"></div>
        <div class="sug-info">
          <div class="sug-title">${escapeHTML(it.title)}</div>
          <div class="sug-meta">
            <span class="type-pill">${typeLabel(it)}</span>
            ${it.rating ? `<span class="rating-star">★ ${it.rating}</span>` : ""}
            <span>${it.year || ""}</span>
          </div>
        </div>
      </div>`).join("");
    suggestFocusIdx = -1;
    box.classList.remove("hidden");
    $$(".suggest-item", box).forEach(el => {
      el.addEventListener("click", () => {
        const idx = +el.dataset.idx;
        const item = suggestItems[idx];
        if (item) { hideSuggestions(); openTitle(item); }
      });
    });
  } catch {
    box.classList.add("hidden");
  }
}
function hideSuggestions() {
  $("#search-suggest").classList.add("hidden");
  suggestFocusIdx = -1;
}

$("#search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { hideSuggestions(); if (location.hash.startsWith("#/search")) navTo("#/"); return; }
  searchTimer = setTimeout(() => showSuggestions(q), 220);
});

$("#search").addEventListener("keydown", e => {
  const box = $("#search-suggest");
  const visible = !box.classList.contains("hidden") && suggestItems.length;
  if (e.key === "Enter") {
    e.preventDefault();
    if (visible && suggestFocusIdx >= 0) {
      hideSuggestions();
      openTitle(suggestItems[suggestFocusIdx]);
    } else {
      const q = $("#search").value.trim();
      if (q) { hideSuggestions(); navTo(`#/search?q=${encodeURIComponent(q)}`); }
    }
  } else if (e.key === "ArrowDown" && visible) {
    e.preventDefault();
    suggestFocusIdx = Math.min(suggestItems.length - 1, suggestFocusIdx + 1);
    $$(".suggest-item", box).forEach((el, i) => el.classList.toggle("focused", i === suggestFocusIdx));
  } else if (e.key === "ArrowUp" && visible) {
    e.preventDefault();
    suggestFocusIdx = Math.max(-1, suggestFocusIdx - 1);
    $$(".suggest-item", box).forEach((el, i) => el.classList.toggle("focused", i === suggestFocusIdx));
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box-wrap")) hideSuggestions();
});
$("#search").addEventListener("focus", () => {
  const q = $("#search").value.trim();
  if (q) showSuggestions(q);
});

// Icon-only search that expands on click (Netflix-style), collapses back
// when it loses focus with nothing typed in it.
$("#search-icon").addEventListener("click", () => {
  $("#search-box").classList.add("open");
  $("#search").focus();
});
$("#search").addEventListener("blur", () => {
  if (!$("#search").value.trim()) $("#search-box").classList.remove("open");
});

// ---------- Keyboard navigation ----------
document.addEventListener("keydown", (e) => {
  // ESC handled in modal; here we focus + arrow navigate cards
  const f = document.activeElement;
  if (!f || !f.classList?.contains("card")) return;
  if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) e.preventDefault();
  if (e.key === "ArrowLeft") f.previousElementSibling?.focus?.();
  else if (e.key === "ArrowRight") f.nextElementSibling?.focus?.();
  else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    // Find the same horizontal index in next/prev row
    const row = f.closest(".row, .search-grid");
    const cards = $$(".card");
    const idx = cards.indexOf(f);
    if (idx < 0) return;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    // Step until we leave current row container
    for (let i = idx + dir; i >= 0 && i < cards.length; i += dir) {
      if (cards[i].closest(".row, .search-grid") !== row) {
        cards[i].focus(); cards[i].scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
    }
  }
});

window.addEventListener("scroll", () => {
  $("#navbar").classList.toggle("scrolled", window.scrollY > 20);
});

// ---------- Auth screen ----------
let authMode = "signin"; // "signin" | "signup"

function showLoginScreen() {
  stopCloudListener();
  $("#boot-screen").classList.add("hidden");
  $("#app").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
}
function showAuthError(msg) {
  const el = $("#login-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function clearAuthError() {
  $("#login-error").classList.add("hidden");
  $("#login-error").textContent = "";
}
$("#login-switch-link").addEventListener("click", (e) => {
  e.preventDefault();
  authMode = authMode === "signin" ? "signup" : "signin";
  clearAuthError();
  if (authMode === "signup") {
    $("#login-title").textContent = "Sign Up";
    $("#login-submit").textContent = "Sign Up";
    $("#login-switch-text").textContent = "Already have an account?";
    $("#login-switch-link").textContent = "Sign in";
    $("#login-password").setAttribute("autocomplete", "new-password");
  } else {
    $("#login-title").textContent = "Sign In";
    $("#login-submit").textContent = "Sign In";
    $("#login-switch-text").textContent = "New to MovieTube?";
    $("#login-switch-link").textContent = "Sign up now";
    $("#login-password").setAttribute("autocomplete", "current-password");
  }
});
const AUTH_ERROR_MESSAGES = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/user-not-found": "No account with that email. Try signing up instead.",
  "auth/wrong-password": "Incorrect password.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/email-already-in-use": "An account with that email already exists. Try signing in instead.",
  "auth/weak-password": "Password must be at least 6 characters.",
  "auth/too-many-requests": "Too many attempts — please wait a moment and try again.",
  "auth/network-request-failed": "Network error — check your connection and try again.",
};
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthError();
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const btn = $("#login-submit");
  btn.disabled = true;
  try {
    if (authMode === "signup") {
      await fbAuth.createUserWithEmailAndPassword(email, password);
    } else {
      await fbAuth.signInWithEmailAndPassword(email, password);
    }
    // onAuthStateChanged picks up from here
  } catch (err) {
    showAuthError(AUTH_ERROR_MESSAGES[err.code] || err.message);
  } finally {
    btn.disabled = false;
  }
});

async function enterApp(user) {
  currentUser = user;
  await pullCloudDataOnce();
  loadProfileData();
  migrateEpisodeProgress();
  checkBedtime();
  startCloudListener();
  $("#boot-screen").classList.add("hidden");
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  const initial = (user.email || "?").trim().charAt(0).toUpperCase();
  const avatar = $("#profile-avatar-mini");
  avatar.textContent = initial;
  avatar.style.cssText += `display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;background:var(--accent);`;
  $("#profile-menu-email").textContent = user.email || "";
  route();
  renderBudgetGauge();
  maybeShowOnboarding();
  maybeShowYearRecap();
  setTimeout(maybeShowResumePrompt, 1800);
}

function maybeShowOnboarding() {
  if (localStorage.getItem(STORAGE.onboarded)) return;
  setTimeout(() => {
    showToast("Tip: hover a poster to preview · type to search · Esc closes any modal");
    localStorage.setItem(STORAGE.onboarded, "1");
  }, 1200);
}
function maybeShowYearRecap() {
  const year = String(new Date().getFullYear());
  if (localStorage.getItem(STORAGE.recapShown) === year) return;
  const yearStart = new Date(+year, 0, 1).getTime();
  const hasActivity = Object.values(progressMap).some(v => v.title && (v.updatedAt || 0) >= yearStart);
  if (!hasActivity) return;
  setTimeout(() => {
    showToast(`Your ${year} Recap is ready — find it from Stats or the footer`);
    localStorage.setItem(STORAGE.recapShown, year);
  }, 3000);
}
function setProfileMenuOpen(open) {
  $("#profile-pill").classList.toggle("open", open);
  $("#profile-pill").setAttribute("aria-expanded", open ? "true" : "false");
}
$("#profile-pill").addEventListener("click", e => {
  if (e.target.closest(".profile-menu")) return;
  setProfileMenuOpen(!$("#profile-pill").classList.contains("open"));
});
$("#profile-pill").addEventListener("keydown", e => {
  if (e.target.closest(".profile-menu")) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    setProfileMenuOpen(!$("#profile-pill").classList.contains("open"));
  } else if (e.key === "Escape") {
    setProfileMenuOpen(false);
  }
});
document.addEventListener("click", e => {
  if (!e.target.closest("#profile-pill")) setProfileMenuOpen(false);
});
$("#logout-btn").addEventListener("click", async (e) => {
  e.preventDefault();
  setProfileMenuOpen(false);
  await flushCloudSync();
  await fbAuth.signOut();
});
$("#clear-data").addEventListener("click", e => {
  e.preventDefault();
  if (confirm("Clear continue-watching and My List for this account?")) {
    progressMap = {}; myList = [];
    saveProgress(); saveMyList();
    route();
  }
  setProfileMenuOpen(false);
});

// ---------- Boot ----------
fbAuth.onAuthStateChanged(user => {
  if (user) enterApp(user);
  else { currentUser = null; showLoginScreen(); }
});

// PWA: register service worker (best effort) and self-update
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then(reg => {
      reg.update?.();
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "activated") location.reload();
        });
      });
    }).catch(() => {});
  });
}
