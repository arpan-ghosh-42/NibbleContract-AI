/**
 * Fine-Print Decoder - standalone frontend
 * Paste or upload a contract, get a plain-language risk report.
 */

const STORAGE_KEYS = {
    REPORTS: 'fpd_reports_v1',
    THEME: 'fpd_theme_v1',
    DOC_TYPE: 'fpd_doc_type_v1'
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MIN_CHARS = 80;
const MAX_SAVED_REPORTS = 30;
const DECODER_DISCLAIMER = 'Not legal advice. Have someone you trust review anything important.';
const DOC_TYPE_LABELS = {
    rental: 'rental agreement',
    internship_offer: 'internship offer',
    scholarship: 'scholarship terms',
    loan: 'loan paperwork',
    other: 'contract'
};
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const State = { file: null, busy: false, reports: [] };

const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    loadReports();
    const saved = safeGet(STORAGE_KEYS.DOC_TYPE);
    if (saved && DOC_TYPE_LABELS[saved]) $('decoderDocType').value = saved;
    setupEvents();
    renderHistory();

    // Landing-page links open the tool with a ready-made example: /app?example=scam
    const wanted = new URLSearchParams(window.location.search).get('example');
    if (wanted && window.FPD_SAMPLES && window.FPD_SAMPLES[wanted]) loadExample(wanted);
});

// Fill the form with one of the fictional examples (see samples.js).
function loadExample(key) {
    const sample = window.FPD_SAMPLES && window.FPD_SAMPLES[key];
    if (!sample) return;
    setFile(null);
    $('decoderDocType').value = sample.doc_type;
    safeSet(STORAGE_KEYS.DOC_TYPE, sample.doc_type);
    syncDocTypeFields();
    $('senderEmail').value = sample.sender_email || '';
    $('companyName').value = sample.company_name || '';
    $('companyWebsite').value = sample.website || '';
    $('docText').value = sample.text;
    document.querySelectorAll('.example-chip').forEach(chip =>
        chip.classList.toggle('active', chip.dataset.example === key));
    $('docText').scrollTop = 0;
}

// While waiting for the server, cycle through what it is actually doing.
function startProgressMessages(docType) {
    const steps = docType === 'internship_offer'
        ? ['Reading the document...', 'Hunting for red flags...', 'Checking the domain and website...',
           'Searching the web for reports...', 'Scoring the offer...']
        : ['Reading the document...', 'Hunting for red flags...', 'Verifying every quote...', 'Writing your report...'];
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
    const theme = safeGet(STORAGE_KEYS.THEME) || 'dark';
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
    $('decoderDocType').addEventListener('change', e => {
        safeSet(STORAGE_KEYS.DOC_TYPE, e.target.value);
        syncDocTypeFields();
    });
    syncDocTypeFields();
    $('btnDecode').addEventListener('click', handleDecode);
    document.querySelectorAll('.example-chip').forEach(chip =>
        chip.addEventListener('click', () => loadExample(chip.dataset.example)));
    $('btnAttach').addEventListener('click', () => $('decoderFileInput').click());
    $('decoderFileInput').addEventListener('change', e => setFile(e.target.files[0] || null));
    $('decoderFileRemove').addEventListener('click', () => setFile(null));

    $('docText').addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleDecode();
        }
    });

    const zone = $('dropZone');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
    });
}

