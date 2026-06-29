import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function getLocalFlag(key, defaultValue = false) {
    try {
        const raw = window?.localStorage?.getItem(key);
        if (raw == null) return defaultValue;
        return raw === '1' || raw === 'true';
    } catch (_e) {
        return defaultValue;
    }
}

function setLocalFlag(key, enabled) {
    try {
        if (enabled) {
            window?.localStorage?.setItem(key, '1');
        } else {
            window?.localStorage?.removeItem(key);
        }
    } catch (_e) {
        // ignored
    }
}

function isVerboseLogsEnabled() {
    return getLocalFlag('runpoddirect_debug', false);
}

function isAutoMissingCheckEnabled() {
    return getLocalFlag('runpoddirect_auto_check', true);
}

function isPreQueueGuardEnabled() {
    return getLocalFlag('runpoddirect_prequeue_guard', false);
}

function isStrictPreQueueHashCheckEnabled() {
    return getLocalFlag('runpoddirect_prequeue_hash_check', false);
}

function debugLog(...args) {
    if (!isVerboseLogsEnabled()) return;
    console.log(...args);
}

// ComfyUI RunpodDirect Extension
// Version: 1.0.11
debugLog('[RunpodDirect] v1.0.11');

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
let serverWsKeepaliveEnabled = true;
let serverCgroupRamPatchEnabled = true;

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

const MODEL_FILE_EXTENSIONS = ['.safetensors', '.sft', '.ckpt', '.pth', '.pt'];

const DIRECTORY_ALIASES = {
    // common aliases -> canonical Comfy folder keys
    checkpoint: 'checkpoints',
    checkpoints: 'checkpoints',
    ckpt: 'checkpoints',
    diffusion: 'diffusion_models',
    diffusion_model: 'diffusion_models',
    diffusion_models: 'diffusion_models',
    unet: 'diffusion_models',
    vae: 'vae',
    vaes: 'vae',
    lora: 'loras',
    loras: 'loras',
    text_encoder: 'text_encoders',
    text_encoders: 'text_encoders',
    textencoder: 'text_encoders',
    clip: 'clip',
    clip_vision: 'clip_vision',
    controlnet: 'controlnet',
    upscale: 'upscale_models',
    upscale_model: 'upscale_models',
    upscale_models: 'upscale_models',
    latent_upscale: 'latent_upscale_models',
    latent_upscale_model: 'latent_upscale_models',
    latent_upscale_models: 'latent_upscale_models',
    embeddings: 'embeddings',
    hypernetwork: 'hypernetworks',
    hypernetworks: 'hypernetworks',
    style_model: 'style_models',
    style_models: 'style_models',
    gligen: 'gligen',
    audio_encoder: 'audio_encoders',
    audio_encoders: 'audio_encoders',
    diffusers: 'diffusers',
    model_patch: 'model_patches',
    model_patches: 'model_patches',
    photomaker: 'photomaker',
};

const URL_DIRECTORY_HINTS = {
    checkpoints: 'checkpoints',
    diffusion_models: 'diffusion_models',
    diffusion: 'diffusion_models',
    unet: 'diffusion_models',
    vae: 'vae',
    vaes: 'vae',
    loras: 'loras',
    lora: 'loras',
    text_encoders: 'text_encoders',
    text_encoder: 'text_encoders',
    clip: 'clip',
    clip_vision: 'clip_vision',
    controlnet: 'controlnet',
    upscale_models: 'upscale_models',
    latent_upscale_models: 'latent_upscale_models',
    embeddings: 'embeddings',
    hypernetworks: 'hypernetworks',
    style_models: 'style_models',
    gligen: 'gligen',
    audio_encoders: 'audio_encoders',
    model_patches: 'model_patches',
    diffusers: 'diffusers',
};

const MANAGER_TYPE_TO_DIRECTORY = {
    checkpoints: 'checkpoints',
    checkpoint: 'checkpoints',
    unclip: 'checkpoints',
    text_encoders: 'text_encoders',
    text_encoder: 'text_encoders',
    clip: 'text_encoders',
    vae: 'vae',
    vae_approx: 'vae_approx',
    lora: 'loras',
    loras: 'loras',
    't2i-adapter': 'controlnet',
    t2i_adapter: 'controlnet',
    't2i-style': 'controlnet',
    t2i_style: 'controlnet',
    controlnet: 'controlnet',
    clip_vision: 'clip_vision',
    gligen: 'gligen',
    upscale: 'upscale_models',
    embedding: 'embeddings',
    embeddings: 'embeddings',
    unet: 'diffusion_models',
    diffusion_model: 'diffusion_models',
    diffusion_models: 'diffusion_models',
    hypernetwork: 'hypernetworks',
    hypernetworks: 'hypernetworks',
    photomaker: 'photomaker',
    classifiers: 'classifiers',
};

const DEFAULT_MODEL_DIRECTORIES = [
    'checkpoints',
    'diffusion_models',
    'vae',
    'text_encoders',
    'loras',
    'clip',
    'clip_vision',
    'controlnet',
    'upscale_models',
    'latent_upscale_models',
    'embeddings',
    'hypernetworks',
    'style_models',
    'gligen',
    'audio_encoders',
    'model_patches',
    'diffusers',
    'photomaker',
];

let folderPathsCache = null;
let folderPathsPromise = null;
const modelFolderCache = new Map();
const modelExistsAnywhereCache = new Map();
const modelDiskExistsCache = new Map();
const modelSizeCache = new Map();
const modelIntegrityCache = new Map();
const PREQUEUE_REPORT_TTL_MS = 10000;
let queueGuardInstalled = false;
let queueGuardBypassOnce = false;
let queueGuardOriginalPrompt = null;
let queueGuardWrappedPrompt = null;
let autoMissingModalTimer = null;
let autoMissingModalInFlight = false;
let autoMissingModalSignature = '';
let autoMissingSuppressedByNativeSignature = '';
let autoMissingListenersInstalled = false;
let runpodHubOverlayEl = null;
let runpodHubPanelEl = null;
let runpodHubQueueListEl = null;
let runpodHubStatsEl = null;
let runpodHubRefreshTimer = null;
let runpodHubListenersInstalled = false;
let runpodHubKeyHandler = null;
let runpodHubResizeHandler = null;
let runpodHubOutsidePointerHandler = null;
let runpodHubScrollHandler = null;
let runpodHubStylesInstalled = false;
let managerModelIndexCache = null;
let managerModelIndexPromise = null;
let workflowGraphSnapshot = null;
let preQueueReportCache = null;

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

function installRunpodHubStyles() {
    if (runpodHubStylesInstalled) return;
    runpodHubStylesInstalled = true;
    const style = document.createElement('style');
    style.id = 'runpoddirect-hub-styles';
    style.textContent = `
        .runpoddirect-top-btn {
            color: var(--base-foreground) !important;
            background-color: var(--secondary-background) !important;
            border: 1px solid var(--border-default) !important;
            font-weight: 600 !important;
            opacity: 1 !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 6px !important;
            height: 30px !important;
            min-height: 30px !important;
            padding: 0 10px !important;
            line-height: 1 !important;
            box-sizing: border-box !important;
        }
        .runpoddirect-top-btn::before {
            content: "";
            display: block;
            width: 14px;
            height: 14px;
            flex: 0 0 14px;
            align-self: center;
            border-radius: 3px;
            background-image: url("/extensions/ComfyUI-RunpodDirect/runpod-favicon.ico");
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
        }
        .runpoddirect-top-btn .p-button-icon,
        .runpoddirect-top-btn [class*="icon-"] {
            display: none !important;
            width: 0 !important;
            margin: 0 !important;
        }
        .runpoddirect-top-btn .p-button-label {
            margin: 0 !important;
            display: inline-flex !important;
            align-items: center !important;
            line-height: 1 !important;
        }
        .runpoddirect-top-btn:hover {
            background-color: var(--secondary-background-hover) !important;
        }
        .runpoddirect-top-btn.runpoddirect-active {
            background-color: var(--primary-background) !important;
            border-color: var(--border-default) !important;
        }
        .runpoddirect-hub-panel {
            backdrop-filter: blur(6px);
        }
        .runpoddirect-hub-row:hover {
            background-color: var(--secondary-background-hover);
        }
        .runpoddirect-hub-action-btn:hover {
            filter: brightness(1.06);
        }
        .runpoddirect-fallback-btn {
            min-width: auto;
            min-height: 30px;
        }
    `;
    document.head.appendChild(style);
}

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
    if (status === 'cancelled') return THEME.muted;
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
    invalidatePreQueueReportCache();
    if (isDownloadingAll) {
        completedDownloads++;
        debugLog(`[RunpodDirect] Progress: ${completedDownloads}/${totalDownloads} completed`);
    }
    downloadStates.set(download_id, { status: 'completed', progress: 100, path, size });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
    debugLog(`Download completed: ${download_id} -> ${path}`);
    if (isDownloadingAll && completedDownloads >= totalDownloads) {
        debugLog('[RunpodDirect] All downloads completed!');
        isDownloadingAll = false;
        window.dispatchEvent(new CustomEvent('serverDownloadAllDone'));
    }
});

api.addEventListener("server_download_error", ({ detail }) => {
    const { download_id, error } = detail;
    invalidatePreQueueReportCache();
    if (isDownloadingAll) {
        completedDownloads++;
        debugLog(`[RunpodDirect] Progress: ${completedDownloads}/${totalDownloads} completed (1 error)`);
    }
    downloadStates.set(download_id, { status: 'error', error });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
    console.error(`Download error: ${download_id} - ${error}`);
    if (isDownloadingAll && completedDownloads >= totalDownloads) {
        debugLog('[RunpodDirect] All downloads completed!');
        isDownloadingAll = false;
        window.dispatchEvent(new CustomEvent('serverDownloadAllDone'));
    }
});

// --- API functions ---

async function startServerDownload(url, savePath, filename, markAsQueued = false, hash = null, hashType = null) {
    try {
        const download_id = `${savePath}/${filename}`;
        if (markAsQueued) {
            downloadStates.set(download_id, { status: 'queued', progress: 0 });
            window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
                detail: { download_id, ...downloadStates.get(download_id) }
            }));
        }
        const body = { url, save_path: savePath, filename };
        if (hash) body.hash = hash;
        if (hashType) body.hash_type = hashType;
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
        debugLog('[RunpodDirect] No downloads in queue');
        return;
    }
    debugLog(`[RunpodDirect] Starting ${downloadQueue.length} downloads`);
    const downloadsToStart = [...downloadQueue];
    downloadQueue = [];
    for (const download of downloadsToStart) {
        debugLog(`[RunpodDirect] Queuing download ${download.filename}`);
        await startServerDownload(
            download.url,
            download.directory,
            download.filename,
            true,
            download.hash || null,
            download.hash_type || null
        );
    }
    debugLog(`[RunpodDirect] All ${downloadsToStart.length} downloads queued on backend`);
}

function getRunpodHubQueueEntries() {
    const entries = Array.from(downloadStates.entries()).map(([download_id, state]) => ({
        download_id,
        ...(state || {}),
    }));
    const priority = (status) => {
        if (status === 'downloading') return 0;
        if (status === 'queued') return 1;
        if (status === 'paused') return 2;
        if (status === 'error') return 3;
        if (status === 'cancelled') return 4;
        if (status === 'completed') return 5;
        return 6;
    };
    entries.sort((a, b) => {
        const p = priority(a.status) - priority(b.status);
        if (p !== 0) return p;
        return String(a.download_id || '').localeCompare(String(b.download_id || ''));
    });
    return entries;
}

function setRunpodHubButtonActive(active) {
    const actionBtn = document.querySelector('.runpoddirect-top-btn');
    if (!(actionBtn instanceof HTMLElement)) return;
    actionBtn.classList.toggle('runpoddirect-active', !!active);
}

function ensureRunpodTopBarButton() {
    if (document.querySelector('.runpoddirect-top-btn')) return true;
    const group = document.querySelector('.comfyui-button-group');
    if (!(group instanceof HTMLElement)) return false;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'comfyui-button runpoddirect-top-btn runpoddirect-fallback-btn';
    btn.textContent = 'RunpodDirect';
    btn.title = 'RunpodDirect downloads and settings';
    btn.onclick = () => toggleRunpodHubPanel();
    group.appendChild(btn);
    return true;
}

function getRunpodHubFilename(downloadId) {
    const id = String(downloadId || '');
    const parts = id.split('/');
    return parts.length ? parts[parts.length - 1] : id;
}

function getRunpodHubProgressText(entry) {
    const downloaded = Number(entry.downloaded || 0);
    const total = Number(entry.total || 0);
    if (downloaded > 0 && total > 0) {
        return `${formatBytes(downloaded)} / ${formatBytes(total)}`;
    }
    if (total > 0) {
        return `0 B / ${formatBytes(total)}`;
    }
    return '--';
}

async function refreshDownloadStatesFromBackend() {
    try {
        const response = await api.fetchApi('/server_download/status');
        if (!response.ok) return;
        const payload = await response.json();
        if (!payload || typeof payload !== 'object') return;
        for (const [download_id, state] of Object.entries(payload)) {
            const prev = downloadStates.get(download_id) || {};
            downloadStates.set(download_id, { ...prev, ...(state || {}) });
        }
    } catch (_e) {
        // ignored
    }
}

function positionRunpodHubPanel() {
    if (!runpodHubPanelEl) return;
    const width = runpodHubPanelEl.offsetWidth || 360;
    const margin = 12;
    const topDefault = 58;
    let left = Math.max(margin, window.innerWidth - width - margin);
    let top = topDefault;

    const actionBtn = document.querySelector('.runpoddirect-top-btn');
    if (actionBtn instanceof HTMLElement) {
        const rect = actionBtn.getBoundingClientRect();
        left = Math.min(
            Math.max(margin, rect.right - width),
            Math.max(margin, window.innerWidth - width - margin)
        );
        top = Math.max(topDefault, rect.bottom + 8);
    }

    runpodHubPanelEl.style.left = `${left}px`;
    runpodHubPanelEl.style.top = `${top}px`;
    const availableHeight = Math.max(260, window.innerHeight - top - margin);
    runpodHubPanelEl.style.maxHeight = `${availableHeight}px`;
}

