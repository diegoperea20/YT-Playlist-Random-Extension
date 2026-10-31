/** Options page: API key override + playback target site. */

const $ = (id) => document.getElementById(id)
const el = {
  apiKeyInput: $('api-key'),
  apiKeyLabel: $('api-key-label'),
  apiKeyDesc: $('api-key-desc'),
  siteLabel: $('site-label'),
  siteDesc: $('site-desc'),
  siteYoutube: $('site-youtube-label'),
  siteMusic: $('site-music-label'),
  saveBtn: $('save-btn'),
  savedOk: $('saved-ok'),
}

function t(key, args) {
  return chrome.i18n.getMessage(key, args ?? [])
}

function applyStaticI18n() {
  el.apiKeyLabel.textContent = t('options_api_key_label')
  el.apiKeyDesc.textContent = t('options_api_key_desc')
  el.siteLabel.textContent = t('options_site_label')
  el.siteDesc.textContent = t('options_site_desc')
  el.siteYoutube.textContent = t('site_youtube')
  el.siteMusic.textContent = t('site_music')
  el.saveBtn.textContent = t('save_btn')
  document.title = t('options_title')
}

async function load() {
  applyStaticI18n()
  const snapshot = await chrome.runtime.sendMessage({ type: 'get-state' })
    .then((reply) => (reply?.ok ? reply : null))
    .catch(() => null)

  if (snapshot?.settings) {
    document.querySelector(`input[name="site"][value="${snapshot.settings.site}"]`).checked = true
  }
  // Show the FULL effective key (bundled or override) so the user can copy/rotate it.
  const keyReply = await chrome.runtime.sendMessage({ type: 'get-effective-key' })
    .catch(() => null)
  if (keyReply?.ok) {
    el.apiKeyInput.value = keyReply.missing ? '' : keyReply.apiKey
    if (keyReply.missing) {
      el.apiKeyInput.placeholder = t('options_no_key_hint')
    }
  }
}

el.saveBtn.addEventListener('click', async () => {
  const site = document.querySelector('input[name="site"]:checked')?.value ?? 'youtube'
  const apiKey = el.apiKeyInput.value.trim()
  await chrome.runtime.sendMessage({ type: 'set-settings', patch: { site, apiKey } })
  el.savedOk.classList.remove('hidden')
  setTimeout(() => el.savedOk.classList.add('hidden'), 1600)
})

load()
