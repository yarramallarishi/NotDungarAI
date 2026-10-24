type Chat = { id: string; title: string; updated_at: string };
type Message = { id: string; role: "user" | "assistant"; content: string };

export interface AuthSession {
  isLoading: boolean;
  isAuthenticated: boolean;
  error?: Error;
  getAccessTokenSilently: () => Promise<string>;
  loginWithRedirect: (signup?: boolean) => Promise<void>;
  logout: () => void;
}

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
const signupButton = byId<HTMLButtonElement>("signup");
const logoutButton = byId<HTMLButtonElement>("logout");
const authNotice = byId<HTMLElement>("auth-notice");
const promptDialog = byId<HTMLDialogElement>("prompt-dialog");
const sidebar = byId<HTMLElement>("sidebar");
const sidebarBackdrop = byId<HTMLButtonElement>("sidebar-backdrop");
const mobileMenuButton = byId<HTMLButtonElement>("mobile-menu");
let auth: AuthSession | null = null;
let currentChatId: string | null = null;
let chats: Chat[] = [];
let busy = false;
let mounted = false;
let previousAuthState: boolean | null = null;

export function updateAuthSession(session: AuthSession): void {
  auth = session;
  loginButton.hidden = session.isLoading || session.isAuthenticated;
  signupButton.hidden = session.isLoading || session.isAuthenticated;
  logoutButton.hidden = session.isLoading || !session.isAuthenticated;
  input.disabled = session.isLoading || !session.isAuthenticated;
  byId<HTMLButtonElement>("send-button").disabled = session.isLoading || !session.isAuthenticated;
  authNotice.hidden = !session.isLoading && session.isAuthenticated;
  authNotice.textContent = session.isLoading
    ? "Connecting to sign in…"
    : "Sign in to save chats and start a conversation.";

  if (session.error) showError(session.error);
  if (session.isLoading || previousAuthState === session.isAuthenticated) return;
  previousAuthState = session.isAuthenticated;

  if (session.isAuthenticated) {
    void loadChats().catch(showError);
  } else {
    chatList.replaceChildren();
    currentChatId = null;
    messages.replaceChildren();
    welcome.classList.remove("hidden");
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!auth?.isAuthenticated) throw new Error("Please sign in to continue.");
  const token = await auth.getAccessTokenSilently();
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
    const title = document.createElement("button");
    title.type = "button";
    title.className = "chat-title chat-open";
    title.setAttribute("aria-current", chat.id === currentChatId ? "page" : "false");
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
  closeMobileSidebar();
  renderChatListSelection();
  messages.scrollTop = messages.scrollHeight;
}

function startNewChat(): void {
  currentChatId = null;
  messages.replaceChildren();
  welcome.classList.remove("hidden");
  closeMobileSidebar();
  renderChatListSelection();
  input.focus();
}

function closeMobileSidebar(): void {
  sidebar.classList.remove("open");
  sidebarBackdrop.classList.remove("open");
  mobileMenuButton.setAttribute("aria-expanded", "false");
}

function appendInlineMarkdown(parent: HTMLElement, text: string): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g;
  let offset = 0;

  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > offset) parent.append(document.createTextNode(text.slice(offset, index)));

    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const link = document.createElement("a");
        link.textContent = linkMatch[1];
        try {
          const url = new URL(linkMatch[2], window.location.origin);
          if (["http:", "https:", "mailto:"].includes(url.protocol)) {
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            parent.append(link);
          } else {
            parent.append(document.createTextNode(token));
          }
        } catch {
          parent.append(document.createTextNode(token));
        }
      }
    } else {
      const element = document.createElement(
        token.startsWith("**") || token.startsWith("__")
          ? "strong"
          : token.startsWith("~~")
            ? "del"
            : "em",
      );
      const markerLength = token.startsWith("**") || token.startsWith("__") || token.startsWith("~~") ? 2 : 1;
      element.textContent = token.slice(markerLength, -markerLength);
      parent.append(element);
    }
    offset = index + token.length;
  }

  if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)));
}

function isTableSeparator(line: string | undefined): boolean {
  return Boolean(line && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line));
}

function parseTableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function renderMarkdown(container: HTMLElement, markdown: string): void {
  container.replaceChildren();
  const lines = markdown.split(/\r?\n/);
  let paragraph: HTMLParagraphElement | null = null;
  let list: HTMLOListElement | HTMLUListElement | null = null;
  let codeLines: string[] | null = null;
  let codeLanguage = "";

  const flushParagraph = () => {
    paragraph = null;
  };
  const flushList = () => {
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (codeLines) {
      if (fence) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (codeLanguage) code.className = `language-${codeLanguage}`;
        code.textContent = codeLines.join("\n");
        pre.append(code);
        container.append(pre);
        codeLines = null;
        codeLanguage = "";
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (fence) {
      flushParagraph();
      flushList();
      codeLines = [];
      codeLanguage = fence[1];
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const element = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(element, heading[2]);
      container.append(element);
      continue;
    }
    if (/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      container.append(document.createElement("hr"));
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      flushList();
      const headers = parseTableCells(line);
      const tableWrap = document.createElement("div");
      tableWrap.className = "markdown-table-wrap";
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const header of headers) {
        const cell = document.createElement("th");
        appendInlineMarkdown(cell, header);
        headerRow.append(cell);
      }
      head.append(headerRow);
      table.append(head);
      const body = document.createElement("tbody");
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const row = document.createElement("tr");
        for (const [cellIndex, value] of parseTableCells(lines[index]).entries()) {
          const cell = document.createElement("td");
          appendInlineMarkdown(cell, value);
          row.append(cell);
          if (cellIndex + 1 >= headers.length) break;
        }
        body.append(row);
        index += 1;
      }
      table.append(body);
      tableWrap.append(table);
      container.append(tableWrap);
      index -= 1;
      continue;
    }

    const listItem = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/.test(listItem[1]);
      if (!list || (ordered !== (list instanceof HTMLOListElement))) {
        flushList();
        list = document.createElement(ordered ? "ol" : "ul");
        container.append(list);
      }
      const item = document.createElement("li");
      appendInlineMarkdown(item, listItem[2]);
      list.append(item);
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      const blockquote = document.createElement("blockquote");
      const quotedText = document.createElement("p");
      appendInlineMarkdown(quotedText, quote[1]);
      blockquote.append(quotedText);
      container.append(blockquote);
      continue;
    }

    flushList();
    if (!paragraph) {
      paragraph = document.createElement("p");
      container.append(paragraph);
    } else {
      paragraph.append(document.createElement("br"));
    }
    appendInlineMarkdown(paragraph, line);
  }

  if (codeLines) {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    if (codeLanguage) code.className = `language-${codeLanguage}`;
    code.textContent = codeLines.join("\n");
    pre.append(code);
    container.append(pre);
  }
}

function createMessage(message: Pick<Message, "role" | "content">): HTMLElement {
  const row = document.createElement("article");
  row.className = `message ${message.role}`;
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = message.role === "assistant" ? "n" : "Y";
  const content = document.createElement("div");
  content.className = "message-body";
  if (message.role === "assistant") {
    renderMarkdown(content, message.content);
  } else {
    const paragraph = document.createElement("p");
    paragraph.textContent = message.content;
    content.append(paragraph);
  }
  row.append(avatar, content);
  return row;
}

function createThinkingMessage(): HTMLElement {
  const row = document.createElement("article");
  row.className = "message assistant thinking-message";
  row.setAttribute("role", "status");
  row.setAttribute("aria-label", "Assistant is thinking");
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = "n";
  const content = document.createElement("div");
  content.className = "message-body thinking-indicator";
  content.append(
    document.createTextNode("Thinking"),
    ...Array.from({ length: 3 }, () => {
      const dot = document.createElement("span");
      dot.className = "thinking-dot";
      return dot;
    }),
  );
  row.append(avatar, content);
  return row;
}

async function revealMessage(row: HTMLElement, text: string): Promise<void> {
  const content = row.querySelector<HTMLElement>(".message-body");
  if (!content) throw new Error("Missing assistant message content.");
  const tokens = text.match(/\S+\s*/g) ?? [text];
  const chunkSize = 8;
  let visibleText = "";

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    renderMarkdown(content, text);
    return;
  }

  for (let index = 0; index < tokens.length; index += chunkSize) {
    const followOutput = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    visibleText += tokens.slice(index, index + chunkSize).join("");
    renderMarkdown(content, visibleText);
    if (followOutput) messages.scrollTop = messages.scrollHeight;
    if (index + chunkSize < tokens.length) {
      await new Promise((resolve) => window.setTimeout(resolve, 45));
    }
  }
}

async function sendMessage(text: string): Promise<void> {
  if (busy || !text.trim()) return;
  busy = true;
  input.value = "";
  input.style.height = "auto";
  welcome.classList.add("hidden");
  const userRow = createMessage({ role: "user", content: text });
  messages.append(userRow);
  const assistantRow = createThinkingMessage();
  messages.append(assistantRow);
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
    assistantRow.removeAttribute("role");
    assistantRow.removeAttribute("aria-label");
    assistantRow.classList.remove("thinking-message");
    await revealMessage(assistantRow, result.message.content);
    assistantRow.setAttribute("aria-live", "polite");
    renderChatList();
    messages.scrollTop = messages.scrollHeight;
  } catch (error) {
    assistantRow.remove();
    userRow.classList.add("failed");
    showError(error);
  } finally {
    busy = false;
    sendButton.disabled = !auth?.isAuthenticated;
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

export function mountApp(): void {
  if (mounted) return;
  mounted = true;

  loginButton.addEventListener("click", () => void auth?.loginWithRedirect());
  signupButton.addEventListener("click", () => void auth?.loginWithRedirect(true));
  logoutButton.addEventListener("click", () => auth?.logout());
  byId<HTMLButtonElement>("new-chat").addEventListener("click", startNewChat);
  mobileMenuButton.setAttribute("aria-expanded", "false");
  mobileMenuButton.addEventListener("click", () => {
    const isOpen = sidebar.classList.toggle("open");
    sidebarBackdrop.classList.toggle("open", isOpen);
    mobileMenuButton.setAttribute("aria-expanded", String(isOpen));
  });
  sidebarBackdrop.addEventListener("click", closeMobileSidebar);
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
      input.dispatchEvent(new Event("input", { bubbles: true }));
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
}