function renderRunpodHubQueue() {
    if (!runpodHubQueueListEl || !runpodHubStatsEl) return;
    runpodHubQueueListEl.textContent = '';

    const entries = getRunpodHubQueueEntries();
    const activeCount = entries.filter((e) => ['queued', 'downloading', 'paused'].includes(String(e.status))).length;
    runpodHubStatsEl.textContent = `${activeCount} active / ${entries.length} tracked`;

    if (!entries.length) {
        runpodHubQueueListEl.appendChild(createEl('div', {
            padding: '18px 12px',
            fontSize: '0.75rem',
            color: THEME.muted,
            textAlign: 'center',
            lineHeight: '1.35',
            whiteSpace: 'pre-line',
        }, 'No active downloads.\nStart from the missing-models dialog.'));
        return;
    }

    const maxRows = 60;
    for (const entry of entries.slice(0, maxRows)) {
        const row = createEl('div', {
            padding: '8px 10px',
            borderBottom: `1px solid ${THEME.borderSubtle}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
        });
        row.className = 'runpoddirect-hub-row';

        const top = createEl('div', {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
        });

        const name = createEl('span', {
            minWidth: '0',
            flex: '1',
            fontSize: '0.8125rem',
            color: THEME.foreground,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
        }, getRunpodHubFilename(entry.download_id));
        name.setAttribute('title', String(entry.download_id || ''));

        const status = String(entry.status || 'unknown');
        const badge = createEl('span', {
            flexShrink: '0',
            fontSize: '0.625rem',
            fontWeight: '600',
            textTransform: 'uppercase',
            color: THEME.foreground,
            backgroundColor: `${statusColor(status)}44`,
            borderRadius: '9999px',
            padding: '2px 7px',
        }, status);

        top.appendChild(name);
        top.appendChild(badge);
        row.appendChild(top);

        const progress = Math.max(0, Math.min(100, Number(entry.progress || 0)));
        const barOuter = createEl('div', {
            width: '100%',
            height: '4px',
            borderRadius: '9999px',
            backgroundColor: THEME.secondaryBgHover,
            overflow: 'hidden',
        });
        const barInner = createEl('div', {
            width: `${progress}%`,
            height: '100%',
            borderRadius: '9999px',
            backgroundColor: statusColor(status),
        });
        barOuter.appendChild(barInner);
        row.appendChild(barOuter);

        const info = createEl('div', {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            fontSize: '0.6875rem',
            color: THEME.muted,
        });
        info.appendChild(createEl('span', {}, `${progress.toFixed(1)}%`));
        info.appendChild(createEl('span', {}, getRunpodHubProgressText(entry)));
        row.appendChild(info);

        if (entry.error) {
            row.appendChild(createEl('div', {
                fontSize: '0.6875rem',
                color: THEME.error,
                lineHeight: '1.3',
                wordBreak: 'break-word',
            }, String(entry.error)));
        }

        const actions = createEl('div', {
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '6px',
        });

        const makeActionBtn = (label, onclick, variant = 'secondary') => {
            const btn = createEl('button', {
                border: variant === 'secondary' ? `1px solid ${THEME.border}` : 'none',
                backgroundColor: variant === 'secondary' ? THEME.secondaryBg : THEME.primary,
                color: THEME.foreground,
                borderRadius: '0.375rem',
                height: '24px',
                padding: '0 8px',
                fontSize: '0.6875rem',
                cursor: 'pointer',
            }, label);
            btn.className = 'runpoddirect-hub-action-btn';
            btn.type = 'button';
            btn.onmouseenter = () => {
                btn.style.backgroundColor = variant === 'secondary' ? THEME.secondaryBgHover : THEME.primaryHover;
            };
            btn.onmouseleave = () => {
                btn.style.backgroundColor = variant === 'secondary' ? THEME.secondaryBg : THEME.primary;
            };
            btn.onclick = onclick;
            return btn;
        };

        if (status === 'downloading') {
            actions.appendChild(makeActionBtn('Pause', async () => {
                await pauseDownload(entry.download_id);
                void refreshDownloadStatesFromBackend();
                renderRunpodHubQueue();
            }));
        } else if (status === 'paused') {
            actions.appendChild(makeActionBtn('Resume', async () => {
                await resumeDownload(entry.download_id);
                void refreshDownloadStatesFromBackend();
                renderRunpodHubQueue();
            }, 'primary'));
        }

        if (['queued', 'downloading', 'paused'].includes(status)) {
            actions.appendChild(makeActionBtn('Cancel', async () => {
                await cancelDownload(entry.download_id);
                void refreshDownloadStatesFromBackend();
                renderRunpodHubQueue();
            }));
        }

        if (actions.childElementCount > 0) {
            row.appendChild(actions);
        }

        runpodHubQueueListEl.appendChild(row);
    }

    if (entries.length > maxRows) {
        runpodHubQueueListEl.appendChild(createEl('div', {
            padding: '8px 10px',
            fontSize: '0.6875rem',
            color: THEME.muted,
        }, `Showing ${maxRows} of ${entries.length} tracked downloads`));
    }
}

function closeRunpodHubPanel() {
    if (runpodHubRefreshTimer) {
        clearInterval(runpodHubRefreshTimer);
        runpodHubRefreshTimer = null;
    }
    if (runpodHubOverlayEl) {
        runpodHubOverlayEl.remove();
    }
    runpodHubOverlayEl = null;
    runpodHubPanelEl = null;
    runpodHubQueueListEl = null;
    runpodHubStatsEl = null;
    if (runpodHubKeyHandler) {
        document.removeEventListener('keydown', runpodHubKeyHandler);
        runpodHubKeyHandler = null;
    }
    if (runpodHubResizeHandler) {
        window.removeEventListener('resize', runpodHubResizeHandler);
        runpodHubResizeHandler = null;
    }
    if (runpodHubOutsidePointerHandler) {
        document.removeEventListener('pointerdown', runpodHubOutsidePointerHandler);
        runpodHubOutsidePointerHandler = null;
    }
    if (runpodHubScrollHandler) {
        window.removeEventListener('scroll', runpodHubScrollHandler, true);
        runpodHubScrollHandler = null;
    }
    setRunpodHubButtonActive(false);
}

async function openRunpodHubPanel() {
    if (runpodHubOverlayEl) {
        renderRunpodHubQueue();
        positionRunpodHubPanel();
        return;
    }

    installRunpodHubStyles();
    await Promise.all([
        checkEnvHfToken(),
        refreshServerWsKeepaliveSetting(),
        refreshServerCgroupRamPatchSetting(),
    ]);

    runpodHubPanelEl = createEl('div', {
        position: 'fixed',
        width: '360px',
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'min(72vh, 640px)',
        borderRadius: '0.7rem',
        border: `1px solid ${THEME.border}`,
        backgroundColor: THEME.baseBg,
        color: THEME.foreground,
        overflow: 'hidden',
        boxShadow: '0 12px 30px rgba(0,0,0,0.38)',
        display: 'flex',
        flexDirection: 'column',
    });
    runpodHubPanelEl.className = 'runpoddirect-hub-panel';
    runpodHubPanelEl.setAttribute('role', 'dialog');
    runpodHubPanelEl.onclick = (e) => e.stopPropagation();

    const header = createEl('div', {
        padding: '10px 12px',
        borderBottom: `1px solid ${THEME.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
    });
    header.appendChild(createEl('div', {
        fontSize: '0.875rem',
        fontWeight: '600',
    }, 'RunpodDirect'));
    const closeBtn = createEl('button', {
        width: '24px',
        height: '24px',
        border: 'none',
        borderRadius: '0.375rem',
        backgroundColor: 'transparent',
        color: THEME.muted,
        cursor: 'pointer',
    }, '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close RunpodDirect panel');
    closeBtn.onmouseenter = () => { closeBtn.style.backgroundColor = THEME.secondaryBgHover; };
    closeBtn.onmouseleave = () => { closeBtn.style.backgroundColor = 'transparent'; };
    closeBtn.onclick = () => closeRunpodHubPanel();
    header.appendChild(closeBtn);
    runpodHubPanelEl.appendChild(header);

    const body = createEl('div', {
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: '0',
    });

    const settings = createEl('div', {
        border: `1px solid ${THEME.borderSubtle}`,
        borderRadius: '0.5rem',
        backgroundColor: THEME.secondaryBg,
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
    });
    settings.appendChild(createEl('div', {
        fontSize: '0.75rem',
        fontWeight: '600',
        color: THEME.foreground,
    }, 'Extension Settings'));
    settings.appendChild(createEl('div', {
        fontSize: '0.6875rem',
        color: THEME.muted,
        lineHeight: '1.3',
    }, envHasHfToken
        ? 'HF token source: server environment token detected'
        : 'HF token source: no server environment token'));

    const makeCheckboxRow = (label, description, isChecked, onToggle) => {
        const row = createEl('label', {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            cursor: 'pointer',
        });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isChecked();
        cb.style.marginTop = '2px';
        cb.onchange = async () => {
            const next = !!cb.checked;
            const prev = !next;
            try {
                const result = await onToggle(next, cb);
                if (result === false) {
                    cb.checked = prev;
                }
            } catch (_e) {
                cb.checked = prev;
            }
        };
        const txt = createEl('div', {
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
        });
        txt.appendChild(createEl('span', {
            fontSize: '0.75rem',
            color: THEME.foreground,
        }, label));
        txt.appendChild(createEl('span', {
            fontSize: '0.6875rem',
            color: THEME.muted,
            lineHeight: '1.3',
        }, description));
        row.appendChild(cb);
        row.appendChild(txt);
        return row;
    };

    settings.appendChild(makeCheckboxRow(
        'Verbose debug logs',
        'Show detailed RunpodDirect logs in browser console.',
        () => isVerboseLogsEnabled(),
        (enabled) => setLocalFlag('runpoddirect_debug', enabled),
    ));

    settings.appendChild(makeCheckboxRow(
        'Auto missing-model checks',
        'Re-check workflow models on graph load and when tab regains focus.',
        () => isAutoMissingCheckEnabled(),
        (enabled) => setLocalFlag('runpoddirect_auto_check', enabled),
    ));

    settings.appendChild(makeCheckboxRow(
        'Pre-queue guard',
        'Intercept Run and block queueing when required models appear to be missing.',
        () => isPreQueueGuardEnabled(),
        (enabled) => {
            setLocalFlag('runpoddirect_prequeue_guard', enabled);
            invalidatePreQueueReportCache();
            syncPreQueueGuard();
            return true;
        },
    ));

    settings.appendChild(makeCheckboxRow(
        'Strict pre-queue hash checks',
        'Re-hash matching files before queueing. Safer for corruption checks, slower on large models.',
        () => isStrictPreQueueHashCheckEnabled(),
        (enabled) => {
            setLocalFlag('runpoddirect_prequeue_hash_check', enabled);
            invalidatePreQueueReportCache();
            return true;
        },
    ));

    settings.appendChild(makeCheckboxRow(
        'Connection keepalive',
        'Keep websocket alive via silent server pings to reduce proxy reconnects.',
        () => isServerWsKeepaliveEnabled(),
        async (enabled, checkbox) => {
            if (checkbox) checkbox.disabled = true;
            const ok = await setServerWsKeepaliveSetting(enabled);
            if (checkbox) checkbox.disabled = false;
            if (!ok) {
                debugLog('[RunpodDirect] Failed to update keepalive setting');
                return false;
            }
            return true;
        },
    ));

    settings.appendChild(makeCheckboxRow(
        'Cgroup RAM-aware mode',
        'Report pod memory limits instead of host RAM to reduce OOM risk on constrained pods.',
        () => isServerCgroupRamPatchEnabled(),
        async (enabled, checkbox) => {
            if (checkbox) checkbox.disabled = true;
            const ok = await setServerCgroupRamPatchSetting(enabled);
            if (checkbox) checkbox.disabled = false;
            if (!ok) {
                debugLog('[RunpodDirect] Failed to update cgroup RAM-aware setting');
                return false;
            }
            return true;
        },
    ));
    body.appendChild(settings);

    const queueCard = createEl('div', {
        border: `1px solid ${THEME.borderSubtle}`,
        borderRadius: '0.5rem',
        backgroundColor: THEME.secondaryBg,
        display: 'flex',
        flexDirection: 'column',
        minHeight: '140px',
        overflow: 'hidden',
    });
    const queueHeader = createEl('div', {
        padding: '8px 10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: `1px solid ${THEME.borderSubtle}`,
        gap: '8px',
    });
    queueHeader.appendChild(createEl('span', {
        fontSize: '0.75rem',
        fontWeight: '600',
        color: THEME.foreground,
    }, 'Download Queue'));
    runpodHubStatsEl = createEl('span', {
        fontSize: '0.6875rem',
        color: THEME.muted,
    }, '--');
    queueHeader.appendChild(runpodHubStatsEl);
    queueCard.appendChild(queueHeader);

    runpodHubQueueListEl = createEl('div', {
        overflowY: 'auto',
        minHeight: '0',
        maxHeight: '260px',
    });
    queueCard.appendChild(runpodHubQueueListEl);
    body.appendChild(queueCard);

    const footer = createEl('div', {
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: '8px',
    });
    const refreshBtn = createEl('button', {
        border: `1px solid ${THEME.border}`,
        backgroundColor: THEME.secondaryBg,
        color: THEME.foreground,
        borderRadius: '0.5rem',
        height: '28px',
        padding: '0 10px',
        fontSize: '0.75rem',
        cursor: 'pointer',
    }, 'Refresh Status');
    refreshBtn.type = 'button';
    refreshBtn.onmouseenter = () => { refreshBtn.style.backgroundColor = THEME.secondaryBgHover; };
    refreshBtn.onmouseleave = () => { refreshBtn.style.backgroundColor = THEME.secondaryBg; };
    refreshBtn.onclick = async () => {
        await refreshDownloadStatesFromBackend();
        renderRunpodHubQueue();
    };
    const closeFooterBtn = createEl('button', {
        border: 'none',
        backgroundColor: THEME.primary,
        color: THEME.foreground,
        borderRadius: '0.5rem',
        height: '28px',
        padding: '0 10px',
        fontSize: '0.75rem',
        cursor: 'pointer',
    }, 'Close');
    closeFooterBtn.type = 'button';
    closeFooterBtn.onmouseenter = () => { closeFooterBtn.style.backgroundColor = THEME.primaryHover; };
    closeFooterBtn.onmouseleave = () => { closeFooterBtn.style.backgroundColor = THEME.primary; };
    closeFooterBtn.onclick = () => closeRunpodHubPanel();
    footer.appendChild(refreshBtn);
    footer.appendChild(closeFooterBtn);
    body.appendChild(footer);

    runpodHubPanelEl.appendChild(body);
    runpodHubOverlayEl = runpodHubPanelEl;
    document.body.appendChild(runpodHubPanelEl);
    setRunpodHubButtonActive(true);

    positionRunpodHubPanel();
    runpodHubKeyHandler = (event) => {
        if (event.key === 'Escape') {
            closeRunpodHubPanel();
        }
    };
    document.addEventListener('keydown', runpodHubKeyHandler);
    runpodHubResizeHandler = () => positionRunpodHubPanel();
    window.addEventListener('resize', runpodHubResizeHandler);
    runpodHubScrollHandler = () => positionRunpodHubPanel();
    window.addEventListener('scroll', runpodHubScrollHandler, true);
    runpodHubOutsidePointerHandler = (event) => {
        if (!runpodHubPanelEl) return;
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (runpodHubPanelEl.contains(target)) return;
        const actionBtn = document.querySelector('.runpoddirect-top-btn');
        if (actionBtn instanceof HTMLElement && actionBtn.contains(target)) return;
        closeRunpodHubPanel();
    };
    document.addEventListener('pointerdown', runpodHubOutsidePointerHandler);

    await refreshDownloadStatesFromBackend();
    renderRunpodHubQueue();

    runpodHubRefreshTimer = setInterval(async () => {
        await refreshDownloadStatesFromBackend();
        renderRunpodHubQueue();
    }, 3000);
}

function toggleRunpodHubPanel() {
    if (runpodHubOverlayEl) {
        closeRunpodHubPanel();
        return;
    }
    void openRunpodHubPanel();
}

function installRunpodHubListeners() {
    if (runpodHubListenersInstalled) return;
    runpodHubListenersInstalled = true;

    window.addEventListener('serverDownloadUpdate', () => {
        if (!runpodHubOverlayEl) return;
        renderRunpodHubQueue();
    });
    window.addEventListener('serverDownloadAllDone', () => {
        if (!runpodHubOverlayEl) return;
        renderRunpodHubQueue();
    });
}

// --- DOM helpers (safe, no innerHTML) ---

function createEl(tag, styles, textContent) {
    const el = document.createElement(tag);
    if (styles) Object.assign(el.style, styles);
    if (textContent) el.textContent = textContent;
    return el;
}

function hasModelExtension(filename) {
    if (!filename) return false;
    const lower = filename.toLowerCase();
    return MODEL_FILE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function sanitizeFilename(rawName) {
    if (typeof rawName !== 'string') return '';
    let value = rawName.trim();
    if (!value) return '';
    value = value.split('#')[0].split('?')[0];
    value = value.replace(/\\/g, '/');
    const parts = value.split('/').filter(Boolean);
    const basename = parts.length ? parts[parts.length - 1] : value;
    try {
        return decodeURIComponent(basename).trim();
    } catch (_e) {
        return basename.trim();
    }
}

function sanitizeUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return '';
    return rawUrl.trim();
}

function normalizeDownloadUrl(rawUrl) {
    const url = sanitizeUrl(rawUrl);
    if (!url) return '';
    try {
        const parsed = new URL(url);
        if (parsed.hostname.includes('huggingface.co')) {
            parsed.pathname = parsed.pathname.replace('/blob/', '/resolve/');
        }
        return parsed.toString();
    } catch (_e) {
        return url;
    }
}

function getFilenameFromUrl(rawUrl) {
    const normalized = normalizeDownloadUrl(rawUrl);
    if (!normalized) return null;
    try {
        const parsed = new URL(normalized);
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        if (!pathParts.length) return null;
        const candidate = sanitizeFilename(pathParts[pathParts.length - 1]);
        return hasModelExtension(candidate) ? candidate : null;
    } catch (_e) {
        return null;
    }
}

function getFallbackFolderOptions(validFolderKeys) {
    const preferred = [
        'checkpoints',
        'diffusion_models',
        'loras',
        'vae',
        'text_encoders',
        'clip',
        'clip_vision',
        'controlnet',
        'upscale_models',
        'latent_upscale_models',
        'embeddings',
    ];
    const preferredExisting = preferred.filter(key => validFolderKeys.includes(key));
    const rest = validFolderKeys.filter(key => !preferredExisting.includes(key)).sort();
    return [...preferredExisting, ...rest];
}

function getKnownFolderKeys(folderPaths) {
    const keys = Object.keys(folderPaths || {}).filter((k) => typeof k === 'string' && k.length > 0);
    if (keys.length > 0) return Array.from(new Set(keys));
    return [...DEFAULT_MODEL_DIRECTORIES];
}

function canonicalizeDirectoryKey(rawDirectory, validDirsSet) {
    if (typeof rawDirectory !== 'string') return null;
    const lowered = rawDirectory.trim().toLowerCase();
    if (!lowered) return null;
    const normalized = lowered.replace(/[\s-]+/g, '_');
    if (validDirsSet.has(normalized)) return normalized;
    const alias = DIRECTORY_ALIASES[normalized];
    if (alias && validDirsSet.has(alias)) return alias;
    const equivalents = {
        diffusion_models: ['unet'],
        unet: ['diffusion_models'],
        clip: ['text_encoders'],
        text_encoders: ['clip'],
    };
    const alternates = equivalents[normalized] || [];
    for (const alt of alternates) {
        if (validDirsSet.has(alt)) return alt;
    }
    return null;
}

function isMissingModelsDialogText(text) {
    const lower = String(text || '').toLowerCase();
    return lower.includes('missing models') || lower.includes('missing model');
}

function findVisibleMissingModelsDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const dialog of dialogs) {
        if (!(dialog instanceof HTMLElement)) continue;
        if (dialog.closest('.server-download-prequeue-overlay')) continue;
        if (isMissingModelsDialogText(dialog.textContent || '')) {
            return dialog;
        }
    }
    return null;
}

