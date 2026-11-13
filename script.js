import {
  createUserWithEmailAndPassword,
  db,
  firebaseReady,
  getFirestoreApi,
  onAuthStateChanged,
  setDoc,
  signInWithEmailAndPassword,
  signOutUser
} from "./firebase.js";
import { migrateCurrentUserBoard } from "./firebase-migrations.js";

const THEME_KEY = "meu-kanban-theme-v1";
const PRIORITIES = ["baixa", "media", "alta"];

let state = { columns: [] };
let currentUser = null;
let draggedCardId = null;
let lastFocusedElement = null;
let editingColumnId = null;
let authMode = "login";
let memberships = [];
let activeBoard = null;
let persistedTaskIds = new Set();
let persistedTaskIdsByBoard = new Map();
let boardSelectionId = 0;
let unsubscribeMembership = null;
let saveQueue = Promise.resolve();

const board = document.querySelector("#board");
const cardDialog = document.querySelector("#card-dialog");
const columnDialog = document.querySelector("#column-dialog");
const newBoardDialog = document.querySelector("#new-board-dialog");
const shareDialog = document.querySelector("#share-dialog");

const ui = {
  appShell: document.querySelector("#app-shell"),
  authScreen: document.querySelector("#auth-screen"),
  authForm: document.querySelector("#auth-form"),
  authEmail: document.querySelector("#auth-email"),
  authPassword: document.querySelector("#auth-password"),
  authFeedback: document.querySelector("#auth-feedback"),
  authTabs: document.querySelectorAll(".auth-tab"),
  signOut: document.querySelector("#sign-out"),
  pageTitle: document.querySelector("#page-title"),
  addCard: document.querySelector("#add-card"),
  clearBoard: document.querySelector("#clear-board"),
  addColumn: document.querySelector("#add-column"),
  shareBoard: document.querySelector("#share-board"),
  createBoard: document.querySelector("#create-board"),
  ownedBoards: document.querySelector("#owned-boards"),
  sharedBoards: document.querySelector("#shared-boards"),
  search: document.querySelector("#search-input"),
  priority: document.querySelector("#priority-filter"),
  cardForm: document.querySelector("#card-form"),
  cardTitle: document.querySelector("#card-title"),
  cardDescription: document.querySelector("#card-description"),
  cardPriority: document.querySelector("#card-priority"),
  cardDueDate: document.querySelector("#card-due-date"),
  columnForm: document.querySelector("#column-form"),
  columnTitle: document.querySelector("#column-title"),
  newBoardForm: document.querySelector("#new-board-form"),
  newBoardName: document.querySelector("#new-board-name"),
  inviteForm: document.querySelector("#invite-form"),
  inviteEmail: document.querySelector("#invite-email"),
  inviteRole: document.querySelector("#invite-role"),
  shareFeedback: document.querySelector("#share-feedback"),
  membersList: document.querySelector("#members-list"),
  invitesList: document.querySelector("#invites-list"),
  deleteBoard: document.querySelector("#delete-board")
};

function createId() {
  return crypto.randomUUID();
}

function createInitialState() {
  return {
    columns: [
      { id: createId(), title: "A Fazer", cards: [] },
      { id: createId(), title: "Em Andamento", cards: [] },
      { id: createId(), title: "Concluído", cards: [] }
    ]
  };
}

function isOwner() {
  return Boolean(activeBoard && activeBoard.role === "OWNER");
}

function canEditTasks() {
  return Boolean(activeBoard && ["OWNER", "EDITOR"].includes(activeBoard.role));
}

function canManageMembers() {
  return isOwner();
}

function getBoardMembershipPath(boardId, userId) {
  return ["boards", boardId, "members", userId];
}

function getTaskPath(boardId, taskId) {
  return ["boards", boardId, "tasks", taskId];
}

function showOperationError(message, error) {
  console.error(message, error);
  window.alert(message);
}

function applyBoardPermissions() {
  const owner = isOwner();
  const editor = canEditTasks();
  ui.addCard.hidden = !editor;
  ui.clearBoard.hidden = !owner;
  ui.addColumn.hidden = !owner;
  ui.shareBoard.hidden = !owner;
}

function renderBoardNavigation() {
  ui.ownedBoards.replaceChildren();
  ui.sharedBoards.replaceChildren();

  memberships.forEach((membership) => {
    const button = makeElement("button", "board-link", membership.boardName || "Quadro");
    button.type = "button";
    button.dataset.boardId = membership.boardId;
    if (activeBoard && activeBoard.boardId === membership.boardId) {
      button.classList.add("is-active");
    }

    if (membership.role !== "OWNER") {
      button.append(makeElement("span", "board-role", membership.role === "EDITOR" ? "Editor" : "Leitor"));
    }
    button.addEventListener("click", () => selectBoard(membership));
    (membership.role === "OWNER" ? ui.ownedBoards : ui.sharedBoards).append(button);
  });
}

