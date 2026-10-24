import { createAuth0Client, type Auth0Client } from "@auth0/auth0-spa-js";

type Chat = { id: string; title: string; updated_at: string };
type Message = { id: string; role: "user" | "assistant"; content: string };
type AppConfig = { auth0Domain: string; auth0ClientId: string; auth0Audience: string };

const byId = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing page element: ${id}`);
  return element as T;
};

const chatList = byId<HTMLElement>("chat-list");
const welcome = byId<HTMLElement>("welcome");
const messages = byId<HTMLElement>("messages");
const form = byId<HTMLFormElement>("chat-form");
const input = byId<HTMLTextAreaElement>("message-input");
const loginButton = byId<HTMLButtonElement>("login");
const logoutButton = byId<HTMLButtonElement>("logout");
const authNotice = byId<HTMLElement>("auth-notice");
const promptDialog = byId<HTMLDialogElement>("prompt-dialog");
let auth: Auth0Client;
let currentChatId: string | null = null;
let chats: Chat[] = [];
let busy = false;

async function initialize(): Promise<void> {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Could not load app configuration.");
    const config = (await response.json()) as AppConfig;
    auth = await createAuth0Client({
      domain: config.auth0Domain,
      clientId: config.auth0ClientId,
      authorizationParams: {
        redirect_uri: window.location.origin,
        audience: config.auth0Audience,
      },
      cacheLocation: "memory",
    });

    if (window.location.search.includes("code=") && window.location.search.includes("state=")) {
      await auth.handleRedirectCallback();
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    await updateAuthView();
  } catch (error) {
    showError(error);
  }
}

async function updateAuthView(): Promise<void> {
  const isAuthenticated = await auth.isAuthenticated();
  loginButton.hidden = isAuthenticated;
  logoutButton.hidden = !isAuthenticated;
  input.disabled = !isAuthenticated;
  byId<HTMLButtonElement>("send-button").disabled = !isAuthenticated;
  authNotice.hidden = isAuthenticated;
  if (isAuthenticated) await loadChats();
  else {
    chatList.replaceChildren();
    currentChatId = null;
    messages.replaceChildren();
    welcome.classList.remove("hidden");
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!auth || !(await auth.isAuthenticated())) throw new Error("Please sign in to continue.");
  const token = await auth.getTokenSilently();
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

async function loadChats(): Promise<void> {
  const result = await api<{ chats: Chat[] }>("/api/chats");
  chats = result.chats;
  renderChatList();
  if (currentChatId && chats.some((chat) => chat.id === currentChatId)) return;
  if (chats.length) await openChat(chats[0].id);
  else startNewChat();
}

function renderChatList(): void {
  chatList.replaceChildren();
  for (const chat of chats) {
    const item = document.createElement("div");
    item.className = `chat-item${chat.id === currentChatId ? " active" : ""}`;
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = chat.title;
    title.addEventListener("click", () => void openChat(chat.id).catch(showError));
    const remove = document.createElement("button");
    remove.className = "delete-chat";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${chat.title}`);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteChat(chat.id).catch(showError);
    });
    item.append(title, remove);
    item.addEventListener("click", () => void openChat(chat.id).catch(showError));
    chatList.append(item);
  }
  renderChatListSelection();
}

function renderChatListSelection(): void {
  for (const [index, element] of Array.from(chatList.children).entries()) {
    element.classList.toggle("active", chats[index]?.id === currentChatId);
  }
}

async function openChat(id: string): Promise<void> {
  const result = await api<{ chat: Chat; messages: Message[] }>(`/api/chats/${encodeURIComponent(id)}`);
  currentChatId = result.chat.id;
  messages.replaceChildren(...result.messages.map(createMessage));
  welcome.classList.toggle("hidden", result.messages.length > 0);
  renderChatListSelection();
  messages.scrollTop = messages.scrollHeight;
}

function startNewChat(): void {
  currentChatId = null;
  messages.replaceChildren();
  welcome.classList.remove("hidden");
  renderChatListSelection();
  input.focus();
}

