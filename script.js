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

import { db } from "/firebase-init.js";
import { collection, getDocs, doc, getDoc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { auth, provider } from "/firebase-init.js";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
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

// Elements used by sizeScoreRectToVideo() — score-rect's height tracking
const scoreRect = document.querySelector('.score-rect');
const videoWrap = document.getElementById('video-wrap');

// Matches .score-rect's height to .video-wrap's actual rendered height,
// so it lines up with the bottom of the YouTube video regardless of
// viewport size.
function sizeScoreRectToVideo() {
  if (!scoreRect || !videoWrap) return;

  // FIX: when the video column is hidden (Webcam Only view) the video
  // has no height, which would collapse the score box to 0px. Let the
  // CSS flex layout size it instead.
  if (videoWrap.offsetHeight === 0) {
    scoreRect.style.height = '';
    return;
  }

  const webcamWrap = document.getElementById('webcam-wrap');
  const recordBtn = document.getElementById('record');
  // Whichever of start/stop is currently visible drives the used-height
  // calc; the hidden one contributes 0 since .hidden sets display:none.
  const activeCameraBtn = (startCameraBtn && !startCameraBtn.classList.contains('hidden'))
    ? startCameraBtn
    : stopCameraBtn;

  const videoHeight = videoWrap.getBoundingClientRect().height;

  // Subtract the height everything above score-rect in the column already
  // takes up (webcam box + buttons + their margins), so score-rect fills
  // exactly what's left rather than pushing the column taller than the video.
  const usedHeight = [webcamWrap, activeCameraBtn, recordBtn]
    .filter(Boolean)
    .reduce((sum, el) => {
      const style = getComputedStyle(el);
      const marginTop = parseFloat(style.marginTop) || 0;
      const marginBottom = parseFloat(style.marginBottom) || 0;
      return sum + el.getBoundingClientRect().height + marginTop + marginBottom;
    }, 0);

  const remaining = videoHeight - usedHeight;
  scoreRect.style.height = Math.max(remaining, 0) + 'px';
}

// ============================================================
// YOUTUBE PLAYER — practice.html
// ============================================================
let ytPlayer;
let currentMember = null; // matched entry from dance.members, holds skeletonUrl
let currentDanceData = null; // full dance doc -- needed for loopSections
let playerRequested = false; // guards against creating the YT player twice

// Practice-controls state (speed/loop/mirror/phantom) -- read by the
// sync loop and the webcam detection loop below.
let activeLoop = null;      // { start, end } in seconds, or null when off
let mirrorEnabled = false;
let phantomEnabled = false;

// YouTube's script calls this automatically once its API has loaded —
// name/signature are fixed by the API, don't rename it. It can't be
// declared async itself, so it delegates to an async helper.
window.onYouTubeIframeAPIReady = function () {
  if (!document.getElementById('yt-player')) return; // not on practice.html
  if (playerRequested) return;
  playerRequested = true;
  loadDanceAndCreatePlayer();
};

// FIX: race condition -- this module loads after the YouTube script
// (modules are deferred), and the YouTube API can finish loading and fire
// onYouTubeIframeAPIReady BEFORE the line above ran, in which case it
// would never be called again and the player would never appear. If the
// API is already here, start immediately.
if (window.YT && window.YT.Player) {
  window.onYouTubeIframeAPIReady();
}

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

function onPlayerStateChange(event) {
  // Only poll/redraw while actually playing — no point burning cycles
  // redrawing the overlay every 100ms while paused.
  if (event.data === YT.PlayerState.PLAYING) {
    startSyncLoop(() => ytPlayer.getCurrentTime());
  } else {
    stopSyncLoop();
  }
}

// Matches the overlay canvas's pixel size to the YouTube iframe underneath
// it so drawn joint coordinates line up with the video.
function sizeOverlayToPlayer() {
  const iframe = document.querySelector('#yt-player iframe');
  if (!iframe || !referenceCanvas) return;
  referenceCanvas.width = iframe.clientWidth;
  referenceCanvas.height = iframe.clientHeight;
}

// ============================================================
// REFERENCE SKELETON DATA + SYNC LOOP
// ============================================================

async function loadSkeletonData(member) {
  // skeletonUrl is the Storage download URL saved on the member entry by
  // admin.html when the dance was added.
  const skeletonUrl = member?.skeletonUrl;
  if (!skeletonUrl) {
    console.warn('This member has no skeletonUrl — sync loop will run with no data.');
    return;
  }

  // FIX: a failed fetch (CORS, bad URL, Storage rules) used to throw an
  // unhandled promise rejection with no useful message. Now it logs a
  // clear error and the page keeps working without the overlay.
  try {
    const res = await fetch(skeletonUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    skeletonData = await res.json(); // expected shape: array of { t, joints: [...] }
  } catch (err) {
    console.error('Could not load skeleton data (check Storage CORS/rules and the skeletonUrl):', err);
    skeletonData = null;
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
    if (activeLoop && currentTime >= activeLoop.end) {
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

  const modelAssetPath =
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

  // FIX: GPU delegate fails on some machines/browsers, which left the app
  // with no pose detection at all. Try GPU first, fall back to CPU.
  for (const delegate of ["GPU", "CPU"]) {
    try {
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: "VIDEO",
        numPoses: 1
      });
      return;
    } catch (err) {
      console.warn(`Pose Landmarker failed with ${delegate} delegate:`, err);
    }
  }
  console.error('Could not start the Pose Landmarker with GPU or CPU.');
}

// Webcam access requires a user gesture — wired to the "Start Camera" button
// rather than requested automatically on page load.
async function startCamera() {
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: true });
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

    // Button swap can change the column's layout height slightly —
    // recalc so score-rect stays aligned with the video.
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

  // Button swap can change the column's layout height slightly —
  // recalc so score-rect stays aligned with the video.
  sizeScoreRectToVideo();
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
  // tracked skeleton reads clearly on top of it.
  if (phantomEnabled && ytPlayer && skeletonData) {
    const phantomFrame = findClosestKeyframe(ytPlayer.getCurrentTime());
    if (phantomFrame?.joints) {
      drawSkeleton(liveCanvas, phantomFrame.joints, { opacity: 0.5, clear: false });
    }
  }

  if (poseLandmarker) {
    const result = poseLandmarker.detectForVideo(webcamVideoEl, performance.now());
    const landmarks = result.landmarks?.[0] || null;
    // Mint when Phantom Overlay is on, so the live-tracked skeleton
    // reads as visually distinct from the white reference ghost drawn
    // underneath it (Section 26: Mint = positive feedback).
    drawSkeleton(liveCanvas, landmarks, {
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
    // FIX: pressing Cancel on a prompt returns null; previously that
    // fell through to the "enter a valid start/end" alert. Cancel now
    // just backs out quietly.
    const startInput = window.prompt('Loop start (seconds)?', '0');
    if (startInput === null) return;
    const endInput = window.prompt('Loop end (seconds)?', '10');
    if (endInput === null) return;

    const start = parseFloat(startInput);
    const end = parseFloat(endInput);
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

// Mirror -- flips video-wrap (video + its overlay canvas) as one unit via
// the .mirrored class already defined in practice.css, so joint
// coordinates never need to be individually flipped in drawSkeleton().
const mirrorBtn = document.getElementById('mirror-btn');
if (mirrorBtn) {
  mirrorBtn.addEventListener('click', () => {
    mirrorEnabled = !mirrorEnabled;
    // FIX: the webcam is already selfie-mirrored by CSS (#webcam-feed and
    // #live-overlay use scaleX(-1)), so also flipping webcam-wrap undid
    // that and left left/right mismatched. Mirror flips the reference only,
    // so its left/right matches the user's mirrored webcam view.
    videoWrap?.classList.toggle('mirrored', mirrorEnabled);
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

    videoColumn.classList.remove('hidden');
    webcamColumn.classList.remove('hidden');
    if (viewSelect.value === 'reference-only') {
      webcamColumn.classList.add('hidden');
    } else if (viewSelect.value === 'webcam-only') {
      videoColumn.classList.add('hidden');
      // FIX: this was `player.pauseVideo()`, but no variable named
      // `player` exists (it's `ytPlayer`), so choosing Webcam Only threw
      // a ReferenceError. Guarded in case the player isn't ready yet.
      if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
        ytPlayer.pauseVideo();
      }
    }

    // FIX: layout just changed -- re-measure once the browser has
    // re-flowed so the overlay canvas and score box match the new sizes.
    requestAnimationFrame(() => {
      sizeOverlayToPlayer();
      sizeScoreRectToVideo();
    });
  });
}

// ============================================================
// STARTUP
// ============================================================

window.addEventListener('DOMContentLoaded', () => {
  // FIX: this used to download the WASM runtime + model on every page
  // (home, library, login...). Only practice.html has a webcam element.
  if (webcamVideoEl) initPoseLandmarker(); // MediaPipe: async, self-initializing
  // YouTube: no manual call needed — window.onYouTubeIframeAPIReady fires on its own

  if (startCameraBtn) {
    startCameraBtn.addEventListener('click', startCamera);
  }
  if (stopCameraBtn) {
    stopCameraBtn.addEventListener('click', stopCamera);
  }

  // Initial pass in case video-wrap already has its aspect-ratio height
  // on load.
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

// library.html uses #library-grid; bookmarks.html uses #bookmarks-grid.
// Both pages share the same card/search/filter code below -- the bookmarks
// page just shows only the dances the signed-in user has bookmarked.
const libraryGrid = document.getElementById('library-grid') || document.getElementById('bookmarks-grid');
const isBookmarksPage = !!document.getElementById('bookmarks-grid');
const filterChipsEl = document.getElementById('filter-chips');
const librarySearchBar = document.getElementById('search-bar');

let allDances = [];
let activeArtist = null;

// Bookmark state -- users/{uid}/bookmarks/{danceId}
let currentUser = null;          // set by onAuthStateChanged at the bottom
let bookmarkedIds = new Set();   // dance IDs the current user has bookmarked
let dancesLoaded = false;        // dances collection fetched
let authChecked = false;         // Firebase Auth has reported signed-in/out

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
    dancesLoaded = true;
    renderFilterChips();
    renderLibraryGrid();
  } catch (err) {
    console.error('Failed to load dances from Firestore:', err);
    libraryGrid.innerHTML = '<p>Could not load the library. Please try again later.</p>';
  }
}

function renderFilterChips() {
  if (!filterChipsEl) return;
  // On the bookmarks page only offer artists that have a bookmarked dance.
  const source = isBookmarksPage ? allDances.filter(d => bookmarkedIds.has(d.id)) : allDances;
  const artists = [...new Set(source.map(d => d.artist))].sort();
  if (activeArtist && !artists.includes(activeArtist)) activeArtist = null;

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

  // Don't flash a misleading empty state before the data has arrived.
  if (!dancesLoaded || (isBookmarksPage && !authChecked)) {
    libraryGrid.innerHTML = '<p>Loading...</p>';
    return;
  }
  if (isBookmarksPage && !currentUser) {
    libraryGrid.innerHTML = '<p>Please <a href="login.html">log in</a> to see your bookmarks.</p>';
    return;
  }

  const query = (librarySearchBar?.value || '').trim().toLowerCase();

  const filtered = allDances.filter(dance => {
    const matchesBookmark = !isBookmarksPage || bookmarkedIds.has(dance.id);
    const matchesArtist = !activeArtist || dance.artist === activeArtist;
    const matchesSearch = !query || dance.songTitle?.toLowerCase().includes(query);
    return matchesBookmark && matchesArtist && matchesSearch;
  });

  let emptyMessage = '<p>No dances match your search.</p>';
  if (isBookmarksPage) {
    emptyMessage = bookmarkedIds.size === 0
      ? '<p>No bookmarks yet. Tap the bookmark icon on a dance in the <a href="library.html">Library</a> to save it here.</p>'
      : '<p>No bookmarks match your search.</p>';
  }

  libraryGrid.innerHTML = filtered.length ? '' : emptyMessage;
  filtered.forEach(dance => libraryGrid.appendChild(createDanceCard(dance)));
}

// Selecting a member navigates to practice.html with both the dance's
// Firestore doc ID and the member's raw youtubeVideoId (URL-encoded,
// since it may itself be a full YouTube URL containing its own ? and =).
// loadDanceAndCreatePlayer() re-matches against dance.members using this
// same raw value, then extracts the bare video ID for YT.Player.
function createDanceCard(dance) {
  const card = document.createElement('div');
  card.className = 'dance-card';
  const isBookmarked = bookmarkedIds.has(dance.id);
  card.innerHTML = `
    <button type="button" class="bookmark-btn${isBookmarked ? ' active' : ''}"
            aria-label="Bookmark ${dance.songTitle}" aria-pressed="${isBookmarked}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>
    </button>
    <img class="dance-card-thumb" src="${dance.thumbnailUrl || ''}" alt="${dance.songTitle}">
    <div class="dropdown">
      <div class="dance-card-info">
        <p class="dance-card-title">${dance.songTitle}</p>
        <p class="dance-card-artist">${dance.artist}</p>
      </div>
      <select class="dance-member-select">
        <option value="">Select a member</option>
        ${dance.members?.map(member => `
          <option value="${member.youtubeVideoId}">${member.Name}</option>
        `).join('') || ''}
      </select>
    </div>
  `;

  const bookmarkBtn = card.querySelector('.bookmark-btn');
  bookmarkBtn.addEventListener('click', () => toggleBookmark(dance.id, bookmarkBtn));

  const select = card.querySelector('.dance-member-select');
  select.addEventListener('change', () => {
    if (!select.value) return; // ignore the placeholder option
    window.location.href = `practice.html?dance=${dance.id}&video=${encodeURIComponent(select.value)}`;
  });

  return card;
}

// ============================================================
// BOOKMARKS — users/{uid}/bookmarks/{danceId}
// ============================================================
// One doc per bookmarked dance, keyed by the dance's ID, so toggling is
// just set/delete on a known path.

function setBookmarkButtonState(btn, active) {
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', String(active));
}

async function toggleBookmark(danceId, btn) {
  if (!currentUser) {
    window.location.href = 'login.html'; // bookmarks need an account
    return;
  }

  const ref = doc(db, 'users', currentUser.uid, 'bookmarks', danceId);
  const wasBookmarked = bookmarkedIds.has(danceId);

  // Optimistic update so the icon responds instantly; reverted on failure.
  if (wasBookmarked) bookmarkedIds.delete(danceId); else bookmarkedIds.add(danceId);
  setBookmarkButtonState(btn, !wasBookmarked);

  try {
    if (wasBookmarked) {
      await deleteDoc(ref);
    } else {
      await setDoc(ref, { danceId, createdAt: serverTimestamp() });
    }
  } catch (err) {
    console.error('Could not update bookmark:', err);
    if (wasBookmarked) bookmarkedIds.add(danceId); else bookmarkedIds.delete(danceId);
    setBookmarkButtonState(btn, wasBookmarked);
    alert("Couldn't update your bookmark. Please try again.");
    return;
  }

  // On the bookmarks page an un-bookmarked dance should disappear.
  if (isBookmarksPage) {
    renderFilterChips();
    renderLibraryGrid();
  }
}

async function loadBookmarks(user) {
  bookmarkedIds = new Set();
  if (user) {
    try {
      const snap = await getDocs(collection(db, 'users', user.uid, 'bookmarks'));
      bookmarkedIds = new Set(snap.docs.map(d => d.id));
    } catch (err) {
      console.error('Could not load bookmarks (check Firestore rules for users/{uid}/bookmarks):', err);
    }
  }
  if (isBookmarksPage) renderFilterChips();
  renderLibraryGrid();
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

// ============================================================
// AUTH — Google, email/password login + signup, auth-aware UI
// ============================================================
// Every block is guarded so it no-ops on pages without those elements.

function showAuthError(message) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = message || '';
  else if (message) alert(message);
}

function friendlyAuthError(err) {
  switch (err?.code) {
    case 'auth/email-already-in-use': return 'An account with that email already exists. Try logging in instead.';
    case 'auth/invalid-email': return "That email address doesn't look right.";
    case 'auth/weak-password': return 'Password must be at least 6 characters.';
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password': return 'Incorrect email or password.';
    case 'auth/too-many-requests': return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request': return ''; // user closed the popup -- not an error
    default: return 'Something went wrong. Please try again.';
  }
}

// merge:true so a returning user's existing data is never overwritten.
async function saveUserDoc(user, extra = {}) {
  try {
    await setDoc(doc(db, 'users', user.uid), {
      email: user.email || null,
      displayName: user.displayName || null,
      ...extra
    }, { merge: true });
  } catch (err) {
    console.error('Could not save user profile document:', err);
  }
}

// Google sign-in (login.html + signup.html)
const googleButton = document.getElementById('google-signup-button');
if (googleButton) {
  googleButton.addEventListener('click', async () => {
    showAuthError('');
    try {
      const result = await signInWithPopup(auth, provider);
      await saveUserDoc(result.user);
      window.location.href = 'index.html';
    } catch (err) {
      console.error('Google sign-in error:', err);
      showAuthError(friendlyAuthError(err));
    }
  });
}

// Email/password login (login.html)
const loginForm = document.getElementById('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    // FIX: with no handler the form submitted as a GET and put the email
    // AND password in the page URL.
    e.preventDefault();
    showAuthError('');
    const emailValue = document.getElementById('email').value.trim();
    const passwordValue = document.getElementById('password').value;
    try {
      await signInWithEmailAndPassword(auth, emailValue, passwordValue);
      window.location.href = 'index.html';
    } catch (err) {
      console.error('Login error:', err);
      showAuthError(friendlyAuthError(err));
    }
  });
}

// Email/password signup (signup.html) -- two steps: name, then credentials
const signupForm = document.getElementById('signup-form');
if (signupForm) {
  const fnameInput = document.getElementById('fname');
  const lnameInput = document.getElementById('lname');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const confirmInput = document.getElementById('confirm-password');
  const nextBtn = document.getElementById('next');
  const signUpBtn = document.getElementById('sign-up');

  // FIX: the old code hid/showed the <input> elements, but the labels and
  // wrapper divs (#fname-group, #email-group, ...) are what carry the
  // .hidden class, so the second step never appeared and Confirm
  // Password was never shown. Toggle the group wrappers instead.
  const nameGroups = ['fname-group', 'lname-group'].map(id => document.getElementById(id));
  const credGroups = ['email-group', 'password-group', 'confirm-password-group'].map(id => document.getElementById(id));

  nextBtn.addEventListener('click', () => {
    showAuthError('');
    if (!fnameInput.value.trim() || !lnameInput.value.trim()) {
      showAuthError('Please enter your first and last name.');
      return;
    }
    nameGroups.forEach(g => g.classList.add('hidden'));
    credGroups.forEach(g => g.classList.remove('hidden'));
    nextBtn.classList.add('hidden');
    signUpBtn.classList.remove('hidden');
  });

  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('');

    if (passwordInput.value !== confirmInput.value) {
      showAuthError("Passwords don't match.");
      return;
    }

    const firstName = fnameInput.value.trim();
    const lastName = lnameInput.value.trim();
    try {
      const cred = await createUserWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
      await updateProfile(cred.user, { displayName: `${firstName} ${lastName}` });
      await saveUserDoc(cred.user, {
        displayName: `${firstName} ${lastName}`,
        firstName,
        lastName,
        createdAt: serverTimestamp()
      });
      window.location.href = 'index.html';
    } catch (err) {
      console.error('Signup error:', err);
      showAuthError(friendlyAuthError(err));
    }
  });
}

