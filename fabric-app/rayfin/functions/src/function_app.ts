/*
 * The dashboard's Rayfin Functions, for Ask your data in the Fabric app.
 *
 * - chatTicket: a short-lived ticket naming the signed-in Fabric user, signed (HMAC-SHA256) with the CHAT_TICKET_KEY
 *   secret that the chat relay shares. The relay (copilot/server.py in relay mode, an Azure Container App) serves nobody
 *   without one, and keys each user's GitHub sign-in to it.
 * - dax: runs one DAX query on the semantic model CMS or CMS V2 for the relay, which has no Fabric access of its own.
 *   The page passes the relay's query here and posts the rows back. It runs with the app's identity (the owner of the
 *   Fabric app item); the models hold public CMS reporting.
 *
 * - chatPayload: keeps the events of each saved answer (Ask your data's chat history) as a JSON file in the chat
 *   lakehouse, Files/chats/<user>/<chat>/<n>.json, as the app identity. The user is the caller's, from the invocation's
 *   token, so nobody reaches another person's files. Folders, chats and questions are Rayfin Data (rayfin/data/).
 *
 * config.generated.ts is written by copilot/deploy.py: the workspace and model IDs, the relay's address and the chat
 * lakehouse.
 */
import { createHmac } from 'node:crypto';

import { AudienceType, UserDataFunctions, type RayfinContext } from '@microsoft/fabric-user-data-functions';

import { CONFIG } from './config.generated.js';

type Schema = Record<string, never>;

/** What the page needs to reach the chat relay as the signed-in user. */
export type ChatTicket = { ticket: string; expiresAt: number; chatUrl: string; user: string };

const MODELS: Record<string, string> = { CMS: CONFIG.cmsModelId, 'CMS V2': CONFIG.cmsV2ModelId };
const MAX_ROWS = 30000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The claims of the invocation's Rayfin token. */
function claims(accessToken: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** The Entra object ID of the caller: the oid claim, or the last segment of the sub path. */
function callerOid(payload: Record<string, unknown>): string {
  return String(payload.oid ?? payload.sub ?? '').split('/').filter(Boolean).pop() ?? '';
}

const udf = new UserDataFunctions();

/** The user's ID as the app sees it (session.user.id): the last segment of a managed-hosting sub path, else the sub. */
function userId(payload: Record<string, unknown>): string {
  const sub = String(payload.sub ?? '');
  return sub.includes('/') ? sub.split('/').filter(Boolean).pop() ?? '' : sub;
}
const SAFE = /^[0-9A-Za-z-]{8,64}$/;
const ONELAKE = 'https://onelake.dfs.fabric.microsoft.com';

udf.func(
  'chatTicket',
  async (ctx: RayfinContext<Schema>): Promise<ChatTicket> => {
    const payload = claims(ctx.accessToken);
    const oid = callerOid(payload);
    if (!/^[0-9a-f-]{36}$/i.test(oid)) throw new Error('Could not tell who is signed in; sign in again.');
    if (!CONFIG.chatUrl) throw new Error('The chat relay is not configured: run copilot/deploy.py.');
    const user = ['upn', 'email', 'preferred_username'].map((k) => payload[k]).find((v) => typeof v === 'string' && v.includes('@')) as string | undefined;
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
    const body = Buffer.from(JSON.stringify({ oid, upn: user ?? `Entra user ${oid}`, exp: expiresAt })).toString('base64url');
    const signature = createHmac('sha256', ctx.Secrets.CHAT_TICKET_KEY).update(body).digest('base64url');
    return { ticket: `${body}.${signature}`, expiresAt, chatUrl: CONFIG.chatUrl, user: user ?? '' };
  },
  []
);

/**
 * One DAX query (EVALUATE ... or DEFINE ... EVALUATE ...) on 'CMS' or 'CMS V2'. Returns JSON text: {ok: true, rows} with
 * the executeQueries row objects, or {ok: false, error} with the model's message so Copilot can correct its query.
 */
udf.func(
  'dax',
  async (model: string, query: string, ctx: RayfinContext<Schema, AudienceType.Fabric>): Promise<string> => {
    try {
      const id = MODELS[String(model)];
      if (!id) throw new Error(`Unknown model ${model}: use CMS or CMS V2.`);
      const q = String(query ?? '').trim();
      if (!/^(DEFINE|EVALUATE)\b/i.test(q)) throw new Error('A DAX query starts with EVALUATE, or DEFINE ... EVALUATE.');
      const url = `https://api.powerbi.com/v1.0/myorg/groups/${CONFIG.workspaceId}/datasets/${id}/executeQueries`;
      let res: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ctx.Tokens.Fabric}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ queries: [{ query: q }], serializerSettings: { includeNulls: true } }),
        });
        if (res.status !== 429 && res.status < 500) break;
        await sleep(2500 * (attempt + 1));
      }
      const text = await res!.text();
      let body: Record<string, any> = {};
      try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
      const result = (body.results ?? [{}])[0] ?? {};
      if (res!.status !== 200 || result.error) {
        const err = body.error ?? result.error ?? {};
        const detail = err?.['pbi.error']?.details?.[0]?.detail?.value ?? err?.message ?? text.slice(0, 600);
        const paused = /capacity/i.test(JSON.stringify(err)) ? ' The Fabric capacity behind the CMS models may be paused.' : '';
        return JSON.stringify({ ok: false, error: `${detail}${paused}` });
      }
      const rows = (result.tables ?? [{}])[0]?.rows ?? [];
      if (rows.length > MAX_ROWS) return JSON.stringify({ ok: false, error: `${rows.length} rows (max ${MAX_ROWS}): aggregate in DAX.` });
      return JSON.stringify({ ok: true, rows });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
  []
);