async function selectBoard(membership) {
  if (!membership || !membership.boardId) return;
  const selectionId = ++boardSelectionId;
  const userId = currentUser && currentUser.uid;

  try {
    const firestore = await getFirestoreApi();
    const boardRef = firestore.doc(db, "boards", membership.boardId);
    const boardSnapshot = await firestore.getDoc(boardRef);
    if (!boardSnapshot.exists()) {
      throw new Error("O quadro não existe mais ou seu acesso foi removido.");
    }

    const boardData = boardSnapshot.data();
    const taskSnapshots = await firestore.getDocs(
      firestore.collection(db, "boards", membership.boardId, "tasks")
    );
    if (selectionId !== boardSelectionId || !currentUser || currentUser.uid !== userId) return;
    const columns = Array.isArray(boardData.columns)
      ? [...boardData.columns].sort((a, b) => (a.order || 0) - (b.order || 0))
      : [];
    if (!columns.length) {
      throw new Error("O quadro não contém colunas válidas.");
    }

    const nextState = { columns: columns.map((column) => ({ ...column, cards: [] })) };
    const nextTaskIds = new Set();
    taskSnapshots.docs.forEach((taskSnapshot) => {
      const task = { ...taskSnapshot.data(), id: taskSnapshot.id };
      const targetColumn = nextState.columns.find((column) => column.id === task.columnId);
      if (!targetColumn) {
        throw new Error(`A tarefa "${task.title || task.id}" referencia uma coluna inexistente.`);
      }
      targetColumn.cards.push(task);
      nextTaskIds.add(task.id);
    });

    nextState.columns.forEach((column) => column.cards.sort((a, b) => (a.position || 0) - (b.position || 0)));
    activeBoard = {
      boardId: membership.boardId,
      boardName: boardData.name || membership.boardName || "Meu Kanban",
      ownerId: boardData.ownerId,
      role: membership.role
    };
    state = nextState;
    persistedTaskIds = nextTaskIds;
    persistedTaskIdsByBoard.set(activeBoard.boardId, nextTaskIds);
    try {
      localStorage.setItem(`meu-kanban-active-board-${currentUser.uid}`, membership.boardId);
    } catch (error) {
      console.warn("Não foi possível salvar o último quadro selecionado.", error);
    }
    ui.pageTitle.textContent = activeBoard.boardName;
    renderBoardNavigation();
    applyBoardPermissions();
    renderBoard();
    subscribeToBoardMembership(firestore, membership);
  } catch (error) {
    if (selectionId !== boardSelectionId) return;
    showOperationError("Não foi possível abrir esse quadro. Verifique seu acesso e as regras do Firestore.", error);
  }
}

function subscribeToBoardMembership(firestore, membership) {
  if (unsubscribeMembership) unsubscribeMembership();
  const memberRef = firestore.doc(db, ...getBoardMembershipPath(membership.boardId, currentUser.uid));
  unsubscribeMembership = firestore.onSnapshot(memberRef, (snapshot) => {
    if (!activeBoard || activeBoard.boardId !== membership.boardId) return;
    if (!snapshot.exists()) {
      activeBoard = null;
      state = { columns: [] };
      persistedTaskIds = new Set();
      memberships = memberships.filter((item) => item.boardId !== membership.boardId);
      renderBoardNavigation();
      renderBoard();
      applyBoardPermissions();
      window.alert("Seu acesso a este quadro foi removido.");
      if (memberships.length) selectBoard(memberships[0]);
      return;
    }

    const updatedMember = snapshot.data();
    const listEntry = memberships.find((item) => item.boardId === membership.boardId);
    if (listEntry) listEntry.role = updatedMember.role;
    if (activeBoard.role !== updatedMember.role) {
      activeBoard.role = updatedMember.role;
      applyBoardPermissions();
      renderBoardNavigation();
      renderBoard();
    }
  }, (error) => {
    console.error("Não foi possível observar as permissões do quadro.", error);
  });
}

function snapshotState() {
  return {
    columns: state.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => ({ ...card }))
    }))
  };
}

async function persistBoardState(snapshot, boardInfo, previousTaskIds) {
  if (!boardInfo || !currentUser) return new Set();

  const firestore = await getFirestoreApi();
  const timestamp = firestore.serverTimestamp();
  const boardRef = firestore.doc(db, "boards", boardInfo.boardId);
  const columns = snapshot.columns.map((column, order) => ({
    id: column.id,
    title: column.title,
    order,
    wipLimit: Number.isInteger(column.wipLimit) ? column.wipLimit : null
  }));
  const operations = [];
  const nextTaskIds = new Set();

  snapshot.columns.forEach((column) => {
    column.cards.forEach((card, position) => {
      nextTaskIds.add(card.id);
      operations.push({
        type: "set",
        ref: firestore.doc(db, ...getTaskPath(boardInfo.boardId, card.id)),
        data: {
          ...card,
          id: card.id,
          boardId: boardInfo.boardId,
          columnId: column.id,
          position,
          createdBy: card.createdBy || currentUser.uid,
          assigneeId: card.assigneeId || null,
          labels: Array.isArray(card.labels) ? card.labels : [],
          checklist: Array.isArray(card.checklist) ? card.checklist : [],
          acceptanceCriteria: Array.isArray(card.acceptanceCriteria) ? card.acceptanceCriteria : [],
          storyPoints: Number.isInteger(card.storyPoints) ? card.storyPoints : null,
          createdAt: card.createdAt || timestamp,
          updatedAt: timestamp
        }
      });
    });
  });

  previousTaskIds.forEach((taskId) => {
    if (!nextTaskIds.has(taskId)) {
      operations.push({
        type: "delete",
        ref: firestore.doc(db, ...getTaskPath(boardInfo.boardId, taskId))
      });
    }
  });

  let operationOffset = 0;
  let firstBatch = true;
  while (firstBatch || operationOffset < operations.length) {
    const batch = firestore.writeBatch(db);
    if (firstBatch) {
      if (boardInfo.role === "OWNER") {
        batch.update(boardRef, { columns, updatedAt: timestamp });
      }
      firstBatch = false;
    }
    const capacity = operationOffset === 0 && boardInfo.role === "OWNER" ? 399 : 400;
    const chunk = operations.slice(operationOffset, operationOffset + capacity);
    chunk.forEach((operation) => {
      if (operation.type === "delete") batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data, { merge: true });
    });
    operationOffset += chunk.length;
    await batch.commit();
  }

  return nextTaskIds;
}

