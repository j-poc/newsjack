import { createCloudflareWorkerEnv, type CloudflareBindings } from "./cloudflare-storage";
import { handleApiRequest } from "./handler";

const worker = {
  async fetch(request: Request, bindings: CloudflareBindings): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return bindings.ASSETS.fetch(request);
    return handleApiRequest(request, createCloudflareWorkerEnv(bindings), readOwnerId(request), "private-worker");
  },
} satisfies ExportedHandler<CloudflareBindings>;

export default worker;

function readOwnerId(request: Request): string {
  return request.headers.get("oai-authenticated-user-id")?.trim() ?? "";
}
