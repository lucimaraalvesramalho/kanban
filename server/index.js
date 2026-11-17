import "dotenv/config";
import { createApp } from "./app.js";
import { createGeminiGenerator } from "./aiService.js";
import { initializeFirebaseAdmin } from "./firebaseAdmin.js";

const { FIREBASE_PROJECT_ID, GEMINI_API_KEY, GEMINI_MODEL, PORT, CORS_ALLOWED_ORIGINS } = process.env;

// Impede iniciar o servidor sem uma chave obrigatória do provedor de IA.
if (!GEMINI_API_KEY) {
  throw new Error("Configure GEMINI_API_KEY no ambiente do servidor.");
}

const firestore = initializeFirebaseAdmin(FIREBASE_PROJECT_ID);
const auth = (await import("firebase-admin/auth")).getAuth();
const generateAnswer = createGeminiGenerator({
  apiKey: GEMINI_API_KEY,
  model: GEMINI_MODEL || "gemini-3.5-flash-lite"
});
const allowedOrigins = (CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const app = createApp({
  auth,
  firestore,
  generateAnswer,
  allowedOrigins
});
const port = Number(PORT) || 3000;

app.listen(port, () => {
  console.log(`Kanban AI API ouvindo na porta ${port}.`);
});
