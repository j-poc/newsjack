import { handleVercelApiRequest } from "../../../worker/vercel-handler.js";

export default function handler(request: Request): Promise<Response> {
  return handleVercelApiRequest(request);
}
