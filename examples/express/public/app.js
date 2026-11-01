// The access token lives only in memory; the refresh token is an HttpOnly cookie.
let accessToken = null;
let refreshing = null;

const output = document.getElementById('output');
const show = (label, value) => {
  output.textContent = `${label}\n${JSON.stringify(value, null, 2)}`;
};

// One refresh at a time: a second request with the old cookie would look like reuse.
function refresh() {
  refreshing ??= fetch('/api/refresh', { method: 'POST' })
    .then(async (response) => {
      accessToken = response.ok ? (await response.json()).accessToken : null;
      return accessToken !== null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function api(path, init = {}) {
  const call = () =>
    fetch(path, {
      ...init,
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  let response = await call();
  if (response.status === 401 && (await refresh())) response = await call();
  return response;
}

document.getElementById('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(form)),
  });
  const body = await response.json();
  accessToken = response.ok ? body.accessToken : null;
  show(`login: ${response.status}`, body);
});

document.getElementById('me').addEventListener('click', async () => {
  const response = await api('/api/me');
  show(`me: ${response.status}`, await response.json());
});

document.getElementById('greeting').addEventListener('click', async () => {
  const response = await api('/api/greeting');
  show(`greeting: ${response.status}`, await response.json());
});

document.getElementById('sessions').addEventListener('click', async () => {
  const response = await api('/api/sessions');
  show(`sessions: ${response.status}`, await response.json());
});

document.getElementById('revoke-others').addEventListener('click', async () => {
  const response = await api('/api/sessions/revoke-others', {
    method: 'POST',
  });
  show(`sign out other devices: ${response.status}`, null);
});

document.getElementById('logout').addEventListener('click', async () => {
  const response = await fetch('/api/logout', { method: 'POST' });
  accessToken = null;
  show(`logout: ${response.status}`, null);
});

// Restores the session after a page reload.
refresh().then((ok) => show('session restored on load', ok));
