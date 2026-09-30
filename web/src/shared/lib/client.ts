import catalog from './catalog.json';
import { performanceSettings, emptyState, type AudioAsset, type Draft, type State, type Voice, type Preferences, type Character, type SynthesisSettings } from '../workbench';
import { encodeWav, toBase64 } from './sound';
import { CallError, parseCallError } from './call-error';

export { CallError, parseCallError };

declare global { interface Window { __workbenchPlatform?: 'macos'; __workbenchMediaBase?: string; __workbenchDraft?: Draft; chrome?: { webview?: { postMessage: (data: unknown) => void; addEventListener: (name: string, listener: (event: MessageEvent) => void) => void } } } }
const native = window.chrome?.webview;
export const isDesktop = !!native;
export const isMac = window.__workbenchPlatform === 'macos';
const listeners = new Set<(state: State) => void>();
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
native?.addEventListener('message', ({ data }) => {
  if (data.event === 'state') { listeners.forEach(fn => fn(data.state)); return; }
  const callback = pending.get(data.id);
  if (!callback) return;
  clearTimeout(callback.timer); pending.delete(data.id);
  if (data.error) callback.reject(parseCallError(data.error)); else callback.resolve(data.result);
});
let preview = emptyState();
for (const key of ['voice-workbench-v1', 'voice-workbench-backup']) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!stored || !Array.isArray(stored.drafts) || !Array.isArray(stored.history) || !Array.isArray(stored.voices)) continue;
    preview = stored; break;
  } catch { /* 主副本损坏时继续读取恢复备份。 */ }
}
preview.characters ??= []; preview.previews = [];
if (!['zh-CN', 'en'].includes(preview.preferences?.uiLocale)) {
  preview = { ...preview, preferences: { ...preview.preferences, uiLocale: 'zh-CN' } };
}
function publish() { const previous = localStorage.getItem('voice-workbench-v1'); if (previous) { try { JSON.parse(previous); localStorage.setItem('voice-workbench-backup', previous); } catch { /* 损坏的主副本不覆盖恢复备份。 */ } } localStorage.setItem('voice-workbench-v1', JSON.stringify(preview)); listeners.forEach(fn => fn(structuredClone(preview))); }
export function subscribe(listener: (state: State) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export async function call<T = unknown>(method: string, data: unknown = {}): Promise<T> {
  if (native) return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new CallError('@yovoice.error.unknown', { detail: 'desktop timeout' })); }, 120000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer }); native.postMessage({ id, method, data });
  });
  // 浏览器预览只保存编辑和音频数据，不模拟桌面推理或模型安装。
  if (method === 'state.get') return { state: preview, catalog, desktop: false } as T;
  if (method === 'character.save') {
    const character = structuredClone(data as Character);
    if (!character.name.trim() || character.name.length > 120 || character.demoText.length > 2000) throw new CallError('@yovoice.error.characterInvalid');
    if ([character.settings.voiceId, character.settings.emotionVoiceId].some(id => id && !preview.voices.some(v => v.id === id))) throw new CallError('@yovoice.error.voiceRequired');
    if ((character.performances?.length ?? 0) > 32 || character.performances?.some((p, i, all) => !/^[a-f0-9]{32}$/i.test(p.id) || !p.name.trim() || p.name.trim().length > 120 || all.some((v, j) => j !== i && (p.id === v.id || p.name.trim().toLowerCase() === v.name.trim().toLowerCase())))) throw new CallError('@yovoice.error.characterInvalid');
    character.performances = character.performances?.map(p => ({ ...p, name: p.name.trim(), settings: performanceSettings(character.settings, p) }));
    if (character.performances?.some(p => p.settings.emotionVoiceId && !preview.voices.some(v => v.id === p.settings.emotionVoiceId))) throw new CallError('@yovoice.error.voiceRequired');
    const index = preview.characters.findIndex(c => c.id === character.id);
    character.name = character.name.trim(); character.createdAt = index < 0 ? new Date().toISOString() : preview.characters[index].createdAt;
    character.updatedAt = new Date().toISOString();
    if (index < 0) preview.characters.push(character); else preview.characters[index] = character;
    publish(); return character as T;
  }
  if (method === 'character.delete') { preview.characters = preview.characters.filter(c => c.id !== (data as { id: string }).id); publish(); return true as T; }
  if (method === 'character.discardPreview') return true as T;
  if (method === 'voice.update' || method === 'voice.fromGeneration') {
    const input = data as { id: string; name: string; referenceText: string };
    if (!input.name.trim() || input.name.length > 100 || input.referenceText.length > 2000) throw new CallError('@yovoice.error.characterInvalid');
    if (method === 'voice.update') {
      const voice = preview.voices.find(v => v.id === input.id);
      if (!voice) throw new CallError('@yovoice.error.audioMissing');
      voice.name = input.name.trim(); voice.referenceText = input.referenceText;
      publish(); return voice as T;
    }
    const generation = preview.history.find(g => g.id === input.id);
    if (!generation) throw new CallError('@yovoice.error.audioMissing');
    const blob = await blobStore(generation.fileName);
    if (!blob) throw new CallError('@yovoice.error.audioBlobMissing');
    const voice = await importVoiceFile(new File([blob], input.name.trim() + '.wav'));
    Object.assign(voice, { referenceText: input.referenceText, source: 'generation', sourceGenerationId: input.id });
    publish(); return voice as T;
  }
  if (method === 'draft.save') {
    const draft = structuredClone(data as Draft); const index = preview.drafts.findIndex(d => d.id === draft.id);
    draft.createdAt = index < 0 ? new Date().toISOString() : preview.drafts[index]?.createdAt;
    draft.updatedAt = preview.drafts[index]?.updatedAt;
    if (index < 0 || JSON.stringify(draft) !== JSON.stringify(preview.drafts[index])) draft.updatedAt = new Date().toISOString();
    if (index < 0) preview.drafts.unshift(draft); else preview.drafts[index] = draft;
    publish(); return true as T;
  }
  if (method === 'media.rename' || method === 'media.delete') {
    const { kind, id, name } = data as { kind: string; id: string; name: string };
    if (!['voices', 'outputs'].includes(kind)) throw new CallError('@yovoice.error.audioKindInvalid');
    if (method === 'media.rename') {
      if (!name?.trim() || name.trim().length > 120) throw new CallError('@yovoice.error.nameLength');
      if (kind === 'voices') preview.voices = preview.voices.map(v => v.id === id ? { ...v, name: name.trim() } : v);
      else preview.history = preview.history.map(v => v.id === id ? { ...v, title: name.trim() } : v);
    } else {
      const item = kind === 'voices' ? preview.voices.find(v => v.id === id) : preview.history.find(v => v.id === id);
      if (kind === 'outputs' && preview.drafts.some(d => d.timeline?.tracks.some(t => t.clips.some(c => c.generationId === id)))) throw new CallError('@yovoice.timeline.inUse');
      if (kind === 'voices') {
        const uses = (s: SynthesisSettings) => s.voiceId === id || s.emotionVoiceId === id;
        const draftUses = (d: Draft) => uses(d) || (d.performance && uses(d.performance.settings)) || d.subtitles?.speakers.some(s => s.settings && uses(s.settings)) || d.subtitles?.cues.some(c => c.performance && uses(c.performance.settings));
        const names = [...preview.characters.filter(c => uses(c.settings) || c.performances?.some(p => uses(p.settings)) || (c.preview && uses(c.preview.settings))).map(c => c.name), ...preview.drafts.filter(draftUses).map(d => d.title), ...preview.history.filter(g => draftUses(g.settings)).map(g => g.title)];
        if (names.length) throw new CallError('@yovoice.error.voiceReferenced', { names: names.join(', ') });
        preview.voices = preview.voices.filter(v => v.id !== id);
        preview.drafts = preview.drafts.map(d => ({ ...d, voiceId: d.voiceId === id ? null : d.voiceId, emotionVoiceId: d.emotionVoiceId === id ? null : d.emotionVoiceId }));
      } else preview.history = preview.history.filter(v => v.id !== id);
      if (item && ![...preview.voices, ...preview.history].some(v => v.fileName === item.fileName)) {
        const db = await database();
        try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').delete(item.fileName); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
      }
    }
    publish(); return true as T;
  }
  if (method === 'draft.delete') { preview.drafts = preview.drafts.filter(draft => draft.id !== (data as { id: string }).id); publish(); return true as T; }
  if (method === 'preferences.save') { preview.preferences = data as Preferences; publish(); return true as T; }
  if (method === 'voice.record') {
    const recording = data as { base64: string; name: string };
    const bytes = Uint8Array.from(atob(recording.base64), c => c.charCodeAt(0));
    return await importVoiceFile(new File([bytes], `${recording.name}.wav`, { type: 'audio/wav' })) as T;
  }
  throw new CallError('@yovoice.error.previewDesktopOnly');
}
function database(): Promise<IDBDatabase> { return new Promise((resolve, reject) => {
  const request = indexedDB.open('voice-workbench-audio', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('audio');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
}); }
async function blobStore(key: string, value?: Blob): Promise<Blob | undefined> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const transaction = db.transaction('audio', value ? 'readwrite' : 'readonly');
    const request = value ? transaction.objectStore('audio').put(value, key) : transaction.objectStore('audio').get(key);
    transaction.oncomplete = () => resolve(value ?? request.result); transaction.onerror = () => reject(transaction.error);
  }); } finally { db.close(); }
}
export async function importTimelineFile(file: File): Promise<AudioAsset> {
  if (file.size > 20 * 1024 * 1024) throw new CallError('@yovoice.error.audioTooLarge');
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 120);
  if (native) return call<AudioAsset>('timeline.import', { name, base64: await toBase64(file) });
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration < 0.01 || buffer.duration > 3600) throw new CallError('@yovoice.timeline.importDuration');
    const id = crypto.randomUUID().replaceAll('-', '');
    const asset = { id, name, fileName: `import-${id}.wav`, duration: buffer.duration };
    await blobStore(asset.fileName, encodeWav(buffer));
    return asset;
  } finally { await context.close(); }
}

