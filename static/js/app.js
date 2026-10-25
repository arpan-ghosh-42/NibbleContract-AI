/**
 * NibbleContract AI frontend
 * Two checks: a job post (before applying) and an offer letter (before signing).
 * Each returns a trust score with its evidence.
 */

const STORAGE_KEYS = {
    REPORTS: 'fpd_reports_v1',
    THEME: 'fpd_theme_v1'
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MIN_CHARS = 80;
const MAX_SAVED_REPORTS = 30;
const DECODER_DISCLAIMER = 'Not legal advice. Have someone you trust review anything important.';
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const State = { file: null, busy: false, reports: [], tool: 'post' };
const TOOLS = { post: { tab: 'tabPost', panel: 'postPanel' }, offer: { tab: 'tabOffer', panel: 'inputPanel' } };
// Example keys used by older links.
const EXAMPLE_ALIASES = { scam: 'post_risky', fake: 'offer_fake' };

const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    await startSession();
    loadReports();
    setupEvents();
    renderHistory();

    // Links can pick the tool (/app?tool=offer) or open a ready-made example (/app?example=post_risky).
    const params = new URLSearchParams(window.location.search);
    setTool(params.get('tool') === 'offer' ? 'offer' : 'post');
    const wanted = EXAMPLE_ALIASES[params.get('example')] || params.get('example');
    if (wanted && window.FPD_SAMPLES && window.FPD_SAMPLES[wanted]) loadExample(wanted);
});

// The tool is for logged-in users: wait for the login check before showing anything.
async function startSession() {
    const auth = window.NC_AUTH;
    if (!auth || !auth.enabled) {
        document.body.classList.remove('auth-pending');
        return;
    }
    let session;
    try {
        session = await auth.requireLogin();
    } catch (e) {
        // Never leave a blank page: show the tool; the server still refuses checks without a valid login.
        document.body.classList.remove('auth-pending');
        showToast("Couldn't confirm your login. Try refreshing the page.");
        return;
    }
    $('userEmail').textContent = (session.user && session.user.email) || 'Logged in';
    $('userBox').hidden = false;
    $('logoutBtn').addEventListener('click', () => auth.logout());
    document.body.classList.remove('auth-pending');
}

function setTool(tool) {
    State.tool = TOOLS[tool] ? tool : 'post';
    Object.entries(TOOLS).forEach(([name, ids]) => {
        const on = name === State.tool;
        $(ids.tab).classList.toggle('active', on);
        $(ids.tab).setAttribute('aria-selected', on ? 'true' : 'false');
        $(ids.panel).hidden = !on;
    });
}

// Fill the form with one of the fictional examples (see samples.js).
function loadExample(key) {
    const sample = window.FPD_SAMPLES && window.FPD_SAMPLES[key];
    if (!sample) return;
    if (sample.kind === 'post') {
        setTool('post');
        $('postCompany').value = sample.company_name || '';
        $('postWebsite').value = sample.website || '';
        $('postUrl').value = sample.url || '';
        $('postText').value = sample.text;
        $('postText').scrollTop = 0;
    } else {
        setTool('offer');
        setFile(null);
        $('senderEmail').value = sample.sender_email || '';
        $('companyName').value = sample.company_name || '';
        $('companyWebsite').value = sample.website || '';
        $('docText').value = sample.text;
        $('docText').scrollTop = 0;
    }
    document.querySelectorAll('.example-chip').forEach(chip =>
        chip.classList.toggle('active', chip.dataset.example === key));
}

// While waiting for the server, cycle through what it is actually doing.
const PROGRESS_STEPS = {
    offer: ['Reading the offer...', 'Hunting for red flags...', 'Checking the domain and website...',
        'Searching the web for reports...', 'Scoring the offer...'],
    post: ['Reading the post...', 'Looking for warning signs...', 'Checking the company\'s domain and website...',
        'Searching the web and Reddit...', 'Scoring the post...']
};

function startProgressMessages(kind) {
    const steps = PROGRESS_STEPS[kind];
    let i = 0;
    const el = () => document.getElementById('progressText');
    const timer = setInterval(() => {
        i = Math.min(i + 1, steps.length - 1);
        if (el()) el().textContent = steps[i];
    }, 3500);
    return { first: steps[0], stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// Storage / theme
// ---------------------------------------------------------------------------
function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}
function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
}

function initTheme() {
    const theme = safeGet(STORAGE_KEYS.THEME) || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeIcon(theme);
}

function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    safeSet(STORAGE_KEYS.THEME, next);
    updateThemeIcon(next);
}

function updateThemeIcon(theme) {
    $('themeToggleIcon').className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
}

function loadReports() {
    try {
        const parsed = JSON.parse(safeGet(STORAGE_KEYS.REPORTS) || '[]');
        State.reports = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        State.reports = [];
    }
}

function saveReports() {
    State.reports = State.reports.slice(0, MAX_SAVED_REPORTS);
    safeSet(STORAGE_KEYS.REPORTS, JSON.stringify(State.reports));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function setupEvents() {
    $('themeToggleBtn').addEventListener('click', toggleTheme);
    document.querySelectorAll('.tool-tab').forEach(tab =>
        tab.addEventListener('click', () => setTool(tab.dataset.tool)));
    $('btnCheckPost').addEventListener('click', handleCheckPost);
    $('btnDecode').addEventListener('click', handleDecode);
    document.querySelectorAll('.example-chip').forEach(chip =>
        chip.addEventListener('click', () => loadExample(chip.dataset.example)));
    $('btnAttach').addEventListener('click', () => $('decoderFileInput').click());
    $('decoderFileInput').addEventListener('change', e => setFile(e.target.files[0] || null));
    $('decoderFileRemove').addEventListener('click', () => setFile(null));

    const submitOnCtrlEnter = handler => e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handler();
        }
    };
    $('docText').addEventListener('keydown', submitOnCtrlEnter(handleDecode));
    $('postText').addEventListener('keydown', submitOnCtrlEnter(handleCheckPost));
    $('postUrl').addEventListener('keydown', e => { if (e.key === 'Enter') handleCheckPost(); });

    const zone = $('dropZone');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
    });
}

