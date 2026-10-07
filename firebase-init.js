// ============================================================
// SyncStep — shared Firebase initialization
// Imported by every page that needs Auth, Firestore, or Storage.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-analytics.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
// Added GoogleAuthProvider to the imports below:
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDk0oVIeuqYxcJDKvznLxUnG6T8GA-prMY",
  authDomain: "syncstep-247ce.firebaseapp.com",
  projectId: "syncstep-247ce",
  storageBucket: "syncstep-247ce.firebasestorage.app",
  messagingSenderId: "957697643174",
  appId: "1:957697643174:web:d6add5276683629f5c5a67",
  measurementId: "G-QD7HFF6BMX"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// Initialize & Export Services
export const db = getFirestore(app);
export const auth = getAuth(app); // Declared and exported once
export const provider = new GoogleAuthProvider(); // Now successfully imported and exported!
export const storage = getStorage(app);