function buildMissingReportSignature(report) {
    const rows = [];
    const all = [
        ...(Array.isArray(report?.missing) ? report.missing : []),
        ...(Array.isArray(report?.unresolved) ? report.unresolved : []),
    ];
    for (const model of all) {
        const filename = sanitizeFilename(model?.filename).toLowerCase();
        const url = normalizeDownloadUrl(model?.url || '');
        const directory = String(model?.directory || '').toLowerCase();
        if (!filename) continue;
        rows.push(`${filename}|${directory}|${url}`);
    }
    rows.sort();
    return rows.join('||');
}

function buildPreQueueCandidateSignature(candidates, verifyHashes = false) {
    const rows = [];
    for (const model of Array.isArray(candidates) ? candidates : []) {
        const filename = sanitizeFilename(model?.filename).toLowerCase();
        const url = normalizeDownloadUrl(model?.url || '');
        const directory = String(model?.directory || '').toLowerCase();
        const hash = verifyHashes ? String(model?.hash || '').toLowerCase() : '';
        if (!filename) continue;
        rows.push(`${filename}|${directory}|${url}|${hash}`);
    }
    rows.sort();
    return rows.join('||');
}

function clonePreQueueReport(report) {
    return cloneWorkflowData(report);
}

function getCachedPreQueueReport(signature) {
    if (!preQueueReportCache) return null;
    if (preQueueReportCache.signature !== signature) return null;
    if ((Date.now() - preQueueReportCache.createdAt) > PREQUEUE_REPORT_TTL_MS) return null;
    return clonePreQueueReport(preQueueReportCache.report);
}

function setCachedPreQueueReport(signature, report) {
    preQueueReportCache = {
        signature,
        createdAt: Date.now(),
        report: clonePreQueueReport(report),
    };
}

function invalidatePreQueueReportCache() {
    preQueueReportCache = null;
}

function shouldWaitForNativeMissingDialog(reason = '') {
    const lower = String(reason || '').toLowerCase();
    return lower.includes('afterconfiguregraph')
        || lower.includes('setup-initial')
        || lower.includes('graph-load')
        || lower.includes('workflow-load')
        || lower.includes('template');
}

async function waitForNativeMissingDialog(timeoutMs = 4200, pollMs = 120) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() < deadline) {
        const nativeOpen = !!getMissingModelsDialogState()
            || !!findVisibleMissingModelsDialog();
        if (nativeOpen) return true;
        await new Promise((resolve) => setTimeout(resolve, Math.max(50, Number(pollMs) || 120)));
    }
    return !!getMissingModelsDialogState() || !!findVisibleMissingModelsDialog();
}

async function maybeAutoShowMissingModelsModal(reason = 'auto') {
    if (!isAutoMissingCheckEnabled()) return null;
    debugLog(`[RunpodDirect] Auto-check (${reason}): skipped (auto fallback modal disabled)`);
    return null;
}

function scheduleAutoMissingModelsCheck(reason = 'auto', delayMs = 260) {
    if (!isAutoMissingCheckEnabled()) return;
    if (autoMissingModalTimer) {
        clearTimeout(autoMissingModalTimer);
        autoMissingModalTimer = null;
    }
    autoMissingModalTimer = setTimeout(() => {
        autoMissingModalTimer = null;
        void maybeAutoShowMissingModelsModal(reason);
    }, Math.max(0, Number(delayMs) || 0));
}

function installAutoMissingCheckListeners() {
    if (autoMissingListenersInstalled) return;
    autoMissingListenersInstalled = true;

    window.addEventListener('focus', () => {
        scheduleAutoMissingModelsCheck('window-focus', 180);
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            scheduleAutoMissingModelsCheck('visibility-visible', 220);
        }
    });
}

function getVueRootElement() {
    return document.getElementById('vue-app')
        || document.querySelector('[data-v-app]')
        || document.getElementById('app');
}

function getPiniaStore(storeId) {
    const rootEl = getVueRootElement();
    if (!rootEl) return null;
    const vueApp = rootEl.__vue_app__;
    if (!vueApp) return null;
    const pinia = vueApp.config?.globalProperties?.$pinia;
    if (!pinia || !pinia._s) return null;
    return pinia._s.get(storeId) || null;
}

function readStoreValue(value) {
    if (value && typeof value === 'object' && value.__v_isRef && 'value' in value) {
        return value.value;
    }
    return value;
}

function getMissingModelsDialogState() {
    const dialogStore = getPiniaStore('dialog');
    if (!dialogStore) return null;
    const stack = dialogStore.dialogStack;
    if (!Array.isArray(stack)) return null;
    const dialog = stack.find(d => d.key === 'global-missing-models-warning');
    if (!dialog) return null;
    const missingModels = Array.isArray(dialog.contentProps?.missingModels)
        ? dialog.contentProps.missingModels
        : [];
    const paths = dialog.contentProps?.paths && typeof dialog.contentProps.paths === 'object'
        ? dialog.contentProps.paths
        : {};
    return { dialog, missingModels, paths };
}

function extractModelsFromPinia() {
    const dialogState = getMissingModelsDialogState();
    if (!dialogState) return null;
    const { missingModels, paths } = dialogState;
    if (!missingModels.length) {
        debugLog('[RunpodDirect] No missingModels in dialog contentProps');
        return null;
    }
    debugLog(`[RunpodDirect] Found ${missingModels.length} models from Pinia dialog store`);
    return {
        models: missingModels.map((m) => ({
            filename: sanitizeFilename(m.name),
            url: normalizeDownloadUrl(m.url),
            directory: m.directory ? String(m.directory) : null,
            hash: typeof m.hash === 'string' ? m.hash : null,
            hash_type: typeof m.hash_type === 'string' ? m.hash_type : null,
            source: 'dialog',
            nodeTypes: [],
        })).filter(m => m.filename && m.url),
        paths,
    };
}

function getMissingModelStoreState() {
    const missingModelStore = getPiniaStore('missingModel');
    if (!missingModelStore) return null;
    const missingModelCandidates = readStoreValue(missingModelStore.missingModelCandidates);
    const folderPaths = readStoreValue(missingModelStore.folderPaths);
    return {
        missingModelStore,
        missingModelCandidates: Array.isArray(missingModelCandidates)
            ? missingModelCandidates
            : [],
        paths: folderPaths && typeof folderPaths === 'object' && !Array.isArray(folderPaths)
            ? folderPaths
            : {},
    };
}

function getModelHashType(model) {
    if (typeof model?.hash_type === 'string') return model.hash_type;
    if (typeof model?.hashType === 'string') return model.hashType;
    return null;
}

function extractModelsFromMissingModelStore() {
    const state = getMissingModelStoreState();
    if (!state || !state.missingModelCandidates.length) return null;
    const models = state.missingModelCandidates
        .filter((candidate) => candidate && candidate.isMissing !== false)
        .map((candidate) => ({
            filename: sanitizeFilename(candidate.name),
            url: normalizeDownloadUrl(candidate.url),
            directory: candidate.directory ? String(candidate.directory) : null,
            hash: typeof candidate.hash === 'string' ? candidate.hash : null,
            hash_type: getModelHashType(candidate),
            source: 'missingModelStore',
            nodeTypes: candidate.nodeType ? [String(candidate.nodeType)] : [],
        }))
        .filter(model => model.filename && model.url);
    if (!models.length) return null;
    debugLog(`[RunpodDirect] Found ${models.length} models from missingModel store`);
    return { models, paths: state.paths };
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
        const rightSide = getModelRowRightSide(row);
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
            models.push({
                filename: sanitizeFilename(filename),
                directory,
                url: normalizeDownloadUrl(url),
                source: 'dom',
                nodeTypes: [],
            });
        }
    });
    return models.length > 0 ? models : null;
}


function extractModelsFromFooter() {
    return null;
}

function cloneWorkflowData(data) {
    if (!data || typeof data !== 'object') return data;
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(data);
        }
    } catch (_e) {
        // ignored
    }
    try {
        return JSON.parse(JSON.stringify(data));
    } catch (_e) {
        return data;
    }
}

function setWorkflowGraphSnapshot(graphData) {
    if (!graphData || typeof graphData !== 'object') return;
    workflowGraphSnapshot = cloneWorkflowData(graphData);
}

function getCurrentWorkflowData(options = {}) {
    const preferSnapshot = options?.preferSnapshot !== false;
    const allowSerialize = options?.allowSerialize !== false;
    if (preferSnapshot && workflowGraphSnapshot && typeof workflowGraphSnapshot === 'object') {
        return workflowGraphSnapshot;
    }
    if (!allowSerialize) return null;
    try {
        if (app?.rootGraph?.serialize) {
            const data = app.rootGraph.serialize();
            setWorkflowGraphSnapshot(data);
            return data;
        }
        if (app?.graph?.serialize) {
            const data = app.graph.serialize();
            setWorkflowGraphSnapshot(data);
            return data;
        }
        if (window?.app?.rootGraph?.serialize) {
            const data = window.app.rootGraph.serialize();
            setWorkflowGraphSnapshot(data);
            return data;
        }
        if (window?.app?.graph?.serialize) {
            const data = window.app.graph.serialize();
            setWorkflowGraphSnapshot(data);
            return data;
        }
    } catch (e) {
        debugLog('[RunpodDirect] Failed to access current workflow data', e);
    }
    return null;
}

function walkObjectStrings(value, onString, seen = new Set()) {
    if (value == null) return;
    if (typeof value === 'string') {
        onString(value);
        return;
    }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) walkObjectStrings(item, onString, seen);
        return;
    }
    for (const child of Object.values(value)) {
        walkObjectStrings(child, onString, seen);
    }
}

function walkWorkflowNodes(value, onNode, seen = new Set()) {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) walkWorkflowNodes(item, onNode, seen);
        return;
    }
    const maybeNode = value;
    const nodeType = typeof maybeNode.type === 'string'
        ? maybeNode.type
        : (typeof maybeNode.class_type === 'string' ? maybeNode.class_type : '');
    if (nodeType && (
        maybeNode.widgets_values !== undefined ||
        maybeNode.properties?.models !== undefined ||
        (maybeNode.inputs && typeof maybeNode.inputs === 'object')
    )) {
        if (maybeNode.type === nodeType) {
            onNode(maybeNode);
        } else {
            onNode({ ...maybeNode, type: nodeType });
        }
    }
    for (const child of Object.values(value)) {
        walkWorkflowNodes(child, onNode, seen);
    }
}

