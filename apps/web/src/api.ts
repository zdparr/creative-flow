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

/**
 * POSTs and reads a server-sent event stream from the response. A non-stream response is an
 * error from before the stream opened; an `error` event is a failure mid-stream.
 */
export async function streamPost(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
      problems?: string[];
    } | null;
    if (res.ok) return;
    throw new ApiError(
      res.status,
      data?.error ?? `Request failed (${res.status})`,
      data?.problems ?? [],
    );
  }

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
      const raw = /^data: (.*)$/m.exec(frame)?.[1];
      const data = raw ? (JSON.parse(raw) as unknown) : null;
      if (event === 'error') {
        const err = data as { error?: string; problems?: string[] } | null;
        throw new ApiError(502, err?.error ?? 'The story stalled', err?.problems ?? []);
      }
      onEvent(event, data);
    }
  }
}

export function errorText(err: unknown): { message: string; problems: string[] } {
  if (err instanceof ApiError) return { message: err.message, problems: err.problems };
  return { message: 'Could not reach the server', problems: [] };
}
