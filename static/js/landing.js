/**
 * Landing page behaviour: theme toggle, scroll reveal, hero scan animation,
 * and the interactive trust-score examples. All content here is static.
 */
(function () {
    const THEME_KEY = 'fpd_theme_v1';
    const $ = id => document.getElementById(id);
    // Motion preference lives on <html data-motion="on|off">, set before first paint from the OS "reduce motion" setting.
    const motionOff = () => document.documentElement.getAttribute('data-motion') === 'off';

    // ---- theme ----
    function updateThemeIcon() {
        const light = document.documentElement.getAttribute('data-theme') === 'light';
        $('themeToggleIcon').className = light ? 'fas fa-moon' : 'fas fa-sun';
    }
    updateThemeIcon();
    $('themeToggleBtn').addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { }
        updateThemeIcon();
    });

    // ---- nav shadow ----
    const nav = $('lpNav');
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // ---- scroll reveal ----
    // Reveal anything at or above the bottom edge of the viewport. Checking position (rather than relying
    // only on IntersectionObserver) means a fast scroll or an anchor jump can never leave a section hidden.
    const reveals = document.querySelectorAll('.lp-reveal');
    let revealQueued = false;
    function revealPending() {
        revealQueued = false;
        const limit = window.innerHeight * 0.92;
        reveals.forEach(el => {
            if (!el.classList.contains('in') && el.getBoundingClientRect().top < limit) el.classList.add('in');
        });
    }
    const queueReveal = () => {
        if (!revealQueued) { revealQueued = true; requestAnimationFrame(revealPending); }
    };
    if (motionOff()) {
        reveals.forEach(el => el.classList.add('in'));
    } else {
        window.addEventListener('scroll', queueReveal, { passive: true });
        window.addEventListener('resize', queueReveal);
        queueReveal();
    }

    // ---- number animation helper ----
    function animateScore(ringEl, numEl, from, to, ms) {
        if (motionOff()) { setScore(ringEl, numEl, to); return; }
        // Time from the first animation frame (rAF timestamps and performance.now() can be on different clocks).
        let start = null;
        function frame(now) {
            if (start === null) start = now;
            const t = Math.max(0, Math.min(1, (now - start) / ms));
            const eased = 1 - Math.pow(1 - t, 3);
            setScore(ringEl, numEl, Math.round(from + (to - from) * eased));
            if (t < 1) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    }
    function setScore(ringEl, numEl, value) {
        value = Math.max(0, Math.min(100, Math.round(value)));
        ringEl.style.setProperty('--pct', value);
        numEl.textContent = value;
    }

    // ---- hero: scan the fake offer, flag clauses, drop the score ----
    const mock = $('heroMock');
    if (mock) {
        const marks = mock.querySelectorAll('mark');
        const chips = mock.querySelectorAll('.lp-chip');
        const scan = $('heroScan');
        const verdict = $('heroVerdict');
        const ring = $('heroRing');
        const num = $('heroScore');
        const finalScore = 0;

        function showAll() {
            marks.forEach(m => m.classList.add('on'));
            chips.forEach(c => c.classList.add('on'));
            verdict.classList.add('on');
            setScore(ring, num, finalScore);
            scan.innerHTML = '<i class="fas fa-triangle-exclamation"></i> 4 red flags';
            scan.classList.add('done');
        }

        let timers = [];
        function cancelTimers() { timers.forEach(clearTimeout); timers = []; }

        function resetHero() {
            cancelTimers();
            marks.forEach(m => m.classList.remove('on'));
            chips.forEach(c => c.classList.remove('on'));
            verdict.classList.remove('on');
            setScore(ring, num, 50);
            scan.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> scanning';
            scan.classList.remove('done');
        }

        function playHero() {
            if (motionOff()) { cancelTimers(); showAll(); return; }
            resetHero();
            marks.forEach((m, i) => {
                timers.push(setTimeout(() => {
                    m.classList.add('on');
                    chips[i].classList.add('on');
                    animateScore(ring, num, 50 - i * 12, Math.max(finalScore, 50 - (i + 1) * 12), 600);
                }, 1100 + i * 900));
            });
            timers.push(setTimeout(() => {
                animateScore(ring, num, 2, finalScore, 500);
                verdict.classList.add('on');
                scan.innerHTML = '<i class="fas fa-triangle-exclamation"></i> 4 red flags';
                scan.classList.add('done');
            }, 1100 + marks.length * 900));
        }

        playHero();
    }

    // ---- interactive trust-score examples ----
    const DEMOS = {
        scam: {
            score: 0, cls: 'high', icon: 'fa-triangle-exclamation', verdict: 'High scam risk',
            note: 'Fictional offer from "Global Tech Hiring Solution"',
            signals: [
                ['bad', 'Asks you to pay money', 'A "refundable" registration fee of Rs 4,999'],
                ['bad', 'Asks for sensitive details too early', 'Aadhaar, PAN and bank OTP before joining'],
                ['bad', 'Free email address used', 'The recruiter writes from gmail.com'],
                ['bad', 'Pressure to accept quickly', '"Within 24 hours or the seat is gone"'],
                ['bad', 'Interview only via chat apps', 'Everything happens on WhatsApp']
            ]
        },
        fake: {
            score: 35, cls: 'high', icon: 'fa-triangle-exclamation', verdict: 'High scam risk',
            note: 'A well-written letter, but the company does not exist online',
            signals: [
                ['bad', 'Company domain isn\'t registered', 'The email domain has no registration record'],
                ['bad', 'Website does not exist', 'The site in the letterhead doesn\'t resolve'],
                ['good', 'Clear role, duties and duration', 'Specific title, dates and hours'],
                ['good', 'Named contact and office address', 'Looks professional, which is exactly why it fools people'],
                ['good', 'States no fees', 'Says the candidate pays nothing']
            ]
        },
        real: {
            score: 75, cls: 'low', icon: 'fa-circle-check', verdict: 'Looks consistent with a genuine offer',
            note: 'Established domain, working website, real selection process',
            signals: [
                ['good', 'Long-established domain', 'Registered for over 5 years'],
                ['good', 'Website mentions the company', 'A working site with a matching name'],
                ['good', 'References a real selection process', 'Application number and named interviewers'],
                ['good', 'Explicitly no fees', 'Clear stipend and payment date'],
                ['info', 'Still verify it yourself', 'We cap the score at 85: a document alone can\'t prove anything']
            ]
        }
    };

    const panel = $('demoPanel');
    const demoRing = $('demoRing');
    const demoNum = $('demoScore');
    const demoVerdict = $('demoVerdict');
    let currentScore = 0;

    function showDemo(key) {
        const d = DEMOS[key];
        panel.className = 'lp-demo-panel verdict-' + d.cls;
        demoVerdict.className = 'risk-badge risk-' + d.cls;
        demoVerdict.innerHTML = '<i class="fas ' + d.icon + '"></i> ';
        demoVerdict.appendChild(document.createTextNode(d.verdict));
        $('demoNote').textContent = d.note;
        animateScore(demoRing, demoNum, currentScore, d.score, 700);
        currentScore = d.score;

        const list = $('demoSignals');
        list.innerHTML = '';
        d.signals.forEach((s, i) => {
            const li = document.createElement('li');
            li.className = s[0];
            li.style.animationDelay = (i * 70) + 'ms';
            const icon = document.createElement('i');
            icon.className = 'fas ' + (s[0] === 'good' ? 'fa-circle-plus' : s[0] === 'info' ? 'fa-circle-info' : 'fa-circle-minus');
            const body = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = s[1];
            const small = document.createElement('small');
            small.textContent = s[2];
            body.appendChild(title);
            body.appendChild(small);
            li.appendChild(icon);
            li.appendChild(body);
            list.appendChild(li);
        });
    }

    document.querySelectorAll('.lp-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.lp-tab').forEach(t => {
                const on = t === tab;
                t.classList.toggle('active', on);
                t.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            showDemo(tab.dataset.demo);
        });
    });

    // Start the demo when it scrolls into view so the ring animates for the visitor.
    const demoSection = $('score');
    let demoStarted = false;
    function startDemo() {
        if (demoStarted) return;
        demoStarted = true;
        showDemo('scam');
    }
    if ('IntersectionObserver' in window) {
        new IntersectionObserver((entries, obs) => {
            if (entries.some(e => e.isIntersecting)) { startDemo(); obs.disconnect(); }
        }, { threshold: 0.25 }).observe(demoSection);
    } else {
        startDemo();
    }
})();