function extractUrlsFromString(text) {
    if (typeof text !== 'string' || !text.includes('http')) return [];
    const matches = text.match(/https?:\/\/[^\s<>"'`]+/g);
    if (!matches) return [];
    return matches
        .map((raw) => raw.replace(/[),.;]+$/g, ''))
        .filter(Boolean);
}

function looksLikeWidgetModelValue(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 260) return false;
    if (trimmed.includes('\n') || trimmed.includes('\r')) return false;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return false;
    if (trimmed.includes('](') || trimmed.includes('```')) return false;
    const filename = sanitizeFilename(trimmed);
    if (!filename || !hasModelExtension(filename)) return false;
    return true;
}

function collectNodeModelLikeValues(node) {
    const values = [];
    const widgets = node?.widgets_values;
    if (Array.isArray(widgets)) {
        values.push(...widgets);
    } else if (widgets && typeof widgets === 'object') {
        values.push(...Object.values(widgets));
    }

    const inputs = node?.inputs;
    if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
        for (const inputValue of Object.values(inputs)) {
            if (typeof inputValue === 'string') {
                values.push(inputValue);
                continue;
            }
            if (Array.isArray(inputValue)) {
                for (const item of inputValue) {
                    if (typeof item === 'string') values.push(item);
                }
            }
        }
    }
    return values;
}

function inferDirectoryFromUrl(url, validDirsSet) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const parts = parsed.pathname.toLowerCase().split('/').filter(Boolean);
        // ignore the final segment (filename)
        const dirParts = parts.slice(0, Math.max(parts.length - 1, 0)).reverse();
        for (const segment of dirParts) {
            const hint = URL_DIRECTORY_HINTS[segment] || segment;
            const canonical = canonicalizeDirectoryKey(hint, validDirsSet);
            if (canonical) return canonical;
        }
    } catch (_e) {
        return null;
    }
    return null;
}

function addDirectoryScore(scores, validDirsSet, rawDirectory, score) {
    const canonical = canonicalizeDirectoryKey(rawDirectory, validDirsSet);
    if (!canonical) return;
    const current = scores.get(canonical) || 0;
    if (score > current) scores.set(canonical, score);
}

function addNodeTypeDirectoryScores(scores, validDirsSet, nodeType) {
    const type = String(nodeType || '').toLowerCase();
    if (!type) return;
    if (type.includes('latentupscalemodelloader')) addDirectoryScore(scores, validDirsSet, 'latent_upscale_models', 86);
    if (type.includes('upscalemodelloader') || (type.includes('upscale') && !type.includes('latent'))) addDirectoryScore(scores, validDirsSet, 'upscale_models', 78);
    if (type.includes('lora')) addDirectoryScore(scores, validDirsSet, 'loras', 84);
    if (type.includes('vae')) addDirectoryScore(scores, validDirsSet, 'vae', 82);
    if (type.includes('clipvision')) addDirectoryScore(scores, validDirsSet, 'clip_vision', 82);
    if (type.includes('controlnet') || type.includes('t2iadapter')) addDirectoryScore(scores, validDirsSet, 'controlnet', 78);
    if (type.includes('textencoder') || type.includes('text_encode') || type.includes('projection') || type.includes('t5') || type.includes('gemma')) {
        addDirectoryScore(scores, validDirsSet, 'text_encoders', 76);
    }
    if (type.includes('clip') && !type.includes('clipvision')) {
        addDirectoryScore(scores, validDirsSet, 'clip', 72);
        addDirectoryScore(scores, validDirsSet, 'text_encoders', 68);
    }
    if (type.includes('checkpoint')) addDirectoryScore(scores, validDirsSet, 'checkpoints', 78);
    if (type.includes('diffusion') || type.includes('unet') || type.includes('transformer')) {
        addDirectoryScore(scores, validDirsSet, 'diffusion_models', 74);
    }
    if (type.includes('embedding') || type.includes('textualinversion')) addDirectoryScore(scores, validDirsSet, 'embeddings', 72);
}

function addFilenameDirectoryScores(scores, validDirsSet, filename) {
    const lower = String(filename || '').toLowerCase();
    if (!lower) return;
    if (lower.includes('lora') || lower.includes('lycoris')) addDirectoryScore(scores, validDirsSet, 'loras', 64);
    if (lower.includes('vae')) addDirectoryScore(scores, validDirsSet, 'vae', 62);
    if (lower.includes('latent') && lower.includes('upscal')) addDirectoryScore(scores, validDirsSet, 'latent_upscale_models', 66);
    if (lower.includes('upscal') && !lower.includes('latent')) addDirectoryScore(scores, validDirsSet, 'upscale_models', 60);
    if (lower.includes('controlnet') || lower.includes('t2i')) addDirectoryScore(scores, validDirsSet, 'controlnet', 58);
    if (lower.includes('clip_vision') || lower.includes('clipvision')) addDirectoryScore(scores, validDirsSet, 'clip_vision', 58);
    if (lower.includes('text_encoder') || lower.includes('text-encoder') || lower.includes('gemma') || lower.includes('t5') || lower.includes('projection')) {
        addDirectoryScore(scores, validDirsSet, 'text_encoders', 58);
    }
    if (lower.includes('embedding')) addDirectoryScore(scores, validDirsSet, 'embeddings', 56);
    if (lower.includes('checkpoint')) addDirectoryScore(scores, validDirsSet, 'checkpoints', 54);
    if (lower.includes('transformer') || lower.includes('diffusion') || lower.includes('flux') || lower.includes('hunyuan') || lower.includes('wan') || lower.includes('sd3') || lower.includes('ltx')) {
        addDirectoryScore(scores, validDirsSet, 'diffusion_models', 52);
    }
}

function resolveModelDirectory(model, validFolderKeys) {
    const validDirsSet = new Set(validFolderKeys || []);
    const scores = new Map();
    if (model.directory) addDirectoryScore(scores, validDirsSet, model.directory, 100);
    const urlDirectory = inferDirectoryFromUrl(model.url, validDirsSet);
    if (urlDirectory) addDirectoryScore(scores, validDirsSet, urlDirectory, 80);
    if (Array.isArray(model.nodeTypes)) {
        for (const nodeType of model.nodeTypes) {
            addNodeTypeDirectoryScores(scores, validDirsSet, nodeType);
        }
    }
    addFilenameDirectoryScores(scores, validDirsSet, model.filename);

    const ranked = Array.from(scores.entries())
        .map(([directory, score]) => ({ directory, score }))
        .sort((a, b) => b.score - a.score);
    const best = ranked[0] || null;
    const second = ranked[1] || null;
    const options = ranked.map(item => item.directory);
    const ambiguous = !!(best && second && (best.score - second.score) <= 12);
    return {
        directory: best ? best.directory : null,
        ambiguous: ambiguous || !best,
        options,
    };
}

async function getAvailableFolderPaths(piniaPaths) {
    const normalizeMap = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const out = {};
        for (const [rawKey, rawEntries] of Object.entries(value)) {
            const key = typeof rawKey === 'string' ? rawKey.trim() : '';
            if (!key) continue;
            const entries = [];
            if (Array.isArray(rawEntries)) {
                for (const item of rawEntries) {
                    if (typeof item === 'string') {
                        entries.push(item);
                    } else if (Array.isArray(item) && typeof item[0] === 'string') {
                        entries.push(item[0]);
                    } else if (item && typeof item === 'object' && typeof item.path === 'string') {
                        entries.push(item.path);
                    }
                }
            }
            out[key] = entries;
        }
        return out;
    };

    const mergeMaps = (...maps) => {
        const merged = {};
        for (const src of maps) {
            const normalized = normalizeMap(src);
            for (const [key, entries] of Object.entries(normalized)) {
                if (!merged[key]) merged[key] = [];
                for (const entry of entries) {
                    if (typeof entry !== 'string' || !entry) continue;
                    if (!merged[key].includes(entry)) merged[key].push(entry);
                }
            }
        }
        return merged;
    };

    const hasPinia = !!(piniaPaths && typeof piniaPaths === 'object' && Object.keys(piniaPaths).length);
    if (folderPathsCache && !hasPinia) return folderPathsCache;

    if (!folderPathsPromise || hasPinia) {
        folderPathsPromise = (async () => {
            try {
                let merged = mergeMaps(folderPathsCache, piniaPaths);

                if (typeof api.getFolderPaths === 'function') {
                    try {
                        const paths = await api.getFolderPaths();
                        merged = mergeMaps(merged, paths);
                    } catch (_e) {
                        // ignored
                    }
                }

                try {
                    const response = await api.fetchApi('/server_download/folder_paths');
                    if (response.ok) {
                        const paths = await response.json();
                        merged = mergeMaps(merged, paths);
                    }
                } catch (_e) {
                    // ignored
                }

                if (Object.keys(merged).length > 0) return merged;

                const folderNames = await fetchModelFolderNames();
                const fallback = {};
                for (const name of folderNames) fallback[name] = [];
                if (Object.keys(fallback).length > 0) return fallback;

                const defaults = {};
                for (const name of DEFAULT_MODEL_DIRECTORIES) defaults[name] = [];
                return defaults;
            } catch (_e) {
                return {};
            }
        })();
    }

    folderPathsCache = await folderPathsPromise;
    folderPathsPromise = null;
    return folderPathsCache || {};
}

function normalizeManagerSavePathToDirectory(savePath, typeName, validFolderKeys) {
    const validDirsSet = new Set(validFolderKeys || []);
    if (typeof savePath === 'string' && savePath && savePath !== 'default') {
        const firstSegment = savePath.replace(/\\/g, '/').split('/').filter(Boolean)[0] || '';
        const fromSavePath = canonicalizeDirectoryKey(firstSegment, validDirsSet);
        if (fromSavePath) return fromSavePath;
    }
    const loweredType = String(typeName || '').trim().toLowerCase();
    if (!loweredType) return null;
    const mapped = MANAGER_TYPE_TO_DIRECTORY[loweredType] || loweredType;
    return canonicalizeDirectoryKey(mapped, validDirsSet);
}

async function fetchManagerModelList() {
    const modes = ['cache', 'local'];
    for (const mode of modes) {
        try {
            const response = await api.fetchApi(`/externalmodel/getlist?mode=${encodeURIComponent(mode)}`);
            if (!response.ok) continue;
            const payload = await response.json();
            if (Array.isArray(payload?.models)) {
                return payload.models;
            }
        } catch (_e) {
            // ignored
        }
    }
    return [];
}

async function getManagerModelIndex() {
    if (managerModelIndexCache) return managerModelIndexCache;
    if (!managerModelIndexPromise) {
        managerModelIndexPromise = (async () => {
            const models = await fetchManagerModelList();
            const byFilename = new Map();
            for (const raw of models) {
                if (!raw || typeof raw !== 'object') continue;
                const filename = sanitizeFilename(raw.filename);
                const url = normalizeDownloadUrl(raw.url || '');
                if (!filename || !hasModelExtension(filename) || !url) continue;
                const key = filename.toLowerCase();
                const entry = {
                    filename,
                    url,
                    save_path: typeof raw.save_path === 'string' ? raw.save_path : '',
                    type: typeof raw.type === 'string' ? raw.type : '',
                    base: typeof raw.base === 'string' ? raw.base : '',
                    name: typeof raw.name === 'string' ? raw.name : '',
                };
                if (!byFilename.has(key)) byFilename.set(key, []);
                byFilename.get(key).push(entry);
            }
            return byFilename;
        })();
    }
    managerModelIndexCache = await managerModelIndexPromise;
    managerModelIndexPromise = null;
    return managerModelIndexCache || new Map();
}

function pickManagerFallbackEntry(entries, filename, nodeTypes, validFolderKeys) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const preferredDirectory = resolveModelDirectory({
        filename,
        url: '',
        directory: null,
        nodeTypes: Array.isArray(nodeTypes) ? nodeTypes : [],
    }, validFolderKeys).directory;

    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
        const directory = normalizeManagerSavePathToDirectory(entry.save_path, entry.type, validFolderKeys);
        let score = 0;
        if (entry.url) score += 40;
        if (directory) score += 20;
        if (preferredDirectory && directory && preferredDirectory === directory) score += 30;
        if (String(entry.base || '').toLowerCase().includes('comfy')) score += 2;
        if (score > bestScore) {
            bestScore = score;
            best = { ...entry, directory };
        }
    }
    return best;
}

async function resolveManagerModelFallback(filename, nodeTypes, validFolderKeys) {
    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename || !hasModelExtension(safeFilename)) return null;
    const index = await getManagerModelIndex();
    if (!index || !(index instanceof Map)) return null;
    const entries = index.get(safeFilename.toLowerCase());
    if (!entries || entries.length === 0) return null;
    const selected = pickManagerFallbackEntry(entries, safeFilename, nodeTypes, validFolderKeys);
    if (!selected || !selected.url) return null;
    return {
        filename: safeFilename,
        url: selected.url,
        directory: selected.directory || null,
        source: 'manager-db',
    };
}

function normalizeModelListPayload(payload) {
    if (!Array.isArray(payload)) return [];
    return payload
        .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
                return item.file_name || item.name || null;
            }
            return null;
        })
        .filter((v) => typeof v === 'string' && v.length > 0);
}

async function fetchModelFolderNames() {
    try {
        if (typeof api.getModelFolders === 'function') {
            const response = await api.getModelFolders();
            if (Array.isArray(response) && response.length > 0) {
                const names = response
                    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
                    .filter((name) => typeof name === 'string' && name.length > 0);
                if (names.length > 0) return names;
            }
        }
    } catch (_e) {
        // ignored
    }

    const urls = ['/experiment/models', '/models'];
    for (const endpoint of urls) {
        try {
            const response = await api.fetchApi(endpoint);
            if (!response.ok) continue;
            const payload = await response.json();
            if (!Array.isArray(payload)) continue;
            const names = payload
                .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
                .filter((name) => typeof name === 'string' && name.length > 0);
            if (names.length > 0) return names;
        } catch (_e) {
            // ignored
        }
    }

    return [...DEFAULT_MODEL_DIRECTORIES];
}

async function fetchModelsForDirectory(directory) {
    let hadSuccessfulResponse = false;

    try {
        if (typeof api.getModels === 'function') {
            const response = await api.getModels(directory);
            hadSuccessfulResponse = true;
            const normalized = normalizeModelListPayload(response);
            return normalized;
        }
    } catch (_e) {
        // ignored
    }

    const urls = [`/experiment/models/${encodeURIComponent(directory)}`, `/models/${encodeURIComponent(directory)}`];
    for (const endpoint of urls) {
        try {
            const response = await api.fetchApi(endpoint);
            if (!response.ok) continue;
            hadSuccessfulResponse = true;
            const payload = await response.json();
            const normalized = normalizeModelListPayload(payload);
            return normalized;
        } catch (_e) {
            // ignored
        }
    }

    return hadSuccessfulResponse ? [] : null;
}

