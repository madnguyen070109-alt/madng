// ============================================================
// SyncStep — shared script.js across all pages
// Runs the MediaPipe Pose Landmarker for live webcam pose
// detection, the YouTube reference player + synced skeleton
// overlay on practice.html, and page-specific wiring for
// library.html / admin.html.
// ============================================================

// NOTE: pinned to an exact version (not @latest) — the JS wrapper and
// the WASM binary must match exactly, or MediaPipe throws internal
// errors like "ASM_CONSTS[code] is not a function". Check
// https://www.npmjs.com/package/@mediapipe/tasks-vision for the current
// stable release before bumping this.
//
// IMPORTANT: static `import ... from` requires a literal string, so the
// version is hardcoded here directly. The MEDIAPIPE_VERSION constant
// below is used for the WASM fileset path (a runtime fetch, so a
// template literal is fine there) — if you bump the version, update
// BOTH this import line and the constant so they stay in sync.
import {
  PoseLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const MEDIAPIPE_VERSION = "0.10.14";

// All non-practice features (auth, bookmarks, community, profile, admin, scoring)
import "./app.js";

import { db, storage } from "/firebase-init.js";
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { ref as storageRef, getDownloadURL, listAll } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";
// ---- Shared state -------------------------------------------------
let poseLandmarker;            // MediaPipe Pose Landmarker instance
let skeletonData = null;       // reference skeleton JSON for the current member
let syncIntervalId = null;     // handle for the reference-sync polling loop
let webcamLoopActive = false;  // guards the live-detection requestAnimationFrame loop
let webcamStream = null;       // active MediaStream, kept so its tracks can be stopped

// Only runs on practice.html (these elements won't exist on other pages)
const referenceCanvas = document.getElementById('reference-overlay');
const liveCanvas = document.getElementById('live-overlay');
const webcamVideoEl = document.getElementById('webcam-feed');
const startCameraBtn = document.getElementById('start-camera-btn');
const stopCameraBtn = document.getElementById('stop-camera-btn');

// Elements used by sizeScoreRectToVideo()
const scoreRect = document.querySelector('.score-rect');
const videoWrap = document.getElementById('video-wrap');

// Both practice boxes are 9:16 and the same height now, so the score box
// no longer has to be stretched to line up with the video. Kept as a
// function (and still called from the places below) so those call sites
// don't need to change — it just clears any leftover inline height.
function sizeScoreRectToVideo() {
  if (scoreRect) scoreRect.style.height = '';
}

// ============================================================
// YOUTUBE PLAYER — practice.html
// ============================================================
let ytPlayer;
let currentMember = null; // matched entry from dance.members, holds skeletonUrl
let currentDanceData = null; // full dance doc -- needed for loopSections

// Practice-controls state (speed/loop/mirror/phantom) -- read by the
// sync loop and the webcam detection loop below.
let activeLoop = null;      // { start, end } in seconds, or null when off
let mirrorEnabled = false;
let phantomEnabled = false;

// Read-only hooks for app.js (scoring). Function declarations are hoisted,
// so referencing findClosestKeyframe here is safe.
window.__syncstep = {
  getPlayer: () => ytPlayer,
  getKeyframe: (t) => findClosestKeyframe(t),
  getDance: () => currentDanceData,
  getMember: () => currentMember,
  getLoop: () => activeLoop
};

// YouTube's script calls this automatically once its API has loaded —
// name/signature are fixed by the API, don't rename it. It can't be
// declared async itself, so it delegates to an async helper.
window.onYouTubeIframeAPIReady = function () {
  if (!document.getElementById('yt-player')) return; // not on practice.html
  loadDanceAndCreatePlayer();
};

// Accepts a full YouTube URL (watch?v=, youtu.be/, embed/) or a bare
// 11-char ID and returns just the ID that YT.Player actually needs.
function extractYouTubeId(urlOrId) {
  if (!urlOrId) return null;

  if (/^[\w-]{11}$/.test(urlOrId)) return urlOrId; // already a bare ID

  try {
    const url = new URL(urlOrId);
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.slice(1); // youtu.be/<id>
    }
    if (url.searchParams.has('v')) {
      return url.searchParams.get('v'); // watch?v=<id>
    }
    const embedMatch = url.pathname.match(/\/embed\/([\w-]{11})/);
    if (embedMatch) return embedMatch[1]; // embed/<id>
  } catch {
    // not a valid URL — fall through
  }

  console.warn(`Couldn't extract a video ID from "${urlOrId}"`);
  return null;
}

