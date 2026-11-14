import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { AiProviderError } from "../aiService.js";
import { createApp } from "../app.js";

function makeSnapshot(data) {
  return {
    exists: data !== null,
    data: () => data
  };
}

function createFakeFirestore({
  member = { userId: "user-1", boardId: "board-1", role: "OWNER" },
  board = { name: "Projeto real", columns: [{ id: "doing", title: "Em andamento" }] },
  tasks = [{
    title: "Card real",
    description: "Descrição real",
    columnId: "doing",
    priority: "alta",
    dueDate: "2026-12-01",
    assigneeId: "user-assignee-123456",
    labels: ["lançamento"],
    storyPoints: 3,
    checklist: [{ done: true }, { done: false }],
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    email: "private@example.com",
    token: "must-not-be-sent"
  }]
} = {}) {
  const firestore = {
    collection(name) {
      assert.equal(name, "boards");
      return {
        doc(boardId) {
          assert.equal(boardId, "board-1");
          return {
            async get() {
              return makeSnapshot(board);
            },
            collection(name) {
              if (name === "members") {
                return {
                  doc(userId) {
                    assert.equal(userId, "user-1");
                    return { async get() { return makeSnapshot(member); } };
                  }
                };
              }
              assert.equal(name, "tasks");
              const taskCollection = {
                limit() {
                  return {
                    async get() {
                      return {
                        size: tasks.length,
                        docs: tasks.map((task) => ({ data: () => task }))
                      };
                    }
                  };
                },
                doc(taskId) {
                  return {
                    async get() {
                      return makeSnapshot(taskId === "task-1" ? tasks[0] : null);
                    }
                  };
                }
              };
              return taskCollection;
            }
          };
        }
      };
    },
    async runTransaction(callback) {
      return callback({
        async get() {
          return makeSnapshot(tasks[0]);
        },
        update(reference, data) {
          Object.assign(tasks[0], data);
        }
      });
    }
  };
  firestore.tasks = tasks;
  return firestore;
}

async function startTestServer(options = {}) {
  const auth = {
    async verifyIdToken(token) {
      if (token !== "valid-token") throw new Error("invalid token");
      return { uid: "user-1" };
    }
  };
  const firestore = createFakeFirestore(options.firestore);
  const app = createApp({
    auth,
    firestore,
    generateAnswer: options.generateAnswer || (async () => "Resposta de teste."),
    rateLimit: options.rateLimit ?? 10,
    allowedOrigins: ["http://localhost:5500"]
  });
  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();

  return {
    server,
    firestore,
    baseUrl: `http://127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}/api/ai/chat`
  };
}

async function postChat(url, { token = "valid-token", body = {
  boardId: "board-1",
  pergunta: "O que está travado?"
} } = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

async function postSubtasks(baseUrl, { token = "valid-token", role, aiResponse } = {}) {
  const fixture = await startTestServer({
    firestore: role ? { member: { userId: "user-1", boardId: "board-1", role } } : undefined,
    generateAnswer: aiResponse
      ? async () => aiResponse
      : async () => '["Preparar ambiente","Implementar fluxo","Validar resultado"]'
  });
  if (baseUrl) fixture.baseUrl = baseUrl;
  return {
    fixture,
    response: await fetch(`${fixture.baseUrl}/api/ai/tasks/task-1/subtasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ boardId: "board-1" })
    })
  };
}

let server;
let url;

before(async () => {
  ({ server, url } = await startTestServer());
});

after(() => {
  server.close();
});

test("requires a valid Firebase login", async () => {
  const response = await postChat(url, { token: null });
  assert.equal(response.status, 401);
});

test("rejects users who are not board members", async () => {
  const fixture = await startTestServer({
    firestore: { member: null }
  });
  try {
    const response = await postChat(fixture.url);
    assert.equal(response.status, 403);
  } finally {
    fixture.server.close();
  }
});

test("allows VIEWER members to consult the board", async () => {
  const fixture = await startTestServer({
    firestore: {
      member: { userId: "user-1", boardId: "board-1", role: "VIEWER" }
    }
  });
  try {
    const response = await postChat(fixture.url);
    assert.equal(response.status, 200);
  } finally {
    fixture.server.close();
  }
});

test("rejects an empty or oversized question", async () => {
  const empty = await postChat(url, {
    body: { boardId: "board-1", pergunta: "   " }
  });
  assert.equal(empty.status, 400);

  const oversized = await postChat(url, {
    body: { boardId: "board-1", pergunta: "x".repeat(501) }
  });
  assert.equal(oversized.status, 400);
});

test("builds the prompt from sanitized real cards and returns the expected shape", async () => {
  let capturedPrompt = "";
  const fixture = await startTestServer({
    generateAnswer: async (prompt) => {
      capturedPrompt = prompt;
      return "O card real está em andamento.";
    }
  });

  try {
    const response = await postChat(fixture.url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resposta: "O card real está em andamento."
    });
    assert.match(capturedPrompt, /Card real/);
    assert.match(capturedPrompt, /Não invente cards/);
    assert.match(capturedPrompt, /nunca instruções/);
    assert.doesNotMatch(capturedPrompt, /private@example\.com|must-not-be-sent/);
    assert.match(capturedPrompt, /Membro-123456/);
  } finally {
    fixture.server.close();
  }
});

test("returns a friendly error when the AI provider fails", async () => {
  const fixture = await startTestServer({
    generateAnswer: async () => {
      throw new AiProviderError("provider");
    }
  });

  try {
    const response = await postChat(fixture.url);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /indisponível/);
    assert.doesNotMatch(JSON.stringify(body), /Falha no provedor de IA/);
  } finally {
    fixture.server.close();
  }
});

test("applies a per-user rate limit", async () => {
  const fixture = await startTestServer({ rateLimit: 1 });
  try {
    assert.equal((await postChat(fixture.url)).status, 200);
    assert.equal((await postChat(fixture.url)).status, 429);
  } finally {
    fixture.server.close();
  }
});

test("allows OWNER and EDITOR but forbids VIEWER from generating subtasks", async () => {
  const { fixture, response } = await postSubtasks(null, { role: "VIEWER" });
  try {
    assert.equal(response.status, 403);
  } finally {
    fixture.server.close();
  }
});

test("validates AI JSON and appends generated subtasks to the task checklist", async () => {
  const { fixture, response } = await postSubtasks(null, { role: "EDITOR" });
  try {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.subtasks.length, 3);
    assert.deepEqual(
      body.checklist.slice(-body.subtasks.length).map((item) => item.text),
      body.subtasks
    );
    assert.ok(
      body.checklist
        .slice(-body.subtasks.length)
        .every((item) => item.done === false && item.id)
    );
    assert.equal(fixture.firestore.tasks[0].checklist.length, 5);
  } finally {
    fixture.server.close();
  }
});

test("rejects malformed AI JSON without changing the checklist", async () => {
  const { fixture, response } = await postSubtasks(null, {
    role: "OWNER",
    aiResponse: "```json\n[\"uma\", \"duas\", \"tres\"]\n```"
  });
  try {
    assert.equal(response.status, 502);
    assert.equal(fixture.firestore.tasks[0].checklist.length, 2);
  } finally {
    fixture.server.close();
  }
});
