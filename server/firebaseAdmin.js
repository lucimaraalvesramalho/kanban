import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function initializeFirebaseAdmin(projectId) {
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID não foi configurado.");
  }

  const app = getApps()[0] || initializeApp({
    credential: applicationDefault(),
    projectId
  });

  return getFirestore(app);
}