function saveState() {
  if (!activeBoard || !currentUser) return Promise.resolve();
  const snapshot = snapshotState();
  const boardInfo = { ...activeBoard };
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => persistBoardState(
      snapshot,
      boardInfo,
      new Set(persistedTaskIdsByBoard.get(boardInfo.boardId) || [])
    ))
    .then((taskIds) => {
      persistedTaskIdsByBoard.set(boardInfo.boardId, taskIds);
      if (activeBoard && activeBoard.boardId === boardInfo.boardId) {
        persistedTaskIds = taskIds;
      }
    })
    .catch((error) => showOperationError("Não foi possível salvar as alterações no quadro.", error));
  return saveQueue;
}

async function acceptPendingInvites(user) {
  if (!user.email) return 0;

  const firestore = await getFirestoreApi();
  const pendingQuery = firestore.query(
    firestore.collectionGroup(db, "invites"),
    firestore.where("email", "==", user.email.toLowerCase())
  );
  const snapshots = await firestore.getDocs(pendingQuery);
  let acceptedCount = 0;

  for (const inviteSnapshot of snapshots.docs) {
    const invite = inviteSnapshot.data();
    if (invite.status !== "PENDING" || !invite.boardId ||
      !inviteSnapshot.ref.parent.parent ||
      inviteSnapshot.ref.parent.parent.id !== invite.boardId) continue;

    const memberRef = firestore.doc(db, ...getBoardMembershipPath(invite.boardId, user.uid));
    const existingMember = await firestore.getDoc(memberRef);
    const batch = firestore.writeBatch(db);
    if (!existingMember.exists()) {
      const boardSnapshot = await firestore.getDoc(firestore.doc(db, "boards", invite.boardId));
      if (!boardSnapshot.exists()) continue;
      const boardData = boardSnapshot.data();
      batch.set(memberRef, {
        userId: user.uid,
        boardId: invite.boardId,
        boardName: boardData.name || invite.boardName || "Quadro",
        ownerId: boardData.ownerId,
        email: user.email,
        role: invite.role,
        inviteId: inviteSnapshot.id,
        createdAt: firestore.serverTimestamp()
      });
    }
    batch.update(inviteSnapshot.ref, {
      status: "ACCEPTED",
      acceptedBy: user.uid,
      acceptedAt: firestore.serverTimestamp()
    });
    await batch.commit();
    acceptedCount += 1;
  }
  return acceptedCount;
}

async function loadBoardList(user) {
  const firestore = await getFirestoreApi();
  const memberQuery = firestore.query(
    firestore.collectionGroup(db, "members"),
    firestore.where("userId", "==", user.uid)
  );
  const result = await firestore.getDocs(memberQuery);
  memberships = result.docs
    .map((snapshot) => snapshot.data())
    .filter((member) => member && member.boardId && member.userId === user.uid);
  renderBoardNavigation();

  if (!memberships.length) {
    activeBoard = null;
    state = { columns: [] };
    persistedTaskIds = new Set();
    ui.pageTitle.textContent = "Meu Kanban";
    applyBoardPermissions();
    renderBoard();
    return;
  }

  let savedBoardId = "";
  try {
    savedBoardId = localStorage.getItem(`meu-kanban-active-board-${user.uid}`) || "";
  } catch (error) {
    console.warn("Não foi possível recuperar o último quadro selecionado.", error);
  }
  const selected = memberships.find((member) => member.boardId === savedBoardId) ||
    memberships.find((member) => member.role === "OWNER") ||
    memberships[0];
  await selectBoard(selected);
}

