import { test, expect } from '@playwright/test';
import { emptyState } from '../src/shared/workbench';

test('故事和语音卡片整面可打开，键盘和更多菜单独立操作', async ({ page }) => {
  const state = emptyState();
  const base = { ...state.drafts[0], text: '卡片摘要内容', createdAt: '2026-09-28T08:00:00Z' };
  state.drafts = [
    { ...base, id: 'speech', kind: 'text', title: '测试语音' },
    { ...base, id: 'story', kind: 'story', title: '测试故事', subtitles: { speakers: [{ id: 'speaker', sourceName: '旁白' }], cues: [{ id: 'cue', start: 0, end: 1000, speakerId: 'speaker', text: base.text }] } },
  ];
  await page.addInitScript(state => localStorage.setItem('voice-workbench-v1', JSON.stringify(state)), state);
  await page.goto('/');
  for (const draft of state.drafts) {
    const nav = page.getByTestId(`nav-${draft.kind}`);
    await nav.click();
    const card = page.locator('.project-library-row:visible').filter({ hasText: draft.title });
    // 用坐标点击，确保验证真实命中区域，不让定位器绕过覆盖层。
    for (const area of ['padding', '.project-avatars', '.project-created', '.project-excerpt']) {
      const box = (await (area === 'padding' ? card : card.locator(area)).boundingBox())!;
      await page.mouse.click(area === 'padding' ? box.x + box.width - 6 : box.x + box.width / 2, area === 'padding' ? box.y + box.height - 6 : box.y + box.height / 2);
      await expect(page.getByLabel('作品名称')).toHaveValue(draft.title);
      await expect(card).toBeHidden();
      await nav.click();
    }
    await card.getByRole('button', { name: '更多操作', exact: true }).click();
    await expect(card).toBeVisible();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('作品名称')).toHaveValue(draft.title);
    await expect(card).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    for (const key of ['Enter', 'Space']) {
      await card.getByRole('button', { name: draft.title, exact: true }).focus();
      await page.keyboard.press(key);
      await expect(card).toBeHidden();
      await expect(page.getByLabel('作品名称')).toHaveValue(draft.title);
      await nav.click();
    }
  }
});

test('最近作品悬停显示快捷删除，取消后保留作品与当前编辑', async ({ page }) => {
  await page.goto('/');
  const title = await page.getByLabel('作品名称', { exact: true }).inputValue();
  const row = page.locator('.recent-projects .project-row').first();
  const remove = row.locator('.project-quick-delete');
  await expect(remove).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(remove).toHaveCSS('opacity', '1');
  await remove.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByLabel('作品名称', { exact: true })).toHaveValue(title);
  await expect(row).toBeVisible();
});
