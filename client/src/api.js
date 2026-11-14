export const readToken = () => sessionStorage.getItem('emberwatch.token');
export const saveToken = (token) =>
  token
    ? sessionStorage.setItem('emberwatch.token', token)
    : sessionStorage.removeItem('emberwatch.token');

function wait(ms, signal) {
  return new Promise((yes, no) => {
    if (signal?.aborted) return no(new DOMException('Aborted', 'AbortError'));
    const abort = () => {
      clearTimeout(timer);
      no(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      yes();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function api(
  path,
  { method = 'GET', body, signal, retry = 0, token = readToken() } = {},
) {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (response.status === 409 && data.code === 'HISTORY_CHANGED' && retry < 2) {
    await wait(250 * 2 ** retry, signal);
    return api(path, { method, body, signal, retry: retry + 1, token });
  }
  if (!response.ok) {
    if (response.status === 401 && token) window.dispatchEvent(new Event('session:expired'));
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}