async function modelExistsInDirectory(directory, filename) {
    if (!directory || !filename) return null;
    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename) return null;
    if (!modelFolderCache.has(directory)) {
        modelFolderCache.set(directory, fetchModelsForDirectory(directory).catch(() => null));
    }
    const models = await modelFolderCache.get(directory);
    const directDiskExists = async () => {
        const key = `${String(directory).toLowerCase()}|${safeFilename.toLowerCase()}`;
        if (modelDiskExistsCache.has(key)) {
            return modelDiskExistsCache.get(key);
        }
        try {
            const response = await api.fetchApi('/server_download/verify_model_integrity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    directory,
                    filename: safeFilename,
                }),
            });
            if (!response.ok) {
                modelDiskExistsCache.set(key, null);
                return null;
            }
            const data = await response.json();
            const exists = typeof data?.exists === 'boolean' ? data.exists : null;
            modelDiskExistsCache.set(key, exists);
            return exists;
        } catch (_e) {
            modelDiskExistsCache.set(key, null);
            return null;
        }
    };

    if (!Array.isArray(models)) {
        return await directDiskExists();
    }

    const target = safeFilename.toLowerCase();
    const listed = models.some((m) => {
        if (typeof m === 'string') return sanitizeFilename(m).toLowerCase() === target;
        const name = m?.file_name || m?.name;
        return typeof name === 'string' && sanitizeFilename(name).toLowerCase() === target;
    });
    if (listed) return true;

    // Model list can be stale right after refresh/startup; verify directly on disk.
    const diskExists = await directDiskExists();
    if (typeof diskExists === 'boolean') return diskExists;

    return false;
}

async function modelExistsAnywhere(filename, folderPaths, preferredDirectories = []) {
    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename) return null;
    const key = safeFilename.toLowerCase();
    if (modelExistsAnywhereCache.has(key)) {
        return modelExistsAnywhereCache.get(key);
    }

    const knownDirs = getKnownFolderKeys(folderPaths);
    const orderedDirs = Array.from(new Set([
        ...preferredDirectories.filter((v) => typeof v === 'string' && v.length > 0),
        ...knownDirs,
    ]));

    let sawUnknown = false;
    for (const directory of orderedDirs) {
        const exists = await modelExistsInDirectory(directory, safeFilename);
        if (exists === true) {
            const result = { exists: true, directory };
            modelExistsAnywhereCache.set(key, result);
            return result;
        }
        if (exists === null) sawUnknown = true;
    }

    const result = sawUnknown ? { exists: null, directory: null } : { exists: false, directory: null };
    modelExistsAnywhereCache.set(key, result);
    return result;
}

async function verifyModelIntegrity(directory, filename, hash, hashType) {
    if (!directory || !filename || !hash) return null;
    const key = `${directory}|${sanitizeFilename(filename).toLowerCase()}|${String(hash).toLowerCase()}|${String(hashType || '').toLowerCase()}`;
    if (modelIntegrityCache.has(key)) {
        return modelIntegrityCache.get(key);
    }
    try {
        const response = await api.fetchApi('/server_download/verify_model_integrity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory,
                filename: sanitizeFilename(filename),
                hash,
                hash_type: hashType || null,
            }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        modelIntegrityCache.set(key, data);
        return data;
    } catch (_e) {
        return null;
    }
}

async function collectSmartWorkflowModels(baseModels, folderPaths) {
    const workflow = getCurrentWorkflowData({ preferSnapshot: true, allowSerialize: false });
    if (!workflow) return [];

    const validFolderKeys = getKnownFolderKeys(folderPaths);
    const selectedModelsByName = new Map();
    const metadataByName = new Map();
    const urlModelsByName = new Map();
    const knownMissingNames = new Set((baseModels || []).map(m => sanitizeFilename(m.filename).toLowerCase()));

    walkWorkflowNodes(workflow, (node) => {
        const nodeType = typeof node.type === 'string'
            ? node.type
            : (typeof node.class_type === 'string' ? node.class_type : '');
        const values = collectNodeModelLikeValues(node);
        for (const value of values) {
            if (!looksLikeWidgetModelValue(value)) continue;
            const filename = sanitizeFilename(value);
            const key = filename.toLowerCase();
            if (!selectedModelsByName.has(key)) {
                selectedModelsByName.set(key, { filename, nodeTypes: new Set() });
            }
            if (nodeType) selectedModelsByName.get(key).nodeTypes.add(nodeType);
        }

        const models = node?.properties?.models;
        if (Array.isArray(models)) {
            for (const m of models) {
                const filename = sanitizeFilename(m?.name);
                const url = normalizeDownloadUrl(m?.url);
                if (!filename || !url || !hasModelExtension(filename)) continue;
                const key = filename.toLowerCase();
                metadataByName.set(key, {
                    filename,
                    url,
                    directory: m?.directory ? String(m.directory) : null,
                    hash: typeof m?.hash === 'string' ? m.hash : null,
                    hash_type: getModelHashType(m),
                });
            }
        }
    });

    if (Array.isArray(workflow?.models)) {
        for (const m of workflow.models) {
            const filename = sanitizeFilename(m?.name);
            const url = normalizeDownloadUrl(m?.url);
            if (!filename || !url || !hasModelExtension(filename)) continue;
            const key = filename.toLowerCase();
            metadataByName.set(key, {
                filename,
                url,
                directory: m?.directory ? String(m.directory) : null,
                hash: typeof m?.hash === 'string' ? m.hash : null,
                hash_type: getModelHashType(m),
            });
        }
    }

    walkObjectStrings(workflow, (text) => {
        const urls = extractUrlsFromString(text);
        for (const rawUrl of urls) {
            const normalizedUrl = normalizeDownloadUrl(rawUrl);
            const filename = getFilenameFromUrl(normalizedUrl);
            if (!filename) continue;
            const key = filename.toLowerCase();
            const inferredDirectory = inferDirectoryFromUrl(normalizedUrl, new Set(validFolderKeys));
            if (!urlModelsByName.has(key)) {
                urlModelsByName.set(key, {
                    filename,
                    url: normalizedUrl,
                    directory: inferredDirectory,
                });
            } else if (!urlModelsByName.get(key).directory && inferredDirectory) {
                urlModelsByName.get(key).directory = inferredDirectory;
            }
        }
    });

    const extras = [];
    for (const [key, selected] of selectedModelsByName.entries()) {
        const metadata = metadataByName.get(key);
        const urlRef = urlModelsByName.get(key);
        const url = metadata?.url || urlRef?.url;
        if (!url) continue;
        const model = {
            filename: selected.filename,
            url,
            directory: metadata?.directory || urlRef?.directory || null,
            hash: metadata?.hash || null,
            hash_type: metadata?.hash_type || null,
            source: 'workflow',
            nodeTypes: Array.from(selected.nodeTypes),
        };
        const resolved = resolveModelDirectory(model, validFolderKeys);
        model.directory = resolved.directory;
        model.needsFolderChoice = resolved.ambiguous || !resolved.directory;
        model.folderOptions = resolved.options.length
            ? resolved.options
            : getFallbackFolderOptions(validFolderKeys);

        if (knownMissingNames.has(key)) {
            extras.push(model);
            continue;
        }

        if (!model.directory) {
            extras.push(model);
            continue;
        }

        const exists = await modelExistsInDirectory(model.directory, model.filename);
        if (exists === false || exists === null) {
            extras.push(model);
        }
    }

    return extras;
}

function mergeAndNormalizeModels(baseModels, workflowModels, folderPaths) {
    const merged = new Map();
    const validFolderKeys = getKnownFolderKeys(folderPaths);
    const fallbackOptions = getFallbackFolderOptions(validFolderKeys);
    const allModels = [...(baseModels || []), ...(workflowModels || [])];

    for (const rawModel of allModels) {
        const filename = sanitizeFilename(rawModel.filename || rawModel.name);
        const url = normalizeDownloadUrl(rawModel.url);
        if (!filename || !url || !hasModelExtension(filename)) continue;
        const key = filename.toLowerCase();

        if (!merged.has(key)) {
            merged.set(key, {
                key: `${key}|${url}`,
                filename,
                url,
                directory: rawModel.directory || null,
                hash: typeof rawModel.hash === 'string' ? rawModel.hash : null,
                hash_type: getModelHashType(rawModel),
                source: rawModel.source || 'unknown',
                nodeTypes: Array.isArray(rawModel.nodeTypes) ? rawModel.nodeTypes : [],
                needsFolderChoice: false,
                folderOptions: [],
            });
        } else {
            const existing = merged.get(key);
            if (existing.source !== 'dialog' && rawModel.source === 'dialog') {
                existing.source = 'dialog';
                existing.url = url || existing.url;
            }
            if (!existing.directory && rawModel.directory) existing.directory = rawModel.directory;
            if (!existing.hash && rawModel.hash) existing.hash = rawModel.hash;
            if (!existing.hash_type) existing.hash_type = getModelHashType(rawModel);
            if (Array.isArray(rawModel.nodeTypes)) {
                existing.nodeTypes = Array.from(new Set([...(existing.nodeTypes || []), ...rawModel.nodeTypes]));
            }
        }
    }

    for (const model of merged.values()) {
        const resolved = resolveModelDirectory(model, validFolderKeys);
        const currentDirectory = canonicalizeDirectoryKey(model.directory, new Set(validFolderKeys));
        model.directory = currentDirectory || resolved.directory;
        model.needsFolderChoice = !model.directory || resolved.ambiguous;
        const candidateOptions = resolved.options.length ? resolved.options : [];
        model.folderOptions = Array.from(new Set([
            ...candidateOptions,
            ...(model.directory ? [model.directory] : []),
            ...fallbackOptions,
        ]));
    }

    return Array.from(merged.values());
}

function augmentDialogMissingModels(allModels, folderPaths) {
    const dialogState = getMissingModelsDialogState();
    if (!dialogState || !Array.isArray(dialogState.missingModels)) return 0;

    const missingModels = dialogState.missingModels;
    const existingKeys = new Set(
        missingModels.map((m) => `${sanitizeFilename(m?.name).toLowerCase()}|${normalizeDownloadUrl(m?.url)}`)
    );

    let added = 0;
    for (const model of allModels || []) {
        const filename = sanitizeFilename(model?.filename || model?.name);
        const url = normalizeDownloadUrl(model?.url);
        if (!filename || !url) continue;
        const dedupeKey = `${filename.toLowerCase()}|${url}`;
        if (existingKeys.has(dedupeKey)) continue;

        const directory = model.directory
            || (Array.isArray(model.folderOptions) && model.folderOptions.length ? model.folderOptions[0] : null);
        if (!directory) continue;

        missingModels.push({
            name: filename,
            url,
            directory,
            ...(model.hash ? { hash: model.hash } : {}),
            ...(model.hash_type ? { hash_type: model.hash_type } : {}),
        });
        existingKeys.add(dedupeKey);
        added++;
    }

    if (dialogState.dialog?.contentProps?.paths && folderPaths && typeof folderPaths === 'object') {
        const targetPaths = dialogState.dialog.contentProps.paths;
        for (const [directory, values] of Object.entries(folderPaths)) {
            if (!(directory in targetPaths)) {
                targetPaths[directory] = values;
            }
        }
    }

    return added;
}

function parseDisplayedSizeToBytes(text) {
    if (typeof text !== 'string') return null;
    const match = text.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (Number.isNaN(value)) return null;
    const unit = match[2].toUpperCase();
    const multipliers = {
        B: 1,
        KB: 1024,
        MB: 1024 * 1024,
        GB: 1024 * 1024 * 1024,
        TB: 1024 * 1024 * 1024 * 1024,
    };
    const multiplier = multipliers[unit];
    if (!multiplier) return null;
    return Math.round(value * multiplier);
}

function getModelRowRightSide(row) {
    if (!row) return null;
    const direct = row.querySelector(':scope > div[class*="shrink-0"]');
    if (direct) return direct;
    const children = Array.from(row.children || []);
    const byChildScan = children.find((child) =>
        child.tagName === 'DIV' && String(child.className || '').includes('shrink-0')
    );
    if (byChildScan) return byChildScan;
    return row.querySelector('div[class*="shrink-0"][class*="items-center"][class*="gap"]');
}

async function fetchModelSizeBytes(url) {
    const normalized = normalizeDownloadUrl(url);
    if (!normalized) return null;
    if (modelSizeCache.has(normalized)) return modelSizeCache.get(normalized);

    let size = null;

    try {
        const headResponse = await fetch(normalized, { method: 'HEAD' });
        if (headResponse.ok) {
            const contentLength = Number.parseInt(headResponse.headers.get('content-length') || '', 10);
            if (Number.isFinite(contentLength) && contentLength > 0) {
                size = contentLength;
            }
        }
    } catch (_e) {
        // ignored
    }

    if (!size) {
        try {
            const rangedResponse = await fetch(normalized, {
                method: 'GET',
                headers: { Range: 'bytes=0-0' },
            });
            const contentRange = rangedResponse.headers.get('content-range') || '';
            const rangeMatch = contentRange.match(/\/(\d+)$/);
            if (rangeMatch) {
                const total = Number.parseInt(rangeMatch[1], 10);
                if (Number.isFinite(total) && total > 0) size = total;
            }
            try {
                await rangedResponse.body?.cancel?.();
            } catch (_cancelErr) {
                // ignored
            }
        } catch (_e) {
            // ignored
        }
    }

    modelSizeCache.set(normalized, size);
    return size;
}

function findModelRowSizeElements(row) {
    const rightSide = getModelRowRightSide(row);
    if (!rightSide) return { rightSide: null, sizeEl: null };
    let sizeEl = rightSide.querySelector('.server-download-size-label');
    if (!sizeEl) {
        // Native size label selector from MissingModelsContent.vue
        sizeEl = rightSide.querySelector('span[class*="text-xs"][class*="text-muted-foreground"]');
    }
    return { rightSide, sizeEl };
}

function harmonizeRightSideLayout(rightSide, sizeEl) {
    if (!rightSide) return;
    rightSide.style.justifyContent = 'flex-end';
    rightSide.style.minWidth = '132px';
    if (!sizeEl) return;
    sizeEl.style.minWidth = '76px';
    sizeEl.style.textAlign = 'right';
    sizeEl.style.fontVariantNumeric = 'tabular-nums';
}

