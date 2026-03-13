import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI RunpodDirect Extension
// Version: 1.0.7 - Updated for ComfyUI v0.17.0+ (frontend v1.42+)
console.log('[RunpodDirect] v1.0.7');

// Track download states
const downloadStates = new Map();
let downloadQueue = [];
let isDownloadingAll = false;
let completedDownloads = 0;
let totalDownloads = 0;
let downloadStartTimes = new Map();

// Session-only HF token (never persisted to disk)
let sessionHfToken = null;
let envHasHfToken = false;

// Badge label -> folder_paths directory name mapping
const BADGE_TO_DIRECTORY = {
    'VAE': 'vae',
    'DIFFUSION': 'diffusion_models',
    'TEXT ENCODER': 'text_encoders',
    'LORA': 'loras',
    'CHECKPOINT': 'checkpoints',
    'CLIP': 'clip',
    'CLIP_VISION': 'clip_vision',
    'CONTROLNET': 'controlnet',
    'UPSCALE_MODELS': 'upscale_models',
    'LATENT_UPSCALE_MODELS': 'latent_upscale_models',
    'EMBEDDINGS': 'embeddings',
    'HYPERNETWORKS': 'hypernetworks',
    'STYLE_MODELS': 'style_models',
    'GLIGEN': 'gligen',
    'UNET': 'unet',
};

const THEME = {
    // Status colors
    primary:     'var(--primary-background)',
    primaryHover:'var(--primary-background-hover)',
    success:     'var(--success-background)',
    error:       'var(--destructive-background)',
    warning:     'var(--warning-background)',
    // Text
    foreground:  'var(--base-foreground)',
    muted:       'var(--muted-foreground)',
    // Backgrounds
    baseBg:      'var(--base-background)',
    secondaryBg: 'var(--secondary-background)',
    secondaryBgHover: 'var(--secondary-background-hover)',
    // Borders
    border:      'var(--border-default)',
    borderSubtle:'var(--border-subtle)',
};

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function calculateSpeed(downloadId, downloaded) {
    const startTime = downloadStartTimes.get(downloadId);
    if (!startTime) return '0 MB/s';
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    if (elapsedSeconds < 1) return 'Calculating...';
    const bytesPerSecond = downloaded / elapsedSeconds;
    return formatBytes(bytesPerSecond) + '/s';
}

function statusColor(status) {
    if (status === 'downloading') return THEME.primary;
    if (status === 'completed') return THEME.success;
    if (status === 'error') return THEME.error;
    if (status === 'paused' || status === 'queued') return THEME.warning;
    return THEME.primary;
}

// --- WebSocket event listeners ---

api.addEventListener("server_download_progress", ({ detail }) => {
    const { download_id, progress, downloaded, total } = detail;
    if (!downloadStartTimes.has(download_id)) {
        downloadStartTimes.set(download_id, Date.now());
    }
    const speed = calculateSpeed(download_id, downloaded);
    downloadStates.set(download_id, { status: 'downloading', progress, downloaded, total, speed });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
});

api.addEventListener("server_download_complete", ({ detail }) => {
    const { download_id, path, size } = detail;
    if (isDownloadingAll) {
        completedDownloads++;
        console.log(`[RunpodDirect] Progress: ${completedDownloads}/${totalDownloads} completed`);
    }
    downloadStates.set(download_id, { status: 'completed', progress: 100, path, size });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
    console.log(`Download completed: ${download_id} -> ${path}`);
    if (isDownloadingAll && completedDownloads >= totalDownloads) {
        console.log('[RunpodDirect] All downloads completed!');
        isDownloadingAll = false;
        window.dispatchEvent(new CustomEvent('serverDownloadAllDone'));
    }
});

api.addEventListener("server_download_error", ({ detail }) => {
    const { download_id, error } = detail;
    if (isDownloadingAll) {
        completedDownloads++;
        console.log(`[RunpodDirect] Progress: ${completedDownloads}/${totalDownloads} completed (1 error)`);
    }
    downloadStates.set(download_id, { status: 'error', error });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
    console.error(`Download error: ${download_id} - ${error}`);
    if (isDownloadingAll && completedDownloads >= totalDownloads) {
        console.log('[RunpodDirect] All downloads completed!');
        isDownloadingAll = false;
        window.dispatchEvent(new CustomEvent('serverDownloadAllDone'));
    }
});

// --- API functions ---