// The sender/company fields only apply to internship offers.
function syncDocTypeFields() {
    $('authFields').style.display = $('decoderDocType').value === 'internship_offer' ? 'flex' : 'none';
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
// Decode
// ---------------------------------------------------------------------------
async function handleDecode() {
    if (State.busy) return;
    const pasted = $('docText').value.trim();

    if (!State.file && !pasted) {
        showToast('Paste the document text or upload a PDF/.txt first.');
        return;
    }
    if (!State.file && pasted.length < MIN_CHARS) {
        showToast('That is too short to review. Paste the full document.');
        return;
    }
    if (State.file && pasted) showToast('Using the uploaded file (pasted text is ignored).');

    const docType = $('decoderDocType').value;
    const form = new FormData();
    form.append('doc_type', docType);
    if (State.file) form.append('file', State.file); else form.append('text', pasted);
    if (docType === 'internship_offer') {
        form.append('sender_email', $('senderEmail').value.trim());
        form.append('company_name', $('companyName').value.trim());
        form.append('website', $('companyWebsite').value.trim());
    }

    setBusy(true);
    $('reportArea').innerHTML = '';
    const progress = startProgressMessages(docType);
    $('statusArea').innerHTML = `
        <div class="panel loading"><div class="spinner"></div>
        <div><strong id="progressText">${escapeHtml(progress.first)}</strong>
        <div class="hint">Longer documents can take up to a minute.</div></div></div>`;

    try {
        const response = await fetch('/decode', { method: 'POST', body: form });
        let data;
        try {
            data = await response.json();
        } catch (e) {
            data = { error: `The server returned an unexpected response (${response.status}).` };
        }

        if (data.error || !data.result) {
            $('statusArea').innerHTML = `<div class="error-box"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(data.error || 'No report was returned.')}</div>`;
            return;
        }

        const report = normalizeReport(data.result);
        const entry = {
            id: 'rep_' + Date.now(),
            createdAt: new Date().toISOString(),
            docType: docType,
            title: report.meta.filename || `Pasted ${DOC_TYPE_LABELS[docType]}`,
            report: report
        };
        State.reports.unshift(entry);
        saveReports();
        renderHistory();
        $('statusArea').innerHTML = '';
        showReport(entry);
        $('docText').value = '';
        setFile(null);
    } catch (err) {
        $('statusArea').innerHTML = `<div class="error-box"><i class="fas fa-triangle-exclamation"></i> Could not reach the server. Is it running? (${escapeHtml(err.message)})</div>`;
    } finally {
        progress.stop();
        setBusy(false);
    }
}

function setBusy(busy) {
    State.busy = busy;
    const btn = $('btnDecode');
    btn.disabled = busy;
    btn.innerHTML = busy
        ? '<i class="fas fa-spinner fa-spin"></i> Decoding...'
        : '<i class="fas fa-magnifying-glass"></i> Decode';
}

function showReport(entry) {
    const area = $('reportArea');
    area.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'report-wrap';
    wrap.innerHTML = renderDecoderReport(normalizeReport(entry.report));
    const actions = document.createElement('div');
    actions.className = 'report-actions';
    actions.innerHTML = '<button class="msg-action-btn" type="button"><i class="fas fa-copy"></i> Copy report</button>';
    actions.firstChild.addEventListener('click', () =>
        copyTextToClipboard(reportToMarkdown(normalizeReport(entry.report)), 'Report copied!'));
    wrap.appendChild(actions);
    area.appendChild(wrap);
    bindDecoderReportActions(wrap, normalizeReport(entry.report));
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
        const rawRisk = entry.report && entry.report.overall_risk;
        const risk = SEVERITY_ORDER.hasOwnProperty(rawRisk) ? rawRisk : 'medium';
        const row = document.createElement('div');
        row.className = 'history-item';
        row.innerHTML = `
            <div class="history-main">
                <strong>${escapeHtml(entry.title)}</strong>
                <span class="sub">${escapeHtml(DOC_TYPE_LABELS[entry.docType] || 'contract')} · ${escapeHtml(new Date(entry.createdAt).toLocaleString())}</span>
            </div>
            <span class="risk-badge risk-${risk}">${risk}</span>
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
const VERDICT_CLASS = { likely_genuine: 'low', uncertain: 'medium', likely_scam: 'high' };

// Coerce the authenticity block into a safe, known shape (or null).
function normalizeAuthenticity(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const str = v => (typeof v === 'string' ? v : '');
    const list = v => (Array.isArray(v) ? v : []);
    const verdict = VERDICT_CLASS.hasOwnProperty(raw.verdict) ? raw.verdict : 'uncertain';
    const score = Math.max(0, Math.min(100, Math.round(Number(raw.score)) || 0));
    const weights = ['high', 'medium', 'low'];
    return {
        score: score,
        verdict: verdict,
        verdict_label: str(raw.verdict_label),
        confidence: ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'low',
        company: str(raw.company),
        limits: str(raw.limits),
        checklist: list(raw.checklist).map(str).filter(Boolean),
        checks: list(raw.checks)
            .filter(c => c && typeof c === 'object')
            .map(c => ({
                name: str(c.name),
                status: ['ok', 'warn', 'unavailable', 'skipped'].includes(c.status) ? c.status : 'unavailable',
                detail: str(c.detail)
            })),
        signals: list(raw.signals)
            .filter(s => s && typeof s === 'object')
            .map(s => ({
                id: str(s.id),
                polarity: s.polarity === 'positive' ? 'positive' : 'negative',
                weight: weights.includes(s.weight) ? s.weight : 'low',
                label: str(s.label),
                explanation: str(s.explanation),
                evidence: str(s.evidence),
                evidence_verified: s.evidence_verified !== false,
                counted: s.counted !== false,
                sources: list(s.sources)
                    .filter(src => src && typeof src === 'object' && /^https?:\/\//i.test(str(src.url)))
                    .slice(0, 5)
                    .map(src => ({ title: str(src.title) || str(src.url), url: str(src.url) }))
            }))
    };
}

function sourceHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function renderAuthenticity(report) {
    const au = report.authenticity;
    if (!au) {
        return report.authenticity_error
            ? `<div class="decoder-card"><p class="decoder-empty"><i class="fas fa-circle-info"></i> ${escapeHtml(report.authenticity_error)}</p></div>`
            : '';
    }
    const cls = VERDICT_CLASS[au.verdict];
    const verdictIcons = { low: 'fa-circle-check', medium: 'fa-circle-question', high: 'fa-triangle-exclamation' };

    const signalHtml = list => list.map(s => `
        <div class="auth-signal ${s.polarity}${s.counted ? '' : ' not-scored'}">
            <div class="auth-signal-head">
                <i class="fas ${s.polarity === 'positive' ? 'fa-circle-plus' : 'fa-circle-minus'}"></i>
                <strong>${escapeHtml(s.label)}</strong>
                <span class="sev-pill sev-${s.polarity === 'positive' ? 'low' : s.weight}">${s.polarity === 'positive' ? 'good sign' : s.weight + ' risk'}</span>
                ${s.counted ? '' : '<span class="quote-unverified" title="The quote could not be found in your document, so this did not change the score."><i class="fas fa-circle-question"></i> Not counted: evidence not found in your document</span>'}
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

    const checkIcons = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', unavailable: 'fa-circle-question', skipped: 'fa-circle-minus' };
    const checksHtml = au.checks.length ? `
        <div class="auth-group">
            <div class="auth-group-title">What we checked online</div>
            <ul class="auth-checks">${au.checks.map(c => `
                <li class="check-${c.status}">
                    <i class="fas ${checkIcons[c.status]}"></i>
                    <span><strong>${escapeHtml(c.name)}</strong>${c.detail ? ` · ${escapeHtml(c.detail)}` : ''}</span>
                </li>`).join('')}
            </ul>
        </div>` : '';

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
