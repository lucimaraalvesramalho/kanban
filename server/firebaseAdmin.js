import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Inicializa o Firebase Admin uma única vez e reutiliza a instância existente.
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