async function loadDanceAndCreatePlayer() {
  const params = new URLSearchParams(window.location.search);
  const danceId = params.get('dance');
  const videoParam = params.get('video'); // may be a full URL or a bare ID

  if (!danceId || !videoParam) {
    console.error('practice.html needs both ?dance=<danceId>&video=<youtubeVideoId> in the URL.');
    return;
  }

  const danceSnap = await getDoc(doc(db, 'dances', danceId));
  if (!danceSnap.exists()) {
    console.error(`No dance found for ID "${danceId}".`);
    location.replace('library.html');
    return;
  }

  const danceData = danceSnap.data();
  currentDanceData = danceData;

  // Match against the raw stored value (whatever format is in Firestore),
  // not the extracted ID, since dance.members stores the original value.
  currentMember = danceData.members?.find(m => m.youtubeVideoId === videoParam) || null;

  if (!currentMember) {
    console.warn(`Video "${videoParam}" isn't listed under any member of dance "${danceId}" — skeleton overlay won't load.`);
  }

  // Loop pills depend only on the dance doc, not on the player being
  // ready yet -- populate as soon as the data's in hand.
  populateLoopPills(danceData.loopSections || []);

  const videoId = extractYouTubeId(videoParam);
  if (!videoId) {
    console.error('Could not resolve a playable YouTube video ID.');
    return;
  }

  ytPlayer = new YT.Player('yt-player', {
    videoId,
    playerVars: {
      controls: 1,
      rel: 0,
      modestbranding: 1
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange
    }
  });
}

function onPlayerReady() {
  sizeOverlayToPlayer();
  loadSkeletonData(currentMember); // fetch this member's skeleton JSON, ready for the sync loop
}

function onPlayerStateChange() {
  // Keep the loop alive in every state so the ghost outline also draws
  // while paused or scrubbing (it's a cheap 100ms poll). Idempotent.
  startSyncLoop(() => ytPlayer.getCurrentTime());
}

// Matches the overlay canvas's pixel size to the YouTube iframe underneath
// it so drawn joint coordinates line up with the video.
function sizeOverlayToPlayer() {
  if (referenceCanvas && videoWrap && videoWrap.clientWidth) {
    referenceCanvas.width = videoWrap.clientWidth;
    referenceCanvas.height = videoWrap.clientHeight;
  }
  const webcamWrapEl = document.getElementById('webcam-wrap');
  if (liveCanvas && webcamWrapEl && webcamWrapEl.clientWidth) {
    liveCanvas.width = webcamWrapEl.clientWidth;
    liveCanvas.height = webcamWrapEl.clientHeight;
  }
}
// Re-size whenever the layout changes (window resize, view switch, rotation)
if ('ResizeObserver' in window) {
  const ro = new ResizeObserver(() => { sizeOverlayToPlayer(); sizeScoreRectToVideo(); });
  if (videoWrap) ro.observe(videoWrap);
  const ww = document.getElementById('webcam-wrap');
  if (ww) ro.observe(ww);
}

// ============================================================
// REFERENCE SKELETON DATA + SYNC LOOP
// ============================================================

function setSkeletonStatus(msg, bad = false) {
  const el = document.getElementById('skeleton-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('bad', bad);
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'member';

// Returns a browser-fetchable https URL for the member's skeleton file.
//  1. gs:// paths stored in Firestore are converted via Storage
//  2. https URLs are used as-is
//  3. no URL stored -> look in Storage under skeletons/<danceId>/
async function resolveSkeletonUrl(member) {
  if (!member) return null;

  if (member.skeletonUrl) {
    if (/^gs:\/\//.test(member.skeletonUrl)) {
      try {
        return await getDownloadURL(storageRef(storage, member.skeletonUrl));
      } catch (err) {
        console.warn('Could not resolve gs:// skeleton URL:', err);
      }
    } else {
      return member.skeletonUrl;
    }
  }

  const danceId = new URLSearchParams(location.search).get('dance');
  const base = slugify(member.Name);

  try {
    return await getDownloadURL(storageRef(storage, `skeletons/${danceId}/${base}.json`));
  } catch { /* not at the conventional path, try listing */ }

  try {
    const { items } = await listAll(storageRef(storage, `skeletons/${danceId}`));
    const hit = items.find(i => slugify(i.name.replace(/\.json$/i, '')).includes(base));
    if (hit) return await getDownloadURL(hit);
  } catch (err) {
    console.warn('Storage lookup for skeleton failed:', err);
  }
  return null;
}

// Accepts [{x,y,visibility}] or [[x,y,z,vis]]; converts pixel coords to 0..1.
// Null/missing landmarks are kept as null so indices stay aligned.
function normalizeJoints(raw, W, H) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const pts = raw.map(p => {
    if (!p) return null;
    return Array.isArray(p)
      ? { x: p[0], y: p[1], z: p[2], visibility: p[3] }
      : { x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? p.v ?? p.score };
  });
  const real = pts.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!real.length) return null;
  const maxVal = Math.max(...real.map(p => Math.max(p.x, p.y)));
  if (maxVal > 2) {
    if (!W || !H) { console.warn('Skeleton looks like pixel coords but file has no width/height'); return null; }
    real.forEach(p => { p.x /= W; p.y /= H; });
  }
  return pts;
}

