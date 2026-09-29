import { PlaybackToolbar, TrackZoom } from './playback-toolbar';
import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Button } from '@astryxdesign/core/Button';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { ResizeHandle } from '@astryxdesign/core/Resizable';
import { useAudioPanel } from './use-audio-panel';
import { useTranslator } from '@astryxdesign/core/i18n';
import { Upload, History, FileAudio, Plus, Scissors, Trash2, Volume2, VolumeX, RefreshCw, GripVertical } from 'lucide-react';
import { AppDialog } from '../../shared/ui/app-dialog';
import { TextInput } from '@astryxdesign/core/TextInput';
import { SpeakerAvatar } from '../create/subtitles';
import { encodeWav } from '../../shared/lib/sound';
import { mediaUrl, saveAudio, importTimelineFile } from '../../shared/lib/client';
import { formatTime, projectKind, type AudioAsset, type AudioClip, type AudioTimeline, type Generation, type Draft } from '../../shared/workbench';
import { Timeline } from './timeline';

export function TimelineEditor({ draft, busy, regenerate, selectCue, value, history, change, suspended, onError }: {
  draft: Draft; busy: boolean; regenerate: (cueId: string, clipId: string) => Promise<void>; selectCue: (index: number) => void;
  value: AudioTimeline; history: Generation[]; change: (value: AudioTimeline) => void; suspended: boolean; onError: (message: string) => void;
}) {
  const t = useTranslator();
  const panel = useAudioPanel(value.tracks.length > 0, 'audio-multitrack-height');
  const input = useRef<HTMLInputElement>(null);
  const uploadTrack = useRef('');
  const latest = useRef(value);
  latest.current = value;
  const [importing, setImporting] = useState(false);
  const [historyTrack, setHistoryTrack] = useState('');
  const [historyQuery, setHistoryQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [trimPreview, setTrimPreview] = useState<AudioTimeline | null>(null);
  const trimDrag = useRef<{ value: AudioTimeline; next: AudioTimeline; id: string; edge: 'start' | 'end'; sourceDuration: number; x: number; pixelsPerSecond: number; scroll: HTMLElement; scrollLeft: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportName, setExportName] = useState(draft.title);
  const [exportError, setExportError] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [peaks, setPeaks] = useState<Record<string, number[]>>({});
  const [zoom, setZoom] = useState(1);
  const context = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const sources = useRef<AudioBufferSourceNode[]>([]);
  const frame = useRef(0);
  const operation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const draggedOffset = useRef(0);
  const duration = Timeline.duration(value);
  const scale = Math.max(duration * 1.2 + 2, 10);
  const clip = (trimPreview ?? value).tracks.flatMap(track => track.clips).find(c => c.id === selected);
  const audioSources = new Map<string, { title: string; duration: number; fileName: string; segment?: Generation['segment'] }>([
    ...history.map(g => [g.id, g] as const),
    ...(value.assets ?? []).map(asset => [`asset:${asset.id}`, { ...asset, title: asset.name }] as const),
  ]);
  const generation = clip ? audioSources.get(Timeline.sourceKey(clip)) : undefined;
  const cueIndex = draft.subtitles?.cues.findIndex(c => c.id === generation?.segment?.cueId) ?? -1;
  const cue = draft.subtitles?.cues[cueIndex];
  const stop = () => {
    operation.current++;
    cancelAnimationFrame(frame.current);
    for (const source of sources.current) { source.stop(); source.disconnect(); }
    sources.current = [];
    setPlaying(false); setLoading(false);
  };
  useEffect(() => {
    abort.current = new AbortController();
    return () => {
      operation.current++; cancelAnimationFrame(frame.current); abort.current?.abort();
      for (const source of sources.current) { source.stop(); source.disconnect(); }
      sources.current = []; buffers.current.clear();
      const current = context.current; context.current = null;
      if (current) void current.close();
    };
  }, []);
  useEffect(() => { if (suspended) stop(); }, [suspended]);
  useEffect(() => { stop(); trimDrag.current = null; setTrimPreview(null); }, [value]);
  const edit = (next: AudioTimeline) => { stop(); change(next); };
  const load = async (id: string, audio: AudioContext): Promise<AudioBuffer> => {
    const cached = buffers.current.get(id);
    if (cached) return cached;
    const generation = audioSources.get(id);
    if (!generation) throw new Error('@yovoice.error.audioMissing');
    const url = await mediaUrl('outputs', generation.fileName);
    try {
      const response = await fetch(url, { signal: abort.current?.signal });
      if (!response.ok) throw new Error('@yovoice.error.audioReadFailed');
      const buffer = await audio.decodeAudioData(await response.arrayBuffer());
      buffers.current.set(id, buffer);
      return buffer;
    } finally { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }
  };
  const sourceIds = [...new Set(value.tracks.flatMap(track => track.clips.map(c => Timeline.sourceKey(c))))].sort().join(',');
  useEffect(() => {
    let active = true;
    const audio = context.current ??= new AudioContext();
    void (async () => {
      for (const id of sourceIds.split(',').filter(Boolean)) {
        try {
          const buffer = await load(id, audio);
          if (!active) return;
          const samples = buffer.getChannelData(0);
          const stride = Math.max(1, Math.ceil(samples.length / 400));
          const waveform = Array.from({ length: 400 }, (_, index) => {
            let peak = 0;
            for (let n = index * stride; n < Math.min(samples.length, (index + 1) * stride); n += 8) peak = Math.max(peak, Math.abs(samples[n]));
            return peak;
          });
          setPeaks(previous => ({ ...previous, [id]: waveform }));
        } catch (error) { if (active) onError((error as Error).message); }
      }
    })();
    return () => { active = false; };
  }, [sourceIds]);
  const play = async () => {
    if (playing || loading) { stop(); return; }
    const token = ++operation.current;
    setLoading(true);
    try {
      const audio = context.current ??= new AudioContext();
      await audio.resume();
      if (token !== operation.current) return;
      const from = time >= duration ? 0 : time;
      const clips = value.tracks.filter(track => !track.muted).flatMap(track => track.clips).filter(c => c.start + c.duration > from);
      // 先解码全部源，再共用同一时钟启动，避免音轨随加载速度错位。
      for (const id of new Set(clips.map(c => Timeline.sourceKey(c)))) {
        await load(id, audio);
        if (token !== operation.current) return;
      }
      const start = audio.currentTime + 0.05;
      for (const c of clips) {
        const buffer = buffers.current.get(Timeline.sourceKey(c))!;
        if (c.offset + c.duration > buffer.duration + 0.02) throw new Error('@yovoice.timeline.invalid');
        const range = Timeline.playback(c, from);
        const source = audio.createBufferSource();
        source.buffer = buffer; source.connect(audio.destination);
        source.start(start + range.delay, range.offset, range.duration);
        sources.current.push(source);
      }
      setLoading(false); setPlaying(true);
      const tick = () => {
        const next = Math.min(duration, from + Math.max(0, audio.currentTime - start));
        setTime(next);
        if (next >= duration) stop(); else frame.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (error) { if (token === operation.current) { stop(); onError((error as Error).message); } }
  };
  const seek = (next: number) => { stop(); setTime(next); };
  const addTrack = () => edit({ ...value, tracks: [...value.tracks, { id: crypto.randomUUID(), name: t('@yovoice.timeline.track', { n: value.tracks.length + 1 }), muted: false, clips: [] }] });
  const append = (trackId: string, source: { duration: number; generationId?: string; assetId?: string }, asset?: AudioAsset) => {
    const current = latest.current;
    const lane = current.tracks.find(t => t.id === trackId);
    if (!lane) throw new Error('@yovoice.timeline.invalid');
    const start = Math.max(0, ...lane.clips.map(c => c.start + c.duration));
    if (current.tracks.reduce((sum, t) => sum + t.clips.length, 0) >= 2000 || source.duration < 0.01 || start + source.duration > 86400) throw new Error('@yovoice.timeline.invalid');
    if (asset && (current.assets?.length ?? 0) >= 2000) throw new Error('@yovoice.timeline.invalid');
    const nextClip: AudioClip = { id: crypto.randomUUID(), ...source, start, offset: 0 };
    edit({ ...current, assets: asset ? [...(current.assets ?? []), asset] : current.assets, tracks: current.tracks.map(t => t.id === trackId ? { ...t, clips: [...t.clips, nextClip] } : t) });
  };
  const selectClip = (c: AudioClip) => {
    setSelected(c.id);
    const id = history.find(g => g.id === c.generationId)?.segment?.cueId;
    const index = draft.subtitles?.cues.findIndex(cue => cue.id === id) ?? -1;
    if (index >= 0) selectCue(index);
  };
  const finishTrim = (commit: boolean) => {
    const drag = trimDrag.current;
    trimDrag.current = null; setTrimPreview(null);
    if (commit && drag && drag.next !== drag.value) edit(drag.next);
  };
  return <VStack as="footer" className="multitrack audio-panel" gap={0} style={{ height: panel.size }} onKeyDown={e => {
    if (e.key === 'Escape' && !exportOpen && !historyTrack) { finishTrim(false); setSelected(''); e.stopPropagation(); }
  }}>
    <input ref={input} type="file" hidden accept="audio/*,.aac,.m4a,.mp3,.wav,.flac,.ogg,.opus,.aiff,.aif,.wma,.webm" onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = '';
      if (!file) return;
      const trackId = uploadTrack.current;
      stop(); setImporting(true);
      try {
        const asset = await importTimelineFile(file);
        if (!abort.current?.signal.aborted) append(trackId, { assetId: asset.id, duration: asset.duration }, asset);
      } catch (error) { onError((error as Error).name === 'EncodingError' ? '@yovoice.error.browserDecode' : (error as Error).message); }
      finally { setImporting(false); }
    }} />
    {historyTrack ? <AppDialog title={t('@yovoice.timeline.fromHistory')} onClose={() => setHistoryTrack('')}>
      <TextInput label={t('@yovoice.timeline.searchHistory')} isLabelHidden placeholder={t('@yovoice.timeline.searchHistory')} value={historyQuery} onChange={setHistoryQuery} hasClear />
      <VStack className="timeline-history-list" gap={1}>
        {history.filter(g => projectKind(draft) === 'text' && !g.segment && g.settings.id === draft.id && g.title.toLocaleLowerCase().includes(historyQuery.trim().toLocaleLowerCase())).map(g => <HStack key={g.id} gap={2} vAlign="center">
          <Button className="grow text-left" variant="ghost" label={g.title} onClick={() => {
            try { append(historyTrack, { generationId: g.id, duration: g.duration }); setHistoryTrack(''); }
            catch (error) { onError((error as Error).message); }
          }} /><small className="muted">{formatTime(g.duration)} · {new Date(g.createdAt).toLocaleString()}</small>
        </HStack>)}
        {!history.some(g => projectKind(draft) === 'text' && !g.segment && g.settings.id === draft.id && g.title.toLocaleLowerCase().includes(historyQuery.trim().toLocaleLowerCase())) ? <p className="muted">{t('@yovoice.timeline.noHistory')}</p> : null}
      </VStack>
    </AppDialog> : null}
    <ResizeHandle label={t('@yovoice.timeline.resize')} direction="vertical" isReversed resizable={panel.props} />
    <PlaybackToolbar time={time} duration={duration} playing={playing} disabled={!duration || suspended || exporting} loading={loading} toggle={() => void play()}>
      <Button size="sm" variant="ghost" isIconOnly tooltip={t('@yovoice.timeline.split')} label={t('@yovoice.timeline.split')} icon={<Scissors />} isDisabled={!clip || time - clip.start < 0.01 || clip.start + clip.duration - time < 0.01} onClick={() => edit(Timeline.split(value, selected, time))} />
      <Button size="sm" variant="ghost" isIconOnly tooltip={t('@yovoice.timeline.removeClip')} label={t('@yovoice.timeline.removeClip')} icon={<Trash2 />} isDisabled={!clip} onClick={() => { edit({ ...value, tracks: value.tracks.map(track => ({ ...track, clips: track.clips.filter(c => c.id !== selected) })) }); setSelected(''); }} />
      <Button size="sm" variant="ghost" isIconOnly icon={<RefreshCw />} label={t('@yovoice.timeline.regenerate')} tooltip={t('@yovoice.timeline.regenerateHint')} isLoading={regenerating} isDisabled={!cue?.text.trim() || busy || exporting} onClick={async () => {
        if (!cue?.id || !clip) return; stop(); setRegenerating(true);
        try { await regenerate(cue.id, clip.id); } catch (error) { onError((error as Error).message); } finally { setRegenerating(false); }
      }} />
      <Button size="sm" label={t('@yovoice.timeline.export')} isDisabled={!value.tracks.some(t => !t.muted && t.clips.length) || exporting} onClick={() => { stop(); setExportError(''); setExportName(draft.title); setExportOpen(true); }} />
      <TrackZoom value={zoom} change={setZoom} disabled={!duration} />
    </PlaybackToolbar>
    {exportOpen ? <AppDialog title={t('@yovoice.timeline.export')} busy={exporting} error={exportError.startsWith('@yovoice.') ? t(exportError) : exportError} onClose={() => setExportOpen(false)} actions={<Button label={t('@yovoice.timeline.exportConfirm')} variant="primary" isLoading={exporting} isDisabled={!exportName.trim()} onClick={async () => {
      setExporting(true); setExportError('');
      try {
        const snapshot = structuredClone(value);
        const audio = context.current ??= new AudioContext();
        const result = await Timeline.render(snapshot, id => load(id, audio));
        if (await saveAudio(encodeWav(result), exportName)) setExportOpen(false);
      } catch (error) { setExportError((error as Error).message); } finally { setExporting(false); }
    }} />}><TextInput label={t('@yovoice.timeline.exportName')} value={exportName} onChange={setExportName} /><small>{t('@yovoice.timeline.exportFormat')}</small></AppDialog> : null}
    <VStack className="multitrack-scroll" gap={0} onPointerDown={e => {
      if (!(e.target as Element).closest('button, input, [role="slider"], [role="menuitem"]')) setSelected('');
    }}>
      <VStack className="multitrack-content" gap={0} style={{ width: `${zoom * 100}%` }}>
        <HStack gap={0} className="multitrack-ruler-row">
          <small className="multitrack-label">{t('@yovoice.timeline.tracks')}</small>
          <VStack className="multitrack-ruler" gap={0}>
            <HStack gap={0} hAlign="between" aria-hidden="true">{Array.from({ length: 11 }, (_, i) => <small key={i}>{Number((scale * i / 10).toFixed(1))}s</small>)}</HStack>
            <input type="range" aria-label={t('@yovoice.player.progress')} min={0} max={scale} step={0.01} value={Math.min(time, scale)} onChange={e => seek(Number(e.target.value))} />
          </VStack>
        </HStack>
        {(trimPreview ?? value).tracks.map(track => <HStack key={track.id} className="multitrack-row" gap={0}>
          <VStack className="multitrack-label" gap={0} vAlign="center" aria-label={track.name}>
            <HStack gap={0}><Button size="sm" variant="ghost" isIconOnly label={t(track.muted ? '@yovoice.timeline.unmute' : '@yovoice.timeline.mute', { name: track.name })} icon={track.muted ? <VolumeX /> : <Volume2 />} aria-pressed={track.muted} onClick={() => edit({ ...value, tracks: value.tracks.map(lane => lane.id === track.id ? { ...lane, muted: !lane.muted } : lane) })} /><Button size="sm" variant="ghost" isIconOnly label={t('@yovoice.timeline.removeTrack', { name: track.name })} icon={<Trash2 />} isDisabled={track.clips.length > 0} onClick={() => edit({ ...value, tracks: value.tracks.filter(lane => lane.id !== track.id) })} /></HStack>
          </VStack>
          <VStack className="multitrack-lane" gap={0} aria-label={track.name} onDragOver={e => e.preventDefault()} onDrop={e => {
            e.preventDefault(); const id = e.dataTransfer.getData('text/yovoice-clip');
            const rect = e.currentTarget.getBoundingClientRect();
            edit(Timeline.move(value, id, track.id, Math.max(0, (e.clientX - rect.left) / rect.width * scale - draggedOffset.current)));
          }}>
            {track.clips.map(c => <HStack key={c.id} className="multitrack-region" gap={0} data-selected={selected === c.id} style={{ left: `${c.start / scale * 100}%`, width: `${c.duration / scale * 100}%`, opacity: track.muted ? 0.5 : 1 }}>
              <Button size="sm" variant="secondary" className="multitrack-clip" label={audioSources.get(Timeline.sourceKey(c))?.title ?? t('@yovoice.timeline.missing')} aria-pressed={selected === c.id} icon={<>{history.find(g => g.id === c.generationId)?.segment ? <SpeakerAvatar seed={`${draft.id}:${history.find(g => g.id === c.generationId)!.segment!.speakerId}`} /> : null}{peaks[Timeline.sourceKey(c)] ? <svg className="clip-waveform" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true">{peaks[Timeline.sourceKey(c)].slice(Math.floor(c.offset / buffers.current.get(Timeline.sourceKey(c))!.duration * 400), Math.ceil((c.offset + c.duration) / buffers.current.get(Timeline.sourceKey(c))!.duration * 400)).map((peak, i, values) => <line key={i} x1={i / values.length * 400} x2={i / values.length * 400} y1={20 - peak * 18} y2={20 + peak * 18} />)}</svg> : null}</>} draggable onDragStart={e => { stop(); selectClip(c); e.dataTransfer.setData('text/yovoice-clip', c.id); const rect = e.currentTarget.getBoundingClientRect(); draggedOffset.current = (e.clientX - rect.left) / rect.width * c.duration; }} onClick={() => selectClip(c)} onKeyDown={e => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                e.preventDefault(); selectClip(c);
                const lane = value.tracks.indexOf(track);
                const destination = value.tracks[lane + (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0)];
                const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
                if (destination) edit(Timeline.move(value, c.id, destination.id, Math.max(0, Math.min(86400 - c.duration, c.start + delta * (e.shiftKey ? 0.1 : 0.01)))));
              }} />
              {(['start', 'end'] as const).map(edge => <Button key={edge} size="sm" variant="ghost" isIconOnly icon={<GripVertical />} className="multitrack-trim" data-edge={edge}
                label={t(edge === 'start' ? '@yovoice.timeline.trimStart' : '@yovoice.timeline.trimEnd')} role="slider" aria-orientation="horizontal"
                aria-valuemin={edge === 'start' ? Math.max(0, c.offset - c.start) : c.offset + 0.01}
                aria-valuemax={edge === 'start' ? c.offset + c.duration - 0.01 : audioSources.get(Timeline.sourceKey(c))?.duration ?? c.offset + c.duration}
                aria-valuenow={Number((edge === 'start' ? c.offset : c.offset + c.duration).toFixed(2))}
                onPointerDown={e => {
                  if (e.button !== 0) return;
                  const sourceDuration = audioSources.get(Timeline.sourceKey(c))?.duration;
                  if (!sourceDuration) return;
                  e.preventDefault(); e.stopPropagation(); stop(); selectClip(c);
                  e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
                  const lane = e.currentTarget.closest('.multitrack-lane')!;
                  const scroll = e.currentTarget.closest('.multitrack-scroll') as HTMLElement;
                  trimDrag.current = { value, next: value, id: c.id, edge, sourceDuration, x: e.clientX, pixelsPerSecond: lane.getBoundingClientRect().width / scale, scroll, scrollLeft: scroll.scrollLeft };
                }} onPointerMove={e => {
                  const drag = trimDrag.current;
                  if (!drag) return;
                  const delta = (e.clientX - drag.x + drag.scroll.scrollLeft - drag.scrollLeft) / drag.pixelsPerSecond;
                  drag.next = Timeline.trimEdge(drag.value, drag.id, drag.edge, Math.round(delta * 100) / 100, drag.sourceDuration);
                  setTrimPreview(drag.next);
                }} onPointerUp={() => finishTrim(true)} onPointerCancel={() => finishTrim(false)} onLostPointerCapture={() => finishTrim(false)}
                onKeyDown={e => {
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  e.preventDefault(); selectClip(c);
                  edit(Timeline.trimEdge(value, c.id, edge, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01), audioSources.get(Timeline.sourceKey(c))?.duration ?? 0));
                }} />)}
            </HStack>)}
            <i className="multitrack-playhead" aria-hidden="true" style={{ left: `${Math.min(time, scale) / scale * 100}%` }} />
            <HStack className="multitrack-add-audio" gap={0} style={{ left: `calc(${Math.max(0, ...track.clips.map(c => c.start + c.duration)) / scale * 100}% + var(--spacing-2))` }}>
              <DropdownMenu className="timeline-audio-menu" presentation="popover" placement="above" alignment="start" hasChevron={false} menuWidth="max-content"
                button={{ size: 'sm', variant: 'secondary', className: 'timeline-audio-button', icon: <FileAudio />, label: t('@yovoice.timeline.audio'), 'aria-label': t('@yovoice.timeline.importTo', { name: track.name }), isLoading: importing && uploadTrack.current === track.id, isDisabled: importing }}
                items={[
                  { label: t('@yovoice.timeline.upload'), icon: Upload, onClick: () => { uploadTrack.current = track.id; input.current?.click(); } },
                  ...(projectKind(draft) === 'text' ? [{ label: t('@yovoice.timeline.fromHistory'), icon: History, onClick: () => { stop(); setHistoryQuery(''); setHistoryTrack(track.id); } }] : []),
                ]} />
            </HStack>
          </VStack>
        </HStack>)}
        <HStack gap={0}>
          <HStack className="multitrack-label" gap={0}>
            <Button size="sm" variant="secondary" label={t('@yovoice.timeline.add')} icon={<Plus />} isDisabled={value.tracks.length >= 32} onClick={addTrack} />
          </HStack>
        </HStack>
      </VStack>
    </VStack>
  </VStack>;
}
