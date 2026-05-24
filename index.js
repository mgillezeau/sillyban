console.log('[sillyban] module top-level executing');
try { window.toastr?.info('[sillyban] script loaded', '', { timeOut: 8000 }); } catch {}
import { extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    saveMetadataDebounced,
    getRequestHeaders,
    chat,
    chat_metadata,
    main_api,
} from '../../../../script.js';
import { MacrosParser } from '../../../macros.js';
import { oai_settings, chat_completion_sources } from '../../../openai.js';

const MODULE_NAME = 'repetition_ban';
const OPENROUTER_SOURCE = chat_completion_sources?.OPENROUTER ?? 'openrouter';

const defaultSettings = {
    enabled: true,
    turnInterval: 10,
    windowSize: 20,
    model: '',
    systemPrompt:
        'You are an editor reviewing recent chat messages for repetitive language. ' +
        'Identify words, phrases, and expressions that have been used excessively across the messages provided. ' +
        'Output ONLY a single sentence in this exact format: ' +
        '"Minimize use of the following terms and expressions: <comma-separated list>." ' +
        'No commentary, no explanation, no markdown. ' +
        'If nothing stands out as overused, output an empty response.',
    maxTokens: 400,
    temperature: 0.3,
};

let isRunning = false;

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

function getChatState() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = { currentBan: '', lastAnalyzedAt: -1 };
    }
    return chat_metadata[MODULE_NAME];
}

function getCurrentBan() {
    try {
        return getChatState().currentBan || '';
    } catch {
        return '';
    }
}

function isOpenRouterActive() {
    return main_api === 'openai' && oai_settings.chat_completion_source === OPENROUTER_SOURCE;
}

function formatMessages(messages) {
    return messages.map(m => `${m.name}: ${m.mes}`).join('\n\n');
}

