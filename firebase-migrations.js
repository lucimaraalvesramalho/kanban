import { auth, db, ensureFirebaseInitialized } from "./firebase.js";
import { buildBoardMigration, BOARD_SCHEMA_VERSION } from "./board-schema.mjs";

const FIRESTORE_MODULE =
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
const LEGACY_STATE_PATH = (uid) => ["users", uid, "kanban", "state"];
const BOARD_PATH = (boardId) => ["boards", boardId];
const MEMBER_PATH = (boardId, uid) => ["boards", boardId, "members", uid];
const TASK_PATH = (boardId, taskId) => ["boards", boardId, "tasks", taskId];
const BATCH_SIZE = 400;

function makeDefaultLegacyState() {
  return {
    columns: [
      { id: crypto.randomUUID(), title: "A Fazer", cards: [] },
      { id: crypto.randomUUID(), title: "Em Andamento", cards: [] },
      { id: crypto.randomUUID(), title: "Concluído", cards: [] }
    ]
  };
}

export async function migrateCurrentUserBoard({ activate = false } = {}) {
  await ensureFirebaseInitialized();
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Entre na sua conta antes de migrar o quadro.");
  }

  const { doc, getDoc, serverTimestamp, writeBatch } = await import(FIRESTORE_MODULE);
  const boardRef = doc(db, ...BOARD_PATH(user.uid));
  const legacyRef = doc(db, ...LEGACY_STATE_PATH(user.uid));
  const existingBoard = await getDoc(boardRef);

  if (existingBoard.exists()) {
    const data = existingBoard.data();
    if (data.ownerId !== user.uid) {
      throw new Error("O quadro de destino pertence a outra conta; nenhum dado foi alterado.");
    }
    if (data.schemaVersion > BOARD_SCHEMA_VERSION) {
      throw new Error("O quadro usa uma versão de dados mais nova e não pode ser migrado por esta versão do app.");
    }
    if (data.migrationStatus === "complete" &&
      (!activate || data.sourceMode === "normalized")) {
      return { status: "already-migrated", boardId: user.uid, taskCount: null };
    }
    if (data.schemaVersion === BOARD_SCHEMA_VERSION &&
      data.migrationStatus !== "in-progress" &&
      data.migrationStatus !== "complete") {
      throw new Error("Já existe um quadro neste formato que não foi criado pela migração. Nada foi sobrescrito.");
    }
  }

  const legacySnapshot = await getDoc(legacyRef);
  if (!existingBoard.exists() && legacySnapshot.exists() &&
    legacySnapshot.data().boardDeleted === true) {
    return { status: "board-deleted", boardId: user.uid, taskCount: null };
  }
  const legacyState = legacySnapshot.exists()
    ? legacySnapshot.data()
    : makeDefaultLegacyState();
  const migration = buildBoardMigration(user.uid, legacyState);
  const timestamp = serverTimestamp();
  const boardData = {
    ...migration.board,
    migrationStatus: "in-progress",
    createdAt: existingBoard.exists() && existingBoard.data().createdAt
      ? existingBoard.data().createdAt
      : timestamp,
    updatedAt: timestamp
  };
  const memberData = {
    ...migration.member,
    boardId: user.uid,
    boardName: migration.board.name,
    ownerId: user.uid,
    email: user.email || "",
    createdAt: timestamp
  };

  const metadataBatch = writeBatch(db);
  metadataBatch.set(boardRef, boardData, { merge: true });
  metadataBatch.set(doc(db, ...MEMBER_PATH(user.uid, user.uid)), memberData, { merge: true });
  await metadataBatch.commit();

  for (let offset = 0; offset < migration.tasks.length; offset += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = migration.tasks.slice(offset, offset + BATCH_SIZE);
    chunk.forEach((task) => {
      batch.set(doc(db, ...TASK_PATH(user.uid, task.id)), {
        ...task,
        createdAt: timestamp,
        updatedAt: timestamp
      }, { merge: true });
    });
    await batch.commit();
  }

  const completeBatch = writeBatch(db);
  completeBatch.update(boardRef, {
    migrationStatus: "complete",
    sourceMode: activate ? "normalized" : "legacy",
    migratedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  await completeBatch.commit();

  return {
    status: "migrated",
    boardId: user.uid,
    taskCount: migration.tasks.length,
    legacyDataPreserved: legacySnapshot.exists()
  };
}
