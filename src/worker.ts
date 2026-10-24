import { createRemoteJWKSet, jwtVerify } from "jose";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GROQ_API_KEY: string;
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_AUDIENCE: string;
  DAILY_REQUEST_LIMIT?: string;
}

interface Identity {
  userId: string;
}

interface Chat {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface AssistantMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface AssistantMemory {
  id: string;
  content: string;
  created_at: string;
}

const MAX_MESSAGE_LENGTH = 12_000;
const MODEL = "openai/gpt-oss-120b";
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const MEMORY_STOP_WORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "could", "did",
  "does", "from", "have", "her", "here", "how", "into", "just", "more", "most",
  "much", "must", "other", "our", "should", "some", "tell", "than", "that",
  "their", "them", "then", "there", "these", "they", "this", "those", "through",
  "under", "very", "was", "were", "what", "when", "where", "which", "while",
  "who", "why", "will", "with", "would", "you", "your",
]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

async function authenticate(request: Request, env: Env): Promise<Identity | null> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const domain = env.AUTH0_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const issuer = `https://${domain}/`;
  try {
    const { payload } = await jwtVerify(token, getJwks(issuer), {
      issuer,
      audience: env.AUTH0_AUDIENCE,
    });
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

async function parseJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function newId(): string {
  return crypto.randomUUID();
}

async function consumeDailyRequest(env: Env, userId: string): Promise<boolean> {
  const configuredLimit = Number(env.DAILY_REQUEST_LIMIT ?? "50");
  const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 50;
  const usage = await env.DB.prepare(
    `INSERT INTO daily_usage (user_id, usage_date, request_count)
     VALUES (?, date('now'), 1)
     ON CONFLICT(user_id) DO UPDATE SET
       usage_date = excluded.usage_date,
       request_count = CASE
         WHEN daily_usage.usage_date = excluded.usage_date THEN daily_usage.request_count + 1
         ELSE 1
       END
     WHERE daily_usage.usage_date != excluded.usage_date OR daily_usage.request_count < ?
     RETURNING request_count`,
  )
    .bind(userId, limit)
    .first<{ request_count: number }>();
  return usage !== null;
}

async function groqReply(env: Env, messages: Array<{ role: string; content: string }>): Promise<string> {
  if (!env.GROQ_API_KEY) throw new Error("The GROQ_API_KEY secret is not configured.");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GROQ_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.7 }),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("Groq API request failed:", response.status, detail);
    throw new Error(`The AI provider returned an error (${response.status}).`);
  }
  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = result.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("The AI provider returned an empty response.");
  return content;
}

async function getOwnedChat(env: Env, userId: string, id: string): Promise<Chat | null> {
  return env.DB.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<Chat>();
}

function getSearchTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(terms.filter((term) => !MEMORY_STOP_WORDS.has(term)))].slice(0, 8);
}

