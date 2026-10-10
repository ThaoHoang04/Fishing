// The browser's memory of "who am I": a profile id + secret token issued by the server.
//
// localStorage keeps it across browser restarts. Two tabs of one browser share localStorage, so a second tab
// is given its own profile by the server (`fresh`); that one lives in sessionStorage and belongs to the tab only.
// `tabId` (sessionStorage) survives a reload of the tab, which lets the server tell "reload" from "second tab".

const LOCAL_KEY = 'ft_profile';
const TAB_PROFILE_KEY = 'ft_tab_profile';
const TAB_ID_KEY = 'ft_tab';

const read = (storage, key) => {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
};

const write = (storage, key, value) => {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch { /* private mode: the profile just will not outlive this page */ }
};

export function tabId() {
  try {
    let id = sessionStorage.getItem(TAB_ID_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 12);
      sessionStorage.setItem(TAB_ID_KEY, id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 12);
  }
}

/** The profile this tab should use: its own (second tab) first, then the browser's. */
export function loadProfile() {
  const p = read(sessionStorage, TAB_PROFILE_KEY) ?? read(localStorage, LOCAL_KEY);
  return p?.id && p?.token ? p : null;
}

/** Remember a newly issued profile. `fresh` = the server made it because another tab owns the browser's one. */
export function saveProfile({ id, token, fresh }) {
  if (fresh) write(sessionStorage, TAB_PROFILE_KEY, { id, token });
  else {
    write(localStorage, LOCAL_KEY, { id, token });
    try {
      sessionStorage.removeItem(TAB_PROFILE_KEY);
    } catch { /* ignore */ }
  }
}
