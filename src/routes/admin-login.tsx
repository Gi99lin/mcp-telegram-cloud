import { Hono } from "hono";
import { buildAdminSessionCookie, isAdminSessionValid, verifyAdminPassword } from "../auth/admin.js";
import { AdminLoginPage } from "../pages/AdminLoginPage.js";

/** Only ever redirect within this app — an attacker-controlled absolute
 *  returnTo would turn this into an open redirect off a login form. */
function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function createAdminLoginRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const returnTo = safeReturnTo(c.req.query("returnTo"));
    if (isAdminSessionValid(c.req.header("cookie"))) {
      return c.redirect(returnTo, 302);
    }
    return c.html(<AdminLoginPage returnTo={returnTo} error={c.req.query("error") === "1"} />);
  });

  app.post("/", async (c) => {
    const { config } = await import("../config.js");
    const returnTo = safeReturnTo(c.req.query("returnTo"));
    const body = await c.req.parseBody();
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    // Read password hash directly from environment to handle test setup ordering.
    const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || config.adminPasswordHash;
    const ok = username === config.adminUsername && verifyAdminPassword(password, adminPasswordHash);
    if (!ok) {
      return c.redirect(`/admin-login?returnTo=${encodeURIComponent(returnTo)}&error=1`, 302);
    }

    c.header("Set-Cookie", buildAdminSessionCookie());
    return c.redirect(returnTo, 302);
  });

  return app;
}
