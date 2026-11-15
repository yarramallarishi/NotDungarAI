import { createAuth0Client } from "@auth0/auth0-spa-js";
import { mountApp, updateAuthSession } from "./client";

type AppConfig = { auth0Domain: string; auth0ClientId: string; auth0Audience: string };
type Memory = { id: string; content: string; created_at: string };

async function start(): Promise<void> {
  const configResponse = await fetch("/api/config", { cache: "no-store" });
  if (!configResponse.ok) throw new Error("Could not load authentication configuration.");
  const config = await configResponse.json() as AppConfig;
  const auth0 = await createAuth0Client({
    domain: config.auth0Domain,
    clientId: config.auth0ClientId,
    authorizationParams: {
      redirect_uri: window.location.origin,
      audience: config.auth0Audience,
      scope: "openid profile email",
    },
    cacheLocation: "memory",
  });

  if (window.location.search.includes("code=") && window.location.search.includes("state=")) {
    await auth0.handleRedirectCallback();
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const session = {
    isLoading: false,
    isAuthenticated: await auth0.isAuthenticated(),
    getAccessTokenSilently: async () => {
      const accessToken = await auth0.getTokenSilently({
        authorizationParams: { audience: config.auth0Audience },
      });
      if (!accessToken) throw new Error("Auth0 did not return an access token.");
      return accessToken;
    },
    loginWithRedirect: (signup = false) => auth0.loginWithRedirect({
      authorizationParams: signup ? { screen_hint: "signup" } : {},
    }),
    logout: () => auth0.logout({ logoutParams: { returnTo: window.location.origin } }),
  };
  updateAuthSession(session);
  mountApp();

  const mode = document.createElement("select");
  mode.id = "research-mode";
  mode.setAttribute("aria-label", "Research mode");
  mode.title = "Choose automatic research, always search, or no web search";
  mode.innerHTML = '<option value="auto">Research: Auto</option><option value="on">Always search</option><option value="off">No web search</option>';
  const promptButton = document.getElementById("prompt-button");
  promptButton?.parentElement?.insertBefore(mode, promptButton);

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url.startsWith("/api/chats") && init?.method === "POST" && typeof init.body === "string") {
      try {
        const payload = JSON.parse(init.body) as Record<string, unknown>;
        payload.research = mode.value;
        init = { ...init, body: JSON.stringify(payload) };
      } catch { /* Preserve non-JSON requests unchanged. */ }
    }
    return nativeFetch(input, init);
  }) as typeof window.fetch;

  const sidebarBottom = document.querySelector(".sidebar-bottom");
  const memoryButton = document.createElement("button");
  memoryButton.type = "button";
  memoryButton.className = "text-button";
  memoryButton.textContent = "Memories";
  memoryButton.style.marginLeft = "auto";
  sidebarBottom?.insertBefore(memoryButton, document.getElementById("logout"));

  const dialog = document.createElement("dialog");
  dialog.className = "prompt-dialog";
  dialog.innerHTML = `
    <form method="dialog"><button class="dialog-close" aria-label="Close">×</button></form>
    <p class="eyebrow">LONG-TERM MEMORY</p>
    <h2>Your saved context</h2>
    <p class="memory-description">Facts you explicitly ask the assistant to remember. Only your account can access these.</p>
    <div class="memory-add"><input id="memory-input" maxlength="2000" placeholder="Add a fact or preference…" /><button id="memory-save" class="primary-button" type="button">Save</button></div>
    <div id="memory-list" class="memory-list" aria-live="polite"></div>
  `;
  document.body.append(dialog);

  const token = async () => {
    const accessToken = await auth0.getTokenSilently({ authorizationParams: { audience: config.auth0Audience } });
    if (!accessToken) throw new Error("Auth0 did not return an access token.");
    return accessToken;
  };
  const memoryRequest = async (path: string, init: RequestInit = {}) => {
    const accessToken = await token();
    const response = await nativeFetch(path, {
      ...init,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(result.error ?? `Memory request failed (${response.status}).`);
    }
    return response.json() as Promise<{ memories?: Memory[]; memory?: Memory; deleted?: boolean }>;
  };

  const list = dialog.querySelector<HTMLElement>("#memory-list")!;
  const loadMemories = async () => {
    list.textContent = "Loading memories…";
    try {
      const result = await memoryRequest("/api/assistant/memories");
      list.replaceChildren();
      if (!result.memories?.length) {
        list.textContent = "No saved memories yet. Ask the assistant to “remember that…” or add one above.";
        return;
      }
      for (const memory of result.memories) {
        const row = document.createElement("div");
        row.className = "memory-row";
        const content = document.createElement("span");
        content.textContent = memory.content;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Delete";
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try {
            await memoryRequest(`/api/assistant/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
            await loadMemories();
          } catch (error) { list.textContent = error instanceof Error ? error.message : "Could not delete memory."; }
        });
        row.append(content, remove);
        list.append(row);
      }
    } catch (error) {
      list.textContent = error instanceof Error ? error.message : "Could not load memories.";
    }
  };
  memoryButton.addEventListener("click", () => {
    if (!session.isAuthenticated) return;
    dialog.showModal();
    void loadMemories();
  });
  dialog.querySelector<HTMLButtonElement>("#memory-save")!.addEventListener("click", async () => {
    const field = dialog.querySelector<HTMLInputElement>("#memory-input")!;
    const content = field.value.trim();
    if (!content) return;
    const button = dialog.querySelector<HTMLButtonElement>("#memory-save")!;
    button.disabled = true;
    try {
      await memoryRequest("/api/assistant/memories", { method: "POST", body: JSON.stringify({ content }) });
      field.value = "";
      await loadMemories();
    } catch (error) { list.textContent = error instanceof Error ? error.message : "Could not save memory."; }
    finally { button.disabled = false; }
  });

  const style = document.createElement("style");
  style.textContent = `
    #research-mode{max-width:145px;min-height:32px;padding:0 9px;border:1px solid #ffffff12;border-radius:8px;background:#201d28;color:#cfc3df;font:11px "DM Sans",sans-serif;outline-offset:2px}
    .memory-description{color:#aaa3b4;font-size:12px;line-height:1.6}
    .memory-add{display:flex;gap:8px;margin:14px 0}
    #memory-input{min-width:0;flex:1;padding:10px;border:1px solid #ffffff18;border-radius:9px;background:#121119;color:#f3eff8;font:12px "DM Sans",sans-serif}
    .memory-add .primary-button{margin:0}
    .memory-list{display:grid;gap:8px;max-height:42vh;overflow:auto;color:#cfc9d8;font-size:12px}
    .memory-row{display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid #ffffff12;border-radius:9px;background:#ffffff05}
    .memory-row span{flex:1;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}
    .memory-row button{flex:none;border:0;border-radius:7px;background:#3b252e;color:#f0b9c5;padding:6px 8px;font-size:10px;cursor:pointer}
    .memory-row button:disabled{opacity:.5}
    @media(max-width:700px){#research-mode{max-width:125px;font-size:10px}}
  `;
  document.head.append(style);
}

start().catch((error: unknown) => {
  console.error("Application startup failed:", error);
  const notice = document.createElement("div");
  notice.className = "auth-bootstrap-error";
  notice.textContent = error instanceof Error ? error.message : "The app could not start.";
  document.body.append(notice);
});