async function loadSkeletonData(member) {
  const skeletonUrl = await resolveSkeletonUrl(member);
  if (!skeletonUrl) {
    setSkeletonStatus(
      member
        ? 'Ghost outline unavailable: no skeleton file found in the library or in Storage for this member.'
        : "Ghost outline unavailable: this video isn't listed under any member of this dance.",
      true
    );
    return;
  }
  try {
    const res = await fetch(skeletonUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json();
    let meta = {};
    if (!Array.isArray(data)) {
      meta = data;
      data = data.frames || data.keyframes || data.skeleton || [];
    }
    if (!data.length) throw new Error('file has no frames');

    // Frames may store points as joints / landmarks / keypoints / pose;
    // everything downstream (drawing + scoring) reads `.joints`.
    const W = meta.width || meta.frame_width || meta.videoWidth;
    const H = meta.height || meta.frame_height || meta.videoHeight;
    data = data
      .map(f => ({
        t: f.t ?? f.time ?? f.timestamp ?? 0,
        joints: normalizeJoints(f.joints || f.landmarks || f.keypoints || f.pose, W, H)
      }))
      .filter(f => f.joints);
    if (!data.length) throw new Error('no usable joints in file');

    // If timestamps look like milliseconds, convert to seconds
    const duration = ytPlayer?.getDuration?.() || 0;
    const lastT = data[data.length - 1].t;
    if ((duration && lastT > duration * 20) || (!duration && lastT > 10000)) {
      data = data.map(f => ({ ...f, t: f.t / 1000 }));
    }

    data.sort((a, b) => a.t - b.t);
    skeletonData = data;
    setSkeletonStatus('');
    sizeOverlayToPlayer();
    startSyncLoop(() => ytPlayer.getCurrentTime()); // don't wait for a player state change
  } catch (err) {
    console.error('Skeleton load failed:', err);
    setSkeletonStatus('Ghost outline failed to load (' + err.message + '). If this says "Failed to fetch", check the Storage CORS settings and that the URL is an https download URL.', true);
  }
}

// Polls playback time every 100ms, finds the closest matching keyframe
// in the skeleton data, and redraws the overlay at that keyframe.
function startSyncLoop(getCurrentTimeFn) {
  if (syncIntervalId) return; // already running
  syncIntervalId = setInterval(() => {
    if (typeof getCurrentTimeFn !== 'function') return;
    const currentTime = getCurrentTimeFn();

    // Loop enforcement: once playback reaches the active section's end,
    // jump back to its start. Runs for as long as a loop pill (other
    // than "Off") is selected -- see populateLoopPills() below.
    if (activeLoop && ytPlayer.getPlayerState?.() === YT.PlayerState.PLAYING && currentTime >= activeLoop.end) {
      ytPlayer.seekTo(activeLoop.start, true);
      return; // skip drawing this tick -- next poll picks up post-seek
    }

    const keyframe = findClosestKeyframe(currentTime);
    // skeletonData entries are { t, joints: [...] } -- draw the joints
    // array itself, not the frame wrapper object (drawSkeleton expects
    // a flat landmarks array indexable by pose-landmark index).
    drawSkeleton(referenceCanvas, keyframe?.joints, { opacity: 1 });
  }, 100);
}

function stopSyncLoop() {
  clearInterval(syncIntervalId);
  syncIntervalId = null;
}

function findClosestKeyframe(currentTime) {
  if (!skeletonData || skeletonData.length === 0) return null;
  // Simple nearest-timestamp lookup — fine at 100ms polling resolution.
  return skeletonData.reduce((closest, frame) =>
    Math.abs(frame.t - currentTime) < Math.abs(closest.t - currentTime) ? frame : closest
  );
}

// ============================================================
// MEDIAPIPE POSE LANDMARKER (live webcam detection)
// ============================================================

async function initPoseLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
  );

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numPoses: 1
  });
}

