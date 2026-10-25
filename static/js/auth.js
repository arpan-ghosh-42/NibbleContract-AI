/**
 * Supabase login shared by the tool and the login page.
 * The page sets window.NC_SUPABASE = {url, key} (the public URL and publishable key).
 * With no config (local development) login is off and everything is allowed.
 */
window.NC_AUTH = (function () {
    const cfg = window.NC_SUPABASE || {};
    const enabled = Boolean(cfg.url && cfg.key && window.supabase && window.supabase.createClient);
    const client = enabled
        ? window.supabase.createClient(cfg.url, cfg.key, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        })
        : null;

    async function session() {
        if (!client) return null;
        const { data } = await client.auth.getSession();
        return data ? data.session : null;
    }

    // Only same-site paths, so ?next= can't send people to another website.
    function safeNext(value) {
        const next = value || '/app';
        return /^\/(?!\/)[^\s\\]*$/.test(next) ? next : '/app';
    }

    async function authHeaders() {
        const s = await session();
        return s ? { Authorization: 'Bearer ' + s.access_token } : {};
    }

    // On a protected page: resolves with the session, or sends the visitor to the login page.
    async function requireLogin() {
        if (!enabled) return null;
        const s = await session();
        if (s) return s;
        goToLogin();
        return new Promise(() => { });   // the page is navigating away
    }

    function goToLogin() {
        location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
    }

    async function logout() {
        if (client) await client.auth.signOut();
        location.replace('/login');
    }

    return { enabled, client, session, safeNext, authHeaders, requireLogin, goToLogin, logout };
})();
