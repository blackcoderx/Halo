const urlInput = document.getElementById('url');
const btnSave = document.getElementById('btn-save');
const btnToggle = document.getElementById('btn-toggle');
const status = document.getElementById('status');

chrome.storage.sync.get(['backendUrl', 'haloVisible'], ({ backendUrl, haloVisible }) => {
  urlInput.value = backendUrl || '';
  updateToggleBtn(haloVisible);
});

btnSave.addEventListener('click', () => {
  const url = urlInput.value.trim().replace(/\/$/, '');
  chrome.storage.sync.set({ backendUrl: url }, () => {
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});

btnToggle.addEventListener('click', () => {
  chrome.storage.sync.get('haloVisible', ({ haloVisible }) => {
    const next = !haloVisible;
    chrome.storage.sync.set({ haloVisible: next });
    updateToggleBtn(next);
    chrome.runtime.sendMessage({ type: 'TOGGLE_HALO' });
  });
});

function updateToggleBtn(visible) {
  if (visible) {
    btnToggle.textContent = 'Hide Squall';
    btnToggle.classList.add('active');
  } else {
    btnToggle.textContent = 'Show Squall';
    btnToggle.classList.remove('active');
  }
}