function handleAuthenticatedUser(user) {
  boardSelectionId += 1;
  if (unsubscribeMembership) {
    unsubscribeMembership();
    unsubscribeMembership = null;
  }
  currentUser = user;
  if (!user) {
    activeBoard = null;
    memberships = [];
    persistedTaskIds = new Set();
    persistedTaskIdsByBoard = new Map();
    state = { columns: [] };
    renderBoardNavigation();
    renderBoard();
    applyBoardPermissions();
    showAuthScreen("Entre para acessar seus quadros.");
    return;
  }

  activeBoard = null;
  memberships = [];
  persistedTaskIds = new Set();
  persistedTaskIdsByBoard = new Map();
  state = { columns: [] };
  renderBoardNavigation();
  renderBoard();
  applyBoardPermissions();
  showAppShell();
  migrateCurrentUserBoard({ activate: true })
    .then(() => acceptPendingInvites(user))
    .then((acceptedCount) => loadBoardList(user).then(() => acceptedCount))
    .then((acceptedCount) => {
      if (acceptedCount) setShareFeedback(`${acceptedCount} convite(s) aceito(s).`, false);
    })
    .catch((error) => {
      showOperationError("Não foi possível carregar seus quadros. Verifique as regras e a configuração do Firestore.", error);
    });
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeIconButton(label, symbol, className, onClick) {
  const button = makeElement("button", `icon-button ${className || ""}`, symbol);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderBoard() {
  board.replaceChildren();
  const searchTerm = ui.search.value.trim().toLocaleLowerCase("pt-BR");
  const selectedPriority = ui.priority.value;
  const owner = isOwner();
  const editor = canEditTasks();

  state.columns.forEach((column) => {
    const columnElement = makeElement("section", "column");
    columnElement.dataset.columnId = column.id;
    columnElement.setAttribute("aria-label", `Coluna ${column.title}`);

    const header = makeElement("div", "column-header");
    const titleWrap = makeElement("div", "column-title-wrap");
    titleWrap.append(
      makeElement("h2", "column-title", column.title),
      makeElement("span", "column-count", String(column.cards.length))
    );
    titleWrap.lastChild.setAttribute(
      "aria-label",
      `${column.cards.length} ${column.cards.length === 1 ? "card" : "cards"}`
    );

    const actions = makeElement("div", "column-actions");
    if (owner) {
      actions.append(
        makeIconButton(`Renomear coluna ${column.title}`, "✎", "column-action", () => openColumnDialog(column.id)),
        makeIconButton(`Excluir coluna ${column.title}`, "×", "column-action delete", () => deleteColumn(column.id))
      );
    }
    header.append(titleWrap, actions);

    const list = makeElement("div", "cards-list");
    list.dataset.columnId = column.id;
    const visibleCards = column.cards.filter((card) => matchesFilters(card, searchTerm, selectedPriority));
    visibleCards.forEach((card) => list.append(createCardElement(card, column)));

    if (visibleCards.length === 0) {
      list.append(makeElement("p", "empty-column",
        column.cards.length === 0 ? "Nenhum card por aqui ainda." : "Nenhum card encontrado."));
    }

    columnElement.append(header, list);
    if (editor) {
      const addTaskButton = makeElement("button", "add-task-inline", "+ Adicionar card");
      addTaskButton.type = "button";
      addTaskButton.setAttribute("aria-label", `Adicionar card em ${column.title}`);
      addTaskButton.addEventListener("click", () => openCardDialog(null, column.id));
      columnElement.append(addTaskButton);
    }
    addDropEvents(columnElement);
    board.append(columnElement);
  });
}

function matchesFilters(card, searchTerm, selectedPriority) {
  const matchesText = !searchTerm ||
    `${card.title} ${card.description}`.toLocaleLowerCase("pt-BR").includes(searchTerm);
  return matchesText && (selectedPriority === "todas" || card.priority === selectedPriority);
}

function createCardElement(card, column) {
  const element = makeElement("article", "task-card");
  element.draggable = canEditTasks();
  element.dataset.cardId = card.id;
  element.setAttribute("aria-label", `Card: ${card.title}. Arraste para mover entre colunas.`);

  const top = makeElement("div", "task-card-top");
  top.append(makeElement("h3", "task-title", card.title));
  const actions = makeElement("div", "task-actions");
  if (canEditTasks()) {
    actions.append(makeIconButton(`Editar card ${card.title}`, "✎", "task-action", () => openCardDialog(card.id, column.id)));
  }
  if (isOwner()) {
    actions.append(makeIconButton(`Excluir card ${card.title}`, "×", "task-action", () => deleteCard(card.id)));
  }
  top.append(actions);
  element.append(top);

  if (card.description) element.append(makeElement("p", "task-description", card.description));

  const meta = makeElement("div", "task-meta");
  const priorityNames = { baixa: "Baixa", media: "Média", alta: "Alta" };
  meta.append(makeElement("span", `priority-badge priority-${card.priority}`, priorityNames[card.priority]));
  if (card.dueDate) {
    const dueDate = makeElement("span", "due-date");
    const calendar = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    calendar.setAttribute("viewBox", "0 0 24 24");
    calendar.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13H4V6a1 1 0 0 1 1-1Z");
    calendar.append(path);
    dueDate.append(calendar, document.createTextNode(formatDate(card.dueDate)));
    meta.append(dueDate);
  }
  element.append(meta);

  element.addEventListener("dragstart", (event) => {
    draggedCardId = card.id;
    element.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.id);
  });
  element.addEventListener("dragend", () => {
    element.classList.remove("is-dragging");
    draggedCardId = null;
    document.querySelectorAll(".column.drag-over").forEach((columnElement) => columnElement.classList.remove("drag-over"));
  });
  element.addEventListener("dragover", (event) => event.preventDefault());
  element.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const targetList = element.closest(".cards-list");
    moveCard(draggedCardId || event.dataTransfer.getData("text/plain"), targetList.dataset.columnId, card.id, event.clientY, element);
  });
  return element;
}

function formatDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR").format(new Date(year, month - 1, day));
}

function addDropEvents(columnElement) {
  columnElement.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    columnElement.classList.add("drag-over");
  });
  columnElement.addEventListener("dragleave", (event) => {
    if (!columnElement.contains(event.relatedTarget)) columnElement.classList.remove("drag-over");
  });
  columnElement.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.target.closest(".task-card")) return;
    const id = draggedCardId || event.dataTransfer.getData("text/plain");
    moveCard(id, columnElement.dataset.columnId, null, null, null);
    columnElement.classList.remove("drag-over");
  });
}

