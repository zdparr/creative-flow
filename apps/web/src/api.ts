export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    (T & { error?: string; problems?: string[] }) | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? `Request failed (${res.status})`,
      data?.problems ?? [],
    );
  }
  return data as T;
}

export function errorText(err: unknown): { message: string; problems: string[] } {
  if (err instanceof ApiError) return { message: err.message, problems: err.problems };
  return { message: 'Could not reach the server', problems: [] };
}
