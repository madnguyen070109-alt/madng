# SyncStep

Practice K-pop choreography with real-time feedback. SyncStep syncs a reference skeleton overlay to a YouTube dance video and compares it against your live webcam pose to help you dial in timing and form.

## Status

Early build — foundation and pose-detection core are in place; practice tools, scoring, accounts, community, and admin are not yet built. See `syncstep-build-tracker.html` for the live, checkbox-tracked task list across all six build phases.

## Tech stack

- **Frontend:** Static HTML/CSS/JS, no framework
- **Video:** YouTube IFrame Player API
- **Pose detection:** MediaPipe Tasks Vision (`PoseLandmarker`)
- **Backend:** Firebase — Auth, Firestore, Storage, Hosting

## Pages

| Page | File | Purpose |
|---|---|---|
| Practice / Home | `index.html` | Landing page — intro, recent dances, community preview |
| Practice Player | `practice.html` | Core screen: YouTube + synced skeleton overlay, webcam + live feedback |
| Library | `library.html` | Browse/search/filter dances |
| Community | `community.html` | Post form + paginated feed |
| Bookmarks | `bookmarks.html` | Saved dances |
| Profile | `profile.html` | Account settings + progress dashboard |
| Admin | `admin.html` | Add new dances (metadata, timestamps, skeleton JSON) |

Every page shares one nav bar (with the current page marked `active`) and imports `general-style.css` alongside its own per-page stylesheet.

## Color palette

Defined as CSS custom properties in `general-style.css` and every per-page stylesheet:

| Name | Hex | Use |
|---|---|---|
| Cream | `#E7E5DF` | Page background, all tabs |
| Ink | `#071013` | Default text, inactive nav links |
| Coral Active | `#E24E64` | Active nav tab, primary buttons, score %, filled bookmark |
| Coral Hover | `#C93A50` | Hover/pressed states |
| Warm White | `#F4F4F2` | Cards, input fields, panels |
| Mint | `#3FAE8A` | Positive feedback (score badges, "great match" states) |

## Project structure

```
/
├── index.html / index.css
├── practice.html / practice.css
├── library.html / library.css
├── community.html / community.css
├── bookmarks.html / bookmarks.css
├── profile.html / profile.css
├── admin.html / admin.css
├── general-style.css       # shared nav/body styles, palette vars
├── script.js                # YouTube player, MediaPipe, sync loop, webcam
├── firebase-init.js         # Firebase app/auth/firestore/storage init
└── syncstep-build-tracker.html   # interactive build checklist
```

## Setup

1. Clone the repo.
2. In `firebase-init.js`, replace the placeholder `firebaseConfig` values with your own project's config (Firebase console → Project settings → SDK setup and configuration).
3. In the Firebase console, enable **Auth** (email/password), **Firestore**, **Storage**, and **Hosting**.
4. Serve the files locally (any static server works, e.g. `npx serve` or the VS Code Live Server extension) — `type="module"` scripts won't run from a plain `file://` URL.
5. Open `index.html`.

## Firestore schema (planned)

```
dances/{danceId}          — youtubeVideoId, skeletonUrl, songTitle, artist, loopSections, ...
users/{uid}                — profile fields
users/{uid}/scores/{id}    — per-session scoring results
users/{uid}/bookmarks/{id} — bookmarked dance references
posts/{postId}             — community feed posts
```

## Notes

- Camera access is only requested on a user gesture (the "Start Camera" button), never on page load.
- The reference overlay (from stored skeleton JSON) and the live webcam overlay share one drawing function (`drawSkeleton` in `script.js`), so both stay visually consistent.
- Full feature spec and implementation details live in the project's spec documents (Parts 1–7, including the wireframes/color-scheme addendum).