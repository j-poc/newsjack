import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  handle: vi.fn(async (request: Request) => new Response(JSON.stringify({ pathname: new URL(request.url).pathname }), {
    headers: { "Content-Type": "application/json" },
  })),
}));

vi.mock("../worker/vercel-handler", () => ({ handleVercelApiRequest: mocked.handle }));

import handler from "../api/events";

describe("Vercel event-page function entrypoint", () => {
  it("forwards the collection route to the same private runtime handler", async () => {
    const request = new Request("https://desk.example/api/events?cursor=next-page");
    const response = await handler(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pathname: "/api/events" });
    expect(mocked.handle).toHaveBeenCalledWith(request);
  });
});