async function startServerDownload(url, savePath, filename, markAsQueued = false) {
    try {
        const download_id = `${savePath}/${filename}`;
        if (markAsQueued) {
            downloadStates.set(download_id, { status: 'queued', progress: 0 });
            window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
                detail: { download_id, ...downloadStates.get(download_id) }
            }));
        }
        const body = { url, save_path: savePath, filename };
        // Pass token for HF downloads (skip if using env var — backend reads it directly)
        if (sessionHfToken && sessionHfToken !== '__env__' && url.includes('huggingface.co')) {
            body.token = sessionHfToken;
        }
        const response = await api.fetchApi("/server_download/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        const result = await response.json();
        if (response.ok) {
            if (!markAsQueued) {
                downloadStates.set(download_id, { status: 'queued', progress: 0 });
                window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
                    detail: { download_id, ...downloadStates.get(download_id) }
                }));
            }
            return { success: true, download_id };
        } else {
            return { success: false, error: result.error };
        }
    } catch (error) {
        console.error("Failed to start download:", error);
        return { success: false, error: error.message };
    }
}

function getDownloadStatus(downloadId) {
    return downloadStates.get(downloadId) || null;
}

async function pauseDownload(downloadId) {
    try {
        const response = await api.fetchApi("/server_download/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ download_id: downloadId })
        });
        const result = await response.json();
        return { success: response.ok, ...result };
    } catch (error) {
        console.error("Failed to pause download:", error);
        return { success: false, error: error.message };
    }
}

async function resumeDownload(downloadId) {
    try {
        const response = await api.fetchApi("/server_download/resume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ download_id: downloadId })
        });
        const result = await response.json();
        return { success: response.ok, ...result };
    } catch (error) {
        console.error("Failed to resume download:", error);
        return { success: false, error: error.message };
    }
}

async function cancelDownload(downloadId) {
    try {
        const response = await api.fetchApi("/server_download/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ download_id: downloadId })
        });
        const result = await response.json();
        return { success: response.ok, ...result };
    } catch (error) {
        console.error("Failed to cancel download:", error);
        return { success: false, error: error.message };
    }
}

async function processDownloadQueue() {
    if (downloadQueue.length === 0) {
        console.log('[RunpodDirect] No downloads in queue');
        return;
    }
    console.log(`[RunpodDirect] Starting ${downloadQueue.length} downloads`);
    const downloadsToStart = [...downloadQueue];
    downloadQueue = [];
    for (const download of downloadsToStart) {
        console.log(`[RunpodDirect] Queuing download ${download.filename}`);
        await startServerDownload(download.url, download.directory, download.filename, true);
    }
    console.log(`[RunpodDirect] All ${downloadsToStart.length} downloads queued on backend`);
}

// --- DOM helpers (safe, no innerHTML) ---

function createEl(tag, styles, textContent) {
    const el = document.createElement(tag);
    if (styles) Object.assign(el.style, styles);
    if (textContent) el.textContent = textContent;
    return el;
}

function extractModelsFromPinia() {
    // Find the Vue app root element (mounted on #vue-app)
    const rootEl = document.getElementById('vue-app')
        || document.querySelector('[data-v-app]')
        || document.getElementById('app');
    if (!rootEl) {
        console.log('[RunpodDirect] No Vue root element found');
        return null;
    }

    const vueApp = rootEl.__vue_app__;
    if (!vueApp) {
        console.log('[RunpodDirect] No __vue_app__ on root element');
        return null;
    }

    // Access Pinia through Vue app's global properties
    const pinia = vueApp.config.globalProperties.$pinia;
    if (!pinia || !pinia._s) {
        console.log('[RunpodDirect] No Pinia store registry found');
        return null;
    }

    // Get the dialog store (registered as 'dialog')
    const dialogStore = pinia._s.get('dialog');
    if (!dialogStore) {
        console.log('[RunpodDirect] Dialog store not found in Pinia');
        return null;
    }

    // Find the missing models dialog in the stack
    const stack = dialogStore.dialogStack;
    if (!stack || !Array.isArray(stack)) {
        console.log('[RunpodDirect] dialogStack not found or not an array');
        return null;
    }

    const dialog = stack.find(d => d.key === 'global-missing-models-warning');
    if (!dialog) {
        console.log('[RunpodDirect] Missing models dialog not found in stack');
        return null;
    }

    const missingModels = dialog.contentProps?.missingModels;
    if (!missingModels || !Array.isArray(missingModels)) {
        console.log('[RunpodDirect] No missingModels in dialog contentProps');
        return null;
    }

    console.log(`[RunpodDirect] Found ${missingModels.length} models from Pinia dialog store`);
    return missingModels.map(m => ({
        filename: m.name,
        url: m.url,
        directory: m.directory,
    }));
}