function isValidAssistantId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/config") {
    const domain = env.AUTH0_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return json({
      auth0Domain: domain,
      auth0ClientId: env.AUTH0_CLIENT_ID,
      auth0Audience: env.AUTH0_AUDIENCE,
    });
  }

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const identity = await authenticate(request, env);
  if (!identity) return json({ error: "Sign in is required." }, 401);

  if (request.method === "GET" && url.pathname === "/api/chats") {
    const result = await env.DB.prepare(
      "SELECT id, title, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100",
    )
      .bind(identity.userId)
      .all<Chat>();
    return json({ chats: result.results });
  }

  if (request.method === "GET" && url.pathname === "/api/assistant/threads") {
    const result = await env.DB.prepare(
      `SELECT id, title, created_at, updated_at
       FROM assistant_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`,
    )
      .bind(identity.userId)
      .all();
    return json({ threads: result.results });
  }

  if (request.method === "GET" && url.pathname === "/api/assistant/context") {
    const threadId = url.searchParams.get("thread_id") ?? "";
    if (threadId && !isValidAssistantId(threadId)) {
      return json({ error: "Invalid thread ID." }, 400);
    }
    const query = url.searchParams.get("q") ?? "";
    const terms = getSearchTerms(query);
    const recent = threadId
      ? await env.DB.prepare(
          `SELECT id, thread_id, role, content, created_at
           FROM assistant_history
           WHERE user_id = ? AND thread_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 32`,
        )
          .bind(identity.userId, threadId)
          .all<AssistantMessage>()
      : { results: [] as AssistantMessage[] };
    const relevant = terms.length
      ? await env.DB.prepare(
          `SELECT id, thread_id, role, content, created_at
           FROM assistant_history
           WHERE user_id = ? AND (${terms.map(() => "instr(lower(content), lower(?)) > 0").join(" OR ")})
           ORDER BY created_at DESC, rowid DESC LIMIT 80`,
        )
          .bind(identity.userId, ...terms)
          .all<AssistantMessage>()
      : { results: [] as AssistantMessage[] };
    const websiteRelevant = terms.length
      ? await env.DB.prepare(
          `SELECT messages.id, chats.id AS thread_id, messages.role, messages.content,
                  messages.created_at
           FROM messages
           INNER JOIN chats ON chats.id = messages.chat_id
           WHERE chats.user_id = ?
             AND (${terms.map(() => "instr(lower(messages.content), lower(?)) > 0").join(" OR ")})
           ORDER BY messages.created_at DESC, messages.rowid DESC LIMIT 80`,
        )
          .bind(identity.userId, ...terms)
          .all<AssistantMessage>()
      : { results: [] as AssistantMessage[] };
    const memories = terms.length
      ? await env.DB.prepare(
          `SELECT id, content, created_at FROM assistant_memories
           WHERE user_id = ? AND (${terms.map(() => "instr(lower(content), lower(?)) > 0").join(" OR ")})
           ORDER BY created_at DESC LIMIT 100`,
        )
          .bind(identity.userId, ...terms)
          .all<AssistantMemory>()
      : await env.DB.prepare(
          `SELECT id, content, created_at FROM assistant_memories
           WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
        )
          .bind(identity.userId)
          .all<AssistantMemory>();
    return json({
      recent: recent.results.reverse(),
      relevant: [...relevant.results, ...websiteRelevant.results],
      memories: memories.results,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/assistant/memories") {
    const result = await env.DB.prepare(
      "SELECT id, content, created_at FROM assistant_memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
    )
      .bind(identity.userId)
      .all<AssistantMemory>();
    return json({ memories: result.results });
  }

  if (request.method === "POST" && url.pathname === "/api/assistant/memories") {
    const body = await parseJson(request);
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 2_000) {
      return json({ error: "Memory must be 1-2000 characters." }, 400);
    }
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO assistant_memories (id, user_id, content) VALUES (?, ?, ?)",
    )
      .bind(id, identity.userId, content)
      .run();
    return json({ memory: { id, content } }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/assistant/turn") {
    const body = await parseJson(request);
    const threadId = body?.thread_id;
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 80) : "";
    const userContent = typeof body?.user === "string" ? body.user.trim() : "";
    const assistantContent = typeof body?.assistant === "string" ? body.assistant.trim() : "";
    if (
      !isValidAssistantId(threadId) ||
      !userContent ||
      userContent.length > MAX_MESSAGE_LENGTH ||
      !assistantContent ||
      assistantContent.length > 30_000
    ) {
      return json({ error: "Invalid conversation turn." }, 400);
    }
    const threadTitle = title || userContent.slice(0, 80);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assistant_threads (id, user_id, title) VALUES (?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           title = CASE WHEN assistant_threads.title = 'New chat' THEN excluded.title ELSE assistant_threads.title END,
           updated_at = datetime('now')`,
      ).bind(threadId, identity.userId, threadTitle),
      env.DB.prepare(
        "INSERT INTO assistant_history (id, user_id, thread_id, role, content) VALUES (?, ?, ?, 'user', ?)",
      ).bind(newId(), identity.userId, threadId, userContent),
      env.DB.prepare(
        "INSERT INTO assistant_history (id, user_id, thread_id, role, content) VALUES (?, ?, ?, 'assistant', ?)",
      ).bind(newId(), identity.userId, threadId, assistantContent),
      env.DB.prepare(
        "UPDATE assistant_threads SET updated_at = datetime('now') WHERE id = ? AND user_id = ?",
      ).bind(threadId, identity.userId),
    ]);
    return json({ saved: true });
  }

  if (request.method === "POST" && url.pathname === "/api/assistant/import") {
    const body = await parseJson(request);
    const threadId = body?.thread_id;
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 80) : "";
    const messages = body?.messages;
    if (
      !isValidAssistantId(threadId) ||
      !title ||
      !Array.isArray(messages) ||
      messages.length > 100
    ) {
      return json({ error: "Invalid chat import." }, 400);
    }
    const imported: Array<{ id: string; role: "user" | "assistant"; content: string }> = [];
    for (const item of messages) {
      if (
        typeof item !== "object" ||
        item === null ||
        !isValidAssistantId(item.id) ||
        (item.role !== "user" && item.role !== "assistant") ||
        typeof item.content !== "string" ||
        !item.content.trim() ||
        item.content.length > 30_000
      ) {
        return json({ error: "Invalid chat import message." }, 400);
      }
      imported.push({ id: item.id, role: item.role, content: item.content });
    }
    const statements = [
      env.DB.prepare(
        "INSERT INTO assistant_threads (id, user_id, title) VALUES (?, ?, ?) ON CONFLICT(user_id, id) DO NOTHING",
      ).bind(threadId, identity.userId, title),
      ...imported.map((message) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO assistant_history (id, user_id, thread_id, role, content) VALUES (?, ?, ?, ?, ?)",
        ).bind(message.id, identity.userId, threadId, message.role, message.content),
      ),
    ];
    await env.DB.batch(statements);
    return json({ imported: imported.length });
  }

  if (request.method === "POST" && url.pathname === "/api/chats") {
    const body = await parseJson(request);
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      return json({ error: `Message must be 1-${MAX_MESSAGE_LENGTH} characters.` }, 400);
    }
    if (!(await consumeDailyRequest(env, identity.userId))) {
      return json({ error: "You have reached the daily AI request limit. Please try again tomorrow." }, 429);
    }
    const chatId = newId();
    const title = content.slice(0, 60);
    const userMessageId = newId();
    try {
      const reply = await groqReply(env, [
        { role: "system", content: "You are a helpful, concise assistant. Think carefully and answer accurately." },
        { role: "user", content },
      ]);
      const assistantMessageId = newId();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO chats (id, user_id, title) VALUES (?, ?, ?)")
          .bind(chatId, identity.userId, title),
        env.DB.prepare("INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'user', ?)")
          .bind(userMessageId, chatId, content),
        env.DB.prepare("INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'assistant', ?)")
          .bind(assistantMessageId, chatId, reply),
        env.DB.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ? AND user_id = ?")
          .bind(chatId, identity.userId),
      ]);
      return json({
        chat: { id: chatId, title, updated_at: new Date().toISOString() },
        message: { id: assistantMessageId, role: "assistant", content: reply },
      });
    } catch (error) {
      console.error("Chat completion failed:", error);
      return json({ error: error instanceof Error ? error.message : "Could not get an AI response." }, 502);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/prompts") {
    const body = await parseJson(request);
    const idea = typeof body?.idea === "string" ? body.idea.trim() : "";
    if (!idea || idea.length > 2_000) return json({ error: "Idea must be 1-2000 characters." }, 400);
    if (!(await consumeDailyRequest(env, identity.userId))) {
      return json({ error: "You have reached the daily AI request limit. Please try again tomorrow." }, 429);
    }
    try {
      const prompt = await groqReply(env, [
        {
          role: "system",
          content: "Turn the user's rough idea into one clear, specific, ready-to-use prompt. Include useful context, goal, constraints, and desired output format where relevant. Do not answer the prompt. Return only the prompt.",
        },
        { role: "user", content: idea },
      ]);
      return json({ prompt });
    } catch (error) {
      console.error("Prompt generation failed:", error);
      return json({ error: error instanceof Error ? error.message : "Could not generate a prompt." }, 502);
    }
  }

  const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)(?:\/messages)?$/);
  if (chatMatch) {
    const chatId = decodeURIComponent(chatMatch[1]);
    const isMessagesRoute = url.pathname.endsWith("/messages");
    const chat = await getOwnedChat(env, identity.userId, chatId);
    if (!chat) return json({ error: "Chat not found." }, 404);

    if (request.method === "GET" && !isMessagesRoute) {
      const result = await env.DB.prepare(
        "SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY rowid ASC LIMIT 500",
      )
        .bind(chat.id)
        .all<Message>();
      return json({
        chat: { id: chat.id, title: chat.title, updated_at: chat.updated_at },
        messages: result.results,
      });
    }

    if (request.method === "POST" && isMessagesRoute) {
      const body = await parseJson(request);
      const content = typeof body?.content === "string" ? body.content.trim() : "";
      if (!content || content.length > MAX_MESSAGE_LENGTH) {
        return json({ error: `Message must be 1-${MAX_MESSAGE_LENGTH} characters.` }, 400);
      }
      if (!(await consumeDailyRequest(env, identity.userId))) {
        return json({ error: "You have reached the daily AI request limit. Please try again tomorrow." }, 429);
      }
      const previous = await env.DB.prepare(
        "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY rowid DESC LIMIT 30",
      )
        .bind(chat.id)
        .all<Pick<Message, "role" | "content">>();
      const history = [...previous.results.reverse(), { role: "user" as const, content }];
      try {
        const reply = await groqReply(env, [
          { role: "system", content: "You are a helpful, concise assistant. Think carefully and answer accurately." },
          ...history,
        ]);
        const assistantMessageId = newId();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'user', ?)")
            .bind(newId(), chat.id, content),
          env.DB.prepare("INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'assistant', ?)")
            .bind(assistantMessageId, chat.id, reply),
          env.DB.prepare(
            "UPDATE chats SET updated_at = datetime('now'), title = CASE WHEN title = 'New chat' THEN ? ELSE title END WHERE id = ? AND user_id = ?",
          ).bind(content.slice(0, 60), chat.id, identity.userId),
        ]);
        return json({
          chat: { id: chat.id, title: chat.title, updated_at: new Date().toISOString() },
          message: { id: assistantMessageId, role: "assistant", content: reply },
        });
      } catch (error) {
        console.error("Chat completion failed:", error);
        return json({ error: error instanceof Error ? error.message : "Could not get an AI response." }, 502);
      }
    }

    if (request.method === "DELETE" && !isMessagesRoute) {
      await env.DB.prepare("DELETE FROM chats WHERE id = ? AND user_id = ?")
        .bind(chat.id, identity.userId)
        .run();
      return json({ deleted: true });
    }
  }

  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        console.error("API request failed:", error);
        return json({ error: "The server could not complete the request." }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
