/**
 * Login page: log in, create an account, reset a forgotten password.
 * Supabase handles the accounts; this page only drives its auth client.
 */
(function () {
    const $ = id => document.getElementById(id);
    const auth = window.NC_AUTH;
    const params = new URLSearchParams(location.search);
    const next = auth.safeNext(params.get('next'));
    // Read before supabase-js clears the link details from the address bar.
    const arrivedForRecovery = /type=recovery/.test(location.hash);
    let mode = 'login';     // login | register | forgot | recover

    const COPY = {
        login: ['Welcome back', 'Log in to check internship posts and offer letters.', 'Log in'],
        register: ['Create your account', 'Free. You only need an email and a password.', 'Create account'],
        forgot: ['Reset your password', "Enter your email and we'll send you a link to set a new password.", 'Send reset link'],
        recover: ['Set a new password', 'Choose a new password for your account.', 'Save new password']
    };

    function setMode(next) {
        mode = next;
        const [title, sub, button] = COPY[mode];
        $('authTitle').textContent = title;
        $('authSub').textContent = sub;
        $('authSubmit').textContent = button;
        $('authTabs').hidden = mode === 'forgot' || mode === 'recover';
        document.querySelectorAll('.auth-tab').forEach(tab => {
            const on = tab.dataset.mode === mode;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        $('authEmail').parentElement.querySelector('label[for="authEmail"]').hidden = mode === 'recover';
        $('authEmail').hidden = mode === 'recover';
        $('passwordBlock').hidden = mode === 'forgot';
        $('confirmBlock').hidden = !(mode === 'register' || mode === 'recover');
        $('authPassword').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
        $('forgotLink').hidden = mode !== 'login';
        $('backToLogin').hidden = mode === 'login' || mode === 'register';
        showMessage('');
    }

    function showMessage(text, kind) {
        const box = $('authMessage');
        box.textContent = text;
        box.className = 'auth-message' + (kind ? ' ' + kind : '');
        box.hidden = !text;
    }

    function friendly(error) {
        const msg = (error && error.message) || '';
        if (/invalid login credentials/i.test(msg)) return 'Wrong email or password.';
        if (/email not confirmed/i.test(msg)) return 'Please confirm your email first: open the link we sent to your inbox.';
        if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a few minutes and try again.';
        if (/password/i.test(msg) && /(weak|short|least|characters)/i.test(msg)) return 'That password is too weak. Use at least 8 characters.';
        if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Log in instead.';
        if (/not authorized/i.test(msg)) return "We can't send a confirmation email to this address yet. Please try again later or contact the site owner.";
        return msg || 'Something went wrong. Please try again.';
    }

    function busy(on) {
        const btn = $('authSubmit');
        btn.disabled = on;
        btn.textContent = on ? 'Please wait...' : COPY[mode][2];
    }

    async function submit(event) {
        event.preventDefault();
        const email = $('authEmail').value.trim();
        const password = $('authPassword').value;
        const confirm = $('authConfirm').value;

        if (mode !== 'recover' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showMessage('Enter a valid email address.', 'error');
        if (mode !== 'forgot' && password.length < 8) return showMessage('Use a password of at least 8 characters.', 'error');
        if ((mode === 'register' || mode === 'recover') && password !== confirm) return showMessage("The passwords don't match.", 'error');

        busy(true);
        try {
            if (mode === 'login') {
                const { error } = await auth.client.auth.signInWithPassword({ email, password });
                if (error) return showMessage(friendly(error), 'error');
                location.replace(next);
            } else if (mode === 'register') {
                const { data, error } = await auth.client.auth.signUp({
                    email, password, options: { emailRedirectTo: location.origin + '/login?next=' + encodeURIComponent(next) }
                });
                if (error) return showMessage(friendly(error), 'error');
                if (data.session) return location.replace(next);           // email confirmation is off
                // With confirmation on, Supabase answers an existing email with a user that has no identities.
                if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
                    return showMessage('An account with this email already exists. Log in instead.', 'error');
                }
                setMode('login');
                $('authEmail').value = email;
                showMessage(`Almost done: we sent a confirmation link to ${email}. Open it, then log in here.`, 'ok');
            } else if (mode === 'forgot') {
                const { error } = await auth.client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/login' });
                if (error) return showMessage(friendly(error), 'error');
                showMessage(`If an account exists for ${email}, a reset link is on its way.`, 'ok');
            } else {
                const { error } = await auth.client.auth.updateUser({ password });
                if (error) return showMessage(friendly(error), 'error');
                showMessage('Password updated. Taking you to the tool...', 'ok');
                setTimeout(() => location.replace(next), 900);
            }
        } catch (e) {
            showMessage("We couldn't reach the login service. Check your connection and try again.", 'error');
        } finally {
            busy(false);
        }
    }

    document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
    $('forgotLink').addEventListener('click', () => setMode('forgot'));
    $('backToLogin').addEventListener('click', () => setMode('login'));
    $('authForm').addEventListener('submit', submit);
    if (params.get('mode') === 'register') setMode('register');

    if (!auth.enabled) {
        $('authForm').hidden = true;
        $('authTabs').hidden = true;
        $('forgotLink').hidden = true;
        $('authSub').innerHTML = 'Login isn\'t set up on this server, so the tool is open. <a href="/app">Go to the tool</a>.';
        return;
    }

    // A password-reset link lands here with a recovery session; otherwise skip the page if already logged in.
    auth.client.auth.onAuthStateChange(event => {
        if (event === 'PASSWORD_RECOVERY') setMode('recover');
    });
    if (arrivedForRecovery) setMode('recover');
    auth.session().then(s => {
        if (s && mode !== 'recover' && !arrivedForRecovery) location.replace(next);
    });
})();