// Fallback: extract model info from DOM when Vue internals aren't accessible
function extractModelsFromDOM(container) {
    const rows = getModelRows(container);
    const models = [];
    rows.forEach((row) => {
        const leftSide = row.querySelector('[class*="overflow-hidden"]');
        if (!leftSide) return;

        const nameSpan = leftSide.querySelector('span[title]');
        if (!nameSpan) return;
        const filename = nameSpan.getAttribute('title') || nameSpan.textContent.trim();

        const badgeSpan = leftSide.querySelector('span[class*="rounded-full"]');
        let directory = null;
        if (badgeSpan) {
            const badgeText = badgeSpan.textContent.trim().toUpperCase();
            directory = BADGE_TO_DIRECTORY[badgeText] || badgeText.toLowerCase();
        }

        // Try button title or anchor href for URL
        const rightSide = row.querySelector('[class*="shrink-0"]');
        let url = null;
        if (rightSide) {
            const urlButton = rightSide.querySelector('button[title]');
            if (urlButton) url = urlButton.getAttribute('title');
            if (!url) {
                const urlAnchor = rightSide.querySelector('a[href]');
                if (urlAnchor) url = urlAnchor.getAttribute('href');
            }
        }

        if (filename && directory && url) {
            models.push({ filename, directory, url });
        }
    });
    return models.length > 0 ? models : null;
}


function extractModelsFromFooter() {
    return null;
}

// Check if HF_TOKEN env var is set on the backend
async function checkEnvHfToken() {
    try {
        const response = await api.fetchApi("/server_download/hf_token_status");
        if (response.ok) {
            const data = await response.json();
            envHasHfToken = data.has_token;
        }
    } catch (e) {
        // Ignore - endpoint may not exist on older backend
    }
}

// Detect gated models from the DOM (rows with "Accept terms" links)
function detectGatedModels(container) {
    const gated = [];
    const rows = getModelRows(container);
    for (const row of rows) {
        const link = row.querySelector('a[target="_blank"]');
        if (link && link.textContent.toLowerCase().includes('accept')) {
            const leftSide = row.querySelector('[class*="overflow-hidden"]');
            if (!leftSide) continue;
            const nameSpan = leftSide.querySelector('span[title]');
            if (!nameSpan) continue;
            const filename = nameSpan.getAttribute('title') || nameSpan.textContent.trim();
            const badgeSpan = leftSide.querySelector('span[class*="rounded-full"]');
            let directory = null;
            if (badgeSpan) {
                const badgeText = badgeSpan.textContent.trim().toUpperCase();
                directory = BADGE_TO_DIRECTORY[badgeText] || badgeText.toLowerCase();
            }
            gated.push({ filename, directory, repoUrl: link.href });
            // Remove the native "Accept terms" link — our token section handles it
            link.remove();
        }
    }
    return gated;
}

