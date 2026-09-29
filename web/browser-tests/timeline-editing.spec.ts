import { test, expect, type Page } from '@playwright/test';
import { Timeline } from '../src/features/media/timeline';
import { emptyState, cueAudioStatus, type AudioTimeline, type State } from '../src/shared/workbench';

async function seedTimeline(page: Page, state: State) {
  await page.evaluate(async state => {
    localStorage.setItem('voice-workbench-v1', JSON.stringify(state));
    const path = '/src/shared/lib/sound.ts'; const { encodeWav } = await import(/* @vite-ignore */ path);
    const audio = new AudioBuffer({ length: 48000, sampleRate: 24000, numberOfChannels: 1 }); audio.getChannelData(0).fill(.2);
    await new Promise<void>((resolve, reject) => { const req = indexedDB.open('voice-workbench-audio', 1); req.onupgradeneeded = () => req.result.createObjectStore('audio'); req.onerror = () => reject(req.error); req.onsuccess = () => { const db = req.result; const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put(encodeWav(audio), 'g.wav'); tx.oncomplete = () => { db.close(); resolve(); }; }; });
  }, state); await page.reload();
}

test('多选保持相对位置，锁轨保护，波纹删除不影响其他轨', () => {
  const value: AudioTimeline = { tracks: [
    { id: 'a', name: '对白', muted: false, clips: [{ id: 'a', start: 1, offset: 0, duration: 2, generationId: 'g' }, { id: 'b', start: 2, offset: 0, duration: 2, generationId: 'g' }, { id: 'c', start: 5, offset: 0, duration: 1, generationId: 'g' }] },
    { id: 'b', name: '音乐', muted: false, clips: [{ id: 'music', start: 0, offset: 0, duration: 10, assetId: 'm' }] },
  ] };
  expect(Timeline.moveGroup(value, ['a', 'b'], -100).tracks[0].clips.map(c => c.start)).toEqual([0, 1, 5]);
  expect(Timeline.remove(value, ['a', 'b'], true).tracks.map(t => t.clips.map(c => c.start))).toEqual([[2], [0]]);
  expect(Timeline.remove(value, ['a']).tracks[0].clips.map(c => c.start)).toEqual([2, 5]);
  expect(Timeline.snap(value, ['a'], [4.96], 0.1, 9)).toEqual({ delta: 5 - 4.96, guide: 5 });
  const locked = { ...value, tracks: value.tracks.map(t => ({ ...t, locked: true })) };
  expect(Timeline.moveGroup(locked, ['a'], 1)).toBe(locked);
  expect(Timeline.remove(locked, ['a'], true)).toEqual(locked);
  expect(Timeline.split(locked, 'a', 2)).toEqual(locked);
  expect(Timeline.paste(value, [{ clip: value.tracks[0].clips[0], lane: 0 }, { clip: value.tracks[0].clips[1], lane: 0 }], 10, 0).tracks[0].clips.slice(-2).map(c => c.start)).toEqual([10, 11]);
  expect(Timeline.gap(value, 'c', .5).tracks[0].clips.at(-1)?.start).toBe(4.5);
  const faded = { tracks: [{ ...value.tracks[0], clips: [{ ...value.tracks[0].clips[0], fadeIn: .2, fadeOut: .3 }] }] };
  expect(Timeline.split(faded, 'a', 2).tracks[0].clips.map(c => [c.fadeIn, c.fadeOut])).toEqual([[.2, 0], [0, .3]]);
});

test('对白状态比较文本及角色参数，保位重生成不移动其他片段', () => {
  const draft = emptyState().drafts[0];
  const cue = { id: 'cue', speakerId: 's', text: '台词', start: 0, end: 1000 };
  draft.subtitles = { cues: [cue], speakers: [{ id: 's', sourceName: '旁白' }] };
  draft.timeline = { regenerateMode: 'preserve', tracks: [{ id: 't', name: 't', muted: false, clips: [{ id: 'c', generationId: 'g', start: 0, offset: 0, duration: 1 }, { id: 'b', generationId: 'b', start: 1, offset: 0, duration: 1 }] }] };
  const g = { id: 'g', title: '台词', fileName: 'g.wav', duration: 1, createdAt: '', settings: { ...draft, text: '台词' }, segment: { cueId: 'cue', speakerId: 's', speakerName: '', index: 0, batchId: 'batch' } };
  expect(cueAudioStatus(draft, [g], cue)).toBe('ready');
  expect(cueAudioStatus(draft, [g], { ...cue, text: '已改' })).toBe('stale');
  expect(cueAudioStatus({ ...draft, timeline: { tracks: [] } }, [g], cue)).toBe('missing');
  const updated = Timeline.accept(draft, [{ ...g, id: 'new', duration: 3, segment: { ...g.segment, targetClipId: 'c' } }]);
  expect(updated.timeline!.tracks[0].clips.map(c => c.start)).toEqual([0, 1]);
});