function setFile(file) {
    if (file) {
        const name = file.name.toLowerCase();
        if (!name.endsWith('.pdf') && !name.endsWith('.txt')) {
            showToast('Please choose a PDF or .txt file.');
            file = null;
        } else if (file.size > MAX_FILE_BYTES) {
            showToast('That file is larger than 5 MB.');
            file = null;
        }
    }
    State.file = file || null;
    if (!State.file) $('decoderFileInput').value = '';

    const chip = $('decoderFileChip');
    if (State.file) {
        const kb = Math.max(1, Math.round(State.file.size / 1024));
        $('decoderFileName').textContent = `${State.file.name} (${kb.toLocaleString()} KB)`;
        $('decoderFileIcon').className = State.file.name.toLowerCase().endsWith('.pdf') ? 'fas fa-file-pdf' : 'fas fa-file-lines';
        chip.style.display = 'flex';
    } else {
        chip.style.display = 'none';
    }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
async function handleCheckPost() {
    if (State.busy) return;
    const pasted = $('postText').value.trim();
    const url = $('postUrl').value.trim();
    if (!pasted && !url) {
        showToast('Paste the job post text, or a link to it, first.');
        return;
    }
    if (pasted && pasted.length < MIN_CHARS) {
        showToast('That is too short to check. Paste the full job post.');
        return;
    }
    if (pasted && url) showToast('Using the pasted text (the link is ignored).');

    const form = new FormData();
    if (pasted) form.append('text', pasted); else form.append('url', url);
    form.append('company_name', $('postCompany').value.trim());
    form.append('website', $('postWebsite').value.trim());

    await submitCheck('post', '/check-post', form, 'btnCheckPost', result => {
        const report = normalizePostReport(result);
        $('postText').value = '';
        $('postUrl').value = '';
        return {
            kind: 'post',
            title: [report.role, report.company].filter(Boolean).join(' · ') || 'Pasted job post',
            report: report
        };
    });
}

async function handleDecode() {
    if (State.busy) return;
    const pasted = $('docText').value.trim();

    if (!State.file && !pasted) {
        showToast('Paste the offer letter text or upload a PDF/.txt first.');
        return;
    }
    if (!State.file && pasted.length < MIN_CHARS) {
        showToast('That is too short to review. Paste the full offer letter.');
        return;
    }
    if (State.file && pasted) showToast('Using the uploaded file (pasted text is ignored).');

    const form = new FormData();
    if (State.file) form.append('file', State.file); else form.append('text', pasted);
    form.append('sender_email', $('senderEmail').value.trim());
    form.append('company_name', $('companyName').value.trim());
    form.append('website', $('companyWebsite').value.trim());

    await submitCheck('offer', '/decode', form, 'btnDecode', result => {
        const report = normalizeReport(result);
        $('docText').value = '';
        setFile(null);
        return { kind: 'offer', title: report.meta.filename || 'Pasted offer letter', report: report };
    });
}

// POST a form, show progress, then save and show the report that toEntry() builds from the result.
async function submitCheck(kind, endpoint, form, buttonId, toEntry) {
    setBusy(true, buttonId);
    $('reportArea').innerHTML = '';
    const progress = startProgressMessages(kind);
    $('statusArea').innerHTML = `
        <div class="panel loading"><div class="spinner"></div>
        <div><strong id="progressText">${escapeHtml(progress.first)}</strong>
        <div class="hint">The online checks can take up to a minute.</div></div></div>`;

    try {
        const headers = window.NC_AUTH ? await window.NC_AUTH.authHeaders() : {};
        const response = await fetch(endpoint, { method: 'POST', body: form, headers: headers });
        let data;
        try {
            data = await response.json();
        } catch (e) {
            data = { error: `The server returned an unexpected response (${response.status}).` };
        }
        if (response.status === 401 && data.login && window.NC_AUTH) {
            window.NC_AUTH.goToLogin();
            return;
        }

        if (data.error || !data.result) {
            $('statusArea').innerHTML = `<div class="error-box"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(data.error || 'No report was returned.')}</div>`;
            return;
        }

        const entry = Object.assign({ id: 'rep_' + Date.now(), createdAt: new Date().toISOString() }, toEntry(data.result));
        State.reports.unshift(entry);
        saveReports();
        renderHistory();
        $('statusArea').innerHTML = '';
        showReport(entry);
    } catch (err) {
        $('statusArea').innerHTML = `<div class="error-box"><i class="fas fa-triangle-exclamation"></i> Could not reach the server. Is it running? (${escapeHtml(err.message)})</div>`;
    } finally {
        progress.stop();
        setBusy(false, buttonId);
    }
}

function setBusy(busy, buttonId) {
    State.busy = busy;
    const btn = $(buttonId);
    if (busy) btn.dataset.label = btn.innerHTML;
    btn.disabled = busy;
    btn.innerHTML = busy ? '<i class="fas fa-spinner fa-spin"></i> Checking...' : (btn.dataset.label || btn.innerHTML);
}

function showReport(entry) {
    const area = $('reportArea');
    area.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'report-wrap';
    const isPost = entry.kind === 'post';
    const report = isPost ? normalizePostReport(entry.report) : normalizeReport(entry.report);
    wrap.innerHTML = isPost ? renderPostReport(report) : renderDecoderReport(report);
    const actions = document.createElement('div');
    actions.className = 'report-actions';
    actions.innerHTML = '<button class="msg-action-btn" type="button"><i class="fas fa-copy"></i> Copy report</button>';
    actions.firstChild.addEventListener('click', () =>
        copyTextToClipboard(isPost ? postToMarkdown(report) : reportToMarkdown(report), 'Report copied!'));
    wrap.appendChild(actions);
    area.appendChild(wrap);
    if (isPost) bindPostReportActions(wrap, report); else bindDecoderReportActions(wrap, report);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Saved reports
// ---------------------------------------------------------------------------
function renderHistory() {
    const panel = $('historyPanel');
    const list = $('historyList');
    panel.style.display = State.reports.length ? 'block' : 'none';
    list.innerHTML = '';

    State.reports.forEach(entry => {
        const isPost = entry.kind === 'post';
        const rawRisk = entry.report && (isPost ? entry.report.risk_level : entry.report.overall_risk);
        const risk = SEVERITY_ORDER.hasOwnProperty(rawRisk) ? rawRisk : 'medium';
        const row = document.createElement('div');
        row.className = 'history-item';
        row.innerHTML = `
            <div class="history-main">
                <strong>${escapeHtml(entry.title)}</strong>
                <span class="sub">${isPost ? 'job post' : 'offer letter'} · ${escapeHtml(new Date(entry.createdAt).toLocaleString())}</span>
            </div>
            <span class="risk-badge risk-${risk}">${isPost ? `${entry.report.score}/100` : risk}</span>
            <button class="history-del" type="button" title="Delete"><i class="fas fa-trash-alt"></i></button>`;
        row.addEventListener('click', () => showReport(entry));
        row.querySelector('.history-del').addEventListener('click', e => {
            e.stopPropagation();
            State.reports = State.reports.filter(r => r.id !== entry.id);
            saveReports();
            renderHistory();
        });
        list.appendChild(row);
    });
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------
// Reports saved before the risk-level wording used verdict ids; map those too.
const LEGACY_VERDICTS = { likely_genuine: 'low', uncertain: 'medium', likely_scam: 'high' };
const RISK_LABELS = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

// Coerce the authenticity block into a safe, known shape (or null).
function normalizeAuthenticity(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const str = v => (typeof v === 'string' ? v : '');
    const list = v => (Array.isArray(v) ? v : []);
    const riskLevel = SEVERITY_ORDER.hasOwnProperty(raw.risk_level) ? raw.risk_level
        : (LEGACY_VERDICTS[raw.verdict] || 'medium');
    const score = Math.max(0, Math.min(100, Math.round(Number(raw.score)) || 0));
    return {
        score: score,
        risk_level: riskLevel,
        verdict_label: raw.risk_level ? str(raw.verdict_label) : RISK_LABELS[riskLevel],
        confidence: ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'low',
        company: str(raw.company),
        limits: str(raw.limits),
        checklist: list(raw.checklist).map(str).filter(Boolean),
        checks: normalizeChecks(raw.checks),
        agents: normalizeAgents(raw.agents),
        signals: normalizeSignals(raw.signals)
    };
}

const safeStr = v => (typeof v === 'string' ? v : '');
const safeList = v => (Array.isArray(v) ? v : []);

function normalizeChecks(raw) {
    return safeList(raw)
        .filter(c => c && typeof c === 'object')
        .map(c => ({
            name: safeStr(c.name),
            status: ['ok', 'warn', 'unavailable', 'skipped'].includes(c.status) ? c.status : 'unavailable',
            detail: safeStr(c.detail)
        }));
}

function normalizeSignals(raw) {
    const weights = ['high', 'medium', 'low'];
    return safeList(raw)
        .filter(s => s && typeof s === 'object')
        .map(s => ({
            id: safeStr(s.id),
            polarity: s.polarity === 'positive' ? 'positive' : 'negative',
            weight: weights.includes(s.weight) ? s.weight : 'low',
            label: safeStr(s.label),
            explanation: safeStr(s.explanation),
            evidence: safeStr(s.evidence),
            evidence_verified: s.evidence_verified !== false,
            counted: s.counted !== false,
            not_counted_reason: safeStr(s.not_counted_reason),
            sources: safeList(s.sources)
                .filter(src => src && typeof src === 'object' && /^https?:\/\//i.test(safeStr(src.url)))
                .slice(0, 5)
                .map(src => ({ title: safeStr(src.title) || safeStr(src.url), url: safeStr(src.url) }))
        }));
}

// Coerce a job-post report (from the server or localStorage) into a safe, known shape.
function normalizePostReport(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const it = r.internship_type && typeof r.internship_type === 'object' ? r.internship_type : {};
    const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
    const riskLevel = SEVERITY_ORDER.hasOwnProperty(r.risk_level) ? r.risk_level : 'medium';
    return {
        score: Math.max(0, Math.min(100, Math.round(Number(r.score)) || 0)),
        risk_level: riskLevel,
        risk_label: safeStr(r.risk_label) || RISK_LABELS[riskLevel],
        confidence: ['low', 'medium', 'high'].includes(r.confidence) ? r.confidence : 'low',
        company: safeStr(r.company),
        role: safeStr(r.role),
        internship_type: {
            label: safeStr(it.label) || 'unclear',
            display: safeStr(it.display) || 'Unclear',
            verified: it.verified !== false,
            quotes: safeList(it.quotes)
                .filter(q => q && typeof q === 'object' && safeStr(q.text))
                .map(q => ({ text: safeStr(q.text), verified: q.verified !== false }))
        },
        signals: normalizeSignals(r.signals),
        checks: normalizeChecks(r.checks),
        agents: normalizeAgents(r.agents),
        questions: safeList(r.questions).map(safeStr).filter(Boolean),
        checklist: safeList(r.checklist).map(safeStr).filter(Boolean),
        limits: safeStr(r.limits),
        meta: { source: safeStr(meta.source), host: safeStr(meta.host), characters: Number(meta.characters) || 0 }
    };
}

function sourceHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

// One evidence row per signal. `where` names the text quotes were checked against.
function renderSignals(list, where) {
    return list.map(s => `
        <div class="auth-signal ${s.polarity}${s.counted ? '' : ' not-scored'}">
            <div class="auth-signal-head">
                <i class="fas ${s.polarity === 'positive' ? 'fa-circle-plus' : 'fa-circle-minus'}"></i>
                <strong>${escapeHtml(s.label)}</strong>
                <span class="sev-pill sev-${s.polarity === 'positive' ? 'low' : s.weight}">${s.polarity === 'positive' ? 'good sign' : s.weight + ' risk'}</span>
                ${s.counted ? '' : `<span class="quote-unverified" title="This did not change the score."><i class="fas fa-circle-question"></i> ${escapeHtml(s.not_counted_reason || `Not counted: evidence not found in your ${where}`)}</span>`}
            </div>
            ${s.explanation ? `<p>${escapeHtml(s.explanation)}</p>` : ''}
            ${s.evidence ? `<blockquote class="clause-quote"><mark>${escapeHtml(s.evidence)}</mark></blockquote>` : ''}
            ${s.sources.length ? `
            <ul class="auth-sources">${s.sources.map(src => `
                <li><i class="fas fa-arrow-up-right-from-square"></i>
                    <a href="${escapeHtml(src.url)}" rel="noopener noreferrer nofollow">${escapeHtml(src.title)}</a>
                    <span class="auth-source-host">${escapeHtml(sourceHost(src.url))}</span></li>`).join('')}
            </ul>` : ''}
        </div>`).join('');
}

// Safe to run twice: reports are normalized when they arrive and again when shown from history.
function normalizeAgents(raw) {
    const statuses = ['done', 'skipped', 'unavailable'];
    const httpUrl = u => /^https?:\/\//i.test(safeStr(u));
    return safeList(raw)
        .filter(a => a && typeof a === 'object' && safeStr(a.name))
        .slice(0, 6)
        .map(a => ({
            id: safeStr(a.id),
            name: safeStr(a.name),
            role: safeStr(a.role),
            status: statuses.includes(a.status) ? a.status : 'unavailable',
            seconds: Math.max(0, a.duration_ms !== undefined ? (Number(a.duration_ms) || 0) / 1000 : Number(a.seconds) || 0),
            tool_calls: Math.max(0, Math.round(Number(a.tool_calls)) || 0),
            engines: safeList(a.engines).map(safeStr).filter(Boolean),
            note: safeStr(a.note),
            sources: safeList(a.sources)
                .filter(s => s && typeof s === 'object' && httpUrl(s.url))
                .slice(0, 10)
                .map(s => ({ title: safeStr(s.title) || safeStr(s.url), url: safeStr(s.url) })),
            findings: safeList(a.findings)
                .filter(f => f && typeof f === 'object' && safeStr(f.claim))
                .slice(0, 10)
                .map(f => ({
                    claim: safeStr(f.claim),
                    stance: safeStr(f.stance),
                    url: httpUrl(f.source_url) ? safeStr(f.source_url) : (httpUrl(f.url) ? safeStr(f.url) : ''),
                    grounded: f.grounded !== false,
                    counted: f.counted !== false && f.grounded !== false
                }))
        }));
}

const STANCE_LABELS = {
    scam_report: 'fraud claim', impersonation_warning: 'fake-offer warning', complaint: 'complaint',
    positive: 'positive', neutral: 'neutral', funding_round: 'funding', not_funding: 'not funding',
    ok: 'ok', warn: 'concern', unavailable: 'unavailable', skipped: 'skipped'
};
const STANCE_TONE = {
    scam_report: 'high', impersonation_warning: 'medium', complaint: 'medium', warn: 'high',
    positive: 'low', funding_round: 'low', ok: 'low'
};

// The agent research panel: a small Gantt chart of what ran, for how long, and what each agent used.
function renderAgents(agents) {
    if (!agents.length) return '';
    const analyst = agents.find(a => a.id === 'post_analyst');
    const research = agents.filter(a => a !== analyst);
    const offset = analyst ? analyst.seconds : 0;   // research agents start once the analyst is done
    const slowest = Math.max(0, ...research.filter(a => a.status !== 'skipped').map(a => a.seconds));
    const total = offset + slowest || 1;
    const icons = { done: 'fa-circle-check', skipped: 'fa-circle-minus', unavailable: 'fa-circle-exclamation' };
    const statusText = { done: 'done', skipped: 'skipped', unavailable: 'unavailable' };
    const ran = research.filter(a => a.status !== 'skipped').length;

    const rows = agents.map(a => {
        const start = a === analyst ? 0 : offset;
        const width = a.status === 'skipped' ? 0 : Math.max(1.5, (a.seconds / total) * 100);
        const meta = [];
        if (a.status !== 'skipped') meta.push(`${a.seconds.toFixed(1)}s`);
        if (a.tool_calls) meta.push(`${a.tool_calls} tool call${a.tool_calls === 1 ? '' : 's'}`);
        if (a.sources.length) meta.push(`${a.sources.length} source${a.sources.length === 1 ? '' : 's'}`);
        if (a.engines.length) meta.push(a.engines.map(e => e === 'duckduckgo' ? 'DuckDuckGo' : e === 'tavily' ? 'Tavily' : e).join(' + '));
        const findings = a.findings.length ? `
            <ul class="agent-findings">${a.findings.map(f => `
                <li>
                    <span class="stance-pill tone-${STANCE_TONE[f.stance] || 'none'}">${escapeHtml(STANCE_LABELS[f.stance] || f.stance || 'finding')}</span>
                    <span class="agent-claim">${escapeHtml(f.claim)}</span>
                    ${!f.grounded ? '<span class="quote-unverified"><i class="fas fa-circle-question"></i> unverified: no tool returned this link, not counted</span>'
                      : !f.counted ? '<span class="quote-unverified">not counted</span>' : ''}
                    ${f.url ? `<a class="agent-link" href="${escapeHtml(f.url)}" rel="noopener noreferrer nofollow">${escapeHtml(sourceHost(f.url) || 'source')}</a>` : ''}
                </li>`).join('')}
            </ul>` : '';
        const sources = a.sources.length ? `
            <ul class="auth-sources">${a.sources.map(src => `
                <li><i class="fas fa-arrow-up-right-from-square"></i>
                    <a href="${escapeHtml(src.url)}" rel="noopener noreferrer nofollow">${escapeHtml(src.title)}</a>
                    <span class="auth-source-host">${escapeHtml(sourceHost(src.url))}</span></li>`).join('')}
            </ul>` : '';
        const hasDetail = a.note || findings || sources;
        const head = `
            <span class="agent-status status-${a.status}" title="${statusText[a.status]}"><i class="fas ${icons[a.status]}"></i></span>
            <span class="agent-name"><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.role)}</small></span>
            <span class="agent-track" aria-hidden="true"><span class="agent-bar status-${a.status}" style="left:${start / total * 100}%;width:${width}%"></span></span>
            <span class="agent-meta">${a.status === 'skipped' ? 'skipped' : a.status === 'unavailable' ? `unavailable · ${meta.join(' · ')}` : meta.join(' · ')}</span>
            ${hasDetail ? '<i class="fas fa-chevron-down agent-chevron" aria-hidden="true"></i>' : ''}`;
        return hasDetail ? `
            <details class="agent-row">
                <summary>${head}</summary>
                <div class="agent-detail">
                    ${a.note ? `<p class="agent-note">${escapeHtml(a.note)}</p>` : ''}
                    ${findings}
                    ${sources ? `<div class="agent-sources-title">Sources the tools returned</div>${sources}` : ''}
                </div>
            </details>` : `<div class="agent-row"><div class="agent-summary">${head}</div></div>`;
    }).join('');

    return `
        <div class="auth-group agent-panel">
            <div class="agent-panel-head">
                <div class="auth-group-title"><i class="fas fa-diagram-project"></i> Research agents</div>
                <span class="agent-total">${total.toFixed(1)}s total${ran > 1 ? ` · ${ran} agents ran in parallel` : ''}</span>
            </div>
            <div class="agent-list">${rows}</div>
            <p class="hint">Agents only gather evidence. The score comes from fixed rules, and a finding only counts when its source is a link a tool actually returned.</p>
        </div>`;
}

function renderChecks(checks) {
    const icons = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', unavailable: 'fa-circle-question', skipped: 'fa-circle-minus' };
    return checks.length ? `
        <div class="auth-group">
            <div class="auth-group-title">What we checked online</div>
            <ul class="auth-checks">${checks.map(c => `
                <li class="check-${c.status}">
                    <i class="fas ${icons[c.status]}"></i>
                    <span><strong>${escapeHtml(c.name)}</strong>${c.detail ? ` · ${escapeHtml(c.detail)}` : ''}</span>
                </li>`).join('')}
            </ul>
        </div>` : '';
}

const CONFIDENCE_TEXT = {
    high: 'High confidence: plenty of evidence from the post and online checks',
    medium: 'Medium confidence: some evidence, so verify the rest yourself',
    low: 'Low confidence: little evidence either way (add the company name and website)'
};

function renderPostReport(r) {
    const verdictIcons = { low: 'fa-circle-check', medium: 'fa-circle-question', high: 'fa-triangle-exclamation' };
    const red = r.signals.filter(s => s.polarity === 'negative');
    const good = r.signals.filter(s => s.polarity === 'positive');
    const it = r.internship_type;
    const typeHtml = `
        <div class="auth-group type-block">
            <div class="auth-group-title">Internship type</div>
            <p class="type-label"><span class="type-chip type-${escapeHtml(it.label)}">${escapeHtml(it.display)}</span>
            ${it.verified ? '' : '<span class="quote-unverified"><i class="fas fa-circle-question"></i> The lines behind this label weren\'t found in the post, so it isn\'t used</span>'}</p>
            ${it.quotes.map(q => `<blockquote class="clause-quote"><mark>${escapeHtml(q.text)}</mark>${q.verified ? '' : ' <span class="quote-unverified">(not found in the post)</span>'}</blockquote>`).join('')}
        </div>`;
    const questionsHtml = r.questions.length ? `
        <div class="auth-group">
            <div class="decoder-card-head">
                <div class="auth-group-title">Questions to ask before you apply</div>
                <button class="msg-action-btn post-questions-copy" type="button"><i class="fas fa-copy"></i> Copy</button>
            </div>
            <ol class="question-list">${r.questions.map(q => `<li><span>${escapeHtml(q)}</span></li>`).join('')}</ol>
        </div>` : '';
    const checklistHtml = r.checklist.length ? `
        <div class="auth-group">
            <div class="decoder-card-head">
                <div class="auth-group-title">Verify it yourself</div>
                <button class="msg-action-btn post-checklist-copy" type="button"><i class="fas fa-copy"></i> Copy</button>
            </div>
            <ol class="question-list">${r.checklist.map(c => `<li><span>${escapeHtml(c)}</span></li>`).join('')}</ol>
        </div>` : '';
    const subject = [r.role, r.company].filter(Boolean).join(' · ');
    const metaBits = [];
    if (r.meta.source === 'link' && r.meta.host) metaBits.push(`read from ${escapeHtml(r.meta.host)}`);
    if (r.meta.characters) metaBits.push(`${r.meta.characters.toLocaleString()} characters`);

    const html = `
        <div class="decoder-report">
            <div class="decoder-report-header">
                <div class="decoder-report-title">
                    <i class="fas fa-magnifying-glass"></i>
                    <span>Job post check${subject ? ` · ${escapeHtml(subject)}` : ''}</span>
                </div>
            </div>
            <div class="decoder-card auth-card verdict-${r.risk_level}">
                <div class="auth-top">
                    <div class="trust-ring" style="--pct:${r.score}" role="img" aria-label="Trust score ${r.score} out of 100">
                        <div class="trust-ring-inner"><strong>${r.score}</strong><span>/100</span></div>
                    </div>
                    <div class="auth-top-text">
                        <h4><i class="fas fa-user-shield"></i> Internship trust score</h4>
                        <span class="risk-badge risk-${r.risk_level}"><i class="fas ${verdictIcons[r.risk_level]}"></i> ${escapeHtml(r.risk_label)}</span>
                        <p class="auth-meta">${escapeHtml(CONFIDENCE_TEXT[r.confidence])}</p>
                    </div>
                </div>
                ${typeHtml}
                ${red.length ? `<div class="auth-group"><div class="auth-group-title">Warning signs <span class="decoder-count">${red.length}</span></div>${renderSignals(red, 'post')}</div>` : ''}
                ${good.length ? `<div class="auth-group"><div class="auth-group-title">Good signs <span class="decoder-count">${good.length}</span></div>${renderSignals(good, 'post')}</div>` : ''}
                ${!red.length && !good.length ? '<p class="decoder-empty">No clear signals either way were found in the post.</p>' : ''}
                ${renderChecks(r.checks)}
                ${renderAgents(r.agents)}
                ${questionsHtml}
                ${checklistHtml}
                <p class="auth-limits"><i class="fas fa-circle-info"></i> ${escapeHtml(r.limits)}</p>
            </div>
            ${metaBits.length ? `<span class="decoder-meta">${metaBits.join(' • ')}</span>` : ''}
        </div>`;
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
}

function bindPostReportActions(row, report) {
    const bind = (selector, items, message) => {
        const btn = row.querySelector(selector);
        if (btn) btn.addEventListener('click', () =>
            copyTextToClipboard(items.map((x, i) => `${i + 1}. ${x}`).join('\n'), message));
    };
    bind('.post-questions-copy', report.questions, 'Questions copied!');
    bind('.post-checklist-copy', report.checklist, 'Checklist copied!');
}

function postToMarkdown(r) {
    const lines = [`## ${window.BRAND_NAME || 'NibbleContract AI'}: job post check`];
    const subject = [r.role, r.company].filter(Boolean).join(' · ');
    if (subject) lines.push(subject);
    lines.push('', `**Internship trust score:** ${r.score}/100 (${r.risk_label})`, `**Internship type:** ${r.internship_type.display}`, '');
    r.signals.forEach(s => {
        lines.push(`- ${s.polarity === 'positive' ? '[good]' : '[warning]'} ${s.label}${s.evidence ? `: "${s.evidence}"` : ''}${s.counted ? '' : ' _(not counted)_'}`);
        s.sources.forEach(src => lines.push(`  - Source: ${src.title} (${src.url})`));
    });
    if (r.checks.length) {
        lines.push('', '**Checked online:**');
        r.checks.forEach(c => lines.push(`- ${c.name} (${c.status})${c.detail ? `: ${c.detail}` : ''}`));
    }
    if (r.agents.length) {
        lines.push('', '**Research agents:**');
        r.agents.forEach(a => lines.push(`- ${a.name}: ${a.status}${a.status === 'skipped' ? '' : ` in ${a.seconds.toFixed(1)}s`}${a.note ? ` (${a.note})` : ''}`));
    }
    lines.push('', '**Questions to ask before you apply:**');
    r.questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
    lines.push('', '**Verify it yourself:**');
    r.checklist.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    lines.push('', `_${r.limits}_`);
    return lines.join('\n');
}

function renderAuthenticity(report) {
    const au = report.authenticity;
    if (!au) {
        return report.authenticity_error
            ? `<div class="decoder-card"><p class="decoder-empty"><i class="fas fa-circle-info"></i> ${escapeHtml(report.authenticity_error)}</p></div>`
            : '';
    }
    const cls = au.risk_level;
    const verdictIcons = { low: 'fa-circle-check', medium: 'fa-circle-question', high: 'fa-triangle-exclamation' };

    const signalHtml = list => renderSignals(list, 'document');
    const checksHtml = renderChecks(au.checks);

    const red = au.signals.filter(s => s.polarity === 'negative');
    const good = au.signals.filter(s => s.polarity === 'positive');
    const checklistHtml = au.checklist.length
        ? `<ol class="question-list">${au.checklist.map(c => `<li><span>${escapeHtml(c)}</span></li>`).join('')}</ol>`
        : '';

    return `
        <div class="decoder-card auth-card verdict-${cls}">
            <div class="auth-top">
                <div class="trust-ring" style="--pct:${au.score}" role="img" aria-label="Trust score ${au.score} out of 100">
                    <div class="trust-ring-inner"><strong>${au.score}</strong><span>/100</span></div>
                </div>
                <div class="auth-top-text">
                    <h4><i class="fas fa-user-shield"></i> Internship trust score</h4>
                    <span class="risk-badge risk-${cls}"><i class="fas ${verdictIcons[cls]}"></i> ${escapeHtml(au.verdict_label)}</span>
                    <p class="auth-meta">${au.company ? `Company: ${escapeHtml(au.company)} · ` : ''}Based on ${au.confidence === 'high' ? 'the document and your sender details' : au.confidence === 'medium' ? 'the document and some sender details' : 'the document only (add sender email, company and website for a better check)'}</p>
                </div>
            </div>
            ${red.length ? `<div class="auth-group"><div class="auth-group-title">Warning signs <span class="decoder-count">${red.length}</span></div>${signalHtml(red)}</div>` : ''}
            ${good.length ? `<div class="auth-group"><div class="auth-group-title">Good signs <span class="decoder-count">${good.length}</span></div>${signalHtml(good)}</div>` : ''}
            ${!red.length && !good.length ? '<p class="decoder-empty">No clear signals either way were found in the text.</p>' : ''}
            ${checksHtml}
            ${renderAgents(au.agents)}
            ${checklistHtml ? `
            <div class="auth-group">
                <div class="decoder-card-head">
                    <div class="auth-group-title">Verify it yourself</div>
                    <button class="msg-action-btn checklist-copy-all" type="button"><i class="fas fa-copy"></i> Copy</button>
                </div>
                ${checklistHtml}
            </div>` : ''}
            <p class="auth-limits"><i class="fas fa-circle-info"></i> ${escapeHtml(au.limits)}</p>
        </div>`;
}

// Coerce a report (from the server or localStorage) into a safe, known shape.
function normalizeReport(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const str = v => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''));
    const level = (v, fallback) => (SEVERITY_ORDER.hasOwnProperty(v) ? v : fallback);
    const list = v => (Array.isArray(v) ? v : []);
    const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};

    return {
        summary: str(r.summary),
        overall_risk: level(r.overall_risk, 'medium'),
        red_flags: list(r.red_flags)
            .filter(f => f && typeof f === 'object')
            .map(f => ({
                severity: level(f.severity, 'medium'),
                clause_quote: str(f.clause_quote),
                plain_meaning: str(f.plain_meaning),
                why_it_matters: str(f.why_it_matters),
                quote_verified: f.quote_verified !== false
            }))
            .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.quote_verified === b.quote_verified ? 0 : a.quote_verified ? -1 : 1)),
        deadlines_and_money: list(r.deadlines_and_money)
            .filter(m => m && typeof m === 'object')
            .map(m => ({ item: str(m.item), detail: str(m.detail) })),
        questions_to_ask: list(r.questions_to_ask).map(str).filter(Boolean),
        authenticity: normalizeAuthenticity(r.authenticity),
        authenticity_error: str(r.authenticity_error),
        meta: {
            doc_label: str(meta.doc_label),
            filename: str(meta.filename),
            characters: Number(meta.characters) || 0,
            chunks: Number(meta.chunks) || 0,
            unverified_quotes: Number(meta.unverified_quotes) || 0
        }
    };
}