// Webcam access requires a user gesture — wired to the "Start Camera" button
// rather than requested automatically on page load.
async function startCamera() {
  try {
    // Ask for a portrait 9:16 stream (phones honor this). Most desktop
    // webcams are landscape and ignore it -- coverMap() below handles that.
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 720 },
        height: { ideal: 1280 },
        aspectRatio: { ideal: 9 / 16 }
      }
    });
    webcamVideoEl.srcObject = webcamStream;
    await webcamVideoEl.play();

    liveCanvas.width = webcamVideoEl.clientWidth;
    liveCanvas.height = webcamVideoEl.clientHeight;

    webcamLoopActive = true;
    requestAnimationFrame(detectWebcamLoop);

    // Swap which button is visible — waits until permission actually
    // succeeds, so a denial leaves Start visible instead of silently
    // showing Stop with nothing running.
    startCameraBtn.classList.add('hidden');
    startCameraBtn.classList.remove('button');
    stopCameraBtn.classList.remove('hidden');
    stopCameraBtn.classList.add('button');

    sizeScoreRectToVideo();
  } catch (err) {
    // TODO: swap for the friendly retry-UI error message from the spec
    // rather than a console log — camera permission denial needs to be
    // visible to the user, not silent.
    console.error('Camera permission denied or unavailable:', err);
  }
}

// Stops the detection loop and releases the camera hardware — the track
// has to be stopped explicitly or the browser's camera indicator stays on.
function stopCamera() {
  webcamLoopActive = false;

  if (webcamStream) {
    webcamStream.getTracks().forEach((track) => track.stop());
    webcamStream = null;
  }
  webcamVideoEl.srcObject = null;

  const ctx = liveCanvas.getContext('2d');
  ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);

  // Swap back to Start
  stopCameraBtn.classList.add('hidden');
  stopCameraBtn.classList.remove('button');
  startCameraBtn.classList.add('button');
  startCameraBtn.classList.remove('hidden');

  sizeScoreRectToVideo();
}

// Maps landmarks from the raw webcam frame into the 9:16 box. The <video>
// uses object-fit: cover, so a landscape webcam has its left/right edges
// cropped (a very tall one would be cropped top/bottom). MediaPipe's
// landmarks are normalized to the UNCROPPED frame, so without this the
// drawn skeleton drifts away from the person. Scoring still receives the
// raw landmarks (it uses the raw frame's aspect ratio instead).
function coverMap(landmarks) {
  if (!landmarks || !webcamVideoEl.videoWidth || !webcamVideoEl.videoHeight) return landmarks;
  const va = webcamVideoEl.videoWidth / webcamVideoEl.videoHeight;
  const boxA = liveCanvas.width / liveCanvas.height;
  if (!boxA || Math.abs(va - boxA) < 0.01) return landmarks;
  return landmarks.map(p => !p ? p : va > boxA
    ? { ...p, x: (p.x - 0.5) * (va / boxA) + 0.5 }
    : { ...p, y: (p.y - 0.5) * (boxA / va) + 0.5 });
}

