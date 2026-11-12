import test from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_SCHEMA_VERSION,
  buildBoardMigration,
  buildCommentRecord,
  isValidLegacyState
} from "../board-schema.mjs";

function legacyBoard() {
  return {
    columns: [
      {
        id: "todo",
        title: "A Fazer",
        cards: [{
          id: "task/1",
          title: "Preparar release",
          description: "Validar a versão",
          priority: "alta",
          dueDate: "2026-12-01"
        }]
      }
    ]
  };
}

test("migrates existing columns and tasks with safe schema defaults", () => {
  const migration = buildBoardMigration("owner-1", legacyBoard());

  assert.equal(migration.board.schemaVersion, BOARD_SCHEMA_VERSION);
  assert.equal(migration.board.ownerId, "owner-1");
  assert.equal(migration.member.role, "OWNER");
  assert.equal(migration.tasks.length, 1);
  assert.equal(migration.tasks[0].id, "task%2F1");
  assert.equal(migration.tasks[0].columnId, "todo");
  assert.equal(migration.tasks[0].assigneeId, null);
  assert.deepEqual(migration.tasks[0].labels, []);
  assert.deepEqual(migration.tasks[0].checklist, []);
  assert.deepEqual(migration.tasks[0].acceptanceCriteria, []);
  assert.equal(migration.tasks[0].storyPoints, null);
  assert.equal(migration.tasks[0].sprintId, null);
});

test("rejects malformed or duplicate legacy task IDs without producing a migration", () => {
  const invalid = legacyBoard();
  invalid.columns[0].cards[0].priority = "urgent";
  assert.equal(isValidLegacyState(invalid), false);
  assert.throws(() => buildBoardMigration("owner-1", invalid), /legado está inválido/);

  const duplicate = legacyBoard();
  duplicate.columns.push({
    id: "doing",
    title: "Em Andamento",
    cards: [{ ...duplicate.columns[0].cards[0] }]
  });
  assert.throws(() => buildBoardMigration("owner-1", duplicate), /IDs de tarefa duplicados/);
});

test("comment model requires an author and non-empty text", () => {
  const timestamp = "2026-11-12T00:00:00.000Z";
  assert.deepEqual(
    buildCommentRecord({
      authorId: "user-1",
      authorEmail: "user@example.com",
      text: "  Feito  ",
      createdAt: timestamp
    }),
    {
      authorId: "user-1",
      authorEmail: "user@example.com",
      text: "Feito",
      createdAt: timestamp,
      updatedAt: timestamp
    }
  );
  assert.throws(
    () => buildCommentRecord({ authorId: "", authorEmail: "", text: "Comentário" }),
    /autor autenticado/
  );
  assert.throws(
    () => buildCommentRecord({ authorId: "user-1", authorEmail: "", text: " " }),
    /não pode estar vazio/
  );
  assert.throws(
    () => buildCommentRecord({ authorId: "user-1", authorEmail: "", text: "Comentário" }),
    /datas de criação e atualização/
  );
});
