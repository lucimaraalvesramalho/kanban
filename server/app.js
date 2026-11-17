import express from "express";
import { AiProviderError } from "./aiService.js";
import { requireBoardMember } from "./middleware/boardAccess.js";
import { requireFirebaseAuth } from "./middleware/firebaseAuth.js";
import { buildProjectPrompt, loadProjectContext } from "./projectContext.js";
import {
  appendSubtasksToTask,
  buildSubtasksPrompt,
  ChecklistLimitError,
  InvalidSubtaskOutputError,
  parseSubtasksResponse,
  TaskNotFoundError
} from "./subtaskService.js";

const MAX_QUESTION_LENGTH = 500;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 10;

function validateChatInput(request, response, next) {
  // Valida o identificador do quadro e o tamanho da pergunta recebida.
  const boardId = request.body?.boardId ?? request.body?.projectId;
  const question = request.body?.pergunta;

  if (
    typeof boardId !== "string" ||
    !boardId.trim() ||
    boardId.length > 128 ||
    boardId.includes("/")
  ) {
    response.status(400).json({ error: "Informe um identificador de quadro válido." });
    return;
  }

  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > MAX_QUESTION_LENGTH
  ) {
    response.status(400).json({
      error: `A pergunta é obrigatória e deve ter até ${MAX_QUESTION_LENGTH} caracteres.`
    });
    return;
  }

  request.boardId = boardId.trim();
  request.question = question.trim();
  next();
}

function validateSubtaskInput(request, response, next) {
  // Valida os identificadores usados ao gerar subtarefas.
  const boardId = request.body?.boardId ?? request.body?.projectId;
  const taskId = request.params.taskId;

  if (
    typeof boardId !== "string" ||
    !boardId.trim() ||
    boardId.length > 128 ||
    boardId.includes("/") ||
    typeof taskId !== "string" ||
    !taskId ||
    taskId.length > 128 ||
    taskId.includes("/")
  ) {
    response.status(400).json({ error: "Informe identificadores válidos para o quadro e a tarefa." });
    return;
  }

  request.boardId = boardId.trim();
  request.taskId = taskId;
  next();
}

function createUserRateLimiter({ limit, windowMs, now }) {
  // Limita por usuário a quantidade de requisições em uma janela de tempo.
  const windows = new Map();

  return (request, response, next) => {
    const currentTime = now();
    const userId = request.user.uid;
    let entry = windows.get(userId);

    if (!entry || currentTime - entry.startedAt >= windowMs) {
      entry = { startedAt: currentTime, count: 0 };
      windows.set(userId, entry);
    }

    entry.count += 1;
    if (entry.count > limit) {
      response.status(429).json({
        error: "Você enviou muitas perguntas. Aguarde um minuto e tente novamente."
      });
      return;
    }

    if (windows.size > 1000) {
      for (const [id, window] of windows) {
        if (currentTime - window.startedAt >= windowMs) windows.delete(id);
      }
    }

    next();
  };
}

