import { handleVercelApiRequest } from "../../../worker/vercel-handler";

export default function handler(request: Request): Promise<Response> {
  return handleVercelApiRequest(request);
}
