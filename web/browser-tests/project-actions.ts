import type { Page } from '@playwright/test';

export async function openProjectHistory(page: Page) {
  const title = await page.getByLabel('作品名称', { exact: true }).inputValue();
  await page.getByTestId('nav-text').click();
  const card = page.locator('.project-library-row:visible').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '历史版本', exact: true }).click();
}