export function createApp({
  auth,
  firestore,
  generateAnswer,
  allowedOrigins = [],
  rateLimit = RATE_LIMIT_REQUESTS,
  rateLimitWindowMs = RATE_LIMIT_WINDOW_MS,
  now = Date.now
}) {
  // Configura dependências, CORS, autenticação e rotas da API de IA.
  if (!auth || !firestore || typeof generateAnswer !== "function") {
    throw new Error("Dependências do servidor de IA não foram configuradas.");
  }

  const app = express();
  const allowedOriginSet = new Set(allowedOrigins);

  app.use((request, response, next) => {
    const origin = request.get("origin");
    if (origin && allowedOriginSet.size && !allowedOriginSet.has(origin)) {
      response.status(403).json({ error: "Origem não permitida." });
      return;
    }

    if (origin && allowedOriginSet.has(origin)) {
      response.set("Access-Control-Allow-Origin", origin);
      response.set("Vary", "Origin");
      response.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    }

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }

    next();
  });
  app.use(express.json({ limit: "10kb" }));

  app.post(
    "/api/ai/chat",
    requireFirebaseAuth(auth),
    validateChatInput,
    createUserRateLimiter({
      limit: rateLimit,
      windowMs: rateLimitWindowMs,
      now
    }),
    requireBoardMember(firestore),
    async (request, response) => {
      try {
        const context = await loadProjectContext(
          firestore,
          request.boardId,
          request.board
        );
        const prompt = buildProjectPrompt({
          question: request.question,
          context
        });
        const resposta = await generateAnswer(prompt);
        response.json({ resposta });
      } catch (error) {
        if (error instanceof AiProviderError && error.kind === "timeout") {
          response.status(504).json({
            error: "O assistente demorou para responder. Tente novamente."
          });
          return;
        }

        if (error instanceof AiProviderError) {
          response.status(503).json({
            error: "O assistente está indisponível no momento. Tente novamente mais tarde."
          });
          return;
        }

        console.error("Falha ao processar uma pergunta do Kanban AI.");
        response.status(500).json({
          error: "Não foi possível consultar os dados do quadro agora."
        });
      }
    }
  );

  app.post(
    "/api/ai/tasks/:taskId/subtasks",
    requireFirebaseAuth(auth),
    validateSubtaskInput,
    createUserRateLimiter({
      limit: rateLimit,
      windowMs: rateLimitWindowMs,
      now
    }),
    requireBoardMember(firestore, new Set(["OWNER", "EDITOR"])),
    async (request, response) => {
      try {
        const taskRef = firestore
          .collection("boards")
          .doc(request.boardId)
          .collection("tasks")
          .doc(request.taskId);
        const taskSnapshot = await taskRef.get();
        if (!taskSnapshot.exists) {
          response.status(404).json({ error: "A tarefa não foi encontrada." });
          return;
        }

        const task = taskSnapshot.data();
        if (typeof task.title !== "string" || !task.title.trim()) {
          response.status(400).json({ error: "A tarefa precisa ter um título para ser dividida." });
          return;
        }

        const prompt = buildSubtasksPrompt({
          title: task.title,
          description: task.description
        });
        const subtasks = parseSubtasksResponse(await generateAnswer(prompt));
        const checklist = await appendSubtasksToTask({
          firestore,
          boardId: request.boardId,
          taskId: request.taskId,
          subtasks,
          serverTimestamp: () => new Date()
        });
        response.json({ subtasks, checklist });
      } catch (error) {
        if (error instanceof TaskNotFoundError) {
          response.status(404).json({ error: "A tarefa não foi encontrada." });
          return;
        }
        if (error instanceof ChecklistLimitError) {
          response.status(409).json({ error: "O checklist atingiu o limite de 50 itens." });
          return;
        }
        if (error instanceof InvalidSubtaskOutputError) {
          response.status(502).json({
            error: "A IA não conseguiu montar subtarefas em um formato válido. Tente novamente."
          });
          return;
        }
        if (error instanceof AiProviderError && error.kind === "timeout") {
          response.status(504).json({
            error: "O assistente demorou para responder. Tente novamente."
          });
          return;
        }
        if (error instanceof AiProviderError) {
          response.status(503).json({
            error: "O assistente está indisponível no momento. Tente novamente mais tarde."
          });
          return;
        }

        console.error("Falha ao gerar subtarefas para uma tarefa.");
        response.status(500).json({
          error: "Não foi possível salvar as subtarefas agora."
        });
      }
    }
  );

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    if (error instanceof SyntaxError && error.status === 400) {
      response.status(400).json({ error: "O corpo da requisição não contém JSON válido." });
      return;
    }

    if (error.status === 413) {
      response.status(413).json({ error: "A requisição excede o tamanho permitido." });
      return;
    }

    console.error("Erro interno ao processar uma requisição do Kanban AI.");
    response.status(500).json({ error: "Ocorreu um erro interno. Tente novamente." });
  });

  return app;
}
