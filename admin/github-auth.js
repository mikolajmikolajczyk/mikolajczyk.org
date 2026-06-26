/**
 * github-auth.js — client for the OAuth broker (gh-auth Worker).
 *
 * Plain browser API, no dependencies. Drop into any frontend.
 *
 *   import { GitHubAuth } from "./github-auth.js";
 *   const auth = new GitHubAuth({
 *     clientId:    "Iv1.xxxx",                  // GitHub App client_id
 *     workerUrl:   "https://gh-auth.<account>.workers.dev",
 *     redirectUri: location.origin + "/auth/callback",
 *   });
 *
 *   // start the login (e.g. from a button):
 *   auth.login();
 *
 *   // on the callback page, on load:
 *   await auth.handleCallback();   // exchanges code → token, cleans the URL
 *
 *   // then use it normally:
 *   const res = await auth.fetch("https://api.github.com/user");
 */

const STORE_KEY = "gh_auth_tokens";
const PKCE_KEY = "gh_pkce_verifier";
const STATE_KEY = "gh_oauth_state";

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  return crypto.subtle.digest("SHA-256", data);
}

function randomString(len = 64) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return b64url(arr).slice(0, len);
}

export class GitHubAuth {
  constructor({ clientId, workerUrl, redirectUri }) {
    this.clientId = clientId;
    this.workerUrl = workerUrl.replace(/\/$/, "");
    this.redirectUri = redirectUri;
  }

  /** Whether we have a live (or refreshable) token. */
  isAuthenticated() {
    const t = this._tokens();
    return !!(t && t.access_token);
  }

  _tokens() {
    try {
      return JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
    } catch {
      return null;
    }
  }

  _saveTokens(t) {
    // expires_at is computed locally from expires_in, with a 60 s margin.
    const now = Math.floor(Date.now() / 1000);
    const enriched = {
      ...t,
      expires_at: t.expires_in ? now + t.expires_in - 60 : null,
    };
    sessionStorage.setItem(STORE_KEY, JSON.stringify(enriched));
  }

  logout() {
    sessionStorage.removeItem(STORE_KEY);
  }

  /** Step 1: redirect to GitHub with PKCE + state. */
  async login() {
    const verifier = randomString(64);
    const challenge = b64url(await sha256(verifier));
    const state = randomString(32);

    sessionStorage.setItem(PKCE_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    location.href = `https://github.com/login/oauth/authorize?${params}`;
  }

  /** Step 2: on the callback page — exchanges the code for a token. */
  async handleCallback() {
    const url = new URL(location.href);
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    if (!code) return false; // not on a callback

    const expectedState = sessionStorage.getItem(STATE_KEY);
    if (!returnedState || returnedState !== expectedState) {
      throw new Error("State mismatch — aborted (possible CSRF).");
    }

    const verifier = sessionStorage.getItem(PKCE_KEY);
    if (!verifier) {
      // PKCE verifier gone (e.g. sessionStorage cleared between login and
      // callback). Exchanging without it would fail server-side anyway, since
      // a code_challenge was sent — bail early with a clear message.
      throw new Error("Missing PKCE verifier — start the login again.");
    }
    const res = await fetch(`${this.workerUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: this.redirectUri,
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Code exchange failed: ${e.error || res.status}`);
    }
    this._saveTokens(await res.json());

    sessionStorage.removeItem(PKCE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    // Strip code/state from the address bar.
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    history.replaceState({}, "", url.pathname + url.hash);
    return true;
  }

  /** Refresh the token via the broker. */
  async _refresh() {
    const t = this._tokens();
    if (!t?.refresh_token) throw new Error("No refresh_token — log in again.");
    const res = await fetch(`${this.workerUrl}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        refresh_token: t.refresh_token,
      }),
    });
    if (!res.ok) {
      this.logout();
      throw new Error("Refresh failed — log in again.");
    }
    this._saveTokens(await res.json());
  }

  async _validToken() {
    let t = this._tokens();
    if (!t?.access_token) throw new Error("Not authenticated.");
    if (t.expires_at && Math.floor(Date.now() / 1000) >= t.expires_at) {
      await this._refresh();
      t = this._tokens();
    }
    return t.access_token;
  }

  /** fetch with an auto-token; on 401 refreshes once and retries. */
  async fetch(input, init = {}) {
    let token = await this._validToken();
    const call = (tok) =>
      fetch(input, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.headers || {}),
          Authorization: `Bearer ${tok}`,
        },
      });

    let res = await call(token);
    if (res.status === 401) {
      await this._refresh();
      token = await this._validToken();
      res = await call(token);
    }
    return res;
  }
}