function moveCard(cardId, targetColumnId, targetCardId, pointerY, targetElement) {
  if (!canEditTasks() || !cardId || cardId === targetCardId) return;

  let sourceColumn;
  let sourceIndex = -1;
  for (const column of state.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      sourceColumn = column;
      sourceIndex = index;
      break;
    }
  }

  const targetColumn = state.columns.find((column) => column.id === targetColumnId);
  if (!sourceColumn || !targetColumn) return;

  const [card] = sourceColumn.cards.splice(sourceIndex, 1);
  let insertionIndex = targetColumn.cards.length;

  if (targetCardId) {
    insertionIndex = targetColumn.cards.findIndex((item) => item.id === targetCardId);
    if (insertionIndex < 0) insertionIndex = targetColumn.cards.length;
    else if (targetElement && pointerY > targetElement.getBoundingClientRect().top + targetElement.offsetHeight / 2) insertionIndex += 1;
  }

  targetColumn.cards.splice(insertionIndex, 0, card);
  saveState();
  renderBoard();
}

function rememberFocus() {
  lastFocusedElement = document.activeElement;
}

function restoreFocus() {
  if (lastFocusedElement && document.contains(lastFocusedElement)) lastFocusedElement.focus();
}

function openCardDialog(cardId, columnId) {
  if (!canEditTasks()) return;
  rememberFocus();
  ui.cardForm.dataset.columnId = columnId || state.columns[0].id;
  ui.cardForm.dataset.cardId = cardId || "";
  const card = cardId ? findCard(cardId) : null;
  document.querySelector("#card-dialog-title").textContent = card ? "Editar card" : "Novo card";
  ui.cardForm.elements.namedItem("title").value = card ? card.title : "";
  ui.cardDescription.value = card ? card.description : "";
  ui.cardPriority.value = card ? card.priority : "media";
  ui.cardDueDate.value = card ? card.dueDate : "";
  cardDialog.showModal();
  ui.cardTitle.focus();
}

function openColumnDialog(columnId) {
  if (!isOwner()) return;
  rememberFocus();
  editingColumnId = columnId;
  const column = columnId ? state.columns.find((item) => item.id === columnId) : null;
  document.querySelector("#column-dialog-title").textContent = column ? "Renomear coluna" : "Nova coluna";
  document.querySelector("#column-form button[type='submit']").textContent = column ? "Salvar alterações" : "Adicionar coluna";
  ui.columnTitle.value = column ? column.title : "";
  columnDialog.showModal();
  ui.columnTitle.focus();
}

function findCard(cardId) {
  for (const column of state.columns) {
    const card = column.cards.find((item) => item.id === cardId);
    if (card) return card;
  }
  return null;
}

function deleteCard(cardId) {
  if (!isOwner()) return;
  const column = state.columns.find((item) => item.cards.some((card) => card.id === cardId));
  if (!column) return;
  column.cards = column.cards.filter((card) => card.id !== cardId);
  saveState();
  renderBoard();
}

function deleteColumn(columnId) {
  if (!isOwner()) return;
  if (state.columns.length <= 1) {
    window.alert("O board precisa ter pelo menos uma coluna.");
    return;
  }
  const column = state.columns.find((item) => item.id === columnId);
  if (!column) return;
  const message = column.cards.length
    ? `Excluir "${column.title}" e os ${column.cards.length} cards desta coluna?`
    : `Excluir a coluna "${column.title}"?`;
  if (!window.confirm(message)) return;
  state.columns = state.columns.filter((item) => item.id !== columnId);
  saveState();
  renderBoard();
}

function setShareFeedback(message, isError = false) {
  ui.shareFeedback.textContent = message || "";
  ui.shareFeedback.classList.toggle("error", isError);
  ui.shareFeedback.classList.toggle("success", !isError && Boolean(message));
}

function appendShareEmpty(container, message) {
  container.replaceChildren(makeElement("p", "share-empty", message));
}

function getRoleLabel(role) {
  return { OWNER: "Dono", EDITOR: "Editor", VIEWER: "Leitor" }[role] || "Leitor";
}

