export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const NETWORK = "The processing service isn't responding. Check that it is running, then try again.";

export async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; request_id?: string } };
    if (body.error?.message) return new ApiError(body.error.code ?? "ERROR", body.error.message, res.status, body.error.request_id);
  } catch {
    /* not JSON */
  }
  if (res.status === 401 || res.status === 403) return new ApiError("UNAUTHORIZED", "You aren't signed in to the processing service.", res.status);
  if (res.status === 502 || res.status === 503 || res.status === 504) return new ApiError("SERVICE_UNAVAILABLE", NETWORK, res.status);
  return new ApiError("ERROR", `The service answered with an error (${res.status}).`, res.status);
}