function ensureSizeLabel(rightSide) {
    let sizeEl = rightSide.querySelector('.server-download-size-label');
    if (sizeEl) {
        harmonizeRightSideLayout(rightSide, sizeEl);
        return sizeEl;
    }
    sizeEl = createEl('span', {
        paddingLeft: '2px',
        fontSize: '0.75rem',
        color: THEME.muted,
    });
    sizeEl.className = 'server-download-size-label';
    const firstAction = rightSide.firstElementChild;
    if (firstAction) {
        rightSide.insertBefore(sizeEl, firstAction);
    } else {
        rightSide.appendChild(sizeEl);
    }
    harmonizeRightSideLayout(rightSide, sizeEl);
    return sizeEl;
}

function getRowModelInfo(row, modelByFilename) {
    const leftSide = row.querySelector('[class*="overflow-hidden"]');
    const rightSide = getModelRowRightSide(row);
    if (!leftSide || !rightSide) return null;

    const nameSpan = leftSide.querySelector('span[title]');
    const filename = sanitizeFilename(nameSpan?.getAttribute('title') || nameSpan?.textContent || '');
    if (!filename) return null;

    const urlFromButton = rightSide.querySelector('button[title]')?.getAttribute('title');
    const urlFromAnchor = rightSide.querySelector('a[href]')?.getAttribute('href');
    const inferredUrl = modelByFilename.get(filename.toLowerCase()) || null;
    const url = normalizeDownloadUrl(urlFromButton || urlFromAnchor || inferredUrl || '');
    if (!url) return null;

    return { filename, url, rightSide };
}

function updateDialogTotalSize(container, sizeByUrl) {
    const stickyRow = container.querySelector(':scope > div.sticky');
    if (!stickyRow) return;
    const spans = stickyRow.querySelectorAll('span');
    if (!spans || spans.length < 2) return;
    const totalEl = spans[1];
    if (!totalEl) return;
    let total = 0;
    for (const value of sizeByUrl.values()) {
        if (Number.isFinite(value) && value > 0) total += value;
    }
    if (total > 0) {
        totalEl.textContent = formatBytes(total);
    }
}

async function hydrateDialogModelSizes(container, allModels) {
    if (!container) return;
    if (container.dataset.serverDownloadSizing === 'busy') return;
    container.dataset.serverDownloadSizing = 'busy';

    try {
        const modelByFilename = new Map(
            (allModels || []).map((m) => [sanitizeFilename(m.filename).toLowerCase(), normalizeDownloadUrl(m.url)])
        );
        const rows = getModelRows(container);
        const sizeByUrl = new Map();

        for (const row of rows) {
            const info = getRowModelInfo(row, modelByFilename);
            if (!info) continue;
            const { url, rightSide } = info;
            const { sizeEl } = findModelRowSizeElements(row);
            harmonizeRightSideLayout(rightSide, sizeEl);
            const existingSizeText = sizeEl?.textContent?.trim();
            const existingBytes = parseDisplayedSizeToBytes(existingSizeText || '');
            if (existingBytes && existingBytes > 0) {
                sizeByUrl.set(url, existingBytes);
                continue;
            }

            const sizeBytes = await fetchModelSizeBytes(url);
            if (sizeBytes && sizeBytes > 0) {
                sizeByUrl.set(url, sizeBytes);
                const label = ensureSizeLabel(rightSide);
                label.textContent = formatBytes(sizeBytes);
            }
        }

        updateDialogTotalSize(container, sizeByUrl);
    } finally {
        container.dataset.serverDownloadSizing = 'idle';
    }
}

async function collectPreQueueModelCandidatesFromWorkflow(workflow, folderPaths) {
    if (!workflow || typeof workflow !== 'object') return [];
    const validFolderKeys = getKnownFolderKeys(folderPaths);
    const validDirsSet = new Set(validFolderKeys);
    const fallbackOptions = getFallbackFolderOptions(validFolderKeys);

    const selectedByName = new Map();
    const metadataByName = new Map();
    const urlModelsByName = new Map();

    walkWorkflowNodes(workflow, (node) => {
        const nodeType = typeof node.type === 'string'
            ? node.type
            : (typeof node.class_type === 'string' ? node.class_type : '');
        const values = collectNodeModelLikeValues(node);
        const selectedNamesInNode = new Set();

        for (const value of values) {
            if (!looksLikeWidgetModelValue(value)) continue;
            const filename = sanitizeFilename(value);
            const key = filename.toLowerCase();
            selectedNamesInNode.add(key);
            if (!selectedByName.has(key)) {
                selectedByName.set(key, {
                    filename,
                    nodeTypes: new Set(),
                });
            }
            if (nodeType) selectedByName.get(key).nodeTypes.add(nodeType);
        }

        const models = node?.properties?.models;
        if (Array.isArray(models)) {
            for (const m of models) {
                const filename = sanitizeFilename(m?.name);
                if (!filename || !hasModelExtension(filename)) continue;
                const key = filename.toLowerCase();
                if (selectedNamesInNode.size > 0 && !selectedNamesInNode.has(key)) continue;
                metadataByName.set(key, {
                    filename,
                    url: normalizeDownloadUrl(m?.url || ''),
                    directory: m?.directory ? String(m.directory) : null,
                    hash: typeof m?.hash === 'string' ? m.hash : null,
                    hash_type: getModelHashType(m),
                });
            }
        }
    });

    if (Array.isArray(workflow?.models)) {
        for (const m of workflow.models) {
            const filename = sanitizeFilename(m?.name);
            if (!filename || !hasModelExtension(filename)) continue;
            const key = filename.toLowerCase();
            if (selectedByName.size > 0 && !selectedByName.has(key)) continue;
            metadataByName.set(key, {
                filename,
                url: normalizeDownloadUrl(m?.url || ''),
                directory: m?.directory ? String(m.directory) : null,
                hash: typeof m?.hash === 'string' ? m.hash : null,
                hash_type: getModelHashType(m),
            });
        }
    }

    walkObjectStrings(workflow, (text) => {
        const urls = extractUrlsFromString(text);
        for (const rawUrl of urls) {
            const normalizedUrl = normalizeDownloadUrl(rawUrl);
            const filename = getFilenameFromUrl(normalizedUrl);
            if (!filename || !hasModelExtension(filename)) continue;
            const key = filename.toLowerCase();
            if (!selectedByName.has(key) && !metadataByName.has(key)) continue;
            const inferredDirectory = inferDirectoryFromUrl(normalizedUrl, validDirsSet);
            if (!urlModelsByName.has(key)) {
                urlModelsByName.set(key, {
                    filename,
                    url: normalizedUrl,
                    directory: inferredDirectory,
                });
            } else {
                const existing = urlModelsByName.get(key);
                if (!existing.directory && inferredDirectory) {
                    existing.directory = inferredDirectory;
                }
                if (!existing.url && normalizedUrl) {
                    existing.url = normalizedUrl;
                }
            }
        }
    });

    const keys = new Set([...selectedByName.keys(), ...metadataByName.keys(), ...urlModelsByName.keys()]);
    const candidates = [];

    for (const key of keys) {
        const selected = selectedByName.get(key);
        const metadata = metadataByName.get(key);
        const urlRef = urlModelsByName.get(key);
        const filename = selected?.filename || metadata?.filename || urlRef?.filename;
        if (!filename || !hasModelExtension(filename)) continue;
        const candidateUrl = metadata?.url || urlRef?.url || '';

        const candidate = {
            key: `${key}|${candidateUrl}`,
            filename,
            url: candidateUrl,
            directory: metadata?.directory || urlRef?.directory || null,
            hash: metadata?.hash || null,
            hash_type: metadata?.hash_type || null,
            nodeTypes: Array.from(selected?.nodeTypes || []),
            source: 'prequeue',
        };

        const resolved = resolveModelDirectory(candidate, validFolderKeys);
        candidate.directory = canonicalizeDirectoryKey(candidate.directory, validDirsSet) || resolved.directory;
        candidate.needsFolderChoice = !candidate.directory || resolved.ambiguous;
        candidate.folderOptions = Array.from(new Set([
            ...(resolved.options || []),
            ...(candidate.directory ? [candidate.directory] : []),
            ...fallbackOptions,
        ]));

        candidates.push(candidate);
    }

    return candidates;
}

async function collectPreQueueModelCandidates(folderPaths) {
    const workflow = getCurrentWorkflowData();
    if (!workflow) return [];
    return await collectPreQueueModelCandidatesFromWorkflow(workflow, folderPaths);
}

async function checkMissingModelsViaBackend(candidates, folderPaths, options = {}) {
    try {
        const response = await api.fetchApi('/server_download/check_missing_models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                models: candidates,
                verify_hashes: !!options.verifyHashes,
            }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        return {
            missing: Array.isArray(data?.missing) ? data.missing : [],
            unresolved: Array.isArray(data?.unresolved) ? data.unresolved : [],
            candidates,
            folderPaths,
        };
    } catch (_e) {
        return null;
    }
}

async function checkMissingModelsForCandidatesFallback(candidates, folderPaths, options = {}) {
    const verifyHashes = !!options.verifyHashes;
    // Legacy path for older backends: keep behavior compatible if the batch route is unavailable.
    modelFolderCache.clear();
    modelExistsAnywhereCache.clear();
    modelDiskExistsCache.clear();
    modelIntegrityCache.clear();

    const missing = [];
    const unresolved = [];

    for (const model of candidates) {
        if (!model.directory) {
            const anywhere = await modelExistsAnywhere(model.filename, folderPaths);
            if (anywhere?.exists === true) {
                continue;
            }
            unresolved.push(model);
            continue;
        }
        const exists = await modelExistsInDirectory(model.directory, model.filename);
        if (exists === null) {
            const anywhere = await modelExistsAnywhere(model.filename, folderPaths, [model.directory]);
            if (anywhere?.exists === true) {
                continue;
            }
            if (anywhere?.exists === null) {
                unresolved.push({ ...model, reason: 'directory_listing_unavailable' });
                continue;
            }
        }
        if (exists === false) {
            const anywhere = await modelExistsAnywhere(model.filename, folderPaths, [model.directory]);
            if (anywhere?.exists === true) {
                debugLog(`[RunpodDirect] Found ${model.filename} in ${anywhere.directory}, ignoring initial miss in ${model.directory}`);
                continue;
            }
            if (anywhere?.exists === null) {
                unresolved.push({ ...model, reason: 'directory_listing_unavailable' });
                continue;
            }
            missing.push(model);
            continue;
        }
        if (verifyHashes && exists === true && model.hash) {
            const integrity = await verifyModelIntegrity(
                model.directory,
                model.filename,
                model.hash,
                model.hash_type || null
            );
            if (integrity?.exists === true && integrity?.valid === false) {
                missing.push({ ...model, corrupted: true, reason: integrity.reason || 'hash_mismatch' });
            }
        }
    }

    return { missing, unresolved, candidates, folderPaths };
}

async function checkMissingModelsForWorkflow(workflow, piniaPaths = {}, options = {}) {
    const verifyHashes = !!options.verifyHashes;
    const folderPaths = await getAvailableFolderPaths(piniaPaths);
    const candidates = await collectPreQueueModelCandidatesFromWorkflow(workflow, folderPaths);
    if (!candidates.length) {
        return { missing: [], unresolved: [], candidates: [], folderPaths };
    }

    const signature = buildPreQueueCandidateSignature(candidates, verifyHashes);
    if (!options.forceRefresh) {
        const cachedReport = getCachedPreQueueReport(signature);
        if (cachedReport) {
            return cachedReport;
        }
    }

    let report = await checkMissingModelsViaBackend(candidates, folderPaths, { verifyHashes });
    if (!report) {
        report = await checkMissingModelsForCandidatesFallback(candidates, folderPaths, { verifyHashes });
    }

    setCachedPreQueueReport(signature, report);
    return clonePreQueueReport(report);
}

async function checkMissingModelsBeforeQueue(options = {}) {
    const dialogState = getMissingModelsDialogState();
    const piniaPaths = dialogState?.paths || {};
    const workflow = getCurrentWorkflowData({ preferSnapshot: false, allowSerialize: true });
    const { missing, unresolved, candidates } = await checkMissingModelsForWorkflow(workflow, piniaPaths, options);

    debugLog(
        `[RunpodDirect] Pre-queue check: ${candidates.length} candidates, ${missing.length} missing, ${unresolved.length} unresolved`
    );

    return { missing, unresolved, candidates };
}

function seedWorkflowModelsForNativeMissingDialog(workflow, report) {
    if (!workflow || typeof workflow !== 'object') return 0;
    if (!Array.isArray(report?.missing) || report.missing.length === 0) return 0;

    const rootModels = Array.isArray(workflow.models) ? workflow.models : [];
    if (!Array.isArray(workflow.models)) {
        workflow.models = rootModels;
    }

    const existingKeys = new Set();
    const ingestModelKey = (entry) => {
        const name = sanitizeFilename(entry?.name || entry?.filename || '');
        const url = normalizeDownloadUrl(entry?.url || '');
        if (!name || !url) return;
        existingKeys.add(`${name.toLowerCase()}|${url}`);
    };

    for (const model of rootModels) ingestModelKey(model);
    walkWorkflowNodes(workflow, (node) => {
        const models = node?.properties?.models;
        if (!Array.isArray(models)) return;
        for (const model of models) ingestModelKey(model);
    });

    let added = 0;
    for (const model of report.missing) {
        const name = sanitizeFilename(model?.filename || model?.name || '');
        const url = normalizeDownloadUrl(model?.url || '');
        const directory = model?.directory || null;
        if (!name || !url || !directory) continue;
        const dedupeKey = `${name.toLowerCase()}|${url}`;
        if (existingKeys.has(dedupeKey)) continue;
        const entry = { name, url, directory };
        if (typeof model?.hash === 'string' && model.hash) entry.hash = model.hash;
        const hashType = getModelHashType(model);
        if (hashType) entry.hash_type = hashType;
        rootModels.push(entry);
        existingKeys.add(dedupeKey);
        added++;
    }

    return added;
}

function closePreQueueMissingModal() {
    const existing = document.querySelector('.server-download-prequeue-overlay');
    if (existing) existing.remove();
}

