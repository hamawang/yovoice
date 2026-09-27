import { projectKind, type AudioClip, type AudioTimeline, type Draft, type Generation } from '../../shared/workbench';

// 所有剪辑使用源音频范围，不改写生成文件。
export class Timeline {
  static sourceKey(clip: AudioClip): string {
    return clip.assetId ? `asset:${clip.assetId}` : clip.generationId ?? '';
  }

  static duration(value: AudioTimeline): number {
    return Math.max(0, ...value.tracks.flatMap(track => track.clips.map(clip => clip.start + clip.duration)));
  }

  static split(value: AudioTimeline, id: string, time: number): AudioTimeline {
    if (!Number.isFinite(time) || value.tracks.reduce((sum, track) => sum + track.clips.length, 0) >= 2000) return value;
    return { ...value, tracks: value.tracks.map(track => ({ ...track, clips: track.clips.flatMap(clip => {
      const left = time - clip.start;
      if (clip.id !== id || left < 0.01 || clip.duration - left < 0.01) return [clip];
      return [{ ...clip, duration: left }, { ...clip, id: crypto.randomUUID(), start: time, offset: clip.offset + left, duration: clip.duration - left }];
    }) })) };
  }

  static move(value: AudioTimeline, id: string, laneId: string, start: number): AudioTimeline {
    const clip = value.tracks.flatMap(track => track.clips).find(c => c.id === id);
    if (!clip || !Number.isFinite(start) || start < 0 || start + clip.duration > 86400 || !value.tracks.some(t => t.id === laneId)) return value;
    return { ...value, tracks: value.tracks.map(track => ({ ...track, clips: [...track.clips.filter(c => c.id !== id), ...(track.id === laneId ? [{ ...clip, start }] : [])].sort((a, b) => a.start - b.start) })) };
  }

  static trim(value: AudioTimeline, id: string, offset: number, end: number, sourceDuration: number): AudioTimeline {
    if (![offset, end, sourceDuration].every(Number.isFinite) || offset < 0 || end > sourceDuration || end - offset < 0.01) return value;
    return { ...value, tracks: value.tracks.map(track => ({ ...track, clips: track.clips.map(c => c.id !== id || c.start + end - offset > 86400 ? c : { ...c, offset, duration: end - offset }) })) };
  }

  // 已接收的版本单独记忆，删除片段或重新打开作品不会把它再次插入。
  static accept(draft: Draft, history: Generation[]): Draft {
    const accepted = new Set(draft.timeline?.acceptedGenerations ?? []);
    const pending = history.filter(g => g.segment && g.settings.id === draft.id && !accepted.has(g.id)).slice().reverse();
    if (!pending.length) {
      // 旧故事的整篇音频作为一个片段保留，不显示历史版本列表。
      const legacy = !draft.timeline && projectKind(draft) === 'story' ? history.find(g => g.settings.id === draft.id && !g.segment) : undefined;
      if (!legacy) return draft;
      return { ...draft, timeline: { tracks: [{ id: `legacy-${legacy.id}`, name: draft.title, muted: false, clips: [{ id: legacy.id, generationId: legacy.id, start: 0, offset: 0, duration: legacy.duration }] }] } };
    }
    const timeline = structuredClone(draft.timeline ?? { tracks: [] });
    let changed = false;
    for (const g of pending) {
      const segment = g.segment!;
      if (segment.targetClipId) {
        const lane = timeline.tracks.find(t => t.clips.some(c => c.id === segment.targetClipId));
        const clip = lane?.clips.find(c => c.id === segment.targetClipId);
        if (lane && clip) {
          const end = clip.start + clip.duration;
          const delta = g.duration - clip.duration;
          if (lane.clips.some(c => (c.id === clip.id ? c.start + g.duration : c.start + c.duration + (c.start >= end ? delta : 0)) > 86400)) continue;
          lane.clips = lane.clips.map(c => c.id === clip.id ? { ...c, generationId: g.id, assetId: undefined, offset: 0, duration: g.duration } : c.start >= end ? { ...c, start: c.start + delta } : c);
        }
        // 生成期间已删除的片段不复活，保留源文件，不再次插入时间轴。
      } else {
        let lane = timeline.tracks.find(t => t.id === segment.batchId);
        if (!lane) {
          if (timeline.tracks.length >= 32) continue;
          lane = { id: segment.batchId, name: draft.title, muted: timeline.tracks.some(t => !t.muted && t.clips.length > 0), clips: [] };
          timeline.tracks.push(lane);
        }
        const start = Math.max(0, ...lane.clips.map(c => c.start + c.duration));
        if (start + g.duration > 86400 || timeline.tracks.reduce((sum, t) => sum + t.clips.length, 0) >= 2000) continue;
        lane.clips.push({ id: g.id, generationId: g.id, start, offset: 0, duration: g.duration });
      }
      changed = true; accepted.add(g.id);
    }
    return changed ? { ...draft, timeline: { ...timeline, acceptedGenerations: [...accepted] } } : draft;
  }

  static playback(clip: AudioClip, time: number) {
    const elapsed = Math.max(0, time - clip.start);
    return { delay: Math.max(0, clip.start - time), offset: clip.offset + elapsed, duration: Math.max(0, clip.duration - elapsed) };
  }

  static async render(value: AudioTimeline, load: (id: string) => Promise<AudioBuffer>): Promise<AudioBuffer> {
    const clips = value.tracks.filter(t => !t.muted).flatMap(t => t.clips);
    const duration = Math.max(0, ...clips.map(c => c.start + c.duration));
    if (!duration) throw new Error('@yovoice.timeline.emptyExport');
    // ponytail: 离线渲染限制一小时控制内存，长篇导出再换为流式文件渲染。
    if (duration > 3600) throw new Error('@yovoice.timeline.exportLimit');
    const audio = new OfflineAudioContext(1, Math.ceil(duration * 24000), 24000);
    const buffers = new Map<string, AudioBuffer>();
    for (const id of new Set(clips.map(c => Timeline.sourceKey(c)))) buffers.set(id, await load(id));
    for (const clip of clips) {
      const buffer = buffers.get(Timeline.sourceKey(clip))!;
      if (clip.offset < 0 || clip.duration <= 0 || clip.offset + clip.duration > buffer.duration + 0.001) throw new Error('@yovoice.timeline.invalid');
      const source = audio.createBufferSource(); source.buffer = buffer; source.connect(audio.destination);
      source.start(clip.start, clip.offset, clip.duration);
    }
    return audio.startRendering();
  }
}
