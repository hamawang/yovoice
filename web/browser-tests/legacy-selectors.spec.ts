import { test, expect } from '@playwright/test';

for (const platform of ['macos', 'windows']) {
  test(`${platform} 缺少 CSS 锚点定位时使用原生下拉框，并保存模型、语言和设置`, async ({ page }) => {
    await page.addInitScript(platform => {
      Object.assign(window, { __workbenchPlatform: platform });
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (property: string, value?: string) => property === 'anchor-name' || property === 'position-area'
        ? false : value === undefined ? supports(property) : supports(property, value);
    }, platform);
    await page.goto('/');
    const model = page.getByRole('combobox', { name: '模型', exact: true });
    await expect(model).toHaveJSProperty('tagName', 'SELECT');
    await model.selectOption('voxcpm2-q8');
    await expect(model).toHaveValue('voxcpm2-q8');
    await model.selectOption('qwen3-tts-customvoice-q8');
    const speaker = page.getByRole('combobox', { name: '内置音色', exact: true });
    await expect(speaker).toHaveJSProperty('tagName', 'SELECT');
    await speaker.selectOption('Ryan');
    await page.getByText('高级设置', { exact: true }).click();
    const chunkMode = page.getByRole('combobox', { name: '分段方式', exact: true });
    await expect(chunkMode).toHaveJSProperty('tagName', 'SELECT');
    await chunkMode.selectOption('tag_aware');
    await model.selectOption('index-2.5-q8');
    await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
    await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('combobox', { name: '语言', exact: true })).toHaveValue('en');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('.astryx-selector-popup:visible')).toHaveCount(0);
  });
}

for (const platform of ['macos', 'windows']) {
  test(`${platform} 支持定位时模型选择框在下方展开，作品不再提供归档筛选`, async ({ page }, testInfo) => {
    await page.addInitScript(platform => Object.assign(window, { __workbenchPlatform: platform }), platform);
    await page.goto('/');
    const model = page.getByRole('combobox', { name: '模型', exact: true });
    await expect(model).not.toHaveJSProperty('tagName', 'SELECT');
    await model.click();
    const popup = page.locator('.astryx-selector-popup:visible');
    await expect.poll(async () => {
      const trigger = await model.boundingBox();
      const menu = await popup.boundingBox();
      return !!trigger && !!menu && menu.y >= trigger.y + trigger.height;
    }).toBe(true);
    await page.getByRole('option', { name: /VoxCPM2 · Q8/ }).click();
    await expect(model).toContainText('VoxCPM2');
    await page.getByTestId('nav-text').click();
    await expect(page.getByRole('combobox', { name: '进行中' })).toHaveCount(0);
  });
}

test('缺少 Popover API 时使用原生选择框', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(HTMLElement.prototype, 'showPopover', { value: undefined, configurable: true }));
  await page.goto('/');
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  await expect(model).toHaveJSProperty('tagName', 'SELECT');
  await model.selectOption('voxcpm2-q8');
  await expect(model).toHaveValue('voxcpm2-q8');
});
