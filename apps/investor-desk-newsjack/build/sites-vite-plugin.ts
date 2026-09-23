import { access, cp, mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// Local-only Sites identity shim. Production identity is injected by Sites.
const localUserId = "local_seedy";
const localEmail = "seedy@sites.test";
const cookieName = "__sites_local_auth";
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const localAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function sites(): Plugin {
  let root = process.cwd();
  let command: "build" | "serve" = "build";

  return {
    name: "sites",
    configResolved(config) {
      root = config.root;
      command = config.command;
    },
    configureServer(server) {
      const secure = Boolean(server.config.server.https);
      server.middlewares.use((request, response, next) => {
        for (const name of Object.keys(request.headers)) {
          if (name.startsWith("oai-authenticated-user-")) removeHeader(request, name);
        }

        let authority: URL;
        let url: URL;
        try {
          authority = new URL(`${secure ? "https" : "http"}://${request.headers.host}`);
          url = new URL(request.url ?? "/", authority);
        } catch {
          next();
          return;
        }
        const hostname = authority.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        if (!localHosts.has(hostname) || !localAddresses.has(request.socket.remoteAddress ?? "") || url.origin !== authority.origin) {
          if (url.pathname === "/signin-with-chatgpt" || url.pathname === "/signout-with-chatgpt") respond(response, 403);
          else next();
          return;
        }

        const cookies = (request.headers.cookie ?? "").split(";").map((item) => item.trim()).filter(Boolean);
        const localCookies = cookies.filter((item) => item.startsWith(`${cookieName}=`));
        const retained = cookies.filter((item) => !item.startsWith(`${cookieName}=`));
        if (localCookies.length !== cookies.length) {
          removeHeader(request, "cookie");
          if (retained.length > 0) setHeader(request, "cookie", retained.join("; "));
        }

        if (url.pathname === "/signin-with-chatgpt" || url.pathname === "/signout-with-chatgpt") {
          if ((request.headers.origin !== undefined && request.headers.origin !== url.origin) || request.headers["sec-fetch-site"] === "cross-site") {
            respond(response, 403);
            return;
          }
          if (request.method !== "GET" && !(url.pathname === "/signout-with-chatgpt" && request.method === "POST")) {
            response.setHeader("Allow", url.pathname === "/signin-with-chatgpt" ? "GET" : "GET, POST");
            respond(response, 405);
            return;
          }
          const signIn = url.pathname === "/signin-with-chatgpt";
          response.statusCode = request.method === "POST" ? 303 : 302;
          response.setHeader("Cache-Control", "private, no-store");
          response.setHeader("Location", safeReturn(url.searchParams.get("return_to")));
          response.setHeader("Set-Cookie", `${cookieName}=${signIn ? "1" : ""}; Path=/; ${signIn ? "" : "Max-Age=0; "}HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
          response.end();
          return;
        }

        if (localCookies.length === 1 && localCookies[0] === `${cookieName}=1`) {
          setHeader(request, "oai-authenticated-user-id", localUserId);
          setHeader(request, "oai-authenticated-user-email", localEmail);
        }
        next();
      });
    },
    async closeBundle() {
      if (command !== "build") return;
      const destination = resolve(root, "dist", ".openai");
      await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      await cp(resolve(root, "..", "..", ".openai", "hosting.json"), resolve(destination, "hosting.json"));
      const migrations = resolve(root, "drizzle");
      try {
        await access(migrations);
        await cp(migrations, resolve(destination, "drizzle"), { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function removeHeader(request: IncomingMessage, name: string): void {
  delete request.headers[name];
  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) request.rawHeaders.splice(index, 2);
  }
}

function setHeader(request: IncomingMessage, name: string, value: string): void {
  removeHeader(request, name);
  request.headers[name] = value;
  request.rawHeaders.push(name, value);
}

function respond(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "private, no-store");
  response.end();
}

function safeReturn(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "http://localhost");
    if (url.origin !== "http://localhost" || url.pathname.startsWith("/signin-with-chatgpt") || url.pathname.startsWith("/signout-with-chatgpt")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