function createMessage(message: Pick<Message, "role" | "content">): HTMLElement {
  const row = document.createElement("article");
  row.className = `message ${message.role}`;
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = message.role === "assistant" ? "n" : "Y";
  const content = document.createElement("div");
  content.className = "message-body";
  const paragraph = document.createElement("p");
  paragraph.textContent = message.content;
  content.append(paragraph);
  row.append(avatar, content);
  return row;
}

async function sendMessage(text: string): Promise<void> {
  if (busy || !text.trim()) return;
  busy = true;
  input.value = "";
  input.style.height = "auto";
  welcome.classList.add("hidden");
  const userRow = createMessage({ role: "user", content: text });
  messages.append(userRow);
  messages.scrollTop = messages.scrollHeight;
  const sendButton = byId<HTMLButtonElement>("send-button");
  sendButton.disabled = true;
  try {
    const result = await api<{ chat: Chat; message: Message }>(
      currentChatId ? `/api/chats/${encodeURIComponent(currentChatId)}/messages` : "/api/chats",
      {
        method: "POST",
        body: JSON.stringify({ content: text }),
      },
    );
    currentChatId = result.chat.id;
    if (!chats.some((chat) => chat.id === result.chat.id)) chats.unshift(result.chat);
    else chats = chats.map((chat) => (chat.id === result.chat.id ? result.chat : chat));
    messages.append(createMessage(result.message));
    renderChatList();
    messages.scrollTop = messages.scrollHeight;
  } catch (error) {
    userRow.classList.add("failed");
    showError(error);
  } finally {
    busy = false;
    sendButton.disabled = !(await auth.isAuthenticated());
    input.focus();
  }
}

async function deleteChat(id: string): Promise<void> {
  await api(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
  chats = chats.filter((chat) => chat.id !== id);
  if (currentChatId === id) {
    currentChatId = null;
    messages.replaceChildren();
  }
  renderChatList();
  if (!currentChatId && chats.length) await openChat(chats[0].id);
  else if (!chats.length) startNewChat();
}

function showError(error: unknown): void {
  const text = error instanceof Error ? error.message : "Something went wrong.";
  const row = createMessage({ role: "assistant", content: `Error: ${text}` });
  row.classList.add("error-message");
  messages.append(row);
}

loginButton.addEventListener("click", () => void auth.loginWithRedirect());
logoutButton.addEventListener("click", () =>
  auth.logout({ logoutParams: { returnTo: window.location.origin } }),
);
byId<HTMLButtonElement>("new-chat").addEventListener("click", startNewChat);
byId<HTMLButtonElement>("mobile-menu").addEventListener("click", () =>
  document.querySelector(".sidebar")?.classList.toggle("open"),
);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage(input.value);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
});
document.querySelectorAll<HTMLButtonElement>(".suggestion").forEach((button) =>
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt ?? "";
    input.focus();
  }),
);
byId<HTMLButtonElement>("prompt-button").addEventListener("click", () => {
  byId<HTMLTextAreaElement>("prompt-idea").value = "";
  byId<HTMLElement>("generated-prompt").hidden = true;
  byId<HTMLButtonElement>("use-prompt").hidden = true;
  promptDialog.showModal();
});
byId<HTMLButtonElement>("generate-prompt").addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const idea = byId<HTMLTextAreaElement>("prompt-idea").value.trim();
  if (!idea) return;
  button.disabled = true;
  button.textContent = "Creating…";
  try {
    const result = await api<{ prompt: string }>("/api/prompts", {
      method: "POST",
      body: JSON.stringify({ idea }),
    });
    const output = byId<HTMLElement>("generated-prompt");
    output.textContent = result.prompt;
    output.hidden = false;
    byId<HTMLButtonElement>("use-prompt").hidden = false;
  } catch (error) {
    showError(error);
    promptDialog.close();
  } finally {
    button.disabled = false;
    button.textContent = "Generate prompt";
  }
});
byId<HTMLButtonElement>("use-prompt").addEventListener("click", () => {
  input.value = byId<HTMLElement>("generated-prompt").textContent ?? "";
  promptDialog.close();
  input.focus();
});
void initialize();
