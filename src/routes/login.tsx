import { Hono } from "hono";
import { isAdminSessionValid } from "../auth/admin.js";
import { config } from "../config.js";
import { LoginPage } from "../pages/LoginPage.js";
import { handleQrLogin } from "../qr-login.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import type { SessionManager } from "../session-manager.js";

export interface LoginRoutesDeps {
  sessions: SessionManager;
}

export function createLoginRoutes({ sessions }: LoginRoutesDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    if (!isAdminSessionValid(c.req.header("cookie"))) {
      return c.redirect("/admin-login", 302);
    }

    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      const html = await renderReactPage("login", {
        locale,
        scripts: islandScripts("language-switcher", "qr-flow"),
      });
      return c.html(html);
    }
    return c.html(<LoginPage />);
  });

  app.get("/qr", async (c) => {
    if (!isAdminSessionValid(c.req.header("cookie"))) {
      return c.text("Forbidden", 403);
    }

    // Single-operator fork: never trust the caller-supplied `userId` query
    // param as the session key. Before this gate, an attacker who merely knew
    // the (non-secret) admin username could hit this endpoint with
    // `userId=admin:<username>` — now config.ownerUserId, a fixed, guessable
    // string — scan the QR with their OWN Telegram account, and hijack the
    // deployment's one primary session. The query param may still arrive from
    // the client-side qr-flow island (it has its own userId input for the
    // legacy multi-tenant flow) but is ignored here.
    const stream = await handleQrLogin(sessions, config.ownerUserId, c.req.raw.signal);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