function renderDecoderReport(report) {
    const riskIcons = { high: 'fa-triangle-exclamation', medium: 'fa-circle-exclamation', low: 'fa-circle-check' };
    const risk = report.overall_risk;

    const flagsHtml = report.red_flags.length
        ? report.red_flags.map(f => `
            <div class="red-flag sev-${f.severity}">
                <div class="red-flag-head">
                    <span class="sev-pill sev-${f.severity}">${f.severity}</span>
                    ${f.quote_verified ? '' : `
                    <span class="quote-unverified" title="This exact wording was not found in your document. The AI may have paraphrased or misquoted it.">
                        <i class="fas fa-circle-question"></i> Quote not found word-for-word in your document. Double-check it.
                    </span>`}
                </div>
                ${f.clause_quote ? `<blockquote class="clause-quote"><mark>${escapeHtml(f.clause_quote)}</mark></blockquote>` : ''}
                ${f.plain_meaning ? `<p><strong>In plain words:</strong> ${escapeHtml(f.plain_meaning)}</p>` : ''}
                ${f.why_it_matters ? `<p><strong>Why it matters:</strong> ${escapeHtml(f.why_it_matters)}</p>` : ''}
            </div>`).join('')
        : '<p class="decoder-empty">No red flags found. That is a good sign, but still read the whole thing.</p>';

    const moneyHtml = report.deadlines_and_money.length
        ? `<ul class="money-list">${report.deadlines_and_money.map(m => `
            <li><strong>${escapeHtml(m.item)}</strong>${m.detail ? `<span>${escapeHtml(m.detail)}</span>` : ''}</li>`).join('')}
           </ul>`
        : '<p class="decoder-empty">No specific amounts or deadlines were found.</p>';

    const questionsHtml = report.questions_to_ask.length
        ? `<ol class="question-list">${report.questions_to_ask.map((q, i) => `
            <li>
                <span>${escapeHtml(q)}</span>
                <button class="question-copy-btn" type="button" data-question-index="${i}" title="Copy question">
                    <i class="fas fa-copy"></i>
                </button>
            </li>`).join('')}
           </ol>`
        : '<p class="decoder-empty">No follow-up questions suggested.</p>';

    const metaBits = [];
    if (report.meta.filename) metaBits.push(escapeHtml(report.meta.filename));
    if (report.meta.characters) metaBits.push(`${report.meta.characters.toLocaleString()} characters`);
    if (report.meta.chunks > 1) metaBits.push(`reviewed in ${report.meta.chunks} parts`);
    if (report.meta.unverified_quotes) metaBits.push(`${report.meta.unverified_quotes} quote(s) could not be verified`);

    const html = `
        <div class="decoder-report">
            <div class="decoder-report-header">
                <div class="decoder-report-title">
                    <i class="fas fa-file-shield"></i>
                    <span>${escapeHtml(window.BRAND_NAME || 'NibbleContract AI')} report${report.meta.doc_label ? ` · ${escapeHtml(report.meta.doc_label)}` : ''}</span>
                </div>
                <span class="risk-badge risk-${risk}" title="Risk from the contract terms"><i class="fas ${riskIcons[risk]}"></i> ${risk} ${report.authenticity ? 'contract ' : ''}risk</span>
            </div>

            ${renderAuthenticity(report)}

            <div class="decoder-card">
                <h4><i class="fas fa-lightbulb"></i> What this really asks of you</h4>
                <p>${escapeHtml(report.summary || 'No summary was produced.')}</p>
            </div>

            <div class="decoder-card">
                <h4><i class="fas fa-flag"></i> Red flags <span class="decoder-count">${report.red_flags.length}</span></h4>
                ${flagsHtml}
            </div>

            <div class="decoder-card">
                <h4><i class="fas fa-calendar-check"></i> Deadlines &amp; money</h4>
                ${moneyHtml}
            </div>

            <div class="decoder-card">
                <div class="decoder-card-head">
                    <h4><i class="fas fa-circle-question"></i> Questions to ask before you sign</h4>
                    ${report.questions_to_ask.length ? '<button class="msg-action-btn questions-copy-all" type="button"><i class="fas fa-copy"></i> Copy all</button>' : ''}
                </div>
                ${questionsHtml}
            </div>

            <div class="decoder-report-footer">
                <p class="decoder-disclaimer"><i class="fas fa-scale-balanced"></i> ${DECODER_DISCLAIMER}</p>
                ${metaBits.length ? `<span class="decoder-meta">${metaBits.join(' • ')}</span>` : ''}
            </div>
        </div>
    `;
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
}

