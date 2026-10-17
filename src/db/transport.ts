// How the browser talks to the Lulua API (services/api): JSON over HTTP,
// plus ONE shared live-change stream per tab that tells every listener
// which collections/documents changed, so they re-fetch.

export interface ApiErrorBody {
  code: string;
  message: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "FirebaseError";
    this.code = code;
    this.status = status;
  }
}

export interface Change {
  c: string;
  ids?: string[];
}

export interface Transport {
  post<T>(path: string, body: unknown): Promise<T>;
  // Subscribe to the change feed; returns an unsubscribe. `onReconnect`
  // fires when the stream comes back after a drop (changes may have been
  // missed, so listeners should re-fetch everything).
  onChange(cb: (c: Change) => void, onReconnect: () => void): () => void;
}

export interface TransportOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  // Defaults to the global fetch; tests pass an in-process server's.
  fetch?: (input: Request) => Promise<Response>;
}

export function createTransport(opts: TransportOptions): Transport {
  const doFetch = opts.fetch ?? ((r: Request) => fetch(r));
  const base = opts.baseUrl.replace(/\/$/, "");

  async function post<T>(path: string, body: unknown): Promise<T> {
    const token = await opts.getToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(new Request(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    } catch (e) {
      throw new ApiError("unavailable", `Could not reach the server: ${(e as Error).message}`, 0);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: ApiErrorBody } & T;
    if (!res.ok) {
      const err = json.error ?? { code: "internal", message: `HTTP ${res.status}` };
      throw new ApiError(err.code, err.message, res.status);
    }
    return json;
  }

  // --- change feed (shared, opened on first subscriber) ---------------------
  const subs = new Set<{ cb: (c: Change) => void; onReconnect: () => void }>();
  let running = false;

  async function runFeed() {
    let attempt = 0;
    let connectedBefore = false;
    while (subs.size) {
      try {
        const res = await doFetch(new Request(`${base}/v1/listen`, { headers: { Accept: "text/event-stream" } }));
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: ?(.*)$/m.exec(block)?.[1];
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.replace(/^data: ?/, ""))
              .join("\n");
            if (event === "ready") {
              attempt = 0;
              if (connectedBefore) subs.forEach((s) => s.onReconnect());
              connectedBefore = true;
            } else if (event === "change") {
              try {
                const c = JSON.parse(data) as Change;
                subs.forEach((s) => s.cb(c));
              } catch {
                /* ignore malformed event */
              }
            }
          }
          if (!subs.size) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      if (!subs.size) break;
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))));
    }
    running = false;
  }

  function onChange(cb: (c: Change) => void, onReconnect: () => void) {
    const sub = { cb, onReconnect };
    subs.add(sub);
    if (!running) {
      running = true;
      void runFeed();
    }
    return () => {
      subs.delete(sub);
    };
  }

  return { post, onChange };
}
