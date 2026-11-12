import firebaseConfig from "./firebase-config.js";

const FIREBASE_MODULES = {
  app: "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js",
  auth: "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js",
  firestore: "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
};

function isPlaceholderValue(value) {
  return typeof value === "string" && (
    value.includes("SUA_") ||
    value.includes("SEU_") ||
    value.includes("YOUR_") ||
    value === ""
  );
}

export let firebaseReady = Boolean(
  firebaseConfig &&
  typeof firebaseConfig === "object" &&
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  !isPlaceholderValue(firebaseConfig.apiKey) &&
  !isPlaceholderValue(firebaseConfig.projectId)
);

export let auth = null;
export let db = null;
let initializationPromise = null;

async function initializeFirebase() {
  if (!firebaseReady) {
    return;
  }

  const [{ initializeApp }, { getAuth }, { initializeFirestore }] = await Promise.all([
    import(FIREBASE_MODULES.app),
    import(FIREBASE_MODULES.auth),
    import(FIREBASE_MODULES.firestore)
  ]);

  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, { experimentalForceLongPolling: true });
}

if (firebaseReady) {
  initializationPromise = initializeFirebase().catch((error) => {
    console.error("Não foi possível inicializar o Firebase.", error);
    firebaseReady = false;
  });
} else {
  console.warn("Firebase não está configurado. Atualize firebase-config.js para usar autenticação e Firestore.");
}

export async function ensureFirebaseInitialized() {
  if (!firebaseReady || !initializationPromise) {
    throw new Error("Firebase não configurado.");
  }

  await initializationPromise;
  if (!firebaseReady || !auth || !db) {
    throw new Error("Não foi possível inicializar o Firebase. Verifique a configuração e a conexão.");
  }
}

export async function getFirestoreApi() {
  await ensureFirebaseInitialized();
  return import(FIREBASE_MODULES.firestore);
}

export async function createUserWithEmailAndPassword(email, password) {
  await ensureFirebaseInitialized();
  const { createUserWithEmailAndPassword: createUser } = await import(FIREBASE_MODULES.auth);
  return createUser(auth, email, password);
}

export async function signInWithEmailAndPassword(email, password) {
  await ensureFirebaseInitialized();
  const { signInWithEmailAndPassword: signIn } = await import(FIREBASE_MODULES.auth);
  return signIn(auth, email, password);
}

export async function signOutUser() {
  await ensureFirebaseInitialized();
  const { signOut } = await import(FIREBASE_MODULES.auth);
  return signOut(auth);
}

export async function onAuthStateChanged(callback) {
  await ensureFirebaseInitialized();
  const { onAuthStateChanged: observeAuthState } = await import(FIREBASE_MODULES.auth);
  return observeAuthState(auth, callback);
}

export async function doc(...segments) {
  await ensureFirebaseInitialized();
  const { doc: createDocRef } = await import(FIREBASE_MODULES.firestore);
  return createDocRef(db, ...segments);
}

export async function getDoc(documentRef) {
  await ensureFirebaseInitialized();
  const { getDoc: readDoc } = await import(FIREBASE_MODULES.firestore);
  return readDoc(documentRef);
}

export async function setDoc(documentRef, data, options) {
  await ensureFirebaseInitialized();
  const { setDoc: writeDoc } = await import(FIREBASE_MODULES.firestore);
  return writeDoc(documentRef, data, options || {});
}