export async function importVoiceFile(file: File): Promise<Voice> {
  if (file.size > 20 * 1024 * 1024) throw new CallError('@yovoice.error.audioTooLarge');
  if (native) return call<Voice>('voice.record', { name: file.name.replace(/\.[^.]+$/, ''), base64: await toBase64(file) });
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (decoded.duration < 1 || decoded.duration > 60) throw new CallError('@yovoice.error.audioDuration');
    const wav = encodeWav(decoded);
    const id = crypto.randomUUID().replaceAll('-', '');
    const voice = { id, name: file.name.replace(/\.[^.]+$/, ''), fileName: id + '.wav', duration: decoded.duration };
    await blobStore(voice.fileName, wav); preview.voices.push(voice); publish(); return voice;
  } finally { await context.close(); }
}
export async function mediaUrl(kind: 'voices' | 'outputs', file: string): Promise<string> {
  if (native && window.__workbenchMediaBase) return `${window.__workbenchMediaBase}${kind}/${encodeURIComponent(file)}`;
  if (native) return `https://${kind}.workbench.local/${encodeURIComponent(file)}`;
  const blob = await blobStore(file); if (!blob) throw new CallError('@yovoice.error.audioBlobMissing'); return URL.createObjectURL(blob);
}

export async function saveAudio(blob: Blob, name: string): Promise<boolean> {
  const fileName = `${name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) || 'yovoice'}.wav`;
  if (native) return call<boolean>('audio.export', { name: fileName, base64: await toBase64(blob) });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