function bindDecoderReportActions(row, report) {
    row.querySelectorAll('.question-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const question = report.questions_to_ask[Number(btn.dataset.questionIndex)];
            if (question) copyTextToClipboard(question, 'Question copied!');
        });
    });
    const copyChecklist = row.querySelector('.checklist-copy-all');
    if (copyChecklist && report.authenticity) {
        copyChecklist.addEventListener('click', () => {
            const text = report.authenticity.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n');
            copyTextToClipboard(text, 'Checklist copied!');
        });
    }
    const copyAll = row.querySelector('.questions-copy-all');
    if (copyAll) {
        copyAll.addEventListener('click', () => {
            const text = report.questions_to_ask.map((q, i) => `${i + 1}. ${q}`).join('\n');
            copyTextToClipboard(text, 'Questions copied!');
        });
    }
}

// Plain-text version used for copy, export, and chat search.
function reportToMarkdown(report) {
    const lines = [];
    lines.push(`## ${window.BRAND_NAME || 'NibbleContract AI'} report${report.meta.doc_label ? ` (${report.meta.doc_label})` : ''}`);
    const au = report.authenticity;
    if (au) {
        lines.push(`**Internship trust score:** ${au.score}/100 (${au.verdict_label})`, '');
        au.signals.forEach(s => {
            lines.push(`- ${s.polarity === 'positive' ? '[good]' : '[warning]'} ${s.label}${s.evidence ? `: "${s.evidence}"` : ''}${s.counted ? '' : ' _(not counted)_'}`);
            s.sources.forEach(src => lines.push(`  - Source: ${src.title} (${src.url})`));
        });
        if (au.checks.length) {
            lines.push('', '**Checked online:**');
            au.checks.forEach(c => lines.push(`- ${c.name} (${c.status})${c.detail ? `: ${c.detail}` : ''}`));
        }
        lines.push('', '**Verify it yourself:**');
        au.checklist.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
        lines.push('', `_${au.limits}_`, '');
    }
    lines.push(`**Overall risk:** ${report.overall_risk}`, '', report.summary, '');
    lines.push('### Red flags');
    if (!report.red_flags.length) lines.push('- None found');
    report.red_flags.forEach(f => {
        lines.push(`- **[${f.severity.toUpperCase()}]** "${f.clause_quote}"${f.quote_verified ? '' : ' _(quote not found verbatim)_'}`);
        if (f.plain_meaning) lines.push(`  - In plain words: ${f.plain_meaning}`);
        if (f.why_it_matters) lines.push(`  - Why it matters: ${f.why_it_matters}`);
    });
    lines.push('', '### Deadlines & money');
    if (!report.deadlines_and_money.length) lines.push('- None found');
    report.deadlines_and_money.forEach(m => lines.push(`- **${m.item}**${m.detail ? `: ${m.detail}` : ''}`));
    lines.push('', '### Questions to ask before you sign');
    report.questions_to_ask.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
    lines.push('', `_${DECODER_DISCLAIMER}_`);
    return lines.join('\n');
}


// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function escapeHtml(string) {
    const entityMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(string).replace(/[&<>"']/g, s => entityMap[s]);
}

function copyTextToClipboard(text, successMsg = 'Copied to clipboard!') {
    navigator.clipboard.writeText(text)
        .then(() => showToast(successMsg))
        .catch(() => showToast('Could not copy. Select the text and copy manually.'));
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    $('toastContainer').appendChild(toast);
    setTimeout(() => toast.remove(), 2800);
}