test('共同渲染链路应用淡化、音量、独听、压低及范围导出', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/features/media/timeline.ts'; const { Timeline } = await import(/* @vite-ignore */ path);
    const buffer = new AudioBuffer({ length: 96000, sampleRate: 24000, numberOfChannels: 1 }); buffer.getChannelData(0).fill(.5);
    const base = { tracks: [{ id: 'v', name: 'v', muted: false, gainDb: -6, clips: [{ id: 'v', generationId: 'v', start: 1, offset: 0, duration: 2, fadeIn: .5, fadeOut: .5 }] }, { id: 'm', name: 'm', muted: false, duckDb: 12, clips: [{ id: 'm', assetId: 'm', start: 0, offset: 0, duration: 4 }] }] };
    const mixed = await Timeline.render(base, async () => buffer);
    const selected = await Timeline.render({ ...base, tracks: [{ ...base.tracks[0], solo: true }, base.tracks[1]] }, async () => buffer, { start: 1, end: 3 });
    return { samples: [.5, 1, 1.25, 2, 2.75, 3.5].map(t => mixed.getChannelData(0)[Math.floor(t * 24000)]), duration: selected.duration, selected: [.001, .25, 1, 1.75].map(t => selected.getChannelData(0)[Math.floor(t * 24000)]), peak: Timeline.peak(mixed) };
  });
  const voice = .5 * 10 ** (-6 / 20), music = .5 * 10 ** (-12 / 20);
  [.5, music, music + voice / 2, music + voice, music + voice / 2, .5].forEach((x, i) => expect(result.samples[i]).toBeCloseTo(x, 3));
  expect(result.duration).toBe(2); expect(result.selected[0]).toBeLessThan(.001); expect(result.selected[1]).toBeCloseTo(voice / 2, 3); expect(result.selected[2]).toBeCloseTo(voice, 3); expect(result.peak).toBeCloseTo(.5, 3);
});

