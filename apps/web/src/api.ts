import { Capacitor } from "@capacitor/core";

/**
 * Unde e serverul.
 * - În browser (laptop, tunel): adresă relativă `/api/...`, iar Vite o trimite la server prin proxy.
 * - În aplicația Android: pagina rulează în telefon, deci trebuie adresa laptopului, ex. `http://192.168.1.104:3001`.
 *   O setezi din ecranul Setări (se ține minte), sau la build cu VITE_API_URL. Implicit `http://localhost:3001`,
 *   care merge cu telefonul legat prin cablu și `adb reverse tcp:3001 tcp:3001`.
 */
const KEY = "pago.apiBase";

export const isNative = Capacitor.isNativePlatform();

function defaultBase(): string {
  const fromBuild = import.meta.env.VITE_API_URL as string | undefined;
  if (fromBuild) return fromBuild;
  return isNative ? "http://localhost:3001" : "";
}

export function getApiBase(): string {
  try {
    return localStorage.getItem(KEY) ?? defaultBase();
  } catch {
    return defaultBase();
  }
}

/** Salvează adresa serverului (ex. „192.168.1.104:3001” → „http://192.168.1.104:3001”). Gol = implicit. */
export function setApiBase(value: string): string {
  let v = value.trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\//.test(v)) v = `http://${v}`;
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* fără localStorage */
  }
  return getApiBase();
}

export class ApiError extends Error {
  constructor(message: string, public data?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(getApiBase() + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((data as { message?: string }).message ?? "Eroare de server.", data);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
