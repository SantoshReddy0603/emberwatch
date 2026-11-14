import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('snapshot retries', () => {
  it('retries an advanced history cut and returns the new snapshot', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 'HISTORY_CHANGED' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ points: [{ seq: 8 }] }));
    vi.stubGlobal('fetch', fetch);
    const result = api('/history', { token: null });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ points: [{ seq: 8 }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('bounds repeated snapshot conflicts instead of looping indefinitely', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ code: 'HISTORY_CHANGED', error: 'retry history' }, { status: 409 }),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const checked = expect(api('/history', { token: null })).rejects.toThrow('retry history');
    await vi.runAllTimersAsync();
    await checked;
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