test('菜单、多选快捷键、锁轨与标尺循环选区', async ({ page }, testInfo) => {
  await page.goto('/'); const state = emptyState(), d = state.drafts[0];
  d.kind = 'story'; d.subtitles = { speakers: [{ id: 's', sourceName: '旁白' }], cues: [{ id: 'c1', speakerId: 's', text: '第一句', start: 0, end: 2000 }, { id: 'c2', speakerId: 's', text: '第二句', start: 3000, end: 5000 }] };
  d.text = '第一句\n第二句';
  d.timeline = { tracks: [{ id: 't', name: '对白', muted: false, clips: [{ id: 'a', generationId: 'g', start: 0, offset: 0, duration: 2 }, { id: 'b', generationId: 'g2', start: 3, offset: 0, duration: 2 }] }] };
  state.history = ['g', 'g2'].map((id, index) => ({ id, title: `台词 ${index + 1}`, fileName: 'g.wav', duration: 2, createdAt: '', settings: d, segment: { batchId: 't', cueId: `c${index + 1}`, speakerId: 's', speakerName: '旁白', index } }));
  d.timeline.acceptedGenerations = ['g', 'g2'];
  await seedTimeline(page, state);
  await page.locator('.multitrack-clip').first().click();
  const fade = (await page.getByRole('button', { name: '淡入', exact: true }).boundingBox())!;
  await page.mouse.move(fade.x + fade.width / 2, fade.y + fade.height / 2); await page.mouse.down(); await page.mouse.move(fade.x + 40, fade.y + fade.height / 2, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.clip-fade-curve')).toHaveCount(1);
  await page.keyboard.press('Meta+z'); await expect(page.locator('.clip-fade-curve')).toHaveCount(0);
  await page.locator('.multitrack-clip').first().click(); await page.keyboard.press('Escape');
  await expect(page.locator('.multitrack-region[data-selected="true"]')).toHaveCount(0);
  await page.locator('[data-cue-index="0"] textarea').click();
  await expect(page.locator('.multitrack-region[data-selected="true"]')).toHaveAttribute('data-clip-id', 'a');
  await page.locator('.multitrack-clip').first().click({ button: 'right' });
  const context = page.getByRole('menu', { name: '剪辑菜单' });
  await expect(context).toBeVisible(); await expect(context.getByRole('menuitem', { name: /复制一份/ })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.locator('.multitrack-clip').nth(1).click({ modifiers: ['Meta'] });
  await expect(page.locator('.multitrack-region[data-selected="true"]')).toHaveCount(2);
  await page.keyboard.press('Meta+d'); await expect(page.locator('.multitrack-clip')).toHaveCount(4);
  await page.keyboard.press('Meta+z'); await expect(page.locator('.multitrack-clip')).toHaveCount(2);
  await page.getByRole('button', { name: '对白 设置', exact: true }).click();
  await page.getByRole('button', { name: '锁定音轨', exact: true }).click(); await page.keyboard.press('Escape');
  await page.locator('.multitrack-clip').first().click(); await page.keyboard.press('Delete'); await expect(page.locator('.multitrack-clip')).toHaveCount(2);
  await page.getByRole('button', { name: '对白 设置', exact: true }).click(); await page.getByRole('button', { name: '解锁音轨', exact: true }).click(); await page.keyboard.press('Escape');
  const ruler = (await page.locator('.multitrack-ruler').boundingBox())!;
  await page.mouse.move(ruler.x + ruler.width * .05, ruler.y + ruler.height / 2); await page.mouse.down(); await page.mouse.move(ruler.x + ruler.width * .15, ruler.y + ruler.height / 2, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.multitrack-ruler .timeline-range')).toBeVisible();
  await page.getByRole('button', { name: '循环试听', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click(); await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await page.waitForTimeout(1400); await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible(); await page.getByRole('button', { name: '循环试听', exact: true }).click(); await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible({ timeout: 2500 });
  await page.getByRole('button', { name: '音轨选项', exact: true }).click(); await page.getByRole('button', { name: '场景标记', exact: true }).click();
  await page.getByRole('textbox', { name: '场景名称', exact: true }).fill('开场'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '开场', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('editing.png') });
  await page.getByRole('button', { name: '放大音轨', exact: true }).click();
  const scroll = page.locator('.multitrack-scroll');
  const viewport = (await scroll.boundingBox())!, x = viewport.x + viewport.width * .6;
  const beforeZoom = (await page.locator('.multitrack-ruler').boundingBox())!;
  await page.mouse.move(x, viewport.y + 15); await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await expect(page.getByRole('button', { name: '适应完整音轨', exact: true })).toHaveText('250%');
  const afterZoom = (await page.locator('.multitrack-ruler').boundingBox())!;
  expect((x - beforeZoom.x) / beforeZoom.width).toBeCloseTo((x - afterZoom.x) / afterZoom.width, 2);
  await scroll.evaluate(e => { e.scrollLeft = 0; });
  const body = (await page.locator('.multitrack-clip').first().boundingBox())!;
  await page.keyboard.down('Alt'); await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2); await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width - 5, body.y + body.height / 2, { steps: 8 });
  await expect.poll(() => scroll.evaluate(e => e.scrollLeft)).toBeGreaterThan(60);
  await page.mouse.up(); await page.keyboard.up('Alt');
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => page.locator('[data-clip-id="a"]').evaluate(e => e.style.left)).toBe('0%');
});

test('长故事默认展开并横向滚动，显示全部仅由用户主动触发', async ({ page }, testInfo) => {
  await page.goto('/'); const state = emptyState(), draft = state.drafts[0];
  draft.timeline = { tracks: [{ id: 't', name: '对白', muted: false, clips: Array.from({ length: 83 }, (_, i) => ({ id: `clip-${i}`, generationId: 'g', start: i * 2, offset: 0, duration: 2 })) }] };
  state.history = [{ id: 'g', title: '悟空，一棒打下，妖精脱了躯壳逃走。', fileName: 'g.wav', duration: 2, createdAt: '', settings: draft }];
  await seedTimeline(page, state);
  const scroll = page.locator('.multitrack-scroll'), first = page.locator('.multitrack-clip').first();
  const initial = (await first.boundingBox())!;
  expect(initial.width).toBeGreaterThan(150);
  await expect.poll(() => scroll.evaluate(e => e.scrollWidth / e.clientWidth)).toBeGreaterThan(10);
  await expect(page.getByRole('button', { name: '适应完整音轨', exact: true })).toHaveText('100%');
  await page.screenshot({ path: testInfo.outputPath('long-story.png') });
  await scroll.evaluate(e => { e.scrollLeft = e.scrollWidth - e.clientWidth; });
  await expect.poll(async () => Number((await page.locator('.timeline-tick').first().textContent())!.replace('s', ''))).toBeGreaterThan(140);
  await expect(page.locator('.timeline-tick')).not.toHaveCount(0);
  expect(await page.locator('.timeline-tick').count()).toBeLessThan(30);
  expect((await first.boundingBox())!.width).toBeCloseTo(initial.width, 1);
  await page.getByRole('button', { name: '适应完整音轨', exact: true }).click();
  await expect.poll(() => scroll.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThan(2);
  expect((await first.boundingBox())!.width).toBeLessThan(30);
});