async function callAnalyzer(messages) {
    const settings = getSettings();
    const model = (settings.model || '').trim() || oai_settings.openrouter_model;

    if (!model) {
        throw new Error('No model set — choose one in the extension settings or in your OpenRouter connection.');
    }

    const payload = {
        messages: [
            { role: 'system', content: settings.systemPrompt },
            { role: 'user', content: formatMessages(messages) },
        ],
        model,
        chat_completion_source: OPENROUTER_SOURCE,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: false,
    };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`OpenRouter request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    return String(data?.choices?.[0]?.message?.content ?? '').trim();
}

async function runAnalysis({ silent = false } = {}) {
    if (isRunning) {
        if (!silent) toastr.info('Repetition ban: analysis already running.');
        return;
    }
    const settings = getSettings();
    if (!settings.enabled) {
        if (!silent) toastr.warning('Repetition ban: disabled.');
        return;
    }
    if (!isOpenRouterActive()) {
        if (!silent) toastr.warning('Repetition ban: active connection is not OpenRouter.');
        return;
    }
    if (!Array.isArray(chat) || chat.length === 0) {
        if (!silent) toastr.info('Repetition ban: no messages to analyze.');
        return;
    }

    const windowSize = Math.max(1, Number(settings.windowSize) || 20);
    const window = chat
        .slice(-windowSize)
        .filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim().length > 0);

    if (window.length === 0) {
        if (!silent) toastr.info('Repetition ban: nothing analyzable in window.');
        return;
    }

    isRunning = true;
    setRunningUI(true);
    try {
        const result = await callAnalyzer(window);
        const state = getChatState();
        state.currentBan = result;
        state.lastAnalyzedAt = chat.length;
        saveMetadataDebounced();
        updateStatusDisplay();
        if (!silent) toastr.success('Repetition ban: updated.');
    } catch (err) {
        console.error('[repetition_ban]', err);
        toastr.error(String(err?.message ?? err), 'Repetition ban');
    } finally {
        isRunning = false;
        setRunningUI(false);
    }
}

async function onMessageEvent() {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const interval = Math.max(1, Number(settings.turnInterval) || 10);
    const state = getChatState();
    if (chat.length === state.lastAnalyzedAt) return;
    if (chat.length % interval !== 0) return;

    await runAnalysis({ silent: true });
}

function onChatChanged() {
    updateStatusDisplay();
}

const settingsHtml = `
<div class="repetition-ban-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Repetition Ban</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label">
                <input id="rb_enabled" type="checkbox" />
                <span>Enabled</span>
            </label>

            <div class="repetition-ban-row">
                <label for="rb_turn_interval" style="margin: 0;">Run every</label>
                <input id="rb_turn_interval" type="number" min="1" step="1" />
                <span>messages (any source)</span>
            </div>

            <div class="repetition-ban-row">
                <label for="rb_window_size" style="margin: 0;">Analyze last</label>
                <input id="rb_window_size" type="number" min="1" step="1" />
                <span>messages</span>
            </div>

            <label for="rb_model">Model (OpenRouter ID — blank uses your active OR model)</label>
            <input id="rb_model" type="text" class="text_pole" placeholder="e.g. anthropic/claude-haiku-4.5" />

            <label for="rb_max_tokens">Max tokens</label>
            <input id="rb_max_tokens" type="number" min="50" step="50" class="text_pole" />

            <label for="rb_temperature">Temperature</label>
            <input id="rb_temperature" type="number" min="0" max="2" step="0.05" class="text_pole" />

            <label for="rb_system_prompt">Analyzer system prompt</label>
            <textarea id="rb_system_prompt" rows="6"></textarea>

            <div class="repetition-ban-row" style="margin-top: 10px;">
                <input id="rb_run_now" class="menu_button" type="button" value="Run now" />
                <input id="rb_clear" class="menu_button" type="button" value="Clear (this chat)" />
            </div>

            <hr />
            <label style="margin-top: 0;">Current ban list (this chat):</label>
            <div id="rb_status" class="repetition-ban-status"></div>
            <small>Insert <code>{{repetition_ban}}</code> in your preset where you want this injected.</small>
        </div>
    </div>
</div>
`;

function updateStatusDisplay() {
    const el = document.getElementById('rb_status');
    if (!el) return;
    const ban = getCurrentBan();
    el.textContent = ban || '(empty — no analysis yet for this chat)';
}

function setRunningUI(running) {
    const btn = document.getElementById('rb_run_now');
    if (!btn) return;
    btn.disabled = running;
    btn.value = running ? 'Running…' : 'Run now';
}

function bindSettings() {
    const settings = getSettings();

    const $enabled = $('#rb_enabled');
    const $interval = $('#rb_turn_interval');
    const $window = $('#rb_window_size');
    const $model = $('#rb_model');
    const $maxTokens = $('#rb_max_tokens');
    const $temp = $('#rb_temperature');
    const $sys = $('#rb_system_prompt');

    $enabled.prop('checked', settings.enabled);
    $interval.val(settings.turnInterval);
    $window.val(settings.windowSize);
    $model.val(settings.model);
    $maxTokens.val(settings.maxTokens);
    $temp.val(settings.temperature);
    $sys.val(settings.systemPrompt);

    $enabled.on('change', () => { settings.enabled = $enabled.prop('checked'); saveSettingsDebounced(); });
    $interval.on('change', () => { settings.turnInterval = Math.max(1, parseInt($interval.val(), 10) || 10); saveSettingsDebounced(); });
    $window.on('change', () => { settings.windowSize = Math.max(1, parseInt($window.val(), 10) || 20); saveSettingsDebounced(); });
    $model.on('change', () => { settings.model = String($model.val() || '').trim(); saveSettingsDebounced(); });
    $maxTokens.on('change', () => { settings.maxTokens = Math.max(50, parseInt($maxTokens.val(), 10) || 400); saveSettingsDebounced(); });
    $temp.on('change', () => {
        const v = parseFloat($temp.val());
        settings.temperature = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 0.3;
        saveSettingsDebounced();
    });
    $sys.on('change', () => {
        const v = String($sys.val() || '').trim();
        settings.systemPrompt = v || defaultSettings.systemPrompt;
        saveSettingsDebounced();
    });

    $('#rb_run_now').on('click', () => runAnalysis());
    $('#rb_clear').on('click', () => {
        const state = getChatState();
        state.currentBan = '';
        state.lastAnalyzedAt = -1;
        saveMetadataDebounced();
        updateStatusDisplay();
        toastr.success('Repetition ban cleared for this chat.');
    });

    updateStatusDisplay();
}

console.log('[sillyban] module-body reached, imports resolved');
try { toastr.info('[sillyban] imports OK', '', { timeOut: 8000 }); } catch {}

jQuery(() => {
    console.log('[sillyban] jQuery ready handler firing');
    try { toastr.info('[sillyban] jQuery ready', '', { timeOut: 8000 }); } catch {}
    getSettings();
    const parent = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    const where = parent?.id || 'NONE';
    console.log('[sillyban] container:', where);
    try { toastr.info(`[sillyban] container: ${where}`, '', { timeOut: 12000 }); } catch {}
    if (!parent) {
        try { toastr.error('[sillyban] no extensions_settings container found', '', { timeOut: 20000 }); } catch {}
        return;
    }
    $(parent).append(settingsHtml);
    const count = document.querySelectorAll('.repetition-ban-settings').length;
    try { toastr.success(`[sillyban] UI appended (${count} found)`, '', { timeOut: 12000 }); } catch {}
    bindSettings();

    MacrosParser.registerMacro(
        'repetition_ban',
        () => getCurrentBan(),
        'Current ban list of repetitive phrases for this chat (managed by Repetition Ban extension).',
    );

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageEvent);
    eventSource.on(event_types.MESSAGE_SENT, onMessageEvent);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
});