// NOTE: previously this bailed out permanently if poseLandmarker wasn't
// ready on the loop's first tick (initPoseLandmarker() takes a few
// seconds to load the WASM runtime + model, and Start Camera can be
// clicked before it resolves). Now the loop stays alive and just skips
// drawing until the model is ready, instead of returning without
// re-scheduling itself.
function detectWebcamLoop() {
  if (!webcamLoopActive) return;

  // Manual single clear per tick -- both the phantom ghost pass and the
  // user's own skeleton pass below are drawn with clear:false so
  // neither one erases the other before both have been drawn.
  const liveCtx = liveCanvas.getContext('2d');
  if (liveCtx) liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);

  // Phantom Overlay: ghosts the reference skeleton directly onto the
  // webcam feed at the current YouTube playback time, so the target
  // pose can be mimicked directly instead of glancing over at the
  // separate reference video. Drawn first/dimmer so the user's own
  // tracked skeleton reads clearly on top of it. Reference joints are
  // normalized to a 9:16 frame and the live box is 9:16 too, so they
  // map straight across with no remapping.
  if (phantomEnabled && ytPlayer && skeletonData) {
    const phantomFrame = findClosestKeyframe(ytPlayer.getCurrentTime());
    if (phantomFrame?.joints) {
      drawSkeleton(liveCanvas, phantomFrame.joints, { opacity: 0.5, clear: false });
    }
  }

  if (poseLandmarker) {
    const result = poseLandmarker.detectForVideo(webcamVideoEl, performance.now());
    const landmarks = result.landmarks?.[0] || null;
    window.dispatchEvent(new CustomEvent('syncstep:pose', { detail: landmarks }));
    // Mint when Phantom Overlay is on, so the live-tracked skeleton
    // reads as visually distinct from the white reference ghost drawn
    // underneath it (Section 26: Mint = positive feedback).
    drawSkeleton(liveCanvas, coverMap(landmarks), {
      opacity: 1,
      color: phantomEnabled ? 'rgba(63, 174, 138, 0.95)' : null,
      clear: false
    });
  }

  requestAnimationFrame(detectWebcamLoop);
}

// ============================================================
// SHARED OVERLAY DRAWING
// ============================================================
// Used for both the reference overlay (pre-recorded keyframes) and the
// live overlay (real-time MediaPipe results) — same drawing logic, just
// fed from different data sources, per the phantom-overlay note in the spec.
//
// Visual style follows the "ghost overlay" reference clip: a soft glowing
// outline rather than a thin stick-figure. Hand landmarks (pinky, index,
// thumb) are drawn as their own pass, with a slightly larger joint radius
// than the rest of the body, so the wrist→finger fan-out reads clearly
// instead of collapsing into a single dot at the wrist.

const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;

// Pose Landmarker indices for the hand points (pinky, index, thumb —
// wrist itself, 15/16, stays part of the main limb line so the forearm
// doesn't get a visible gap at the wrist).
const HAND_POINT_INDICES = new Set([17, 18, 19, 20, 21, 22]);

// Split once: connections touching a hand point (the wrist→finger fan-out
// and the pinky↔index cross-link) vs. everything else (torso/limbs).
const HAND_CONNECTIONS = [...POSE_CONNECTIONS].filter(
  ({ start, end }) => HAND_POINT_INDICES.has(start) || HAND_POINT_INDICES.has(end)
);
const BODY_CONNECTIONS = [...POSE_CONNECTIONS].filter(
  ({ start, end }) => !HAND_POINT_INDICES.has(start) && !HAND_POINT_INDICES.has(end)
);

function drawSkeleton(canvas, landmarks, { opacity = 1, color = null, clear = true } = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (clear) ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!landmarks) return;

  ctx.globalAlpha = opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Soft glow behind every stroke/dot — this is what gives the overlay
  // its "ghost" outline look instead of a flat thin line. Monochrome
  // white, matching the reference clip, rather than Section 26's Mint —
  // the glow itself doesn't shift with Phantom Overlay's Mint recolor
  // below; it's an ambient effect, not the "positive feedback" signal.
  ctx.shadowColor = 'rgba(255, 255, 255, 0.85)';
  ctx.shadowBlur = 10;

  // `color` lets Phantom Overlay draw the user's own live-tracked
  // skeleton in Mint so it's visually distinct from the white reference
  // ghost drawn underneath it. Defaults to the original monochrome
  // ghost white everywhere else (reference overlay, non-phantom webcam).
  const strokeColor = color || 'rgba(255, 255, 255, 0.95)';

  // Body bones (torso/limbs) — drawn thick so the glow reads as one
  // continuous outline.
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 6;
  BODY_CONNECTIONS.forEach(({ start, end }) => {
    const a = landmarks[start];
    const b = landmarks[end];
    if (!a || !b) return;
    ctx.beginPath();
    ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
    ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
    ctx.stroke();
  });

  // Hands — a separate, slightly thinner pass so the wrist→pinky/index/thumb
  // fan-out stays crisp and doesn't get swallowed by the thicker body
  // strokes or lost in the glow blur.
  ctx.lineWidth = 4;
  HAND_CONNECTIONS.forEach(({ start, end }) => {
    const a = landmarks[start];
    const b = landmarks[end];
    if (!a || !b) return;
    ctx.beginPath();
    ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
    ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
    ctx.stroke();
  });

  // Joints — hand points get a slightly larger radius than body joints so
  // fingertip/thumb positions read as distinct points rather than
  // disappearing into the glow.
  landmarks.forEach((point, idx) => {
    if (!point) return;
    const isHandPoint = HAND_POINT_INDICES.has(idx);
    ctx.beginPath();
    ctx.fillStyle = strokeColor;
    ctx.arc(point.x * canvas.width, point.y * canvas.height, isHandPoint ? 5 : 4, 0, 2 * Math.PI);
    ctx.fill();
  });

  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

