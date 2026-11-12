import {
  createUserWithEmailAndPassword,
  db,
  doc,
  firebaseReady,
  getDoc,
  onAuthStateChanged,
  setDoc,
  signInWithEmailAndPassword,
  signOutUser
} from "./firebase.js";

const STORAGE_KEY = "meu-kanban-board-v1";
const THEME_KEY = "meu-kanban-theme-v1";
const PRIORITIES = ["baixa", "media", "alta"];

let state = loadState();
let currentUser = null;
let draggedCardId = null;
let lastFocusedElement = null;
let editingColumnId = null;
let authMode = "login";

const board = document.querySelector("#board");
const cardDialog = document.querySelector("#card-dialog");
const columnDialog = document.querySelector("#column-dialog");

const ui = {
  appShell: document.querySelector("#app-shell"),
  authScreen: document.querySelector("#auth-screen"),
  authForm: document.querySelector("#auth-form"),
  authEmail: document.querySelector("#auth-email"),
  authPassword: document.querySelector("#auth-password"),
  authFeedback: document.querySelector("#auth-feedback"),
  authTabs: document.querySelectorAll(".auth-tab"),
  signOut: document.querySelector("#sign-out"),
  search: document.querySelector("#search-input"),
  priority: document.querySelector("#priority-filter"),
  cardForm: document.querySelector("#card-form"),
  cardTitle: document.querySelector("#card-title"),
  cardDescription: document.querySelector("#card-description"),
  cardPriority: document.querySelector("#card-priority"),
  cardDueDate: document.querySelector("#card-due-date"),
  columnForm: document.querySelector("#column-form"),
  columnTitle: document.querySelector("#column-title")
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

function isValidColumn(column) {
  return column && typeof column.id === "string" &&
    typeof column.title === "string" && Array.isArray(column.cards) &&
    column.cards.every(isValidCard);
}

function isValidCard(card) {
  return card && typeof card.id === "string" &&
    typeof card.title === "string" && card.title.trim().length > 0 &&
    typeof card.description === "string" && PRIORITIES.includes(card.priority) &&
    typeof card.dueDate === "string";
}

function isValidState(value) {
  return value && Array.isArray(value.columns) && value.columns.length > 0 && value.columns.every(isValidColumn);
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && isValidState(saved)) {
      return saved;
    }
  } catch (error) {
    console.warn("Não foi possível carregar o board salvo.", error);
  }
  return createInitialState();
}

function saveLocalState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Não foi possível salvar o board local.", error);
  }
}

async function saveState() {
  saveLocalState();

  if (!firebaseReady || !currentUser || !db) {
    return;
  }

  try {
    const boardRef = await doc("users", currentUser.uid, "kanban", "state");
    await setDoc(boardRef, state);
  } catch (error) {
    console.error("Não foi possível salvar o board no Firebase.", error);
    window.alert("Não foi possível sincronizar seu quadro com o Firebase.");
  }
}

async function syncBoardFromFirebase(user) {
  if (!firebaseReady || !user) {
    return;
  }

  try {
    const boardRef = await doc("users", user.uid, "kanban", "state");
    const snapshot = await getDoc(boardRef);

    if (snapshot.exists()) {
      const boardState = snapshot.data();
      state = isValidState(boardState) ? boardState : createInitialState();
    } else {
      state = createInitialState();
      await setDoc(boardRef, state);
    }

    saveLocalState();
    renderBoard();
  } catch (error) {
    console.error("Não foi possível carregar o board do Firebase.", error);
    setAuthFeedback("Não foi possível carregar seus dados. Verifique a configuração do Firebase.", true);
  }
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
    actions.append(
      makeIconButton(`Renomear coluna ${column.title}`, "✎", "column-action", () => openColumnDialog(column.id)),
      makeIconButton(`Excluir coluna ${column.title}`, "×", "column-action delete", () => deleteColumn(column.id))
    );
    header.append(titleWrap, actions);

    const list = makeElement("div", "cards-list");
    list.dataset.columnId = column.id;
    const visibleCards = column.cards.filter((card) => matchesFilters(card, searchTerm, selectedPriority));
    visibleCards.forEach((card) => list.append(createCardElement(card, column)));

    if (visibleCards.length === 0) {
      list.append(makeElement("p", "empty-column",
        column.cards.length === 0 ? "Nenhum card por aqui ainda." : "Nenhum card encontrado."));
    }

    const addTaskButton = makeElement("button", "add-task-inline", "+ Adicionar card");
    addTaskButton.type = "button";
    addTaskButton.setAttribute("aria-label", `Adicionar card em ${column.title}`);
    addTaskButton.addEventListener("click", () => openCardDialog(null, column.id));
    columnElement.append(header, list, addTaskButton);
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
  element.draggable = true;
  element.dataset.cardId = card.id;
  element.setAttribute("aria-label", `Card: ${card.title}. Arraste para mover entre colunas.`);

  const top = makeElement("div", "task-card-top");
  top.append(makeElement("h3", "task-title", card.title));
  const actions = makeElement("div", "task-actions");
  actions.append(
    makeIconButton(`Editar card ${card.title}`, "✎", "task-action", () => openCardDialog(card.id, column.id)),
    makeIconButton(`Excluir card ${card.title}`, "×", "task-action", () => deleteCard(card.id))
  );
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
  if (!cardId || cardId === targetCardId) return;

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
  const column = state.columns.find((item) => item.cards.some((card) => card.id === cardId));
  if (!column) return;
  column.cards = column.cards.filter((card) => card.id !== cardId);
  saveState();
  renderBoard();
}

function deleteColumn(columnId) {
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

  document.querySelector("#add-card").addEventListener("click", () => openCardDialog(null, state.columns[0].id));
  document.querySelector("#add-column").addEventListener("click", () => openColumnDialog(null));
  document.querySelector("#clear-board").addEventListener("click", () => {
    if (!window.confirm("Tem certeza de que deseja excluir todos os cards do board? As colunas serão mantidas.")) return;
    state.columns.forEach((column) => { column.cards = []; });
    saveState();
    renderBoard();
  });

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
    button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog).close());
  });

  ui.cardForm.addEventListener("submit", (event) => {
    event.preventDefault();
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
      column.cards.push({ id: createId(), ...cardData });
    }
    saveState();
    cardDialog.close();
    renderBoard();
  });

  ui.columnForm.addEventListener("submit", (event) => {
    event.preventDefault();
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

  [cardDialog, columnDialog].forEach((dialog) => {
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
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme === "dark") {
    document.documentElement.dataset.theme = "dark";
    document.querySelector("#theme-toggle").setAttribute("aria-label", "Ativar tema claro");
  }
}

async function startAuthListener() {
  if (!firebaseReady) {
    showAuthScreen("Configure o firebase-config.js com as chaves do seu projeto Firebase.");
    return;
  }

  onAuthStateChanged((user) => {
    currentUser = user;

    if (user) {
      showAppShell();
      syncBoardFromFirebase(user);
      return;
    }

    showAuthScreen("Entre para sincronizar seu quadro com o Firebase.");
  }).catch((error) => {
    console.error("Erro ao observar autenticação.", error);
    showAuthScreen("Não foi possível verificar sua autenticação.");
  });
}

initializeAuthUi();
initializeBoardUi();
applyTheme();
renderBoard();
startAuthListener();