/**
 * The events of one saved answer, in the chat lakehouse. op: 'put' (body: the JSON text), 'get' (returns it, or '' when
 * there is none) or 'delete' (every answer of the chat). Returns JSON text: {ok: true, body?} or {ok: false, error}.
 */
udf.func(
  'chatPayload',
  async (op: string, chatId: string, idx: number, body: string, ctx: RayfinContext<Schema, AudienceType.Storage>): Promise<string> => {
    try {
      const user = userId(claims(ctx.accessToken));
      if (!SAFE.test(user)) throw new Error('Could not tell who is signed in; sign in again.');
      if (!SAFE.test(String(chatId))) throw new Error('Not a valid chat.');
      const ws = CONFIG.chatWorkspaceId, item = CONFIG.chatLakehouseId;
      if (!ws || !item) throw new Error('The chat lakehouse is not configured: run copilot/deploy.py app.');
      const dir = `${ONELAKE}/${ws}/${item}/Files/chats/${user}/${chatId}`;
      const auth = { Authorization: `Bearer ${ctx.Tokens.Storage}`, 'x-ms-version': '2023-11-03' };
      if (op === 'delete') {
        const res = await fetch(`${dir}?recursive=true`, { method: 'DELETE', headers: auth });
        if (!res.ok && res.status !== 404) throw new Error(`OneLake delete failed (${res.status}).`);
        return JSON.stringify({ ok: true });
      }
      const n = Number(idx);
      if (!Number.isInteger(n) || n < 0 || n > 10000) throw new Error('Not a valid answer number.');
      const file = `${dir}/${n}.json`;
      if (op === 'get') {
        const res = await fetch(file, { headers: auth });
        if (res.status === 404) return JSON.stringify({ ok: true, body: '' });
        if (!res.ok) throw new Error(`OneLake read failed (${res.status}).`);
        return JSON.stringify({ ok: true, body: await res.text() });
      }
      if (op !== 'put') throw new Error(`Unknown operation ${op}.`);
      const data = Buffer.from(String(body ?? ''), 'utf8');
      if (data.length > 8 * 1024 * 1024) throw new Error('The answer is too large to save.');
      const step = async (url: string, init: RequestInit, what: string) => {
        const res = await fetch(url, init);
        if (!res.ok) throw new Error(`OneLake ${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      };
      await step(`${file}?resource=file`, { method: 'PUT', headers: auth }, 'create');
      await step(`${file}?action=append&position=0`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: data }, 'append');
      await step(`${file}?action=flush&position=${data.length}`, { method: 'PATCH', headers: auth }, 'flush');
      return JSON.stringify({ ok: true });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
  []
);