// ============================================================
// PRACTICE CONTROLS — speed, loop, mirror, phantom, view
// ============================================================
// Guarded so this safely no-ops on any page other than practice.html
// (the elements these look up simply won't exist elsewhere).

// Builds the Loop pill row from the dance doc's loopSections, plus a
// "Custom" pill for an ad-hoc range. Called once loadDanceAndCreatePlayer()
// has the dance doc in hand -- doesn't need the player itself to be ready.
function populateLoopPills(loopSections) {
  const container = document.getElementById('loop-pills');
  if (!container) return;

  // Clear out any previously-generated pills (re-populating on a second
  // load, if that ever happens) but keep the static "Off" pill that's
  // already in the markup.
  container.querySelectorAll('.loop-pill:not([data-loop-off])').forEach(el => el.remove());

  loopSections.forEach(section => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'oval-button loop-pill';
    pill.textContent = section.Label;
    pill.addEventListener('click', () => {
      activeLoop = { start: section.Start, end: section.End };
      setActiveLoopPill(pill);
      if (ytPlayer) ytPlayer.seekTo(section.Start, true);
    });
    container.appendChild(pill);
  });

  // "Custom" pill -- minimal prompt()-based entry for now. A proper
  // inline start/end picker is a nice-to-have for later; not blocking
  // basic loop functionality.
  const customPill = document.createElement('button');
  customPill.type = 'button';
  customPill.className = 'oval-button loop-pill';
  customPill.textContent = 'Custom';
  customPill.addEventListener('click', () => {
    const start = parseFloat(window.prompt('Loop start (seconds)?', '0'));
    const end = parseFloat(window.prompt('Loop end (seconds)?', '10'));
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
      alert('Enter a valid start/end (end must be after start).');
      return;
    }
    activeLoop = { start, end };
    setActiveLoopPill(customPill);
    if (ytPlayer) ytPlayer.seekTo(start, true);
  });
  container.appendChild(customPill);

  // Wire the static "Off" pill -- it's in the HTML markup already, not
  // part of the dynamically-generated set above.
  const offPill = container.querySelector('[data-loop-off]');
  if (offPill) {
    offPill.addEventListener('click', () => {
      activeLoop = null;
      setActiveLoopPill(offPill);
    });
  }
}

function setActiveLoopPill(activePill) {
  document.querySelectorAll('#loop-pills .loop-pill').forEach(p => p.classList.remove('active'));
  activePill.classList.add('active');
}

// Playback speed pills
const speedButtons = document.querySelectorAll('.speed-btn');
speedButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const speed = parseFloat(btn.dataset.speed);
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') {
      ytPlayer.setPlaybackRate(speed);
    }
    speedButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Mirror -- flips video-wrap and webcam-wrap together as one unit via
// the .mirrored class already defined in practice.css, so joint
// coordinates never need to be individually flipped in drawSkeleton().
const mirrorBtn = document.getElementById('mirror-btn');
if (mirrorBtn) {
  mirrorBtn.addEventListener('click', () => {
    mirrorEnabled = !mirrorEnabled;
    videoWrap?.classList.toggle('mirrored', mirrorEnabled);
    document.getElementById('webcam-wrap')?.classList.toggle('mirrored', mirrorEnabled);
    mirrorBtn.classList.toggle('active', mirrorEnabled);
  });
}

// Phantom Overlay -- toggled flag read by detectWebcamLoop() above.
const phantomBtn = document.getElementById('phantom-btn');
if (phantomBtn) {
  phantomBtn.addEventListener('click', () => {
    phantomEnabled = !phantomEnabled;
    phantomBtn.classList.toggle('active', phantomEnabled);
  });
}