async function refreshShareLists() {
  if (!canManageMembers() || !activeBoard) return;

  try {
    const firestore = await getFirestoreApi();
    const [membersSnapshot, invitesSnapshot] = await Promise.all([
      firestore.getDocs(firestore.collection(db, "boards", activeBoard.boardId, "members")),
      firestore.getDocs(firestore.collection(db, "boards", activeBoard.boardId, "invites"))
    ]);

    ui.membersList.replaceChildren();
    if (membersSnapshot.empty) {
      appendShareEmpty(ui.membersList, "Ainda não há membros neste quadro.");
    } else {
      membersSnapshot.docs.forEach((memberSnapshot) => {
        const member = memberSnapshot.data();
        const row = makeElement("div", "share-row");
        row.append(makeElement("span", "share-person", member.email || member.userId));
        const actions = makeElement("div", "share-actions");

        if (memberSnapshot.id === currentUser.uid) {
          actions.append(makeElement("span", "board-role", `${getRoleLabel(member.role)} (você)`));
        } else {
          const roleSelect = makeElement("select", "");
          roleSelect.setAttribute("aria-label", `Papel de ${member.email || member.userId}`);
          [
            ["OWNER", "Dono (acesso completo)"],
            ["EDITOR", "Editor"],
            ["VIEWER", "Leitor"]
          ].forEach(([value, label]) => {
            const option = makeElement("option", "", label);
            option.value = value;
            roleSelect.append(option);
          });
          roleSelect.value = member.role;
          roleSelect.addEventListener("change", async () => {
            try {
              await firestore.updateDoc(memberSnapshot.ref, {
                role: roleSelect.value,
                updatedAt: firestore.serverTimestamp()
              });
              setShareFeedback("Papel atualizado.", false);
            } catch (error) {
              setShareFeedback("Não foi possível alterar o papel deste membro.", true);
              console.error("Erro ao alterar papel do membro.", error);
              roleSelect.value = member.role;
            }
          });
          const removeButton = makeElement("button", "button button-quiet", "Remover");
          removeButton.type = "button";
          removeButton.addEventListener("click", async () => {
            const accessLevel = member.role === "OWNER" ? " e os poderes de dono" : "";
            if (!window.confirm(`Remover o acesso${accessLevel} de ${member.email || member.userId}?`)) return;
            try {
              await firestore.deleteDoc(memberSnapshot.ref);
              setShareFeedback("Acesso removido.", false);
              await refreshShareLists();
            } catch (error) {
              setShareFeedback("Não foi possível remover este membro.", true);
              console.error("Erro ao remover membro.", error);
            }
          });
          actions.append(roleSelect, removeButton);
        }
        row.append(actions);
        ui.membersList.append(row);
      });
    }

    const pendingInvites = invitesSnapshot.docs
      .filter((snapshot) => snapshot.data().status === "PENDING");
    ui.invitesList.replaceChildren();
    if (!pendingInvites.length) {
      appendShareEmpty(ui.invitesList, "Não há convites pendentes.");
    } else {
      pendingInvites.forEach((inviteSnapshot) => {
        const invite = inviteSnapshot.data();
        const row = makeElement("div", "share-row");
        row.append(makeElement("span", "share-person", invite.email));
        const actions = makeElement("div", "share-actions");
        actions.append(makeElement("span", "board-role", getRoleLabel(invite.role)));
        const cancelButton = makeElement("button", "button button-quiet", "Cancelar");
        cancelButton.type = "button";
        cancelButton.addEventListener("click", async () => {
          try {
            await firestore.deleteDoc(inviteSnapshot.ref);
            setShareFeedback("Convite cancelado.", false);
            await refreshShareLists();
          } catch (error) {
            setShareFeedback("Não foi possível cancelar o convite.", true);
            console.error("Erro ao cancelar convite.", error);
          }
        });
        actions.append(cancelButton);
        row.append(actions);
        ui.invitesList.append(row);
      });
    }
  } catch (error) {
    setShareFeedback("Não foi possível carregar os membros deste quadro.", true);
    console.error("Erro ao carregar membros e convites.", error);
  }
}

function openShareDialog() {
  if (!canManageMembers()) return;
  rememberFocus();
  setShareFeedback("");
  refreshShareLists();
  shareDialog.showModal();
}

async function createInvitation(event) {
  event.preventDefault();
  if (!canManageMembers() || !activeBoard) return;

  const email = ui.inviteEmail.value.trim().toLowerCase();
  const role = ui.inviteRole.value;
  if (!email || !["OWNER", "EDITOR", "VIEWER"].includes(role)) {
    setShareFeedback("Informe um e-mail válido e um papel permitido.", true);
    return;
  }
  if (currentUser.email && email.toLowerCase() === currentUser.email.toLowerCase()) {
    setShareFeedback("Você já tem acesso a este quadro.", true);
    return;
  }

  try {
    const firestore = await getFirestoreApi();
    const memberQuery = firestore.query(
      firestore.collection(db, "boards", activeBoard.boardId, "members"),
      firestore.where("email", "==", email)
    );
    const inviteQuery = firestore.query(
      firestore.collection(db, "boards", activeBoard.boardId, "invites"),
      firestore.where("email", "==", email)
    );
    const [memberMatches, inviteMatches] = await Promise.all([
      firestore.getDocs(memberQuery),
      firestore.getDocs(inviteQuery)
    ]);
    if (!memberMatches.empty) {
      setShareFeedback("Essa pessoa já tem acesso ao quadro.", true);
      return;
    }
    if (inviteMatches.docs.some((snapshot) => snapshot.data().status === "PENDING")) {
      setShareFeedback("Já existe um convite pendente para esse e-mail.", true);
      return;
    }

    const inviteRef = firestore.doc(db, "boards", activeBoard.boardId, "invites", createId());
    await setDoc(inviteRef, {
      boardId: activeBoard.boardId,
      boardName: activeBoard.boardName,
      ownerId: activeBoard.ownerId,
      email,
      role,
      status: "PENDING",
      invitedBy: currentUser.uid,
      createdAt: firestore.serverTimestamp()
    });
    ui.inviteForm.reset();
    const roleMessage = role === "OWNER"
      ? " A pessoa terá acesso completo, incluindo gerenciar membros e excluir o quadro."
      : "";
    setShareFeedback(`Convite registrado para ${email}. Se a pessoa ainda não tiver conta, ele ficará pendente até ela entrar com esse e-mail.${roleMessage}`, false);
    await refreshShareLists();
  } catch (error) {
    setShareFeedback("Não foi possível criar o convite. Verifique se você é o dono do quadro.", true);
    console.error("Erro ao criar convite.", error);
  }
}