function showPreQueueMissingModal(report, onQueueAnyway, options = {}) {
    closePreQueueMissingModal();
    const mode = options?.mode === 'auto' ? 'auto' : 'queue';
    const isAutoMode = mode === 'auto';

    const overlay = createEl('div', {
        position: 'fixed',
        inset: '0',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '2000',
        padding: '16px',
    });
    overlay.className = 'server-download-prequeue-overlay';

    const dialog = createEl('div', {
        width: '100%',
        maxWidth: '560px',
        borderRadius: '0.75rem',
        border: `1px solid ${THEME.border}`,
        backgroundColor: THEME.baseBg,
        color: THEME.foreground,
        overflow: 'hidden',
        boxShadow: '0 20px 40px rgba(0,0,0,0.35)',
    });
    dialog.setAttribute('role', 'dialog');
    dialog.onclick = (e) => e.stopPropagation();

    const header = createEl('div', {
        padding: '14px 16px',
        borderBottom: `1px solid ${THEME.border}`,
        fontSize: '1rem',
        fontWeight: '600',
    }, isAutoMode ? 'This Workflow Is Missing Models' : 'Missing Models Detected');
    dialog.appendChild(header);

    const body = createEl('div', {
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    });

    const missingItems = Array.isArray(report?.missing) ? report.missing : [];
    const unresolvedItems = Array.isArray(report?.unresolved) ? report.unresolved : [];
    const hasHardMissing = missingItems.length > 0;

    body.appendChild(createEl('div', {
        fontSize: '0.8125rem',
        color: THEME.muted,
        lineHeight: '1.45',
    }, isAutoMode
        ? (hasHardMissing
            ? 'Required model files are missing on disk. Some entries have no download URL in metadata, so they cannot be auto-downloaded.'
            : 'Some model folders could not be resolved with confidence for this workflow.')
        : (hasHardMissing
            ? 'Queue was blocked because required models are missing on disk. This prevents broken or partial generations.'
            : 'Queue was blocked because some model folders could not be resolved with confidence.')));

    const list = createEl('div', {
        maxHeight: '260px',
        overflowY: 'auto',
        borderRadius: '0.5rem',
        backgroundColor: THEME.secondaryBg,
        border: `1px solid ${THEME.borderSubtle}`,
    });

    const items = hasHardMissing ? missingItems : unresolvedItems;
    const maxRows = 18;
    for (const model of items.slice(0, maxRows)) {
        const row = createEl('div', {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            padding: '8px 10px',
            borderBottom: `1px solid ${THEME.borderSubtle}`,
        });
        const name = createEl('span', {
            minWidth: '0',
            fontSize: '0.8125rem',
            color: THEME.foreground,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
        }, model.filename);
        const badge = createEl('span', {
            flexShrink: '0',
            fontSize: '0.625rem',
            fontWeight: '600',
            textTransform: 'uppercase',
            color: THEME.muted,
            backgroundColor: `${THEME.muted}22`,
            borderRadius: '9999px',
            padding: '2px 6px',
            letterSpacing: '0.02em',
        }, String(model.directory || 'unknown'));
        row.appendChild(name);
        row.appendChild(badge);
        list.appendChild(row);
    }
    if (items.length > maxRows) {
        list.appendChild(createEl('div', {
            padding: '8px 10px',
            fontSize: '0.75rem',
            color: THEME.muted,
        }, `+ ${items.length - maxRows} more...`));
    }
    body.appendChild(list);

    if (unresolvedItems.length > 0) {
        body.appendChild(createEl('div', {
            fontSize: '0.75rem',
            color: THEME.warning,
            lineHeight: '1.4',
        }, `Note: ${unresolvedItems.length} model(s) have ambiguous folders and were not auto-validated.`));
    }

    dialog.appendChild(body);

    const footer = createEl('div', {
        padding: '12px 16px',
        borderTop: `1px solid ${THEME.border}`,
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '8px',
    });

    const closeBtn = createEl('button', {
        backgroundColor: THEME.secondaryBg,
        color: THEME.foreground,
        border: `1px solid ${THEME.border}`,
        height: '32px',
        padding: '0 10px',
        fontSize: '0.75rem',
        borderRadius: '0.5rem',
        cursor: 'pointer',
    }, isAutoMode ? 'Close' : 'Cancel');
    closeBtn.type = 'button';
    closeBtn.onclick = () => closePreQueueMissingModal();
    footer.appendChild(closeBtn);

    if (isAutoMode) {
        const openHubBtn = createEl('button', {
            backgroundColor: THEME.primary,
            color: THEME.foreground,
            border: 'none',
            height: '32px',
            padding: '0 10px',
            fontSize: '0.75rem',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: '600',
        }, 'Open RunpodDirect');
        openHubBtn.type = 'button';
        openHubBtn.onclick = () => {
            closePreQueueMissingModal();
            void openRunpodHubPanel();
        };
        footer.appendChild(openHubBtn);
    } else {
        const queueAnywayBtn = createEl('button', {
            backgroundColor: THEME.warning,
            color: THEME.foreground,
            border: 'none',
            height: '32px',
            padding: '0 10px',
            fontSize: '0.75rem',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: '600',
        }, 'Queue Anyway');
        queueAnywayBtn.type = 'button';
        queueAnywayBtn.onclick = async () => {
            closePreQueueMissingModal();
            if (typeof onQueueAnyway === 'function') {
                await onQueueAnyway();
            }
        };
        footer.appendChild(queueAnywayBtn);
    }
    dialog.appendChild(footer);

    overlay.onclick = () => closePreQueueMissingModal();
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

function syncPreQueueGuard(retryCount = 0) {
    if (!isPreQueueGuardEnabled()) {
        if (queueGuardInstalled && app?.queuePrompt === queueGuardWrappedPrompt && typeof queueGuardOriginalPrompt === 'function') {
            app.queuePrompt = queueGuardOriginalPrompt;
            debugLog('[RunpodDirect] Pre-queue model check guard removed');
        }
        queueGuardInstalled = false;
        queueGuardWrappedPrompt = null;
        queueGuardOriginalPrompt = null;
        queueGuardBypassOnce = false;
        closePreQueueMissingModal();
        return;
    }

    if (queueGuardInstalled) return;

    const currentQueuePrompt = app?.queuePrompt;
    if (typeof currentQueuePrompt !== 'function') {
        if (retryCount < 20) {
            setTimeout(() => syncPreQueueGuard(retryCount + 1), 500);
        } else {
            debugLog('[RunpodDirect] queuePrompt hook not available, pre-queue guard not installed');
        }
        return;
    }

    const originalQueuePrompt = currentQueuePrompt;
    queueGuardOriginalPrompt = originalQueuePrompt;
    queueGuardWrappedPrompt = async function(number, batchCount = 1, queueNodeIds) {
        if (!isPreQueueGuardEnabled()) {
            return await originalQueuePrompt.call(this, number, batchCount, queueNodeIds);
        }

        if (queueGuardBypassOnce) {
            queueGuardBypassOnce = false;
            return await originalQueuePrompt.call(this, number, batchCount, queueNodeIds);
        }

        try {
            const report = await checkMissingModelsBeforeQueue({
                verifyHashes: isStrictPreQueueHashCheckEnabled(),
            });
            if (report.missing.length > 0 || report.unresolved.length > 0) {
                debugLog(
                    `[RunpodDirect] Blocking queue: ${report.missing.length} missing, ${report.unresolved.length} unresolved model(s)`
                );
                showPreQueueMissingModal(report, async () => {
                    queueGuardBypassOnce = true;
                    await app.queuePrompt(number, batchCount, queueNodeIds);
                });
                return false;
            }
        } catch (error) {
            console.error('[RunpodDirect] Pre-queue model check failed, allowing queue', error);
        }

        closePreQueueMissingModal();
        autoMissingModalSignature = '';
        autoMissingSuppressedByNativeSignature = '';
        return await originalQueuePrompt.call(this, number, batchCount, queueNodeIds);
    };

    app.queuePrompt = queueGuardWrappedPrompt;
    queueGuardInstalled = true;
    debugLog('[RunpodDirect] Pre-queue model check guard installed');
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

function isServerWsKeepaliveEnabled() {
    return !!serverWsKeepaliveEnabled;
}

function isServerCgroupRamPatchEnabled() {
    return !!serverCgroupRamPatchEnabled;
}

async function refreshServerWsKeepaliveSetting() {
    try {
        const response = await api.fetchApi('/server_download/keepalive_status');
        if (!response.ok) return false;
        const data = await response.json();
        if (typeof data?.enabled === 'boolean') {
            serverWsKeepaliveEnabled = data.enabled;
        }
        return true;
    } catch (_e) {
        return false;
    }
}

async function refreshServerCgroupRamPatchSetting() {
    try {
        const response = await api.fetchApi('/server_download/cgroup_ram_patch_status');
        if (!response.ok) return false;
        const data = await response.json();
        if (typeof data?.enabled === 'boolean') {
            serverCgroupRamPatchEnabled = data.enabled;
        }
        return true;
    } catch (_e) {
        return false;
    }
}

async function setServerCgroupRamPatchSetting(enabled) {
    try {
        const response = await api.fetchApi('/server_download/cgroup_ram_patch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!enabled }),
        });
        if (!response.ok) return false;
        const data = await response.json();
        if (typeof data?.enabled === 'boolean') {
            serverCgroupRamPatchEnabled = data.enabled;
        } else {
            serverCgroupRamPatchEnabled = !!enabled;
        }
        return true;
    } catch (_e) {
        return false;
    }
}

async function setServerWsKeepaliveSetting(enabled) {
    try {
        const response = await api.fetchApi('/server_download/keepalive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!enabled }),
        });
        if (!response.ok) return false;
        const data = await response.json();
        if (typeof data?.enabled === 'boolean') {
            serverWsKeepaliveEnabled = data.enabled;
        } else {
            serverWsKeepaliveEnabled = !!enabled;
        }
        return true;
    } catch (_e) {
        return false;
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
            gated.push({ filename: sanitizeFilename(filename), directory, repoUrl: link.href });
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

function createFolderPickerSection(dialog, unresolvedModels, selectedFolders, onSelect) {
    const existing = dialog.querySelector('.server-download-folder-picker');
    if (existing) existing.remove();
    if (!Array.isArray(unresolvedModels) || unresolvedModels.length === 0) return null;

    const modelList = dialog.querySelector('[class*="scrollbar-custom"][class*="overflow-y-auto"][class*="rounded-lg"]');
    if (!modelList) return null;

    const section = createEl('div', {
        borderRadius: '0.5rem',
        backgroundColor: THEME.secondaryBg,
        overflow: 'hidden',
    });
    section.className = 'server-download-folder-picker';

    const header = createEl('div', {
        padding: '8px 12px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
    });
    header.appendChild(createEl('span', {
        fontSize: '0.75rem',
        fontWeight: '600',
        color: THEME.foreground,
    }, 'Choose Model Folder'));
    header.appendChild(createEl('span', {
        fontSize: '0.6875rem',
        color: THEME.warning,
    }, `${unresolvedModels.length} unresolved`));
    section.appendChild(header);

    const body = createEl('div', {
        padding: '0 12px 10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    });

    for (const model of unresolvedModels) {
        const row = createEl('div', {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
        });

        const name = createEl('span', {
            flex: '1',
            minWidth: '0',
            fontSize: '0.75rem',
            color: THEME.foreground,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
        }, model.filename);

        const select = document.createElement('select');
        Object.assign(select.style, {
            width: '200px',
            height: '28px',
            padding: '0 8px',
            fontSize: '0.75rem',
            borderRadius: '0.375rem',
            border: `1px solid ${THEME.border}`,
            backgroundColor: THEME.baseBg,
            color: THEME.foreground,
            outline: 'none',
        });
        select.onfocus = () => { select.style.borderColor = THEME.primary; };
        select.onblur = () => { select.style.borderColor = THEME.border; };

        const selected = selectedFolders.get(model.key);
        const suggested = model.directory;

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = suggested
            ? `Select folder (suggested: ${suggested})`
            : 'Select folder';
        select.appendChild(placeholder);

        const options = Array.isArray(model.folderOptions) ? model.folderOptions : [];
        for (const option of options) {
            const opt = document.createElement('option');
            opt.value = option;
            opt.textContent = option;
            select.appendChild(opt);
        }

        if (selected) {
            select.value = selected;
        } else if (!model.needsFolderChoice && suggested) {
            select.value = suggested;
        } else {
            select.value = '';
        }

        select.onchange = () => {
            const value = select.value || null;
            onSelect(model.key, value);
        };

        row.appendChild(name);
        row.appendChild(select);
        body.appendChild(row);
    }

    body.appendChild(createEl('div', {
        fontSize: '0.6875rem',
        color: THEME.muted,
        lineHeight: '1.4',
    }, 'Pick the destination folder for each model before downloading.'));

    section.appendChild(body);

    const afterEl = dialog.querySelector('.server-download-token-section') || modelList;
    afterEl.parentElement.insertBefore(section, afterEl.nextSibling);
    return section;
}

function findMissingModelsContainer() {
    const currentPanelContainer = document.querySelector(
        '[data-testid="missing-model-importable-rows"], [data-testid="missing-model-import-not-supported-section"]'
    );
    if (currentPanelContainer instanceof HTMLElement) {
        return currentPanelContainer;
    }

    const currentPanelActions = document.querySelector('[data-testid="missing-model-actions"]');
    if (currentPanelActions instanceof HTMLElement) {
        return currentPanelActions;
    }

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

function findMissingModelActionsContainer(container) {
    const parentActions = container?.parentElement?.querySelector?.('[data-testid="missing-model-actions"]');
    if (parentActions instanceof HTMLElement) return parentActions;

    const panel = container?.closest?.('[data-testid="error-group-missing-model"]')
        || container?.closest?.('[data-testid="missing-model-import-not-supported-section"]')?.parentElement
        || container?.parentElement;
    const panelActions = panel?.querySelector?.('[data-testid="missing-model-actions"]');
    if (panelActions instanceof HTMLElement) return panelActions;

    const currentPanelActions = document.querySelector('[data-testid="missing-model-actions"]');
    return currentPanelActions instanceof HTMLElement ? currentPanelActions : null;
}

function setTruncatingButtonText(button, text) {
    let label = button.querySelector(':scope > .server-download-button-label');
    if (!(label instanceof HTMLElement)) {
        label = document.createElement('span');
        label.className = 'server-download-button-label';
        label.style.display = 'block';
        label.style.minWidth = '0';
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.style.whiteSpace = 'nowrap';
        button.textContent = '';
        button.appendChild(label);
    }
    label.textContent = text;
    button.setAttribute('aria-label', text);
}

function applyPanelActionButtonSizing(button, hasSibling = false) {
    button.style.flex = '1 1 0';
    button.style.minWidth = '0';
    button.style.maxWidth = '100%';
    button.style.overflow = 'hidden';
    button.style.textOverflow = 'ellipsis';
    button.style.whiteSpace = 'nowrap';
    button.style.boxSizing = 'border-box';
    button.style.marginRight = hasSibling ? '8px' : '0';
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

async function injectServerDownloadButtons() {
    debugLog('[RunpodDirect] injectServerDownloadButtons called');
    let dialogForLock = null;
    try {

        const container = findMissingModelsContainer();
        if (!container) {
            debugLog('[RunpodDirect] Missing models container not found');
            return;
        }

        debugLog('[RunpodDirect] Found missing models container');
        dialogForLock = container.closest('[role="dialog"]');
        if (dialogForLock?.dataset?.serverDownloadInjecting === '1') {
            debugLog('[RunpodDirect] Injection already in progress for this dialog');
            return;
        }
        if (dialogForLock) {
            dialogForLock.dataset.serverDownloadInjecting = '1';
        }
        if (dialogForLock?.querySelector('.server-download-all-btn') || document.querySelector('.server-download-all-btn')) {
            debugLog('[RunpodDirect] Buttons already injected');
            return;
        }

    // Extract model data: try Pinia store first (most reliable - URLs aren't in DOM),
    // then fall back to DOM parsing
        let models = null;
        let piniaPaths = {};

    // Strategy 1: Pinia dialog store (most reliable - works in production builds)
        const piniaModels = extractModelsFromPinia();
        if (piniaModels?.models?.length > 0) {
            models = piniaModels.models;
            piniaPaths = piniaModels.paths || {};
        }

    // Strategy 2: Current right-side Errors panel missing-model store
        if (!models) {
            const storeModels = extractModelsFromMissingModelStore();
            if (storeModels?.models?.length > 0) {
                models = storeModels.models;
                piniaPaths = storeModels.paths || {};
            }
        }

    // Strategy 3: DOM parsing (fallback - works when buttons with URLs are visible)
        if (!models) {
            const domModels = extractModelsFromDOM(container);
            if (domModels && domModels.length > 0) {
                models = domModels;
                debugLog(`[RunpodDirect] Got ${models.length} models from DOM parsing`);
            }
        }

    // Strategy 4: Footer component fallback
        if (!models) {
            const footerData = extractModelsFromFooter();
            if (footerData && footerData.models?.length > 0) {
                models = footerData.models;
                debugLog(`[RunpodDirect] Got ${models.length} models from footer component`);
            }
        }

        if (!models || models.length === 0) {
            debugLog('[RunpodDirect] No models could be extracted, will retry...');
            // Retry after a short delay - Pinia store may not be populated yet
            if (!container.dataset.retryCount || parseInt(container.dataset.retryCount) < 5) {
                container.dataset.retryCount = (parseInt(container.dataset.retryCount || '0') + 1).toString();
                setTimeout(() => injectServerDownloadButtons(), 500);
            } else {
                debugLog('[RunpodDirect] Max retries reached, giving up');
            }
            return;
        }

        const folderPaths = await getAvailableFolderPaths(piniaPaths);

    // Additional model detection from workflow (widget selections + embedded URLs)
        const workflowModels = await collectSmartWorkflowModels(models, folderPaths);
        if (workflowModels.length > 0) {
            debugLog(`[RunpodDirect] Found ${workflowModels.length} additional model(s) from workflow scan`);
        }

        models = mergeAndNormalizeModels(models, workflowModels, folderPaths);

        if (!models.length) {
            debugLog('[RunpodDirect] No valid downloadable models after normalization');
            return;
        }

        const addedToDialog = augmentDialogMissingModels(models, folderPaths);
        if (addedToDialog > 0) {
            debugLog(`[RunpodDirect] Added ${addedToDialog} model(s) to visible missing-models list`);
            // Let Vue flush the dialog list update before row-based DOM operations below.
            await new Promise((resolve) => setTimeout(resolve, 80));
        }
        void hydrateDialogModelSizes(container, models);

    // Separate downloadable models from gated ones
        const gatedModels = detectGatedModels(container);
        const gatedFilenames = new Set(gatedModels.map(g => sanitizeFilename(g.filename).toLowerCase()));

    // Models from Pinia include ALL models (including gated ones).
        const downloadableModels = models.filter(m => !gatedFilenames.has(m.filename.toLowerCase()));
        const gatedWithUrls = models.filter(m => gatedFilenames.has(m.filename.toLowerCase()));

        downloadableModels.forEach((m, i) => {
            debugLog(`[RunpodDirect] Model ${i + 1}: ${m.directory}/${m.filename} -> ${m.url}`);
        });
        if (gatedWithUrls.length > 0) {
            debugLog(`[RunpodDirect] ${gatedWithUrls.length} gated model(s) detected`);
        }

        const selectedFolders = new Map();
        // Mutable list — starts with only non-gated, grows when token is validated
        let allModelsToDownload = [];
        // Track whether gated models block the download button
        const hasGated = gatedModels.length > 0;
        let gatedVerified = false;

        const dialog = container.closest('[role="dialog"]');
        const footerBtnRow = dialog?.querySelector('div[class*="justify-end"][class*="gap"]');
        const panelActionsRow = findMissingModelActionsContainer(container);

        function getResolvedDirectory(model) {
        const selected = selectedFolders.get(model.key);
        if (selected) return selected;
        if (!model.needsFolderChoice) return model.directory;
        return null;
    }

        function getUnresolvedModels() {
        return models.filter((model) => model.needsFolderChoice && !selectedFolders.get(model.key));
    }

        function recomputeDownloadList() {
        const activeModels = gatedVerified ? models : downloadableModels;
        allModelsToDownload = activeModels
            .map((model) => {
                const directory = getResolvedDirectory(model);
                const filename = sanitizeFilename(model.filename);
                if (!directory || !filename) return null;
                return {
                    ...model,
                    directory,
                    filename,
                };
            })
            .filter(Boolean);
    }

        function refreshFolderPicker() {
        if (!dialog) return;
        const unresolved = getUnresolvedModels();
        createFolderPickerSection(dialog, unresolved, selectedFolders, (modelKey, directory) => {
            if (directory) {
                selectedFolders.set(modelKey, directory);
            } else {
                selectedFolders.delete(modelKey);
            }
            updateBtnCount();
            refreshFolderPicker();
        });
    }

    // Show gated models section if needed
        if (hasGated && dialog) {
            createTokenSection(dialog, gatedModels, gatedWithUrls, {
                onAllAccessible(_accessibleModels) {
                    // All gated models verified — enable download for everything
                    gatedVerified = true;
                    updateBtnCount();
                    debugLog(`[RunpodDirect] All gated models accessible, ${allModelsToDownload.length} total`);
                },
                onPartialAccess(_accessible, denied) {
                    // Some models need terms — keep button disabled
                    gatedVerified = false;
                    updateBtnCount();
                    debugLog(`[RunpodDirect] ${denied.length} model(s) need terms accepted`);
                },
                onFail() {
                    // Invalid token — keep button disabled
                    gatedVerified = false;
                    updateBtnCount();
                    debugLog('[RunpodDirect] Token validation failed');
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
        recomputeDownloadList();
        const count = allModelsToDownload.length;
        const unresolvedCount = getUnresolvedModels().length;
        setTruncatingButtonText(downloadAllBtn, `Download to Pod (${count})`);
        // Disable when: no models OR unresolved folders OR gated models exist but token not verified
        const shouldDisable = count === 0 || unresolvedCount > 0 || (hasGated && !gatedVerified);
        if (shouldDisable) {
            downloadAllBtn.disabled = true;
            downloadAllBtn.style.opacity = '0.5';
            downloadAllBtn.style.cursor = 'default';
        } else {
            downloadAllBtn.disabled = false;
            downloadAllBtn.style.opacity = '1';
            downloadAllBtn.style.cursor = 'pointer';
        }
        if (unresolvedCount > 0) {
            downloadAllBtn.title = `Choose folders for ${unresolvedCount} model(s) before downloading`;
        } else if (hasGated && !gatedVerified) {
            downloadAllBtn.title = 'Verify token for gated models first';
        } else {
            downloadAllBtn.title = 'Download all models directly to this RunPod instance (server-side)';
        }
        }
        updateBtnCount();
        refreshFolderPicker();

        downloadAllBtn.onmouseenter = () => { if (!downloadAllBtn.disabled) downloadAllBtn.style.backgroundColor = THEME.primaryHover; };
        downloadAllBtn.onmouseleave = () => { if (!downloadAllBtn.disabled) downloadAllBtn.style.backgroundColor = THEME.primary; };

        function setButtonRefresh() {
        downloadAllBtn.disabled = false;
        downloadAllBtn.style.opacity = '1';
        downloadAllBtn.style.pointerEvents = 'auto';
        downloadAllBtn.style.backgroundColor = THEME.success;
        downloadAllBtn.style.color = THEME.foreground;
        setTruncatingButtonText(downloadAllBtn, 'Refresh Page');
        downloadAllBtn.onmouseenter = null;
        downloadAllBtn.onmouseleave = null;
        downloadAllBtn.onclick = () => location.reload();
        }

        downloadAllBtn.onclick = async (e) => {
        e.stopPropagation();
        downloadAllBtn.disabled = true;
        downloadAllBtn.style.opacity = '0.5';
        downloadAllBtn.style.cursor = 'default';
        setTruncatingButtonText(downloadAllBtn, 'Downloading...');

        downloadQueue = allModelsToDownload.map(m => ({
            url: m.url,
            directory: m.directory,
            filename: sanitizeFilename(m.filename),
            hash: m.hash || null,
            hash_type: m.hash_type || null,
        }));
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

        if (dialog?.querySelector('.server-download-all-btn') || panelActionsRow?.querySelector('.server-download-all-btn')) {
            debugLog('[RunpodDirect] Button already present before insert, skipping duplicate');
            return;
        }
        if (footerBtnRow) {
            // Insert before the native "Download all" button
            footerBtnRow.insertBefore(downloadAllBtn, footerBtnRow.firstChild);
        } else if (panelActionsRow) {
            // Current ComfyUI frontend renders missing models in the right-side Errors panel.
            applyPanelActionButtonSizing(downloadAllBtn, !!panelActionsRow.firstElementChild);
            panelActionsRow.insertBefore(downloadAllBtn, panelActionsRow.firstChild);
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

        debugLog('[RunpodDirect] Button injection complete');
        setTimeout(() => { void hydrateDialogModelSizes(container, models); }, 350);
    } catch (error) {
        console.error('[RunpodDirect] Injection failed', error);
    } finally {
        if (dialogForLock?.dataset) {
            delete dialogForLock.dataset.serverDownloadInjecting;
        }
    }
}

function nodeContainsCurrentMissingModelPanel(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const selector = [
        '[data-testid="missing-model-importable-rows"]',
        '[data-testid="missing-model-actions"]',
        '[data-testid="error-group-missing-model"]',
    ].join(', ');
    return !!(
        node.matches?.(selector)
        || node.querySelector?.(selector)
    );
}

// MutationObserver for detecting the missing models dialog or current Errors panel
function setupDialogObserver() {
    debugLog('[RunpodDirect] Setting up dialog observer');

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return;

                    const isDialog = node.getAttribute?.('role') === 'dialog' ||
                        node.querySelector?.('[role="dialog"]');

                    if (nodeContainsCurrentMissingModelPanel(node)) {
                        debugLog('[RunpodDirect] Detected missing models panel');
                        setTimeout(() => injectServerDownloadButtons(), 300);
                    }

                    if (isDialog) {
                        setTimeout(() => {
                            const dialog = node.getAttribute?.('role') === 'dialog'
                                ? node
                                : node.querySelector('[role="dialog"]');
                            if (dialog) {
                                const text = dialog.textContent || '';
                                if (text.includes('missing models') || text.includes('Missing models')) {
                                    debugLog('[RunpodDirect] Detected missing models dialog');
                                    const fromCustomOverlay = !!dialog.closest('.server-download-prequeue-overlay');
                                    if (!fromCustomOverlay && document.querySelector('.server-download-prequeue-overlay')) {
                                        debugLog('[RunpodDirect] Closing custom missing-model dialog because native dialog is now visible');
                                        closePreQueueMissingModal();
                                    }
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
    debugLog('[RunpodDirect] Observer active');
}

// Register extension
app.registerExtension({
    name: "ComfyUI.RunpodDirect",
    actionBarButtons: [
        {
            label: 'RunpodDirect',
            tooltip: 'RunpodDirect downloads and settings',
            class: 'runpoddirect-top-btn',
            onClick: () => {
                toggleRunpodHubPanel();
            },
        },
    ],

    async setup() {
        debugLog("[RunpodDirect] Extension setup starting");
        checkEnvHfToken();
        syncPreQueueGuard();
        setupDialogObserver();
        installAutoMissingCheckListeners();
        installRunpodHubListeners();
        installRunpodHubStyles();
        void refreshDownloadStatesFromBackend();
        setTimeout(() => {
            if (document.querySelector('.runpoddirect-top-btn')) return;
            let attempts = 0;
            const timer = setInterval(() => {
                attempts += 1;
                if (ensureRunpodTopBarButton() || attempts >= 20) {
                    clearInterval(timer);
                }
            }, 300);
        }, 1200);
        scheduleAutoMissingModelsCheck('setup-initial', 1200);

        setTimeout(() => {
            debugLog('[RunpodDirect] Checking for existing dialog...');
            injectServerDownloadButtons();
        }, 1000);

        setTimeout(() => {
            debugLog('[RunpodDirect] Second check for dialog...');
            injectServerDownloadButtons();
        }, 3000);

        debugLog("[RunpodDirect] Extension setup complete");
    },

    async beforeConfigureGraph(graphData) {
        try {
            setWorkflowGraphSnapshot(graphData);
            const folderPaths = await getAvailableFolderPaths({});
            const candidates = await collectPreQueueModelCandidatesFromWorkflow(
                graphData,
                folderPaths
            );
            const seedable = candidates.filter((model) => {
                const url = normalizeDownloadUrl(model?.url || '');
                return !!(url && model?.directory);
            });
            const added = seedWorkflowModelsForNativeMissingDialog(graphData, { missing: seedable });
            if (added > 0) {
                debugLog(
                    `[RunpodDirect] beforeConfigureGraph: seeded ${added} model(s) into workflow.models ` +
                    `for native missing-models dialog (fast path, candidates=${candidates.length})`
                );
            } else {
                debugLog(
                    `[RunpodDirect] beforeConfigureGraph: no additional native-model entries (fast path, candidates=${candidates.length})`
                );
            }
        } catch (error) {
            console.error('[RunpodDirect] beforeConfigureGraph native seeding failed', error);
        }
    },

    async afterConfigureGraph(missingNodeTypes) {
        const missingCount = Array.isArray(missingNodeTypes) ? missingNodeTypes.length : 0;
        debugLog(`[RunpodDirect] afterConfigureGraph fired (missing node types: ${missingCount})`);
        scheduleAutoMissingModelsCheck('afterConfigureGraph', 320);
        setTimeout(() => { void maybeAutoShowMissingModelsModal('afterConfigureGraph-late'); }, 1400);
    }
});

api.addEventListener("server_download_paused", ({ detail }) => {
    const { download_id } = detail;
    const prev = downloadStates.get(download_id) || {};
    downloadStates.set(download_id, { ...prev, status: 'paused' });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
});

api.addEventListener("server_download_resumed", ({ detail }) => {
    const { download_id } = detail;
    const prev = downloadStates.get(download_id) || {};
    downloadStates.set(download_id, { ...prev, status: 'downloading' });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
});

api.addEventListener("server_download_cancelled", ({ detail }) => {
    const { download_id } = detail;
    invalidatePreQueueReportCache();
    const prev = downloadStates.get(download_id) || {};
    downloadStates.set(download_id, { ...prev, status: 'cancelled' });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
});
