import { DurableObject } from "cloudflare:workers";

const API_PREFIX = "/api/location-share";
const ROOM_ID = /^[0-9a-f-]{36}$/i;
const OWNER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ROOM_TTL_MS = 60 * 60 * 1000;
const MAX_VIEWERS = 20;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function allowedOrigin(origin, env) {
  return !!origin && (env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).includes(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function apiPath(pathname) {
  if (pathname === API_PREFIX) return "/";
  if (pathname.startsWith(`${API_PREFIX}/`)) return pathname.slice(API_PREFIX.length);
  return pathname;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (!allowedOrigin(origin, env)) return json({ error: "這個網站未獲允許使用位置分享服務。" }, 403);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const path = apiPath(new URL(request.url).pathname);
    const match = path.match(/^\/rooms\/([0-9a-f-]{36})(\/socket)?$/i);
    if (!match || !ROOM_ID.test(match[1])) {
      return json({ error: "找不到位置分享端點。" }, 404, corsHeaders(origin));
    }

    if (match[2] && (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")) {
      return json({ error: "即時連線需要 WebSocket。" }, 426, corsHeaders(origin));
    }
    if (!match[2] && !["POST", "DELETE"].includes(request.method)) {
      return json({ error: "不支援這個請求。" }, 405, corsHeaders(origin));
    }

    const id = env.LOCATION_ROOMS.idFromName(match[1].toLowerCase());
    const response = await env.LOCATION_ROOMS.get(id).fetch(request);
    if (response.status === 101) return response;

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

export class LocationRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    const path = apiPath(new URL(request.url).pathname);
    const socketPath = /\/socket$/i.test(path);
    const room = await this.ctx.storage.get("room");

    if (request.method === "POST" && !socketPath) {
      if (room && room.expiresAt > Date.now()) return json({ error: "分享房間已存在。" }, 409);
      if (room) await this.endRoom("expired");
      const payload = await request.json().catch(() => null);
      if (!payload || !OWNER_TOKEN.test(payload.ownerToken || "")) {
        return json({ error: "分享驗證資料無效。" }, 400);
      }
      const tokenHash = await hashToken(payload.ownerToken);
      const expiresAt = Date.now() + ROOM_TTL_MS;
      await this.ctx.storage.put("room", { tokenHash, expiresAt });
      await this.ctx.storage.setAlarm(expiresAt);
      return json({ expiresAt }, 201);
    }

    if (request.method === "DELETE" && !socketPath) {
      if (!room) return json({ ended: true });
      const payload = await request.json().catch(() => null);
      if (!payload || !await tokenMatches(payload.ownerToken, room.tokenHash)) {
        return json({ error: "只有分享者可以關閉這個連結。" }, 403);
      }
      await this.endRoom("ended");
      return json({ ended: true });
    }

    if (socketPath && request.method === "GET") {
      if (!room) return json({ error: "分享連結不存在或已結束。" }, 404);
      if (room.expiresAt <= Date.now()) {
        await this.endRoom("expired");
        return json({ error: "這個分享連結已失效。" }, 410);
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "需要 WebSocket 即時連線。" }, 426);
      }

      const role = new URL(request.url).searchParams.get("role");
      if (!["owner", "viewer"].includes(role)) return json({ error: "連線角色無效。" }, 400);
      if (role === "viewer") {
        const viewers = this.ctx.getWebSockets("viewer").filter(ws => ws.deserializeAttachment()?.role === "viewer" && ws.readyState === WebSocket.OPEN);
        if (viewers.length >= MAX_VIEWERS) return json({ error: "這個分享連結目前已達查看人數上限。" }, 429);
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment({ role: role === "owner" ? "pending" : "viewer" });

      if (role === "viewer") {
        server.send(JSON.stringify({ type: "viewer-ready" }));
        const owner = this.ctx.getWebSockets("owner").find(ws => ws.deserializeAttachment()?.role === "owner");
        const ownerState = owner?.deserializeAttachment();
        if (ownerState) server.send(JSON.stringify({ type: ownerState.state || "active" }));
        if (ownerState?.lastPosition && Date.now() - ownerState.lastPosition.t < 30000) {
          server.send(JSON.stringify({ type: "position", position: ownerState.lastPosition }));
        } else if (!ownerState) server.send(JSON.stringify({ type: "waiting" }));
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "找不到位置分享端點。" }, 404);
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment() || {};
    const data = parseMessage(message);
    if (!data) return ws.close(1008, "Invalid message");

    if (attachment.role === "pending") {
      if (data.type !== "owner-auth" || typeof data.token !== "string") return ws.close(1008, "Authentication required");
      const room = await this.ctx.storage.get("room");
      if (!room || room.expiresAt <= Date.now() || !await tokenMatches(data.token, room.tokenHash)) {
        return ws.close(4003, "Invalid or expired share link");
      }

      const oldOwner = this.ctx.getWebSockets("owner").find(candidate => candidate !== ws && candidate.deserializeAttachment()?.role === "owner");
      let lastPosition = null;
      let lastSentAt = 0;
      if (oldOwner) {
        const oldState = oldOwner.deserializeAttachment() || {};
        lastPosition = oldState.lastPosition || null;
        lastSentAt = oldState.lastSentAt || 0;
        oldOwner.serializeAttachment({ role: "replaced" });
        try { oldOwner.close(4001, "Share connection resumed"); } catch {}
      }

      ws.serializeAttachment({ role: "owner", lastPosition, lastSentAt, state: "active" });
      ws.send(JSON.stringify({ type: "owner-ready", expiresAt: room.expiresAt }));
      this.broadcast({ type: "active" });
      return;
    }

    if (attachment.role !== "owner") return ws.close(1008, "View-only connection");

    if (data.type === "position") {
      const p = data.position;
      if (!validPosition(p)) return;
      const now = Date.now();
      if (now - (attachment.lastSentAt || 0) < 500) return;
      const position = { lat: p.lat, lng: p.lng, accuracy: p.accuracy, t: p.t };
      ws.serializeAttachment({ ...attachment, lastPosition: position, lastSentAt: now, state: "active" });
      this.broadcast({ type: "position", position });
      return;
    }

    if (data.type === "state" && ["active", "paused"].includes(data.state)) {
      ws.serializeAttachment({ ...attachment, state: data.state });
      this.broadcast({ type: data.state });
      return;
    }

    if (data.type === "stop") {
      const room = await this.ctx.storage.get("room");
      if (room && await tokenMatches(data.token, room.tokenHash)) await this.endRoom("ended");
      else ws.close(1008, "Invalid owner token");
      return;
    }

    ws.close(1008, "Unsupported message");
  }

  webSocketClose(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.role === "owner") this.broadcast({ type: "offline" });
  }

  async alarm() {
    await this.endRoom("expired");
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets("viewer")) {
      if (ws.deserializeAttachment()?.role !== "viewer" || ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(payload); } catch {}
    }
  }

  async endRoom(reason) {
    const payload = JSON.stringify({ type: "ended", reason });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch {}
      try { ws.close(1000, reason); } catch {}
    }
    await this.ctx.storage.deleteAll();
  }
}

async function hashToken(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function tokenMatches(token, expectedHash) {
  if (typeof token !== "string" || !OWNER_TOKEN.test(token) || !expectedHash) return false;
  const actual = await hashToken(token);
  if (actual.length !== expectedHash.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return difference === 0;
}

function parseMessage(message) {
  try {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (raw.length > 2048) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function validPosition(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.accuracy) && Number.isFinite(p.t) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && p.accuracy >= 0 && p.accuracy <= 100 &&
    Math.abs(Date.now() - p.t) <= 5 * 60 * 1000;
}