async function createBoard(event) {
  event.preventDefault();
  const name = ui.newBoardName.value.trim();
  if (!name || !currentUser) return;

  try {
    const firestore = await getFirestoreApi();
    const boardId = createId();
    const initialState = createInitialState();
    const boardRef = firestore.doc(db, "boards", boardId);
    const memberRef = firestore.doc(db, ...getBoardMembershipPath(boardId, currentUser.uid));
    const timestamp = firestore.serverTimestamp();
    const batch = firestore.writeBatch(db);
    batch.set(boardRef, {
      id: boardId,
      name,
      ownerId: currentUser.uid,
      schemaVersion: 2,
      definitionOfDone: "",
      columns: initialState.columns.map((column, order) => ({
        id: column.id,
        title: column.title,
        order,
        wipLimit: null
      })),
      createdAt: timestamp,
      updatedAt: timestamp
    });
    batch.set(memberRef, {
      userId: currentUser.uid,
      boardId,
      boardName: name,
      ownerId: currentUser.uid,
      email: currentUser.email || "",
      role: "OWNER",
      createdAt: timestamp
    });
    await batch.commit();

    const membership = {
      userId: currentUser.uid,
      boardId,
      boardName: name,
      ownerId: currentUser.uid,
      email: currentUser.email || "",
      role: "OWNER"
    };
    memberships = [...memberships, membership];
    newBoardDialog.close();
    ui.newBoardForm.reset();
    renderBoardNavigation();
    await selectBoard(membership);
  } catch (error) {
    showOperationError("Não foi possível criar o quadro.", error);
  }
}

async function deleteDocumentRefs(firestore, refs) {
  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = firestore.writeBatch(db);
    refs.slice(offset, offset + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

async function deleteActiveBoard() {
  if (!isOwner() || !activeBoard) return;
  const boardId = activeBoard.boardId;
  const boardName = activeBoard.boardName;
  if (!window.confirm(`Excluir o quadro "${boardName}" e todo o seu conteúdo? Essa ação não pode ser desfeita.`)) return;

  try {
    const firestore = await getFirestoreApi();
    const [membersSnapshot, invitesSnapshot, tasksSnapshot] = await Promise.all([
      firestore.getDocs(firestore.collection(db, "boards", boardId, "members")),
      firestore.getDocs(firestore.collection(db, "boards", boardId, "invites")),
      firestore.getDocs(firestore.collection(db, "boards", boardId, "tasks"))
    ]);
    const childRefs = [...invitesSnapshot.docs.map((snapshot) => snapshot.ref)];
    for (const taskSnapshot of tasksSnapshot.docs) {
      const comments = await firestore.getDocs(
        firestore.collection(db, "boards", boardId, "tasks", taskSnapshot.id, "comments")
      );
      childRefs.push(...comments.docs.map((snapshot) => snapshot.ref), taskSnapshot.ref);
    }
    childRefs.push(...membersSnapshot.docs
      .filter((snapshot) => snapshot.id !== currentUser.uid)
      .map((snapshot) => snapshot.ref));
    await deleteDocumentRefs(firestore, childRefs);

    if (unsubscribeMembership) {
      unsubscribeMembership();
      unsubscribeMembership = null;
    }
    const finalBatch = firestore.writeBatch(db);
    finalBatch.delete(firestore.doc(db, ...getBoardMembershipPath(boardId, currentUser.uid)));
    finalBatch.delete(firestore.doc(db, "boards", boardId));
    if (boardId === currentUser.uid) {
      finalBatch.set(
        firestore.doc(db, "users", currentUser.uid, "kanban", "state"),
        { boardDeleted: true, boardDeletedAt: firestore.serverTimestamp() },
        { merge: true }
      );
    }
    await finalBatch.commit();

    memberships = memberships.filter((member) => member.boardId !== boardId);
    activeBoard = null;
    state = { columns: [] };
    renderBoardNavigation();
    if (memberships.length) {
      await selectBoard(memberships[0]);
    } else {
      await loadBoardList(currentUser);
    }
    shareDialog.close();
  } catch (error) {
    showOperationError("Não foi possível excluir o quadro e seus dados.", error);
  }
}

function setAuthFeedback(message, isError = false) {
  ui.authFeedback.textContent = message || "";
  ui.authFeedback.classList.toggle("error", isError);
  ui.authFeedback.classList.toggle("success", !isError && Boolean(message));
}

function showAppShell() {
  ui.authScreen.classList.add("hidden");
  ui.appShell.classList.remove("hidden");
}

function showAuthScreen(message = "") {
  ui.appShell.classList.add("hidden");
  ui.authScreen.classList.remove("hidden");
  setAuthFeedback(message, Boolean(message) && !message.includes("sucesso"));
}

function setAuthMode(mode) {
  authMode = mode;
  ui.authTabs.forEach((tab) => {
    const isActive = tab.dataset.authMode === mode;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-pressed", String(isActive));
  });
  const buttonText = mode === "login" ? "Entrar" : "Criar conta";
  ui.authForm.querySelector(".auth-submit").textContent = buttonText;
}

async function handleAuthSubmit(event) {
  event.preventDefault();

  const email = ui.authEmail.value.trim();
  const password = ui.authPassword.value.trim();

  if (!email || !password) {
    setAuthFeedback("Informe seu e-mail e sua senha.", true);
    return;
  }

  if (password.length < 6) {
    setAuthFeedback("A senha deve ter pelo menos 6 caracteres.", true);
    return;
  }

  try {
    setAuthFeedback(authMode === "login" ? "Autenticando..." : "Criando conta...", false);

    if (authMode === "login") {
      await signInWithEmailAndPassword(email, password);
    } else {
      await createUserWithEmailAndPassword(email, password);
    }
  } catch (error) {
    const code = error?.code || "";
    if (code.includes("auth/email-already-in-use")) {
      setAuthFeedback("Este e-mail já está em uso. Tente entrar com a conta existente.", true);
      return;
    }
    if (code.includes("auth/weak-password")) {
      setAuthFeedback("A senha deve ter pelo menos 6 caracteres.", true);
      return;
    }
    if (code.includes("auth/invalid-email")) {
      setAuthFeedback("Informe um e-mail válido.", true);
      return;
    }
    if (code.includes("auth/user-not-found") || code.includes("auth/wrong-password")) {
      setAuthFeedback("E-mail ou senha incorretos.", true);
      return;
    }

    setAuthFeedback(error?.message || "Não foi possível concluir a operação.", true);
  }
}

async function handleSignOut() {
  try {
    await signOutUser();
  } catch (error) {
    console.error("Não foi possível sair da conta.", error);
  }
}

function initializeAuthUi() {
  ui.authTabs.forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode)));
  ui.authForm.addEventListener("submit", handleAuthSubmit);
  ui.signOut.addEventListener("click", handleSignOut);
  setAuthMode(authMode);
}

