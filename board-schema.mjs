export const BOARD_SCHEMA_VERSION = 2;
export const BOARD_ROLES = Object.freeze(["OWNER", "EDITOR", "VIEWER"]);
export const TASK_PRIORITIES = Object.freeze(["baixa", "media", "alta"]);
export const STORY_POINT_VALUES = Object.freeze([1, 2, 3, 5, 8, 13]);

export function isValidLegacyState(value) {
  return Boolean(
    value &&
    Array.isArray(value.columns) &&
    value.columns.length > 0 &&
    value.columns.every((column) =>
      column &&
      typeof column.id === "string" &&
      column.id.trim().length > 0 &&
      typeof column.title === "string" &&
      Array.isArray(column.cards) &&
      column.cards.every((card) =>
        card &&
        typeof card.id === "string" &&
        card.id.trim().length > 0 &&
        typeof card.title === "string" &&
        card.title.trim().length > 0 &&
        typeof card.description === "string" &&
        TASK_PRIORITIES.includes(card.priority) &&
        typeof card.dueDate === "string"
      )
    )
  );
}

function toDocumentId(value) {
  const documentId = encodeURIComponent(value);
  if (!documentId || documentId.length > 1200) {
    throw new Error("O quadro contém um identificador de tarefa inválido para migração.");
  }
  return documentId;
}

export function buildBoardMigration(uid, legacyState) {
  if (typeof uid !== "string" || !uid.trim()) {
    throw new Error("É necessário um UID autenticado para migrar o quadro.");
  }
  if (!isValidLegacyState(legacyState)) {
    throw new Error("O quadro legado está inválido; a migração foi interrompida para preservar os dados.");
  }

  const board = {
    id: uid,
    name: "Meu Kanban",
    ownerId: uid,
    schemaVersion: BOARD_SCHEMA_VERSION,
    definitionOfDone: "",
    columns: legacyState.columns.map((column, order) => ({
      id: column.id,
      title: column.title,
      order,
      wipLimit: null
    }))
  };
  const member = {
    userId: uid,
    role: "OWNER"
  };
  const tasks = [];
  const seenTaskIds = new Set();

  legacyState.columns.forEach((column) => {
    column.cards.forEach((card, position) => {
      const id = toDocumentId(card.id);
      if (seenTaskIds.has(id)) {
        throw new Error("O quadro contém IDs de tarefa duplicados; a migração foi interrompida.");
      }
      seenTaskIds.add(id);

      tasks.push({
        id,
        legacyId: card.id,
        boardId: uid,
        columnId: column.id,
        position,
        title: card.title,
        description: card.description,
        priority: card.priority,
        dueDate: card.dueDate,
        assigneeId: null,
        labels: [],
        checklist: [],
        acceptanceCriteria: [],
        storyPoints: null,
        sprintId: null,
        createdBy: uid
      });
    });
  });

  return { board, member, tasks };
}

export function buildCommentRecord({ authorId, authorEmail, text, createdAt, updatedAt = createdAt }) {
  if (typeof authorId !== "string" || !authorId.trim()) {
    throw new Error("O comentário precisa de um autor autenticado.");
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("O comentário não pode estar vazio.");
  }
  if (!createdAt || !updatedAt) {
    throw new Error("O comentário precisa de datas de criação e atualização.");
  }

  return {
    authorId,
    authorEmail: typeof authorEmail === "string" ? authorEmail : "",
    text: text.trim(),
    createdAt,
    updatedAt
  };
}