// Validate HF token against backend and check access to specific URLs
async function validateHfToken(token, urls) {
    try {
        const response = await api.fetchApi("/server_download/validate_hf_token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, urls })
        });
        if (response.ok) return await response.json();
        return { valid: false, error: 'Validation request failed' };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

// Token section for gated models.
// Sits below the model list. Controls whether the download button gets enabled.
//
// States:
//   1. Initial: show input + Verify btn. Download btn disabled.
//   2. Token invalid: show error. Download btn disabled.
//   3. Token valid, ALL gated accessible: green success. Download btn enabled for all.
//   4. Token valid, SOME need terms: show which models need terms (with links). Download btn disabled.
//      User can click Accept terms → go to HF → come back → click Verify again.
function createTokenSection(dialog, gatedModels, gatedWithUrls, callbacks) {
    if (document.querySelector('.server-download-token-section')) return;

    const modelList = dialog.querySelector('[class*="scrollbar-custom"][class*="overflow-y-auto"][class*="rounded-lg"]');
    if (!modelList) return;

    const section = createEl('div', {
        borderRadius: '0.5rem',
        backgroundColor: THEME.secondaryBg,
        overflow: 'hidden',
    });
    section.className = 'server-download-token-section';

    // Header
    const header = createEl('div', {
        padding: '8px 12px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
    });
    const headerTitle = createEl('span', {
        fontSize: '0.75rem',
        fontWeight: '600',
        color: THEME.foreground,
    }, 'HF Token Required');
    const headerStatus = createEl('span', {
        fontSize: '0.6875rem',
        color: THEME.muted,
    }, `${gatedModels.length} gated model${gatedModels.length > 1 ? 's' : ''}`);
    header.appendChild(headerTitle);
    header.appendChild(headerStatus);
    section.appendChild(header);

    // Body area — holds input, status messages, terms list
    const body = createEl('div', {
        padding: '0 12px 10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    });
    section.appendChild(body);

    // Status/message area
    const statusEl = createEl('div', {
        fontSize: '0.6875rem',
        color: THEME.muted,
        lineHeight: '1.4',
    });

    // Terms list container (shown when some models need terms)
    const termsListEl = createEl('div', {
        display: 'none',
        flexDirection: 'column',
        gap: '4px',
    });

    function showTermsList(deniedModels) {
        while (termsListEl.firstChild) termsListEl.removeChild(termsListEl.firstChild);
        termsListEl.style.display = 'flex';
        for (const m of deniedModels) {
            const row = createEl('div', {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '4px 0',
            });
            const name = createEl('span', {
                fontSize: '0.75rem',
                color: THEME.foreground,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: '0',
            }, m.filename);
            const btn = createEl('button', {
                backgroundColor: THEME.secondaryBgHover,
                color: THEME.foreground,
                border: 'none',
                height: '22px',
                padding: '0 8px',
                fontSize: '0.6875rem',
                fontWeight: '500',
                borderRadius: '0.375rem',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: '0',
                marginLeft: '8px',
            }, 'Accept terms');
            btn.type = 'button';
            btn.onclick = () => window.open(m.repoUrl, '_blank', 'noopener,noreferrer');
            row.appendChild(name);
            row.appendChild(btn);
            termsListEl.appendChild(row);
        }
    }

    function hideTermsList() {
        termsListEl.style.display = 'none';
    }

    // Input row builder
    function buildInputRow() {
        const row = createEl('div', {
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
        });

        const input = document.createElement('input');
        input.type = 'password';
        input.placeholder = 'hf_...';
        input.autocomplete = 'off';
        input.spellcheck = false;
        Object.assign(input.style, {
            flex: '1',
            height: '28px',
            padding: '0 8px',
            fontSize: '0.75rem',
            borderRadius: '0.375rem',
            border: `1px solid ${THEME.border}`,
            backgroundColor: THEME.baseBg,
            color: THEME.foreground,
            outline: 'none',
            fontFamily: 'monospace',
            minWidth: '0',
        });
        input.onfocus = () => { input.style.borderColor = THEME.primary; };
        input.onblur = () => { input.style.borderColor = THEME.border; };

        const verifyBtn = createEl('button', {
            backgroundColor: THEME.primary,
            color: THEME.foreground,
            border: 'none',
            height: '28px',
            padding: '0 10px',
            fontSize: '0.75rem',
            fontWeight: '500',
            borderRadius: '0.375rem',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: '0',
        }, 'Verify');
        verifyBtn.type = 'button';

        verifyBtn.onclick = () => doVerify(input, verifyBtn);
        input.onkeydown = (e) => { if (e.key === 'Enter') doVerify(input, verifyBtn); };

        row.appendChild(input);
        row.appendChild(verifyBtn);
        return row;
    }

    async function doVerify(input, verifyBtn) {
        const val = input.value.trim();
        if (!val || !val.startsWith('hf_')) {
            statusEl.textContent = 'Token must start with hf_';
            statusEl.style.color = THEME.error;
            return;
        }

        verifyBtn.disabled = true;
        verifyBtn.textContent = 'Verifying...';
        verifyBtn.style.opacity = '0.5';
        statusEl.textContent = '';
        hideTermsList();

        const result = await validateHfToken(val, gatedWithUrls.map(m => m.url));

        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify';
        verifyBtn.style.opacity = '1';

        if (!result.valid) {
            statusEl.textContent = result.error || 'Invalid token';
            statusEl.style.color = THEME.error;
            callbacks.onFail();
            return;
        }

        // Token valid — check per-model access
        sessionHfToken = val;
        const accessible = [];
        const denied = [];
        for (const m of gatedWithUrls) {
            const access = result.url_access?.[m.url];
            if (access?.accessible) {
                accessible.push(m);
            } else {
                denied.push({ ...m, repoUrl: access?.repo_url || m.url });
            }
        }

        if (denied.length === 0) {
            // All good — green
            headerStatus.textContent = 'all accessible';
            headerStatus.style.color = THEME.success;
            statusEl.textContent = `Verified as ${result.username}`;
            statusEl.style.color = THEME.success;
            input.disabled = true;
            input.style.opacity = '0.5';
            verifyBtn.textContent = 'OK';
            verifyBtn.disabled = true;
            verifyBtn.style.backgroundColor = THEME.success;
            verifyBtn.style.opacity = '0.7';
            callbacks.onAllAccessible(gatedWithUrls);
        } else {
            // Some need terms
            statusEl.textContent = `Verified as ${result.username} — ${denied.length} model${denied.length > 1 ? 's' : ''} need terms accepted:`;
            statusEl.style.color = THEME.warning;
            showTermsList(denied);
            // Keep input active so user can re-verify after accepting terms
            callbacks.onPartialAccess(accessible, denied);
        }
    }

    // Auto-validate env token
    async function autoValidateEnv() {
        statusEl.textContent = 'HF_TOKEN found in environment. Validating...';
        statusEl.style.color = THEME.muted;
        sessionHfToken = '__env__';

        const result = await validateHfToken('__env__', gatedWithUrls.map(m => m.url));

        if (!result.valid) {
            statusEl.textContent = 'Environment HF_TOKEN is invalid.';
            statusEl.style.color = THEME.error;
            sessionHfToken = null;
            // Show manual input as fallback
            body.insertBefore(buildInputRow(), statusEl);
            callbacks.onFail();
            return;
        }

        const accessible = [];
        const denied = [];
        for (const m of gatedWithUrls) {
            const access = result.url_access?.[m.url];
            if (access?.accessible) {
                accessible.push(m);
            } else {
                denied.push({ ...m, repoUrl: access?.repo_url || m.url });
            }
        }

        if (denied.length === 0) {
            headerStatus.textContent = 'all accessible';
            headerStatus.style.color = THEME.success;
            statusEl.textContent = `Verified as ${result.username}`;
            statusEl.style.color = THEME.success;
            callbacks.onAllAccessible(gatedWithUrls);
        } else {
            statusEl.textContent = `Verified as ${result.username} — ${denied.length} model${denied.length > 1 ? 's' : ''} need terms accepted:`;
            statusEl.style.color = THEME.warning;
            showTermsList(denied);
            callbacks.onPartialAccess(accessible, denied);
        }
    }

    // Build the body
    if (envHasHfToken) {
        body.appendChild(statusEl);
        body.appendChild(termsListEl);
    } else {
        body.appendChild(buildInputRow());
        body.appendChild(statusEl);
        body.appendChild(termsListEl);
    }

    // Insert after model list
    modelList.parentElement.insertBefore(section, modelList.nextSibling);

    // Auto-validate if env token exists
    if (envHasHfToken) {
        autoValidateEnv();
    }

    return section;
}

function findMissingModelsContainer() {
    const containers = document.querySelectorAll('[class*="scrollbar-custom"][class*="overflow-y-auto"][class*="rounded-lg"]');
    for (const container of containers) {
        const rows = container.querySelectorAll(':scope > div');
        if (rows.length > 0) {
            for (const row of rows) {
                if (row.querySelector('span[class*="rounded-full"]')) {
                    return container;
                }
            }
        }
    }

    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const dialog of dialogs) {
        const text = dialog.textContent || '';
        if (text.includes('missing models') || text.includes('Missing models')) {
            const scrollable = dialog.querySelector('[class*="overflow-y-auto"]');
            if (scrollable) return scrollable;
        }
    }
    return null;
}

function getModelRows(container) {
    const allRows = container.querySelectorAll(':scope > div');
    return Array.from(allRows).filter(row => !row.classList.contains('sticky'));
}

// --- UI injection (theme-aware, matches ComfyUI design system) ---

function createProgressArea(container) {
    const existing = document.querySelector('.server-download-progress-area');
    if (existing) existing.remove();

    // Match the model list container style: rounded-lg bg-secondary-background
    const area = createEl('div', {
        borderRadius: '0.5rem',
        backgroundColor: THEME.secondaryBg,
        overflow: 'hidden',
    });
    area.className = 'server-download-progress-area';

    // Header row matching the sticky bottom row style from the model list
    const header = createEl('div', {
        padding: '8px 12px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: `1px solid ${THEME.border}`,
    });
    const headerTitle = createEl('span', {
        fontSize: '0.75rem',
        fontWeight: '600',
        color: THEME.foreground,
    }, 'Download Progress');
    const headerStatus = createEl('span', {
        fontSize: '0.75rem',
        color: THEME.muted,
    }, `0/${totalDownloads} completed`);
    headerStatus.id = 'server-download-overall-progress';
    header.appendChild(headerTitle);
    header.appendChild(headerStatus);
    area.appendChild(header);

    const itemsContainer = createEl('div', {
        display: 'flex',
        flexDirection: 'column',
    });
    itemsContainer.id = 'server-download-items-container';
    area.appendChild(itemsContainer);

    // Insert after the model list container (inside the same parent flex column)
    container.parentElement.insertBefore(area, container.nextSibling);

    window.addEventListener('serverDownloadUpdate', (event) => {
        const { download_id, status, progress, downloaded, total, speed } = event.detail;
        if (!isDownloadingAll) return;

        const overallEl = document.getElementById('server-download-overall-progress');
        if (overallEl) {
            overallEl.textContent = `${completedDownloads}/${totalDownloads} completed`;
        }
        updateDownloadProgressItem(download_id, status, progress, downloaded, total, speed);
    });
}

function updateDownloadProgressItem(download_id, status, progress, downloaded, total, speed) {
    const itemId = `download-item-${download_id.replace(/\//g, '-')}`;
    const container = document.getElementById('server-download-items-container');
    if (!container) return;

    let item = document.getElementById(itemId);

    if (status === 'queued') {
        if (item) item.remove();
        return;
    }

    if ((status === 'completed' || status === 'error') && item && !item.dataset.removing) {
        item.dataset.removing = 'true';
        setTimeout(() => { try { if (item && item.parentNode) item.remove(); } catch (e) { /* */ } }, 2000);
    }

    if (!item) {
        // Match model list row style: px-3 py-2 with no extra bg/border
        item = createEl('div', { padding: '8px 12px' });
        item.id = itemId;
        container.appendChild(item);
    }

    const progressPercent = progress || 0;
    const speedText = speed || '--';
    const sizeText = downloaded && total ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : '--';

    while (item.firstChild) item.removeChild(item.firstChild);

    // Row 1: filename + percentage (matches model row: name left, info right)
    const nameRow = createEl('div', {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px',
    });
    const filename = download_id.split('/').pop() || download_id;
    const nameEl = createEl('span', {
        fontSize: '0.875rem', color: THEME.foreground, fontWeight: '400',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0',
    }, filename);
    const pctEl = createEl('span', {
        fontSize: '0.75rem', color: THEME.muted, flexShrink: '0', paddingLeft: '8px',
    }, progressPercent.toFixed(1) + '%');
    nameRow.appendChild(nameEl);
    nameRow.appendChild(pctEl);
    item.appendChild(nameRow);

    // Row 2: progress bar
    const barOuter = createEl('div', {
        width: '100%', height: '4px',
        backgroundColor: THEME.secondaryBgHover,
        borderRadius: '9999px', overflow: 'hidden', marginBottom: '4px',
    });
    const color = statusColor(status);
    const barInner = createEl('div', {
        height: '100%', backgroundColor: color,
        borderRadius: '9999px',
        width: progressPercent + '%', transition: 'width 0.3s',
    });
    barOuter.appendChild(barInner);
    item.appendChild(barOuter);

    // Row 3: speed + size
    const infoRow = createEl('div', {
        display: 'flex', justifyContent: 'space-between',
        fontSize: '0.6875rem', color: THEME.muted,
    });
    infoRow.appendChild(createEl('span', {}, speedText));
    infoRow.appendChild(createEl('span', {}, sizeText));
    item.appendChild(infoRow);
}

// Export functions
window.serverDownload = {
    start: startServerDownload,
    getStatus: getDownloadStatus,
    states: downloadStates
};

// --- Main injection logic ---

function injectServerDownloadButtons() {
    console.log('[RunpodDirect] injectServerDownloadButtons called');

    const container = findMissingModelsContainer();
    if (!container) {
        console.log('[RunpodDirect] Missing models container not found');
        return;
    }

    console.log('[RunpodDirect] Found missing models container');

    if (document.querySelector('.server-download-all-btn')) {
        console.log('[RunpodDirect] Buttons already injected');
        return;
    }

    // Extract model data: try Pinia store first (most reliable - URLs aren't in DOM),
    // then fall back to DOM parsing
    let models = null;

    // Strategy 1: Pinia dialog store (most reliable - works in production builds)
    const piniaModels = extractModelsFromPinia();
    if (piniaModels && piniaModels.length > 0) {
        models = piniaModels;
    }

    // Strategy 2: DOM parsing (fallback - works when buttons with URLs are visible)
    if (!models) {
        const domModels = extractModelsFromDOM(container);
        if (domModels && domModels.length > 0) {
            models = domModels;
            console.log(`[RunpodDirect] Got ${models.length} models from DOM parsing`);
        }
    }

    // Strategy 3: Footer component fallback
    if (!models) {
        const footerData = extractModelsFromFooter();
        if (footerData && footerData.models?.length > 0) {
            models = footerData.models;
            console.log(`[RunpodDirect] Got ${models.length} models from footer component`);
        }
    }

    if (!models || models.length === 0) {
        console.log('[RunpodDirect] No models could be extracted, will retry...');
        // Retry after a short delay - Pinia store may not be populated yet
        if (!container.dataset.retryCount || parseInt(container.dataset.retryCount) < 5) {
            container.dataset.retryCount = (parseInt(container.dataset.retryCount || '0') + 1).toString();
            setTimeout(() => injectServerDownloadButtons(), 500);
        } else {
            console.log('[RunpodDirect] Max retries reached, giving up');
        }
        return;
    }

    // Separate downloadable models from gated ones
    const gatedModels = detectGatedModels(container);
    const gatedFilenames = new Set(gatedModels.map(g => g.filename));

    // Models from Pinia include ALL models (including gated ones).
    const downloadableModels = models.filter(m => !gatedFilenames.has(m.filename));
    const gatedWithUrls = models.filter(m => gatedFilenames.has(m.filename));

    downloadableModels.forEach((m, i) => {
        console.log(`[RunpodDirect] Model ${i + 1}: ${m.directory}/${m.filename} -> ${m.url}`);
    });
    if (gatedWithUrls.length > 0) {
        console.log(`[RunpodDirect] ${gatedWithUrls.length} gated model(s) detected`);
    }

    // Mutable list — starts with only non-gated, grows when token is validated
    let allModelsToDownload = [...downloadableModels];
    // Track whether gated models block the download button
    const hasGated = gatedModels.length > 0;
    let gatedVerified = false;

    const dialog = container.closest('[role="dialog"]');
    const footerBtnRow = dialog?.querySelector('div[class*="justify-end"][class*="gap"]');

    // Show gated models section if needed
    if (hasGated && dialog) {
        createTokenSection(dialog, gatedModels, gatedWithUrls, {
            onAllAccessible(accessibleModels) {
                // All gated models verified — enable download for everything
                gatedVerified = true;
                allModelsToDownload = [...downloadableModels, ...accessibleModels];
                updateBtnCount();
                console.log(`[RunpodDirect] All gated models accessible, ${allModelsToDownload.length} total`);
            },
            onPartialAccess(_accessible, denied) {
                // Some models need terms — keep button disabled
                gatedVerified = false;
                allModelsToDownload = [...downloadableModels];
                updateBtnCount();
                console.log(`[RunpodDirect] ${denied.length} model(s) need terms accepted`);
            },
            onFail() {
                // Invalid token — keep button disabled
                gatedVerified = false;
                allModelsToDownload = [...downloadableModels];
                updateBtnCount();
                console.log('[RunpodDirect] Token validation failed');
            },
        });
    }

    // Match ComfyUI's primary button: bg-primary-background text-base-foreground h-8 rounded-lg text-xs
    const downloadAllBtn = createEl('button', {
        backgroundColor: THEME.primary,
        color: THEME.foreground,
        border: 'none',
        height: '32px',
        padding: '0 8px',
        fontSize: '0.75rem',
        fontWeight: '500',
        borderRadius: '0.5rem',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        whiteSpace: 'nowrap',
        transition: 'background-color 0.15s',
    });
    downloadAllBtn.className = 'server-download-all-btn';
    downloadAllBtn.type = 'button';
    downloadAllBtn.title = 'Download all models directly to this RunPod instance (server-side)';

    function updateBtnCount() {
        const count = allModelsToDownload.length;
        downloadAllBtn.textContent = `Download to Pod (${count})`;
        // Disable when: no models OR gated models exist but token not verified
        const shouldDisable = count === 0 || (hasGated && !gatedVerified);
        if (shouldDisable) {
            downloadAllBtn.disabled = true;
            downloadAllBtn.style.opacity = '0.5';
            downloadAllBtn.style.cursor = 'default';
        } else {
            downloadAllBtn.disabled = false;
            downloadAllBtn.style.opacity = '1';
            downloadAllBtn.style.cursor = 'pointer';
        }
    }
    updateBtnCount();

    downloadAllBtn.onmouseenter = () => { if (!downloadAllBtn.disabled) downloadAllBtn.style.backgroundColor = THEME.primaryHover; };
    downloadAllBtn.onmouseleave = () => { if (!downloadAllBtn.disabled) downloadAllBtn.style.backgroundColor = THEME.primary; };

    function setButtonRefresh() {
        downloadAllBtn.disabled = false;
        downloadAllBtn.style.opacity = '1';
        downloadAllBtn.style.pointerEvents = 'auto';
        downloadAllBtn.style.backgroundColor = THEME.success;
        downloadAllBtn.style.color = THEME.foreground;
        downloadAllBtn.textContent = 'Refresh Page';
        downloadAllBtn.onmouseenter = null;
        downloadAllBtn.onmouseleave = null;
        downloadAllBtn.onclick = () => location.reload();
    }

    downloadAllBtn.onclick = async (e) => {
        e.stopPropagation();
        downloadAllBtn.disabled = true;
        downloadAllBtn.style.opacity = '0.5';
        downloadAllBtn.style.cursor = 'default';
        downloadAllBtn.textContent = 'Downloading...';

        downloadQueue = allModelsToDownload.map(m => ({ url: m.url, directory: m.directory, filename: m.filename }));
        totalDownloads = allModelsToDownload.length;
        completedDownloads = 0;
        isDownloadingAll = true;

        createProgressArea(container);

        if (downloadQueue.length > 0) {
            processDownloadQueue();
        }
    };

    // Listen for all downloads completing to show refresh button and remove progress area
    window.addEventListener('serverDownloadAllDone', () => {
        setButtonRefresh();
        const progressArea = document.querySelector('.server-download-progress-area');
        if (progressArea) progressArea.remove();
    });

    if (footerBtnRow) {
        // Insert before the native "Download all" button
        footerBtnRow.insertBefore(downloadAllBtn, footerBtnRow.firstChild);
    } else {
        // Fallback: place above the model list
        const fallbackContainer = createEl('div', {
            padding: '0 16px 8px 16px',
            display: 'flex',
            justifyContent: 'center',
        });
        fallbackContainer.appendChild(downloadAllBtn);
        container.parentElement.insertBefore(fallbackContainer, container);
    }

    console.log('[RunpodDirect] Button injection complete');
}

// MutationObserver for detecting the missing models dialog
function setupDialogObserver() {
    console.log('[RunpodDirect] Setting up dialog observer');

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return;

                    const isDialog = node.getAttribute?.('role') === 'dialog' ||
                        node.querySelector?.('[role="dialog"]');

                    if (isDialog) {
                        setTimeout(() => {
                            const dialog = node.getAttribute?.('role') === 'dialog'
                                ? node
                                : node.querySelector('[role="dialog"]');
                            if (dialog) {
                                const text = dialog.textContent || '';
                                if (text.includes('missing models') || text.includes('Missing models')) {
                                    console.log('[RunpodDirect] Detected missing models dialog');
                                    setTimeout(() => injectServerDownloadButtons(), 500);
                                }
                            }
                        }, 300);
                    }
                });
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[RunpodDirect] Observer active');
}

// Register extension
app.registerExtension({
    name: "ComfyUI.RunpodDirect",

    async setup() {
        console.log("[RunpodDirect] Extension setup starting");
        checkEnvHfToken();
        setupDialogObserver();

        setTimeout(() => {
            console.log('[RunpodDirect] Checking for existing dialog...');
            injectServerDownloadButtons();
        }, 1000);

        setTimeout(() => {
            console.log('[RunpodDirect] Second check for dialog...');
            injectServerDownloadButtons();
        }, 3000);

        console.log("[RunpodDirect] Extension setup complete");
    }
});
