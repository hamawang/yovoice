import { test, expect } from '@playwright/test';
import { emptyState } from '../src/shared/workbench';

test('全局错误与任务提示不改变工作区布局，关闭后不重复出现', async ({ page }) => {
  const state = emptyState();
  await page.addInitScript(state => {
    let receive: (event: { data: unknown }) => void;
    window.addEventListener('test-state', event => {
      receive({ data: { event: 'state', state: (event as CustomEvent).detail } });
    });
    Object.assign(window, { chrome: { webview: {
      addEventListener: (_name: string, listener: typeof receive) => { receive = listener; },
      postMessage: (message: { id: string; method: string }) => {
        queueMicrotask(() => receive({ data: { id: message.id, result: message.method === 'state.get' ? { state, catalog: [] } : true } }));
      },
    } } });
  }, state);
  await page.goto('/');
  await expect(page.getByLabel('作品名称')).toBeVisible();
  const geometry = () => page.locator('.document-title, .script-editor, .inspector, .audio-panel').evaluateAll(elements =>
    elements.map(element => element.getBoundingClientRect().toJSON()));
  const original = await geometry();
  state.activity = { kind: 'generate', status: 'failed', code: '@yovoice.activity.failed', params: null, errorCode: '@yovoice.error.voiceRequired', errorParams: null, received: 0, total: 0 };
  const publish = () => page.evaluate(state => window.dispatchEvent(new CustomEvent('test-state', { detail: state })), state);
  await publish();
  const notice = page.getByRole('alert');
  await expect(notice).toContainText('请先添加音色参考音频');
  expect(await geometry()).toEqual(original);
  await page.getByRole('button', { name: '关闭提示' }).click();
  await expect(notice).toHaveCount(0);
  await publish();
  await expect(notice).toHaveCount(0);
  expect(await geometry()).toEqual(original);

  state.activity = { ...state.activity, kind: 'import', status: 'running', code: '@yovoice.activity.verifying', received: 50, total: 100 };
  await publish();
  await expect(page.locator('.activity')).toBeVisible();
  await expect(page.locator('.activity').getByRole('button', { name: '取消' })).toBeEnabled();
  expect(await geometry()).toEqual(original);
  state.activity = null;
  await publish();
  await expect(page.locator('.activity')).toHaveCount(0);
  expect(await geometry()).toEqual(original);

  await page.setViewportSize({ width: 640, height: 720 });
  state.activity = { kind: 'generate', status: 'failed', code: '@yovoice.activity.failed', params: null, errorCode: '@yovoice.error.unknown', errorParams: { detail: 'a'.repeat(300) }, received: 0, total: 0 };
  await publish();
  await expect(notice).toBeVisible();
  const box = (await notice.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(640);
  expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('button', { name: '关闭提示' }).click();
  await expect(notice).toHaveCount(0);
});