function initializeBoardUi() {
  ui.search.addEventListener("input", renderBoard);
  ui.priority.addEventListener("change", renderBoard);

  ui.addCard.addEventListener("click", () => {
    if (state.columns[0]) openCardDialog(null, state.columns[0].id);
  });
  ui.addColumn.addEventListener("click", () => openColumnDialog(null));
  ui.clearBoard.addEventListener("click", () => {
    if (!isOwner()) return;
    if (!window.confirm("Tem certeza de que deseja excluir todos os cards do board? As colunas serão mantidas.")) return;
    state.columns.forEach((column) => { column.cards = []; });
    saveState();
    renderBoard();
  });
  ui.shareBoard.addEventListener("click", openShareDialog);
  ui.createBoard.addEventListener("click", () => {
    rememberFocus();
    newBoardDialog.showModal();
    ui.newBoardName.focus();
  });
  ui.newBoardForm.addEventListener("submit", createBoard);
  ui.inviteForm.addEventListener("submit", createInvitation);
  ui.deleteBoard.addEventListener("click", deleteActiveBoard);

  document.querySelector("#theme-toggle").addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    document.querySelector("#theme-toggle").setAttribute(
      "aria-label",
      nextTheme === "dark" ? "Ativar tema claro" : "Ativar tema escuro"
    );
    try {
      localStorage.setItem(THEME_KEY, nextTheme);
    } catch (error) {
      console.error("Não foi possível salvar o tema escolhido.", error);
    }
  });

  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      if (dialog && dialog.open) dialog.close();
    });
  });

  ui.cardForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!canEditTasks()) return;
    const title = ui.cardTitle.value.trim();
    if (!title) {
      ui.cardTitle.focus();
      return;
    }

    const cardId = ui.cardForm.dataset.cardId;
    const cardData = {
      title,
      description: ui.cardDescription.value.trim(),
      priority: ui.cardPriority.value,
      dueDate: ui.cardDueDate.value
    };

    if (cardId) {
      const existing = findCard(cardId);
      if (existing) Object.assign(existing, cardData);
    } else {
      const column = state.columns.find((item) => item.id === ui.cardForm.dataset.columnId) || state.columns[0];
      if (!column || !currentUser) return;
      column.cards.push({
        id: createId(),
        ...cardData,
        createdBy: currentUser.uid,
        assigneeId: null,
        labels: [],
        checklist: [],
        acceptanceCriteria: [],
        storyPoints: null
      });
    }
    saveState();
    cardDialog.close();
    renderBoard();
  });

  ui.columnForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isOwner()) return;
    const title = ui.columnTitle.value.trim();
    if (!title) {
      ui.columnTitle.focus();
      return;
    }

    if (editingColumnId) {
      const column = state.columns.find((item) => item.id === editingColumnId);
      if (column) column.title = title;
    } else {
      state.columns.push({ id: createId(), title, cards: [] });
    }
    saveState();
    columnDialog.close();
    renderBoard();
  });

  [cardDialog, columnDialog, newBoardDialog, shareDialog].forEach((dialog) => {
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dialog.close();
      }
    });
    dialog.addEventListener("close", restoreFocus);
  });
}

function applyTheme() {
  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === "dark") {
      document.documentElement.dataset.theme = "dark";
      document.querySelector("#theme-toggle").setAttribute("aria-label", "Ativar tema claro");
    }
  } catch (error) {
    console.warn("Não foi possível carregar o tema salvo.", error);
  }
}

async function startAuthListener() {
  if (!firebaseReady) {
    showAuthScreen("Configure o firebase-config.js com as chaves do seu projeto Firebase.");
    return;
  }

  onAuthStateChanged(handleAuthenticatedUser).catch((error) => {
    console.error("Erro ao observar autenticação.", error);
    showAuthScreen("Não foi possível verificar sua autenticação.");
  });
}

initializeAuthUi();
initializeBoardUi();
applyTheme();
renderBoard();
startAuthListener();
