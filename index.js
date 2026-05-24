import { extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    saveMetadata,
    chat,
    chat_metadata,
} from '../../../../script.js';
import { MacrosParser } from '../../../macros.js';
import { ConnectionManagerRequestService } from '../../shared.js';

const MODULE_NAME = 'repetition_ban';

const defaultSettings = {
    enabled: true,
    profileId: '',
    turnInterval: 10,
    windowSize: 20,
    model: '',
    systemPrompt:
        'You are an editor reviewing a roleplay/creative-writing transcript for stylistic repetition.\n\n' +
        'IGNORE entirely: pronouns ("you", "I", "she", etc.), articles ("the", "a"), prepositions, conjunctions, copulas, ' +
        'common verbs ("said", "looked", "went"), proper nouns/character names, and any other ordinary function words. ' +
        'High frequency alone is NOT the criterion — only flag things that are notable BECAUSE of how often they recur.\n\n' +
        'DO flag: distinctive multi-word phrases, body-language tics ("her breath hitched", "a shiver ran down"), ' +
        'sensory clichés ("the air thick with"), recurring metaphors, "a mix of X and Y" constructions, ' +
        'repeated emotional descriptors, stylistic crutches the writer is leaning on, and any vocabulary or imagery ' +
        'that shows up enough times across the sample to feel like a tic rather than a choice.\n\n' +
        'Output ONLY a single sentence in this exact format:\n' +
        '"Minimize use of the following terms and expressions: <comma-separated list>."\n' +
        'No commentary, no explanation, no markdown, no bullet points. ' +
        'If nothing stylistically notable recurs, output an empty response.',
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
        chat_metadata[MODULE_NAME] = { currentBan: '', lastAnalyzedAt: -1, lastSent: '' };
    }
    if (chat_metadata[MODULE_NAME].lastSent === undefined) {
        chat_metadata[MODULE_NAME].lastSent = '';
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

function getConnectionProfiles() {
    return extension_settings?.connectionManager?.profiles ?? [];
}

function formatMessages(messages) {
    return messages.map(m => `${m.name}: ${m.mes}`).join('\n\n');
}

async function callAnalyzer(formattedUserContent) {
    const settings = getSettings();
    if (!settings.profileId) {
        throw new Error('No connection profile selected.');
    }
    if (!getConnectionProfiles().some(p => p.id === settings.profileId)) {
        throw new Error('Selected connection profile no longer exists.');
    }

    const prompt = [
        { role: 'system', content: settings.systemPrompt },
        { role: 'user', content: formattedUserContent },
    ];

    const overridePayload = { temperature: settings.temperature };
    const overrideModel = (settings.model || '').trim();
    if (overrideModel) overridePayload.model = overrideModel;

    const result = await ConnectionManagerRequestService.sendRequest(
        settings.profileId,
        prompt,
        settings.maxTokens,
        { extractData: true, includePreset: false, includeInstruct: false },
        overridePayload,
    );

    return String(result?.content ?? '').trim();
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
    if (!settings.profileId) {
        if (!silent) toastr.warning('Repetition ban: no connection profile selected.');
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
        const formatted = formatMessages(window);
        const result = await callAnalyzer(formatted);
        const state = getChatState();
        state.currentBan = result;
        state.lastAnalyzedAt = chat.length;
        state.lastSent = formatted;
        await saveMetadata();
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

            <label for="rb_profile">Connection profile</label>
            <div class="repetition-ban-row">
                <select id="rb_profile" class="text_pole" style="flex: 1;"></select>
                <input id="rb_profile_refresh" class="menu_button" type="button" value="↻" title="Refresh profile list" />
            </div>

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

            <label for="rb_model">Model override (blank = use the profile's model)</label>
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

            <details style="margin-top: 10px;">
                <summary style="cursor: pointer; font-weight: 600;">Show last messages sent to analyzer</summary>
                <div id="rb_last_sent" class="repetition-ban-status" style="max-height: 300px; overflow-y: auto; font-style: normal; font-family: monospace; font-size: 0.85em;"></div>
            </details>
        </div>
    </div>
</div>
`;

function updateStatusDisplay() {
    const el = document.getElementById('rb_status');
    if (el) el.textContent = getCurrentBan() || '(empty — no analysis yet for this chat)';
    const sent = document.getElementById('rb_last_sent');
    if (sent) sent.textContent = getChatState().lastSent || '(no analysis has run for this chat yet)';
}

function setRunningUI(running) {
    const btn = document.getElementById('rb_run_now');
    if (!btn) return;
    btn.disabled = running;
    btn.value = running ? 'Running…' : 'Run now';
}

function populateProfileDropdown() {
    const settings = getSettings();
    const sel = document.getElementById('rb_profile');
    if (!sel) return;
    const profiles = getConnectionProfiles().slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    sel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = profiles.length ? '— select a profile —' : '(no profiles found — set one up in Connection Manager)';
    sel.appendChild(placeholder);
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
    }
    sel.value = settings.profileId || '';
}

function bindSettings() {
    const settings = getSettings();

    const $enabled = $('#rb_enabled');
    const $profile = $('#rb_profile');
    const $interval = $('#rb_turn_interval');
    const $window = $('#rb_window_size');
    const $model = $('#rb_model');
    const $maxTokens = $('#rb_max_tokens');
    const $temp = $('#rb_temperature');
    const $sys = $('#rb_system_prompt');

    $enabled.prop('checked', settings.enabled);
    populateProfileDropdown();
    $interval.val(settings.turnInterval);
    $window.val(settings.windowSize);
    $model.val(settings.model);
    $maxTokens.val(settings.maxTokens);
    $temp.val(settings.temperature);
    $sys.val(settings.systemPrompt);

    $enabled.on('change', () => { settings.enabled = $enabled.prop('checked'); saveSettingsDebounced(); });
    $profile.on('change', () => { settings.profileId = String($profile.val() || ''); saveSettingsDebounced(); });
    $('#rb_profile_refresh').on('click', () => populateProfileDropdown());
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
    $('#rb_clear').on('click', async () => {
        const state = getChatState();
        state.currentBan = '';
        state.lastAnalyzedAt = -1;
        state.lastSent = '';
        await saveMetadata();
        updateStatusDisplay();
        toastr.success('Repetition ban cleared for this chat.');
    });

    updateStatusDisplay();
}

jQuery(() => {
    getSettings();
    const parent = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!parent) return;
    $(parent).append(settingsHtml);
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