// View dropdown -- Side by Side / Reference Only / Webcam Only. Toggles
// the .hidden utility class (general-style.css) on the two stage columns.
const viewSelect = document.getElementById('view');
if (viewSelect) {
  viewSelect.addEventListener('change', () => {
    const videoColumn = document.querySelector('.video-column');
    const webcamColumn = document.querySelector('.webcam-column');
    if (!videoColumn || !webcamColumn) return;

    document.body.dataset.view = viewSelect.value;
    videoColumn.classList.remove('hidden');
    webcamColumn.classList.remove('hidden');
    if (viewSelect.value === 'reference-only') {
      webcamColumn.classList.add('hidden');
    } else if (viewSelect.value === 'webcam-only') {
      videoColumn.classList.add('hidden');
      ytPlayer?.pauseVideo();
    }
    sizeScoreRectToVideo();
  });
}

// ============================================================
// STARTUP
// ============================================================

window.addEventListener('DOMContentLoaded', () => {
  initPoseLandmarker(); // MediaPipe: async, self-initializing
  // YouTube: no manual call needed — window.onYouTubeIframeAPIReady fires on its own

  if (startCameraBtn) {
    startCameraBtn.addEventListener('click', startCamera);
  }
  if (stopCameraBtn) {
    stopCameraBtn.addEventListener('click', stopCamera);
  }

  sizeScoreRectToVideo();
  sizeOverlayToPlayer();
});

window.addEventListener('resize', () => {
  sizeScoreRectToVideo();
  sizeOverlayToPlayer();
});

// ============================================================
// ADMIN — dynamic loop-section rows
// ============================================================
// Guarded so this safely no-ops on any page other than admin.html,
// where #add-timestamps and #loop-sections-list don't exist.