// ============================================================
// AUTH-AWARE UI — nav links, logout, profile page, bookmarks
// ============================================================
async function logOut() {
  try {
    await signOut(auth);
    window.location.href = 'index.html';
  } catch (err) {
    console.error('Logout error:', err);
  }
}

// Adds/removes a "Log Out" link at the end of the nav on every page, so
// no page's HTML needs editing.
function syncNavLogout(user) {
  const nav = document.querySelector('.navigation');
  if (!nav) return;
  let logoutLink = document.getElementById('nav-logout');
  if (user && !logoutLink) {
    logoutLink = document.createElement('a');
    logoutLink.id = 'nav-logout';
    logoutLink.className = 'nav-logout';
    logoutLink.href = '#';
    logoutLink.textContent = 'Log Out';
    logoutLink.addEventListener('click', (e) => {
      e.preventDefault();
      logOut();
    });
    nav.appendChild(logoutLink);
  } else if (!user && logoutLink) {
    logoutLink.remove();
  }
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  authChecked = true;

  // Hide Login / Sign Up when signed in, show Log Out instead.
  document.querySelectorAll('a.login-button, a.signup-button').forEach(link => {
    link.classList.toggle('hidden', !!user);
  });
  syncNavLogout(user);

  // profile.html -- previously both panels stayed hidden forever.
  const profileInfo = document.getElementById('profile-info');
  const profileLoggedOut = document.getElementById('profile-logged-out');
  if (profileInfo && profileLoggedOut) {
    profileInfo.classList.toggle('hidden', !user);
    profileLoggedOut.classList.toggle('hidden', !!user);
    if (user) {
      document.getElementById('profile-name').textContent = user.displayName || 'SyncStep dancer';
      document.getElementById('profile-email').textContent = user.email || '';
    }
  }

  // library.html / bookmarks.html -- load this user's bookmarks and redraw.
  if (libraryGrid) loadBookmarks(user);
});

const logoutButton = document.getElementById('logout-button');
if (logoutButton) {
  logoutButton.addEventListener('click', logOut);
}