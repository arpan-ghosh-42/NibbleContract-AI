/**
 * Interactive effects shared by the landing page and the tool:
 *  - a themed background of faint "document lines" whose flagged clauses light up near the cursor
 *  - magnetic pull on the main buttons, click ripples, and a mouse-tilt on the hero card
 *  - the animations on/off toggle
 *
 * Motion preference lives on <html data-motion="on|off">. An inline script in each page sets it before
 * first paint: the saved choice if there is one, otherwise the OS "reduce motion" setting. Every effect
 * checks it live, so the toggle takes effect immediately.
 */
(function () {
    const MOTION_KEY = 'fpd_motion_v1';
    const root = document.documentElement;
    const motionOn = () => root.getAttribute('data-motion') !== 'off';
    const finePointer = window.matchMedia && window.matchMedia('(pointer: fine)').matches;

    // ---- background -------------------------------------------------------
    function linesImage() {
        let seed = 11;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
        const W = 720, H = 560, rows = 20;
        let shapes = '';
        for (let i = 0; i < rows; i++) {
            if (i % 6 === 5) continue;                       // paragraph break
            const y = 14 + i * 28;
            const w = Math.round(W * (0.38 + rnd() * 0.55));
            shapes += `<rect x="24" y="${y}" width="${w}" height="8" rx="4" fill="#94a3b8"/>`;
            if (rnd() < 0.24) {                              // a "flagged clause"
                const mw = 70 + Math.round(rnd() * 70);
                const mx = 24 + Math.round(rnd() * Math.max(10, w - mw));
                const colour = rnd() < 0.55 ? '#f59e0b' : '#ef4444';
                shapes += `<rect x="${mx}" y="${y - 2}" width="${mw}" height="12" rx="3" fill="${colour}"/>`;
            }
        }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${shapes}</svg>`;
        return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
    }

    const bg = document.createElement('div');
    bg.className = 'fx-bg';
    bg.setAttribute('aria-hidden', 'true');
    bg.innerHTML = '<div class="fx-lines fx-ambient"></div><div class="fx-lines fx-reveal"></div><div class="fx-glow"></div>';
    const image = linesImage();
    bg.querySelectorAll('.fx-lines').forEach(el => { el.style.backgroundImage = image; });
    document.body.insertBefore(bg, document.body.firstChild);

    function resetSpotlight() {
        bg.style.removeProperty('--mx');
        bg.style.removeProperty('--my');
        bg.style.removeProperty('--sy');
    }

    let px = 0, py = 0, queued = false;
    const applySpot = () => {
        queued = false;
        bg.style.setProperty('--mx', px + 'px');
        bg.style.setProperty('--my', py + 'px');
    };
    window.addEventListener('pointermove', e => {
        if (!motionOn()) return;
        px = e.clientX; py = e.clientY;
        if (!queued) { queued = true; requestAnimationFrame(applySpot); }
    }, { passive: true });
    document.addEventListener('pointerleave', () => { if (motionOn()) { px = -500; py = -500; applySpot(); } });

    let scrollQueued = false;
    window.addEventListener('scroll', () => {
        if (!motionOn() || scrollQueued) return;
        scrollQueued = true;
        requestAnimationFrame(() => { scrollQueued = false; bg.style.setProperty('--sy', window.scrollY); });
    }, { passive: true });

    // ---- click ripple -----------------------------------------------------
    document.addEventListener('pointerdown', e => {
        if (!motionOn()) return;
        const target = e.target.closest('.lp-btn, .btn, .example-chip, .lp-tab');
        if (!target || target.disabled) return;
        const rect = target.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 2;
        const ripple = document.createElement('span');
        ripple.className = 'fx-ripple';
        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
        ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
        target.appendChild(ripple);
        setTimeout(() => ripple.remove(), 650);
    });

    // ---- magnetic buttons and hero tilt (mouse only) ----------------------
    if (finePointer) {
        document.querySelectorAll('.lp-btn-lg, .lp-btn-primary, .btn-primary').forEach(btn => {
            btn.classList.add('fx-magnetic');
            btn.addEventListener('pointermove', e => {
                if (!motionOn()) return;
                const r = btn.getBoundingClientRect();
                const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
                const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
                btn.style.translate = `${(dx * 6).toFixed(1)}px ${(dy * 4).toFixed(1)}px`;
            });
            btn.addEventListener('pointerleave', () => { btn.style.translate = ''; });
        });

        const visual = document.querySelector('.lp-hero-visual');
        const mock = document.getElementById('heroMock');
        if (visual && mock) {
            visual.addEventListener('pointermove', e => {
                if (!motionOn()) return;
                const r = visual.getBoundingClientRect();
                const x = (e.clientX - r.left) / r.width - 0.5;
                const y = (e.clientY - r.top) / r.height - 0.5;
                mock.style.setProperty('--ry', (x * 12).toFixed(2) + 'deg');
                mock.style.setProperty('--rx', (-y * 9).toFixed(2) + 'deg');
            });
            visual.addEventListener('pointerleave', () => {
                mock.style.removeProperty('--ry');
                mock.style.removeProperty('--rx');
            });
        }
    }

    // ---- animations on/off toggle ----------------------------------------
    const toggle = document.getElementById('motionToggleBtn');
    function syncToggle() {
        if (!toggle) return;
        const on = motionOn();
        toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
        toggle.title = on ? 'Animations: on (click to turn off)' : 'Animations: off (click to turn on)';
    }
    syncToggle();
    if (toggle) {
        toggle.addEventListener('click', () => {
            const next = motionOn() ? 'off' : 'on';
            root.setAttribute('data-motion', next);
            try { localStorage.setItem(MOTION_KEY, next); } catch (e) { /* storage unavailable */ }
            if (next === 'off') {
                resetSpotlight();
                document.querySelectorAll('.fx-magnetic').forEach(b => { b.style.translate = ''; });
            }
            syncToggle();
            document.dispatchEvent(new CustomEvent('fpd-motion', { detail: { on: next === 'on' } }));
        });
    }
})();