function addSectionRow(container, label = '', start = '', end = '') {
  const row = document.createElement('div');
  row.className = 'section-row';
  row.innerHTML = `
    <input type="number" placeholder="Start (sec)" class="section-start" value="${start}">
    <input type="number" placeholder="End (sec)" class="section-end" value="${end}">
    <input type="text" placeholder="section name" class="section-label" value="${label}">
    <button type="button" class="remove-section">✕</button>
  `;
  row.querySelector('.remove-section').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

// NOTE: the members schema field for a member's display name is `Name`
// (capitalized), matching the dances/{danceId}.members array-of-maps
// shape written by this form.
function addMemberRow(container, Name = '', youtubeVideoId = '', skeletonUrl = '') {
  const row = document.createElement('div');
  row.className = 'section-row';
  row.innerHTML = `
    <input type="text" placeholder="Member name" class="member-name" value="${Name}">
    <input type="text" placeholder="Youtube Video Id" class="member-youtube-id" value="${youtubeVideoId}">
    <input type="file" accept=".json,application/json" class="member-skeleton">
    <button type="button" class="remove-section">✕</button>
  `;
  row.querySelector('.remove-section').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

// ============================================================
// LIBRARY — fetch all dances once, render cards, filter client-side
// ============================================================
// Guarded so this safely no-ops on any page other than library.html.

const libraryGrid = document.getElementById('library-grid');
const filterChipsEl = document.getElementById('filter-chips');
const librarySearchBar = document.getElementById('search-bar');

let allDances = [];
let activeArtist = null;

if (libraryGrid) {
  loadLibrary();
  if (librarySearchBar) {
    librarySearchBar.addEventListener('input', renderLibraryGrid);
  }
}

async function loadLibrary() {
  try {
    const snap = await getDocs(collection(db, 'dances'));
    allDances = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFilterChips();
    renderLibraryGrid();
  } catch (err) {
    console.error('Failed to load dances from Firestore:', err);
    libraryGrid.innerHTML = '<p>Could not load the library. Please try again later.</p>';
  }
}

function renderFilterChips() {
  if (!filterChipsEl) return;
  const artists = [...new Set(allDances.map(d => d.artist))].sort();

  filterChipsEl.innerHTML = '';
  filterChipsEl.appendChild(createChip('All', null));
  artists.forEach(artist => filterChipsEl.appendChild(createChip(artist, artist)));
}

function createChip(label, artistValue) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'filter-chip' + (activeArtist === artistValue ? ' active' : '');
  chip.textContent = label;
  chip.addEventListener('click', () => {
    activeArtist = artistValue;
    renderFilterChips();
    renderLibraryGrid();
  });
  return chip;
}

function renderLibraryGrid() {
  if (!libraryGrid) return;
  const query = (librarySearchBar?.value || '').trim().toLowerCase();

  const filtered = allDances.filter(dance => {
    const matchesArtist = !activeArtist || dance.artist === activeArtist;
    const matchesSearch = !query || dance.songTitle?.toLowerCase().includes(query);
    return matchesArtist && matchesSearch;
  });

  libraryGrid.innerHTML = filtered.length
    ? ''
    : '<p>No dances match your search.</p>';

  filtered.forEach(dance => libraryGrid.appendChild(createDanceCard(dance)));
}

// Selecting a member navigates to practice.html with both the dance's
// Firestore doc ID and the member's raw youtubeVideoId (URL-encoded,
// since it may itself be a full YouTube URL containing its own ? and =).
// loadDanceAndCreatePlayer() re-matches against dance.members using this
// same raw value, then extracts the bare video ID for YT.Player.
function createDanceCard(dance) {
  const esc = (v = '') => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const card = document.createElement('div');
  card.className = 'dance-card';
  card.innerHTML = `
    <div class="dance-card-thumb-wrap">
      <img class="dance-card-thumb" src="${esc(dance.thumbnailUrl || '')}" alt="${esc(dance.songTitle)}">
      <button type="button" class="bookmark-btn" data-dance-id="${esc(dance.id)}" aria-label="Bookmark">☆</button>
    </div>
    <div class="dropdown">
      <div class="dance-card-info">
        <p class="dance-card-title">${esc(dance.songTitle)}</p>
        <p class="dance-card-artist">${esc(dance.artist)}</p>
      </div>
      <select class="dance-member-select">
        <option value="">Select a member</option>
        ${dance.members?.map(member => `
          <option value="${esc(member.youtubeVideoId)}">${esc(member.Name)}</option>
        `).join('') || ''}
      </select>
    </div>
  `;

  const select = card.querySelector('.dance-member-select');
  select.addEventListener('change', () => {
    if (!select.value) return; // ignore the placeholder option
    window.location.href = `practice.html?dance=${dance.id}&video=${encodeURIComponent(select.value)}`;
  });

  return card;
}

// ============================================================
// ADMIN — multiple dance entries
// ============================================================

let danceRowCount = 0;

function addDanceEntry() {
  const danceIndex = danceRowCount++;

  const wrapper = document.createElement('div');
  wrapper.className = 'dance-entry';
  wrapper.dataset.danceIndex = danceIndex;

  wrapper.innerHTML = `
    <hr>
    <div class="input-group">
      <label>Document ID</label><br>
      <input type="text" class="document-id" placeholder="Enter the document ID">
    </div>
    <div class="input-group">
      <label>Thumbnail URL:</label><br>
      <input type="text" class="thumbnail-url" placeholder="Enter the thumbnail URL">
    </div>
    <div class="input-group">
      <label>Song Title:</label><br>
      <input type="text" class="song-title" placeholder="Enter the song title">
    </div>
    <div class="input-group">
      <label>Artist/Group:</label><br>
      <input type="text" class="artist" placeholder="Enter the artist or group name">
    </div>
    <div class="input-group">
      <label>Loop Section Timestamps:</label>
      <div class="loop-sections-list"></div>
      <h5 class="add-timestamps button">Add New Timestamps</h5>
    </div>
    <div class="input-group">
      <label>Members:</label>
      <div class="members-list"></div>
      <h5 class="add-members button">Add Member</h5>
    </div>
    <button type="button" class="remove-dance button">Remove This Dance</button>
  `;

  // Scope the row-builders to *this* entry's own containers instead of
  // a single global list, so each dance keeps its own timestamps/members.
  wrapper.querySelector('.add-timestamps').addEventListener('click', () => {
    addSectionRow(wrapper.querySelector('.loop-sections-list'));
  });
  wrapper.querySelector('.add-members').addEventListener('click', () => {
    addMemberRow(wrapper.querySelector('.members-list'));
  });
  wrapper.querySelector('.remove-dance').addEventListener('click', () => {
    wrapper.remove();
  });

  document.getElementById('add-dance-list').appendChild(wrapper);
}

const addDancesBtn = document.getElementById('add-dances');
if (addDancesBtn) {
  addDancesBtn.addEventListener('click', addDanceEntry);
}

// Seed the form with one dance entry on load, instead of static markup
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('add-dance-list')) addDanceEntry();
});

// community.html — post form submit handler not yet built (deferred)
// bookmarks.html — depends on Auth, not yet built (deferred)

// Auth (login/signup/Google), bookmarks, community, profile, admin writes and
// practice scoring now live in app.js (imported at the top of this file).